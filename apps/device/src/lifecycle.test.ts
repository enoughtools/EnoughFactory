import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvmuxSession, type EnvmuxReady, type EnvmuxState } from '@enoughfactory/envmux';
import type { Session } from '@enoughfactory/contracts';
import { SessionController } from './sessions.ts';
import { Store } from './store.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

const endpoint = {
  host: 'unix:///tmp/enoughfactory-lifecycle-test/docker.sock',
  cliPath: '/tmp/enoughfactory-lifecycle-test/docker',
  configDirectory: '/tmp/enoughfactory-lifecycle-test/config',
};
const ready: EnvmuxReady = {
  type: 'ready', version: 1, endpoint: 'http://127.0.0.1:43199', token: 'test-token',
  project: 'Lifecycle project', session: 'work', instance: 'owned-container',
  workdir: '/work', user: 'root', branch: 'envmux/work', dockerHost: endpoint.host,
};
function state(phase: string, failed?: string): EnvmuxState {
  return {
    project: ready.project, session: ready.session, branch: ready.branch, base: 'main', image: 'test',
    address: '127.0.0.1', instanceName: ready.instance, workdir: ready.workdir, shell: '/bin/sh',
    domain: 'test.local', port: 43199, phase, ready: !failed, failed,
    startedAt: '2026-10-05T00:00:00.000Z', editorAttach: '', browserPort: 0,
    routes: [], tasks: [], services: [], tools: [], log: [],
  };
}
function sessionRecord(id: string, status: Session['status'] = 'unknown'): Session {
  return {
    id, projectId: 'project', deviceId: 'device', name: ready.session, status,
    createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', services: [],
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'enoughfactory-lifecycle-'));
  const store = new Store(directory);
  const event = deferred<EnvmuxState>();
  const controller = new SessionController(store, 'device', () => {}, (topic, data) => {
    if (topic === 'session-state') event.resolve((data as { state: EnvmuxState }).state);
  }, { endpoint, ensureReady: async () => endpoint, bridgeHostAddress: () => undefined });
  t.after(async () => { controller.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  function save(id: string) {
    store.set('sessions', sessionRecord(id));
    store.set('session-private', { id, ready, projectPath: directory });
  }
  return { store, controller, directory, event, save };
}

function fakeSession(snapshot: EnvmuxState) {
  const engine = new EnvmuxSession({ ready, projectPath: '/test/project' });
  const observing = deferred<AbortSignal>();
  let next = deferred<EnvmuxState | undefined>();
  engine.state = async () => snapshot;
  engine.restart = async () => {};
  engine.stop = async () => {};
  engine.events = async function* (signal?: AbortSignal) {
    assert.ok(signal);
    observing.resolve(signal);
    const end = () => next.resolve(undefined);
    signal.addEventListener('abort', end, { once: true });
    try {
      while (!signal.aborted) {
        const update = await next.promise;
        next = deferred<EnvmuxState | undefined>();
        if (!update || signal.aborted) return;
        yield update;
      }
    } finally { signal.removeEventListener('abort', end); }
  };
  return { engine, observing, publish: (update: EnvmuxState) => next.resolve(update) };
}

for (const delayedBoundary of ['attach', 'state'] as const) {
  test(`an older ${delayedBoundary} response cannot replace or abort the current session stream`, { timeout: 2_000 }, async t => {
    const { controller, event, save } = await fixture(t);
    save('session');
    const stale = fakeSession(state('Stale environment'));
    const current = fakeSession(state('Current environment'));
    const entered = deferred<void>();
    const release = deferred<void>();
    let connections = 0;
    if (delayedBoundary === 'state') stale.engine.state = async () => {
      entered.resolve(); await release.promise; return state('Stale environment');
    };
    controller.engine.attach = async () => {
      if (++connections !== 1) return current.engine;
      if (delayedBoundary === 'attach') { entered.resolve(); await release.promise; }
      return stale.engine;
    };

    const older = controller.recover();
    await entered.promise;
    await controller.recover();
    const signal = await current.observing.promise;
    release.resolve();
    await older;

    assert.equal(controller.get('session'), current.engine);
    assert.equal(controller.record('session').phase, 'Current environment');
    assert.equal(signal.aborted, false, 'the current connection must retain its live stream');
    current.publish(state('Current services changed'));
    assert.equal((await event.promise).phase, 'Current services changed');
    assert.equal(controller.record('session').phase, 'Current services changed');
  });
}

test('a failed live environment requires termination, while a failed environment that never started does not', { timeout: 2_000 }, async t => {
  const { store, controller, directory, save } = await fixture(t);
  save('live');
  const failed = fakeSession(state('Service failed', 'A service failed during startup'));
  controller.engine.attach = async () => failed.engine;
  await controller.recover();
  assert.equal(controller.record('live').status, 'failed');
  assert.equal(controller.owns('live'), true);
  assert.equal(controller.needsTermination('live'), true);

  store.set('sessions', sessionRecord('never-started', 'failed'));
  store.set('session-launch', { id: 'never-started', projectPath: directory, generation: 1, dockerHost: endpoint.host });
  assert.equal(controller.owns('never-started'), true);
  assert.equal(controller.needsTermination('never-started'), false);
});
