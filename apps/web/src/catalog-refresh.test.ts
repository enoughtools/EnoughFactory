import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogRefresh } from './catalog-refresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function workspace() {
  let generation = 0;
  let visible = 'Waiting';
  let error: unknown;
  let successes = 0;
  let settled = 0;
  const requests: ReturnType<typeof deferred<string>>[] = [];
  const refresh = createCatalogRefresh({
    generation: () => generation,
    request: () => { const request = deferred<string>(); requests.push(request); return request.promise; },
    onValue: (value, latestRequest) => { visible = value; if (latestRequest) { error = undefined; successes++; } },
    onError: cause => { error = cause; },
    onSettled: () => { settled++; },
  });
  return { refresh, requests, switchDevice: () => { generation++; }, view: () => ({ visible, error, successes, settled }) };
}

test('ongoing stream refreshes cannot hide successful task progress while another request is pending', async () => {
  const screen = workspace();
  let previous = screen.refresh();
  for (const [index, state] of ['Preparing', 'Working', 'Checking', 'Integrated'].entries()) {
    const next = screen.refresh();
    screen.requests[index]!.resolve(state);
    await previous;
    assert.equal(screen.view().visible, state, 'A newer pending request must not discard this successful snapshot.');
    assert.equal(screen.view().settled, 0, 'The latest request still owns availability and loading.');
    previous = next;
  }
  screen.requests[4]!.resolve('Complete');
  await previous;
  assert.deepEqual(screen.view(), { visible: 'Complete', error: undefined, successes: 1, settled: 1 });
});

test('an older response cannot roll back a newer snapshot that finished first', async () => {
  const screen = workspace();
  const older = screen.refresh(), newer = screen.refresh();
  screen.requests[1]!.resolve('Checking');
  await newer;
  screen.requests[0]!.resolve('Preparing');
  await older;
  assert.deepEqual(screen.view(), { visible: 'Checking', error: undefined, successes: 1, settled: 1 });
});

test('a late success may update last known state without clearing a newer connection failure', async () => {
  const screen = workspace();
  const older = screen.refresh(), newer = screen.refresh();
  const failure = new Error('Device disconnected');
  screen.requests[1]!.reject(failure);
  await newer;
  screen.requests[0]!.resolve('Working');
  await older;
  assert.deepEqual(screen.view(), { visible: 'Working', error: failure, successes: 0, settled: 1 });
  const recovered = screen.refresh();
  screen.requests[2]!.resolve('Checking');
  await recovered;
  assert.deepEqual(screen.view(), { visible: 'Checking', error: undefined, successes: 1, settled: 2 });
});

test('an older failure cannot replace a newer successful connection', async () => {
  const screen = workspace();
  const older = screen.refresh(), newer = screen.refresh();
  screen.requests[1]!.resolve('Working');
  await newer;
  screen.requests[0]!.reject(new Error('Old connection timeout'));
  await older;
  assert.deepEqual(screen.view(), { visible: 'Working', error: undefined, successes: 1, settled: 1 });
});

test('changing devices fences off old snapshots, failures and loading completion', async () => {
  const screen = workspace();
  const oldValue = screen.refresh(), oldFailure = screen.refresh();
  screen.switchDevice();
  const current = screen.refresh();
  screen.requests[0]!.resolve('Other device task');
  screen.requests[1]!.reject(new Error('Other device offline'));
  await Promise.all([oldValue, oldFailure]);
  assert.deepEqual(screen.view(), { visible: 'Waiting', error: undefined, successes: 0, settled: 0 });
  screen.requests[2]!.resolve('Selected device task');
  await current;
  assert.deepEqual(screen.view(), { visible: 'Selected device task', error: undefined, successes: 1, settled: 1 });
});
