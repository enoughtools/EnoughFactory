import { createHash } from 'node:crypto';
import { chmod, cp, lchmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Attempt, Chat, ChatEvent, ExecutionCapability, ExecutionTargetAdvertisement, FactoryTask, Goal, InspectionAuthority, InspectionSourceIdentity, InspectionVerificationAcceptance, InspectionVerificationRun, Project, Session, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import type { HostProcessState } from '@enoughfactory/agents';
import { ArtifactStore, InspectionSnapshotManager, WorkspaceManager, exportInspectionContainerRoots, exportInspectionSnapshot, importInspectionSnapshot, verifyInspectionSnapshotContents, writeAtomic, type InspectionSnapshot, type InspectionSnapshotTransfer, type WorkspaceRecord } from '@enoughfactory/workspaces';
import { dockerInvocation } from '@enoughfactory/runtime';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext, ChatController } from './chats.ts';
import { goalAgentCount } from './factory-agent-capacity.ts';
import { factoryQualityInstructions } from './factory-quality.ts';
import { inspectionSourceContentMatches, type InspectionQualityService } from './inspection-quality.ts';
import type { DelegatedNativeInspectionReadiness } from './inspection-delegation.ts';
import { canonicalVerificationValue as canonical, inspectionAcceptanceContractSha256, inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verification-identity.ts';
import { INLINE_VERIFICATION_CONTRACT_CHARACTERS, verificationContractContent } from './inspection-verification-contract.ts';
import { exec } from './util.ts';
import { INSPECTION_SOURCE_MAX_BYTES } from './inspection-source-policy.ts';
export { inspectionAcceptanceContractSha256, inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verification-identity.ts';

export const INSPECTION_VERIFIER_RUNS = 'inspection-verifier-runs';
const INPUTS = 'inspection-verifier-inputs';
const terminal = new Set<InspectionVerificationRun['status']>(['succeeded', 'failed', 'canceled', 'unknown']);
const sha = /^[a-f0-9]{64}$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const setupOwnerChangedReason = 'The independent setup owner changed.';
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

export interface VerificationInput {
  authority: InspectionAuthority;
  purpose?: 'task' | 'goal-final';
  /** Current canonical goal revision, independently of the frozen author assignment. */
  goalRevision?: number;
  /** Optional caller projection is checked against the original durable contract. */
  acceptanceContract?: InspectionVerificationAcceptance;
  source: InspectionSourceIdentity;
  /** The exact candidate or combined integration-check snapshot, never the author's live worktree. */
  snapshot: InspectionSnapshot;
  quality: TaskQualityRequirements;
  project: Project;
  signal?: AbortSignal;
}
export interface VerificationSource {
  id: string;
  snapshot: InspectionSnapshot;
  source: InspectionSourceIdentity;
  run: InspectionVerificationRun;
}
interface VerificationInputs {
  id: string;
  project: Project;
  transfer: InspectionSnapshotTransfer;
  snapshot?: InspectionSnapshot;
  retirement?: { startedAt: string; workspace?: WorkspaceRecord; workspaceDirectory?: DirectoryIdentity; cacheIdentity?: string; cacheDirectory?: DirectoryIdentity; cacheJournalSha256?: string; primarySource?: InspectionSnapshotTransfer };
  retiredAt?: string;
}
interface DirectoryIdentity { dev: string; ino: string }
export interface VerificationPreparation {
  run: InspectionVerificationRun;
  snapshot: InspectionSnapshot;
  project: Project;
  signal: AbortSignal;
  assertCurrent: () => void;
  /** Publish the owner before asynchronous preparation can be interrupted. */
  onSession: (session: Session) => void;
}
export interface InspectionVerifierOptions {
  app: DeviceApp;
  chats: ChatController;
  quality: Pick<InspectionQualityService, 'check' | 'context'>;
  authorityCurrent: (authority: InspectionAuthority) => boolean;
  readiness: () => Promise<ExecutionTargetAdvertisement[]>;
  /** Project-specific profiles discovered through online authenticated paired native owners. */
  delegatedReadiness?: (projectId: string) => Promise<DelegatedNativeInspectionReadiness[]>;
  /** Only an original service-owned audit may defer an ended verifier turn. */
  /** Source-only setup may prepare the first profile; native actions and final evidence stay gated. */
  allowNativeProfileSetup?: boolean;
  pendingNativeSetup?: (authority:InspectionAuthority,source:InspectionSourceIdentity)=>{status:'pending'|'unknown'|'rejected';reason:string}|undefined;
  /** Default twenty minutes. A completed verifier is never silently dispatched again. */
  timeoutMs?: number;
  /** Alternate owner must prepare and verify exact private execution copies before return. */
  prepareExecution?: (input: VerificationPreparation) => Promise<Session>;
  /** Stop-only reconciliation of original inspection jobs; no uncertain action is replayed. */
  reconcileInspection?: (run: InspectionVerificationRun, signal: AbortSignal) => Promise<boolean>;
}

function hostProofMatchesVerifier(process: HostProcessState, run: InspectionVerificationRun, workdir: string): boolean {
  const proof = process.termination;
  if (process.state !== 'exited' || proof?.schemaVersion !== 2) return false;
  if (proof.kind === 'host-reboot') return proof.evidence === 'boot-identity-change' && proof.previousBoot?.platform === proof.currentBoot.platform && proof.previousBoot.machineId === proof.currentBoot.machineId && proof.previousBoot.bootId !== proof.currentBoot.bootId;
  if (proof.kind === 'supervised-termination') return proof.evidence === 'complete-owned-teardown' && proof.previousStatus === 'exited' && proof.inventoryComplete === true && proof.exitCode === null && proof.exitSignal === 'SIGKILL'
    && proof.processKey === process.processKey && proof.sessionId === run.sessionId && proof.cwd === workdir && sha.test(proof.priorRecordSha256)
    && proof.supervisor?.pid === process.pid && Number.isSafeInteger(proof.supervisor.pid) && proof.supervisor.pid >= 2 && typeof proof.supervisor.identity === 'string'
    && proof.supervisor.path === process.recordPath.replace(/\.json$/, '.cjs') && proof.supervisor.identity.includes(proof.supervisor.path) && proof.supervisor.identity.includes(process.processKey)
    && Array.isArray(proof.children) && proof.children.length <= 2048 && proof.children.every(child => Number.isSafeInteger(child.pid) && child.pid >= 2 && typeof child.identity === 'string' && !!child.identity)
    && Number.isFinite(Date.parse(proof.observedAt)) && Date.parse(proof.observedAt) >= Date.parse(process.createdAt!);
  if (proof.kind !== 'operator-attested-reboot' || proof.evidence !== 'operator-observed-os-restart' || !proof.actor?.trim() || proof.actor.length > 256 || proof.verificationRunId !== run.id || proof.chatId !== run.chatId || proof.sessionId !== run.sessionId || proof.cwd !== workdir || proof.processKey !== process.processKey || !sha.test(proof.priorRecordSha256)) return false;
  return [proof.beforeWitness, proof.afterWitness].every(witness => !!witness && path.isAbsolute(witness.path) && sha.test(witness.sha256) && typeof witness.content === 'string' && witness.sha256 === createHash('sha256').update(witness.content).digest('hex')) && proof.beforeWitness.sha256 !== proof.afterWitness.sha256;
}

/** A service-owned reviewer, separate from an ended author and its attempt budget. */
export class InspectionVerifier {
  private readonly artifacts: ArtifactStore;
  private readonly active = new Map<string, { promise: Promise<InspectionVerificationRun>; abort: AbortController }>();
  private readonly timeoutMs: number;
  private closing = false;
  private sweeping?: Promise<{ retiredRunIds: string[]; errors: Array<{ runId: string; reason: string }> }>;

  constructor(private readonly options: InspectionVerifierOptions) {
    this.timeoutMs = options.timeoutMs ?? 20 * 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60 * 60_000) throw new Error('Invalid inspection verifier deadline.');
    this.artifacts = new ArtifactStore(path.join(options.app.dataDir, 'workspace-data', 'artifacts'), options.app.device.id);
  }
  private now(): string { return new Date().toISOString(); }
  private get(id: string): InspectionVerificationRun {
    const run = this.options.app.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, id);
    if (!run) throw new Error('Inspection verifier owner is missing.');
    return run;
  }
  private patch(id: string, fields: Partial<InspectionVerificationRun>): InspectionVerificationRun {
    const run = { ...this.get(id), ...fields, updatedAt: this.now() };
    this.options.app.store.set(INSPECTION_VERIFIER_RUNS, run);
    this.options.app.emit('inspection-verifier', run);
    this.options.app.changed();
    return run;
  }
  /** Synchronous ownership fence after awaited read-only process inspection. */
  providerOwnerCurrent(run: InspectionVerificationRun): boolean {
    if (this.closing || this.active.has(run.id) || canonical(this.options.app.store.get(INSPECTION_VERIFIER_RUNS, run.id)) !== canonical(run) || run.ownerDeviceId !== this.options.app.device.id || run.id !== inspectionVerificationKey(run) || run.policySha256 !== inspectionQualityPolicySha256(run.quality)) return false;
    if (!run.chatId) return !run.sessionId && !run.startedAt;
    const chat = this.options.app.store.get<Chat>('chats', run.chatId);
    return !!chat && chat.sessionId === run.sessionId && chat.verificationRunId === run.id && chat.deviceId === run.ownerDeviceId && chat.runtime === 'codex' && !['running', 'waiting'].includes(chat.status) && !this.options.chats.isRunning(chat.id);
  }
  /** Read-only admission for rechecking the same retained author candidate. */
  async providerSettled(run: InspectionVerificationRun): Promise<{ ready: boolean; reason?: string }> {
    const unavailable = (reason: string) => ({ ready: false, reason });
    if (!this.providerOwnerCurrent(run)) return unavailable('The original independent verifier still has an active or changed owner.');
    if (!run.sessionId && !run.chatId && !run.startedAt) return { ready: true };
    if (!run.sessionId || !run.chatId || !run.startedAt) return unavailable('The verifier provider admission is not completely recorded.');
    const chat = this.options.app.store.get<Chat>('chats', run.chatId);
    if (!chat || chat.sessionId !== run.sessionId || chat.verificationRunId !== run.id || chat.deviceId !== run.ownerDeviceId || chat.runtime !== 'codex' || ['running', 'waiting'].includes(chat.status) || this.options.chats.isRunning(chat.id)) return unavailable('The original verifier conversation still has active or unresolved execution.');
    try {
      const session = this.options.app.sessions.record(run.sessionId);
      if (session.verificationRunId !== run.id || session.deviceId !== run.ownerDeviceId || !this.options.app.sessions.owns(session.id) || (session.executionTargetKind ?? 'container') !== run.executionTargetKind) return unavailable('The original verifier session ownership changed.');
      if (run.executionTargetKind === 'container') {
        const archive = this.options.app.sessions.archivedEnvironment(session.id);
        return session.status === 'stopped' && archive?.status === 'removed' && archive.receipt?.version === 2 && archive.receipt.status === 'removed' && archive.receipt.identity.sessionId === session.id && archive.receipt.containerId === archive.containerId
          ? { ready: true } : unavailable('The original container verifier has no positive stopped-execution receipt.');
      }
      const execution = this.options.app.sessions.retainedHostExecution(session.id);
      if (execution.kind !== 'host-macos') return unavailable('The original native verifier source owner changed.');
      if (execution.releasedAt) {
        const inputs = this.options.app.store.get<VerificationInputs>(INPUTS, run.id), workspace = inputs?.retirement?.workspace;
        if (!['succeeded', 'failed', 'canceled'].includes(run.status) || session.status !== 'stopped' || inputs?.transfer.snapshotId !== run.source.snapshotId || inputs.transfer.sourceDigest !== run.source.sha256 || !inputs.retirement?.primarySource || workspace?.id !== run.id || workspace.attemptId !== run.id || workspace.goalId !== run.authority.goalId || workspace.taskId !== run.authority.taskId || workspace.deviceId !== run.ownerDeviceId || workspace.provider !== 'git' || workspace.path !== execution.workdir || execution.workspaceId !== run.id || workspace.path !== path.join(this.options.app.dataDir, 'workspace-data', 'workspaces', run.id, 'repository')) return unavailable('The retired verifier has no exact retained source and ownership receipt.');
      }
      const processes = (await this.options.chats.manager.hostProcesses({ readOnly: true })).filter(process => process.sessionId === session.id || process.sessionId.startsWith(`${session.id}-decision-`));
      if (!this.providerOwnerCurrent(run) || canonical(this.options.app.store.get('chats', chat.id)) !== canonical(chat) || canonical(this.options.app.sessions.record(session.id)) !== canonical(session) || canonical(this.options.app.sessions.retainedHostExecution(session.id)) !== canonical(execution)) return unavailable('The original verifier owner changed during process inspection.');
      const original = processes.filter(process => process.sessionId === session.id && process.cwd === execution.workdir && Date.parse(process.createdAt ?? '') >= Date.parse(run.startedAt!));
      if (!processes.length) {
        const failure = this.options.app.store.get<{ attemptId?: string; agentStarted?: boolean; executionEnded?: boolean }>('chat-turn-failures', chat.id);
        const dispatched = !!chat.threadId || this.options.app.store.events<ChatEvent>('chat', chat.id).some(event => event.value.kind === 'tool' || event.value.role === 'assistant' || event.value.kind === 'status' && event.value.data?.status === 'running');
        if (!dispatched && failure?.attemptId === run.authority.attemptId && failure.agentStarted === false && failure.executionEnded === true) return { ready: true };
      }
      if (!original.length || processes.some(process => process.state !== 'exited' || !!process.pid && !process.termination) || !original.every(process => hostProofMatchesVerifier(process, run, execution.workdir))) return unavailable('The original verifier provider or one of its owned tools has unconfirmed termination.');
      return { ready: true };
    } catch { return unavailable('The original verifier execution evidence is unavailable.'); }
  }
  private assertCurrent(run: InspectionVerificationRun, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const current = this.get(run.id);
    if (this.closing || terminal.has(current.status) || current.ownerDeviceId !== this.options.app.device.id || current.id !== inspectionVerificationKey(current) || !this.options.authorityCurrent(current.authority)) throw new Error('Inspection verifier authority was retired.');
    if (current.purpose === 'goal-final' && this.options.app.store.get<Goal>('goals', current.authority.goalId)?.revision !== current.goalRevision) throw new Error('The final verification goal revision was retired.');
    if (current.acceptanceContract && canonical(this.acceptanceContract(current)) !== canonical(current.acceptanceContract)) throw new Error('The frozen verification acceptance contract changed.');
  }
  private acceptanceContract(input: Pick<VerificationInput, 'authority' | 'purpose' | 'goalRevision' | 'quality'>): InspectionVerificationAcceptance {
    const detail = this.options.app.store.get<AttemptDetail>('factory-attempt-details', input.authority.attemptId);
    if (!detail?.contract || detail.id !== input.authority.attemptId || detail.goalId !== input.authority.goalId || (detail.assignmentGoalRevision ?? detail.goalRevision) !== input.authority.goalRevision) throw new Error('Independent verification requires the original frozen author acceptance contract.');
    const task = structuredClone(detail.contract);
    if (typeof task.title !== 'string' || typeof task.description !== 'string' || !Number.isSafeInteger(task.planRevision) || task.acceptanceCriteria !== undefined && (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.some(item => typeof item !== 'string'))) throw new Error('The original frozen author acceptance contract is invalid.');
    if (input.purpose !== 'goal-final') return { version: 1, task };
    const goal = this.options.app.store.get<Goal>('goals', input.authority.goalId);
    if (!goal || goal.revision !== input.goalRevision || typeof goal.objective !== 'string' || !Array.isArray(goal.criteria) || goal.criteria.some(item => typeof item !== 'string')) throw new Error('Final verification requires the original objective and completion criteria at the current canonical goal revision.');
    const taskContracts = this.options.app.store.list<FactoryTask>('tasks').filter(value => value.goalId === goal.id && value.status === 'completed').sort((left, right) => left.id.localeCompare(right.id)).flatMap(value => {
      const author = value.currentAttemptId ? this.options.app.store.get<Attempt>('attempts', value.currentAttemptId) : undefined;
      const original = author ? this.options.app.store.get<AttemptDetail>('factory-attempt-details', author.id) : undefined;
      const required = original?.contract?.quality;
      if (!required || !required.platforms.some(platform => input.quality.platforms.includes(platform))) return [];
      if (!author || author.taskId !== value.id || author.status !== 'succeeded' || !original?.contract || original.id !== author.id || original.goalId !== goal.id || !original.integration || original.integration.candidateCommit !== original.candidate?.commit) throw new Error('Final verification requires every accepted task’s original frozen contract and integration identity.');
      return [{ taskId: value.id, attemptId: author.id, authorityGeneration: author.generation, assignmentGoalRevision: original.assignmentGoalRevision ?? original.goalRevision, contract: structuredClone(original.contract) }];
    });
    return { version: 1, task, goal: { revision: goal.revision, objective: goal.objective, criteria: structuredClone(goal.criteria), taskContracts } };
  }
  private snapshotManager(id: string): InspectionSnapshotManager {
    return new InspectionSnapshotManager({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'inspection-verification', id), artifacts: this.artifacts });
  }
  private validate(input: VerificationInput): void {
    if (input.purpose !== undefined && !['task', 'goal-final'].includes(input.purpose)) throw new Error('Invalid independent verification purpose.');
    if (input.purpose === 'goal-final' && (!Number.isSafeInteger(input.goalRevision) || input.goalRevision! < 0)) throw new Error('Final goal verification requires its current canonical goal revision.');
    if (input.purpose !== 'goal-final' && input.goalRevision !== undefined) throw new Error('Task verification uses its frozen author assignment revision.');
    if (!sha.test(input.source.sha256) || !input.source.candidateId || !commit.test(input.source.candidateCommit ?? '') || !commit.test(input.source.checkedCommit ?? '')) throw new Error('Verification requires the exact saved candidate and checked commit identities.');
    const frozen: InspectionSourceIdentity = { snapshotId: input.snapshot.id, sha256: input.snapshot.sourceDigest, roots: input.snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) };
    if (input.source.snapshotId !== input.snapshot.id || !inspectionSourceContentMatches(input.source, frozen)) throw new Error('Verification source is not the exact checked snapshot.');
    if (!input.quality.platforms.length || input.quality.workflows.some(workflow => !input.quality.platforms.includes(workflow.platform))) throw new Error('Verification requires an explicit platform and workflow contract.');
  }

  ensure(input: VerificationInput): Promise<InspectionVerificationRun> {
    this.validate(input);
    input.signal?.throwIfAborted();
    const acceptanceContract = this.acceptanceContract(input);
    if (input.acceptanceContract && canonical(input.acceptanceContract) !== canonical(acceptanceContract)) throw new Error('The supplied acceptance projection differs from the original frozen contract.');
    if (input.purpose !== 'goal-final' && canonical(acceptanceContract.task.quality) !== canonical(input.quality)) throw new Error('Task verification quality differs from the original frozen author contract.');
    input = { ...input, acceptanceContract };
    const id = inspectionVerificationKey(input), existing = this.options.app.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, id);
    const live = this.active.get(id);
    if (live) return live.promise;
    const reconcileSetup = existing && this.preDispatchContainerSetupUnknown(existing);
    const reconcileReboot = existing && this.interruptedHostVerifier(existing);
    if (existing && terminal.has(existing.status) && !reconcileSetup && !reconcileReboot) return Promise.resolve(existing);
    if (existing && ['preparing', 'running'].includes(existing.status)) return Promise.resolve(this.patch(id, { status: 'unknown', completedAt: undefined, reason: 'The verifier process lost its service owner. Reconcile its retained conversation and jobs before continuing.' }));
    const target = input.quality.platforms.includes('web') ? 'container' : 'host-macos';
    if (!existing) {
      const at = this.now();
      this.options.app.store.set<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, { id, authority: structuredClone(input.authority), ...(input.purpose === 'goal-final' ? { purpose: input.purpose, goalRevision: input.goalRevision } : {}), acceptanceContract: structuredClone(acceptanceContract), source: structuredClone(input.source), quality: structuredClone(input.quality), policySha256: inspectionQualityPolicySha256(input.quality), ownerDeviceId: this.options.app.device.id, executionTargetKind: target, executionTargetId: target === 'container' ? 'container' : 'mac-host', status: 'queued', createdAt: at, updatedAt: at, deadlineAt: new Date(Date.now() + this.timeoutMs).toISOString() });
    }
    const abort = new AbortController();
    const forward = () => abort.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', forward, { once: true });
    const promise = Promise.resolve().then(async () => {
      if (reconcileSetup && !await this.reconcilePreDispatchContainerSetup(id, input, abort.signal)) return this.get(id);
      if (reconcileReboot && !await this.reconcileInterruptedHostVerifier(id, input, abort.signal)) return this.get(id);
      return this.execute(id, input, abort);
    }).then(() => this.get(id)).finally(() => { input.signal?.removeEventListener('abort', forward); this.active.delete(id); });
    this.active.set(id, { promise, abort });
    return promise;
  }

  private preDispatchContainerSetupUnknown(run: InspectionVerificationRun): boolean {
    return run.status === 'unknown' && run.executionTargetKind === 'container' && !!run.sessionId && run.completedAt === undefined &&
      (run.chatId === undefined && run.startedAt === undefined || !!run.chatId && !!run.startedAt && !!this.unusedReservedChat(run));
  }

  /** ChatController journals the user input before any asynchronous provider admission. */
  private unusedReservedChat(run: InspectionVerificationRun): Chat | undefined {
    const chat = run.chatId && this.options.app.store.get<Chat>('chats', run.chatId);
    if (!chat || chat.sessionId !== run.sessionId || chat.verificationRunId !== run.id || chat.deviceId !== run.ownerDeviceId || chat.runtime !== 'codex' || chat.status !== 'idle' || chat.threadId !== undefined || chat.attemptId !== undefined || chat.error !== undefined || this.options.chats.isRunning(chat.id)) return undefined;
    if (this.options.app.store.events('chat', chat.id).length || this.options.app.store.get('chat-results', chat.id) || this.options.app.store.get('chat-turn-failures', chat.id)) return undefined;
    return chat;
  }

  private interruptedHostVerifier(run: InspectionVerificationRun): boolean {
    return run.status === 'unknown' && run.executionTargetKind === 'host-macos' && !!run.sessionId && !!run.chatId && !!run.startedAt && run.completedAt === undefined;
  }

  /** Positive process teardown ends old execution, not its verification result. */
  private async reconcileInterruptedHostVerifier(id: string, input: VerificationInput, signal: AbortSignal): Promise<boolean> {
    const original = this.get(id), originalChat = this.options.app.store.get<Chat>('chats', original.chatId!);
    const eligible = () => {
      signal.throwIfAborted();
      const run = this.get(id), chat = this.options.app.store.get<Chat>('chats', original.chatId!);
      if (this.closing || !this.interruptedHostVerifier(run) || canonical(run) !== canonical(original) || run.ownerDeviceId !== this.options.app.device.id || run.id !== inspectionVerificationKey(run) || run.policySha256 !== inspectionQualityPolicySha256(run.quality) || !this.options.authorityCurrent(run.authority)) return false;
      if (run.purpose === 'goal-final' && this.options.app.store.get<Goal>('goals', run.authority.goalId)?.revision !== run.goalRevision) return false;
      if (canonical(run.authority) !== canonical(input.authority) || canonical(run.quality) !== canonical(input.quality) || run.source.candidateId !== input.source.candidateId || run.source.candidateCommit !== input.source.candidateCommit || !inspectionSourceContentMatches(run.source, input.source)) return false;
      if (!chat || !originalChat || canonical(chat) !== canonical(originalChat) || chat.verificationRunId !== id || chat.sessionId !== run.sessionId || chat.deviceId !== run.ownerDeviceId || chat.runtime !== 'codex' || ['running', 'waiting'].includes(chat.status) || this.options.chats.isRunning(chat.id)) return false;
      const session = this.options.app.sessions.record(run.sessionId!);
      return session.verificationRunId === id && session.deviceId === run.ownerDeviceId && session.executionTargetKind === 'host-macos' && this.options.app.sessions.owns(session.id)
        && !this.options.app.store.list<Chat>('chats').some(other => other.sessionId === session.id && other.id !== chat.id && ['running', 'waiting'].includes(other.status));
    };
    try {
      if (!eligible() || !this.options.reconcileInspection) return false;
      const execution = this.options.app.sessions.execution(original.sessionId!);
      if (execution.kind !== 'host-macos') return false;
      const processes = (await this.options.chats.manager.hostProcesses()).filter(process => process.sessionId === original.sessionId || process.sessionId.startsWith(`${original.sessionId}-decision-`));
      const originalProcesses = processes.filter(process => process.sessionId === original.sessionId && process.cwd === execution.workdir && Date.parse(process.createdAt ?? '') >= Date.parse(original.startedAt!));
      // Empty inventories and same-boot missing/recycled PIDs are not evidence.
      if (!originalProcesses.length || processes.some(process => process.state !== 'exited') || !originalProcesses.every(process => hostProofMatchesVerifier(process, original, execution.workdir))) return false;
      const bindings = this.options.app.store.events<ChatEvent>('chat', original.chatId!).map(event => event.value).filter(event => event.kind === 'status' && event.data?.status === 'running' && typeof event.data.threadId === 'string').map(event => event.data!.threadId as string);
      const threadIds = new Set([...(originalChat!.threadId ? [originalChat!.threadId] : []), ...bindings]);
      if (threadIds.size !== 1) return false;
      const threadId = [...threadIds][0]!;
      if (!threadId.trim() || threadId.length > 256) return false;
      const saved = this.options.app.store.get<VerificationInputs>(INPUTS, id);
      if (!saved || saved.retiredAt || saved.retirement) return false;
      for (const artifact of [saved.transfer.sourceManifest, ...saved.transfer.sourceArtifacts.map(root => root.manifest)]) {
        if (canonical(await this.artifacts.get(artifact.id)) !== canonical(artifact)) return false;
        await this.artifacts.path(artifact);
      }
      const snapshot = await importInspectionSnapshot({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'inspection-verification', id), artifacts: this.artifacts, sourceArtifacts: saved.transfer.sourceArtifacts, sourceManifest: saved.transfer.sourceManifest, expectedSource: { snapshotId: original.source.snapshotId, sourceDigest: original.source.sha256 }, context: original.authority, signal, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
      if (!eligible() || !inspectionSourceContentMatches(original.source, { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) })) return false;
      await this.assertExecutionSource(original.sessionId!, snapshot, signal);
      if (!eligible() || !await this.options.reconcileInspection(original, signal) || !eligible()) return false;
      // Ordinary stop hooks check every original provider and retain extra-root
      // files. They do not claim old actions or the old verifier turn succeeded.
      await this.options.app.sessions.stop(original.sessionId!);
      if (!eligible() || this.options.app.sessions.record(original.sessionId!).status !== 'stopped') return false;
      await this.assertExecutionSource(original.sessionId!, snapshot, signal);
      const supervised = originalProcesses.some(process => process.termination?.kind === 'supervised-termination');
      this.options.app.store.transaction(() => {
        if (!eligible()) throw new Error('The host continuation owner changed.');
        this.options.app.store.append('inspection-verifier-reconciliation', id, { action: supervised ? 'host-supervised-continuation' : 'host-reboot-continuation', previous: original, chat: originalChat, processes: originalProcesses, threadId, source: original.source, at: this.now() });
        this.options.app.store.set(INPUTS, { ...saved, snapshot });
        this.options.app.store.set('chats', { ...originalChat!, threadId });
        this.patch(id, { status: 'waiting', reason: supervised ? 'The original host provider and its owned tools confirmed termination. Continuing its retained independent verification conversation with fresh inspection sessions.' : 'The original host provider ended during a confirmed reboot. Continuing its retained independent verification conversation with fresh inspection sessions.', completedAt: undefined });
      });
      return true;
    } catch {
      // Any changed source/authority, missing receipt or uncertain backend keeps
      // the old unknown result and cannot admit another provider turn.
      return false;
    }
  }

  /** Only a removed original container and no provider dispatch permit setup replay. */
  private async reconcilePreDispatchContainerSetup(id: string, input: VerificationInput, signal: AbortSignal): Promise<boolean> {
    const original = this.get(id);
    const eligible = () => {
      signal.throwIfAborted();
      const run = this.get(id);
      if (this.closing || !this.preDispatchContainerSetupUnknown(run) || canonical(run) !== canonical(original) || run.ownerDeviceId !== this.options.app.device.id || run.id !== inspectionVerificationKey(run) || run.policySha256 !== inspectionQualityPolicySha256(run.quality) || !this.options.authorityCurrent(run.authority)) return false;
      if (run.purpose === 'goal-final' && this.options.app.store.get<Goal>('goals', run.authority.goalId)?.revision !== run.goalRevision) return false;
      if (canonical(run.authority) !== canonical(input.authority) || canonical(run.quality) !== canonical(input.quality) || run.source.candidateId !== input.source.candidateId || run.source.candidateCommit !== input.source.candidateCommit || !inspectionSourceContentMatches(run.source, input.source)) return false;
      const session = this.options.app.sessions.record(run.sessionId!);
      const archive = this.options.app.sessions.archivedEnvironment(session.id);
      const unused = this.unusedReservedChat(run);
      return (session.executionTargetKind === undefined ? 'container' : session.executionTargetKind) === 'container' && session.deviceId === run.ownerDeviceId && session.verificationRunId === run.id && session.status === 'stopped' && this.options.app.sessions.owns(session.id)
        && !this.options.app.store.list<Chat>('chats').some(chat => chat.sessionId === session.id && chat.id !== unused?.id)
        && archive?.status === 'removed' && archive.id === session.id && /^[a-f0-9]{64}$/.test(archive.containerId)
        && archive.receipt?.version === 2 && archive.receipt.status === 'removed' && archive.receipt.containerId === archive.containerId && archive.receipt.identity.sessionId === session.id
        && archive.receipt.identity.name === archive.name && archive.receipt.identity.sessionName === session.name
        && (session.containerId === undefined || session.containerId === archive.containerId || session.containerId === archive.name);
    };
    try {
      if (!eligible() || !this.options.app.sessions.canRetireEnvironment(original.sessionId!)) return false;
      return await this.options.app.sessions.withStoppedInputs(original.sessionId!, async () => {
        if (!eligible()) return false;
        if (original.chatId && (!this.options.reconcileInspection || !await this.options.reconcileInspection(original, signal) || !eligible())) return false;
        const saved = this.options.app.store.get<VerificationInputs>(INPUTS, id);
        if (!saved || saved.retiredAt || saved.retirement) return false;
        for (const artifact of [saved.transfer.sourceManifest, ...saved.transfer.sourceArtifacts.map(root => root.manifest)]) {
          if (canonical(await this.artifacts.get(artifact.id)) !== canonical(artifact)) return false;
          await this.artifacts.path(artifact);
        }
        const snapshot = await importInspectionSnapshot({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'inspection-verification', id), artifacts: this.artifacts, sourceArtifacts: saved.transfer.sourceArtifacts, sourceManifest: saved.transfer.sourceManifest, expectedSource: { snapshotId: original.source.snapshotId, sourceDigest: original.source.sha256 }, context: original.authority, signal, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
        if (!eligible() || !inspectionSourceContentMatches(original.source, { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) })) return false;
        this.options.app.store.transaction(() => {
          if (!eligible()) throw new Error('The stopped setup reconciliation owner changed.');
          this.options.app.store.append('inspection-verifier-reconciliation', id, { action: original.chatId ? 'unused-container-verifier-chat' : 'stopped-container-setup', previous: original, ...(original.chatId ? { chat: this.unusedReservedChat(original), providerAdmission: 'no-journaled-turn', archiveReceipt: this.options.app.sessions.archivedEnvironment(original.sessionId!)!.receipt } : {}), sessionId: original.sessionId, source: original.source, archiveContainerId: this.options.app.sessions.archivedEnvironment(original.sessionId!)!.containerId, at: this.now() });
          this.options.app.store.set(INPUTS, { ...saved, snapshot });
          this.patch(id, { status: 'waiting', reason: 'The original container was confirmed removed before any verifier turn started. Retrying the retained independent setup.', completedAt: undefined });
        });
        return true;
      });
    } catch {
      // Missing archives, changed authority/source or a busy owner retain the
      // original unknown record. They cannot authorize another provider turn.
      return false;
    }
  }

  private async retain(id: string, input: VerificationInput, signal: AbortSignal): Promise<InspectionSnapshot> {
    let saved = this.options.app.store.get<VerificationInputs>(INPUTS, id);
    if (!saved) {
      const transfer = await exportInspectionSnapshot({ snapshot: input.snapshot, artifacts: this.artifacts, context: input.authority, signal, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
      saved = { id, project: structuredClone(input.project), transfer };
      this.options.app.store.set(INPUTS, saved);
      for (const artifact of [transfer.sourceManifest, ...transfer.sourceArtifacts.map(source => source.manifest)]) this.options.app.store.set('factory-artifacts', artifact);
    }
    const snapshot = await importInspectionSnapshot({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'inspection-verification', id), artifacts: this.artifacts, sourceArtifacts: saved.transfer.sourceArtifacts, sourceManifest: saved.transfer.sourceManifest, expectedSource: { snapshotId: this.get(id).source.snapshotId, sourceDigest: this.get(id).source.sha256 }, context: this.get(id).authority, signal, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
    this.options.app.store.set(INPUTS, { ...saved, snapshot });
    return snapshot;
  }

  private async selectedTarget(run: InspectionVerificationRun, project: Project): Promise<{ target?: ExecutionTargetAdvertisement; reason?: string }> {
    const targets = await this.options.readiness();
    const web = run.quality.platforms.includes('web');
    // A new native-only verifier can author its review on Linux and use the same
    // paired Mac tools as a container author. Retained execution owners never move.
    const kinds = run.sessionId ? [run.executionTargetKind] : web ? ['container'] : ['host-macos', 'container'];
    const target = kinds.flatMap(kind => targets.filter(target => {
      const required: ExecutionCapability[] = kind === 'container' ? ['linux-shell', ...(web ? ['chromium-inspection' as const] : [])] : ['mac-shell'];
      return target.kind === kind && target.protocolVersion === 1 && (!target.runtimes || target.runtimes.includes('codex')) && required.every(kind => target.capabilities.some(capability => capability.kind === kind && capability.readiness === 'ready')) && target.readiness === 'ready'
        && (!run.sessionId || target.id === run.executionTargetId);
    }))[0];
    const reasons: string[] = [];
    if (!target) reasons.push(`The ${web ? 'private browser/container' : run.sessionId ? run.executionTargetKind === 'container' ? 'retained container Codex' : 'retained Mac Codex' : 'Mac or private container Codex'} verification target is not ready.`);
    const nativePlatforms = run.quality.platforms.filter((platform): platform is 'macos' | 'ios-simulator' => platform !== 'web');
    const nativeReady = (target: ExecutionTargetAdvertisement, capability: ExecutionCapability) => target.kind === 'host-macos' && target.protocolVersion === 1 && target.readiness === 'ready'
      && ['apple-compilation', capability].every(kind => target.capabilities.some(item => item.kind === kind && item.readiness === 'ready'));
    const missingLocally = nativePlatforms.filter(platform => !targets.some(target => nativeReady(target, platform === 'macos' ? 'macos-app-inspection' : 'ios-simulator-inspection')));
    const delegated = missingLocally.length ? await this.options.delegatedReadiness?.(project.sourceProjectId || project.id) ?? [] : [];
    for (const platform of missingLocally) {
      const capability = platform === 'macos' ? 'macos-app-inspection' : 'ios-simulator-inspection';
      if (delegated.some(owner => (this.options.allowNativeProfileSetup || owner.profiles.some(profile => profile.platform === platform)) && owner.executionTargets?.some(target => nativeReady(target, capability)))) continue;
      reasons.push(targets.flatMap(target => target.capabilities).find(item => item.kind === capability)?.reason || `Native ${platform === 'macos' ? 'Mac' : 'iPhone Simulator'} verification needs a ready local or paired Mac with Apple builds, app testing and this project's isolated testing profile.`);
    }
    return reasons.length ? { reason: reasons.join(' ') } : { target };
  }

  private async execute(id: string, input: VerificationInput, abort: AbortController): Promise<InspectionVerificationRun> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dispatched = false;
    let providerEnded = false;
    let snapshot: InspectionSnapshot | undefined;
    try {
      this.assertCurrent(this.get(id), abort.signal);
      // Source retention needs no provider slot; own C before any ownership,
      // capacity or readiness wait can outlive the caller's temporary snapshot.
      snapshot = await this.retain(id, input, abort.signal);
      this.assertCurrent(this.get(id), abort.signal);
      // A stronger contract gets a new owner, while any older owner still keeps
      // its original authority, conversation, evidence and uncertain effects.
      const siblings = this.options.app.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS).filter(run => run.id !== id && (!run.acceptanceContract || !terminal.has(run.status)) && canonical(run.authority) === canonical(input.authority) && inspectionSourceContentMatches(run.source, input.source));
      for (const sibling of siblings) {
        const settled = await this.providerSettled(sibling);
        this.assertCurrent(this.get(id), abort.signal);
        if (!settled.ready || (sibling.sessionId || sibling.chatId || sibling.startedAt) && (!this.options.reconcileInspection || !await this.options.reconcileInspection(sibling, abort.signal))) return this.patch(id, { status: 'waiting', reason: `An earlier verification owner must finish reconciliation before this full-contract review: ${settled.reason || 'Its original inspection effects are not confirmed stopped.'}` });
        this.assertCurrent(this.get(id), abort.signal);
        if (canonical(this.get(sibling.id)) !== canonical(sibling) || !this.providerOwnerCurrent(sibling)) return this.patch(id, { status: 'waiting', reason: 'An earlier verification owner changed during acceptance migration. Its execution remains retained.' });
      }
      const claimed = this.options.app.store.transaction(() => {
        const current = this.get(id);
        if (!['queued', 'waiting'].includes(current.status)) return false;
        const goal=this.options.app.store.get<Goal>('goals',current.authority.goalId);
        if(goalAgentCount(this.options.app.store,current.authority.goalId,[`verifier:${id}`])>=Math.max(1,goal?.concurrency??1)){this.patch(id,{status:'waiting',reason:'The goal’s agent limit is occupied; continue verification of this same saved source after a slot becomes available.'});return false;}
        this.patch(id, { status: 'preparing', reason: undefined });
        return true;
      });
      if (!claimed) return this.get(id);
      const selected = await abortable(this.selectedTarget(this.get(id), input.project), abort.signal);
      this.assertCurrent(this.get(id), abort.signal);
      if (!selected.target) return this.patch(id, { status: 'waiting', reason: selected.reason });
      const run = this.patch(id, { status: 'preparing', executionTargetKind: selected.target.kind, executionTargetId: selected.target.id, deadlineAt: new Date(Date.now() + this.timeoutMs).toISOString(), reason: undefined });
      timer = setTimeout(() => abort.abort(new Error('Inspection verifier exceeded its bounded deadline.')), this.timeoutMs);
      const assertCurrent = () => this.assertCurrent(this.get(id), abort.signal);
      const onSession = (session: Session) => {
        assertCurrent();
        // Preparation/restart may advance runtime state while callers still hold
        // their initial starting/stopped object. Attach ownership to the live
        // record rather than rewinding readiness, roots or the runtime phase.
        const current = this.options.app.sessions.record(session.id);
        this.options.app.store.set('sessions', { ...current, verificationRunId: id });
        this.patch(id, { sessionId: session.id });
      };
      const preparation = { run, snapshot, project: input.project, signal: abort.signal, assertCurrent, onSession };
      let session: Session;
      if (run.sessionId) {
        session = this.options.app.sessions.record(run.sessionId);
        if (session.verificationRunId !== id || session.deviceId !== run.ownerDeviceId || !this.options.app.sessions.owns(session.id) || (session.executionTargetKind === undefined ? 'container' : session.executionTargetKind) !== run.executionTargetKind) throw Object.assign(new Error(setupOwnerChangedReason), { code: 'HOST_PROCESS_UNKNOWN' });
        if (session.status === 'unknown') throw Object.assign(new Error('The independent setup execution outcome is unknown.'), { code: 'HOST_PROCESS_UNKNOWN' });
        if (session.status === 'stopped') await this.options.app.sessions.restart(session.id);
        await abortable(this.options.app.sessions.waitExecutionReady(session.id, this.timeoutMs), abort.signal);
        assertCurrent();
        if (run.executionTargetKind === 'container' && !this.options.prepareExecution) await this.restoreContainerSource(preparation, session.id);
        else await this.assertExecutionSource(session.id, snapshot, abort.signal);
      } else session = await (this.options.prepareExecution ?? (preparation => this.prepareExecution(preparation)))(preparation);
      onSession(session);
      await abortable(this.options.app.sessions.waitExecutionReady(session.id, this.timeoutMs), abort.signal);
      assertCurrent();
      await this.snapshotManager(id).verify(snapshot, abort.signal);
      const goal = this.options.app.store.get<Goal>('goals', run.authority.goalId);
      const chat = run.chatId ? this.options.app.store.get<Chat>('chats', run.chatId) : this.options.chats.create({ sessionId: session.id, runtime: 'codex', approvalMode: goal?.approvalMode ?? input.project.approvalMode, title: `Verify ${run.source.checkedCommit!.slice(0, 12)}`, verificationRunId: id });
      if (!chat || chat.sessionId !== session.id || chat.verificationRunId !== id || chat.deviceId !== run.ownerDeviceId || chat.runtime !== 'codex' || this.options.chats.isRunning(chat.id)) throw Object.assign(new Error(setupOwnerChangedReason), { code: 'HOST_PROCESS_UNKNOWN' });
      this.patch(id, { status: 'running', chatId: chat.id, startedAt: run.startedAt ?? this.now() });
      const stop = () => { void this.options.chats.interrupt(chat.id).catch(() => {}); };
      abort.signal.addEventListener('abort', stop, { once: true });
      try {
        assertCurrent();
        const context = await this.options.quality.context({ authority: run.authority, source: run.source, referenceIds: run.quality.referenceIds });
        assertCurrent();
        const continuation = run.chatId ? 'Continue this same independent verification conversation after service-owned reconciliation. An interrupted prior turn is not a success. Its unknown actions remain unknown: never repeat their old request IDs or use stale observation/element IDs. All original inspection sessions were confirmed stopped before this continuation. Start fresh owned inspection sessions, inspect their actual state, and complete the full frozen workflow and visual review contract for this same exact source. Do not resume or change the ended author.\n\n' : '';
        const turn = this.options.chats.run(chat.id, continuation + this.prompt(this.get(id), context), { attemptId: run.authority.attemptId, verificationRunId: id, autonomous: true, systemInstructions: factoryQualityInstructions('evaluator') });
        // ChatController's synchronous guards precede its durable user event and
        // any provider admission. A guard rejection did not dispatch a model.
        dispatched = true;
        await abortable(turn, abort.signal);
        providerEnded = true;
      } finally { abort.signal.removeEventListener('abort', stop); }
      assertCurrent();
      await this.snapshotManager(id).verify(snapshot, abort.signal);
      const checked = await this.options.quality.check({ authority: run.authority, quality: run.quality, source: run.source, candidateCommit: run.source.candidateCommit!, checkedCommit: run.source.checkedCommit, verification: { runId: id, chatId: chat.id, acceptanceContractSha256: inspectionAcceptanceContractSha256(run.acceptanceContract!) } });
      assertCurrent();
      const setup=!checked.passed&&checked.recovery?this.options.pendingNativeSetup?.(run.authority,run.source):undefined;
      if(setup&&setup.status!=='rejected')return this.patch(id,{status:'waiting',reason:`Native fixture setup is ${setup.status}: ${setup.reason} Continue this same verifier conversation after setup.`,completedAt:undefined});
      return this.patch(id, { status: checked.passed ? 'succeeded' : 'failed', reason: checked.passed ? undefined : checked.output, completedAt: this.now() });
    } catch (error) {
      const failure = error as Error & { agentStarted?: boolean; executionEnded?: boolean; code?: string };
      const current = this.get(id);
      if (current.status === 'unknown') return current;
      if (!this.options.authorityCurrent(current.authority) || current.purpose === 'goal-final' && this.options.app.store.get<Goal>('goals', current.authority.goalId)?.revision !== current.goalRevision) return this.patch(id, { status: 'canceled', reason: failure.message, completedAt: this.now() });
      const uncertain = ['HOST_PROCESS_UNKNOWN', 'HOST_PROCESS_ACTIVE', 'PROCESS_TEARDOWN_UNCONFIRMED'].includes(failure.code ?? '') || dispatched && !providerEnded && failure.agentStarted !== false && failure.executionEnded !== true;
      const status = uncertain ? 'unknown' : abort.signal.aborted ? 'canceled' : !dispatched || failure.agentStarted === false ? 'waiting' : 'failed';
      return this.patch(id, { status, reason: failure.message, completedAt: ['failed', 'canceled'].includes(status) ? this.now() : undefined });
    } finally {
      if (timer) clearTimeout(timer);
      const run = this.get(id);
      // Unknown owners keep their source and session. Terminal chat/evidence stays
      // durable; a confirmed stop lets ordinary ephemeral cleanup retire execution.
      if (run.sessionId && !['unknown', 'waiting'].includes(run.status)) {
        try { await this.options.app.sessions.stop(run.sessionId); }
        catch (error) { this.patch(id, { status: 'unknown', completedAt: undefined, reason: `Verifier termination is unconfirmed: ${(error as Error).message}` }); }
      }
    }
  }

  private prompt(run: InspectionVerificationRun, context: string): string {
    const contract = verificationContractContent(run.acceptanceContract!);
    const acceptance = contract.totalCharacters <= INLINE_VERIFICATION_CONTRACT_CHARACTERS ? `Frozen authoritative acceptance contract (complete): ${contract.content}` : `Frozen authoritative acceptance contract manifest: ${JSON.stringify({ contractSha256: contract.contractSha256, totalCharacters: contract.totalCharacters })}. The complete original requirements are retained without summarizing or dropping criteria. Before testing, read every character using factory_verification_contract with offset 0 and maxCharacters 16000, then continue at each nextOffset until totalCharacters. Factory requires this conversation's full original contract reads before accepting its quality report.`;
    return [
      'Independently verify the exact saved application source below. The author has finished; you are a separate verifier and must not resume, repair, commit or integrate its source. Native builds and app start/restart must use the Factory inspection tools bound to the immutable checked snapshot. For web, you may use shell to launch the declared local fixture/development server from this owned verification workspace; operate and inspect its browser only through Factory tools. Use shell to inspect source and discover declared build/reference paths. Preserve the checked source bytes and keep generated files out of source roots.',
      `Verification run: ${run.id}\nChecked source: ${JSON.stringify(run.source)}\nFrozen quality requirements: ${JSON.stringify(run.quality)}`,
      acceptance,
      'Treat every original acceptance criterion, task description and final-goal completion criterion as required. Workflow IDs only organize evidence; a passed interaction does not establish the whole criterion. For restoration or persistence of message content, use factory_assert valueEquals on the entire observed editable value, including every line. When a required read-only field such as From is exposed as its label rather than a value, select it with labelIncludes and use labelEquals on the complete observed label, including its field prefix and exact address. labelEquals and valueEquals compare actual observed strings; an identifier or a missing value cannot replace them. Verify every exact From/To/subject/body field required by the contract. valueIncludes, matching the first line, an empty standalone draft, or a successful click cannot establish whole-message restoration. Exercise the required populated Reply flow, software keyboard, first/middle/last lines, close/reopen and confirmed restart when specified; retain the exact distinctive multiline expected text and compare the full restored body after each required transition. Never send mail unless the original contract explicitly requires and authorizes it. If the observation cannot expose an entire required field string, report that acceptance evidence as blocked instead of claiming it passed.',
      'When an original criterion requires author history, pre-edit reproduction, stop/edit/check/new-source order, unchanged files or the final author badge/chat, use factory_verification_history and read the original attempt/check/result records, assertions and base-to-candidate diffs through factory_verification_evidence. View original pre-edit/final screenshot pixels with factory_verification_image. Continue bounded reads until every relevant original record is complete. These are historical context with their original source/authority; they never establish current workflow acceptance and their IDs cannot replace this verifier own current-source screenshots/actions/assertions. Missing original bytes or unresolved chronology remains an explicit verification gap.',
      'Use factory_capabilities. For native platforms select the configured fixture profile, factory_native_build, poll its job, then factory_native_start. For web start the app from this private verification workspace and use factory_browser_start. View original screenshot image tool responses, inspect required reference/design-system files with factory_reference, execute every required workflow, re-observe and use factory_assert on resulting state. Distinguish screenshot evidence IDs from observation/action IDs.',
      'Submit a version 1 QualityEvidenceReport through factory_quality_submit using the EXACT Checked source object. Each passed workflow requires before/action/after plus assertionEvidenceId. Review hierarchy, spacing, clipping, typography, controls and states against the inspected reference; record serious defects honestly. Missing capabilities or failed interactions are blocked/failed evidence, never a success claim. Finish by stopping the owned app/browser sessions. Do not ask the user or start another author attempt.',
      context,
    ].join('\n\n');
  }

  /** The broker uses this instead of capturing the mutable verifier/author worktree. */
  async verificationSource(context: AgentToolBridgeContext): Promise<VerificationSource | undefined> {
    const id = context.chat.verificationRunId;
    if (!id) return undefined;
    const run = this.get(id);
    if (run.status !== 'running' || run.chatId !== context.chat.id || run.sessionId !== context.session.id || context.session.verificationRunId !== id || context.chat.deviceId !== run.ownerDeviceId || context.attemptId !== run.authority.attemptId || context.verificationRunId !== id) throw new Error('This conversation does not own the independent verifier authority.');
    this.assertCurrent(run, context.signal);
    const saved = this.options.app.store.get<VerificationInputs>(INPUTS, id);
    if (!saved?.snapshot || saved.snapshot.id !== run.source.snapshotId || !inspectionSourceContentMatches(run.source, { snapshotId: saved.snapshot.id, sha256: saved.snapshot.sourceDigest, roots: saved.snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) })) throw new Error('The exact verifier source binding is unavailable.');
    await this.snapshotManager(id).verify(saved.snapshot, context.signal);
    this.assertCurrent(this.get(id), context.signal);
    return { id: saved.snapshot.id, snapshot: saved.snapshot, source: structuredClone(run.source), run };
  }

  /** Trusted native-build seam: only an active registered verifier copy is owned. */
  async verifySnapshot(snapshot: InspectionSnapshot, signal?: AbortSignal): Promise<void> {
    const saved = this.options.app.store.list<VerificationInputs>(INPUTS).find(record => record.snapshot?.path === snapshot.path);
    if (!saved?.snapshot || canonical(saved.snapshot) !== canonical(snapshot)) throw new Error('This native snapshot is not registered to an independent verifier.');
    const run = this.get(saved.id);
    this.assertCurrent(run, signal);
    if (snapshot.id !== run.source.snapshotId || snapshot.sourceDigest !== run.source.sha256) throw new Error('The native verifier snapshot changed its checked source identity.');
    await this.snapshotManager(run.id).verify(snapshot, signal);
    this.assertCurrent(this.get(run.id), signal);
  }

  /** Retire only reconstructible, known-ended copies; chats/evidence/CAS stay durable. */
  sweepCompleted(canRetireInspection: (run: InspectionVerificationRun) => boolean): Promise<{ retiredRunIds: string[]; errors: Array<{ runId: string; reason: string }> }> {
    if (this.closing) return Promise.resolve({ retiredRunIds: [], errors: [] });
    if (this.sweeping) return this.sweeping;
    const operation = this.sweepCompletedOwned(canRetireInspection).finally(() => { this.sweeping = undefined; });
    this.sweeping = operation;
    return operation;
  }
  private async sweepCompletedOwned(canRetireInspection: (run: InspectionVerificationRun) => boolean): Promise<{ retiredRunIds: string[]; errors: Array<{ runId: string; reason: string }> }> {
    const result: { retiredRunIds: string[]; errors: Array<{ runId: string; reason: string }> } = { retiredRunIds: [], errors: [] };
    for (const run of this.options.app.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)) {
      const ended = () => {
        const current = this.get(run.id);
        return !this.active.has(run.id) && ['succeeded', 'failed', 'canceled'].includes(current.status) && current.ownerDeviceId === this.options.app.device.id && current.id === inspectionVerificationKey(current) && canRetireInspection(current);
      };
      if (!run.sessionId || !ended()) continue;
      const inputs = this.options.app.store.get<VerificationInputs>(INPUTS, run.id);
      if (!inputs || inputs.retiredAt) continue;
      try {
        const session = this.options.app.sessions.record(run.sessionId);
        if (session.verificationRunId !== run.id || session.status !== 'stopped' || !this.options.app.sessions.owns(session.id) || (run.chatId && this.options.chats.isRunning(run.chatId))) continue;
        await this.options.app.sessions.withStoppedInputs(session.id, async () => {
          const assertRetirable = () => {
            const session = this.options.app.sessions.record(run.sessionId!);
            if (!ended() || session.status !== 'stopped' || session.verificationRunId !== run.id || (run.chatId && this.options.chats.isRunning(run.chatId))) throw new Error('Verifier cleanup lost its confirmed terminal owner.');
          };
          assertRetirable();
          const providers = run.executionTargetKind === 'host-macos' ? (await this.options.chats.manager.hostProcesses()).filter(process => process.sessionId === session.id || process.sessionId.startsWith(`${session.id}-decision-`)) : [];
          if (providers.some(process => process.state !== 'exited')) throw new Error('The host verifier provider still has active or unknown ownership.');
          for (const artifact of [inputs.transfer.sourceManifest, ...inputs.transfer.sourceArtifacts.map(root => root.manifest)]) {
            if (canonical(await this.artifacts.get(artifact.id)) !== canonical(artifact)) throw new Error('The durable verifier source manifest changed.');
            await this.artifacts.path(artifact);
          }
          const frozen = await importInspectionSnapshot({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'inspection-verification', run.id), artifacts: this.artifacts, sourceArtifacts: inputs.transfer.sourceArtifacts, sourceManifest: inputs.transfer.sourceManifest, expectedSource: { snapshotId: run.source.snapshotId, sourceDigest: run.source.sha256 }, context: run.authority, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
          const workspaces = new WorkspaceManager({ dataDir: path.join(this.options.app.dataDir, 'workspace-data'), deviceId: this.options.app.device.id });
          const workspaceDirectory = path.join(this.options.app.dataDir, 'workspace-data', 'workspaces', run.id);
          const cacheIdentity = `${run.id}-inputs`;
          const cacheDirectory = path.join(this.options.app.dataDir, 'workspace-data', 'working-directories', cacheIdentity);
          const validateWorkspace = (workspace: WorkspaceRecord) => {
            if (workspace.id !== run.id || workspace.attemptId !== run.id || workspace.goalId !== run.authority.goalId || workspace.taskId !== run.authority.taskId || workspace.deviceId !== run.ownerDeviceId || workspace.provider !== 'git' || workspace.path !== path.join(workspaceDirectory, 'repository')) throw new Error('The terminal verifier workspace identity changed.');
          };
          let retirement = inputs.retirement;
          if (!retirement) {
            let workspace: WorkspaceRecord | undefined, primarySource: InspectionSnapshotTransfer | undefined;
            const workspaceIdentity = await ownedDirectoryIdentity(workspaceDirectory);
            if (workspaceIdentity) {
              // Missing metadata in an existing tree is not proof of prior cleanup.
              workspace = await workspaces.workspace(run.id);
              validateWorkspace(workspace);
              await existingOwnedDirectory(workspace.path);
              // Preserve any verifier-created source as well as the original C/M.
              // Build caches exceeding the bounded source inventory retain this
              // workspace instead of discarding files whose outcome is uncertain.
              const manager = new InspectionSnapshotManager({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'verification-retirement', run.id), artifacts: this.artifacts });
              let preserved: InspectionSnapshot | undefined;
              try {
                preserved = await manager.create({ roots: [{ id: frozen.roots[0]!.id, name: frozen.roots[0]!.name, path: workspace.path, kind: 'git' }], includeAll: true, context: run.authority, maxBytes: INSPECTION_SOURCE_MAX_BYTES });
                primarySource = await exportInspectionSnapshot({ snapshot: preserved, artifacts: this.artifacts, context: run.authority, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
                for (const artifact of [primarySource.sourceManifest, ...primarySource.sourceArtifacts.map(source => source.manifest)]) this.options.app.store.set('factory-artifacts', artifact);
              } finally { if (preserved) await manager.remove(preserved); }
            }
            const cachedIdentity = await ownedDirectoryIdentity(cacheDirectory);
            let cacheJournalSha256: string | undefined;
            if (cachedIdentity) {
              const sources = await this.options.app.sessions.directoryManager.sourceSnapshots(cacheIdentity);
              if (sources.length !== frozen.roots.length - 1 || sources.some(source => !frozen.roots.slice(1).some(root => source.id === root.id && source.name === root.name))) throw new Error('The verifier input-cache root identity changed.');
              cacheJournalSha256 = digest(sources);
            }
            await assertDirectoryIdentity(workspaceDirectory, workspaceIdentity);
            await assertDirectoryIdentity(cacheDirectory, cachedIdentity);
            assertRetirable();
            // Intent is durable before any removal. A crash after an ownership
            // marker is deleted can resume only this exact already-proven tree.
            retirement = { startedAt: this.now(), workspace, workspaceDirectory: workspaceIdentity, primarySource, ...(cachedIdentity ? { cacheIdentity, cacheDirectory: cachedIdentity, cacheJournalSha256 } : {}) };
            this.options.app.store.set(INPUTS, { ...inputs, retirement });
          }
          await assertDirectoryIdentity(workspaceDirectory, retirement.workspaceDirectory);
          await assertDirectoryIdentity(cacheDirectory, retirement.cacheDirectory);
          if (retirement.workspace) {
            validateWorkspace(retirement.workspace);
            if (!retirement.primarySource) throw new Error('The verifier workspace has no durable source preservation.');
            for (const artifact of [retirement.primarySource.sourceManifest, ...retirement.primarySource.sourceArtifacts.map(root => root.manifest)]) {
              if (canonical(await this.artifacts.get(artifact.id)) !== canonical(artifact)) throw new Error('The retired verifier source manifest changed.');
              await this.artifacts.path(artifact);
            }
          }
          assertRetirable();
          if (run.executionTargetKind === 'host-macos') {
            if (retirement.workspace) for (const providerSession of new Set([session.id, ...providers.map(process => process.sessionId)])) {
              assertRetirable();
              await this.options.chats.manager.retireHostSession(providerSession, retirement.workspace.path);
            }
            await this.options.app.sessions.disposeHostWorkspace(session.id);
          }
          if (retirement.workspace && await existingOwnedDirectory(workspaceDirectory)) {
            try {
              const workspace = await workspaces.workspace(run.id);
              if (canonical(workspace) !== canonical(retirement.workspace)) throw new Error('The retiring verifier workspace identity changed.');
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            await assertDirectoryIdentity(workspaceDirectory, retirement.workspaceDirectory);
            assertRetirable();
            await removeScratch(workspaceDirectory);
          }
          if (retirement.cacheIdentity !== undefined) {
            if (retirement.cacheIdentity !== cacheIdentity) throw new Error('The retiring verifier cache identity changed.');
            if (await existingOwnedDirectory(cacheDirectory)) {
              try {
                await lstat(path.join(cacheDirectory, 'snapshots.json'));
                if (digest(await this.options.app.sessions.directoryManager.sourceSnapshots(cacheIdentity)) !== retirement.cacheJournalSha256) throw new Error('The retiring verifier cache journal changed.');
              } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
              await assertDirectoryIdentity(cacheDirectory, retirement.cacheDirectory);
              assertRetirable(); await removeScratch(cacheDirectory);
            }
          }
          assertRetirable();
          await this.snapshotManager(run.id).remove(frozen);
          this.options.app.store.set(INPUTS, { ...inputs, retirement, snapshot: undefined, retiredAt: this.now() });
          result.retiredRunIds.push(run.id);
        });
      } catch (error) { result.errors.push({ runId: run.id, reason: (error as Error).message }); }
    }
    return result;
  }

  private async prepareExecution(input: VerificationPreparation): Promise<Session> {
    input.assertCurrent();
    const primary = input.snapshot.roots[0]!;
    const workspaceRoot = path.join(this.options.app.dataDir, 'workspace-data', 'workspaces', input.run.id);
    const repository = path.join(workspaceRoot, 'repository');
    await ownedDirectory(path.dirname(workspaceRoot));
    // Exclusive identity: an interrupted, unpublished preparation is not reseeded.
    await mkdir(workspaceRoot, { mode: 0o700 });
    await cp(primary.path, repository, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    const workspace: WorkspaceRecord = { id: input.run.id, goalId: input.run.authority.goalId, taskId: input.run.authority.taskId, attemptId: input.run.id, deviceId: this.options.app.device.id, projectPath: primary.path, path: repository, provider: 'git', baseCommit: primary.commit, branch: 'HEAD', executionTargetKind: input.run.executionTargetKind, createdAt: this.now() };
    await writeAtomic(path.join(workspaceRoot, 'workspace.json'), workspace);
    const configured = this.options.app.store.get<Project>('projects', input.project.sourceProjectId ?? input.project.id) ?? input.project;
    const goal = this.options.app.store.get<Goal>('goals', input.run.authority.goalId);
    const project: Project = { ...input.project, id: `workspace-${input.run.id}`, path: repository, name: `${input.project.name} · verification`, runtime: 'codex', approvalMode: goal?.approvalMode ?? configured.approvalMode, rules: configured.rules, deviceId: this.options.app.device.id, internal: true, sourceProjectId: input.project.sourceProjectId ?? input.project.id, workingDirectories: input.snapshot.roots.slice(1).map(root => ({ id: root.id, name: root.name, path: root.path })) };
    this.options.app.store.set('projects', project);
    const sources = await this.options.app.sessions.workingDirectorySources(`${input.run.id}-inputs`, project);
    input.assertCurrent();
    const name = `v-${input.run.id.slice(-18)}`;
    if (input.run.executionTargetKind === 'host-macos') {
      const session = await this.options.app.sessions.createHost(project, name, { workspace, workingDirectorySources: sources, executionTargetId: input.run.executionTargetId, assertCurrent: input.assertCurrent, onCreated: input.onSession });
      // Git bundles preserve executability, but other permission bits and empty
      // folders belong to the checked manifest too. Restore that exact worktree
      // after generic multi-root preparation, retaining its owned Git baseline.
      const current = this.options.app.sessions.record(session.id);
      for (const [index, root] of input.snapshot.roots.entries()) {
        if (index === 0) continue;
        const target = current.workingDirectories?.find(item => item.id === root.id)?.path;
        if (!target) throw new Error('The native verifier omitted an additional checked root.');
        const entries = input.snapshot.manifest.roots[index]!.entries;
        for (const entry of entries) if (entry.kind === 'directory') {
          const directory = path.join(target, ...entry.path.split('/'));
          const state = await lstat(directory);
          if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('The verifier root contains an unsafe source parent.');
          await chmod(directory, entry.mode | 0o700);
        }
        await cp(root.path, target, { recursive: true, dereference: false, verbatimSymlinks: true, force: true, filter: from => path.basename(from).toLowerCase() !== '.git' });
        for (const entry of [...entries].reverse()) {
          const filename = path.join(target, ...entry.path.split('/'));
          if (entry.kind === 'symlink') { if (((await lstat(filename)).mode & 0o777) !== entry.mode) await lchmod(filename, entry.mode); }
          else await chmod(filename, entry.mode);
        }
        input.assertCurrent();
      }
      await this.assertExecutionSource(session.id, input.snapshot, input.signal);
      return session;
    }
    // Force envmux to seed the exact private snapshot HEAD, independently of the
    // project's usual base branch. This config is execution scratch, not evidence.
    let config: Record<string, unknown> = {};
    try { config = JSON.parse(await readFile(path.join(repository, '.envmux.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const key = Object.keys(config).find(key => key.toLowerCase() === 'git') ?? 'git';
    const git = config[key] && typeof config[key] === 'object' ? { ...config[key] as Record<string, unknown> } : {};
    for (const key of Object.keys(git)) if (key.toLowerCase() === 'base') delete git[key];
    config[key] = { ...git, base: 'HEAD' };
    await writeFile(path.join(repository, '.envmux.json'), JSON.stringify(config), { mode: 0o600 });
    const session = await this.options.app.sessions.create(project, name, { workingDirectorySources: sources, assertCurrent: input.assertCurrent, developmentToolchain: 'default' });
    input.onSession(session);
    const execution = await abortable(this.options.app.sessions.waitExecutionReady(session.id, this.timeoutMs), input.signal);
    input.assertCurrent();
    if (execution.kind !== 'container' || !execution.containerId) throw new Error('The verifier did not receive its frozen container target.');
    await this.restoreContainerSource(input, session.id);
    return session;
  }

  private async restoreContainerSource(input: VerificationPreparation, sessionId: string): Promise<void> {
    const execution = await abortable(this.options.app.sessions.waitExecutionReady(sessionId, this.timeoutMs), input.signal);
    input.assertCurrent();
    if (execution.kind !== 'container' || !execution.containerId) throw new Error('The verifier did not receive its frozen container target.');
    // Default envmux images do not contain the pinned helper Node. This must
    // precede source export; chat dispatch provisions too late for this check.
    await this.options.chats.manager.provision(execution.containerId, 'codex', {}, input.signal);
    input.assertCurrent();
    const current = this.options.app.sessions.record(sessionId);
    // Envmux has finished seeding. Restore the exact worktree while preserving
    // its runtime-owned Git branches/configuration for a confirmed terminal stop.
    for (const [index, root] of input.snapshot.roots.entries()) {
      const target = index === 0 ? execution.workdir : current.workingDirectories?.find(item => item.id === root.id)?.path;
      if (!target) throw new Error('The verifier execution omitted a declared source root.');
      const restoreRoot = path.join(this.options.app.dataDir, 'workspace-data', 'verification-restores');
      await ownedDirectory(restoreRoot);
      const staging = await mkdtemp(path.join(restoreRoot, `${input.run.id}-${root.id}-`));
      let copied = false;
      try {
        const worktree = path.join(staging, 'source');
        await cp(root.path, worktree, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true, filter: from => path.basename(from).toLowerCase() !== '.git' });
        const copy = dockerInvocation(this.options.app.runtime.endpoint, ['cp', `${worktree}/.`, `${execution.containerId}:${target}`]);
        await exec(copy.command, copy.args, { env: copy.env, timeout: 120_000, signal: input.signal });
        copied = true;
      } finally {
        // A failed transport can still own source reads; keep its bounded scratch
        // until execution teardown/reconciliation rather than race its copier.
        if (copied) await removeScratch(staging);
      }
      if (!input.snapshot.manifest.roots[index]!.entries.some(entry => entry.path === '.envmux.json')) {
        const remove = dockerInvocation(this.options.app.runtime.endpoint, ['exec', '--user', '0', execution.containerId, 'rm', '-f', '--', path.posix.join(target, '.envmux.json')]);
        await exec(remove.command, remove.args, { env: remove.env, timeout: 10_000, signal: input.signal });
      }
      input.assertCurrent();
    }
    await this.assertExecutionSource(sessionId, input.snapshot, input.signal);
  }

  private async assertExecutionSource(sessionId: string, expected: InspectionSnapshot, signal: AbortSignal): Promise<void> {
    const session = this.options.app.sessions.record(sessionId), execution = this.options.app.sessions.execution(sessionId);
    const roots = [{ id: expected.roots[0]!.id, name: expected.roots[0]!.name, path: execution.workdir }, ...(session.workingDirectories ?? []).map(root => ({ id: root.id, name: root.name, path: root.path }))];
    if (execution.kind === 'host-macos') {
      if (roots.length !== expected.roots.length || expected.roots.some(root => !roots.some(actual => actual.id === root.id && actual.name === root.name))) throw new Error('The private verifier execution omitted a checked source root.');
      // Read every declared source entry, including empty directories and modes.
      // Git ls-files alone would hide those in a synthetic verification clone.
      const materialized: InspectionSnapshot = { ...expected, roots: expected.roots.map((root, index) => ({ ...root, path: roots.find(actual => actual.id === root.id)!.path, commit: index === 0 ? root.commit : session.workingDirectories!.find(actual => actual.id === root.id)!.baseCommit })) };
      await verifyInspectionSnapshotContents(materialized, signal);
      return;
    }
    let exported: Awaited<ReturnType<typeof exportInspectionContainerRoots>> | undefined;
    let actual: InspectionSnapshot | undefined;
    const manager = new InspectionSnapshotManager({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'verification-validation') });
    try {
      if (execution.kind === 'container') exported = await exportInspectionContainerRoots({ endpoint: this.options.app.runtime.endpoint, containerId: execution.containerId!, roots, scratchDirectory: path.join(this.options.app.dataDir, 'workspace-data', 'verification-exports', sessionId), signal, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
      actual = await manager.create({ roots: exported?.roots ?? roots, signal, maxBytes: INSPECTION_SOURCE_MAX_BYTES });
      if (!inspectionSourceContentMatches({ snapshotId: expected.id, sha256: expected.sourceDigest, roots: expected.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) }, { snapshotId: actual.id, sha256: actual.sourceDigest, roots: actual.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) })) throw new Error('The private verifier execution changed the exact checked source while preparing.');
    } finally { if (actual) await manager.remove(actual); await exported?.cleanup(); }
  }

  /** Restart cannot replay an in-flight verifier or reopen its ended author. */
  recover(): void {
    for (const run of this.options.app.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)) if (run.ownerDeviceId === this.options.app.device.id && ['preparing', 'running'].includes(run.status) && !this.active.has(run.id)) this.patch(run.id, { status: 'unknown', completedAt: undefined, reason: 'The service restarted during independent verification. Reconcile its retained jobs and conversation before continuing.' });
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const live of this.active.values()) live.abort.abort(new Error('Device service is stopping independent verification.'));
    await Promise.allSettled([...this.active.values()].map(live => live.promise));
    await this.sweeping;
  }
}

async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Verifier workspace storage must be an exact private directory.');
}

async function existingOwnedDirectory(directory: string): Promise<boolean> {
  return !!await ownedDirectoryIdentity(directory);
}

async function ownedDirectoryIdentity(directory: string): Promise<DirectoryIdentity | undefined> {
  let state: Awaited<ReturnType<typeof lstat>>;
  try { state = await lstat(directory, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!state.isDirectory() || state.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Verifier cleanup path is not an exact owned directory.');
  return { dev: String(state.dev), ino: String(state.ino) };
}

async function assertDirectoryIdentity(directory: string, expected?: DirectoryIdentity): Promise<void> {
  const current = await ownedDirectoryIdentity(directory);
  if (current && (!expected || canonical(current) !== canonical(expected))) throw new Error('The retiring verifier directory was replaced by another owner.');
}

async function removeScratch(directory: string): Promise<void> {
  const writable = async (selected: string): Promise<void> => {
    const state = await lstat(selected);
    if (!state.isDirectory() || state.isSymbolicLink()) return;
    await chmod(selected, (state.mode & 0o777) | 0o700);
    for (const name of await readdir(selected)) await writable(path.join(selected, name));
  };
  await writable(directory);
  await rm(directory, { recursive: true, force: true });
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('Verification canceled.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
