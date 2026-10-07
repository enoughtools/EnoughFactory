import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { EnvmuxHttpError, EnvmuxSession, type EnvmuxReady } from '../src/index.ts';

const ready: EnvmuxReady = {
  type: 'ready', version: 1, endpoint: 'http://127.0.0.1:43210', token: 'private-fixture-token',
  project: 'fixture', session: 'work', instance: 'fixture-work', workdir: '/work', user: 'root',
  branch: 'envmux/work', dockerHost: 'unix:///owned/docker.sock',
};
function childFixture() {
  const signals: NodeJS.Signals[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 987654, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill(signal: NodeJS.Signals) { signals.push(signal); return true; },
  });
  let exit!: (code: number) => void;
  const ended = new Promise<number>(resolve => { exit = code => { child.exitCode = code; child.emit('exit', code); resolve(code); }; });
  return { child: child as unknown as ChildProcess, signals, ended, exit };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('a typed 401 stops only the owned live child with SIGINT and waits for its native exit', async t => {
  const native = childFixture();
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    assert.equal(input.pathname, '/api/stop'); assert.equal(init.method, 'POST');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${ready.token}`);
    return new Response('Unauthorized', { status: 401 });
  });
  const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
  let stopped = false;
  const stopping = session.stop().then(() => { stopped = true; });
  await flush();
  assert.deepEqual(native.signals, ['SIGINT']); assert.equal(stopped, false);
  native.exit(0); await stopping; assert.equal(stopped, true);
});

test('normal authenticated stop retains the same native exit wait without signaling', async t => {
  const native = childFixture();
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
  let stopped = false;
  const stopping = session.stop().then(() => { stopped = true; });
  await flush(); assert.equal(stopped, false); assert.deepEqual(native.signals, []);
  native.exit(0); await stopping;
});

test('an owned child without a supplied exit promise still waits and preserves failed exits', async t => {
  await t.test('live child', async t => {
    const native = childFixture();
    t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }));
    const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child });
    let stopped = false;
    const stopping = session.stop().then(() => { stopped = true; });
    await flush(); assert.deepEqual(native.signals, ['SIGINT']); assert.equal(stopped, false);
    native.exit(0); await stopping; assert.equal(stopped, true);
  });
  await t.test('already exited with failure', async t => {
    const native = childFixture(); native.exit(17);
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
    const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child });
    await assert.rejects(session.stop(), /could not finish returning work \(exit 17\)/);
    assert.deepEqual(native.signals, []);
  });
});

test('non-401 responses and untyped error text cannot signal an owned child', async t => {
  for (const status of [403, 404, 500]) await t.test(String(status), async t => {
    const native = childFixture();
    t.mock.method(globalThis, 'fetch', async () => new Response('Private failure', { status }));
    const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
    await assert.rejects(session.stop(), error => error instanceof EnvmuxHttpError && error.status === status);
    assert.deepEqual(native.signals, []);
  });
  await t.test('untyped message', async t => {
    const native = childFixture();
    const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
    t.mock.method(session, 'request', async () => { throw new Error('Envmux 401: looks like authentication'); });
    await assert.rejects(session.stop(), /looks like authentication/); assert.deepEqual(native.signals, []);
  });
});

test('401 on a reattached PID or an exited child never signals a process', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }));
  t.mock.method(process, 'kill', () => assert.fail('A saved PID must never authorize stop signaling'));
  const reattached = new EnvmuxSession({ ready, projectPath: '/owned/project', pid: 987654 });
  await assert.rejects(reattached.stop(), { status: 401 });
  const native = childFixture(); native.exit(0);
  const exited = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
  await assert.rejects(exited.stop(), { status: 401 }); assert.deepEqual(native.signals, []);
});

test('a failed native exit or rejected signal cannot report successful stop', async t => {
  await t.test('nonzero exit', async t => {
    const native = childFixture();
    t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }));
    const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
    const failed = assert.rejects(session.stop(), /could not finish returning work \(exit 17\)/);
    await flush(); assert.deepEqual(native.signals, ['SIGINT']); native.exit(17); await failed;
  });
  await t.test('signal rejected', async t => {
    const native = childFixture();
    t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }));
    t.mock.method(native.child, 'kill', () => false);
    const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
    await assert.rejects(session.stop(), { status: 401 });
  });
  await t.test('native exit remains unconfirmed', async t => {
    const native = childFixture();
    t.mock.method(globalThis, 'fetch', async () => new Response('Unauthorized', { status: 401 }));
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const session = new EnvmuxSession({ ready, projectPath: '/owned/project', process: native.child, ended: native.ended });
    const failed = assert.rejects(session.stop(), /session stop has not finished/);
    await flush(); assert.deepEqual(native.signals, ['SIGINT']); t.mock.timers.tick(120_000); await failed;
  });
});
