import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CandidateRef, CheckResult, ConfirmCheckRecoveryResult, FactoryVerificationContext } from '@enoughfactory/factory';
import { UI_QUALITY_CHECK_COMMAND } from '@enoughfactory/factory';
import { parseAppleCheckCommand, type AppleCheckEvidence, type AppleCheckResult, type ArtifactManifest, type Candidate, type CheckReport, type WorkspaceManager } from '@enoughfactory/workspaces';

export interface RetainedCheckRecoveryInput {
  workspaces: Pick<WorkspaceManager, 'candidate' | 'artifacts' | 'hasUnsettledChecks'>;
  dataDir: string;
  deviceId: string;
  candidate: CandidateRef;
  verification: FactoryVerificationContext;
  previousChecks: CheckResult[];
  commands: string[];
}
export type RetainedCheckRecoveryProof = ConfirmCheckRecoveryResult;

type SourceAudit = {
  dirty?: string; actualHead?: string; unresolved?: string[]; sourceAuditSkipped?: string; retainedCheckPath?: string;
  workingDirectories?: Array<{ containerPath: string; commit: string; dirty: string; actualHead: string; emptyDirectories: unknown; expectedEmptyDirectories: unknown; emptyDirectoriesMatch: boolean }>;
};
const maximumRecordBytes = 64 * 1024 * 1024;
const canonical = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const same = (left: unknown, right: unknown) => isDeepStrictEqual(canonical(left), canonical(right));
function requireProof(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }

/** Only the owning service's original source and check artifacts can reopen a retained check. */
export async function confirmRetainedCheckRecovery(input: RetainedCheckRecoveryInput): Promise<RetainedCheckRecoveryProof> {
  try {
    requireProof(!input.workspaces.hasUnsettledChecks(input.candidate.id), 'Check execution or integration is still unsettled.');
    const candidate = await input.workspaces.candidate(input.candidate.id);
    requireProof(same(candidate, input.candidate), 'The retained source differs from its original candidate record.');
    const { goal, task, attempt } = input.verification;
    requireProof(goal.coordinatorId === input.deviceId && task.goalId === goal.id && attempt.taskId === task.id && task.currentAttemptId === attempt.id &&
      candidate.goalId === goal.id && candidate.taskId === task.id && candidate.attemptId === attempt.id && candidate.deviceId === attempt.deviceId,
    'The retained source does not belong to this coordinator and attempt.');
    requireProof(input.commands.length > 0 && input.previousChecks.length > 0 && input.previousChecks.some(check => !check.passed), 'No original failed candidate check was retained.');
    const evidenceIds = await authenticateSource(input, candidate);
    const root = path.join(input.dataDir, 'workspace-data');
    await assertNoIntegration(root, candidate.id);

    const matches: CheckReport[] = [];
    for (const filename of await recordFiles(path.join(root, 'reports'))) {
      const report = await readPrivateJson<CheckReport>(path.join(root, 'reports', filename));
      if (report.candidateId === candidate.id && report.commit === candidate.commit && Array.isArray(report.commands) &&
        matchesPreviousChecks(report, candidate.commit, input.previousChecks)) matches.push(report);
    }
    requireProof(matches.length === 1, matches.length ? 'Several original reports match this legacy check result; its execution identity is ambiguous.' : 'The original candidate check report is unavailable.');
    const report = matches[0]!;
    requireProof(report.status === 'failed' || report.status === 'canceled', 'The original report does not record a failed candidate check.');
    requireProof(report.baseCommit === undefined && same(report.candidateDevelopmentToolchain, candidate.developmentToolchain), 'The original report is not the frozen candidate verification context.');
    requireProof(report.commands.length <= input.commands.length && report.commands.every((command, index) => command.command === input.commands[index]), 'The report does not follow the original frozen check commands.');
    requireProof(report.commands.every((command, index) => index === report.commands.length - 1 || command.exitCode === 0 && !command.timedOut), 'The report continued execution after an unsettled check.');
    requireProof(report.commands.at(-1)!.exitCode !== 0 || report.commands.at(-1)!.timedOut, 'The report has no original unsuccessful command outcome.');
    await authenticateArtifact(input, report.logArtifact, input.deviceId, candidate, true);
    requireProof(report.logArtifact.metadata?.candidateId === candidate.id && report.logArtifact.metadata.commit === candidate.commit, 'The original report manifest identifies a different candidate source.');
    const original = await artifactJson<CheckReport & SourceAudit>(input, report.logArtifact);
    const { logArtifact: _log, ...pointer } = report;
    requireProof(Object.entries(pointer).every(([key, value]) => same(value, (original as unknown as Record<string, unknown>)[key])), 'The report pointer differs from its original immutable evidence.');
    assertCleanAudit(original, candidate);
    evidenceIds.push(report.logArtifact.id);

    for (const command of report.commands) {
      const apple = (command as AppleCheckResult).appleValidation;
      requireProof(apple?.artifact, 'This original checker has no retained positive Apple execution receipt.');
      requireProof(!command.cleanupErrors?.length, 'The original check could not confirm resource termination.');
      requireProof(apple.version === 1 && apple.sandbox === 'macos-seatbelt-deny-default' && apple.developerDirectory === '/Applications/Xcode.app/Contents/Developer' &&
        apple.candidateId === candidate.id && apple.candidateCommit === candidate.commit && apple.checkedCommit === candidate.commit &&
        same(apple.profile, parseAppleCheckCommand(command.command)) && same(apple.workingDirectories, (candidate.workingDirectories ?? []).map(({ containerPath, commit }) => ({ containerPath, commit }))),
      'The Apple receipt does not identify the exact original check source and profile.');
      await authenticateArtifact(input, apple.artifact, input.deviceId, candidate, true);
      requireProof(apple.artifact.metadata?.candidateId === candidate.id && apple.artifact.metadata.commit === candidate.commit && same(apple.artifact.metadata.profile, apple.profile), 'The Apple artifact manifest has different source metadata.');
      const receipt = await artifactJson<AppleCheckEvidence>(input, apple.artifact);
      const { result, ...metadata } = receipt;
      const { appleValidation: _apple, ...commandResult } = command as AppleCheckResult;
      requireProof(same({ ...metadata, artifact: apple.artifact }, apple) && same(result, commandResult), 'The Apple artifact differs from its original command outcome.');
      requireProof(!result.cleanupErrors?.length && typeof result.startedAt === 'string' && typeof result.endedAt === 'string' && Number.isFinite(Date.parse(result.startedAt)) && Date.parse(result.endedAt) >= Date.parse(result.startedAt), 'The original Apple execution receipt is incomplete or uncertain.');
      for (const product of apple.products) await authenticateArtifact(input, product, input.deviceId, candidate, true);
      evidenceIds.push(apple.artifact.id);
    }
    // NativeTeardownError never produces an Apple receipt. A normal retained receipt,
    // followed by WorkspaceManager's clean post-release audit, proves settled execution.
    // The older runner recorded timeout as a boolean; exit 130 and prose alone are not transient proof.
    const automatic = report.status === 'canceled' || report.commands.some(command => command.timedOut === true);
    requireProof(!input.workspaces.hasUnsettledChecks(candidate.id), 'Check execution or integration changed while recovery evidence was inspected.');
    await assertNoIntegration(root, candidate.id);
    requireProof(same(await input.workspaces.candidate(candidate.id), candidate), 'The retained source changed while recovery evidence was inspected.');
    return { status: 'settled', automatic, evidenceIds: [...new Set(evidenceIds)] };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }
}

async function authenticateSource(input: RetainedCheckRecoveryInput, candidate: Candidate): Promise<string[]> {
  const ids: string[] = [];
  for (const artifact of [candidate.bundleArtifact, candidate.diffArtifact]) {
    await authenticateArtifact(input, artifact, candidate.deviceId, candidate, true);
    requireProof(artifact.metadata?.commit === candidate.commit && artifact.metadata.baseCommit === candidate.baseCommit &&
      same(artifact.metadata.checkInputs ?? null, candidate.checkInputs ?? null) && same(artifact.metadata.developmentToolchain ?? null, candidate.developmentToolchain ?? null) &&
      (artifact.metadata.executionTargetKind ?? 'container') === (candidate.executionTargetKind ?? 'container'), 'Primary source evidence has different frozen candidate metadata.');
    ids.push(artifact.id);
  }
  for (const capture of candidate.workingDirectories ?? []) for (const artifact of [capture.bundleArtifact, capture.diffArtifact]) {
    await authenticateArtifact(input, artifact, candidate.deviceId, candidate, false);
    requireProof(artifact.metadata?.commit === capture.commit && artifact.metadata.baseCommit === capture.baseCommit && artifact.metadata.workingDirectoryId === capture.id, 'Attached source evidence has different captured root metadata.');
    ids.push(artifact.id);
  }
  return ids;
}

async function authenticateArtifact(input: RetainedCheckRecoveryInput, manifest: ArtifactManifest, owner: string, candidate: Candidate, authorityRequired: boolean): Promise<void> {
  requireProof(manifest && manifest.deviceId === owner && same(await input.workspaces.artifacts.get(manifest.id), manifest), 'An original artifact manifest is unavailable, forged or owned by another device.');
  for (const key of ['goalId', 'taskId', 'attemptId'] as const) requireProof((!authorityRequired && manifest[key] === undefined) || manifest[key] === candidate[key], 'An artifact belongs to different attempt authority.');
  await input.workspaces.artifacts.path(manifest);
}

async function artifactJson<T>(input: RetainedCheckRecoveryInput, artifact: ArtifactManifest): Promise<T> {
  requireProof(artifact.mime === 'application/json' && artifact.size <= maximumRecordBytes, 'The original JSON evidence exceeds the supported recovery limit.');
  return JSON.parse((await input.workspaces.artifacts.read(artifact)).toString()) as T;
}

function assertCleanAudit(report: CheckReport & SourceAudit, candidate: Candidate): void {
  requireProof(!report.cleanupErrors?.length && !report.sourceAuditSkipped && !report.retainedCheckPath && report.dirty === '' && report.actualHead === candidate.commit && Array.isArray(report.unresolved) && report.unresolved.length === 0, 'The original report has no clean post-termination source audit.');
  const captures = candidate.workingDirectories ?? [];
  requireProof(Array.isArray(report.workingDirectories) && report.workingDirectories.length === captures.length && captures.every((capture, index) => {
    const root = report.workingDirectories![index]!;
    const empty = capture.bundleArtifact.metadata?.emptyDirectories ?? [];
    return root.containerPath === capture.containerPath && root.commit === capture.commit && root.actualHead === capture.commit && root.dirty === '' && root.emptyDirectoriesMatch === true && same(root.emptyDirectories, empty) && same(root.expectedEmptyDirectories, empty);
  }), 'The original source audit omitted or changed an attached root.');
}

/** Match the actual service projection, rather than parsing output as lifecycle state. */
function projectChecks(report: CheckReport, candidateCommit: string): CheckResult[] {
  return report.commands.map(command => {
    if (command.command === UI_QUALITY_CHECK_COMMAND) {
      const quality = command.factoryQuality as CheckResult | undefined;
      if (quality?.command === UI_QUALITY_CHECK_COMMAND && quality.candidateCommit === candidateCommit && quality.checkedCommit === report.commit) return { ...quality, passed: quality.passed === true && command.exitCode === 0 && !command.timedOut };
    }
    return { command: command.command, passed: command.exitCode === 0 && !command.timedOut, output: `${command.stdout}${command.stderr}`, exitCode: command.exitCode, candidateCommit, checkedCommit: report.commit,
      developmentToolchain: command.developmentToolchain, executionTargetKind: command.executionTargetKind, hostPermissions: command.hostPermissions,
      ...((command as Partial<AppleCheckResult>).appleValidation ? { appleValidation: (command as AppleCheckResult).appleValidation } : {}) };
  });
}

function matchesPreviousChecks(report: CheckReport, candidateCommit: string, previous: CheckResult[]): boolean {
  const original = projectChecks(report, candidateCommit);
  return original.length === previous.length && previous.every((check, index) => {
    // New services annotate interrupted checks. Legacy records have the same original
    // outcome without that derived explanation; only the original typed lifecycle permits it.
    if (check.recovery?.condition === 'check-interrupted') {
      const { recovery: _recovery, ...retained } = check;
      return (report.commands[index]!.timedOut === true || report.status === 'canceled') && same(retained, original[index]);
    }
    return same(check, original[index]);
  });
}

async function assertNoIntegration(root: string, candidateId: string): Promise<void> {
  for (const directory of ['integrations', 'integration-intents']) for (const filename of await recordFiles(path.join(root, directory))) {
    const record = await readPrivateJson<{ candidateId?: string }>(path.join(root, directory, filename));
    requireProof(record.candidateId !== candidateId, 'This candidate has an integration record or intent; reconcile acceptance before retrying checks.');
  }
}

async function recordFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  requireProof(entries.length <= 10_000, 'Recovery storage exceeds the supported bounded inspection limit.');
  return entries.filter(filename => filename.endsWith('.json'));
}

async function readPrivateJson<T>(filename: string): Promise<T> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    requireProof(stat.isFile() && stat.size <= maximumRecordBytes, 'Recovery record is not a bounded original file.');
    return JSON.parse(await file.readFile('utf8')) as T;
  } finally { await file.close(); }
}
