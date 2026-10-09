import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, FactoryTask, Goal } from '@enoughfactory/contracts';
import { UI_QUALITY_CHECK_COMMAND, type CheckResult, type FactoryVerificationContext } from '@enoughfactory/factory';
import { ArtifactStore, APPLE_CHECK_PREFIX, parseAppleCheckCommand, type AppleCheckEvidence, type AppleCheckResult, type ArtifactManifest, type Candidate, type CheckReport } from '@enoughfactory/workspaces';
import { confirmRetainedCheckRecovery, type RetainedCheckRecoveryInput } from './factory-check-recovery.ts';

const at = '2026-10-08T22:00:00.000Z';
const primary = 'a'.repeat(40), base = 'b'.repeat(40), extra = 'c'.repeat(40);
const command = `${APPLE_CHECK_PREFIX} ${JSON.stringify({ tool: 'xcodebuild', project: 'Mail.xcodeproj', scheme: 'Mail', platform: 'macos', configuration: 'Debug' })}`;
const commands = [command, `${APPLE_CHECK_PREFIX} ${JSON.stringify({ tool: 'xcodebuild', project: 'Mail.xcodeproj', scheme: 'Mail', platform: 'ios-simulator', configuration: 'Debug' })}`, UI_QUALITY_CHECK_COMMAND];
type Audit = { dirty: string; actualHead: string; unresolved: string[]; workingDirectories: Array<{ containerPath: string; commit: string; dirty: string; actualHead: string; emptyDirectories: unknown; expectedEmptyDirectories: unknown; emptyDirectoriesMatch: boolean }>; cleanupErrors?: string[]; sourceAuditSkipped?: string; retainedCheckPath?: string };

async function fixture(t: TestContext, owner = 'coordinator') {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'enoughfactory-check-recovery-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, 'workspace-data');
  const artifacts = new ArtifactStore(path.join(root, 'artifacts'), 'coordinator');
  const sourceStore = owner === 'coordinator' ? artifacts : new ArtifactStore(path.join(dataDir, 'author-artifacts'), owner);
  const authority = { goalId: 'goal', taskId: 'task', attemptId: 'attempt' };
  const source = async (name: string, mime: string, metadata: Record<string, unknown>, scoped = true): Promise<ArtifactManifest> => {
    const artifact = await sourceStore.put(`original immutable ${name}`, { name, mime, ...(scoped ? authority : {}), metadata });
    if (sourceStore !== artifacts) await artifacts.importFile(await sourceStore.path(artifact), artifact);
    return artifact;
  };
  const candidate: Candidate = {
    id: 'candidate', workspaceId: 'attempt', ...authority, deviceId: owner, baseCommit: base, commit: primary, branch: 'retained', createdAt: at, executionTargetKind: 'host-macos',
    bundleArtifact: await source('candidate.bundle', 'application/x-git-bundle', { commit: primary, baseCommit: base, executionTargetKind: 'host-macos' }),
    diffArtifact: await source('candidate.patch', 'text/x-diff', { commit: primary, baseCommit: base, executionTargetKind: 'host-macos' }),
    workingDirectories: [{ id: 'reference', name: 'reference', kind: 'git', containerPath: '/workspaces/reference', baseCommit: base, commit: extra,
      bundleArtifact: await source('reference.bundle', 'application/x-git-bundle', { commit: extra, baseCommit: base, workingDirectoryId: 'reference', emptyDirectories: ['empty'] }, false),
      diffArtifact: await source('reference.patch', 'text/x-diff', { commit: extra, baseCommit: base, workingDirectoryId: 'reference' }, false) }],
  };
  const goal: Goal = { id: 'goal', projectId: 'project', coordinatorId: 'coordinator', title: 'Native delivery', objective: 'Deliver the application', criteria: ['Native workflow and appearance verified'], status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', revision: 3, concurrency: 1, createdAt: at, updatedAt: at };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Deliver mail', description: 'Finish native mail', status: 'failed', currentAttemptId: 'attempt', dependsOn: [], quality: { platforms: ['macos', 'ios-simulator'], workflows: [{ id: 'compose', platform: 'macos' }, { id: 'read', platform: 'ios-simulator' }], referenceIds: ['reference'] }, createdAt: at, updatedAt: at };
  const attempt: Attempt = { id: 'attempt', taskId: task.id, generation: 3, deviceId: owner, status: 'failed', executionTargetKind: 'host-macos', executionTargetId: 'mac-host', startedAt: at, endedAt: at };
  const verification: FactoryVerificationContext = { goal, task, attempt, quality: task.quality };
  const result = { command, exitCode: 130, stdout: 'EnoughFactory Apple validation output', stderr: 'terminated by SIGTERM', timedOut: true, startedAt: at, endedAt: '2026-10-08T22:01:00.000Z' };
  const receipt: AppleCheckEvidence = { version: 1, candidateId: candidate.id, candidateCommit: primary, checkedCommit: primary, profile: parseAppleCheckCommand(command), sandbox: 'macos-seatbelt-deny-default', developerDirectory: '/Applications/Xcode.app/Contents/Developer', workingDirectories: [{ containerPath: '/workspaces/reference', commit: extra }], products: [], result };
  const audit: Audit = { dirty: '', actualHead: primary, unresolved: [], workingDirectories: [{ containerPath: '/workspaces/reference', commit: extra, actualHead: extra, dirty: '', emptyDirectories: ['empty'], expectedEmptyDirectories: ['empty'], emptyDirectoriesMatch: true }] };
  let active = false;
  const input: RetainedCheckRecoveryInput = { workspaces: { artifacts, candidate: async () => JSON.parse(JSON.stringify(candidate)) as Candidate, hasUnsettledChecks: () => active }, dataDir, deviceId: 'coordinator', candidate: { ...candidate }, verification, previousChecks: [], commands: [...commands] };
  const persist = async (options: { receipt?: AppleCheckEvidence; audit?: Audit; status?: CheckReport['status']; result?: AppleCheckResult; original?: boolean; scope?: Partial<typeof authority>; reportMetadata?: Record<string, unknown> } = {}) => {
    const original = options.receipt ?? receipt;
    const nativeArtifact = await artifacts.put(JSON.stringify(original), { name: 'original-apple-receipt.json', mime: 'application/json', ...authority, ...options.scope, metadata: { candidateId: candidate.id, commit: primary, profile: original.profile } });
    const { result: originalResult, ...metadata } = original;
    const selected: AppleCheckResult = options.result ?? { ...originalResult, appleValidation: { ...metadata, artifact: nativeArtifact } };
    const reportBase = { id: randomUUID(), candidateId: candidate.id, commit: primary, status: options.status ?? 'failed', commands: [selected], createdAt: at };
    const logArtifact = await artifacts.put(JSON.stringify({ ...options.audit ?? audit, ...reportBase }), { name: 'original-check-report.json', mime: 'application/json', ...authority, metadata: { candidateId: candidate.id, commit: primary, ...options.reportMetadata } });
    const report: CheckReport = { ...reportBase, logArtifact };
    await mkdir(path.join(root, 'reports'), { recursive: true });
    await writeFile(path.join(root, 'reports', `${report.id}.json`), JSON.stringify(report));
    input.previousChecks = [{ command: selected.command, passed: selected.exitCode === 0 && !selected.timedOut, output: `${selected.stdout}${selected.stderr}`, exitCode: selected.exitCode, candidateCommit: primary, checkedCommit: primary, ...(selected.appleValidation ? { appleValidation: selected.appleValidation } : {}) }];
    return report;
  };
  const report = await persist();
  return { input, root, artifacts, candidate, verification, receipt, audit, report, persist, setActive: (value: boolean) => { active = value; } };
}

test('original timed-out Apple check proof retains exact author, source and quality without accepting unrun checks', async t => {
  const f = await fixture(t), before = structuredClone({ candidate: f.candidate, verification: f.verification, previous: f.input.previousChecks, commands: f.input.commands });
  const proof = await confirmRetainedCheckRecovery(f.input);
  assert.equal(proof.status, 'settled');
  if (proof.status === 'settled') {
    assert.equal(proof.automatic, true);
    assert.deepEqual(new Set(proof.evidenceIds), new Set([f.candidate.bundleArtifact.id, f.candidate.diffArtifact.id, ...f.candidate.workingDirectories!.flatMap(root => [root.bundleArtifact.id, root.diffArtifact.id]), f.report.logArtifact.id, (f.report.commands[0] as AppleCheckResult).appleValidation.artifact!.id]));
  }
  assert.deepEqual({ candidate: f.candidate, verification: f.verification, previous: f.input.previousChecks, commands: f.input.commands }, before);
  assert.equal(f.input.previousChecks.length, 1, 'The remaining iOS and UI quality checks have not run or passed.');
});

test('paired author source is authenticated at the local coordinator without relabeling ownership', async t => {
  const f = await fixture(t, 'paired-mac');
  assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'settled');
  assert.equal(f.candidate.deviceId, 'paired-mac');
  assert.equal(f.verification.attempt.deviceId, 'paired-mac');
});

test('exit 130 and interrupted prose do not claim automatic recovery', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, 'reports'), { recursive: true });
  await f.persist({ receipt: { ...f.receipt, result: { ...f.receipt.result, timedOut: false } } });
  assert.deepEqual((await confirmRetainedCheckRecovery(f.input)).status, 'settled');
  const proof = await confirmRetainedCheckRecovery(f.input);
  assert.ok(proof.status === 'settled' && proof.automatic === false);
});

test('original typed canceled report permits automatic recovery independently of its prose', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, 'reports'), { recursive: true });
  await f.persist({ status: 'canceled', receipt: { ...f.receipt, result: { ...f.receipt.result, timedOut: false, stderr: '' } } });
  const proof = await confirmRetainedCheckRecovery(f.input);
  assert.ok(proof.status === 'settled' && proof.automatic === true);
});

test('current service interruption annotation matches original proof while invented annotation is rejected', async t => {
  await t.test('current typed service projection', async t => {
    const f = await fixture(t);
    f.input.previousChecks[0]!.recovery = { condition: 'check-interrupted', reason: 'The original verification was interrupted; saved work can be rechecked only after its owning effects and source are confirmed settled.' };
    const proof = await confirmRetainedCheckRecovery(f.input);
    assert.ok(proof.status === 'settled' && proof.automatic === true);
  });
  await t.test('invented lifecycle annotation', async t => {
    const f = await fixture(t); await rm(path.join(f.root, 'reports'), { recursive: true });
    await f.persist({ receipt: { ...f.receipt, result: { ...f.receipt.result, timedOut: false } } });
    f.input.previousChecks[0]!.recovery = { condition: 'check-interrupted', reason: 'Claimed timeout' };
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
});

test('uncertain or changed source and authority reject before admitting recovery', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void]> = [
    ['unsettled executor', f => f.setActive(true)],
    ['wrong coordinator', f => { f.input.deviceId = 'foreign'; }],
    ['wrong author', f => { f.verification.attempt.deviceId = 'foreign'; }],
    ['wrong current attempt', f => { f.verification.task.currentAttemptId = 'new-attempt'; }],
    ['changed candidate', f => { f.input.candidate = { ...f.input.candidate, commit: 'd'.repeat(40) }; }],
    ['changed frozen source manifest', f => { f.input.candidate = { ...f.input.candidate, bundleArtifact: { ...f.candidate.bundleArtifact, sha256: 'd'.repeat(64) } }; }],
    ['forged CAS content', async f => { await writeFile(await f.artifacts.path(f.candidate.bundleArtifact), 'corrupted original source'); }],
    ['wrong primary source metadata', async f => { const artifact = await f.artifacts.put('wrong-source', { name: 'wrong-source.bundle', mime: 'application/x-git-bundle', goalId: 'goal', taskId: 'task', attemptId: 'attempt', metadata: { commit: 'd'.repeat(40), baseCommit: base, executionTargetKind: 'host-macos' } }); f.candidate.bundleArtifact = artifact; f.input.candidate = { ...f.candidate }; }],
    ['wrong root source metadata', async f => { const root = f.candidate.workingDirectories![0]!; root.diffArtifact = await f.artifacts.put('wrong-root', { name: 'wrong-root.patch', mime: 'text/x-diff', metadata: { commit: 'd'.repeat(40), baseCommit: base, workingDirectoryId: root.id } }); f.input.candidate = { ...f.candidate }; }],
    ['missing original report', async f => { await rm(path.join(f.root, 'reports'), { recursive: true }); }],
    ['changed previous check outcome', f => { f.input.previousChecks[0]!.output = 'new output'; }],
    ['changed frozen command', f => { f.input.commands[0] = 'new-command'; }],
    ['combined verification context', async f => { await writeFile(path.join(f.root, 'reports', `${f.report.id}.json`), JSON.stringify({ ...f.report, baseCommit: base })); }],
    ['integration intent', async f => { await mkdir(path.join(f.root, 'integration-intents')); await writeFile(path.join(f.root, 'integration-intents', 'intent.json'), JSON.stringify({ candidateId: f.candidate.id })); }],
    ['integration receipt', async f => { await mkdir(path.join(f.root, 'integrations')); await writeFile(path.join(f.root, 'integrations', 'receipt.json'), JSON.stringify({ candidateId: f.candidate.id })); }],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t); await change(f);
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
});

test('original dirty, omitted or uncertain post-stop audit stays unknown', async t => {
  const cases: Array<[string, (audit: Audit) => void]> = [
    ['cleanup failure', audit => { audit.cleanupErrors = ['Termination unconfirmed']; }],
    ['skipped source audit', audit => { audit.sourceAuditSkipped = 'Active snapshot'; }],
    ['quarantined source', audit => { audit.retainedCheckPath = '/private/owned/check'; }],
    ['changed primary head', audit => { audit.actualHead = 'd'.repeat(40); }],
    ['dirty primary', audit => { audit.dirty = ' M Mail.swift'; }],
    ['unresolved conflict', audit => { audit.unresolved = ['Mail.swift']; }],
    ['missing root', audit => { audit.workingDirectories = []; }],
    ['changed root commit', audit => { audit.workingDirectories[0]!.actualHead = 'd'.repeat(40); }],
    ['dirty root', audit => { audit.workingDirectories[0]!.dirty = '?? secret.txt'; }],
    ['false empty-directory assertion', audit => { audit.workingDirectories[0]!.emptyDirectories = []; }],
    ['changed expected empty directories', audit => { audit.workingDirectories[0]!.expectedEmptyDirectories = []; }],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t), audit = structuredClone(f.audit); change(audit);
    await rm(path.join(f.root, 'reports'), { recursive: true }); await f.persist({ audit });
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
});

test('nested Apple receipt must be the original exact source, result, profile and authority', async t => {
  const cases: Array<[string, (receipt: AppleCheckEvidence) => void]> = [
    ['different candidate', receipt => { receipt.candidateId = 'foreign'; }],
    ['different checked source', receipt => { receipt.checkedCommit = 'd'.repeat(40); }],
    ['different attached source', receipt => { receipt.workingDirectories[0]!.commit = 'd'.repeat(40); }],
    ['omitted attached source', receipt => { receipt.workingDirectories = []; }],
    ['wrong platform profile', receipt => { receipt.profile = { tool: 'swift', package: '.', action: 'test' }; }],
    ['uncertain command cleanup', receipt => { receipt.result.cleanupErrors = ['Descendant still live']; }],
    ['no completed lifetime', receipt => { receipt.result.endedAt = 'not-a-time'; }],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t), receipt = structuredClone(f.receipt); change(receipt);
    await rm(path.join(f.root, 'reports'), { recursive: true }); await f.persist({ receipt });
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
  await t.test('wrong artifact authority', async t => {
    const f = await fixture(t); await rm(path.join(f.root, 'reports'), { recursive: true }); await f.persist({ scope: { attemptId: 'foreign' } });
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
  await t.test('nested outcome replaced after capture', async t => {
    const f = await fixture(t); await rm(path.join(f.root, 'reports'), { recursive: true });
    await f.persist({ result: { ...(f.report.commands[0] as AppleCheckResult), stderr: 'different command result' } });
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
});

test('ordinary host errors have no positive Apple receipt and remain unknown', async t => {
  const f = await fixture(t); await rm(path.join(f.root, 'reports'), { recursive: true });
  const ordinary = { ...f.receipt.result, command: 'xcodebuild build', executionTargetKind: 'host-macos' as const, hostPermissions: 'full-host' as const };
  await f.persist({ result: ordinary as AppleCheckResult });
  f.input.commands[0] = ordinary.command;
  f.input.previousChecks[0] = { ...f.input.previousChecks[0]!, executionTargetKind: 'host-macos', hostPermissions: 'full-host' };
  assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
});

test('ambiguous legacy reports and changed report pointers are never guessed', async t => {
  await t.test('ambiguous original identity', async t => {
    const f = await fixture(t);
    const copied = { ...f.report, id: randomUUID() };
    await writeFile(path.join(f.root, 'reports', `${copied.id}.json`), JSON.stringify(copied));
    const proof = await confirmRetainedCheckRecovery(f.input);
    assert.ok(proof.status === 'unknown' && /ambiguous/.test(proof.reason));
  });
  await t.test('original pointer replaced', async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.root, 'reports', `${f.report.id}.json`), JSON.stringify({ ...f.report, createdAt: '2026-10-09T00:00:00.000Z' }));
    const proof = await confirmRetainedCheckRecovery(f.input);
    assert.ok(proof.status === 'unknown' && /pointer/.test(proof.reason));
  });
});

test('executor, integration and source changes during proof inspection invalidate admission', async t => {
  await t.test('new unsettled execution', async t => {
    const f = await fixture(t); let calls = 0;
    f.input.workspaces.hasUnsettledChecks = () => ++calls > 1;
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
  await t.test('integration began during artifact inspection', async t => {
    const f = await fixture(t), originalRead = f.artifacts.read.bind(f.artifacts);
    t.mock.method(f.artifacts, 'read', async (artifact: ArtifactManifest) => {
      if (artifact.id === f.report.logArtifact.id) { await mkdir(path.join(f.root, 'integration-intents')); await writeFile(path.join(f.root, 'integration-intents', 'intent.json'), JSON.stringify({ candidateId: f.candidate.id })); }
      return originalRead(artifact);
    });
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
  await t.test('candidate changed after original proof', async t => {
    const f = await fixture(t); let calls = 0;
    f.input.workspaces.candidate = async () => ({ ...f.candidate, ...(++calls > 1 ? { commit: 'd'.repeat(40) } : {}) });
    assert.equal((await confirmRetainedCheckRecovery(f.input)).status, 'unknown');
  });
});
