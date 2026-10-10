import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Attempt, Decision, Device, FactoryTask, Goal, Project } from '@enoughfactory/contracts';
import { FactoryCapacityError, FactoryCoordinator, type AttemptDetail, type CandidateRef, type CoordinatorOptions, type TaskDetail } from '@enoughfactory/factory';
import { factoryPreparationArtifactBytes } from './factory.ts';
import { HostDiskAdmission, HostDiskHeadroomError, PREPARATION_HEADROOM_BYTES } from './host-disk-admission.ts';
import { Store } from './store.ts';

const GiB = 1024 ** 3;
const originalCandidate: CandidateRef = { id: 'original-source', commit: 'retained-commit', baseCommit: 'base',
  bundleArtifact: { sha256: 'a'.repeat(64), size: GiB / 2 } };
const device: Device = { id: 'mac', name: 'Test Mac', local: true, online: true, platform: 'darwin', arch: 'arm64', capacity: 1, lastSeen: '2026-10-10T00:00:00Z' };
const project: Project = { id: 'project', name: 'Mail', path: '/project', deviceId: device.id, runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: device.lastSeen };

test('deferred preparation uses the current owner and frozen contract while later execution only needs provider headroom', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ef-preparation-floor-')), store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const goal: Goal = { id: 'goal', projectId: project.id, coordinatorId: device.id, title: 'Mail', objective: 'Build mail', criteria: [],
    status: 'waiting', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 1, revision: 1, createdAt: device.lastSeen, updatedAt: device.lastSeen };
  const sourceTask: FactoryTask = { id: 'source-task', goalId: goal.id, title: 'Source', description: '', dependsOn: [], status: 'completed', createdAt: device.lastSeen, updatedAt: device.lastSeen };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Current task', description: '', dependsOn: [], status: 'running', currentAttemptId: 'owner', createdAt: device.lastSeen, updatedAt: device.lastSeen };
  const attempt: Attempt = { id: 'owner', taskId: task.id, deviceId: device.id, generation: 2, status: 'created', startedAt: device.lastSeen };
  const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: 1, phase: 'preparing', capacityWait: 'preparing', cancellation: 'none',
    contract: { ...task, dependsOn: [sourceTask.id], checks: [], planRevision: 1 } };
  store.set('goals', goal); store.set('tasks', sourceTask); store.set('tasks', task); store.set('attempts', attempt); store.set('factory-attempt-details', detail);
  store.set<TaskDetail>('factory-task-details', { id: sourceTask.id, key: 'source', checks: [], planRevision: 1, selected: false, failureSignatures: [], lastCandidate: originalCandidate });
  let available = 6.25 * GiB;
  const disk = new HostDiskAdmission(() => ['/owned'], () => device.name, () => available);
  const admission = () => disk.blocker(PREPARATION_HEADROOM_BYTES + factoryPreparationArtifactBytes(store, goal) * 2);
  assert.equal(factoryPreparationArtifactBytes(store, goal), GiB / 2, 'The running deferred task retains its frozen dependency evidence reserve.');
  assert.match(admission()!.reason, /7\.0 GiB required/);
  available = 7 * GiB;
  assert.equal(admission(), undefined, 'The same scoped reservation threshold permits a genuine wake.');
  available = 6.25 * GiB;
  store.set('factory-attempt-details', { ...detail, capacityWait: 'executing', workspace: { id: attempt.id, path: '/prepared', baseCommit: 'base', provider: 'git' } });
  assert.equal(admission(), undefined, 'A prepared owner resumes provider setup without reserving already prepared input copies.');
  store.set('factory-attempt-details', detail);
  store.set('tasks', { ...task, currentAttemptId: 'replacement' });
  assert.equal(factoryPreparationArtifactBytes(store, goal), 0, 'A detached old attempt cannot impose a reserve on its successor.');
});

test('preparation capacity refusals yield durably and restore the same owner once space returns', async t => {
  for (const exactAdmission of [true, false]) await t.test(exactAdmission ? 'frozen preparation reserve' : 'space changed after general admission', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'ef-preparation-wake-'));
    let store = new Store(directory), at = Date.parse(device.lastSeen), available = 8 * GiB;
    let prepares = 0, providers = 0, captures = 0, checks = 0, integrations = 0, observations = 0;
    let coordinator: FactoryCoordinator;
    t.after(async () => { coordinator.stop(); store.close(); await rm(directory, { recursive: true, force: true }); });
    const disk = new HostDiskAdmission(() => ['/owned-state'], () => device.name, () => { observations++; return available; });
    const options: CoordinatorOptions = {
      get store() { return store; }, deviceId: device.id, devices: () => [device], project: () => project, now: () => new Date(at),
      admission: goal => disk.blocker(PREPARATION_HEADROOM_BYTES + (exactAdmission ? factoryPreparationArtifactBytes(store, goal) * 2 : 0)),
      runtime: {
        async complete({ role }) { return { text: JSON.stringify(role === 'planner'
          ? { summary: 'Implement mail', criteria: ['Mail works'], checks: [], tasks: [{ key: 'mail', title: 'Build mail', description: 'Build mail', dependsOn: [], checks: [] }] }
          : { complete: true, summary: 'Mail verified', criteria: [{ criterion: 'Mail works', satisfied: true, evidence: ['actual-check'] }] }) }; },
        async execute() { providers++; return { status: 'succeeded', text: 'Done' }; },
        async reconcile() { assert.fail('Positively refused preparation cannot be mistaken for unknown execution.'); },
        async cancel() { assert.fail('Disk restoration must preserve the original owner.'); },
      },
      workspaces: {
        async prepare({ attempt }) {
          prepares++;
          if (prepares === 1) available = 6.25 * GiB;
          // Bound a regressed self-kick loop so the test runner can report it.
          if (prepares > 4) available = 8 * GiB;
          let release: () => void;
          try { release = disk.reserve(attempt.id, GiB / 2); }
          catch (error) { assert(error instanceof HostDiskHeadroomError); throw new FactoryCapacityError(error.message, { cause: error }); }
          try { return { id: attempt.id, path: '/isolated', baseCommit: 'base', provider: 'git' }; } finally { release(); }
        },
        async capture(workspace) { captures++; return { id: workspace.id, commit: 'new-source', baseCommit: 'base' }; },
        async check() { checks++; return []; },
        async integrate(_project, candidate) { integrations++; return { commit: 'merged', previousHead: 'base', candidateCommit: candidate.commit, checks: [] }; },
        async inspect() { return { head: 'merged', branch: 'main', status: '' }; },
      },
    };
    coordinator = new FactoryCoordinator(options);
    const goal = coordinator.create({ projectId: project.id, objective: 'Build mail', criteria: ['Mail works'], autonomy: 'autonomous', approvalMode: 'approve-all', concurrency: 1 });
    await coordinator.tick(); await coordinator.waitForIdle();
    const task = store.list<FactoryTask>('tasks')[0]!;
    store.set('factory-task-details', { ...store.get<TaskDetail>('factory-task-details', task.id)!, lastCandidate: originalCandidate });
    const oldAttempt: Attempt = { id: 'previous-author', taskId: task.id, generation: 1, deviceId: device.id, status: 'failed', startedAt: device.lastSeen, endedAt: device.lastSeen };
    const oldDetail: AttemptDetail = { id: oldAttempt.id, goalId: goal.id, goalRevision: 1, phase: 'checking', cancellation: 'none', candidate: originalCandidate, result: { status: 'succeeded', text: 'Original authored source' },
      checks: [{ command: 'original-check', passed: false, output: 'Original failed evidence', candidateCommit: originalCandidate.commit }] };
    store.set('attempts', oldAttempt); store.set('factory-attempt-details', oldDetail);
    await coordinator.tick(); await coordinator.waitForIdle();
    const owner = store.list<Attempt>('attempts').find(attempt => attempt.id !== oldAttempt.id)!;
    const saved = store.get<AttemptDetail>('factory-attempt-details', owner.id)!;
    assert.equal(prepares, 1); assert.equal(providers, 0); assert.equal(owner.generation, 2); assert.equal(owner.status, 'created');
    assert.equal(saved.capacityWait, 'preparing'); assert.equal(saved.recoveryObservation!.retryAt, new Date(at + 10_000).toISOString());
    assert.equal(store.get<Goal>('goals', goal.id)!.status, 'waiting');
    store.close(); store = new Store(directory); coordinator = new FactoryCoordinator(options);
    const beforeRestart = observations;
    await coordinator.start(); await coordinator.waitForIdle();
    for (let index = 0; index < 5; index++) { await coordinator.tick(); await coordinator.waitForIdle(); }
    assert.equal(prepares, 1, 'Restart and completion microtasks cannot reopen preparation before its durable observation.');
    assert.equal(observations, beforeRestart, 'Repeated ticks before the due time perform no disk probes or wake decisions.');
    assert.equal(store.list<Decision>('decisions').filter(decision => decision.kind === 'woken').length, 0);
    at += 10_000;
    await coordinator.tick(); await coordinator.waitForIdle();
    await coordinator.tick(); await coordinator.waitForIdle();
    assert.equal(prepares, exactAdmission ? 1 : 2, 'Exact readiness waits; a capacity race gets only one fresh bounded attempt.');
    assert.equal(providers, 0); assert.equal(store.list<Attempt>('attempts').length, 2);
    assert.equal(store.get<Goal>('goals', goal.id)!.status, 'waiting');
    available = 8 * GiB; at += 10_000;
    await coordinator.tick(); await coordinator.waitForIdle();
    await coordinator.tick(); await coordinator.waitForIdle();
    assert.equal(providers, 1); assert.equal(captures, 1); assert.equal(checks, 1); assert.equal(integrations, 1);
    assert.equal(store.list<Attempt>('attempts').length, 2, 'Capacity recovery does not allocate a replacement author.');
    assert.equal(store.get<FactoryTask>('tasks', task.id)!.currentAttemptId, owner.id);
    assert.equal(store.get<FactoryTask>('tasks', task.id)!.status, 'completed');
    assert.equal(store.get<AttemptDetail>('factory-attempt-details', owner.id)!.capacityWait, undefined);
    assert.deepEqual(store.get<Attempt>('attempts', oldAttempt.id), oldAttempt);
    assert.deepEqual(store.get<AttemptDetail>('factory-attempt-details', oldAttempt.id), oldDetail, 'Original source, result and failed verification remain intact.');
  });
});
