import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, FactoryTask, Goal, TaskQualityRequirements } from '@enoughfactory/contracts';
import { UI_QUALITY_CHECK_COMMAND, type CheckResult, type FactoryVerificationContext } from '@enoughfactory/factory';
import { APPLE_CHECK_PREFIX, ArtifactStore, parseAppleCheckCommand, type AppleCheckEvidence, type AppleCheckResult, type Candidate, type CheckReport, type CommandResult } from '@enoughfactory/workspaces';
import { checkVerificationSha256, confirmInspectionCheckContinuation, confirmRetainedCheckRecovery, type RetainedCheckRecoveryInput } from './factory-check-recovery.ts';

const at = '2026-10-10T20:00:00.000Z', endedAt = '2026-10-10T20:01:00.000Z';
const commit = 'a'.repeat(40), base = 'b'.repeat(40), extra = 'c'.repeat(40);
const appleCommand = `${APPLE_CHECK_PREFIX} ${JSON.stringify({ tool: 'xcodebuild', project: 'Mail.xcodeproj', scheme: 'Mail', platform: 'macos', configuration: 'Debug' })}`;
const commands = ['sh scripts/checks/internal.sh', appleCommand, UI_QUALITY_CHECK_COMMAND];
type Audit = { dirty: string; actualHead: string; unresolved: string[]; workingDirectories: Array<{ containerPath: string; commit: string; dirty: string; actualHead: string; emptyDirectories: unknown; expectedEmptyDirectories: unknown; emptyDirectoriesMatch: boolean }>; cleanupErrors?: string[]; sourceAuditSkipped?: string; retainedCheckPath?: string };

function projection(report: CheckReport): CheckResult[] {
  return report.commands.map(result => {
    const identity = report.verificationSha256 ? { checkReportId: report.id } : {};
    if (result.command === UI_QUALITY_CHECK_COMMAND) return { ...(result.factoryQuality as CheckResult), passed: (result.factoryQuality as CheckResult).passed && result.exitCode === 0 && !result.timedOut, ...identity };
    return { command: result.command, passed: result.exitCode === 0 && !result.timedOut, output: `${result.stdout}${result.stderr}`, exitCode: result.exitCode,
      candidateCommit: commit, checkedCommit: report.commit, executionTargetKind: result.executionTargetKind, hostPermissions: result.hostPermissions, developmentToolchain: result.developmentToolchain,
      ...((result as AppleCheckResult).appleValidation ? { appleValidation: (result as AppleCheckResult).appleValidation } : {}), ...identity };
  });
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'enoughfactory-check-continuation-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, 'workspace-data'), owner = 'coordinator';
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'), owner);
  const authority = { goalId: 'goal', taskId: 'task', attemptId: 'attempt' };
  const checkInputs = { configurationRevision: 2, workingDirectoryIds: ['reference'], environment: { ENOUGH_EVIDENCE_ROOT: 'retained-evidence' } };
  const sourceMetadata = { commit, baseCommit: base, executionTargetKind: 'host-macos', checkInputs };
  const candidate: Candidate = { id: 'candidate', workspaceId: 'attempt', ...authority, deviceId: owner, commit, baseCommit: base, branch: 'saved', createdAt: at, executionTargetKind: 'host-macos', checkInputs,
    bundleArtifact: await artifacts.put('saved candidate bundle', { name: 'candidate.bundle', mime: 'application/x-git-bundle', ...authority, metadata: sourceMetadata }),
    diffArtifact: await artifacts.put('saved candidate patch', { name: 'candidate.patch', mime: 'text/x-diff', ...authority, metadata: sourceMetadata }),
    workingDirectories: [{ id: 'reference', name: 'reference', kind: 'git', containerPath: '/workspaces/reference', commit: extra, baseCommit: base,
      bundleArtifact: await artifacts.put('saved reference bundle', { name: 'reference.bundle', mime: 'application/x-git-bundle', metadata: { commit: extra, baseCommit: base, workingDirectoryId: 'reference', emptyDirectories: ['empty'] } }),
      diffArtifact: await artifacts.put('saved reference patch', { name: 'reference.patch', mime: 'text/x-diff', metadata: { commit: extra, baseCommit: base, workingDirectoryId: 'reference' } }) }] };
  const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'read-mail', platform: 'macos' }], referenceIds: ['reference'] };
  const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: owner, title: 'Native mail', objective: 'Deliver native mail', criteria: ['Native mail works and looks coherent'], status: 'running', revision: 3, autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 1, createdAt: at, updatedAt: at };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Deliver mail', description: 'Implement mail', dependsOn: [], status: 'review', currentAttemptId: 'attempt', quality, createdAt: at, updatedAt: at };
  const attempt: Attempt = { id: 'attempt', taskId: task.id, generation: 4, deviceId: owner, executionTargetKind: 'host-macos', executionTargetId: 'mac-host', status: 'succeeded', startedAt: at, endedAt };
  const verification: FactoryVerificationContext = { goal, task, attempt, quality, contract: { title: task.title, description: task.description, dependsOn: [], checks: commands.slice(0, -1), planRevision: 3, quality } };
  const ordinary: CommandResult = { command: commands[0]!, exitCode: 0, stdout: 'Internal checks passed\n', stderr: '', startedAt: at, endedAt, executionTargetKind: 'host-macos', hostPermissions: 'full-host' };
  const product = await artifacts.put('retained unsigned application ZIP', { name: 'Mail-macos.zip', mime: 'application/zip', ...authority,
    metadata: { candidateId: candidate.id, candidateCommit: commit, commit, platform: 'macos', scheme: 'Mail', unsigned: true, format: 'apple-app-zip' } });
  const nativeResult: CommandResult = { command: appleCommand, exitCode: 0, stdout: 'Native build passed\n', stderr: '', startedAt: at, endedAt };
  const appleReceipt: AppleCheckEvidence = { version: 1, candidateId: candidate.id, candidateCommit: commit, checkedCommit: commit, profile: parseAppleCheckCommand(appleCommand), sandbox: 'macos-seatbelt-deny-default', developerDirectory: '/Applications/Xcode.app/Contents/Developer', workingDirectories: [{ containerPath: '/workspaces/reference', commit: extra }], products: [product], result: nativeResult };
  const appleArtifact = await artifacts.put(JSON.stringify(appleReceipt), { name: 'original-apple.json', mime: 'application/json', ...authority, metadata: { candidateId: candidate.id, commit, profile: appleReceipt.profile } });
  const { result: _result, ...appleMetadata } = appleReceipt;
  const native: AppleCheckResult = { ...nativeResult, appleValidation: { ...appleMetadata, artifact: appleArtifact } };
  const uiQuality: CheckResult = { command: UI_QUALITY_CHECK_COMMAND, passed: false, output: 'The owned native inspector is producing current-source evidence.', exitCode: 1, candidateCommit: commit, checkedCommit: commit, recovery: { condition: 'inspection-evidence', reason: 'Current-source evidence is pending.' } };
  const ui: CommandResult = { command: UI_QUALITY_CHECK_COMMAND, exitCode: 1, stdout: uiQuality.output, stderr: '', startedAt: at, endedAt, factoryQuality: uiQuality };
  const audit: Audit = { dirty: '', actualHead: commit, unresolved: [], workingDirectories: [{ containerPath: '/workspaces/reference', commit: extra, actualHead: extra, dirty: '', emptyDirectories: ['empty'], expectedEmptyDirectories: ['empty'], emptyDirectoriesMatch: true }] };
  let active = false;
  const input: RetainedCheckRecoveryInput = { workspaces: { artifacts, candidate: async () => structuredClone(candidate), hasUnsettledChecks: () => active }, dataDir, deviceId: owner, candidate: { ...structuredClone(candidate) }, verification, commands: [...commands], previousChecks: [] };
  const digest = checkVerificationSha256(input);
  const persist = async (selected: CommandResult[], options: { id?: string; audit?: Audit; digest?: string | null; sourceIntegrity?: CheckReport['sourceIntegrity'] | null; status?: CheckReport['status']; baseCommit?: string } = {}): Promise<CheckReport> => {
    const pointer = { id: options.id ?? randomUUID(), candidateId: candidate.id, commit, commands: selected, status: options.status ?? 'failed', createdAt: at,
      ...(options.digest === null ? {} : { verificationSha256: options.digest ?? digest }), ...(options.sourceIntegrity === null ? {} : { sourceIntegrity: options.sourceIntegrity ?? 'verified' as const }), ...(options.baseCommit ? { baseCommit: options.baseCommit } : {}) };
    const logArtifact = await artifacts.put(JSON.stringify({ ...options.audit ?? audit, ...pointer }), { name: 'original-check-report.json', mime: 'application/json', ...authority, metadata: { candidateId: candidate.id, commit } });
    const report: CheckReport = { ...pointer, logArtifact };
    await mkdir(path.join(root, 'reports'), { recursive: true });
    await writeFile(path.join(root, 'reports', `${report.id}.json`), JSON.stringify(report));
    return report;
  };
  const original = await persist([ordinary, native, ui]); input.previousChecks = projection(original);
  const selectLatest = (report: CheckReport) => { input.previousChecks = [...projection(original).slice(0, -1), ...projection(report)]; };
  return { input, root, artifacts, candidate, verification, ordinary, native, ui, audit, product, appleArtifact, original, persist, selectLatest, setActive: (value: boolean) => { active = value; } };
}

test('pending native inspection reuses only exact original passed checks with immutable source, product and cleanup proof', async t => {
  const f = await fixture(t), before = structuredClone(f.input.previousChecks);
  const reportFile = path.join(f.root, 'reports', `${f.original.id}.json`), bytes = await readFile(reportFile), log = await f.artifacts.read(f.original.logArtifact);
  const proof = await confirmInspectionCheckContinuation(f.input);
  assert.equal(proof.status, 'settled', proof.status === 'unknown' ? proof.reason : undefined);
  if (proof.status === 'settled') {
    assert.equal(proof.automatic, false, 'Continuation does not authorize automatic retry of a genuine failure.');
    for (const artifact of [f.candidate.bundleArtifact, f.candidate.diffArtifact, f.original.logArtifact, f.appleArtifact]) assert.ok(proof.evidenceIds.includes(artifact.id));
  }
  assert.deepEqual(f.input.previousChecks, before);
  assert.deepEqual(await readFile(reportFile), bytes); assert.deepEqual(await f.artifacts.read(f.original.logArtifact), log);
});

test('identical repeated UI-only reports use exact IDs without newest-report selection or ambiguous legacy matching', async t => {
  const f = await fixture(t), reports: CheckReport[] = [];
  for (let index = 0; index < 4; index++) reports.push(await f.persist([structuredClone(f.ui)]));
  f.selectLatest(reports[1]!);
  const proof = await confirmInspectionCheckContinuation(f.input);
  assert.equal(proof.status, 'settled', proof.status === 'unknown' ? proof.reason : undefined);
  if (proof.status === 'settled') {
    assert.ok(proof.evidenceIds.includes(reports[1]!.logArtifact.id));
    assert.ok(!proof.evidenceIds.includes(reports[3]!.logArtifact.id), 'A later unreferenced report cannot supply authority.');
  }
  assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'settled', 'Explicit recovery also understands the exact composite report identity.');
});

test('genuine later UI rejection prevents continuation but allows explicit fresh verification without hiding the observed failure', async t => {
  const f = await fixture(t), rejected = structuredClone(f.ui), quality = rejected.factoryQuality as CheckResult;
  delete quality.recovery; quality.output = 'The source audit rejected fixture routing.'; rejected.stdout = quality.output;
  const latest = await f.persist([rejected]); f.selectLatest(latest);
  assert.equal((await confirmInspectionCheckContinuation(f.input)).status, 'unknown');
  const proof = await confirmRetainedCheckRecovery(f.input);
  assert.ok(proof.status === 'settled' && proof.automatic === false, proof.status === 'unknown' ? proof.reason : undefined);
  assert.equal(f.input.previousChecks.at(-1)!.output, quality.output);
  assert.equal(f.input.previousChecks.at(-1)!.passed, false);
});

test('verification digest ignores lifecycle presentation and key order while binding original requirements, source and policy', async t => {
  const f = await fixture(t), initial = checkVerificationSha256(f.input);
  const presented = structuredClone({ candidate: f.input.candidate, verification: f.input.verification, commands: f.input.commands });
  presented.verification.goal = { ...presented.verification.goal, status: 'paused', autonomy: 'manual', updatedAt: endedAt, error: 'Paused', nextAction: 'Wait' };
  presented.verification.task.status = 'failed'; presented.verification.attempt.status = 'failed'; presented.verification.attempt.error = 'Observed UI failure';
  assert.equal(checkVerificationSha256(presented), initial);
  presented.candidate = Object.fromEntries(Object.entries(presented.candidate).reverse()) as typeof presented.candidate;
  assert.equal(checkVerificationSha256(presented), initial);
  for (const change of [
    (value: typeof presented) => { value.verification.goal.criteria.push('Additional criterion'); },
    (value: typeof presented) => { value.verification.goal.approvalMode = 'manual'; },
    (value: typeof presented) => { value.verification.contract!.description += ' Additional contract'; },
    (value: typeof presented) => { value.verification.quality!.referenceIds.push('other-reference'); },
    (value: typeof presented) => { value.commands[0] = 'different-command'; },
    (value: typeof presented) => { value.candidate.checkInputs = { configurationRevision: 3 }; },
  ]) { const changed = structuredClone(presented); change(changed); assert.notEqual(checkVerificationSha256(changed), initial); }
});

test('legacy, incomplete, changed or uncertain continuation authority fails closed', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void]> = [
    ['legacy report identity', f => { for (const check of f.input.previousChecks) delete check.checkReportId; }],
    ['missing exact report', async f => { await rm(path.join(f.root, 'reports', `${f.original.id}.json`)); }],
    ['unsafe report path', f => { f.input.previousChecks[0]!.checkReportId = '../different'; }],
    ['mixed ordinary report identities', f => { f.input.previousChecks[1]!.checkReportId = randomUUID(); }],
    ['unsettled executor', f => f.setActive(true)],
    ['wrong coordinator', f => { f.input.deviceId = 'foreign'; }],
    ['retired current attempt', f => { f.verification.task.currentAttemptId = 'replacement'; }],
    ['changed goal revision', f => { f.verification.goal.revision++; }],
    ['changed frozen contract', f => { f.verification.contract!.acceptanceCriteria = ['Changed requirement']; }],
    ['changed quality', f => { f.verification.quality!.workflows.push({ id: 'compose', platform: 'macos' }); }],
    ['missing frozen contract', f => { delete f.verification.contract; }],
    ['changed candidate', f => { f.input.candidate.commit = 'd'.repeat(40); }],
    ['changed command', f => { f.input.commands[0] = 'different-command'; }],
    ['omitted ordinary result', f => { f.input.previousChecks.shift(); }],
    ['changed ordinary output', f => { f.input.previousChecks[0]!.output = 'Different evidence'; }],
    ['ordinary recovery annotation', f => { f.input.previousChecks[0]!.recovery = { condition: 'check-interrupted', reason: 'Interrupted' }; }],
    ['UI already passed', f => { f.input.previousChecks.at(-1)!.passed = true; }],
    ['UI real failure', f => { delete f.input.previousChecks.at(-1)!.recovery; }],
    ['UI checked foreign source', f => { f.input.previousChecks.at(-1)!.checkedCommit = 'd'.repeat(40); }],
    ['tampered report pointer', async f => { await writeFile(path.join(f.root, 'reports', `${f.original.id}.json`), JSON.stringify({ ...f.original, createdAt: endedAt })); }],
    ['tampered source CAS', async f => { await writeFile(await f.artifacts.path(f.candidate.bundleArtifact), 'Forged source'); }],
    ['tampered product CAS', async f => { await writeFile(await f.artifacts.path(f.product), 'Forged product'); }],
    ['missing product', async f => { await rm(await f.artifacts.path(f.product)); }],
    ['integration intent', async f => { await mkdir(path.join(f.root, 'integration-intents')); await writeFile(path.join(f.root, 'integration-intents', 'intent.json'), JSON.stringify({ candidateId: f.candidate.id })); }],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t); await change(f);
    const proof = await confirmInspectionCheckContinuation(f.input); assert.equal(proof.status, 'unknown', name);
  });
});

test('authentic reports still require clean positively ended source and command evidence', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>, selected: CommandResult[], audit: Audit) => void, Parameters<Awaited<ReturnType<typeof fixture>>['persist']>[1]?]> = [
    ['failed ordinary command', (_f, selected) => { selected[0]!.exitCode = 1; }],
    ['timed out ordinary command', (_f, selected) => { selected[0]!.timedOut = true; }],
    ['no host authority', (_f, selected) => { delete selected[0]!.hostPermissions; }],
    ['unfinished command lifetime', (_f, selected) => { selected[0]!.endedAt = 'not-a-time'; }],
    ['command cleanup error', (_f, selected) => { selected[0]!.cleanupErrors = ['Owned descendant still live']; }],
    ['dirty primary source', (_f, _selected, audit) => { audit.dirty = ' M Mail.swift'; }],
    ['changed reference source', (_f, _selected, audit) => { audit.workingDirectories[0]!.actualHead = 'd'.repeat(40); }],
    ['missing reference audit', (_f, _selected, audit) => { audit.workingDirectories = []; }],
    ['changed empty directories', (_f, _selected, audit) => { audit.workingDirectories[0]!.emptyDirectories = []; }],
    ['cleanup failed', (_f, _selected, audit) => { audit.cleanupErrors = ['Release unconfirmed']; }],
    ['audit skipped', (_f, _selected, audit) => { audit.sourceAuditSkipped = 'Uncertain ownership'; }],
    ['retained active snapshot', (_f, _selected, audit) => { audit.retainedCheckPath = '/private/retained/check'; }],
    ['canceled report', () => {}, { status: 'canceled' }],
    ['passed report', () => {}, { status: 'passed' }],
    ['combined source report', () => {}, { baseCommit: base }],
    ['legacy unbound report', () => {}, { digest: null }],
    ['foreign frozen contract', () => {}, { digest: 'd'.repeat(64) }],
    ['source integrity failed', () => {}, { sourceIntegrity: 'failed' }],
    ['source integrity unconfirmed', () => {}, { sourceIntegrity: 'unconfirmed' }],
    ['source integrity omitted', () => {}, { sourceIntegrity: null }],
  ];
  for (const [name, change, options] of cases) await t.test(name, async t => {
    const f = await fixture(t), selected = structuredClone(f.original.commands), audit = structuredClone(f.audit); change(f, selected, audit);
    const report = await f.persist(selected, { ...options, id: f.original.id, audit }); f.input.previousChecks = projection(report);
    assert.equal((await confirmInspectionCheckContinuation(f.input)).status, 'unknown', name);
  });
});

test('latest UI-only report must retain its exact clean audit and typed pending result', async t => {
  const cases: Array<[string, (selected: CommandResult[], audit: Audit) => void]> = [
    ['extra ordinary execution', selected => { selected.unshift({ ...selected[0]!, command: commands[0]!, factoryQuality: undefined, exitCode: 0 }); }],
    ['timed out UI', selected => { selected[0]!.timedOut = true; }],
    ['foreign UI evidence', selected => { (selected[0]!.factoryQuality as CheckResult).checkedCommit = 'd'.repeat(40); }],
    ['contradictory UI stdout', selected => { selected[0]!.stdout = 'Different UI evidence'; }],
    ['dirty UI source', (_selected, audit) => { audit.dirty = ' M Mail.swift'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t), selected = [structuredClone(f.ui)], audit = structuredClone(f.audit); change(selected, audit);
    const latest = await f.persist(selected, { audit }); f.selectLatest(latest);
    assert.equal((await confirmInspectionCheckContinuation(f.input)).status, 'unknown', name);
  });
});

test('native app continuation requires actual retained products bound to the original profile and source', async t => {
  const cases: Array<[string, Record<string, unknown> | null]> = [
    ['no retained runnable product', null],
    ['foreign product source', { commit: 'd'.repeat(40) }],
    ['foreign candidate identity', { candidateId: 'other-candidate' }],
    ['foreign platform', { platform: 'ios-simulator' }],
    ['foreign scheme', { scheme: 'OtherApp' }],
    ['different signing assertion', { unsigned: false }],
    ['different product format', { format: 'generic-archive' }],
  ];
  for (const [name, metadata] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    const receipt = JSON.parse((await f.artifacts.read(f.appleArtifact)).toString()) as AppleCheckEvidence;
    receipt.products = metadata === null ? [] : [await f.artifacts.put('different retained app ZIP', { name: f.product.name, mime: f.product.mime,
      goalId: f.product.goalId, taskId: f.product.taskId, attemptId: f.product.attemptId, metadata: { ...f.product.metadata, ...metadata } })];
    const artifact = await f.artifacts.put(JSON.stringify(receipt), { name: f.appleArtifact.name, mime: f.appleArtifact.mime,
      goalId: f.appleArtifact.goalId, taskId: f.appleArtifact.taskId, attemptId: f.appleArtifact.attemptId, metadata: f.appleArtifact.metadata });
    const { result, ...apple } = receipt;
    const native: AppleCheckResult = { ...result, appleValidation: { ...apple, artifact } };
    const report = await f.persist([f.ordinary, native, f.ui], { id: f.original.id }); f.input.previousChecks = projection(report);
    assert.equal((await confirmInspectionCheckContinuation(f.input)).status, 'unknown', name);
  });
});

test('new checkpoint source integrity must positively pass in both original and UI-only reports', async t => {
  for (const sourceIntegrity of ['failed', 'unconfirmed', null] as const) {
    await t.test(`original source integrity ${sourceIntegrity ?? 'omitted'}`, async t => {
      const f = await fixture(t);
      const report = await f.persist(f.original.commands, { id: f.original.id, sourceIntegrity }); f.input.previousChecks = projection(report);
      assert.equal((await confirmInspectionCheckContinuation(f.input)).status, 'unknown');
      assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown', 'A new full report cannot claim settled recovery without positive source integrity.');
    });
    await t.test(`latest source integrity ${sourceIntegrity ?? 'omitted'}`, async t => {
      const f = await fixture(t);
      const latest = await f.persist([f.ui], { sourceIntegrity }); f.selectLatest(latest);
      assert.equal((await confirmInspectionCheckContinuation(f.input)).status, 'unknown');
      assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown', 'Composite recovery cannot hide uncertain source behind passed ordinary checks.');
    });
  }
});
