import assert from 'node:assert/strict';
import test from 'node:test';
import { DeviceApp } from './app.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
/** Exercise the real admission methods without opening a database, Docker or listening socket. */
function fixture() {
  const state = {
    closing: false, serviceUpdating: false, runtimeSuspended: true, runtimeStopping: true,
    activeApiOperations: 0, runtimeOperations: new Map(), serviceOperations: new Map(),
    sessions: { serviceActivity: () => ({ starting: 0, stopping: 0 }), close: () => {} },
    store: { list: () => [], close: () => {} }, serviceActivityHooks: [], closers: [], sse: new Set(),
    socketServer: { close: () => {} }, server: { close: (done: () => void) => done() },
  };
  const app = Object.assign(Object.create(DeviceApp.prototype), state) as DeviceApp;
  return { app, state: app as unknown as typeof state };
}

test('native service work is admitted while private Docker is stopped and reserves service update ownership', async () => {
  const { app, state } = fixture();
  const release = deferred<number>();
  let invoked = false;
  const job = app.withServiceOperation(async signal => { invoked = true; assert.equal(signal.aborted, false); return release.promise; });
  assert.equal(invoked, false, 'Ownership is registered before calling the host operation');
  assert.equal(state.serviceOperations.size, 1);
  assert.equal(app.serviceUpdateStatus().canUpdate, false);
  await assert.rejects(app.withRuntimeOperation(async () => assert.fail('Docker work must stay stopped')), /runtime/i);
  await Promise.resolve(); assert.equal(invoked, true);
  release.resolve(42); assert.equal(await job, 42);
  assert.equal(state.serviceOperations.size, 0);
  state.runtimeStopping = false;
  assert.equal(app.serviceUpdateStatus().canUpdate, true);
});

test('synchronous host failures release ownership and service handoff rejects new host effects', async () => {
  const { app, state } = fixture();
  await assert.rejects(app.withServiceOperation(() => { throw new Error('Native preparation failed'); }), /Native preparation failed/);
  assert.equal(state.serviceOperations.size, 0);
  state.serviceUpdating = true;
  let invoked = false;
  await assert.rejects(app.withServiceOperation(async () => { invoked = true; }), /updating/);
  assert.equal(invoked, false);
});

test('service shutdown aborts admitted native work and waits for its outcome before closing storage', async () => {
  const { app, state } = fixture();
  const started = deferred(), stopped = deferred();
  let storedClosed = false;
  state.store.close = () => { storedClosed = true; };
  const job = app.withServiceOperation(async signal => {
    signal.addEventListener('abort', () => stopped.resolve(), { once: true });
    started.resolve(); await stopped.promise;
    assert.equal(storedClosed, false); return 'canceled';
  });
  await started.promise;
  await app.close();
  assert.equal(await job, 'canceled');
  assert.equal(storedClosed, true);
  assert.equal(state.serviceOperations.size, 0);
  await assert.rejects(app.withServiceOperation(async () => {}), /updating/);
});
