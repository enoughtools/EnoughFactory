import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Device, ExecutionTargetAdvertisement, RuntimeCapability } from '@enoughfactory/contracts';
import type { DeviceApp, Extension } from './app.ts';
import type { ChatController } from './chats.ts';
import { InspectionService } from './inspection-service.ts';
import { Store } from './store.ts';

interface SetupRecord {
  id: 'mac-shell'; status: 'preparing' | 'failed' | 'ready'; attempts: number;
  attemptedAt: string; updatedAt: string; retryAfter: number; error?: string; runtimeKey?: string;
}
interface Install {
  signal: AbortSignal; succeed(): void; fail(reason: string): void;
}
const macOnly = { skip: process.platform !== 'darwin' };

/** Normal service/API orchestration and SQLite; provider installation and native probes have no effects. */
async function fixture(t: TestContext, options: { available?: boolean; setup?: SetupRecord; details?: string } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-host-readiness-'))), store = new Store(directory);
  let available = options.available ?? false, details = options.details ?? 'The pinned Mac runtime is not installed.';
  let time = Date.parse('2026-10-09T12:00:00.000Z'), changes = 0;
  t.mock.method(Date, 'now', () => time);
  if (options.setup) store.set('inspection-host-setup', options.setup);
  const events: Array<{ topic: string; data: unknown }> = [], installs: Install[] = [], controllers = new Set<AbortController>(), operations = new Set<Promise<unknown>>();
  const capability = (): RuntimeCapability => ({ kind: 'codex', available, version: available ? 'pinned-fixture-version' : undefined, fullAccess: true, interactiveApprovals: available, resume: available, details });
  const device: Device = { id: 'mac', name: 'Test Mac', platform: 'darwin', arch: 'arm64', online: true, local: true, lastSeen: new Date(time).toISOString(), capacity: 1, workspaceProviders: ['git'] };
  const extensions: Extension[] = [], closers: Array<() => void | Promise<void>> = [];
  const app = { dataDir: directory, store, device, devices: [device], extensions, closers, serviceActivityHooks: [],
    runtime: { endpoint: { host: 'unix:///never-use-docker', cliPath: '/usr/bin/false', configDirectory: path.join(directory, 'private-runtime') } },
    changed: () => { changes++; }, emit: (topic: string, data: unknown) => { events.push({ topic, data }); },
    withServiceOperation: <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController(); controllers.add(controller);
      let promise: Promise<T>;
      promise = Promise.resolve().then(() => operation(controller.signal)).finally(() => { controllers.delete(controller); operations.delete(promise); });
      operations.add(promise); return promise;
    },
  } as unknown as DeviceApp;
  const chats = { setToolBridge: () => {}, manager: {
    hostAvailability: async () => [capability()],
    provisionHost: (signal: AbortSignal) => new Promise<RuntimeCapability>((resolve, reject) => {
      installs.push({ signal, succeed: () => { available = true; resolve(capability()); }, fail: reason => { details = reason; reject(new Error(reason)); } });
    }),
  } } as unknown as ChatController;
  const service = new InspectionService(app, chats);
  Object.assign(service.native, { readiness: async () => ({ status: 'setup-required', reasons: ['The real GUI permission is deliberately unavailable.'] }), closeTransport: async () => {} });
  t.after(async () => {
    for (const controller of controllers) controller.abort(new Error('Fixture stopped.'));
    for (const install of installs) install.fail('Fixture stopped.');
    await Promise.allSettled([...operations]); await service.close(); store.close(); await rm(directory, { recursive: true, force: true });
  });
  const get = async (): Promise<ExecutionTargetAdvertisement[]> => {
    const extension = extensions[0]; assert.ok(extension, 'initialize registers the normal readiness endpoint');
    const response = await extension({ method: 'GET', url: new URL('http://factory.test/api/inspection/readiness'), body: {} }) as { executionTargets: ExecutionTargetAdvertisement[] };
    return response.executionTargets;
  };
  return { store, app, service, installs, events, get, initialize: () => service.initialize(), setup: () => store.get<SetupRecord>('inspection-host-setup', 'mac-shell'),
    changes: () => changes, advance: (milliseconds: number) => { time += milliseconds; }, setAvailable: (value: boolean, reason = details) => { available = value; details = reason; },
    settle: () => Promise.allSettled([...operations, ...((service as unknown as { hostPreparation?: Promise<void> }).hostPreparation ? [(service as unknown as { hostPreparation: Promise<void> }).hostPreparation] : [])]),
    revoke: () => { for (const controller of controllers) controller.abort(new Error('Device service operation was revoked.')); } };
}
function host(targets: ExecutionTargetAdvertisement[]) {
  const target = targets.find(target => target.kind === 'host-macos'); assert.ok(target);
  const shell = target.capabilities.find(capability => capability.kind === 'mac-shell'); assert.ok(shell);
  return { target, shell };
}

test('cold Mac installation failure is durable and a requested readiness refresh retries once after cooldown', macOnly, async t => {
  const f = await fixture(t);
  assert.equal(host(await f.service.readiness()).shell.readiness, 'setup-required');
  assert.equal(f.installs.length, 0, 'An internal read cannot begin provisioning'); assert.equal(f.setup(), undefined);
  await f.initialize();
  assert.equal(f.installs.length, 1);
  const starting = host(await f.get()); assert.equal(starting.target.readiness, 'preparing'); assert.equal(starting.shell.readiness, 'preparing');
  f.installs[0]!.fail('The pinned tool download failed: network unavailable.'); await f.settle();
  const failed = f.setup()!; assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 1); assert.match(failed.error!, /network unavailable/);
  const waiting = host(await f.get()); assert.equal(waiting.target.readiness, 'setup-required'); assert.equal(waiting.shell.readiness, 'setup-required');
  assert.match(waiting.shell.reason!, /network unavailable/); assert.ok(waiting.shell.setupAction); assert.equal(f.installs.length, 1);
  f.advance(60001);
  const refreshed = await Promise.all([f.get(), f.get(), f.get()]);
  assert.equal(f.installs.length, 2, 'Concurrent normal GET refreshes share one installer');
  assert.equal(f.setup()!.attempts, 2);
  assert.ok(refreshed.every(targets => host(targets).shell.readiness === 'preparing'));
  f.installs[1]!.succeed(); await f.settle();
  const ready = host(await f.get()); assert.equal(ready.target.readiness, 'ready'); assert.equal(ready.shell.readiness, 'ready');
  assert.equal(f.setup()!.status, 'ready'); assert.equal(f.setup()!.attempts, 0, 'Verified readiness resets the failed-install retry budget'); assert.equal(f.setup()!.error, undefined);
  assert.equal(ready.target.capabilities.find(capability => capability.kind === 'macos-app-inspection')!.readiness, 'setup-required', 'Mac authoring readiness does not claim GUI permissions');
  assert.deepEqual(f.store.list('sessions'), []); assert.deepEqual(f.store.list('chats'), []); assert.deepEqual(f.store.list('attempts'), []);
});

test('persisted failed setup and provider details stay actionable before retry, while a stranded preparation is not advertised active', macOnly, async t => {
  for (const status of ['failed', 'preparing'] as const) await t.test(status, async t => {
    const now = Date.parse('2026-10-09T12:00:00.000Z');
    const setup: SetupRecord = { id: 'mac-shell', status, attempts: 3, attemptedAt: new Date(now - 1000).toISOString(), updatedAt: new Date(now - 1000).toISOString(), retryAfter: now + 60000,
      ...(status === 'failed' ? { error: 'Original checksum verification failed.' } : {}) };
    const f = await fixture(t, { setup, details: 'The owned provider cache has an invalid executable.' }); await f.initialize();
    const waiting = host(await f.get());
    assert.equal(waiting.shell.readiness, 'setup-required'); assert.equal(waiting.target.readiness, 'setup-required'); assert.ok(waiting.shell.setupAction);
    assert.match(waiting.shell.reason!, /owned provider cache has an invalid executable/);
    assert.match(waiting.shell.reason!, status === 'failed' ? /Original checksum verification failed/ : /Previous Mac agent preparation was interrupted/);
    assert.equal(f.installs.length, 0, 'A cooldown/capped record does not start a speculative replacement installer');
    if (status === 'failed') {
      f.advance(60001);
      await f.service.readiness({ prepareHost: 'automatic' });
      assert.equal(f.installs.length, 0, 'Automatic retries stop after three failures');
      assert.equal(host(await f.get()).shell.readiness, 'preparing');
      assert.equal(f.installs.length, 1, 'The normal requested refresh can retry a capped setup after cooldown');
      f.installs[0]!.succeed(); await f.settle();
      assert.equal(f.setup()!.status, 'ready');
    }
  });
});

test('a positively verified provider clears the old capped failure episode before later cache damage', macOnly, async t => {
  const now = Date.parse('2026-10-09T12:00:00.000Z');
  const f = await fixture(t, { available: true, setup: { id: 'mac-shell', status: 'failed', attempts: 3, attemptedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), retryAfter: now + 60000, error: 'Historical download failure.' } });
  const ready = host(await f.service.readiness()); assert.equal(ready.shell.readiness, 'ready'); assert.equal(ready.target.readiness, 'ready'); assert.equal(f.installs.length, 0);
  assert.equal(f.setup()!.status, 'ready'); assert.equal(f.setup()!.attempts, 0); assert.equal(f.setup()!.retryAfter, 0); assert.equal(f.setup()!.error, undefined);
  f.setAvailable(false, 'The previously verified runtime cache changed.');
  await f.initialize();
  assert.equal(f.installs.length, 1, 'Positive readiness opens a new bounded setup episode when the runtime later becomes unavailable');
  assert.equal(f.setup()!.attempts, 1); assert.equal(host(await f.get()).shell.readiness, 'preparing');
  f.installs[0]!.succeed(); await f.settle(); assert.equal(f.setup()!.status, 'ready');
});

test('a capped setup record for known different runtime pins permits one automatic attempt for the current runtime', macOnly, async t => {
  const now = Date.parse('2026-10-09T12:00:00.000Z'), oldKey = 'node=0.0.0;codex=0.0.0;arch=old';
  const f = await fixture(t, { setup: { id: 'mac-shell', status: 'failed', attempts: 3, attemptedAt: new Date(now - 60001).toISOString(), updatedAt: new Date(now - 60001).toISOString(), retryAfter: now - 1, error: 'The old pinned runtime failed.', runtimeKey: oldKey } });
  await f.initialize();
  assert.equal(f.installs.length, 1, 'An old known runtime episode cannot exhaust the new runtime budget');
  assert.equal(f.setup()!.attempts, 1); assert.equal(typeof f.setup()!.runtimeKey, 'string'); assert.notEqual(f.setup()!.runtimeKey, oldKey);
  await Promise.all([f.get(), f.get()]); assert.equal(f.installs.length, 1);
  f.installs[0]!.succeed(); await f.settle(); assert.equal(f.setup()!.attempts, 0);
});

test('requested refresh during a held readonly probe retains one setup retry instead of losing the request', macOnly, async t => {
  const f = await fixture(t); await f.initialize();
  f.installs[0]!.fail('The original download was interrupted.'); await f.settle(); f.advance(60001);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  Object.assign(f.service.native, { readiness: async () => { await gate; return { status: 'setup-required', reasons: ['Actual native permissions are unavailable.'] }; } });
  const readonly = f.service.readiness(), requested = [f.get(), f.get()];
  assert.equal(f.installs.length, 1, 'A pending probe does not begin another provider effect');
  release(); await Promise.all([readonly, ...requested]);
  assert.equal(f.installs.length, 2, 'Requested mode survives the shared readonly probe and starts one eligible retry');
  assert.equal(f.setup()!.status, 'preparing');
  f.installs[1]!.succeed(); await f.settle();
  assert.equal(host(await f.get()).shell.readiness, 'ready');
});

test('revocation or closure during setup rejects late installer success without publishing ready or rewriting durable setup state', macOnly, async t => {
  for (const fence of ['revoked', 'closed'] as const) await t.test(fence, async t => {
    const f = await fixture(t); await f.initialize(); assert.equal(f.installs.length, 1);
    const original = f.setup(); assert.equal(original?.status, 'preparing');
    if (fence === 'revoked') f.revoke(); else await f.service.close();
    const before = { setup: f.setup(), device: structuredClone(f.app.device), events: f.events.length, changes: f.changes() };
    f.installs[0]!.succeed(); await f.settle();
    assert.deepEqual(f.setup(), before.setup); assert.deepEqual(f.app.device, before.device);
    assert.equal(f.events.length, before.events); assert.equal(f.changes(), before.changes);
    assert.equal(f.events.slice(before.events).filter(event => event.topic === 'execution-capabilities').length, 0);
  });
});
