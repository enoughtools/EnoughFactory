import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import type { Attempt, Chat, ChatEvent, FactoryTask, Goal } from '@enoughfactory/contracts';
import type { AttemptDetail, FactoryStore, TaskDetail } from '@enoughfactory/factory';
import { WorkingDirectoryManager, WorkspaceManager } from '@enoughfactory/workspaces';
import {
  manualContinuationReceiptTable, retainManualContinuation,
  type ManualContinuationDependencies, type ManualContinuationInput, type ManualContinuationReceipt,
} from './manual-continuation-retention.ts';

const execute = promisify(execFile);
const git = async (directory: string, ...args: string[]) => (await execute('git', ['-C', directory, ...args])).stdout.trim();
function memoryStore(): FactoryStore {
  let tables = new Map<string, Map<string, unknown>>();
  return {
    list: <T>(table: string) => structuredClone([...(tables.get(table)?.values() ?? [])]) as T[],
    get: <T>(table: string, id: string) => structuredClone(tables.get(table)?.get(id)) as T | undefined,
    set: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(value.id, structuredClone(value)); },
    delete: (table, id) => { tables.get(table)?.delete(id); },
    transaction: fn => { const before = structuredClone(tables); try { return fn(); } catch (error) { tables = before; throw error; } },
  };
}
const originalTime = '2026-10-06T12:00:00.000Z', failedTime = '2026-10-06T12:01:00.000Z';
const manualTime = '2026-10-06T12:02:00.000Z', completedTime = '2026-10-06T12:03:00.000Z';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'enough-manual-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectPath = path.join(root, 'project'), extraPath = path.join(root, 'reference');
  await mkdir(projectPath); await mkdir(extraPath);
  await git(projectPath, 'init', '--quiet');
  await git(projectPath, 'config', 'user.name', 'Fixture'); await git(projectPath, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(projectPath, 'README.md'), 'Initial integrated project\n');
  await git(projectPath, 'add', '.'); await git(projectPath, 'commit', '-m', 'Initial project');
  await writeFile(path.join(extraPath, 'reference.txt'), 'Initial reference\n');
  const workspaces = new WorkspaceManager({ dataDir: path.join(root, 'owned'), deviceId: 'device' });
  const directories = new WorkingDirectoryManager({ dataDir: path.join(root, 'owned'), artifacts: workspaces.artifacts });
  const workspace = await workspaces.create({ projectPath, goalId: 'goal', taskId: 'task', attemptId: 'attempt' });
  const extra = (await directories.prepare({ identity: 'attempt', sources: [{ id: 'reference', name: 'Reference', path: extraPath }] }))[0]!;
  await writeFile(path.join(workspace.path, 'Client.swift'), 'Original failed source\n');
  await git(workspace.path, 'add', '.'); await git(workspace.path, 'commit', '-m', 'Original checked source');
  const oldExtra = await directories.captureFromPath(extra, extra.path);
  const oldCandidate = await workspaces.capture({ workspaceId: workspace.id, workingDirectories: [oldExtra] });
  const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: 'device', title: 'Email client', objective: 'Build the client', criteria: ['Works'], status: 'paused', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 8, revision: 4, createdAt: originalTime, updatedAt: failedTime };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Build client', description: 'Implement', dependsOn: [], status: 'failed', currentAttemptId: 'attempt', deviceId: 'device', sessionId: 'session', createdAt: originalTime, updatedAt: failedTime };
  const attempt: Attempt = { id: 'attempt', taskId: task.id, generation: 1, deviceId: 'device', sessionId: 'session', chatId: 'chat', status: 'failed', startedAt: originalTime, endedAt: failedTime, candidate: oldCandidate.commit, baseCommit: workspace.baseCommit, error: 'Checks failed' };
  const workspaceRef = { ...workspace, sessionId: 'session', workingDirectories: [{ id: extra.id, name: extra.name, path: extra.containerPath, kind: extra.kind, baseCommit: extra.baseCommit, status: 'captured' as const }] };
  const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, workspace: workspaceRef, candidate: { ...oldCandidate }, result: { status: 'succeeded', text: 'Original response' }, checks: [{ command: 'swift test', passed: false, output: 'Original failure', candidateCommit: oldCandidate.commit }], cancellation: 'none', phase: 'done' };
  const taskDetail: TaskDetail = { id: task.id, key: 'client', checks: ['swift test'], planRevision: 3, selected: false, failureSignatures: ['old failure'], lastError: 'Original failure', lastCandidate: { ...oldCandidate } };
  const chat: Chat = { id: 'chat', sessionId: 'session', deviceId: 'device', title: 'Build client', runtime: 'codex', attemptId: 'attempt', approvalMode: 'approve-all', status: 'idle', threadId: 'thread', createdAt: originalTime, updatedAt: completedTime };
  const worker = { id: attempt.id, coordinatorId: 'device', status: 'succeeded', goal, task, attempt, workspace: workspaceRef, candidate: oldCandidate, chatId: chat.id, sessionId: chat.sessionId, result: { status: 'succeeded', text: 'Original response' }, error: 'Original failure', updatedAt: failedTime };
  const events: ChatEvent[] = [
    { id: 'first', chatId: chat.id, seq: 1, at: originalTime, kind: 'message', role: 'user', text: 'Original task' },
    { id: 'manual', chatId: chat.id, seq: 22, at: manualTime, kind: 'message', role: 'user', text: 'Repair this source' },
    { id: 'output', chatId: chat.id, seq: 25, at: completedTime, kind: 'message', role: 'assistant', text: 'Repair finished' },
  ];
  const store = memoryStore();
  store.set('goals', goal); store.set('tasks', task); store.set('attempts', attempt); store.set('factory-attempt-details', detail);
  store.set('factory-task-details', taskDetail); store.set('factory-workers', worker); store.set('chats', chat);
  store.set('chat-results', { id: chat.id, result: { text: 'Repair finished', threadId: chat.threadId, stopReason: 'completed' }, completedAt: completedTime });
  const input: ManualContinuationInput = { goalId: goal.id, taskId: task.id, goalRevision: goal.revision, attemptId: attempt.id, oldCandidateId: oldCandidate.id, chatId: chat.id, turn: { userMessageSeq: 22, lastEventSeq: 25, completedAt: completedTime } };
  await writeFile(path.join(workspace.path, 'Client.swift'), 'Repaired source beyond the old candidate\n');
  await writeFile(path.join(workspace.path, 'NewFile.swift'), 'Previously untracked repair source\n');
  await writeFile(path.join(extra.path, 'reference.txt'), 'Updated manual repair reference\n');
  const calls: string[] = [];
  const deps: ManualContinuationDependencies = {
    store, deviceId: 'device', readChatEvents: () => structuredClone(events), chatIsRunning: () => false, workerJobsBusy: () => false,
    captureGitCommit: async () => {
      calls.push('commit'); await git(workspace.path, 'add', '--all');
      if (await git(workspace.path, 'diff', '--cached', '--name-only')) await git(workspace.path, 'commit', '-m', 'Preserve completed manual repair');
      return git(workspace.path, 'rev-parse', 'HEAD');
    },
    captureExtras: async () => { calls.push('extras'); return [await directories.captureFromPath(extra, extra.path)]; },
    validateGitCommit: async (_context, commit) => {
      if (await git(workspace.path, 'rev-parse', 'HEAD') !== commit || await git(workspace.path, 'status', '--porcelain')) throw new Error('Primary source changed since its retained commit; environment preserved');
    },
    stopSession: async () => { calls.push('stop'); assert.equal(await git(workspace.path, 'status', '--porcelain'), ''); },
    capture: async (_context, captureInput) => { calls.push('capture'); return { ...await workspaces.capture({ workspaceId: workspace.id, ...captureInput }) }; },
    now: () => new Date('2026-10-06T12:04:00.000Z'),
  };
  return { root, projectPath, workspace, workspaces, directories, extra, store, input, deps, events, calls, oldCandidate, goal, task, attempt, detail, taskDetail, worker, chat };
}

test('retains dirty primary and extra source in a fresh unchecked candidate without rewriting original evidence', async t => {
  const f = await fixture(t), projectHead = await git(f.projectPath, 'rev-parse', 'HEAD');
  const original = ['goals', 'tasks', 'attempts', 'factory-attempt-details', 'factory-workers', 'chats', 'chat-results'].map(table => [table, f.store.list(table)]);
  const receipt = await retainManualContinuation(f.input, f.deps);
  assert.equal(receipt.status, 'retained'); assert.notEqual(receipt.candidate!.id, f.oldCandidate.id);
  assert.notEqual(receipt.candidate!.commit, f.oldCandidate.commit); assert.deepEqual(f.calls, ['commit', 'extras', 'stop', 'capture']);
  assert.deepEqual(['goals', 'tasks', 'attempts', 'factory-attempt-details', 'factory-workers', 'chats', 'chat-results'].map(table => [table, f.store.list(table)]), original);
  assert.deepEqual(f.store.get<TaskDetail>('factory-task-details', 'task'), { ...f.taskDetail, lastCandidate: receipt.candidate });
  assert.deepEqual(await f.workspaces.candidate(f.oldCandidate.id), JSON.parse(JSON.stringify(f.oldCandidate)));
  const saved = await f.workspaces.candidate(receipt.candidate!.id), imported = path.join(f.root, 'retained-source');
  await f.workspaces.importSource({ artifact: saved.bundleArtifact, targetPath: imported, branch: 'retained' });
  assert.equal(await readFile(path.join(imported, 'Client.swift'), 'utf8'), 'Repaired source beyond the old candidate\n');
  assert.equal(await readFile(path.join(imported, 'NewFile.swift'), 'utf8'), 'Previously untracked repair source\n');
  const extraImport = path.join(f.root, 'owned', 'retained-extra');
  await f.directories.importCapture(saved.workingDirectories![0]!, extraImport);
  assert.equal(await readFile(path.join(extraImport, 'reference.txt'), 'utf8'), 'Updated manual repair reference\n');
  assert.equal(await git(f.projectPath, 'rev-parse', 'HEAD'), projectHead);
  assert.equal(await git(f.projectPath, 'status', '--porcelain'), '');
  assert.equal(f.store.list('decisions').length, 1);
  assert.equal((f.store.list<{data:{unchecked:boolean}}>('decisions')[0]!).data.unchecked, true);
});

test('refuses active, unknown, stale and mismatched authority before touching source', async t => {
  const f = await fixture(t);
  const refused = async (deps = f.deps, input = f.input) => {
    await assert.rejects(retainManualContinuation(input, deps), { status: 409 });
    assert.deepEqual(f.calls, []); assert.equal(f.store.list(manualContinuationReceiptTable).length, 0);
  };
  await refused({ ...f.deps, chatIsRunning: () => true });
  await refused({ ...f.deps, workerJobsBusy: () => true });
  f.store.set('factory-workers', { ...f.worker, status: 'unknown' }); await refused(); f.store.set('factory-workers', f.worker);
  f.store.set('goals', { ...f.goal, status: 'running' }); await refused(); f.store.set('goals', f.goal);
  await refused(f.deps, { ...f.input, goalRevision: 5 });
  await refused(f.deps, { ...f.input, oldCandidateId: 'wrong' });
  f.store.set('tasks', { ...f.task, currentAttemptId: 'replacement' }); await refused(); f.store.set('tasks', f.task);
  f.store.set('chats', { ...f.chat, status: 'interrupted' }); await refused(); f.store.set('chats', f.chat);
  f.store.set('factory-attempt-details', { ...f.detail, cancellation: 'requested' }); await refused();
});

test('requires the exact latest successful unbound turn range and provider completion', async t => {
  const f = await fixture(t), completed = f.store.get<{id:string;attemptId?:string;result:{threadId:string;stopReason:string};completedAt:string}>('chat-results', 'chat')!;
  const refused = async (input = f.input) => { await assert.rejects(retainManualContinuation(input, f.deps), { status: 409 }); assert.deepEqual(f.calls, []); };
  await refused({ ...f.input, turn: { ...f.input.turn, userMessageSeq: 1 } });
  await refused({ ...f.input, turn: { ...f.input.turn, lastEventSeq: 24 } });
  await refused({ ...f.input, turn: { ...f.input.turn, completedAt: manualTime } });
  f.store.set('chat-results', { ...completed, attemptId: 'attempt' }); await refused();
  f.store.set('chat-results', { ...completed, result: { ...completed.result, stopReason: 'interrupted' } }); await refused();
  f.store.set('chat-results', { ...completed, result: { ...completed.result, threadId: 'other' } }); await refused();
  f.store.set('chat-results', completed);
  f.events.push({ id: 'newer', chatId: 'chat', seq: 26, at: completedTime, kind: 'message', role: 'user', text: 'Another turn' }); await refused();
});

test('capture failure leaves durable exact commit and folder inputs for a safe idempotent retry', async t => {
  const f = await fixture(t); let fail = true;
  const deps = { ...f.deps, capture: async (...args: Parameters<ManualContinuationDependencies['capture']>) => {
    if (fail) { f.calls.push('capture-failed'); fail = false; throw new Error('Temporary artifact write failure'); }
    return f.deps.capture(...args);
  } };
  await assert.rejects(retainManualContinuation(f.input, deps), /Temporary artifact write failure/);
  const pending = f.store.list<ManualContinuationReceipt>(manualContinuationReceiptTable)[0]!;
  assert.equal(pending.status, 'pending'); assert.ok(pending.commit); assert.equal(pending.workingDirectories!.length, 1);
  assert.equal(f.store.get<TaskDetail>('factory-task-details', 'task')!.lastCandidate!.id, f.oldCandidate.id);
  const retained = await retainManualContinuation(f.input, deps);
  assert.equal(retained.commit, pending.commit); assert.equal(retained.status, 'retained');
  assert.deepEqual(f.calls, ['commit', 'extras', 'stop', 'capture-failed', 'stop', 'capture']);
  const again = await retainManualContinuation(f.input, deps);
  assert.deepEqual(again, retained); assert.equal(f.store.list('decisions').length, 1);
  assert.equal(f.calls.length, 6, 'The exact retained turn must not create another candidate or repeat side effects');
});

test('rechecks paused authority before publishing even when fresh candidate capture succeeded', async t => {
  const f = await fixture(t);
  const deps = { ...f.deps, capture: async (...args: Parameters<ManualContinuationDependencies['capture']>) => {
    const candidate = await f.deps.capture(...args); f.store.set('goals', { ...f.goal, revision: 5 }); return candidate;
  } };
  await assert.rejects(retainManualContinuation(f.input, deps), { status: 409 });
  const receipt = f.store.list<ManualContinuationReceipt>(manualContinuationReceiptTable)[0]!;
  assert.equal(receipt.status, 'pending'); assert.ok(receipt.candidate);
  assert.equal(f.store.get<TaskDetail>('factory-task-details', 'task')!.lastCandidate!.id, f.oldCandidate.id);
  assert.deepEqual(f.store.get('factory-attempt-details', 'attempt'), f.detail); assert.deepEqual(f.store.list('decisions'), []);
});

test('a new turn after committing prevents folder capture and environment stop', async t => {
  const f = await fixture(t);
  const deps = { ...f.deps, captureGitCommit: async (...args: Parameters<ManualContinuationDependencies['captureGitCommit']>) => {
    const commit = await f.deps.captureGitCommit(...args);
    f.events.push({ id: 'new', chatId: 'chat', seq: 26, at: completedTime, kind: 'message', role: 'user', text: 'Keep changing this' }); return commit;
  } };
  await assert.rejects(retainManualContinuation(f.input, deps), { status: 409 });
  assert.deepEqual(f.calls, ['commit']); assert.equal(f.store.get<TaskDetail>('factory-task-details', 'task')!.lastCandidate!.id, f.oldCandidate.id);
});

test('concurrent retries share one exact retention operation', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([retainManualContinuation(f.input, f.deps), retainManualContinuation(f.input, f.deps)]);
  assert.deepEqual(first, second); assert.deepEqual(f.calls, ['commit', 'extras', 'stop', 'capture']);
  assert.equal(f.store.list('decisions').length, 1);
});

test('refuses a fresh capture with mismatched refreshed working-folder evidence', async t => {
  const f = await fixture(t);
  const deps = { ...f.deps, capture: async (...args: Parameters<ManualContinuationDependencies['capture']>) => {
    const candidate = await f.deps.capture(...args); return { ...candidate, workingDirectories: f.oldCandidate.workingDirectories };
  } };
  await assert.rejects(retainManualContinuation(f.input, deps), /new immutable candidate for the exact preserved source/);
  assert.equal(f.store.get<TaskDetail>('factory-task-details', 'task')!.lastCandidate!.id, f.oldCandidate.id);
  assert.deepEqual(f.store.get('factory-attempt-details', 'attempt'), f.detail); assert.deepEqual(f.store.list('decisions'), []);
  const receipt = f.store.list<ManualContinuationReceipt>(manualContinuationReceiptTable)[0]!;
  assert.equal(receipt.status, 'pending'); assert.equal(receipt.candidate, undefined);
});

test('retains partial source from conclusively failed manual turns while refusing unknown or interrupted outcomes', async t => {
  for (const receiptFields of [{ executionEnded: true }]) {
    const f = await fixture(t);
    f.store.delete('chat-results', 'chat');
    f.store.set('chats', { ...f.chat, status: 'failed', error: 'Manual turn failed after writing partial source' });
    const failure = { id: 'chat', completedAt: completedTime, error: 'Manual turn failed', agentStarted: true };
    f.store.set('chat-turn-failures', { ...failure, code: 'RUNTIME_DISCONNECTED' });
    await assert.rejects(retainManualContinuation(f.input, f.deps), { status: 409 });
    f.store.set('chat-turn-failures', { ...failure, code: 'AGENT_TURN_FAILED', agentStarted: undefined });
    await assert.rejects(retainManualContinuation(f.input, f.deps), { status: 409 });
    f.store.set('chat-turn-failures', { ...failure, code: 'AGENT_TURN_FAILED', agentStarted: true });
    await assert.rejects(retainManualContinuation(f.input, f.deps), { status: 409 }, 'A generic CLI failure code does not prove the provider ended');
    f.store.set('chat-turn-failures', { ...failure, ...receiptFields });
    f.store.set('chats', { ...f.chat, status: 'interrupted' });
    await assert.rejects(retainManualContinuation(f.input, f.deps), { status: 409 });
    assert.deepEqual(f.calls, [], 'Unconfirmed outcomes must leave source and the running environment untouched');
    f.store.set('chats', { ...f.chat, status: 'failed', error: failure.error });
    const before = ['attempts', 'factory-attempt-details', 'factory-workers', 'chat-turn-failures'].map(table => [table, f.store.list(table)]);
    const receipt = await retainManualContinuation(f.input, f.deps);
    assert.equal(receipt.status, 'retained'); assert.equal(receipt.manualTurnOutcome, 'failed');
    assert.notEqual(receipt.candidate!.commit, f.oldCandidate.commit);
    assert.deepEqual(['attempts', 'factory-attempt-details', 'factory-workers', 'chat-turn-failures'].map(table => [table, f.store.list(table)]), before);
    const decision = f.store.list<{ text: string; data: { unchecked: boolean; manualTurnOutcome: string } }>('decisions')[0]!;
    assert.match(decision.text, /Partial source from the conclusively failed manual turn/);
    assert.equal(decision.data.unchecked, true); assert.equal(decision.data.manualTurnOutcome, 'failed');
    assert.equal(f.store.get<FactoryTask>('tasks', 'task')!.status, 'failed');
  }
});

test('a pending journal never stops newer dirty or committed primary work after a preparation failure', async t => {
  for (const commitNewer of [false, true]) {
    const f = await fixture(t);
    const deps = { ...f.deps, captureExtras: async () => { throw new Error('Temporary folder snapshot failure'); } };
    await assert.rejects(retainManualContinuation(f.input, deps), /Temporary folder snapshot failure/);
    const pending = f.store.list<ManualContinuationReceipt>(manualContinuationReceiptTable)[0]!;
    assert.ok(pending.commit); assert.equal(pending.status, 'pending');
    await writeFile(path.join(f.workspace.path, 'Later.swift'), 'A newer terminal edit must not be lost\n');
    if (commitNewer) { await git(f.workspace.path, 'add', '.'); await git(f.workspace.path, 'commit', '-m', 'Later terminal work'); }
    await assert.rejects(retainManualContinuation(f.input, f.deps), /Primary source changed/);
    assert.ok(!f.calls.includes('stop')); assert.ok(!f.calls.includes('capture'));
    assert.equal(await readFile(path.join(f.workspace.path, 'Later.swift'), 'utf8'), 'A newer terminal edit must not be lost\n');
    assert.equal(f.store.get<TaskDetail>('factory-task-details', 'task')!.lastCandidate!.id, f.oldCandidate.id);
    assert.equal(f.store.list('decisions').length, 0);
  }
});
