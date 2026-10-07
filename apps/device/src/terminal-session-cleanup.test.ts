import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Chat, Session } from '@enoughfactory/contracts';
import { Store } from './store.ts';
import { TerminalSessionCleanup, terminalSessionCleanupBucket, type TerminalSessionCleanupOptions, type TerminalSessionCleanupRecord } from './terminal-session-cleanup.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function session(id: string, status: Session['status'] = 'stopped'): Session {
  return { id, name: id, projectId: 'project', deviceId: 'local', status, containerId: `container-${id}`,
    services: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
}

function chat(id: string, sessionId: string, status: Chat['status']): Chat {
  return { id, sessionId, deviceId: 'local', title: id, runtime: 'codex', status, approvalMode: 'approve-all',
    createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'enough-terminal-cleanup-'));
  const store = new Store(directory);
  const queues: TerminalSessionCleanup[] = [];
  let time = Date.parse('2026-10-07T01:00:00.000Z'), ready = true;
  const busy = new Set<string>(), unretirable = new Set<string>(), generations = new Map<string, number>();
  const options: Omit<TerminalSessionCleanupOptions, 'retire'> = {
    store,
    sessions: {
      record: id => { const value = store.get<Session>('sessions', id); assert.ok(value); return value; },
      owns: id => store.get<Session>('sessions', id)?.deviceId === 'local',
      canRetireEnvironment: id => !unretirable.has(id),
    },
    runtimeReady: () => ready,
    busy: id => busy.has(id),
    identity: value => `${value.containerId}:${generations.get(value.id) ?? 1}`,
    retryMs: 10, reconcileMs: 60_000, now: () => time,
  };
  const create = (retire: TerminalSessionCleanupOptions['retire'], extra: Partial<TerminalSessionCleanupOptions> = {}) => {
    const queue = new TerminalSessionCleanup({ ...options, ...extra, retire }); queues.push(queue); return queue;
  };
  t.after(async () => { for (const queue of queues) await queue.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, options, create, busy, unretirable, generations,
    setReady: (value: boolean) => { ready = value; }, advance: (value: number) => { time += value; },
    record: (id: string) => store.get<TerminalSessionCleanupRecord>(terminalSessionCleanupBucket, id),
  };
}

test('startup retires owned terminal environments sequentially and leaves outcomes and live sessions intact', async t => {
  const f = await fixture(t);
  for (const value of [session('stopped'), session('failed', 'failed'), session('unknown', 'unknown'), session('ready', 'ready'), { ...session('remote'), deviceId: 'remote' }])
    f.store.set('sessions', value);
  f.store.set('chats', chat('historical-failure', 'failed', 'failed'));
  const originalSessions = f.store.list<Session>('sessions'), originalChats = f.store.list<Chat>('chats');
  let active = 0, maximum = 0;
  const retired: string[] = [];
  const queue = f.create(async (id, assertCurrent) => {
    maximum = Math.max(maximum, ++active);
    assert.equal(f.record(id)?.status, 'preserving');
    assertCurrent();
    await Promise.resolve();
    retired.push(id); --active;
  });
  queue.start(); await queue.drain();
  assert.deepEqual(retired, ['stopped', 'failed', 'unknown']);
  assert.equal(maximum, 1);
  assert.deepEqual(f.store.list('sessions'), originalSessions);
  assert.deepEqual(f.store.list('chats'), originalChats);
  assert.equal(f.record('ready'), undefined); assert.equal(f.record('remote'), undefined);
  queue.reconcile(); await queue.drain(); assert.equal(retired.length, 3, 'durable removal receipts suppress repeated retirement');
});

test('running chats, waiting chats, active captures, live owners and an unavailable runtime defer without consuming retries', async t => {
  const f = await fixture(t), ids = ['running', 'waiting', 'capturing', 'owner', 'runtime'];
  for (const id of ids) f.store.set('sessions', session(id));
  f.store.set('chats', chat('run-chat', 'running', 'running'));
  f.store.set('chats', chat('wait-chat', 'waiting', 'waiting'));
  f.busy.add('capturing'); f.unretirable.add('owner'); f.setReady(false);
  const retired: string[] = [], queue = f.create(async (id, assertCurrent) => { assertCurrent(); retired.push(id); });
  queue.start(); await queue.drain();
  assert.deepEqual(retired, []);
  for (const id of ids) { assert.equal(f.record(id)?.status, 'deferred'); assert.equal(f.record(id)?.attempts, 0); }
  f.setReady(true); f.advance(10); queue.reconcile(); await queue.drain();
  assert.deepEqual(retired, ['runtime']);
  assert.match(f.record('running')!.reason!, /conversation/); assert.match(f.record('waiting')!.reason!, /conversation/);
  assert.match(f.record('capturing')!.reason!, /capture/); assert.match(f.record('owner')!.reason!, /idle/);
  f.store.set('chats', chat('run-chat', 'running', 'idle')); f.store.set('chats', chat('wait-chat', 'waiting', 'interrupted'));
  f.busy.clear(); f.unretirable.clear(); f.advance(10); queue.reconcile(); await queue.drain();
  assert.equal(retired.length, 5);
  assert.equal(f.store.get<Chat>('chats', 'wait-chat')?.status, 'interrupted');
});

test('a session restart during preservation fences destruction and a new generation gets its own cleanup', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  f.store.set('sessions', session('work'));
  let calls = 0, removals = 0;
  const queue = f.create(async (_id, assertCurrent) => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    assertCurrent(); ++removals;
  });
  queue.start(); await entered.promise;
  f.generations.set('work', 2); f.store.set('sessions', session('work', 'starting'));
  release.resolve(); await queue.drain();
  assert.equal(removals, 0); assert.equal(f.record('work')?.status, 'deferred');
  assert.match(f.record('work')!.reason!, /identity changed/);
  f.store.set('sessions', session('work')); queue.request('work'); await queue.drain();
  assert.equal(removals, 1); assert.equal(f.record('work')?.identity, 'container-work:2');
  assert.equal(f.record('work')?.status, 'removed'); assert.equal(f.record('work')?.attempts, 1);
});

test('an interrupted preservation replays from SQLite and an archival failure remains durable across queue recreation', async t => {
  const f = await fixture(t);
  f.store.set('sessions', session('interrupted'));
  f.store.set(terminalSessionCleanupBucket, { id: 'interrupted', identity: 'container-interrupted:1', status: 'preserving', attempts: 1, updatedAt: '2026-10-07T00:00:00.000Z' });
  const older = f.create(async () => { throw new Error('Archive destination is temporarily unavailable.'); });
  older.start(); await older.drain();
  assert.equal(f.record('interrupted')?.status, 'deferred'); assert.equal(f.record('interrupted')?.attempts, 2);
  await older.close();
  const reopened = new Store(f.directory);
  t.after(() => reopened.close());
  let attempts = 0;
  const replacement = f.create(async (_id, assertCurrent) => { assertCurrent(); ++attempts; }, { store: reopened });
  replacement.start(); await replacement.drain(); assert.equal(attempts, 0, 'restart respects the persisted retry deadline');
  f.advance(20); replacement.reconcile(); await replacement.drain();
  assert.equal(attempts, 1);
  assert.equal(reopened.get<TerminalSessionCleanupRecord>(terminalSessionCleanupBucket, 'interrupted')?.status, 'removed');
  assert.equal(f.store.get<Session>('sessions', 'interrupted')?.status, 'stopped');
});

test('preservation failures back off, stop at the retry budget, and explicit retry starts a fresh budget', async t => {
  const f = await fixture(t); f.store.set('sessions', session('work'));
  let calls = 0, available = false;
  const queue = f.create(async (_id, assertCurrent) => { ++calls; assertCurrent(); if (!available) throw new Error('Archive integrity could not be confirmed.'); }, { maxAttempts: 2 });
  queue.start(); await queue.drain();
  assert.equal(calls, 1); assert.equal(f.record('work')?.attempts, 1);
  queue.reconcile(); await queue.drain(); assert.equal(calls, 1);
  f.advance(10); queue.reconcile(); await queue.drain();
  assert.equal(calls, 2); assert.equal(f.record('work')?.exhausted, true);
  f.advance(60_000); queue.reconcile(); await queue.drain(); assert.equal(calls, 2);
  available = true; queue.request('work'); await queue.drain();
  assert.equal(calls, 3); assert.equal(f.record('work')?.status, 'removed'); assert.equal(f.record('work')?.attempts, 1);
});

test('restart respects an interrupted attempt limit while a runtime fence during preservation preserves its retry budget', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  f.store.set('sessions', session('interrupted'));
  f.store.set(terminalSessionCleanupBucket, { id: 'interrupted', identity: 'container-interrupted:1', status: 'preserving', attempts: 1, updatedAt: '2026-10-07T00:00:00.000Z' });
  let removals = 0;
  const capped = f.create(async () => { ++removals; }, { maxAttempts: 1 });
  capped.start(); await capped.drain();
  assert.equal(removals, 0); assert.equal(f.record('interrupted')?.exhausted, true);
  await capped.close();
  f.store.set('sessions', session('runtime'));
  let calls = 0;
  const queue = f.create(async (id, assertCurrent) => {
    assert.equal(id, 'runtime');
    if (++calls === 1) { entered.resolve(); await release.promise; }
    assertCurrent(); ++removals;
  }, { maxAttempts: 1 });
  queue.start(); await entered.promise;
  f.setReady(false); release.resolve(); await queue.drain();
  assert.equal(removals, 0); assert.equal(f.record('runtime')?.attempts, 0);
  assert.equal(f.record('runtime')?.exhausted, undefined);
  f.setReady(true); f.advance(10); queue.reconcile(); await queue.drain();
  assert.equal(removals, 1); assert.equal(f.record('runtime')?.status, 'removed');
});

test('close finishes preservation in flight and leaves later queued environments durable for restart', async t => {
  const f = await fixture(t), entered = gate(), release = gate();
  f.store.set('sessions', session('first')); f.store.set('sessions', session('second'));
  const retired: string[] = [];
  const queue = f.create(async (id, assertCurrent) => { entered.resolve(); await release.promise; assertCurrent(); retired.push(id); });
  queue.start(); await entered.promise;
  let closed = false;
  const closing = queue.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release.resolve(); await closing;
  assert.deepEqual(retired, ['first']); assert.equal(f.record('second')?.status, 'queued');
  const replacement = f.create(async (id, assertCurrent) => { assertCurrent(); retired.push(id); });
  replacement.start(); await replacement.drain(); assert.deepEqual(retired, ['first', 'second']);
});
