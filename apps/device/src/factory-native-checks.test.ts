import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, FactoryTask, Goal, Project, TaskQualityRequirements } from '@enoughfactory/contracts';
import { FactoryOperationError, FactoryVerificationWaitError, UI_QUALITY_CHECK_COMMAND, type AttemptDetail, type CheckResult, type ControlRecord, type FactoryVerificationContext, type TaskDetail } from '@enoughfactory/factory';
import type { CheckReport, WorkingDirectoryCapture } from '@enoughfactory/workspaces';
import { DeviceApp } from './app.ts';
import { ChatController } from './chats.ts';
import { initializeFactory, type FactoryInspectionPorts } from './factory.ts';
import { HostDiskAdmission } from './host-disk-admission.ts';
import { exec } from './util.ts';

type QualityInput = Parameters<NonNullable<FactoryInspectionPorts['qualityCheck']>>[0];
const git = async (repository: string, ...args: string[]) => (await exec('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args])).stdout.trim();
const immutable = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const entry of Object.values(value)) immutable(entry); Object.freeze(value); }
  return value;
};

async function harness(t: TestContext) {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), 'enoughfactory-native-checks-')));
  const previous = process.env.ENOUGHFACTORY_HOME;
  let app: DeviceApp;
  try { process.env.ENOUGHFACTORY_HOME = directory; app = new DeviceApp(); }
  finally { if (previous === undefined) delete process.env.ENOUGHFACTORY_HOME; else process.env.ENOUGHFACTORY_HOME = previous; }
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const unavailable = async () => { throw new Error('The private container runtime is deliberately unavailable in this test.'); };
  const runtimeAdmission = t.mock.method(app, 'withRuntimeOperation', unavailable);
  const runtimeReadiness = t.mock.method(app, 'ensureRuntimeReady', unavailable);
  const runtimeStart = t.mock.method(app.runtime, 'ensureReady', unavailable);
  const runtimeWorkspace = t.mock.method(app.runtime, 'prepareWorkspace', unavailable);
  // Disk admission has dedicated capacity tests. These tiny Git fixtures must
  // exercise native verification independently of the developer Mac's headroom.
  t.mock.method(HostDiskAdmission.prototype, 'reserve', () => () => {});
  t.mock.method(HostDiskAdmission.prototype, 'assert', () => {});
  t.mock.method(HostDiskAdmission.prototype, 'blocker', () => undefined);
  const chats = new ChatController(app);
  const providerTurns = t.mock.method(chats.manager, 'runTurn', async () => assert.fail('Check verification must not start an author or controller turn.'));
  const observations: QualityInput[] = [];
  let respond: NonNullable<FactoryInspectionPorts['qualityCheck']> = async input => ({ command: UI_QUALITY_CHECK_COMMAND, passed: true, output: 'Authenticated current-source UI evidence.', exitCode: 0, candidateCommit: input.candidate.commit, checkedCommit: input.checkedCommit });
  const factory = await initializeFactory(app, chats, undefined, { qualityCheck: async input => { observations.push(input); return respond(input); } });
  factory.coordinator.stop();
  const runtimeBaseline = runtimeAdmission.mock.callCount();
  const repository = path.join(directory, 'repository');
  await mkdir(repository);
  await git(repository, 'init', '-q', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Native Check Fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repository, 'implementation.txt'), 'primary base\n');
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'Primary base');
  const base = await git(repository, 'rev-parse', 'HEAD');
  const timestamp = '2026-10-08T22:00:00.000Z';
  const referencePath = path.join(directory, 'design-reference'); await mkdir(referencePath);
  await writeFile(path.join(referencePath, 'tokens.txt'), 'actual captured design reference\n');
  const project: Project = { id: 'project', name: 'Native fixture', path: repository, deviceId: app.device.id, runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: timestamp, workingDirectories: [{ id: 'design-reference', name: 'design-reference', path: referencePath }] };
  const goal: Goal = { id: 'goal', projectId: project.id, coordinatorId: app.device.id, title: 'Deliver native app', objective: 'Deliver the native app and verified UI workflows', criteria: ['Native UI behaves correctly'], status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 2, revision: 3, createdAt: timestamp, updatedAt: timestamp };
  const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'open-and-read', platform: 'macos' }], referenceIds: ['design-reference'] };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Frozen native work', description: 'Implement and inspect the assigned native reading workflow', acceptanceCriteria: ['Reading works'], expectedOutputs: ['Verified native source'], dependsOn: [], status: 'review', currentAttemptId: 'attempt', deviceId: app.device.id, quality, execution: { target: 'host-macos', requiredCapabilities: ['mac-shell'] }, createdAt: timestamp, updatedAt: timestamp };
  const attempt: Attempt = { id: 'attempt', taskId: task.id, generation: 5, deviceId: app.device.id, status: 'running', executionTargetKind: 'host-macos', executionTargetId: 'mac-host', startedAt: timestamp };
  const verification: FactoryVerificationContext = immutable(structuredClone({ goal, task, attempt, quality }));
  app.store.transaction(() => { app.store.set('projects', project); app.store.set('goals', goal); app.store.set('tasks', { ...task, title: 'Later mutable display title', quality: { ...quality, workflows: [] } }); app.store.set('attempts', attempt); });
  const workspace = await factory.workspaces.create({ projectPath: repository, goalId: goal.id, taskId: task.id, attemptId: attempt.id, executionTargetKind: 'host-macos' });
  await writeFile(path.join(workspace.path, 'implementation.txt'), 'candidate implementation\n');
  await git(workspace.path, 'add', '.'); await git(workspace.path, 'commit', '-qm', 'Native candidate');
  const snapshots = await app.sessions.directoryManager.prepare({ identity: 'reference-input', sources: project.workingDirectories! });
  const captures: WorkingDirectoryCapture[] = [];
  for (const snapshot of snapshots) captures.push(await app.sessions.directoryManager.captureFromPath(snapshot, snapshot.path));
  const candidate = { ...await factory.workspaces.capture({ workspaceId: workspace.id, workingDirectories: captures }) };
  const reports = async (): Promise<CheckReport[]> => {
    const root = path.join(app.dataDir, 'workspace-data', 'reports');
    const files = await readdir(root).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
    return Promise.all(files.map(async filename => JSON.parse(await readFile(path.join(root, filename), 'utf8')) as CheckReport));
  };
  const assertNoDocker = () => {
    assert.equal(runtimeAdmission.mock.callCount(), runtimeBaseline, 'verification does not enter container admission');
    assert.equal(runtimeReadiness.mock.callCount(), 0); assert.equal(runtimeStart.mock.callCount(), 0); assert.equal(runtimeWorkspace.mock.callCount(), 0);
  };
  return { app, factory, project, goal, task, attempt, verification, workspace, candidate, captures, base, observations, reports, assertNoDocker, providerTurns, respond: (handler: NonNullable<FactoryInspectionPorts['qualityCheck']>) => { respond = handler; } };
}

test('native capability recovery wakes retained inspection evidence and existing execution-capability waits', async t => {
  const f = await harness(t), since = f.goal.updatedAt;
  const author: Attempt = { ...f.attempt, status: 'succeeded', endedAt: since, chatId: 'retained-author-chat', sessionId: 'retained-author-session' };
  const detail: AttemptDetail = {
    id: author.id, goalId: f.goal.id, goalRevision: f.goal.revision, workspace: { ...f.workspace },
    candidate: f.candidate, result: { status: 'succeeded', text: 'Native source authored and retained.', chatId: author.chatId, sessionId: author.sessionId },
    cancellation: 'none', phase: 'checking', verificationWait: {
      condition: 'inspection-evidence', reason: 'Unlock the owning Mac before native workflow inspection can continue.', since,
    },
  };
  const capabilityGoal: Goal = { ...f.goal, id: 'capability-goal', status: 'waiting', error: 'The configured Mac capability is unavailable.' };
  f.app.store.transaction(() => {
    f.app.store.set('attempts', author);
    f.app.store.set('factory-attempt-details', detail);
    f.app.store.set<TaskDetail>('factory-task-details', { id: f.task.id, key: f.task.id, checks: [UI_QUALITY_CHECK_COMMAND], planRevision: f.goal.revision, selected: true, failureSignatures: [] });
    f.app.store.set<ControlRecord>('factory-control', { id: f.goal.id, stage: 'dispatch', startedAt: since, steering: [] });
    f.app.store.set('goals', capabilityGoal);
    f.app.store.set<ControlRecord>('factory-control', { id: capabilityGoal.id, stage: 'plan', startedAt: since, steering: [], waitingFor: 'execution-capability', waitReason: capabilityGoal.error });
  });
  const taskBefore = f.app.store.get<FactoryTask>('tasks', f.task.id)!;
  const attemptsBefore = f.app.store.list<Attempt>('attempts');
  const candidateBefore = await f.factory.workspaces.candidate(f.candidate.id);
  const { verificationWait, ...retainedDetail } = f.app.store.get<AttemptDetail>('factory-attempt-details', author.id)!;
  assert.equal(verificationWait!.condition, 'inspection-evidence');

  f.app.emit('execution-capabilities', { deviceId: f.app.device.id });
  await f.factory.coordinator.waitForIdle();

  assert.deepEqual(f.app.store.get<AttemptDetail>('factory-attempt-details', author.id), retainedDetail, 'only the verification wait is cleared; the author result and retained candidate remain authoritative');
  assert.deepEqual(f.app.store.list<Attempt>('attempts'), attemptsBefore, 'capability recovery cannot create or replace an author attempt');
  assert.deepEqual(f.app.store.get<FactoryTask>('tasks', f.task.id), taskBefore, 'the task stays in review under the same current author');
  assert.deepEqual(await f.factory.workspaces.candidate(f.candidate.id), candidateBefore, 'the exact saved source remains retained');
  const decisions = f.app.store.list<{ goalId: string; kind: string; data?: { attemptId?: string; condition?: string } }>('decisions');
  assert.equal(decisions.filter(decision => decision.goalId === f.goal.id && decision.kind === 'verification-woken' && decision.data?.attemptId === author.id && decision.data?.condition === 'inspection-evidence').length, 1);
  assert.equal(f.app.store.get<Goal>('goals', capabilityGoal.id)!.status, 'planning', 'the original execution-capability wake is still delivered');
  assert.equal(f.app.store.get<ControlRecord>('factory-control', capabilityGoal.id)!.waitingFor, undefined);
  assert.equal(f.providerTurns.mock.callCount(), 0);
  assert.equal(f.observations.length, 0, 'the event schedules retained-source verification instead of performing it inline');
  f.assertNoDocker();
});

test('native candidate ordinary checks run with Docker unavailable and retain full-host provenance', { skip: process.platform !== 'darwin' }, async t => {
  const f = await harness(t);
  const checks = await f.factory.workspacePort.check(f.project, f.candidate, ['test "$(cat implementation.txt)" = "candidate implementation"; printf native-check-passed'], f.verification);
  assert.equal(checks.length, 1); assert.equal(checks[0]!.passed, true, checks[0]!.output);
  assert.equal(checks[0]!.executionTargetKind, 'host-macos'); assert.equal(checks[0]!.hostPermissions, 'full-host');
  assert.equal(checks[0]!.candidateCommit, f.candidate.commit); assert.equal(checks[0]!.checkedCommit, f.candidate.commit);
  const [report] = await f.reports(); assert.equal(report!.status, 'passed');
  assert.equal(report!.commands[0]!.hostPermissions, 'full-host');
  const evidence = JSON.parse((await f.factory.workspaces.artifacts.read(report!.logArtifact)).toString()) as CheckReport;
  assert.equal(evidence.commands[0]!.executionTargetKind, 'host-macos');
  assert.equal(await git(f.project.path, 'rev-parse', 'HEAD'), f.base);
  assert.equal(await readFile(path.join(f.project.path, 'implementation.txt'), 'utf8'), 'primary base\n');
  f.assertNoDocker();
});

test('successful commands with uncertain cleanup expose the actual failure without claiming source changed', async t => {
  const f = await harness(t), cleanup = 'Host check process inventory is unavailable after 2 probes: killed=true';
  const report: CheckReport = {
    id: 'uncertain-check', candidateId: f.candidate.id, commit: f.candidate.commit, status: 'failed',
    commands: [{ command: 'run-native-tests', exitCode: 0, stdout: '106 tests passed', stderr: '', startedAt: f.goal.createdAt, endedAt: f.goal.updatedAt }],
    cleanupErrors: [cleanup], createdAt: f.goal.updatedAt, logArtifact: f.candidate.bundleArtifact,
  };
  t.mock.method(f.factory.workspaces, 'verify', async () => report);
  const checks = await f.factory.workspacePort.check(f.project, f.candidate, ['run-native-tests'], f.verification);
  assert.equal(checks[0]!.passed, true);
  assert.equal(checks[1]!.passed, false, 'Passing tests do not establish safe cleanup or source integrity.');
  assert.match(checks[1]!.output, /could not confirm verification cleanup/);
  assert.match(checks[1]!.output, /workspace and process journals were retained/);
  assert(checks[1]!.output.includes(cleanup));
  assert.doesNotMatch(checks[1]!.output, /Checks changed|were canceled/);
  assert.equal(checks[1]!.candidateCommit, f.candidate.commit);
  assert.equal(await git(f.project.path, 'rev-parse', 'HEAD'), f.base);
  f.assertNoDocker();
});

test('service quality hook receives frozen contract and actual private C/M snapshots with exact secondary roots', async t => {
  const f = await harness(t);
  f.respond(async input => {
    assert.equal(input.goal, f.verification.goal); assert.equal(input.task, f.verification.task); assert.equal(input.attempt, f.verification.attempt); assert.equal(input.quality, f.verification.quality);
    assert.equal(input.task.title, 'Frozen native work'); assert.equal(input.quality.workflows[0]!.id, 'open-and-read');
    assert.equal(Object.isFrozen(input.quality), true);
    assert.equal(input.candidate.commit, f.candidate.commit);
    assert.equal(await git(input.path, 'rev-parse', 'HEAD'), input.checkedCommit);
    assert.notEqual(input.path, f.project.path); assert.notEqual(input.path, f.workspace.path);
    assert.equal(input.workingDirectories!.length, 1);
    assert.equal(input.workingDirectories![0]!.containerPath, f.captures[0]!.containerPath);
    assert.equal(input.workingDirectories![0]!.commit, f.captures[0]!.commit);
    assert.equal(path.dirname(input.workingDirectories![0]!.path), `${input.path}-working-directories`);
    assert.equal(await readFile(path.join(input.workingDirectories![0]!.path, 'tokens.txt'), 'utf8'), 'actual captured design reference\n');
    assert.ok(f.app.serviceUpdateStatus().busy.some(reason => /host or inspection operation/.test(reason)), 'the real service admission owns this callback');
    return { command: UI_QUALITY_CHECK_COMMAND, passed: true, output: `Verified ${input.checkedCommit}`, exitCode: 0, candidateCommit: input.candidate.commit, checkedCommit: input.checkedCommit };
  });
  const checked = await f.factory.workspacePort.check(f.project, f.candidate, [UI_QUALITY_CHECK_COMMAND], f.verification);
  assert.equal(checked[0]!.passed, true);
  await writeFile(path.join(f.project.path, 'parallel-work.txt'), 'independent accepted change\n'); await git(f.project.path, 'add', '.'); await git(f.project.path, 'commit', '-qm', 'Independent work advanced the target');
  const advanced = await git(f.project.path, 'rev-parse', 'HEAD');
  const integrated = await f.factory.workspacePort.integrate(f.project, f.candidate, { checks: [UI_QUALITY_CHECK_COMMAND], isCurrent: () => true, verification: f.verification });
  assert.equal(f.observations.length, 2); assert.equal(f.observations[0]!.checkedCommit, f.candidate.commit);
  assert.notEqual(integrated.commit, f.candidate.commit); assert.notEqual(integrated.commit, advanced);
  assert.equal(f.observations[1]!.checkedCommit, integrated.commit);
  assert.equal(path.basename(path.dirname(f.observations[0]!.path)), 'checks'); assert.equal(path.basename(path.dirname(f.observations[1]!.path)), 'integration');
  assert.equal(integrated.checks[0]!.candidateCommit, f.candidate.commit); assert.equal(integrated.checks[0]!.checkedCommit, integrated.commit);
  const recovered = await f.factory.workspacePort.reconcileIntegration!(f.project, f.candidate);
  assert.equal(recovered!.commit, integrated.commit); assert.deepEqual(recovered!.checks, integrated.checks);
  f.assertNoDocker();
});

test('pending quality evidence remains durable and blocks integration before the target is written', async t => {
  const f = await harness(t), recovery = { condition: 'inspection-evidence' as const, reason: 'The owned Mac inspection job has not produced current-source workflow evidence.' };
  f.respond(async input => ({ command: UI_QUALITY_CHECK_COMMAND, passed: false, output: recovery.reason, exitCode: 1, candidateCommit: input.candidate.commit, checkedCommit: input.checkedCommit, recovery }));
  const checks = await f.factory.workspacePort.check(f.project, f.candidate, [UI_QUALITY_CHECK_COMMAND], f.verification);
  assert.equal(checks[0]!.passed, false); assert.deepEqual(checks[0]!.recovery, recovery);
  await assert.rejects(f.factory.workspacePort.integrate(f.project, f.candidate, { checks: [UI_QUALITY_CHECK_COMMAND], isCurrent: () => true, verification: f.verification }), (error: unknown) => error instanceof FactoryVerificationWaitError && error.condition === 'inspection-evidence' && error.message === recovery.reason);
  assert.equal(await git(f.project.path, 'rev-parse', 'HEAD'), f.base); assert.equal(await git(f.project.path, 'status', '--porcelain'), '');
  for (const report of await f.reports()) {
    assert.equal(report.status, 'failed');
    assert.deepEqual((report.commands[0]!.factoryQuality as CheckResult).recovery, recovery);
    const evidence = JSON.parse((await f.factory.workspaces.artifacts.read(report.logArtifact)).toString()) as CheckReport;
    assert.deepEqual((evidence.commands[0]!.factoryQuality as CheckResult).recovery, recovery);
  }
  assert.equal((await f.reports()).length, 2);
  f.assertNoDocker();
});

test('observed quality failure and callback source mutation cannot accept a merge', async t => {
  const f = await harness(t);
  for (const mutate of [false, true]) {
    f.respond(async input => {
      if (mutate) await writeFile(path.join(input.path, 'implementation.txt'), 'changed by quality callback\n');
      return { command: UI_QUALITY_CHECK_COMMAND, passed: mutate, output: mutate ? 'Claimed success on a modified tree' : 'Native reading view clips message content.', exitCode: mutate ? 0 : 1, candidateCommit: input.candidate.commit, checkedCommit: input.checkedCommit };
    });
    await assert.rejects(f.factory.workspacePort.integrate(f.project, f.candidate, { checks: [UI_QUALITY_CHECK_COMMAND], isCurrent: () => true, verification: f.verification }), (error: unknown) => error instanceof FactoryOperationError && error.kind === 'checks-failed');
    assert.equal(await git(f.project.path, 'rev-parse', 'HEAD'), f.base);
    assert.equal(await readFile(path.join(f.project.path, 'implementation.txt'), 'utf8'), 'primary base\n');
  }
  assert.ok((await f.reports()).every(report => report.status === 'failed'));
  f.assertNoDocker();
});

test('quality callback evidence for a different candidate or combined commit fails closed', async t => {
  const f = await harness(t);
  for (const field of ['candidateCommit', 'checkedCommit'] as const) {
    f.respond(async input => ({ command: UI_QUALITY_CHECK_COMMAND, passed: true, output: 'Stale evidence', exitCode: 0, candidateCommit: input.candidate.commit, checkedCommit: input.checkedCommit, [field]: '0'.repeat(40) }));
    const checks = await f.factory.workspacePort.check(f.project, f.candidate, [UI_QUALITY_CHECK_COMMAND], f.verification);
    assert.equal(checks[0]!.passed, false); assert.match(checks[0]!.output, /does not identify the exact .*source/);
    await assert.rejects(f.factory.workspacePort.integrate(f.project, f.candidate, { checks: [UI_QUALITY_CHECK_COMMAND], isCurrent: () => true, verification: f.verification }), (error: unknown) => error instanceof FactoryOperationError && error.kind === 'checks-failed');
    assert.equal(await git(f.project.path, 'rev-parse', 'HEAD'), f.base);
  }
  f.assertNoDocker();
});

test('saved integration recovery cannot turn a marker without its trusted quality payload into shell success', async t => {
  const f = await harness(t);
  const integrated = await f.factory.workspacePort.integrate(f.project, f.candidate, { checks: [UI_QUALITY_CHECK_COMMAND], isCurrent: () => true, verification: f.verification });
  for (const folder of ['integrations', 'integration-intents']) {
    const directory = path.join(f.app.dataDir, 'workspace-data', folder);
    for (const filename of await readdir(directory)) {
      const selected = path.join(directory, filename), record = JSON.parse(await readFile(selected, 'utf8')) as { report: CheckReport };
      delete record.report.commands[0]!.factoryQuality;
      await writeFile(selected, JSON.stringify(record));
    }
  }
  const recovered = await f.factory.workspacePort.reconcileIntegration!(f.project, f.candidate);
  assert.ok(!recovered || recovered.checks.some(check => check.command === UI_QUALITY_CHECK_COMMAND && !check.passed), 'missing application-owned quality evidence must remain unverified during recovery');
  assert.equal(await git(f.project.path, 'rev-parse', 'HEAD'), integrated.commit, 'recovery does not rewrite already accepted source');
  f.assertNoDocker();
});

test('legacy container attempt reprepare keeps its omitted target and immutable legacy manifests', async t => {
  const f = await harness(t), identity = { projectPath: f.project.path, goalId: 'legacy-goal', taskId: 'legacy-task', attemptId: 'legacy-attempt' };
  const legacy = await f.factory.workspaces.create(identity);
  assert.equal(legacy.executionTargetKind, undefined);
  const reconnected = await f.factory.workspaces.create({ ...identity, executionTargetKind: 'container' });
  assert.equal(reconnected.executionTargetKind, undefined);
  const candidate = await f.factory.workspaces.capture({ workspaceId: legacy.id });
  assert.equal(candidate.executionTargetKind, undefined); assert.equal(candidate.bundleArtifact.metadata?.executionTargetKind, undefined); assert.equal(candidate.diffArtifact.metadata?.executionTargetKind, undefined);
  await assert.rejects(f.factory.workspaces.create({ ...identity, executionTargetKind: 'host-macos' }), /different frozen execution target/);
  f.assertNoDocker();
});

test('stopped native workers preserve uncommitted primary and independent folder changes before candidate capture', { skip: process.platform !== 'darwin' }, async t => {
  const f = await harness(t);
  const sources = await f.app.sessions.directoryManager.prepare({ identity: 'stopped-host-inputs', sources: f.project.workingDirectories! });
  const started = await f.app.sessions.createHost(f.project, 'stopped-capture', { workspace: f.workspace, workingDirectorySources: sources, executionTargetId: 'mac-host' });
  await f.app.sessions.waitExecutionReady(started.id);
  const session = f.app.sessions.record(started.id), extra = session.workingDirectories![0]!.path;
  await writeFile(path.join(f.workspace.path, 'implementation.txt'), 'uncommitted native primary edit\n');
  await writeFile(path.join(f.workspace.path, 'NativeFeature.swift'), 'struct RetainedNativeFeature {}\n');
  await writeFile(path.join(extra, 'tokens.txt'), 'uncommitted independent folder edit\n');
  await writeFile(path.join(extra, 'ExtraSource.swift'), 'struct RetainedExtraSource {}\n');
  const boundWorkspace = { ...f.workspace, deviceId: f.app.device.id, sessionId: session.id, workingDirectories: session.workingDirectories };
  const attempt = { ...f.attempt, sessionId: session.id, status: 'succeeded' as const };
  const worker = { id: attempt.id, coordinatorId: f.app.device.id, goal: f.goal, task: f.task, attempt, project: f.project, status: 'succeeded', workspace: boundWorkspace, sessionId: session.id, workingDirectorySources: sources, updatedAt: f.goal.updatedAt };
  f.app.store.set('factory-workers', worker);
  f.app.store.set('attempts', attempt);
  const beforeStop = await git(f.workspace.path, 'rev-parse', 'HEAD');
  await f.app.sessions.stop(session.id);
  assert.equal(f.app.sessions.record(session.id).status, 'stopped');
  assert.equal(await git(f.workspace.path, 'rev-parse', 'HEAD'), beforeStop, 'session stop captures extra folders while primary still needs Factory preservation');
  const captured = await f.factory.workspacePort.capture(boundWorkspace, { goal: f.goal, task: f.task, attempt });
  assert.notEqual(captured.commit, beforeStop);
  const candidate = await f.factory.workspaces.candidate(captured.id);
  const preserved = path.join(f.app.dataDir, 'workspace-data', 'verify-stopped-primary');
  await f.factory.workspaces.importSource({ artifact: candidate.bundleArtifact, targetPath: preserved });
  assert.equal(await readFile(path.join(preserved, 'implementation.txt'), 'utf8'), 'uncommitted native primary edit\n');
  assert.equal(await readFile(path.join(preserved, 'NativeFeature.swift'), 'utf8'), 'struct RetainedNativeFeature {}\n');
  assert.equal(candidate.workingDirectories!.length, 1);
  const preservedExtra = path.join(f.app.dataDir, 'workspace-data', 'verify-stopped-extra');
  await f.app.sessions.directoryManager.importCapture(candidate.workingDirectories![0]!, preservedExtra);
  assert.equal(await readFile(path.join(preservedExtra, 'tokens.txt'), 'utf8'), 'uncommitted independent folder edit\n');
  assert.equal(await readFile(path.join(preservedExtra, 'ExtraSource.swift'), 'utf8'), 'struct RetainedExtraSource {}\n');
  assert.equal(await readFile(path.join(f.project.path, 'implementation.txt'), 'utf8'), 'primary base\n');
  assert.equal(await readFile(path.join(f.project.workingDirectories![0]!.path, 'tokens.txt'), 'utf8'), 'actual captured design reference\n');
  assert.equal(await git(f.project.path, 'status', '--porcelain'), '');
  const repeated = await f.factory.workspacePort.capture(boundWorkspace, { goal: f.goal, task: f.task, attempt });
  assert.equal(repeated.id, captured.id); assert.equal(repeated.commit, captured.commit);
  // A crash after freezing source but before saving candidate cannot silently
  // turn subsequent stopped edits into the original attempt's evidence.
  f.app.store.set('factory-workers', worker);
  await writeFile(path.join(f.workspace.path, 'implementation.txt'), 'later stopped edit retained for reconciliation\n');
  await assert.rejects(f.factory.workspacePort.capture(boundWorkspace, { goal: f.goal, task: f.task, attempt }), /changed after its recorded source capture/);
  assert.equal(await readFile(path.join(f.workspace.path, 'implementation.txt'), 'utf8'), 'later stopped edit retained for reconciliation\n');
  f.assertNoDocker();
});

test('fixed Apple check profiles reach native service validation with the container runtime stopped', { skip: process.platform !== 'darwin' }, async t => {
  const f = await harness(t), command = 'enoughfactory:apple-build {"tool":"swift","package":"missing-fixture-package","action":"build"}';
  const checks = await f.factory.workspacePort.check(f.project, f.candidate, [command], f.verification);
  assert.equal(checks[0]!.passed, false);
  assert.match(checks[0]!.output, /missing-fixture-package|ENOENT/);
  assert.doesNotMatch(checks[0]!.output, /container runtime|private snapshot|validation accepts only/);
  assert.equal(await git(f.project.path, 'rev-parse', 'HEAD'), f.base);
  f.assertNoDocker();
});
