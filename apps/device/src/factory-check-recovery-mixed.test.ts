import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Attempt, FactoryTask, Goal, TaskQualityRequirements } from '@enoughfactory/contracts';
import { UI_QUALITY_CHECK_COMMAND, type CheckResult, type FactoryVerificationContext } from '@enoughfactory/factory';
import {
  APPLE_CHECK_PREFIX, WorkspaceManager, isAppleCheckCommand, parseAppleCheckCommand,
  type AppleCheckEvidence, type AppleCheckResult, type ArtifactManifest, type CheckExecutor, type CheckReport, type CommandResult,
} from '@enoughfactory/workspaces';
import { git } from '../../../packages/workspaces/src/process.ts';
import { confirmRetainedCheckRecovery, type RetainedCheckRecoveryInput } from './factory-check-recovery.ts';
import { hostCheckExecutor } from './host-checks.ts';

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const appleCommand = (platform: 'macos' | 'ios-simulator') => `${APPLE_CHECK_PREFIX} ${JSON.stringify({ tool: 'xcodebuild', project: 'Mail.xcodeproj', scheme: 'Mail', platform, configuration: 'Debug' })}`;
const missingSnapshot = 'The independent verifier has no owned source snapshot for the retained candidate.';

/** Reproduce the public service projection, including its fail-closed UI branch. */
function retainedChecks(report: CheckReport): CheckResult[] {
  return report.commands.map(command => {
    if (command.command === UI_QUALITY_CHECK_COMMAND) {
      const quality = command.factoryQuality as CheckResult | undefined;
      if (quality && quality.command === UI_QUALITY_CHECK_COMMAND && quality.candidateCommit === report.commit && quality.checkedCommit === report.commit) {
        return { ...quality, passed: quality.passed === true && command.exitCode === 0 && !command.timedOut };
      }
      return { command: command.command, passed: false, output: 'Recorded UI quality evidence does not identify the exact checked source.', exitCode: 1, candidateCommit: report.commit, checkedCommit: report.commit };
    }
    return {
      command: command.command, passed: command.exitCode === 0 && !command.timedOut,
      output: `${command.stdout}${command.stderr}`, exitCode: command.exitCode,
      candidateCommit: report.commit, checkedCommit: report.commit,
      developmentToolchain: command.developmentToolchain, executionTargetKind: command.executionTargetKind, hostPermissions: command.hostPermissions,
      ...((command as Partial<AppleCheckResult>).appleValidation ? { appleValidation: (command as AppleCheckResult).appleValidation } : {}),
    };
  });
}

async function mixedVerification(t: TestContext, options: { wrongUiSource?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'enoughfactory-mixed-recovery-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, 'project'), dataDir = path.join(directory, 'state'), root = path.join(dataDir, 'workspace-data');
  await mkdir(path.join(repository, 'scripts'), { recursive: true });
  await git(repository, 'init', '-q', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Mixed Recovery Fixture');
  await git(repository, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(repository, 'implementation.txt'), 'base implementation\n');
  await writeFile(path.join(repository, 'scripts', 'fixture-check.cjs'), "const assert=require('node:assert/strict'); const fs=require('node:fs'); assert.equal(fs.readFileSync('implementation.txt','utf8'),'saved implementation\\n'); console.log('Saved implementation verified');\n");
  await git(repository, 'add', '.'); await git(repository, 'commit', '-qm', 'Fixture base');
  const base = await git(repository, 'rev-parse', 'HEAD');
  const at = new Date().toISOString(), deviceId = 'mixed-check-coordinator';
  const quality: TaskQualityRequirements = {
    platforms: ['macos', 'ios-simulator'],
    workflows: [{ id: 'mac-read-mail', platform: 'macos' }, { id: 'ios-read-mail', platform: 'ios-simulator' }], referenceIds: ['primary'],
  };
  const goal: Goal = { id: 'mixed-goal', projectId: 'mixed-project', coordinatorId: deviceId, title: 'Verify retained mail source', objective: 'Deliver verified native mail apps', criteria: ['Both native apps work'], status: 'running', revision: 1, autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', concurrency: 1, createdAt: at, updatedAt: at };
  const task: FactoryTask = { id: 'mixed-task', goalId: goal.id, title: 'Native mail fixture', description: 'Verify exact saved source', acceptanceCriteria: ['Native workflows pass'], expectedOutputs: ['Verified apps'], dependsOn: [], status: 'review', currentAttemptId: 'mixed-attempt', deviceId, quality, execution: { target: 'host-macos', requiredCapabilities: ['mac-shell'] }, createdAt: at, updatedAt: at };
  const attempt: Attempt = { id: task.currentAttemptId!, taskId: task.id, generation: 1, deviceId, executionTargetKind: 'host-macos', executionTargetId: 'mac-host', status: 'succeeded', startedAt: at, endedAt: at };
  const verification: FactoryVerificationContext = { goal, task, attempt, quality };
  const commands = ['git diff --check HEAD', `${quote(process.execPath)} scripts/fixture-check.cjs`, appleCommand('macos'), appleCommand('ios-simulator'), UI_QUALITY_CHECK_COMMAND];
  const host = hostCheckExecutor({ checksRoot: path.join(root, 'checks') });
  const appleReceipts: ArtifactManifest[] = [], products: ArtifactManifest[] = [];
  const invoked: string[] = [], privateCheckPaths = new Set<string>();
  let manager!: WorkspaceManager;
  const executor: CheckExecutor = Object.assign(async (context: Parameters<CheckExecutor>[0]) => {
    invoked.push(context.command); privateCheckPaths.add(context.path);
    assert.notEqual(context.path, repository, 'Checks operate on the manager-owned candidate copy.');
    assert.equal(await git(context.path, 'rev-parse', 'HEAD'), context.commit);
    if (isAppleCheckCommand(context.command)) {
      const profile = parseAppleCheckCommand(context.command);
      assert.equal(profile.tool, 'xcodebuild');
      const result: CommandResult = { command: context.command, exitCode: 0, stdout: `${profile.platform} product retained\n`, stderr: '', startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
      // The Apple execution seam creates original immutable receipts/products;
      // this regression does not pretend to compile a real Xcode project.
      const product = await manager.artifacts.put(Buffer.from('504b0506000000000000000000000000000000000000', 'hex'), {
        name: `Mail-${profile.platform}.zip`, mime: 'application/zip', goalId: goal.id, taskId: task.id, attemptId: attempt.id,
        metadata: { candidateId: context.candidate.id, commit: context.commit, candidateCommit: context.candidate.commit, platform: profile.platform, scheme: profile.scheme, unsigned: true, format: 'apple-app-zip' },
      });
      const metadata: Omit<AppleCheckEvidence, 'result'> = {
        version: 1, candidateId: context.candidate.id, candidateCommit: context.candidate.commit, checkedCommit: context.commit,
        profile, sandbox: 'macos-seatbelt-deny-default', developerDirectory: '/Applications/Xcode.app/Contents/Developer',
        workingDirectories: [], products: [product],
      };
      const artifact = await manager.artifacts.put(JSON.stringify({ ...metadata, result }), {
        name: `apple-${profile.platform}.json`, mime: 'application/json', goalId: goal.id, taskId: task.id, attemptId: attempt.id,
        metadata: { candidateId: context.candidate.id, commit: context.commit, profile },
      });
      products.push(product); appleReceipts.push(artifact);
      return { ...result, appleValidation: { ...metadata, artifact } } satisfies AppleCheckResult;
    }
    if (context.command === UI_QUALITY_CHECK_COMMAND) {
      const factoryQuality: CheckResult = {
        command: UI_QUALITY_CHECK_COMMAND, passed: false, output: missingSnapshot, exitCode: 1,
        candidateCommit: context.candidate.commit, checkedCommit: options.wrongUiSource ? base : context.commit,
        recovery: { condition: 'inspection-evidence', reason: missingSnapshot },
      };
      return { command: context.command, exitCode: 1, stdout: missingSnapshot, stderr: '', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), factoryQuality };
    }
    return host(context);
  }, { release: host.release });
  manager = new WorkspaceManager({ dataDir: root, deviceId, checkExecutor: executor, checkTimeoutMs: 10_000 });
  const workspace = await manager.create({ projectPath: repository, goalId: goal.id, taskId: task.id, attemptId: attempt.id, executionTargetKind: 'host-macos' });
  await writeFile(path.join(workspace.path, 'implementation.txt'), 'saved implementation\n');
  await git(workspace.path, 'add', '.'); await git(workspace.path, 'commit', '-qm', 'Saved candidate');
  const captured = await manager.capture({ workspaceId: workspace.id });
  const candidate = await manager.candidate(captured.id);
  const report = await manager.verify({ candidateId: candidate.id, commands, verification });
  const previousChecks = retainedChecks(report);
  const input: RetainedCheckRecoveryInput = { workspaces: manager, dataDir, deviceId, candidate: { ...candidate }, verification, previousChecks, commands };
  const reportPath = path.join(root, 'reports', `${report.id}.json`), reportBytes = await readFile(reportPath);
  const logBytes = await manager.artifacts.read(report.logArtifact);
  const artifactBytes = await Promise.all([candidate.bundleArtifact, candidate.diffArtifact, ...appleReceipts, ...products].map(artifact => manager.artifacts.read(artifact)));
  return { repository, workspace, base, manager, candidate, report, reportPath, reportBytes, logBytes, artifactBytes, appleReceipts, products, previousChecks, input, invoked, privateCheckPaths };
}

test('real mixed host/Apple/UI check recovery reopens exact retained verification without accepting its failed UI', { skip: process.platform !== 'darwin' }, async t => {
  const f = await mixedVerification(t), before = structuredClone({ candidate: f.candidate, previous: f.previousChecks, verification: f.input.verification });
  assert.deepEqual(f.invoked, f.input.commands, `The manager preserves the full original mixed command order: ${JSON.stringify({ status: f.report.status, commands: f.report.commands, cleanupErrors: f.report.cleanupErrors })}`);
  assert.equal(f.report.status, 'failed'); assert.equal(f.report.commands.length, 5);
  assert.equal(f.report.commands[0]!.hostPermissions, 'full-host'); assert.equal(f.report.commands[1]!.executionTargetKind, 'host-macos');
  assert.equal(f.report.commands[1]!.stdout, 'Saved implementation verified\n');
  assert.deepEqual(f.previousChecks.map(check => check.passed), [true, true, true, true, false]);
  assert.equal(f.previousChecks[4]!.output, missingSnapshot);
  assert.equal(f.previousChecks[4]!.recovery?.condition, 'inspection-evidence');
  const audited = JSON.parse(f.logBytes.toString());
  assert.equal(audited.dirty, ''); assert.equal(audited.actualHead, f.candidate.commit);
  assert.deepEqual(audited.unresolved, []); assert.deepEqual(audited.workingDirectories, []);
  assert.equal(audited.cleanupErrors, undefined); assert.equal(audited.retainedCheckPath, undefined); assert.equal(audited.sourceAuditSkipped, undefined);
  const proof = await confirmRetainedCheckRecovery(f.input);
  assert.equal(proof.status, 'settled', proof.status === 'unknown' ? proof.reason : undefined);
  if (proof.status === 'settled') {
    assert.equal(proof.automatic, false, 'A UI snapshot failure has no original typed timeout/cancellation.');
    for (const artifact of [f.candidate.bundleArtifact, f.candidate.diffArtifact, f.report.logArtifact, ...f.appleReceipts]) assert.ok(proof.evidenceIds.includes(artifact.id));
  }
  assert.deepEqual({ candidate: f.candidate, previous: f.previousChecks, verification: f.input.verification }, before);
  assert.deepEqual(await f.manager.candidate(f.candidate.id), before.candidate);
  assert.deepEqual(await readFile(f.reportPath), f.reportBytes, 'Recovery does not rewrite the failed original report.');
  assert.deepEqual(await f.manager.artifacts.read(f.report.logArtifact), f.logBytes, 'Original cleanup/source evidence stays immutable.');
  const manifests = [f.candidate.bundleArtifact, f.candidate.diffArtifact, ...f.appleReceipts, ...f.products];
  for (const [index, artifact] of manifests.entries()) assert.deepEqual(await f.manager.artifacts.read(artifact), f.artifactBytes[index], 'Source, Apple products and execution receipts remain retained.');
  assert.equal(await git(f.repository, 'rev-parse', 'HEAD'), f.base);
  assert.equal(await readFile(path.join(f.repository, 'implementation.txt'), 'utf8'), 'base implementation\n');
  assert.equal(await git(f.workspace.path, 'rev-parse', 'HEAD'), f.candidate.commit);
  assert.equal(await readFile(path.join(f.workspace.path, 'implementation.txt'), 'utf8'), 'saved implementation\n');
  for (const checkPath of f.privateCheckPaths) await assert.rejects(readFile(path.join(checkPath, '.git', 'HEAD')), { code: 'ENOENT' }, 'The actual host checks released their private snapshots.');
});

test('a real mixed report with clean teardown cannot recover UI evidence for a different checked source', { skip: process.platform !== 'darwin' }, async t => {
  const f = await mixedVerification(t, { wrongUiSource: true });
  assert.equal(f.report.status, 'failed');
  assert.equal((f.report.commands[4]!.factoryQuality as CheckResult).checkedCommit, f.base);
  assert.equal(f.previousChecks[4]!.passed, false);
  const proof = await confirmRetainedCheckRecovery(f.input);
  assert.equal(proof.status, 'unknown', 'Positive ordinary and Apple checks never authorize a foreign UI source.');
  assert.deepEqual(await readFile(f.reportPath), f.reportBytes);
  assert.deepEqual(await f.manager.artifacts.read(f.report.logArtifact), f.logBytes);
  assert.equal(await git(f.repository, 'rev-parse', 'HEAD'), f.base);
});
