import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Attempt, FactoryTask, Goal, Project } from '@enoughfactory/contracts';
import type { AttemptDetail, FactoryStore, TaskDetail } from '@enoughfactory/factory';
import { taskCheckInputBlocker } from '@enoughfactory/factory';
import { ArtifactStore, WorkingDirectoryManager } from '@enoughfactory/workspaces';
import { configureTaskCheckInputs, freezeTaskCheckInputs } from './factory-check-inputs.ts';
import { factoryAttemptWorkingDirectorySources } from './factory.ts';

function fixture() {
  const tables = new Map<string, Map<string, unknown>>();
  const store: FactoryStore = {
    list: <T>(table: string) => [...tables.get(table)?.values() ?? []] as T[],
    get: <T>(table: string, id: string) => tables.get(table)?.get(id) as T | undefined,
    set: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(value.id, value); },
    delete: (table, id) => { tables.get(table)?.delete(id); }, transaction: fn => fn(),
  };
  const goal = { id: 'goal', projectId: 'project', coordinatorId: 'device', revision: 30, status: 'waiting', objective: 'Original exact objective', criteria: ['Original criterion'] } as Goal;
  const task = { id: 'task', goalId: goal.id, title: 'Verify native evidence', description: 'Original exact contract', status: 'failed', dependsOn: [], currentAttemptId: 'old-attempt', createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:01:00Z' } as FactoryTask;
  const project = { id: 'project', deviceId: 'device', workingDirectories: [{ id: 'verification', name: 'verification-inputs', path: '/private/configured/evidence' }, { id: 'support', name: 'support', path: '/private/configured/support' }] } as Project;
  const attempt = { id: 'old-attempt', taskId: task.id, generation: 1, status: 'failed', deviceId: 'device', startedAt: '2026-10-07T00:00:00Z', endedAt: '2026-10-07T00:01:00Z' } as Attempt;
  store.set('goals', goal); store.set('tasks', task); store.set('projects', project); store.set('attempts', attempt);
  store.set<TaskDetail>('factory-task-details', { id: task.id, key: 'native', checks: ['node validate.mjs'], planRevision: 30, selected: true, failureSignatures: [], waitingFor: 'native-evidence-ready', waitReason: 'Await the authentic native export', waitSince: '2026-10-07T00:01:00Z' });
  store.set<AttemptDetail>('factory-attempt-details', { id: attempt.id, goalId: goal.id, goalRevision: 30, phase: 'done', cancellation: 'none' });
  store.set('factory-workers', { id: attempt.id, coordinatorId: 'device', status: 'succeeded', result: { status: 'succeeded' } });
  store.set('factory-control', { id: goal.id, stage: 'dispatch', waitingFor: 'original-goal-wait' });
  const deps = { store, deviceId: 'device', workerBusy: () => false, chatIsRunning: () => false, now: () => '2026-10-07T00:02:00Z' };
  const input = { expectedGoalRevision: 30, expectedAttemptId: attempt.id, workingDirectoryIds: ['verification'], environment: { ENOUGH_EVIDENCE_ROOT: '/workspaces/verification-inputs/current', ENOUGH_NATIVE_INDEX_SHA256: 'a'.repeat(64) } };
  return { store, goal, task, project, attempt, deps, input };
}

test('authenticated check-input configuration leaves waiting/contracts and old attempts untouched, then freezes each new attempt', () => {
  const f = fixture();
  const preserved = ['goals', 'tasks', 'attempts', 'factory-attempt-details', 'factory-control'].map(table => JSON.stringify(f.store.list(table)));
  const before = f.store.get<TaskDetail>('factory-task-details', f.task.id)!;
  const configured = configureTaskCheckInputs(f.task.id, f.input, f.deps);
  assert.equal(configured.configurationRevision, 1);
  assert.deepEqual(['goals', 'tasks', 'attempts', 'factory-attempt-details', 'factory-control'].map(table => JSON.stringify(f.store.list(table))), preserved);
  assert.deepEqual({ ...f.store.get<TaskDetail>('factory-task-details', f.task.id)!, checkInputs: undefined }, { ...before, checkInputs: undefined });
  assert.equal(f.store.list('decisions').length, 1);
  f.store.set('factory-attempt-details', { id: 'new-attempt', goalId: f.goal.id, phase: 'preparing', cancellation: 'none' });
  const frozen = freezeTaskCheckInputs(f.store, f.task.id, 'new-attempt', f.project)!;
  configureTaskCheckInputs(f.task.id, { ...f.input, environment: { ...f.input.environment, ENOUGH_NATIVE_INDEX_SHA256: 'b'.repeat(64) } }, f.deps);
  assert.deepEqual(freezeTaskCheckInputs(f.store, f.task.id, 'new-attempt', f.project), frozen);
  assert.equal(frozen.environment.ENOUGH_NATIVE_INDEX_SHA256, 'a'.repeat(64));
  assert.deepEqual(f.store.get<AttemptDetail>('factory-attempt-details', 'new-attempt')!.checkInputs, frozen);
});

test('stale authority, active execution, secret environment and unselected paths cannot configure check inputs', () => {
  for (const change of [
    { expectedGoalRevision: 29 }, { expectedAttemptId: 'superseded' },
    { workingDirectoryIds: ['unknown'] }, { environment: { API_TOKEN: 'must-not-forward' } },
    { environment: { ENOUGH_EVIDENCE_ROOT: '/Users/russell/private' } },
    { environment: { ENOUGH_EVIDENCE_ROOT: '/workspaces/support/index.json' } },
    { environment: { ENOUGH_EVIDENCE_ROOT: '/workspaces/verification-inputs/../support' } },
    { environment: { ENOUGH_NATIVE_INDEX_SHA256: 'not-a-digest' } },
    { requiredCheckEnvironment: ['API_TOKEN'] }, { requiredCheckEnvironment: 'ENOUGH_EVIDENCE_ROOT' },
    { requiredCheckEnvironment: ['ENOUGH_EVIDENCE_ROOT', 'ENOUGH_EVIDENCE_ROOT'] },
  ]) {
    const f = fixture(), before = JSON.stringify(f.store.list('factory-task-details'));
    assert.throws(() => configureTaskCheckInputs(f.task.id, { ...f.input, ...change }, f.deps));
    assert.equal(JSON.stringify(f.store.list('factory-task-details')), before); assert.equal(f.store.list('decisions').length, 0);
  }
  for (const state of ['active', 'unknown', 'remote', 'revoked'] as const) {
    const f = fixture();
    if (state === 'active') f.store.set('chats', { id: 'chat', attemptId: f.attempt.id, status: 'running' });
    if (state === 'unknown') f.store.set('factory-workers', { id: f.attempt.id, coordinatorId: 'device', status: 'unknown' });
    if (state === 'remote') f.store.set('attempts', { ...f.attempt, deviceId: 'other-device' });
    if (state === 'revoked') f.store.set('factory-attempt-details', { ...f.store.get<AttemptDetail>('factory-attempt-details', f.attempt.id)!, cancellation: 'requested' });
    assert.throws(() => configureTaskCheckInputs(f.task.id, f.input, f.deps)); assert.equal(f.store.list('decisions').length, 0);
  }
});

test('verification prerequisites can be recorded without waking or rewriting a failed attempt', () => {
  const f = fixture();
  const preserved = ['goals', 'tasks', 'attempts', 'factory-attempt-details', 'factory-control'].map(table => JSON.stringify(f.store.list(table)));
  const requiredCheckEnvironment = ['ENOUGH_EVIDENCE_ROOT', 'ENOUGH_NATIVE_INDEX_SHA256', 'ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR'];
  configureTaskCheckInputs(f.task.id, { ...f.input, requiredCheckEnvironment }, f.deps);
  const detail = () => f.store.get<TaskDetail>('factory-task-details', f.task.id)!;
  assert.deepEqual(detail().requiredCheckEnvironment, requiredCheckEnvironment);
  assert.deepEqual(taskCheckInputBlocker(detail())?.missingEnvironment, ['ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR']);
  assert.equal(detail().waitingFor, 'native-evidence-ready');
  assert.deepEqual(['goals', 'tasks', 'attempts', 'factory-attempt-details', 'factory-control'].map(table => JSON.stringify(f.store.list(table))), preserved);
  configureTaskCheckInputs(f.task.id, { ...f.input, environment: { ...f.input.environment, ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR: '/workspaces/verification-inputs/native-ui/receipt.json' } }, f.deps);
  assert.deepEqual(detail().requiredCheckEnvironment, requiredCheckEnvironment);
  assert.equal(taskCheckInputBlocker(detail()), undefined);
  assert.equal(detail().waitingFor, 'native-evidence-ready');
  configureTaskCheckInputs(f.task.id, { ...f.input, requiredCheckEnvironment: [] }, f.deps);
  assert.deepEqual(detail().requiredCheckEnvironment, []);
});

test('explicit refresh replaces only the selected prior root in a new immutable attempt snapshot', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'enough-refresh-check-inputs-'));
  try {
    const owned = path.join(root, 'owned'), support = path.join(root, 'support'), verification = path.join(root, 'verification');
    for (const directory of [owned, support, verification]) await mkdir(directory);
    await writeFile(path.join(support, 'source.txt'), 'original support\n'); await writeFile(path.join(verification, 'index.json'), 'old evidence\n');
    const manager = new WorkingDirectoryManager({ dataDir: path.join(owned, 'workspace-data'), artifacts: new ArtifactStore(path.join(owned, 'artifacts'), 'device') });
    const project = { id: 'project', workingDirectories: [{ id: 'support', name: 'support', path: support }, { id: 'verification', name: 'verification-inputs', path: verification }] } as Project;
    const prior = await manager.prepare({ identity: 'original', sources: project.workingDirectories });
    const captures = [];
    for (const snapshot of prior) { const exported = path.join(owned, 'workspace-data', `export-${snapshot.id}`); await cp(snapshot.path, exported, { recursive: true }); captures.push(await manager.captureFromPath(snapshot, exported)); }
    const priorBytes = JSON.stringify(captures);
    await writeFile(path.join(support, 'source.txt'), 'unselected current support\n'); await writeFile(path.join(verification, 'index.json'), 'authentic new evidence\n');
    const sessions = { directoryManager: manager, workingDirectorySources: async (identity: string, selected: Project) => (await manager.prepare({ identity, sources: selected.workingDirectories })).map(({ path: _path, ...source }) => source) };
    await factoryAttemptWorkingDirectorySources(owned, sessions, 'new-attempt', project, captures, ['verification']);
    const actual = await manager.sourceSnapshots('new-attempt');
    assert.equal(await readFile(path.join(actual.find(item => item.id === 'support')!.path, 'source.txt'), 'utf8'), 'original support\n');
    assert.equal(await readFile(path.join(actual.find(item => item.id === 'verification')!.path, 'index.json'), 'utf8'), 'authentic new evidence\n');
    assert.equal(JSON.stringify(captures), priorBytes);
    await factoryAttemptWorkingDirectorySources(owned, sessions, 'default-retry', project, captures);
    assert.equal(await readFile(path.join((await manager.sourceSnapshots('default-retry')).find(item => item.id === 'verification')!.path, 'index.json'), 'utf8'), 'old evidence\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
