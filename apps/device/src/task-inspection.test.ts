import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Artifact, Attempt, AttemptInspection, ControllerRun, Device, FactoryTask, Goal, GoalInspection, Project, TaskInspection } from '@enoughfactory/contracts';
import type { AttemptDetail, ControlRecord, FactoryRuntimePort, FactoryWorkspacePort, PlanRecord, TaskDetail } from '@enoughfactory/factory';
import { DeviceApp } from './app.ts';
import type { ChatController } from './chats.ts';
import { initializeFactory } from './factory.ts';
import { HostDiskAdmission } from './host-disk-admission.ts';

test('authenticated inspection projects exact receipts without writes and isolates unknown work to its dependency and write branches', async t => {
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
      dependsOn: [], writePaths: ['apps/device/'], status: 'running', currentAttemptId: 'unknown-attempt', createdAt: at, updatedAt: at,
    };
    const queued: FactoryTask = {
      id: 'queued', goalId: goal.id, title: 'Independent work', description: 'Eligible while another branch is reconciled', writePaths: ['apps/web/'],
      dependsOn: [], status: 'queued', createdAt: at, updatedAt: at,
    };
    const conflicting: FactoryTask = { ...queued, id: 'conflicting', title: 'Modify device health', writePaths: ['apps/device/health.ts'] };
    const dependent: FactoryTask = { ...queued, id: 'dependent', title: 'Use device changes', dependsOn: [uncertain.id] };
    const failure: FactoryTask = { ...queued, id: 'failure', title: 'Repair data export', status: 'failed', writePaths: ['apps/data/'] };
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
      appleValidation: { version: 1 as const, candidateId: 'candidate', candidateCommit: 'candidate-sha', checkedCommit: 'candidate-sha',
        profile: { tool: 'xcodebuild' as const, project: 'App.xcodeproj', scheme: 'App', platform: 'macos' as const, configuration: 'Debug' as const },
        sandbox: 'macos-seatbelt-deny-default' as const, developerDirectory: '/Applications/Xcode.app/Contents/Developer', workingDirectories: [],
        products: [{ id: 'native-product', name: 'Native app', mime: 'application/zip', sha256: 'product-hash', size: 72, deviceId: app.device.id, createdAt: at }] },
    };
    const combinedCheck = { ...check, output: 'Combined repository scenario passed\n', checkedCommit: 'integrated-sha', appleValidation: { ...check.appleValidation, checkedCommit: 'integrated-sha' } };
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
    app.device = { ...app.device, capacity: 8, workerResources: { cpus: 8, memoryGiB: 16 } };
    app.devices = [app.device];
    app.store.set('projects', project);
    app.store.set('goals', goal);
    for (const task of [accepted, uncertain, queued, conflicting, dependent, failure]) app.store.set('tasks', task);
    for (const attempt of [acceptedAttempt, failedAttempt, unknownAttempt]) app.store.set('attempts', attempt);
    app.store.set<PlanRecord>('factory-plans', {
      id: goal.id, goalId: goal.id, revision: goal.revision, summary: 'Deliver and verify',
      checks: ['verify/feature'], taskKeys: { accepted: accepted.id, uncertain: uncertain.id, queued: queued.id }, createdAt: at,
    });
    app.store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'dispatch', startedAt: at, steering: [] });
    app.store.set<TaskDetail>('factory-task-details', {
      id: accepted.id, key: 'accepted', checks: ['verify/feature'], planRevision: goal.revision,
      selected: true, failureSignatures: [], repairInstructions: 'Restore the health response',
    });
    app.store.set<TaskDetail>('factory-task-details', { id: failure.id, key: failure.id, checks: [], planRevision: goal.revision, selected: true, failureSignatures: [], waitingFor: 'export-service', waitReason: 'Waiting for the export service to return.' });
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
    assert.equal(queuedView.state, 'ready', 'An unrelated branch can run while a known footprint is reconciled');
    const conflictView = goalView.tasks.find(item => item.task.id === conflicting.id)!;
    assert.equal(conflictView.state, 'blocked');
    assert.match(conflictView.reason!, /Recover interrupted work/);
    const dependentView = goalView.tasks.find(item => item.task.id === dependent.id)!;
    assert.equal(dependentView.state, 'blocked');
    assert.match(dependentView.reason!, /Recover interrupted work/);
    const failureView = goalView.tasks.find(item => item.task.id === failure.id)!;
    assert.equal(failureView.state, 'waiting');
    assert.equal(failureView.reason, 'Waiting for the export service to return.');
    assert.equal(goalView.controllers[0]!.chatId, 'planner-chat');
    assert.deepEqual(goalView.plan!.checks, ['verify/feature']);

    const taskView = await read<TaskInspection>(routes[1]!);
    assert.equal(taskView.task.kind, 'feature');
    assert.deepEqual(taskView.task.acceptanceCriteria, accepted.acceptanceCriteria);
    assert.deepEqual(taskView.task.expectedOutputs, accepted.expectedOutputs);
    assert.deepEqual(taskView.checks, ['verify/feature']);
    assert.deepEqual(taskView.attempts.map(item => item.attempt.id), [acceptedAttempt.id, failedAttempt.id]);
    assert.deepEqual(taskView.attempts[0]!.checks, [check]);
    assert.equal(taskView.attempts[0]!.checks![0]!.appleValidation!.products[0]!.id, 'native-product', 'Native product references survive public check projection');
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
  t.mock.method(HostDiskAdmission.prototype, 'blocker', () => undefined);
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
    app.device = { ...app.device, capacity: 8, workerResources: { cpus: 4, memoryGiB: 4 } };
    app.devices = [app.device];
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
        app.store.set<ControlRecord>('factory-control', { id: goal.id, stage, startedAt: at, steering: [] });
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
    seed({ coordinatorId: 'another-coordinator' }); await rejectWithoutEffects(run, expected);
    seed({}, {}, 'evaluate'); await rejectWithoutEffects(run, expected);
    seed({}, { dependsOn: ['unfinished'] }); await rejectWithoutEffects(run, expected);
    seed({}, { status: 'running', currentAttemptId: second.id });
    app.store.set('attempts', { ...second, status: 'running' });
    await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });
    await rejectWithoutEffects(`/api/attempts/${first.id}/retire`, {});
    seed({}, { status: 'failed', currentAttemptId: second.id }); await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });
    seed({}, { status: 'failed', currentAttemptId: first.id }, 'diagnose'); await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });

    function reserve(status: Attempt['status'], writePaths: string[] | undefined = ['src/shared/'], contractPaths: string[] | undefined = writePaths) {
      const writer: FactoryTask = { ...task, id: 'writer', title: 'Shared component work', status: 'running', writePaths, currentAttemptId: 'writer-attempt', deviceId: app.device.id };
      const attempt: Attempt = { ...first, id: 'writer-attempt', taskId: writer.id, status };
      app.store.set('tasks', writer); app.store.set('attempts', attempt);
      app.store.set<TaskDetail>('factory-task-details', { id: writer.id, key: writer.id, checks: [], planRevision: goal.revision, selected: false, failureSignatures: [] });
      app.store.set<AttemptDetail>('factory-attempt-details', { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, phase: 'executing', cancellation: 'none',
        contract: { title: writer.title, description: writer.description, dependsOn: [], checks: [], planRevision: goal.revision, writePaths: contractPaths } });
      return writer;
    }
    async function viewTask(): Promise<TaskInspection> {
      const response = await fetch(`${origin}/api/tasks/${task.id}`, { headers: { authorization: `Bearer ${app.token}` } });
      assert.equal(response.status, 200); return await response.json() as TaskInspection;
    }

    // Missing coordinator evidence blocks both manual dispatch and the read projection,
    // while keeping failed attempt receipts and configured values private.
    for (const status of ['queued', 'ready', 'failed'] as const) {
      seed({}, { status, ...(status === 'failed' ? { currentAttemptId: first.id } : {}) });
      const detail = app.store.get<TaskDetail>('factory-task-details', task.id)!;
      app.store.set<TaskDetail>('factory-task-details', { ...detail,
        requiredCheckEnvironment: ['EVIDENCE_ROOT', 'EVIDENCE_DESCRIPTOR'],
        ...(status === 'failed' ? { waitingFor: 'verified-export', waitReason: 'The coordinator must supply the verification export.', waitSince: at } : {}),
        checkInputs: { configurationRevision: 1, workingDirectoryIds: [], environment: { EVIDENCE_ROOT: '/private/coordinator-evidence' },
          goalRevision: goal.revision, configuredAgainstAttemptId: status === 'failed' ? first.id : null, configuredAt: at, configuredByDeviceId: app.device.id } });
      const before = snapshot(), view = await viewTask();
      assert.equal(view.state, 'waiting');
      assert.deepEqual(view.verificationInputs, { missingEnvironment: ['EVIDENCE_DESCRIPTOR'] });
      assert.match(view.reason!, /verification evidence/i);
      assert.equal(JSON.stringify(view).includes('/private/coordinator-evidence'), false);
      assert.deepEqual(snapshot(), before, 'Reading prerequisite metadata cannot change task or attempt state');
      if (status === 'failed') {
        assert.deepEqual(view.wait, { condition: 'verified-export', reason: 'The coordinator must supply the verification export.', since: at });
        assert.equal(app.store.get<Attempt>('attempts', first.id)!.status, 'failed');
        await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });
      } else {
        await rejectWithoutEffects(run, expected);
        app.store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'plan', startedAt: at, steering: [] });
        assert.equal((await viewTask()).state, 'waiting', 'Controller activity cannot disguise a missing verification prerequisite as queued work');
      }
    }
    seed();
    const configured = app.store.get<TaskDetail>('factory-task-details', task.id)!;
    app.store.set<TaskDetail>('factory-task-details', { ...configured, requiredCheckEnvironment: ['EVIDENCE_DESCRIPTOR'],
      checkInputs: { configurationRevision: 2, workingDirectoryIds: [], environment: { EVIDENCE_DESCRIPTOR: '/private/verified/export.json' },
        goalRevision: goal.revision, configuredAgainstAttemptId: null, configuredAt: at, configuredByDeviceId: app.device.id } });
    const configuredView = await viewTask();
    assert.equal(configuredView.verificationInputs, undefined);
    assert.equal(configuredView.state, 'queued', 'A configured prerequisite returns to the normal manual authorization rule');

    // A manual command follows the same footprint, resource and slot reservations as the board.
    seed({ concurrency: 4 }, { writePaths: ['src/shared/ui/'] });
    reserve('unknown', ['src/elsewhere/'], ['src/shared/']);
    assert.equal((await viewTask()).state, 'blocked');
    assert.match((await viewTask()).reason!, /overlapping write paths/);
    await rejectWithoutEffects(run, expected);
    seed({ concurrency: 4 }, { status: 'failed', currentAttemptId: first.id, writePaths: ['src/shared/ui/'] });
    reserve('unknown');
    await rejectWithoutEffects(retry, { ...expected, expectedAttemptId: first.id });
    seed({ concurrency: 4 }, { writePaths: ['src/independent/'] }); reserve('unknown', []);
    await rejectWithoutEffects(run, expected);
    seed({ concurrency: 4 }, { resources: { cpus: 5 } });
    assert.match((await viewTask()).reason!, /CPU/);
    await rejectWithoutEffects(run, expected);
    seed({ concurrency: 4 }, { resources: { memoryGiB: 5 } });
    assert.match((await viewTask()).reason!, /memory/);
    await rejectWithoutEffects(run, expected);
    seed(); reserve('running', ['src/independent/']);
    assert.match((await viewTask()).reason!, /Goal concurrency/);
    await rejectWithoutEffects(run, expected);
    seed({ concurrency: 4 }); reserve('running', ['src/independent/']);
    app.devices = [{ ...app.device, capacity: 1 }];
    assert.match((await viewTask()).reason!, /Worker capacity/);
    await rejectWithoutEffects(run, expected);
    app.devices = [{ ...app.device, online: false }];
    assert.match((await viewTask()).reason!, /online worker/);
    await rejectWithoutEffects(run, expected);
    app.devices = [app.device];

    // Diagnosis and scoped replanning retain their authority while independent selected work continues.
    for (const stage of ['diagnose', 'plan'] as const) {
      seed({ concurrency: 4, status: stage === 'plan' ? 'planning' : 'running' }, { writePaths: ['src/independent/'] }, stage);
      const uncertain = reserve('unknown', ['src/elsewhere/']);
      const failure = { ...task, id: 'failure', title: 'Repair API branch', status: 'failed' as const, writePaths: ['src/api/'] };
      app.store.set('tasks', failure);
      app.store.set<TaskDetail>('factory-task-details', { id: failure.id, key: failure.id, checks: [], planRevision: goal.revision, selected: false, failureSignatures: [] });
      app.store.set<TaskDetail>('factory-task-details', { id: uncertain.id, key: uncertain.id, checks: [], planRevision: goal.revision, selected: true, failureSignatures: [] });
      const control: ControlRecord = { id: goal.id, stage, diagnosisTaskId: failure.id, ...(stage === 'plan' ? { replanTaskIds: [failure.id] } : {}), startedAt: at, steering: [], operation: { id: 'controller', revision: goal.revision, kind: stage === 'plan' ? 'planner' : 'diagnosis' } };
      app.store.set('factory-control', control);
      assert.equal(await post(run, expected), 200);
      assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.selected, true);
      assert.equal(app.store.get<TaskDetail>('factory-task-details', uncertain.id)!.selected, true, 'Selecting one branch preserves selection of other work');
      assert.equal(app.store.get<ControlRecord>('factory-control', goal.id)!.stage, stage);
      assert.deepEqual(app.store.get<ControlRecord>('factory-control', goal.id)!.operation, control.operation);
      assert.equal(app.store.get<Goal>('goals', goal.id)!.status, stage === 'plan' ? 'planning' : 'running');
    }

    // Existing manual selection and legacy clients remain valid at the dispatch boundary.
    seed({ status: 'waiting' }); assert.equal(await post(run, expected), 200);
    assert.equal(app.store.get<Goal>('goals', goal.id)!.status, 'running');
    assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.selected, true);
    seed({}, { status: 'failed', currentAttemptId: first.id }); assert.equal(await post(retry), 200);
    assert.equal(app.store.get<Attempt>('attempts', first.id)!.status, 'retired');
    assert.equal(app.store.get<FactoryTask>('tasks', task.id)!.currentAttemptId, undefined);
    seed({}, { status: 'failed' }); assert.equal(await post(retry, { ...expected, expectedAttemptId: null }), 200);

    // Feedback must be validated before retirement, and omission must preserve an existing repair request.
    seed({}, { status: 'failed', currentAttemptId: first.id });
    const beforeInvalidFeedback = snapshot(), canceledBeforeInvalidFeedback = cancellations;
    for (const repairInstructions of [42, 'x'.repeat(8001)]) assert.equal(await post(retry, { ...expected, expectedAttemptId: first.id, repairInstructions }), 400);
    assert.deepEqual(snapshot(), beforeInvalidFeedback); assert.equal(cancellations, canceledBeforeInvalidFeedback);
    assert.equal(await post(retry, { ...expected, expectedAttemptId: first.id, repairInstructions: '  Repair the existing archive workflow and preserve its data.\n  ' }), 200);
    assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.repairInstructions, 'Repair the existing archive workflow and preserve its data.');
    assert.equal(app.store.list<{ kind: string }>('decisions').filter(item => item.kind === 'task-retry-instructions').length, 1);
    seed({}, { status: 'failed' });
    app.store.set('factory-task-details', { ...app.store.get<TaskDetail>('factory-task-details', task.id)!, repairInstructions: 'Keep the existing request' });
    assert.equal(await post(retry, { ...expected, expectedAttemptId: null }), 200);
    assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.repairInstructions, 'Keep the existing request');
    seed({}, { status: 'failed' });
    app.store.set('factory-task-details', { ...app.store.get<TaskDetail>('factory-task-details', task.id)!, repairInstructions: 'Clear this request' });
    assert.equal(await post(retry, { ...expected, expectedAttemptId: null, repairInstructions: '' }), 200);
    assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.repairInstructions, undefined);

    // The owner acknowledgement is asynchronous: newer coordinator state must win.
    for (const transition of ['steer', 'replacement', 'write-conflict'] as const) {
      seed({ concurrency: 4 }, { status: 'failed', currentAttemptId: first.id, writePaths: ['src/shared/ui/'] });
      let acknowledge!: () => void, entered!: () => void;
      const acknowledgment = new Promise<void>(resolve => { acknowledge = resolve; });
      const cancelEntered = new Promise<void>(resolve => { entered = resolve; });
      cancelHook = async () => { entered(); await acknowledgment; };
      const pending = post(retry, { ...expected, expectedAttemptId: first.id, repairInstructions: 'The original authorized repair request' });
      try {
        await cancelEntered;
        if (transition === 'steer') await factory.coordinator.steer(goal.id, { context: 'Revise the goal before continuing' });
        else if (transition === 'replacement') {
          app.store.set('attempts', { ...second, status: 'running' });
          app.store.set('tasks', { ...task, status: 'running', currentAttemptId: second.id });
        } else reserve('running');
        const controlBefore = app.store.get<ControlRecord>('factory-control', goal.id), goalBefore = app.store.get<Goal>('goals', goal.id), taskBefore = app.store.get<FactoryTask>('tasks', task.id);
        acknowledge(); assert.equal(await pending, 409);
        assert.deepEqual(app.store.get('factory-control', goal.id), controlBefore);
        assert.deepEqual(app.store.get('goals', goal.id), goalBefore);
        assert.deepEqual(app.store.get('tasks', task.id), taskBefore);
        if (transition === 'replacement') assert.equal(app.store.get<Attempt>('attempts', second.id)!.status, 'running');
        if (transition === 'write-conflict') assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.selected, false, 'A newly occupied write footprint cannot be authorized after cancellation acknowledgment');
        assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.repairInstructions, 'The original authorized repair request', 'Feedback was accepted atomically with retirement under the original authority; the stale response must not write it again');
      } finally { acknowledge(); cancelHook = async () => {}; await pending; }
    }

    // A formal retry produces a new generation with current policy and retained repair input, without adopting old checks.
    seed({ approvalMode: 'manual' }, { status: 'failed', currentAttemptId: first.id });
    const source = { id: 'unchecked-repair', commit: 'repair-commit', baseCommit: 'base' };
    const project: Project = { id: goal.projectId, name: 'Product', path: '/unused', deviceId: app.device.id, runtime: 'codex', approvalMode: 'rules', rules: [{ id: 'rule', tool: 'read', decision: 'allow' }], createdAt: at };
    app.store.set('projects', project);
    app.store.set('factory-task-details', { ...app.store.get<TaskDetail>('factory-task-details', task.id)!, lastCandidate: source });
    let preparation: Parameters<FactoryWorkspacePort['prepare']>[0] | undefined, execution: Parameters<FactoryRuntimePort['execute']>[0] | undefined;
    t.mock.method(factory.workspacePort, 'prepare', async (input: Parameters<FactoryWorkspacePort['prepare']>[0]) => { preparation = input; return { id: 'new-workspace', path: '/isolated', provider: 'git', baseCommit: 'base' }; });
    t.mock.method(factory.runtime, 'execute', async (input: Parameters<FactoryRuntimePort['execute']>[0]) => { execution = input; return { status: 'unknown', text: '', error: 'No provider launched in this authority test' }; });
    cancelHook = async () => {
      assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.repairInstructions, 'Keep the manual repair and fix the archive failure', 'Cancellation acknowledgement may trigger dispatch immediately, so feedback must already be durable');
      assert.equal(app.store.get<FactoryTask>('tasks', task.id)!.status, 'queued');
    };
    assert.equal(await post(retry, { ...expected, expectedAttemptId: first.id, repairInstructions: 'Keep the manual repair and fix the archive failure' }), 200);
    await factory.coordinator.tick(); await factory.coordinator.waitForIdle();
    assert.ok(execution); assert.ok(preparation);
    assert.notEqual(execution.attempt.id, first.id); assert.equal(execution.attempt.generation, 3);
    assert.equal(execution.goal.approvalMode, 'manual'); assert.deepEqual(execution.project.rules, project.rules);
    assert.deepEqual(preparation.previousCandidate, source);
    assert.match(execution.prompt, /Keep the manual repair and fix the archive failure/);
    assert.equal(app.store.get<Attempt>('attempts', first.id)!.status, 'retired');
    assert.equal(app.store.get<AttemptDetail>('factory-attempt-details', execution.attempt.id)!.checks, undefined);
  } finally { await app.close(); }
});

test('retry acknowledges its authorized successor dispatched before cancellation returns', async t => {
  t.mock.method(HostDiskAdmission.prototype, 'blocker', () => undefined);
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-retry-dispatch-race-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const previousDirectory = process.env.ENOUGHFACTORY_HOME;
  let app: DeviceApp;
  try { process.env.ENOUGHFACTORY_HOME = directory; app = new DeviceApp(); }
  finally { if (previousDirectory === undefined) delete process.env.ENOUGHFACTORY_HOME; else process.env.ENOUGHFACTORY_HOME = previousDirectory; }
  let finishExecution!: (result: Awaited<ReturnType<FactoryRuntimePort['execute']>>) => void;
  try {
    t.mock.method(app, 'ensureRuntimeReady', async () => assert.fail('Retry race verification must not start a runtime'));
    const chats = new Proxy({} as ChatController, { get(_target, key) { return assert.fail(`Retry race verification must not use providers: ${String(key)}`); } });
    const factory = await initializeFactory(app, chats);
    factory.coordinator.stop();
    const at = '2026-10-06T00:00:00.000Z';
    const project: Project = { id: 'project', name: 'Product', path: '/unused-race-fixture', deviceId: app.device.id, runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: at };
    const goal: Goal = { id: 'goal', projectId: project.id, coordinatorId: app.device.id, title: 'Deliver', objective: 'Deliver the behavior', criteria: ['Works'], status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 1, revision: 8, createdAt: at, updatedAt: at };
    const failed: Attempt = { id: 'failed-attempt', taskId: 'task', generation: 4, deviceId: app.device.id, status: 'failed', startedAt: at, endedAt: at };
    const task: FactoryTask = { id: failed.taskId, goalId: goal.id, title: 'Repair', description: 'Repair the actual workflow', dependsOn: [], status: 'failed', currentAttemptId: failed.id, createdAt: at, updatedAt: at };
    const retained = { id: 'retained-candidate', commit: 'retained-commit', baseCommit: 'base' };
    app.store.transaction(() => {
      app.store.set('projects', project); app.store.set('goals', goal); app.store.set('tasks', task); app.store.set('attempts', failed);
      app.store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'dispatch', startedAt: at, steering: [] });
      app.store.set<TaskDetail>('factory-task-details', { id: task.id, key: task.id, checks: [], planRevision: goal.revision, selected: false, failureSignatures: [], lastCandidate: retained });
      app.store.set<AttemptDetail>('factory-attempt-details', { id: failed.id, goalId: goal.id, goalRevision: goal.revision, phase: 'done', cancellation: 'none', candidate: retained });
    });
    let execution!: Parameters<FactoryRuntimePort['execute']>[0];
    let entered!: () => void;
    const executionEntered = new Promise<void>(resolve => { entered = resolve; });
    const running = new Promise<Awaited<ReturnType<FactoryRuntimePort['execute']>>>(resolve => { finishExecution = resolve; });
    t.mock.method(factory.runtime, 'cancel', async () => {});
    t.mock.method(factory.workspacePort, 'prepare', async (input: Parameters<FactoryWorkspacePort['prepare']>[0]) => {
      assert.deepEqual(input.previousCandidate, retained);
      return { id: 'successor-workspace', path: '/isolated-fixture', provider: 'git', baseCommit: 'base' };
    });
    t.mock.method(factory.runtime, 'execute', async (input: Parameters<FactoryRuntimePort['execute']>[0]) => { execution = input; entered(); return running; });
    const retire = factory.coordinator.retireAttempt.bind(factory.coordinator);
    let dispatchedState: unknown[] = [];
    t.mock.method(factory.coordinator, 'retireAttempt', async (...args: Parameters<typeof retire>) => {
      await retire(...args);
      await factory.coordinator.tick();
      await executionEntered;
      dispatchedState = ['goals', 'tasks', 'factory-control', 'factory-task-details', 'decisions'].map(bucket => app.store.list(bucket));
    });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const response = await fetch(`${origin}/api/tasks/${task.id}/retry`, { method: 'POST', headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ expectedGoalRevision: goal.revision, expectedAttemptId: failed.id, repairInstructions: '  Preserve retained work and repair the submission workflow.  ' }) });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(execution.attempt.generation, 5); assert.notEqual(execution.attempt.id, failed.id);
    assert.equal(app.store.get<FactoryTask>('tasks', task.id)!.currentAttemptId, execution.attempt.id);
    assert.equal(app.store.get<Attempt>('attempts', failed.id)!.status, 'retired');
    assert.equal(app.store.get<AttemptDetail>('factory-attempt-details', failed.id)!.cancellation, 'acknowledged');
    assert.match(execution.prompt, /Preserve retained work and repair the submission workflow\./);
    assert.equal(app.store.get<TaskDetail>('factory-task-details', task.id)!.repairInstructions, 'Preserve retained work and repair the submission workflow.');
    assert.equal(app.store.list<Attempt>('attempts').length, 2, 'Acknowledging the dispatched retry must not create another successor');
    assert.deepEqual(['goals', 'tasks', 'factory-control', 'factory-task-details', 'decisions'].map(bucket => app.store.list(bucket)), dispatchedState, 'The successful response must not re-select work or overwrite advanced controller state');
    finishExecution({ status: 'unknown', text: '', error: 'Fixture provider outcome intentionally unresolved' });
    await factory.coordinator.waitForIdle();
  } finally { finishExecution?.({ status: 'unknown', text: '' }); await app.close(); }
});

test('task-local prerequisite waits expose their actual age without changing failed outcomes or retained history', async t => {
  const { FactoryCoordinator } = await import('@enoughfactory/factory');
  const { Store } = await import('./store.ts');
  const { inspectTask } = await import('./task-inspection.ts');
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-task-wait-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const failureAt = '2026-10-05T00:00:00.000Z', waitAt = '2026-10-05T00:20:00.000Z';
  const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: 'owner', title: 'Deliver', objective: 'Deliver the actual behavior', criteria: ['Behavior works'],
    status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 2, revision: 1, createdAt: failureAt, updatedAt: failureAt };
  const task: FactoryTask = { id: 'waiting-task', goalId: goal.id, title: 'Validate native evidence', description: 'Consume coordinator-owned native evidence', dependsOn: [],
    status: 'failed', currentAttemptId: 'failed-attempt', createdAt: failureAt, updatedAt: failureAt };
  const attempt: Attempt = { id: 'failed-attempt', taskId: task.id, generation: 1, deviceId: 'owner', status: 'failed', startedAt: failureAt, endedAt: failureAt, error: 'Required evidence was absent' };
  const detail: TaskDetail = { id: task.id, key: 'native-evidence', checks: [], planRevision: 1, selected: true, failureSignatures: [], lastError: attempt.error };
  const result: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: 1, phase: 'checking', cancellation: 'none', result: { status: 'succeeded', text: 'Provider turn completed' } };
  const project: Project = { id: 'project', name: 'Product', path: '/isolated/project', deviceId: 'owner', runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: failureAt };
  store.set('goals', goal); store.set('tasks', task); store.set('attempts', attempt); store.set('factory-task-details', detail); store.set('factory-attempt-details', result);
  store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'diagnose', diagnosisTaskId: task.id, startedAt: failureAt, steering: [] });
  const coordinator = new FactoryCoordinator({ store, deviceId: 'owner', devices: () => [], project: () => project, now: () => new Date(waitAt),
    workspaces: {} as FactoryWorkspacePort,
    runtime: { complete: async () => ({ text: JSON.stringify({ action: 'wait', reason: 'Authenticated native evidence is required.', waitReason: 'The coordinator must supply the original native export.', wakeCondition: 'native-export-ready' }) }),
      execute: async () => assert.fail('A waiting task cannot execute'), reconcile: async () => assert.fail('A confirmed failure cannot reconcile'), cancel: async () => assert.fail('Recording a wait cannot cancel its attempt') } });
  await coordinator.tick(); await coordinator.waitForIdle();
  assert.equal(store.get<TaskDetail>('factory-task-details', task.id)!.waitSince, waitAt);
  assert.deepEqual(store.get<Attempt>('attempts', attempt.id), attempt);
  assert.equal(store.get<FactoryTask>('tasks', task.id)!.status, 'failed');
  assert.equal(store.get<Goal>('goals', goal.id)!.status, 'running');
  const expected = { condition: 'native-export-ready', reason: 'The coordinator must supply the original native export.', since: waitAt };
  assert.deepEqual(inspectTask(store, [], task).wait, expected, 'Task waits are independent of global goal status and provider result');

  // Upgrade an existing wait: its immutable repair decision supplies the later timestamp.
  const current = store.get<TaskDetail>('factory-task-details', task.id)!;
  store.set('factory-task-details', { ...current, waitSince: undefined });
  const buckets = ['goals', 'tasks', 'attempts', 'factory-task-details', 'factory-attempt-details', 'factory-control', 'decisions'];
  const before = buckets.map(bucket => store.list(bucket));
  const view = inspectTask(store, [], task);
  assert.deepEqual(view.wait, expected);
  assert.equal(view.state, 'waiting');
  assert.equal(view.task.updatedAt, failureAt, 'Inspection does not replace historical failure timing');
  assert.deepEqual(JSON.parse(JSON.stringify(view.attempts[0]!.result)), result.result);
  assert.deepEqual(buckets.map(bucket => store.list(bucket)), before, 'Legacy fallback is a read-only projection');
  store.set('factory-task-details', { ...current, waitSince: undefined, waitingFor: undefined });
  assert.equal(inspectTask(store, [], task).wait, undefined, 'A cleared condition cannot expose a stale wake action');
});

test('native capability readiness projects a durable prerequisite without rewriting attempt outcomes', async t => {
  const { Store } = await import('./store.ts');
  const { inspectTask } = await import('./task-inspection.ts');
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-capability-inspection-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-10-08T00:00:00.000Z';
  const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: 'owner', title: 'Deliver', objective: 'Deliver the native app', criteria: ['The app works'],
    status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 2, revision: 1, createdAt: at, updatedAt: at };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Verify the native workflow', description: 'Use actual native tools', dependsOn: [],
    execution: { target: 'container', delegatedCapabilities: ['macos-app-inspection'] }, status: 'queued', createdAt: at, updatedAt: at };
  const device: Device = { id: 'owner', name: 'Test Mac', platform: 'darwin', arch: 'arm64', online: true, lastSeen: at, local: true, executionTargets: [
    { id: 'container', kind: 'container', protocolVersion: 1, readiness: 'ready', capabilities: [{ kind: 'linux-shell', readiness: 'ready' }] },
    { id: 'host-macos', kind: 'host-macos', protocolVersion: 1, readiness: 'ready', capabilities: [{ kind: 'macos-app-inspection', readiness: 'setup-required', reason: 'The Mac testing helper must be connected.' }] },
  ] };
  store.set('goals', goal); store.set('tasks', task);
  store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'plan', startedAt: at, steering: [] });
  const buckets = ['goals', 'tasks', 'attempts', 'factory-task-details', 'factory-attempt-details', 'factory-control', 'decisions'];
  const before = buckets.map(bucket => store.list(bucket));
  const queued = inspectTask(store, [device], task);
  assert.equal(queued.state, 'waiting', 'Planning cannot conceal an unsupported native prerequisite');
  assert.equal(queued.reason, 'The Mac testing helper must be connected.');
  assert.deepEqual(queued.executionBlocker, { kind: 'execution-capability', readiness: 'setup-required', capabilities: ['macos-app-inspection'],
    deviceIds: [device.id], targetIds: ['host-macos'], reason: queued.reason });
  assert.deepEqual(buckets.map(bucket => store.list(bucket)), before, 'Readiness is a read-only projection and cannot allocate an attempt');
  assert.equal(inspectTask(store, [{ ...device, executionTargets: undefined }], task).executionBlocker!.readiness, 'unsupported', 'The Mac platform does not imply native UI support');

  const attempt: Attempt = { id: 'fifth', taskId: task.id, generation: 5, deviceId: device.id, status: 'failed', startedAt: at, endedAt: at, error: 'Native evidence was unavailable' };
  const failed = { ...task, status: 'failed' as const, currentAttemptId: attempt.id };
  store.set('tasks', failed); store.set('attempts', attempt);
  store.set<AttemptDetail>('factory-attempt-details', { id: attempt.id, goalId: goal.id, goalRevision: 1, phase: 'checking', cancellation: 'none', result: { status: 'succeeded', text: 'Author turn completed' } });
  const failedView = inspectTask(store, [device], failed);
  assert.equal(failedView.state, 'waiting');
  assert.equal(failedView.executionBlocker!.readiness, 'setup-required');
  assert.deepEqual(store.get<Attempt>('attempts', attempt.id), attempt, 'Missing tools cannot retire or rewrite a failed author attempt');
  assert.equal(failedView.attempts[0]!.result!.status, 'succeeded', 'Provider completion remains distinct from failed acceptance');

  const readyDevice: Device = { ...device, executionTargets: device.executionTargets!.map(target => ({ ...target, capabilities: target.capabilities.map(capability => ({ ...capability, readiness: 'ready', reason: undefined })) })) };
  store.set('tasks', task); store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'dispatch', startedAt: at, steering: [] });
  const ready = inspectTask(store, [readyDevice], task);
  assert.equal(ready.executionBlocker, undefined); assert.equal(ready.state, 'ready');
  const unknown = { ...attempt, status: 'unknown' as const, endedAt: undefined };
  const running = { ...failed, status: 'running' as const };
  store.set('tasks', running); store.set('attempts', unknown);
  const unknownView = inspectTask(store, [device], running);
  assert.equal(unknownView.state, 'unknown'); assert.equal(unknownView.executionBlocker, undefined, 'Capability waits cannot replace unresolved execution authority');
});

test('goal execution defaults gate queued inspection and manual dispatch without replacing explicit task requirements', async t => {
  const { Store } = await import('./store.ts');
  const { inspectTask, taskDispatchBlocker } = await import('./task-inspection.ts');
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-goal-capability-inspection-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-10-08T00:00:00.000Z';
  const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: 'owner', title: 'Native app', objective: 'Deliver', criteria: ['Works'],
    status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 2, revision: 1, createdAt: at, updatedAt: at, execution: { target: 'host-macos' } };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Implement', description: 'Use the goal target', dependsOn: [], status: 'queued', createdAt: at, updatedAt: at };
  const device: Device = { id: 'owner', name: 'Mac', platform: 'darwin', arch: 'arm64', local: true, online: true, lastSeen: at, capacity: 2 };
  store.set('goals', goal); store.set('tasks', task);
  store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'plan', startedAt: at, steering: [] });
  assert.equal(inspectTask(store, [device], task).executionBlocker?.readiness, 'unsupported', 'A goal host default must not inherit legacy container readiness');
  assert.equal(inspectTask(store, [device], task).state, 'waiting', 'Controller planning does not hide missing goal capabilities');
  assert.equal(taskDispatchBlocker(store, [device], task, goal)?.kind, 'execution-capability');
  const explicit = { ...task, execution: { target: 'container' as const } };
  assert.equal(inspectTask(store, [device], explicit).executionBlocker, undefined, 'Explicit per-task placement owns its contract');
  assert.equal(taskDispatchBlocker(store, [device], explicit, goal), undefined);
  const ready: Device = { ...device, executionTargets: [{ id: 'mac-host', kind: 'host-macos', protocolVersion: 1, readiness: 'ready', capabilities: [{ kind: 'mac-shell', readiness: 'ready' }] }] };
  store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'dispatch', startedAt: at, steering: [] });
  assert.equal(inspectTask(store, [ready], task).state, 'ready');
  assert.equal(inspectTask(store, [ready], task).executionBlocker, undefined);
  assert.equal(taskDispatchBlocker(store, [ready], task, goal), undefined);
  assert.equal(store.get<FactoryTask>('tasks', task.id)!.execution, undefined, 'Projection cannot rewrite recorded task contracts');
});

test('verification evidence wait preserves candidate and check provenance while releasing author capacity but retaining frozen write ownership', async t => {
  const { Store } = await import('./store.ts');
  const { inspectTask, taskDispatchBlocker } = await import('./task-inspection.ts');
  const directory = mkdtempSync(path.join(tmpdir(), 'enoughfactory-verification-wait-inspection-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const at = '2026-10-08T00:00:00.000Z', waitingAt = '2026-10-08T00:15:00.000Z';
  const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: 'owner', title: 'Deliver', objective: 'Deliver', criteria: ['Works'],
    status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 1, revision: 1, createdAt: at, updatedAt: at, execution: { target: 'host-macos' } };
  const task: FactoryTask = { id: 'review', goalId: goal.id, title: 'Verify app', description: 'Use retained source', dependsOn: [], writePaths: ['new-scope/'], status: 'review', currentAttemptId: 'fifth', createdAt: at, updatedAt: at };
  const attempt: Attempt = { id: 'fifth', taskId: task.id, generation: 5, deviceId: 'owner', executionTargetId: 'mac-host', executionTargetKind: 'host-macos', status: 'succeeded', startedAt: at, endedAt: waitingAt, candidate: 'candidate-C' };
  const previous: Attempt = { ...attempt, id: 'fourth', generation: 4, status: 'failed', error: 'Previous candidate failed' };
  const wait: NonNullable<AttemptDetail['verificationWait']> = { condition: 'inspection-evidence', reason: 'The testing device is producing workflow results.', since: waitingAt };
  const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: 1, phase: 'checking', cancellation: 'none', verificationWait: wait,
    contract: { title: task.title, description: task.description, dependsOn: [], checks: ['enoughfactory:ui-quality'], planRevision: 1, writePaths: ['protected/'], execution: { target: 'host-macos' } },
    candidate: { id: 'candidate', commit: 'candidate-C', baseCommit: 'base' }, result: { status: 'succeeded', text: 'Author work saved' },
    checks: [{ command: 'enoughfactory:ui-quality', passed: false, output: 'Awaiting exact source evidence', candidateCommit: 'candidate-C', checkedCommit: 'checked-M', executionTargetKind: 'host-macos', hostPermissions: 'full-host', recovery: { condition: 'inspection-evidence', reason: wait.reason } }],
    checkInputs: { configurationRevision: 1, workingDirectoryIds: [], environment: { PRIVATE_INPUT: 'must-stay-private' } } };
  const independent: FactoryTask = { id: 'independent', goalId: goal.id, title: 'Independent work', description: '', dependsOn: [], writePaths: ['other/'], status: 'queued', createdAt: at, updatedAt: at };
  const conflicting = { ...independent, id: 'conflicting', title: 'Conflicting work', writePaths: ['protected/file.ts'] };
  const device: Device = { id: 'owner', name: 'Mac', platform: 'darwin', arch: 'arm64', online: true, local: true, lastSeen: at, executionTargets: [{ id: 'mac-host', kind: 'host-macos', protocolVersion: 1, readiness: 'ready', capacity: 1, capabilities: [{ kind: 'mac-shell', readiness: 'ready' }] }] };
  store.set('goals', goal); for (const item of [task, independent, conflicting]) store.set('tasks', item);
  for (const item of [attempt, previous]) store.set('attempts', item);
  store.set('factory-attempt-details', detail);
  store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'dispatch', startedAt: at, steering: [] });
  const buckets = ['goals', 'tasks', 'attempts', 'factory-attempt-details', 'factory-control'];
  const before = buckets.map(bucket => store.list(bucket));
  const view = inspectTask(store, [device], task);
  assert.equal(view.state, 'waiting'); assert.equal(view.reason, wait.reason);
  assert.deepEqual(view.attempts[0]!.verificationWait, wait);
  assert.equal(view.attempts[0]!.attempt.status, 'succeeded');
  assert.equal(view.attempts[0]!.candidate?.commit, 'candidate-C');
  assert.equal(view.attempts[0]!.checks?.[0]?.candidateCommit, 'candidate-C');
  assert.equal(view.attempts[0]!.checks?.[0]?.checkedCommit, 'checked-M');
  assert.equal(view.attempts[0]!.checks?.[0]?.executionTargetKind, 'host-macos');
  assert.equal(view.attempts[0]!.checks?.[0]?.hostPermissions, 'full-host');
  assert.deepEqual(view.attempts[0]!.checks?.[0]?.recovery, { condition: 'inspection-evidence', reason: wait.reason });
  assert.equal(view.attempts[1]!.attempt.status, 'failed', 'The earlier failed attempt remains truthful');
  assert.equal(JSON.stringify(view).includes('must-stay-private'), false);
  assert.equal(taskDispatchBlocker(store, [device], independent, goal), undefined, 'A waiting verifier does not consume the one author slot');
  assert.equal(taskDispatchBlocker(store, [device], conflicting, goal)?.kind, 'write-conflict', 'Frozen candidate ownership remains reserved');
  assert.deepEqual(buckets.map(bucket => store.list(bucket)), before, 'Inspection never resumes or rewrites saved work');
  store.set('attempts', { ...attempt, status: 'unknown' });
  assert.equal(inspectTask(store, [device], task).state, 'unknown', 'Unknown execution authority has precedence over a retained evidence wait');
});
