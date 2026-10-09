import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import test, { type TestContext } from 'node:test';
import { DeviceApp } from './app.ts';

interface StreamSeam {
  sse: Map<ServerResponse, { write(packet: string): void; end(): void }>;
  openEventStream(req: IncomingMessage, res: ServerResponse): void;
}

/** Real Node responses and the production SSE path; no database, runtime or listener. */
function fixture(t: TestContext) {
  const heartbeats: Array<() => void> = [], timers: Array<ReturnType<typeof setInterval>> = [];
  const activeTimers = new Set<ReturnType<typeof setInterval>>(), interval = globalThis.setInterval, clear = globalThis.clearInterval;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
    heartbeats.push(callback);
    const timer = interval(callback, delay); timer.unref(); timers.push(timer); activeTimers.add(timer); return timer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer: ReturnType<typeof setInterval>) => { activeTimers.delete(timer); clear(timer); });
  let revision = 1;
  const app = Object.assign(Object.create(DeviceApp.prototype), { closing: false, sse: new Map(), listeners: new Set(), state: () => ({ revision }) }) as DeviceApp;
  const seam = app as unknown as StreamSeam;
  const connections: Array<{ req: IncomingMessage; res: ServerResponse }> = [];
  t.after(() => { for (const timer of timers) clearInterval(timer); for (const { req, res } of connections) { res.destroy(); req.destroy(); } });
  const connect = () => {
    const req = new IncomingMessage(new Socket()); req.method = 'GET';
    const res = new ServerResponse(req), packets: string[] = [];
    const originalWrite = res.write;
    t.mock.method(res, 'write', (packet: unknown, ...args: unknown[]) => { packets.push(String(packet)); return Reflect.apply(originalWrite, res, [packet, ...args]); });
    connections.push({ req, res }); seam.openEventStream(req, res);
    return { req, res, packets, heartbeat: heartbeats.at(-1)! };
  };
  return { app, seam, connect, activeTimers, nextRevision: () => { revision++; } };
}

test('SSE backpressure ends the response and an already queued heartbeat cannot write after end', async t => {
  const f = fixture(t), client = f.connect();
  f.app.emit('activity', 'x'.repeat(1024 * 1024));
  assert(client.res.writableLength > 1024 * 1024, 'The real response buffer reaches the production backpressure limit');
  f.app.emit('activity', 'next event');
  assert.equal(client.res.writableEnded, true); assert.equal(f.seam.sse.size, 0);
  assert.equal(f.activeTimers.size, 0, 'Backpressure immediately cancels the heartbeat without waiting for request close');
  const writes = client.packets.length;
  client.heartbeat();
  assert.equal(client.packets.length, writes, 'A timer callback queued before cancellation must still guard the ended response');
  assert.equal(client.req.listenerCount('close'), 0); assert.equal(client.req.listenerCount('aborted'), 0);
  assert.equal(client.res.listenerCount('finish'), 0); assert.equal(client.res.listenerCount('close'), 0);
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('a response error retires its SSE stream without making queued heartbeats or application errors unsafe', async t => {
  const f = fixture(t), client = f.connect();
  await new Promise<void>(resolve => setImmediate(() => { client.res.emit('error', Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' })); resolve(); }));
  assert.equal(client.res.destroyed, true); assert.equal(f.seam.sse.size, 0);
  assert.equal(f.activeTimers.size, 0);
  const writes = client.packets.length; client.heartbeat(); assert.equal(client.packets.length, writes);
  assert.doesNotThrow(() => client.res.emit('error', new Error('An earlier queued response write failed after cleanup')));
  f.app.listeners.add(() => { throw new Error('Unrelated application listener error'); });
  assert.throws(() => f.app.emit('activity', 'event'), /Unrelated application listener error/);
});

test('an ended response is removed even before close and a reconnect receives current state and new events', async t => {
  const f = fixture(t), previous = f.connect();
  assert.match(previous.packets[0]!, /event: state\ndata: \{"revision":1\}/);
  previous.res.end(); const writes = previous.packets.length;
  previous.heartbeat(); assert.equal(f.seam.sse.size, 0); assert.equal(previous.packets.length, writes);
  assert.equal(f.activeTimers.size, 0);
  f.nextRevision(); const current = f.connect();
  assert.match(current.packets[0]!, /event: state\ndata: \{"revision":2\}/);
  f.app.emit('activity', { status: 'running' });
  assert.equal(previous.packets.length, writes);
  assert.match(current.packets[1]!, /event: activity\ndata: \{"status":"running"\}/);
  current.req.emit('aborted'); assert.equal(f.seam.sse.size, 0);
  assert.equal(f.activeTimers.size, 0);
  const currentWrites = current.packets.length; current.heartbeat(); assert.equal(current.packets.length, currentWrites);
  await new Promise<void>(resolve => setImmediate(resolve));
});
