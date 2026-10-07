import assert from 'node:assert/strict';
import test from 'node:test';
import { connectFactoryEvents, onFactoryForeground } from './live-updates';

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(condition: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'The event subscription did not settle.'); await sleep(2); }
}

test('a closed stream reconnects with the same credentials and resumes updates', async () => {
  let requests = 0, changes = 0;
  let live: ReadableStreamDefaultController<Uint8Array> | undefined;
  const headers = { Authorization: 'Bearer inert-fixture-token' };
  const stream = connectFactoryEvents({ url: 'http://factory.invalid/api/events', headers, retryDelayMs: 1,
    onChange: () => changes++,
    fetch: async (url, options) => {
      assert.equal(url, 'http://factory.invalid/api/events');
      assert.deepEqual(options?.headers, headers);
      requests++;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        if (requests === 1) controller.close();
        else live = controller;
      } }));
    },
  });
  try {
    await until(() => requests === 2);
    live!.enqueue(new TextEncoder().encode('event: state\ndata: resumed\n\n'));
    await until(() => changes === 1);
    assert.equal(requests, 2);
  } finally { stream.close(); }
});

test('network and rejected HTTP subscriptions retry without a user refresh', async () => {
  let requests = 0, disconnects = 0;
  const stream = connectFactoryEvents({ url: 'http://factory.invalid/api/events', retryDelayMs: 1,
    onChange() {}, onDisconnect: () => disconnects++,
    fetch: async () => {
      requests++;
      if (requests === 1) throw new Error('Service restarting');
      if (requests === 2) return new Response('Starting', { status: 503 });
      return new Response(new ReadableStream());
    },
  });
  try { await until(() => requests === 3); assert.equal(disconnects, 2); }
  finally { stream.close(); }
});

test('closing during retry clears its timer and cannot open another stream', async () => {
  let requests = 0, disconnected = false;
  const stream = connectFactoryEvents({ url: 'http://factory.invalid/api/events', retryDelayMs: 30,
    onChange() {}, onDisconnect: () => { disconnected = true; },
    fetch: async () => { requests++; return new Response(new ReadableStream({ start(controller) { controller.close(); } })); },
  });
  await until(() => disconnected);
  stream.close(); stream.close(); stream.reconnect();
  await sleep(50);
  assert.equal(requests, 1);
});

test('repeated foreground reconnects close the old reader before opening one replacement', async () => {
  let requests = 0, active = 0, maximum = 0, disconnected = 0;
  const stream = connectFactoryEvents({ url: 'http://factory.invalid/api/events', retryDelayMs: 1,
    onChange() {}, onDisconnect: () => disconnected++,
    fetch: async () => {
      requests++;
      return new Response(new ReadableStream({
        start() { active++; maximum = Math.max(maximum, active); },
        cancel() { active--; },
      }));
    },
  });
  await until(() => active === 1);
  stream.reconnect(); stream.reconnect(); stream.reconnect();
  await until(() => requests === 2);
  assert.equal(maximum, 1);
  assert.equal(active, 1);
  stream.close();
  await until(() => active === 0);
  await sleep(10);
  assert.equal(requests, 2);
  assert.equal(disconnected, 1, 'Unmount must not report another disconnection or refresh.');
});

test('closing aborts an outstanding connection and suppresses reconnection', async () => {
  let requests = 0, aborts = 0, disconnected = 0;
  const stream = connectFactoryEvents({ url: 'http://factory.invalid/api/events', retryDelayMs: 1,
    onChange() {}, onDisconnect: () => disconnected++,
    fetch: async (_url, options) => {
      requests++;
      return await new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => { aborts++; reject(new Error('Aborted')); }, { once: true });
      });
    },
  });
  stream.close();
  await until(() => aborts === 1);
  await sleep(10);
  assert.equal(requests, 1);
  assert.equal(disconnected, 0);
});

test('foreground and network recovery refresh immediately, hidden windows and removed listeners do not', () => {
  const windowTarget = new EventTarget();
  const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
  let activations = 0;
  const close = onFactoryForeground(windowTarget, documentTarget, () => activations++);
  windowTarget.dispatchEvent(new Event('focus'));
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  assert.equal(activations, 0);
  documentTarget.visibilityState = 'visible';
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  windowTarget.dispatchEvent(new Event('focus'));
  windowTarget.dispatchEvent(new Event('online'));
  assert.equal(activations, 3);
  close();
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  windowTarget.dispatchEvent(new Event('focus'));
  windowTarget.dispatchEvent(new Event('online'));
  assert.equal(activations, 3);
});
