import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, Chat, FactoryTask, Goal, Project, Session } from '@enoughfactory/contracts';
import type { AttemptDetail, ControlRecord, WorkspaceRef } from '@enoughfactory/factory';
import type { TurnCallbacks, TurnInput, TurnResult } from '@enoughfactory/agents';
import type { AddressInfo } from 'node:net';
import { DeviceApp } from './app.ts';
import { ChatController } from './chats.ts';
import { initializeFactory } from './factory.ts';

interface WorkerReceipt {
  id: string; coordinatorId: string; goal: Goal; task: FactoryTask; attempt: Attempt; project: Project;
  status: 'running' | 'unknown' | 'prepared' | 'succeeded'; workspace: WorkspaceRef;
  sessionId: string; chatId: string; updatedAt: string; error?: string; result?: unknown;
}
interface CompletionReceipt { id: string; result: TurnResult; attemptId?: string; completedAt?: string; }

async function harness(t: TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-recovery-'));
  const previousDirectory = process.env.ENOUGHFACTORY_HOME;
  let app: DeviceApp;
  try { process.env.ENOUGHFACTORY_HOME = directory; app = new DeviceApp(); }
  finally {
    if (previousDirectory === undefined) delete process.env.ENOUGHFACTORY_HOME;
    else process.env.ENOUGHFACTORY_HOME = previousDirectory;
  }
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  t.mock.method(app, 'ensureRuntimeReady', async () => assert.fail('Recovery observation must not launch a runtime'));
  t.mock.method(app.runtime, 'prepareWorkspace', async () => assert.fail('Recovery must retain the existing workspace'));
  let live = false;
  const chats = {
    isRunning: () => live,
    get: (id: string) => app.store.get<Chat>('chats', id)!,
    run: async () => assert.fail('Reconciliation must not rerun a provider turn'),
    create: () => assert.fail('Reconciliation must not create a replacement conversation'),
  } as unknown as ChatController;
  const factory = await initializeFactory(app, chats);
  factory.coordinator.stop();

  function seed(status: WorkerReceipt['status'] = 'unknown') {
    const startedAt = '2026-10-05T00:00:00.000Z', updatedAt = '2026-10-05T00:00:01.000Z';
    const project: Project = { id: 'project', name: 'Product', path: path.join(directory, 'repository'), deviceId: app.device.id, runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: startedAt };
    const goal: Goal = { id: 'goal', projectId: project.id, coordinatorId: app.device.id, title: 'Deliver product', objective: 'Implement the complete requested behavior', criteria: ['Behavior works'], status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 4, revision: 2, createdAt: startedAt, updatedAt };
    const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Implement behavior', description: 'Deliver the actual behavior and focused evidence', acceptanceCriteria: ['Behavior works'], expectedOutputs: ['Preserved implementation'], dependsOn: [], status: 'running', currentAttemptId: 'attempt', deviceId: app.device.id, createdAt: startedAt, updatedAt };
    const attempt: Attempt = { id: 'attempt', taskId: task.id, generation: 3, deviceId: app.device.id, status: 'unknown', sessionId: 'session', chatId: 'chat', startedAt };
    const workspace: WorkspaceRef = { id: 'workspace', path: path.join(directory, 'workspace'), provider: 'git', baseCommit: 'original-base', sessionId: 'session', deviceId: app.device.id };
    const chat: Chat = { id: 'chat', sessionId: 'session', deviceId: app.device.id, title: task.title, runtime: 'codex', approvalMode: 'approve-all', status: 'idle', threadId: 'provider-thread', createdAt: startedAt, updatedAt: '2026-10-05T00:00:02.000Z' };
    const session: Session = { id: 'session', projectId: project.id, deviceId: app.device.id, name: 'existing-work', status: 'ready', services: [], createdAt: startedAt, updatedAt };
    const worker: WorkerReceipt = { id: attempt.id, coordinatorId: app.device.id, goal: { ...goal, revision: 1 }, task, attempt, project, status, workspace, sessionId: session.id, chatId: chat.id, updatedAt, error: 'Connection was interrupted' };
    const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, assignmentGoalRevision: 1, cancellation: 'none', phase: 'executing', workspace };
    const completion: CompletionReceipt = { id: chat.id, result: { threadId: chat.threadId, text: 'Legacy response which does not prove the full assigned task was completed' }, completedAt: '2026-10-05T00:00:02.000Z' };
    app.store.transaction(() => {
      app.store.set('projects', project); app.store.set('goals', goal); app.store.set('tasks', task);
      app.store.set('attempts', attempt); app.store.set('factory-attempt-details', detail);
      app.store.set('sessions', session); app.store.set('chats', chat); app.store.set('factory-workers', worker);
      app.store.delete('chat-results', chat.id); app.store.delete('chat-turn-failures', chat.id);
    });
    return { worker, goal, task, attempt, detail, workspace, chat, completion };
  }
  return { app, factory, seed, setLive(value: boolean) { live = value; } };
}

test('unknown and running factory workers observe a live conversation without repeating execution', async t => {
  const fixture = await harness(t);
  for (const status of ['unknown', 'running'] as const) {
    const state = fixture.seed(status);
    fixture.setLive(true);
    const report = await fixture.factory.runtime.reconcile(state.attempt);
    assert.equal(report.status, 'running');
    const saved = fixture.app.store.get<WorkerReceipt>('factory-workers', state.attempt.id)!;
    assert.equal(saved.status, 'running');
    assert.equal(saved.id, state.worker.id);
    assert.deepEqual(saved.workspace, state.workspace);
    assert.equal(saved.chatId, state.chat.id);
    assert.equal(fixture.app.store.list<Attempt>('attempts').length, 1);
  }
});

test('a completion receipt bound to the exact attempt recovers its journaled result', async t => {
  const fixture = await harness(t);
  const state = fixture.seed();
  const completion = { ...state.completion, attemptId: state.attempt.id, result: { threadId: state.chat.threadId, text: 'The complete assigned task and relevant checks finished' } };
  fixture.app.store.set('chat-results', completion);
  const report = await fixture.factory.runtime.reconcile(state.attempt);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.result!.status, 'succeeded');
  assert.equal(report.result!.text, completion.result.text);
  assert.equal(report.result!.chatId, state.chat.id);
  assert.equal(report.result!.sessionId, state.worker.sessionId);
  assert.equal(fixture.app.store.get<WorkerReceipt>('factory-workers', state.attempt.id)!.error, undefined);
});

test('an authenticated legacy completion re-prepares the same attempt and workspace without adopting unbound success', async t => {
  const fixture = await harness(t);
  const state = fixture.seed();
  fixture.app.store.set('chat-results', state.completion);
  fixture.app.store.set('factory-workers', { ...state.worker, updatedAt: '2026-10-05T00:00:03.000Z' });
  const before = fixture.app.store.get<Attempt>('attempts', state.attempt.id);
  const report = await fixture.factory.runtime.reconcile(state.attempt);
  assert.equal(report.status, 'prepared');
  assert.equal(report.result, undefined, 'the unbound response is not evidence of task completion');
  assert.deepEqual(report.workspace, state.workspace);
  assert.deepEqual(fixture.app.store.get<Attempt>('attempts', state.attempt.id), before);
  const saved = fixture.app.store.get<WorkerReceipt>('factory-workers', state.attempt.id)!;
  assert.equal(saved.status, 'prepared');
  assert.equal(saved.result, undefined);
  assert.equal(saved.sessionId, state.worker.sessionId);
  assert.equal(saved.chatId, state.worker.chatId);
  assert.equal(saved.attempt.generation, 3);
  assert.equal(fixture.app.store.get<Chat>('chats', state.chat.id)!.attemptId, state.attempt.id);
  assert.equal(fixture.app.store.get<AttemptDetail>('factory-attempt-details', state.attempt.id)!.goalRevision, 2);
});

test('a manual Continue turn preserves factory binding and passes the immutable task contract to the provider', async t => {
  const fixture = await harness(t);
  const state = fixture.seed();
  fixture.app.store.set<AttemptDetail>('factory-attempt-details', { ...state.detail, contract: {
    title: 'Original assigned task', description: 'Implement the original delivery contract',
    acceptanceCriteria: ['The assigned scenario passes'], expectedOutputs: ['A verified implementation artifact'],
    checks: ['verify/assigned-task'], dependsOn: [], planRevision: 1,
  } });
  fixture.app.store.set('tasks', { ...state.task, title: 'Later display title', description: 'Later description' });
  t.mock.method(fixture.app.sessions, 'get', () => ({ ready: { instance: 'fake-container', workdir: '/workspace/existing' } }) as ReturnType<DeviceApp['sessions']['get']>);
  const chats = new ChatController(fixture.app);
  let received: TurnInput | undefined;
  t.mock.method(chats.manager, 'runTurn', async (input: TurnInput) => {
    received = input;
    return { threadId: state.chat.threadId, text: 'Continued with the assigned context' };
  });
  await chats.run(state.chat.id, 'Continue');
  assert.equal(received!.prompt, 'Continue');
  assert.equal(received!.attemptId, state.attempt.id);
  assert.equal(received!.sessionId, state.worker.sessionId);
  assert.equal(received!.threadId, state.chat.threadId);
  for (const context of [state.goal.objective, 'Behavior works', 'Original assigned task', 'Implement the original delivery contract', 'The assigned scenario passes', 'A verified implementation artifact', 'verify/assigned-task']) {
    assert.ok(received!.systemInstructions!.includes(context), `Provider instructions retain ${context}`);
  }
  assert.ok(!received!.systemInstructions!.includes('Later description'));
  assert.equal(fixture.app.store.get<CompletionReceipt>('chat-results', state.chat.id)!.attemptId, state.attempt.id);
  assert.equal(chats.get(state.chat.id).attemptId, state.attempt.id);
});

test('ended and stale factory conversations reject new provider turns without losing their transcript or receipts', async t => {
  const fixture = await harness(t), chats = new ChatController(fixture.app);
  t.mock.method(chats.manager, 'runTurn', async () => assert.fail('Ended or stale factory source cannot start another provider turn'));
  await new Promise<void>(resolve => fixture.app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(fixture.app.server.address() as AddressInfo).port}`;
  for (const change of ['ended', 'checking', 'replaced', 'revision', 'new-chat'] as const) {
    const state = fixture.seed(change === 'ended' || change === 'checking' ? 'succeeded' : 'running');
    if (change === 'ended') {
      fixture.app.store.set('tasks', { ...state.task, status: 'failed' });
      fixture.app.store.set('attempts', { ...state.attempt, status: 'failed' });
    } else if (change === 'checking') fixture.app.store.set('tasks', { ...state.task, status: 'review' });
    else if (change === 'replaced') fixture.app.store.set('tasks', { ...state.task, currentAttemptId: 'replacement' });
    else if (change === 'revision') fixture.app.store.set('goals', { ...state.goal, revision: 3 });
    const chatId = change === 'new-chat' ? 'other-chat' : state.chat.id;
    if (change === 'new-chat') fixture.app.store.set('chats', { ...state.chat, id: chatId });
    fixture.app.store.set('chat-results', { ...state.completion, id: chatId });
    const before = fixture.app.store.get('chat-results', chatId), events = chats.events(chatId);
    const response = await fetch(`${origin}/api/chats/${chatId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${fixture.app.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Repair this failure' }),
    });
    assert.equal(response.status, 409, change);
    const error = await response.json() as { code: string; details: { goalId: string; taskId: string; attemptId: string } };
    assert.equal(error.code, 'FACTORY_TASK_RETRY_REQUIRED');
    assert.equal(error.details.goalId, state.goal.id); assert.equal(error.details.taskId, state.task.id); assert.equal(error.details.attemptId, state.attempt.id);
    assert.deepEqual(fixture.app.store.get('chat-results', chatId), before);
    assert.deepEqual(chats.events(chatId), events);
  }
});

test('ordinary chats and answers to an already pending factory question retain their existing flow', async t => {
  const fixture = await harness(t), chats = new ChatController(fixture.app);
  const engine = { ready: { instance: 'fake-container', workdir: '/workspace/existing' } } as ReturnType<DeviceApp['sessions']['get']>;
  t.mock.method(fixture.app.sessions, 'get', () => engine);
  let state = fixture.seed('running');
  fixture.app.store.delete('factory-workers', state.attempt.id);
  t.mock.method(chats.manager, 'runTurn', async (input: TurnInput) => ({ threadId: 'normal-thread', text: input.prompt }));
  const normal = await chats.run(state.chat.id, 'Ordinary conversation');
  assert.equal(normal.text, 'Ordinary conversation');
  assert.equal(fixture.app.store.get<CompletionReceipt>('chat-results', state.chat.id)!.attemptId, undefined);

  state = fixture.seed('running');
  let questionEntered!: () => void;
  const entered = new Promise<void>(resolve => { questionEntered = resolve; });
  t.mock.method(chats.manager, 'runTurn', async (_input: TurnInput, callbacks: TurnCallbacks) => {
    const pending = callbacks.onQuestion!({ id: 'question', chatId: state.chat.id, questions: [{ id: 'choice' }] }, new AbortController().signal);
    questionEntered();
    assert.deepEqual(await pending, { choice: { answers: ['Use the existing design'] } });
    return { threadId: state.chat.threadId, text: 'Continued after the answer', stopReason: 'completed' };
  });
  const turn = chats.run(state.chat.id, 'Ask a question', { attemptId: state.attempt.id, autonomous: false });
  await entered;
  // The original live turn may still ask for input while its task has changed; answering is not a new turn.
  fixture.app.store.set('goals', { ...state.goal, revision: 3 });
  await fixture.app.dispatch({ method: 'POST', url: new URL(`http://local/api/chats/${state.chat.id}/messages`), body: { text: 'Use the existing design' } });
  await turn;
  assert.equal(chats.get(state.chat.id).status, 'idle');
  assert.equal(fixture.app.store.get<CompletionReceipt>('chat-results', state.chat.id)!.attemptId, state.attempt.id);
});

test('stale authority and mismatched legacy receipts remain unknown instead of authorizing execution or success', async t => {
  const fixture = await harness(t);
  const changes: Array<[string, (state: ReturnType<typeof fixture.seed>) => void]> = [
    ['retired authority', state => fixture.app.store.set('attempts', { ...state.attempt, status: 'retired' as const })],
    ['replacement authority', state => fixture.app.store.set('tasks', { ...state.task, currentAttemptId: 'replacement' })],
    ['replacement generation', state => fixture.app.store.set('attempts', { ...state.attempt, generation: state.attempt.generation + 1 })],
    ['stale revision', state => fixture.app.store.set('factory-attempt-details', { ...state.detail, goalRevision: 1 })],
    ['different session', state => fixture.app.store.set('chats', { ...state.chat, sessionId: 'other-session' })],
    ['different provider thread', state => fixture.app.store.set('chat-results', { ...state.completion, result: { ...state.completion.result, threadId: 'other-thread' } })],
    ['completion predates attempt start', state => fixture.app.store.set('factory-workers', { ...state.worker, attempt: { ...state.attempt, startedAt: '2026-10-05T00:00:03.000Z' } })],
    ['receipt from another attempt', state => fixture.app.store.set('chat-results', { ...state.completion, attemptId: 'other-attempt' })],
  ];
  for (const [reason, change] of changes) {
    const state = fixture.seed();
    fixture.app.store.set('chat-results', state.completion);
    change(state);
    const report = await fixture.factory.runtime.reconcile(state.attempt);
    assert.equal(report.status, 'unknown', reason);
    assert.equal(report.workspace, undefined, reason);
    assert.equal(report.result, undefined, reason);
    assert.equal(fixture.app.store.get<WorkerReceipt>('factory-workers', state.attempt.id)!.status, 'unknown', reason);
    assert.equal(fixture.app.store.get<Chat>('chats', state.chat.id)!.attemptId, undefined, reason);
  }
});

test('real runtime readiness wakes availability waits without resuming paused or canceled goals', async t => {
  const fixture = await harness(t);
  const state = fixture.seed();
  const base: ControlRecord = { id: state.goal.id, stage: 'plan', spent: 0, startedAt: state.goal.createdAt, steering: [], waitingFor: 'runtime-available', waitReason: 'The runtime was stopped', wakeAt: '2026-10-05T00:01:00Z' };
  fixture.app.store.set('factory-task-details', { id: state.task.id, key: state.task.id, checks: [], planRevision: state.goal.revision, selected: true, failureSignatures: [] });
  for (const status of ['waiting', 'paused', 'canceled'] as const) {
    fixture.app.store.set('goals', { ...state.goal, status });
    fixture.app.store.set('factory-control', base);
    fixture.app.emit('runtime', { state: 'starting' });
    assert.equal(fixture.app.store.get<Goal>('goals', state.goal.id)!.status, status);
    fixture.app.emit('runtime', { state: 'ready' });
    assert.equal(fixture.app.store.get<Goal>('goals', state.goal.id)!.status, status === 'waiting' ? 'planning' : status);
    if (status === 'waiting') {
      const control = fixture.app.store.get<ControlRecord>('factory-control', state.goal.id)!;
      assert.equal(control.waitingFor, undefined);
      assert.equal(control.wakeAt, undefined, 'a satisfied condition cannot leave an obsolete timer behind');
    }
  }
  fixture.app.store.set('goals', { ...state.goal, status: 'waiting' });
  fixture.app.store.set('factory-control', { ...base, waitingFor: 'credentials-changed', wakeAt: undefined });
  fixture.app.emit('runtime', { state: 'ready' });
  assert.equal(fixture.app.store.get<ControlRecord>('factory-control', state.goal.id)!.waitingFor, 'credentials-changed');
  fixture.app.store.set('factory-control', { ...base, wakeAt: undefined });
  t.mock.method(fixture.app.sessions.engine, 'detect', async () => ({ available: true, version: 'fixture' }));
  t.mock.method(fixture.app.runtime, 'status', async () => ({ state: 'ready' } as Awaited<ReturnType<DeviceApp['runtime']['status']>>));
  await fixture.app.refreshDiagnostics();
  assert.equal(fixture.app.store.get<Goal>('goals', state.goal.id)!.status, 'planning', 'startup diagnostic readiness uses the same wake producer as an explicit runtime start');
  fixture.app.store.set('goals', { ...state.goal, status: 'waiting' });
  fixture.app.store.set('factory-control', base);
  t.mock.method(fixture.app, 'assertRuntimeCanRun', () => { throw new Error('The runtime is suspended'); });
  fixture.app.emit('runtime', { state: 'ready' });
  assert.equal(fixture.app.store.get<Goal>('goals', state.goal.id)!.status, 'waiting', 'a ready socket cannot undo explicit runtime suspension');
});
