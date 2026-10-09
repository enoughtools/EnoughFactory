import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, ControllerRun, ExecutionTargetAdvertisement, FactoryTask, Goal, Project, Session } from '@enoughfactory/contracts';
import type { TurnInput, TurnResult } from '@enoughfactory/agents';
import type { AttemptDetail, CandidateRef, ControlRecord, ExecutionResult, TaskDetail } from '@enoughfactory/factory';
import { git } from '../../../packages/workspaces/src/process.ts';
import { DeviceApp } from './app.ts';
import { ChatController } from './chats.ts';
import { initializeFactory, type FactoryInspectionPorts } from './factory.ts';
import { Store } from './store.ts';

const nativeMac = { skip: process.platform !== 'darwin' };
const criterion = 'Native product behavior is implemented and verified';
const plan = JSON.stringify({ summary: 'Implement the native product', criteria: [criterion], checks: [], tasks: [{
  key: 'native-product', title: 'Implement native product', description: 'Implement the requested product behavior in the selected native workspace.',
  kind: 'feature', acceptanceCriteria: [criterion], expectedOutputs: ['Saved native source'], dependsOn: [], checks: [],
}] });

async function fixture(t: TestContext, inspection: FactoryInspectionPorts = {}, preInitialize?: (app: DeviceApp, project: Project) => void | Promise<void>) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'enough-goal-execution-')));
  const state = new Store(directory);
  state.set('private', { id: 'runtime-control', suspended: true }); state.close();
  const previousHome = process.env.ENOUGHFACTORY_HOME;
  let app: DeviceApp;
  try { process.env.ENOUGHFACTORY_HOME = directory; app = new DeviceApp(); }
  finally {
    if (previousHome === undefined) delete process.env.ENOUGHFACTORY_HOME;
    else process.env.ENOUGHFACTORY_HOME = previousHome;
  }
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const primary = path.join(directory, 'user-project'); await mkdir(primary);
  await git(primary, 'init', '--quiet');
  await git(primary, 'config', 'user.name', 'Fixture'); await git(primary, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(primary, 'source.txt'), 'actual project source\n');
  await git(primary, 'add', '.'); await git(primary, 'commit', '--quiet', '-m', 'baseline');
  const project: Project = { id: 'project', name: 'Native product', path: primary, deviceId: app.device.id, createdAt: new Date().toISOString(), runtime: 'codex', approvalMode: 'approve-all', rules: [], developmentToolchain: 'default' };
  app.store.set('projects', project);
  const host: ExecutionTargetAdvertisement = { id: `${app.device.id}:configured-native`, kind: 'host-macos', protocolVersion: 1,
    readiness: 'ready', capacity: 2, workspaceProviders: ['git'], runtimes: ['codex'], capabilities: [
      { kind: 'mac-shell', readiness: 'ready' }, { kind: 'apple-compilation', readiness: 'ready' },
    ] };
  const container: ExecutionTargetAdvertisement = { id: `${app.device.id}:private-container`, kind: 'container', protocolVersion: 1,
    readiness: 'ready', capacity: 2, workspaceProviders: ['git'], capabilities: [{ kind: 'linux-shell', readiness: 'ready' }] };
  app.setDevice({ ...app.device, executionTargets: [container, host] });
  let containerStarts = 0, hostProvisions = 0;
  t.mock.method(app, 'ensureRuntimeReady', async () => { containerStarts++; throw new Error('Fixture container admission selected'); });
  t.mock.method(app.runtime, 'prepareWorkspace', async () => assert.fail('Orchestration tests must not prepare a Docker workspace'));
  Object.defineProperty(app.sessions, 'engine', { value: new Proxy({}, { get(_target, key) {
    return () => assert.fail(`Native orchestration must not invoke envmux.${String(key)}`);
  } }) });
  const chats = new ChatController(app), turns: TurnInput[] = [];
  t.mock.method(chats.manager, 'provisionHost', async () => {
    hostProvisions++; return { kind: 'codex', available: true, fullAccess: true, interactiveApprovals: true, resume: true };
  });
  t.mock.method(chats.manager, 'hostProcesses', async () => []);
  t.mock.method(chats.manager, 'cancelHostSession', async () => {});
  t.mock.method(chats.manager, 'interrupt', async () => {});
  let respond: (input: TurnInput) => Promise<TurnResult> = async () => ({ threadId: 'fixture-planner-thread', text: plan });
  t.mock.method(chats.manager, 'runTurn', async (input: TurnInput) => {
    turns.push(input);
    assert.equal(input.executionTarget, 'host-macos');
    assert.equal(input.containerId, undefined);
    assert(input.cwd);
    assert(input.cwd.startsWith(path.join(directory, 'workspace-data', 'workspaces')));
    assert.equal(await readFile(path.join(input.cwd, 'source.txt'), 'utf8'), 'actual project source\n');
    return respond(input);
  });
  await preInitialize?.(app, project);
  const factory = await initializeFactory(app, chats, undefined, inspection); factory.coordinator.stop();
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  async function request(method: string, route: string, body: Record<string, unknown>) {
    return fetch(`${origin}${route}`, { method, headers: { authorization: `Bearer ${app.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function create(execution?: unknown, additions: Record<string, unknown> = {}): Promise<Goal> {
    const response = await request('POST', '/api/goals', { projectId: project.id, objective: 'Build a complete native product', criteria: [criterion], autonomy: 'manual', ...(execution === undefined ? {} : { execution }), ...additions });
    assert.equal(response.status, 200, await response.clone().text()); return await response.json() as Goal;
  }
  const complete = (goal: Goal, signal?: AbortSignal) => factory.runtime.complete({ goal, project, role: 'planner', prompt: 'Return the requested plan JSON for this exact goal.', signal });
  const containerReady = () => {
    app.allowRuntimeStart();
    app.diagnostics.containerRuntime = { kind: 'lima', state: 'ready', socketPath: '/fixture.sock', dataDirectory: path.join(directory, 'runtime-data'), stateDirectory: path.join(directory, 'runtime-state'), artifactFsSupported: false, cpus: 4, memoryGiB: 8 };
    app.setDevice({ ...app.device, executionTargets: [container, host] });
  };
  return { app, chats, factory, project, primary, directory, host, container, turns, create, request, complete, containerReady,
    counts: () => ({ containerStarts, hostProvisions }), respond: (handler: typeof respond) => { respond = handler; } };
}

test('an explicitly native goal plans from zero tasks with the private container runtime paused', nativeMac, async t => {
  const f = await fixture(t), execution = { target: 'host-macos', requiredCapabilities: ['mac-shell', 'apple-compilation'] };
  const goal = await f.create(execution);
  assert.equal(f.app.store.list<FactoryTask>('tasks').length, 0);
  assert.throws(() => f.app.assertRuntimeCanRun(), /Start EnoughFactory/);
  f.factory.coordinator.requestPlan(goal.id);
  await f.factory.coordinator.start(); await f.factory.coordinator.waitForIdle(); f.factory.coordinator.stop();
  const planned = f.app.store.get<Goal>('goals', goal.id)!;
  assert.equal(planned.status, 'running', planned.error);
  assert.deepEqual(planned.execution, execution);
  const tasks = f.app.store.list<FactoryTask>('tasks').filter(task => task.goalId === goal.id);
  assert.equal(tasks.length, 1); assert.equal(tasks[0]!.title, 'Implement native product');
  assert.equal(f.turns.length, 1);
  assert.match(f.turns[0]!.systemInstructions!, /full same-user host access in a private Git snapshot/);
  assert.match(f.turns[0]!.systemInstructions!, /not a container sandbox/);
  assert.doesNotMatch(f.turns[0]!.systemInstructions!, /Authoring agents and ordinary shell checks run in Linux containers/);
  assert.doesNotMatch(f.turns[0]!.systemInstructions!, /\/workspaces\/factory-context/);
  assert.equal(f.counts().containerStarts, 0); assert(f.counts().hostProvisions > 0);
  const session = f.app.store.get<Session>('sessions', f.turns[0]!.sessionId)!;
  assert.equal(session.executionTargetId, f.host.id); assert.equal(session.executionTargetKind, 'host-macos');
  assert.equal(session.containerId, undefined); assert.equal(session.status, 'stopped');
  assert.equal(await readFile(path.join(f.primary, 'source.txt'), 'utf8'), 'actual project source\n');
});

function coldStartGoal(app: DeviceApp, project: Project): Goal {
  const at = new Date().toISOString();
  const goal: Goal = { id: randomUUID(), projectId: project.id, coordinatorId: app.device.id, title: 'Cold-start native product', objective: 'Build the requested native product', criteria: [criterion],
    status: 'draft', autonomy: 'manual', approvalMode: 'approve-all', runtime: 'codex', concurrency: 1, revision: 1, createdAt: at, updatedAt: at, execution: { target: 'host-macos' } };
  app.store.set('goals', goal);
  app.store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'plan', startedAt: at, steering: [] });
  return goal;
}

test('cold-start orphan controller preparation releases its reservation before normal single-agent planning', { ...nativeMac, timeout: 60000 }, async t => {
  let goal!: Goal;
  const operation = randomUUID();
  const f = await fixture(t, {}, (app, project) => {
    goal = coldStartGoal(app, project);
    app.store.set('factory-controller-inputs', { id: operation, goalId: goal.id, role: 'planner', status: 'preparing', updatedAt: goal.updatedAt });
  });
  assert.equal(f.app.store.get<{ status: string }>('factory-controller-inputs', operation)!.status, 'released');
  assert.equal(f.app.store.get('factory-controller-cleanup', operation), undefined);
  assert.equal(f.app.store.list('sessions').length, 0); assert.equal(f.app.store.list('factory-controller-runs').length, 0);
  assert.equal(f.turns.length, 0); assert.deepEqual(f.counts(), { containerStarts: 0, hostProvisions: 0 });
  f.factory.coordinator.requestPlan(goal.id);
  await f.factory.coordinator.start(); await f.factory.coordinator.waitForIdle(); f.factory.coordinator.stop();
  assert.equal(f.app.store.get<Goal>('goals', goal.id)!.status, 'running'); assert.equal(f.turns.length, 1);
  assert.equal(f.app.store.list<FactoryTask>('tasks').filter(task => task.goalId === goal.id).length, 1);
  assert.equal(f.app.store.get<ControlRecord>('factory-control', goal.id)!.waitingFor, undefined);
  assert.equal(f.app.store.get<ControlRecord>('factory-control', goal.id)!.controllerFailures, undefined); assert.equal(f.counts().containerStarts, 0);
});

test('cold-start controller ownership ambiguity retains its reservation and admits no replacement provider', { ...nativeMac, timeout: 60000 }, async t => {
  let goal!: Goal;
  const operation = randomUUID(), saved: Session[] = [];
  const f = await fixture(t, {}, (app, project) => {
    goal = coldStartGoal(app, project);
    app.store.set('factory-controller-inputs', { id: operation, goalId: goal.id, role: 'planner', status: 'prepared', updatedAt: goal.updatedAt });
    for (const id of ['orphan-original-session', 'orphan-ambiguous-session']) {
      const session: Session = { id, projectId: `workspace-${operation}`, deviceId: app.device.id, name: 'retained-controller', status: 'unknown', createdAt: goal.createdAt, updatedAt: goal.updatedAt, services: [] };
      saved.push(session); app.store.set('sessions', session);
    }
  });
  assert.equal(f.app.store.get<{ status: string }>('factory-controller-inputs', operation)!.status, 'prepared');
  assert.match(f.app.store.get<{ error: string }>('factory-controller-cleanup', operation)!.error, /ownership is ambiguous/);
  await assert.rejects(f.complete(goal), (error: unknown) => { assert.equal((error as { recovery?: string }).recovery, 'inspection-evidence'); return true; });
  assert.deepEqual(f.app.store.list('sessions'), saved); assert.equal(f.app.store.list('factory-controller-runs').length, 0);
  assert.equal(f.turns.length, 0); assert.deepEqual(f.counts(), { containerStarts: 0, hostProvisions: 0 });
});

test('goal creation persists explicit application acceptance and rejects unavailable references as client input', nativeMac, async t => {
  const f = await fixture(t);
  const acceptance = { kind: 'application', platforms: ['macos', 'ios-simulator'], referenceIds: ['primary'] };
  const goal = await f.create({ target: 'auto' }, { acceptance });
  assert.deepEqual(goal.acceptance, acceptance);
  assert.deepEqual(f.app.store.get<Goal>('goals', goal.id)!.acceptance, acceptance);
  for (const invalid of [{ ...acceptance, platforms: [] }, { ...acceptance, referenceIds: ['removed-design-folder'] }]) {
    const response = await f.request('POST', '/api/goals', { projectId: f.project.id, objective: 'Build the native app', autonomy: 'manual', acceptance: invalid });
    assert.equal(response.status, 400, await response.clone().text());
  }
  assert.equal(f.app.store.list<Goal>('goals').length, 1, 'Rejected templates cannot leave a partially created goal');
  const legacy = await f.create();
  assert.equal(legacy.acceptance, undefined, 'API callers that omit the template preserve existing behavior');
  assert.equal(f.turns.length, 0); assert.equal(f.counts().containerStarts, 0);
});

test('explicit native preference remains native with a ready container, while auto chooses the ready container', nativeMac, async t => {
  const f = await fixture(t); f.containerReady();
  const nativeGoal = await f.create({ target: 'host-macos' });
  await f.complete(nativeGoal);
  assert.equal(f.turns.length, 1); assert.equal(f.counts().containerStarts, 0);
  const automatic = await f.create({ target: 'auto' });
  await assert.rejects(f.complete(automatic), /Fixture container admission selected/);
  assert.equal(f.counts().containerStarts, 1); assert.equal(f.turns.length, 1);
});

test('explicit auto can use the configured host when Docker is paused, while legacy goals stay container based', nativeMac, async t => {
  const f = await fixture(t);
  const automatic = await f.create({ target: 'auto' }); await f.complete(automatic);
  assert.equal(f.turns.length, 1); assert.equal(f.counts().containerStarts, 0);
  const legacy = await f.create();
  await assert.rejects(f.complete(legacy), /Start EnoughFactory/);
  assert.equal(f.turns.length, 1, 'Darwin alone cannot authorize native execution');
  assert.equal(f.counts().containerStarts, 0);
  const now = new Date().toISOString();
  f.app.store.set<FactoryTask>('tasks', { id: 'explicit-host-task', goalId: legacy.id, title: 'Native prerequisite', description: 'Native authoring is explicitly required', dependsOn: [], status: 'ready', createdAt: now, updatedAt: now, execution: { target: 'host-macos' } });
  await f.complete(legacy);
  assert.equal(f.turns.length, 2, 'Existing explicit native task contracts retain the documented controller fallback');
});

test('missing native requirements and unsupported providers wait for a matching target without silent fallback', nativeMac, async t => {
  const f = await fixture(t);
  for (const [execution, additions] of [
    [{ target: 'host-macos', requiredCapabilities: ['ios-simulator-inspection'] }, {}],
    [{ target: 'host-macos' }, { runtime: 'claude' }],
  ] as const) {
    const goal = await f.create(execution, additions);
    await assert.rejects(f.complete(goal), (error: unknown) => {
      assert.equal((error as { recovery: string }).recovery, 'execution-capability'); return true;
    });
  }
  assert.deepEqual(f.counts(), { containerStarts: 0, hostProvisions: 0 }); assert.equal(f.turns.length, 0);
});

test('goal execution APIs reject malformed preferences atomically on create, configure and steer', async t => {
  const f = await fixture(t), goal = await f.create({ target: 'host-macos' });
  for (const execution of [null, [], 'native', { target: 'mac' }, { target: 'host-macos', extra: true }, { requiredCapabilities: ['unsupported'] }, { requiredCapabilities: ['mac-shell', 'mac-shell'] }]) {
    const count = f.app.store.list<Goal>('goals').length;
    const create = await f.request('POST', '/api/goals', { projectId: f.project.id, objective: 'Invalid native preference', execution });
    assert.equal(create.status, 400, JSON.stringify(execution));
    assert.equal(f.app.store.list<Goal>('goals').length, count);
    for (const [method, route] of [['PATCH', `/api/goals/${goal.id}`], ['POST', `/api/goals/${goal.id}/steer`]]) {
      const before = f.app.store.get<Goal>('goals', goal.id);
      const response = await f.request(method!, route!, { execution, ...(method === 'PATCH' ? { workspaceProvider: 'artifactfs' } : {}) });
      assert.equal(response.status, 400, `${method}: ${JSON.stringify(execution)}`);
      assert.deepEqual(f.app.store.get('goals', goal.id), before, 'Invalid execution settings cannot mutate authority or preferences');
    }
  }
  assert.equal(f.turns.length, 0); assert.deepEqual(f.counts(), { containerStarts: 0, hostProvisions: 0 });
});

test('configure preserves omitted execution and frozen attempts while steer revokes outstanding authority', async t => {
  const f = await fixture(t), goal = await f.create({ target: 'host-macos', requiredCapabilities: ['mac-shell'] });
  const now = new Date().toISOString();
  const task: FactoryTask = { id: 'active-task', goalId: goal.id, title: 'Native authoring', description: 'Keep the exact allocated author target', dependsOn: [], status: 'running', currentAttemptId: 'active-attempt', createdAt: now, updatedAt: now, execution: { target: 'host-macos' } };
  const attempt: Attempt = { id: 'active-attempt', taskId: task.id, generation: 1, deviceId: f.app.device.id, status: 'running', startedAt: now, executionTargetKind: 'host-macos', executionTargetId: f.host.id };
  const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, cancellation: 'none', phase: 'executing' };
  f.app.store.set('tasks', task); f.app.store.set('attempts', attempt); f.app.store.set('factory-attempt-details', detail);
  const preserving = await f.request('PATCH', `/api/goals/${goal.id}`, { concurrency: 3 });
  assert.equal(preserving.status, 200); assert.deepEqual((await preserving.json() as Goal).execution, goal.execution);
  const changed = await f.request('PATCH', `/api/goals/${goal.id}`, { execution: { target: 'container' } });
  assert.equal(changed.status, 200); assert.deepEqual((await changed.json() as Goal).execution, { target: 'container' });
  assert.deepEqual(f.app.store.get('attempts', attempt.id), attempt, 'Reconfiguration does not rebind an already allocated attempt');
  const canceled: Attempt[] = []; t.mock.method(f.factory.runtime, 'cancel', async (value: Attempt) => { canceled.push(value); });
  const steering = await f.request('POST', `/api/goals/${goal.id}/steer`, { context: 'Continue native development with the required tooling', execution: { target: 'auto', requiredCapabilities: ['mac-shell'] } });
  assert.equal(steering.status, 200);
  const revised = f.app.store.get<Goal>('goals', goal.id)!;
  assert.equal(revised.revision, goal.revision + 1); assert.deepEqual(revised.execution, { target: 'auto', requiredCapabilities: ['mac-shell'] });
  assert.equal(f.app.store.get<FactoryTask>('tasks', task.id)!.status, 'canceled');
  assert.equal(f.app.store.get<Attempt>('attempts', attempt.id)!.status, 'retired');
  assert.equal(f.app.store.get<Attempt>('attempts', attempt.id)!.executionTargetId, f.host.id);
  assert.equal(f.app.store.get<AttemptDetail>('factory-attempt-details', attempt.id)!.cancellation, 'acknowledged');
  assert.deepEqual(canceled, [attempt]);
  const before = revised.execution;
  const preserved = await f.request('POST', `/api/goals/${goal.id}/steer`, { context: 'Keep the selected execution preference' });
  assert.equal(preserved.status, 200); assert.deepEqual(f.app.store.get<Goal>('goals', goal.id)!.execution, before);
  assert.equal(f.app.store.get<ControlRecord>('factory-control', goal.id)!.stage, 'plan');
});

test('a source audit holding the only goal agent slot delays normal planning without spending the failure budget', { ...nativeMac, timeout: 60000 }, async t => {
  const f = await fixture(t), goal = await f.create({ target: 'host-macos' }, { concurrency: 1 });
  const audit = { id: 'preparing-native-source-audit', authority: { goalId: goal.id, goalRevision: goal.revision, taskId: 'native-task', attemptId: 'native-author', authorityGeneration: 1, policyRevision: goal.revision }, status: 'preparing' };
  f.app.store.set('inspection-profile-audits', audit);
  await assert.rejects(f.complete(goal), (error: unknown) => {
    assert.equal((error as { recovery?: string }).recovery, 'inspection-evidence'); return true;
  });
  assert.equal(f.turns.length, 0); assert.equal(f.app.store.list('sessions').length, 0); assert.equal(f.app.store.list('factory-controller-runs').length, 0);
  assert.deepEqual(f.counts(), { containerStarts: 0, hostProvisions: 0 });

  f.factory.coordinator.requestPlan(goal.id);
  const requested = f.app.store.get<Goal>('goals', goal.id)!;
  const before = f.app.store.get<ControlRecord>('factory-control', goal.id)!;
  await f.factory.coordinator.start(); await f.factory.coordinator.waitForIdle(); f.factory.coordinator.stop();
  const waiting = f.app.store.get<ControlRecord>('factory-control', goal.id)!;
  assert.equal(f.app.store.get<Goal>('goals', goal.id)!.status, 'waiting'); assert.equal(f.app.store.get<Goal>('goals', goal.id)!.revision, requested.revision); assert.equal(waiting.waitingFor, 'inspection-evidence');
  assert.equal(waiting.stage, 'plan'); assert.equal(waiting.manualAction, 'plan'); assert.deepEqual(waiting.controllerFailures, before.controllerFailures);
  assert.equal(f.turns.length, 0); assert.equal(f.app.store.list('sessions').length, 0); assert.equal(f.app.store.list('factory-controller-runs').length, 0);

  f.app.store.delete('inspection-profile-audits', audit.id);
  f.app.emit('inspection-evidence', { goalId: goal.id, auditId: audit.id, purpose: 'source-audit-released' });
  await f.factory.coordinator.start(); await f.factory.coordinator.waitForIdle(); f.factory.coordinator.stop();
  const planned = f.app.store.get<Goal>('goals', goal.id)!, control = f.app.store.get<ControlRecord>('factory-control', goal.id)!;
  assert.equal(planned.status, 'running', planned.error); assert.equal(planned.id, goal.id); assert.equal(planned.revision, requested.revision, 'The capacity wait resumes the same requested plan authority.');
  assert.equal(control.waitingFor, undefined); assert.equal(control.controllerFailures, undefined); assert.equal(f.turns.length, 1);
  assert.equal(f.app.store.list<FactoryTask>('tasks').filter(task => task.goalId === goal.id).length, 1);
  assert.equal(f.app.store.list<ControllerRun>('factory-controller-runs').filter(run => run.goalId === goal.id).length, 1);
  assert.equal(f.counts().containerStarts, 0); assert.equal(await readFile(path.join(f.primary, 'source.txt'), 'utf8'), 'actual project source\n');
});

test('a source audit capacity wait preserves the original retained evaluator conversation', { ...nativeMac, timeout: 60000 }, async t => {
  let reviewReady = false;
  const f = await fixture(t, { reviewController: async () => ({ ready: reviewReady, reason: 'The current native source still needs inspection evidence.', evidenceIds: [] }) });
  const goal = await f.create({ target: 'host-macos' }, { concurrency: 1 });
  const at = new Date().toISOString();
  f.app.store.set<FactoryTask>('tasks', { id: 'native-ui', goalId: goal.id, title: 'Native UI', description: 'Inspect the delivered native workflow', dependsOn: [], status: 'completed', createdAt: at, updatedAt: at,
    quality: { platforms: ['macos'], workflows: [{ id: 'native-composer', platform: 'macos' }], referenceIds: ['primary'] } });
  const decision = JSON.stringify({ complete: true, summary: 'Recorded evaluator decision awaiting original inspection', criteria: [{ criterion, satisfied: true, evidence: ['Recorded source'] }] });
  f.respond(async input => ({ threadId: input.threadId ?? `retained-evaluator-${input.chatId}`, text: decision }));
  const evaluate = () => f.factory.runtime.complete({ goal: f.app.store.get<Goal>('goals', goal.id)!, project: f.project, role: 'evaluator', prompt: 'Evaluate the current integrated product.' });
  const isInspectionWait = (error: unknown) => { assert.equal((error as { recovery?: string }).recovery, 'inspection-evidence'); return true; };
  await assert.rejects(evaluate(), isInspectionWait);
  const original = f.app.store.list<ControllerRun>('factory-controller-runs').find(run => run.goalId === goal.id)!;
  assert.equal(original.status, 'waiting'); assert(original.chatId && original.sessionId); assert.equal(f.turns.length, 2);
  const retained = f.app.store.get('factory-controller-reviews', original.id); assert(retained);
  const audit = { id: 'final-native-source-audit', authority: { goalId: goal.id, goalRevision: goal.revision, taskId: 'native-ui', attemptId: 'native-author', authorityGeneration: 1, policyRevision: goal.revision }, status: 'preparing' };
  f.app.store.set('inspection-profile-audits', audit);
  await assert.rejects(evaluate(), isInspectionWait);
  assert.equal(f.turns.length, 2); assert.equal(f.app.store.list('sessions').length, 1); assert.equal(f.app.store.list('factory-controller-runs').length, 1);
  assert.deepEqual(f.app.store.get('factory-controller-reviews', original.id), retained); assert.equal(f.app.store.get<ControllerRun>('factory-controller-runs', original.id)!.status, 'waiting');

  f.app.store.delete('inspection-profile-audits', audit.id); reviewReady = true;
  f.app.emit('inspection-evidence', { goalId: goal.id, auditId: audit.id, purpose: 'source-audit-released' });
  const result = await evaluate();
  assert.deepEqual(result, { text: decision, chatId: original.chatId }); assert.equal(f.turns.length, 2, 'A finished evaluator decision cannot be rerun to bypass the occupied slot.');
  assert.equal(f.app.store.list<ControllerRun>('factory-controller-runs').length, 1); assert.equal(f.app.store.get<ControllerRun>('factory-controller-runs', original.id)!.status, 'completed');
  assert.equal(f.app.store.get('factory-controller-reviews', original.id), undefined); assert.equal(f.counts().containerStarts, 0);
});

/** HTTP recovery exercises the real coordinator; proof/check effects are typed owning-port fixtures. */
async function savedVerificationFixture(t: TestContext) {
  const f = await fixture(t), requested = await f.create({ target: 'host-macos' });
  const at = new Date().toISOString(), candidate: CandidateRef = { id: 'retained-candidate', commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40) };
  const goal: Goal = { ...requested, status: 'paused' };
  const task: FactoryTask = { id: 'saved-task', goalId: goal.id, title: 'Saved native implementation', description: 'Original frozen task', kind: 'feature', status: 'failed', dependsOn: [], currentAttemptId: 'saved-author', createdAt: at, updatedAt: at };
  const attempt: Attempt = { id: 'saved-author', taskId: task.id, generation: 3, status: 'failed', deviceId: f.app.device.id, startedAt: at, endedAt: at, candidate: candidate.commit, chatId: 'saved-chat', sessionId: 'saved-session', executionTargetKind: 'host-macos', error: 'Original canceled verification' };
  const result: ExecutionResult = { status: 'succeeded', text: 'Original completed author', chatId: attempt.chatId, sessionId: attempt.sessionId };
  const commands = ['frozen-first', 'frozen-second'];
  const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, assignmentGoalRevision: goal.revision, phase: 'checking', cancellation: 'none', workspace: { id: attempt.id, provider: 'git', path: f.primary, baseCommit: candidate.baseCommit }, candidate, result,
    contract: { title: task.title, description: task.description, dependsOn: [], checks: commands, planRevision: goal.revision },
    checks: [{ command: commands[0]!, passed: false, output: 'Canceled original check', exitCode: 130, candidateCommit: candidate.commit, checkedCommit: candidate.commit }] };
  f.app.store.set('goals', goal); f.app.store.set('tasks', task); f.app.store.set('attempts', attempt); f.app.store.set('factory-attempt-details', detail);
  f.app.store.set<TaskDetail>('factory-task-details', { id: task.id, key: 'saved', checks: ['changed-current-task-check'], planRevision: goal.revision, selected: false, failureSignatures: ['original-failure'], lastCandidate: candidate, lastError: attempt.error });
  f.app.store.set<ControlRecord>('factory-control', { id: goal.id, stage: 'diagnose', diagnosisTaskId: task.id, startedAt: at, steering: [] });
  let settled = true, proofs = 0, checks = 0;
  const observedCommands: string[][] = [];
  t.mock.method(f.factory.runtime, 'reconcile', async () => ({ status: 'succeeded', result }));
  f.factory.workspacePort.confirmCheckRecovery = async () => { proofs++; return settled ? { status: 'settled', automatic: true, evidenceIds: ['original-owned-report'] } : { status: 'unknown', reason: 'Original verifier still owns an unsettled process.' }; };
  f.factory.workspacePort.check = async (_project, current, selected) => { checks++; observedCommands.push([...selected]); return selected.map(command => ({ command, passed: false, output: 'Rechecked outcome remains a real failure', exitCode: 1, candidateCommit: current.commit, checkedCommit: current.commit })); };
  t.mock.method(f.factory.workspacePort, 'prepare', async () => assert.fail('Saved verification must not allocate another author'));
  t.mock.method(f.factory.workspacePort, 'capture', async () => assert.fail('Saved verification must not recapture its candidate'));
  t.mock.method(f.factory.workspacePort, 'integrate', async () => assert.fail('A rechecked failure cannot integrate'));
  const pinned = { expectedGoalRevision: goal.revision, expectedAttemptId: attempt.id, expectedCandidateId: candidate.id, expectedCandidateCommit: candidate.commit };
  await f.factory.coordinator.start();
  return { ...f, goal, task, attempt, detail, pinned, observedCommands, settle: (value: boolean) => { settled = value; }, counts: () => ({ proofs, checks }) };
}

test('pinned HTTP verification recovery resumes paused saved work and preserves the original failed report', nativeMac, async t => {
  const f = await savedVerificationFixture(t);
  const response = await fetch(`http://127.0.0.1:${(f.app.server.address() as AddressInfo).port}/api/tasks/${f.task.id}`, { headers: { authorization: `Bearer ${f.app.token}` } });
  assert.equal(response.status, 200);
  const view = await response.json() as { verificationRecovery: { eligible: boolean; attemptId: string; candidateCommit: string } };
  assert.equal(view.verificationRecovery.eligible, true); assert.equal(view.verificationRecovery.attemptId, f.attempt.id); assert.equal(view.verificationRecovery.candidateCommit, f.pinned.expectedCandidateCommit);
  const retried = await f.request('POST', `/api/tasks/${f.task.id}/recheck`, f.pinned);
  assert.equal(retried.status, 200, await retried.clone().text()); await f.factory.coordinator.waitForIdle();
  assert.deepEqual(f.observedCommands, [f.detail.contract!.checks]); assert.equal(f.turns.length, 0);
  assert.equal(f.app.store.get<Goal>('goals', f.goal.id)!.status, 'running');
  assert.equal(f.app.store.list<Attempt>('attempts').length, 1);
  assert.equal(f.app.store.get<Attempt>('attempts', f.attempt.id)!.generation, 3); assert.equal(f.app.store.get<Attempt>('attempts', f.attempt.id)!.status, 'failed');
  const retained = f.app.store.get<AttemptDetail>('factory-attempt-details', f.attempt.id)!;
  assert.deepEqual(retained.candidate, f.detail.candidate); assert.deepEqual(retained.result, f.detail.result); assert.deepEqual(retained.contract, f.detail.contract);
  assert.deepEqual(retained.checkRecoveryHistory![0]!.checks, f.detail.checks); assert.equal(retained.checkRecoveryHistory![0]!.error, f.attempt.error);
  assert.deepEqual(f.app.store.get<TaskDetail>('factory-task-details', f.task.id)!.failureSignatures[0], 'original-failure');
});

test('HTTP saved verification rejects stale identities, supplied replacements and unknown effects without changing the author', nativeMac, async t => {
  const f = await savedVerificationFixture(t);
  const variants: Array<[Record<string, unknown>, number]> = [
    [{ ...f.pinned, expectedGoalRevision: f.goal.revision + 1 }, 409], [{ ...f.pinned, expectedAttemptId: 'another-author' }, 409],
    [{ ...f.pinned, expectedCandidateId: 'another-candidate' }, 409], [{ ...f.pinned, expectedCandidateCommit: 'd'.repeat(40) }, 409],
    [{ ...f.pinned, commands: ['replace-frozen-checks'] }, 400], [{ expectedGoalRevision: f.goal.revision }, 400],
  ];
  for (const [body, status] of variants) {
    const response = await f.request('POST', `/api/tasks/${f.task.id}/recheck`, body); assert.equal(response.status, status, await response.clone().text());
  }
  f.settle(false);
  const rejected = await f.request('POST', `/api/tasks/${f.task.id}/recheck`, f.pinned); assert.equal(rejected.status, 409); assert.match(await rejected.text(), /unsettled process/);
  assert.equal(f.counts().checks, 0); assert.deepEqual(f.app.store.get('attempts', f.attempt.id), f.attempt); assert.deepEqual(f.app.store.get('factory-attempt-details', f.attempt.id), f.detail);
  assert.equal(f.app.store.get<Goal>('goals', f.goal.id)!.status, 'paused'); assert.equal(f.turns.length, 0);
});
