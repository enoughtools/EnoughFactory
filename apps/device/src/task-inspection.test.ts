import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Artifact, Attempt, AttemptInspection, ControllerRun, FactoryTask, Goal, GoalInspection, Project, TaskInspection } from '@enoughfactory/contracts';
import type { AttemptDetail, ControlRecord, PlanRecord, TaskDetail } from '@enoughfactory/factory';
import { DeviceApp } from './app.ts';
import type { ChatController } from './chats.ts';
import { initializeFactory } from './factory.ts';

test('authenticated inspection projects exact receipts without writes or invented phases, and unknown work blocks dispatch', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-inspection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousDirectory = process.env.ENOUGHFACTORY_HOME;
  let app: DeviceApp;
  try {
    process.env.ENOUGHFACTORY_HOME = directory;
    app = new DeviceApp();
  } finally {
    if (previousDirectory === undefined) delete process.env.ENOUGHFACTORY_HOME;
    else process.env.ENOUGHFACTORY_HOME = previousDirectory;
  }
  try {
    // Use the production HTTP handler and factory routes, with execution as a tripwire.
    t.mock.method(app, 'ensureRuntimeReady', async () => assert.fail('Inspection cannot start a runtime'));
    t.mock.method(app.runtime, 'prepareWorkspace', async () => assert.fail('Inspection cannot prepare a workspace'));
    const chats = new Proxy({} as ChatController, {
      get(_target, property) { return assert.fail(`Inspection cannot access the agent controller: ${String(property)}`); },
    });
    const factory = await initializeFactory(app, chats);
    await factory.coordinator.stop();

    const at = '2026-10-05T00:00:00.000Z';
    const project: Project = {
      id: 'project', name: 'Product', path: path.join(directory, 'repository'), deviceId: app.device.id,
      runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: at,
    };
    const goal: Goal = {
      id: 'goal', projectId: project.id, coordinatorId: app.device.id, title: 'Deliver the product',
      objective: 'Build the requested behavior', criteria: ['Behavior works'], status: 'running',
      autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 4,
      revision: 3, createdAt: at, updatedAt: at,
    };
    const accepted: FactoryTask = {
      id: 'accepted', goalId: goal.id, title: 'Deliver the feature', description: 'Implement the behavior',
      kind: 'feature', acceptanceCriteria: ['The requested scenario works'], expectedOutputs: ['A verified candidate'],
      dependsOn: [], status: 'completed', currentAttemptId: 'accepted-attempt', createdAt: at, updatedAt: at,
    };
    const uncertain: FactoryTask = {
      id: 'uncertain', goalId: goal.id, title: 'Recover interrupted work', description: 'Retain its identity',
      dependsOn: [], status: 'running', currentAttemptId: 'unknown-attempt', createdAt: at, updatedAt: at,
    };
    const queued: FactoryTask = {
      id: 'queued', goalId: goal.id, title: 'Independent work', description: 'Eligible when outcomes are reconciled',
      dependsOn: [], status: 'queued', createdAt: at, updatedAt: at,
    };
    const acceptedAttempt: Attempt = {
      id: 'accepted-attempt', taskId: accepted.id, generation: 2, deviceId: app.device.id,
      sessionId: 'accepted-session', chatId: 'accepted-chat', status: 'succeeded', startedAt: at, endedAt: at,
    };
    const failedAttempt: Attempt = {
      id: 'failed-attempt', taskId: accepted.id, generation: 1, deviceId: app.device.id,
      status: 'failed', startedAt: at, endedAt: at, error: 'The health scenario failed',
    };
    const unknownAttempt: Attempt = {
      id: 'unknown-attempt', taskId: uncertain.id, generation: 1, deviceId: app.device.id,
      status: 'unknown', startedAt: at, error: 'Owning device disconnected before its result arrived',
    };
    const check = {
      command: 'verify/feature', passed: true, output: 'Scenario returned the expected response\n',
      exitCode: 0, candidateCommit: 'candidate-sha', checkedCommit: 'candidate-sha',
    };
    const combinedCheck = { ...check, output: 'Combined repository scenario passed\n', checkedCommit: 'integrated-sha' };
    const failedCheck = {
      command: 'verify/feature', passed: false, output: 'Health scenario returned 503\n', exitCode: 17,
      candidateCommit: 'failed-candidate-sha', checkedCommit: 'failed-candidate-sha',
    };
    const acceptedDetail: AttemptDetail = {
      id: acceptedAttempt.id, goalId: goal.id, goalRevision: goal.revision, phase: 'done', cancellation: 'none',
      workspace: { id: 'workspace', path: '/private/workspace', provider: 'git', baseCommit: 'base-sha', sessionId: 'accepted-session', deviceId: app.device.id },
      candidate: { id: 'candidate', commit: 'candidate-sha', baseCommit: 'base-sha', tree: 'candidate-tree', branch: 'enoughfactory/candidate', deviceId: app.device.id, bundle: '/private/candidate.bundle' },
      result: { status: 'succeeded', text: 'Requested behavior implemented' }, checks: [check],
      integration: { commit: 'integrated-sha', previousHead: 'base-sha', candidateCommit: 'candidate-sha', checks: [combinedCheck] },
    };
    const artifact: Artifact & { path: string } = {
      id: 'proof', name: 'Scenario evidence', mime: 'text/plain', sha256: 'proof-hash', size: 72,
      deviceId: app.device.id, createdAt: at, goalId: goal.id, taskId: accepted.id,
      attemptId: acceptedAttempt.id, path: '/private/evidence.log',
    };
    app.device = { ...app.device, capacity: 8 };
    app.devices = [app.device];
    app.store.set('projects', project);
    app.store.set('goals', goal);
    for (const task of [accepted, uncertain, queued]) app.store.set('tasks', task);
    for (const attempt of [acceptedAttempt, failedAttempt, unknownAttempt]) app.store.set('attempts', attempt);
    app.store.set<PlanRecord>('factory-plans', {
      id: goal.id, goalId: goal.id, revision: goal.revision, summary: 'Deliver and verify',
      checks: ['verify/feature'], taskKeys: { accepted: accepted.id, uncertain: uncertain.id, queued: queued.id }, createdAt: at,
    });
    app.store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'dispatch', spent: 2, startedAt: at, steering: [] });
    app.store.set<TaskDetail>('factory-task-details', {
      id: accepted.id, key: 'accepted', checks: ['verify/feature'], planRevision: goal.revision,
      selected: true, failureSignatures: [], repairInstructions: 'Restore the health response',
    });
    app.store.set('factory-attempt-details', acceptedDetail);
    app.store.set<AttemptDetail>('factory-attempt-details', {
      id: failedAttempt.id, goalId: goal.id, goalRevision: 2, phase: 'checking', cancellation: 'none',
      checks: [failedCheck], result: { status: 'failed', text: '', error: 'The health scenario failed' },
    });
    // There is deliberately no detail/phase receipt for the unknown attempt.
    app.store.set('artifacts', artifact);
    app.store.set<ControllerRun>('factory-controller-runs', {
      id: 'planner', goalId: goal.id, role: 'planner', sessionId: 'planner-session', chatId: 'planner-chat', status: 'completed', updatedAt: at,
    });
    const buckets = ['goals', 'tasks', 'attempts', 'factory-plans', 'factory-control', 'factory-task-details', 'factory-attempt-details', 'artifacts', 'factory-controller-runs'];
    const before = buckets.map(bucket => app.store.list(bucket));
    t.mock.method(app.store, 'set', () => assert.fail('Inspection cannot write durable records'));
    t.mock.method(app.store, 'delete', () => assert.fail('Inspection cannot delete durable records'));
    t.mock.method(app.store, 'append', () => assert.fail('Inspection cannot append events'));

    // Bind only the existing server: app.listen would also run host diagnostics/recovery.
    await new Promise<void>((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', () => resolve());
    });
    const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const routes = [`/api/goals/${goal.id}/inspection`, `/api/tasks/${accepted.id}`, `/api/attempts/${acceptedAttempt.id}`];
    for (const route of routes) {
      const denied = await fetch(`${origin}${route}`);
      assert.equal(denied.status, 401, 'Inspection receipts require device authentication');
      await denied.arrayBuffer();
    }
    const wrongToken = await fetch(`${origin}${routes[1]}`, { headers: { authorization: 'Bearer invalid-token' } });
    assert.equal(wrongToken.status, 401);
    await wrongToken.arrayBuffer();
    async function read<T>(route: string): Promise<T> {
      const response = await fetch(`${origin}${route}`, { headers: { authorization: `Bearer ${app.token}` } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return await response.json() as T;
    }

    const goalView = await read<GoalInspection>(routes[0]!);
    assert.equal(goalView.tasks.find(item => item.task.id === accepted.id)!.state, 'accepted');
    assert.equal(goalView.tasks.find(item => item.task.id === uncertain.id)!.state, 'unknown');
    const queuedView = goalView.tasks.find(item => item.task.id === queued.id)!;
    assert.notEqual(queuedView.state, 'ready', 'A free worker and fulfilled dependencies cannot bypass an unknown current execution');
    assert.match(queuedView.reason!, /unknown|reconcil/i);
    assert.equal(goalView.controllers[0]!.chatId, 'planner-chat');
    assert.deepEqual(goalView.plan!.checks, ['verify/feature']);

    const taskView = await read<TaskInspection>(routes[1]!);
    assert.equal(taskView.task.kind, 'feature');
    assert.deepEqual(taskView.task.acceptanceCriteria, accepted.acceptanceCriteria);
    assert.deepEqual(taskView.task.expectedOutputs, accepted.expectedOutputs);
    assert.deepEqual(taskView.checks, ['verify/feature']);
    assert.deepEqual(taskView.attempts.map(item => item.attempt.id), [acceptedAttempt.id, failedAttempt.id]);
    assert.deepEqual(taskView.attempts[0]!.checks, [check]);
    assert.deepEqual(taskView.attempts[0]!.integration!.checks, [combinedCheck]);
    assert.deepEqual(taskView.attempts[1]!.checks, [failedCheck]);
    assert.equal(taskView.artifacts[0]!.sha256, artifact.sha256);
    assert.equal(Object.hasOwn(taskView.artifacts[0]!, 'path'), false);

    const attemptView = await read<AttemptInspection>(routes[2]!);
    assert.equal(attemptView.phase, 'done');
    assert.equal(attemptView.candidate!.commit, 'candidate-sha');
    assert.equal(attemptView.candidate!.baseCommit, 'base-sha');
    assert.equal(attemptView.integration!.commit, 'integrated-sha');
    assert.equal(attemptView.integration!.candidateCommit, 'candidate-sha');
    assert.deepEqual(attemptView.checks, [check]);
    assert.equal(Object.hasOwn(attemptView.workspace!, 'path'), false);
    assert.equal(Object.hasOwn(attemptView.candidate!, 'bundle'), false);
    const unknownView = await read<AttemptInspection>(`/api/attempts/${unknownAttempt.id}`);
    assert.equal(unknownView.attempt.status, 'unknown');
    assert.equal(Object.hasOwn(unknownView, 'phase'), false, 'No execution receipt means no invented preparation/checking phase');
    assert.equal(Object.hasOwn(unknownView, 'checks'), false);

    taskView.task.description = 'Mutated cached response';
    taskView.attempts[0]!.candidate!.commit = 'mutated-candidate';
    taskView.attempts[0]!.checks![0]!.output = 'mutated-output';
    const fresh = await read<TaskInspection>(routes[1]!);
    assert.equal(fresh.task.description, accepted.description);
    assert.equal(fresh.attempts[0]!.candidate!.commit, 'candidate-sha');
    assert.deepEqual(fresh.attempts[0]!.checks, [check]);
    assert.deepEqual(buckets.map(bucket => app.store.list(bucket)), before, 'Every inspection leaves coordination and receipts unchanged');
  } finally {
    await app.close();
  }
});

test('stale inspector commands preserve newer attempts, pause and replanning controls', async t => {
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-task-actions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousDirectory = process.env.ENOUGHFACTORY_HOME;
  let app: DeviceApp;
  try { process.env.ENOUGHFACTORY_HOME = directory; app = new DeviceApp(); }
  finally { if (previousDirectory === undefined) delete process.env.ENOUGHFACTORY_HOME; else process.env.ENOUGHFACTORY_HOME = previousDirectory; }
  try {
    t.mock.method(app, 'ensureRuntimeReady', async () => assert.fail('Task action validation cannot start a runtime'));
    const chats = new Proxy({} as ChatController, { get(_target, key) { return assert.fail(`Task action validation cannot use agents: ${String(key)}`); } });
    const factory = await initializeFactory(app, chats);
    factory.coordinator.stop();
    let cancellations = 0, cancelHook: () => Promise<void> = async () => {};
    t.mock.method(factory.runtime, 'cancel', async () => { cancellations++; await cancelHook(); });
    const at = '2026-10-05T00:00:00.000Z';
    const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: app.device.id, title: 'Deliver', objective: 'Deliver the behavior', criteria: ['Works'], status: 'running', autonomy: 'manual', approvalMode: 'approve-all', runtime: 'codex', concurrency: 1, revision: 3, createdAt: at, updatedAt: at };
    const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Implement', description: 'Implement the behavior', dependsOn: [], status: 'queued', createdAt: at, updatedAt: at };
    const first: Attempt = { id: 'first', taskId: task.id, generation: 1, deviceId: app.device.id, status: 'failed', startedAt: at, endedAt: at };
    const second: Attempt = { ...first, id: 'second', generation: 2 };
    const buckets = ['goals', 'tasks', 'attempts', 'factory-control', 'factory-task-details', 'factory-attempt-details', 'decisions'];
    const snapshot = () => buckets.map(bucket => app.store.list(bucket));
    function seed(goalPatch: Partial<Goal> = {}, taskPatch: Partial<FactoryTask> = {}, stage: ControlRecord['stage'] = 'dispatch') {
      app.store.transaction(() => {
        for (const bucket of buckets) for (const record of app.store.list<{ id: string }>(bucket)) app.store.delete(bucket, record.id);
        const currentGoal = { ...goal, ...goalPatch };
        app.store.set('goals', currentGoal); app.store.set('tasks', { ...task, ...taskPatch });
        app.store.set<ControlRecord>('factory-control', { id: goal.id, stage, spent: 0, startedAt: at, steering: [] });
        app.store.set<TaskDetail>('factory-task-details', { id: task.id, key: task.id, checks: [], planRevision: currentGoal.revision, selected: false, failureSignatures: [] });
        for (const attempt of [first, second]) {
          app.store.set('attempts', attempt);
          app.store.set<AttemptDetail>('factory-attempt-details', { id: attempt.id, goalId: goal.id, goalRevision: currentGoal.revision, phase: 'done', cancellation: 'none' });
        }
      });
    }
    await new Promise<void>((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', () => resolve()); });
    const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    async function post(route: string, body: Record<string, unknown> = {}) {
      const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      await response.json(); return response.status;
    }
    async function rejectWithoutEffects(route: string, body: Record<string, unknown>) {
      const before = snapshot(), canceled = cancellations;
      assert.equal(await post(route, body), 409);
      assert.deepEqual(snapshot(), before, 'Rejected stale commands must preserve execution authority and goal controls');
      assert.equal(cancellations, canceled, 'Rejected stale commands cannot cancel an owner');
    }
    const run = `/api/tasks/${task.id}/run`, retry = `/api/tasks/${task.id}/retry`;
    const expected = { expectedGoalRevision: goal.revision };
    seed({ status: 'paused' }); await rejectWithoutEffects(run, expected);
    seed({ status: 'planning', revision: 4 }, { status: 'canceled' }, 'plan'); await rejectWithoutEffects(run, expected);
    seed({ revision: 4 }); await rejectWithoutEffects(run, expected);
    seed({}, {}, 'evaluate'); await rejectWithoutEffects(run, expected);
    seed({}, { dependsOn: ['unfinished'] }); await rejectWithoutEffects(run, expected);
    seed({}, { status: 'running', currentAttemptId: second.id });
    app.store.set('attempts', { ...second, status: 'running' });
    await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });
    await rejectWithoutEffects(`/api/attempts/${first.id}/retire`, {});
    seed({}, { status: 'failed', currentAttemptId: second.id }); await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });
    seed({}, { status: 'failed', currentAttemptId: first.id }, 'diagnose'); await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });

    // Existing manual selection and legacy clients remain valid at the dispatch boundary.
    seed({ status: 'waiting' }); assert.equal(await post(run, expected), 200);
    assert.equal(app.store.get<Goal>('goals', goal.id)!.status, 'running');
    assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.selected, true);
    seed({}, { status: 'failed', currentAttemptId: first.id }); assert.equal(await post(retry), 200);
    assert.equal(app.store.get<Attempt>('attempts', first.id)!.status, 'retired');
    assert.equal(app.store.get<FactoryTask>('tasks', task.id)!.currentAttemptId, undefined);
    seed({}, { status: 'failed' }); assert.equal(await post(retry, { ...expected, expectedAttemptId: null }), 200);

    // The owner acknowledgement is asynchronous: newer coordinator state must win.
    for (const transition of ['steer', 'replacement'] as const) {
      seed({}, { status: 'failed', currentAttemptId: first.id });
      let acknowledge!: () => void, entered!: () => void;
      const acknowledgment = new Promise<void>(resolve => { acknowledge = resolve; });
      const cancelEntered = new Promise<void>(resolve => { entered = resolve; });
      cancelHook = async () => { entered(); await acknowledgment; };
      const pending = post(retry, { ...expected, expectedAttemptId: first.id });
      try {
        await cancelEntered;
        if (transition === 'steer') await factory.coordinator.steer(goal.id, { context: 'Revise the goal before continuing' });
        else {
          app.store.set('attempts', { ...second, status: 'running' });
          app.store.set('tasks', { ...task, status: 'running', currentAttemptId: second.id });
        }
        const controlBefore = app.store.get<ControlRecord>('factory-control', goal.id), goalBefore = app.store.get<Goal>('goals', goal.id), taskBefore = app.store.get<FactoryTask>('tasks', task.id);
        acknowledge(); assert.equal(await pending, 409);
        assert.deepEqual(app.store.get('factory-control', goal.id), controlBefore);
        assert.deepEqual(app.store.get('goals', goal.id), goalBefore);
        assert.deepEqual(app.store.get('tasks', task.id), taskBefore);
        if (transition === 'replacement') assert.equal(app.store.get<Attempt>('attempts', second.id)!.status, 'running');
      } finally { acknowledge(); cancelHook = async () => {}; await pending; }
    }
  } finally { await app.close(); }
});
