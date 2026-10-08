import { createHash } from 'node:crypto';
import { chmod, cp, lchmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionCapability, ExecutionTargetAdvertisement, Goal, InspectionAuthority, InspectionSourceIdentity, InspectionVerificationRun, Project, Session, TaskQualityRequirements } from '@enoughfactory/contracts';
import { ArtifactStore, InspectionSnapshotManager, WorkspaceManager, exportInspectionContainerRoots, exportInspectionSnapshot, importInspectionSnapshot, verifyInspectionSnapshotContents, writeAtomic, type InspectionSnapshot, type InspectionSnapshotTransfer, type WorkspaceRecord } from '@enoughfactory/workspaces';
import { dockerInvocation } from '@enoughfactory/runtime';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext, ChatController } from './chats.ts';
import { factoryQualityInstructions } from './factory-quality.ts';
import { inspectionSourceContentMatches, type InspectionQualityService } from './inspection-quality.ts';
import { exec } from './util.ts';

export const INSPECTION_VERIFIER_RUNS = 'inspection-verifier-runs';
const INPUTS = 'inspection-verifier-inputs';
const terminal = new Set<InspectionVerificationRun['status']>(['succeeded', 'failed', 'canceled', 'unknown']);
const sha = /^[a-f0-9]{64}$/;
const commit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export interface VerificationInput {
  authority: InspectionAuthority;
  purpose?: 'task' | 'goal-final';
  /** Current canonical goal revision, independently of the frozen author assignment. */
  goalRevision?: number;
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
  /** Default twenty minutes. A completed verifier is never silently dispatched again. */
  timeoutMs?: number;
  /** Alternate owner must prepare and verify exact private execution copies before return. */
  prepareExecution?: (input: VerificationPreparation) => Promise<Session>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function inspectionQualityPolicySha256(quality: TaskQualityRequirements): string { return digest(quality); }
export function inspectionVerificationKey(input: Pick<VerificationInput, 'authority' | 'source' | 'quality' | 'purpose' | 'goalRevision'>): string {
  // Commit identities remain recorded separately: byte-equivalent C and M reuse the
  // same review; different source or policy always receives a new verifier owner.
  return `verify-${digest({ version: 1, authority: input.authority, ...(input.purpose === 'goal-final' ? { purpose: input.purpose, goalRevision: input.goalRevision } : {}), source: { sha256: input.source.sha256, roots: (input.source.roots ?? []).map(({ id, sha256 }) => ({ id, sha256 })).sort((a, b) => a.id.localeCompare(b.id)) }, quality: input.quality })}`;
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
  private assertCurrent(run: InspectionVerificationRun, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    const current = this.get(run.id);
    if (this.closing || terminal.has(current.status) || current.ownerDeviceId !== this.options.app.device.id || !this.options.authorityCurrent(current.authority)) throw new Error('Inspection verifier authority was retired.');
    if (current.purpose === 'goal-final' && this.options.app.store.get<Goal>('goals', current.authority.goalId)?.revision !== current.goalRevision) throw new Error('The final verification goal revision was retired.');
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
    const id = inspectionVerificationKey(input), existing = this.options.app.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, id);
    const live = this.active.get(id);
    if (live) return live.promise;
    if (existing && terminal.has(existing.status)) return Promise.resolve(existing);
    if (existing && ['preparing', 'running'].includes(existing.status)) return Promise.resolve(this.patch(id, { status: 'unknown', completedAt: undefined, reason: 'The verifier process lost its service owner. Reconcile its retained conversation and jobs before continuing.' }));
    const target = input.quality.platforms.includes('web') ? 'container' : 'host-macos';
    if (!existing) {
      const at = this.now();
      this.options.app.store.set<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, { id, authority: structuredClone(input.authority), ...(input.purpose === 'goal-final' ? { purpose: input.purpose, goalRevision: input.goalRevision } : {}), source: structuredClone(input.source), quality: structuredClone(input.quality), policySha256: inspectionQualityPolicySha256(input.quality), ownerDeviceId: this.options.app.device.id, executionTargetKind: target, executionTargetId: target === 'container' ? 'container' : 'mac-host', status: 'queued', createdAt: at, updatedAt: at, deadlineAt: new Date(Date.now() + this.timeoutMs).toISOString() });
    }
    const abort = new AbortController();
    const forward = () => abort.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', forward, { once: true });
    const promise = Promise.resolve().then(() => this.execute(id, input, abort)).then(() => this.get(id)).finally(() => { input.signal?.removeEventListener('abort', forward); this.active.delete(id); });
    this.active.set(id, { promise, abort });
    return promise;
  }

  private async retain(id: string, input: VerificationInput, signal: AbortSignal): Promise<InspectionSnapshot> {
    let saved = this.options.app.store.get<VerificationInputs>(INPUTS, id);
    if (!saved) {
      const transfer = await exportInspectionSnapshot({ snapshot: input.snapshot, artifacts: this.artifacts, context: input.authority, signal });
      saved = { id, project: structuredClone(input.project), transfer };
      this.options.app.store.set(INPUTS, saved);
      for (const artifact of [transfer.sourceManifest, ...transfer.sourceArtifacts.map(source => source.manifest)]) this.options.app.store.set('factory-artifacts', artifact);
    }
    const snapshot = await importInspectionSnapshot({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'inspection-verification', id), artifacts: this.artifacts, sourceArtifacts: saved.transfer.sourceArtifacts, sourceManifest: saved.transfer.sourceManifest, expectedSource: { snapshotId: this.get(id).source.snapshotId, sourceDigest: this.get(id).source.sha256 }, context: this.get(id).authority, signal });
    this.options.app.store.set(INPUTS, { ...saved, snapshot });
    return snapshot;
  }

  private async selectedTarget(run: InspectionVerificationRun): Promise<{ target?: ExecutionTargetAdvertisement; reason?: string }> {
    const targets = await this.options.readiness();
    const required: ExecutionCapability[] = run.executionTargetKind === 'container' ? ['linux-shell', 'chromium-inspection'] : ['mac-shell'];
    const target = targets.find(target => target.kind === run.executionTargetKind && (!target.runtimes || target.runtimes.includes('codex')) && required.every(kind => target.capabilities.some(capability => capability.kind === kind && capability.readiness === 'ready')) && target.readiness === 'ready');
    const reasons: string[] = [];
    if (!target) reasons.push(`The ${run.executionTargetKind === 'container' ? 'private browser/container' : 'Mac Codex'} verification target is not ready.`);
    for (const platform of run.quality.platforms) {
      if (platform === 'web') continue;
      const capability = platform === 'macos' ? 'macos-app-inspection' : 'ios-simulator-inspection';
      for (const kind of ['apple-compilation', capability] as const) if (!targets.some(target => target.capabilities.some(item => item.kind === kind && item.readiness === 'ready'))) reasons.push(targets.flatMap(target => target.capabilities).find(item => item.kind === kind)?.reason || `The ${kind} capability is not ready.`);
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
      const claimed = this.options.app.store.transaction(() => {
        const current = this.get(id);
        if (!['queued', 'waiting'].includes(current.status)) return false;
        this.patch(id, { status: 'preparing', reason: undefined });
        return true;
      });
      if (!claimed) return this.get(id);
      // Retain before returning a readiness wait: the caller may retire its check copy.
      snapshot = await this.retain(id, input, abort.signal);
      this.assertCurrent(this.get(id), abort.signal);
      const selected = await abortable(this.selectedTarget(this.get(id)), abort.signal);
      this.assertCurrent(this.get(id), abort.signal);
      if (!selected.target) return this.patch(id, { status: 'waiting', reason: selected.reason });
      const run = this.patch(id, { status: 'preparing', executionTargetId: selected.target.id, deadlineAt: new Date(Date.now() + this.timeoutMs).toISOString(), reason: undefined });
      timer = setTimeout(() => abort.abort(new Error('Inspection verifier exceeded its bounded deadline.')), this.timeoutMs);
      const assertCurrent = () => this.assertCurrent(this.get(id), abort.signal);
      const onSession = (session: Session) => {
        assertCurrent();
        this.options.app.store.set('sessions', { ...session, verificationRunId: id });
        this.patch(id, { sessionId: session.id });
      };
      const preparation = { run, snapshot, project: input.project, signal: abort.signal, assertCurrent, onSession };
      let session: Session;
      if (run.sessionId) {
        session = this.options.app.sessions.record(run.sessionId);
        if (session.verificationRunId !== id || !this.options.app.sessions.owns(session.id) || session.executionTargetKind !== run.executionTargetKind) throw Object.assign(new Error('The independent setup owner changed.'), { code: 'HOST_PROCESS_UNKNOWN' });
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
      const chat = this.options.chats.create({ sessionId: session.id, runtime: 'codex', approvalMode: goal?.approvalMode ?? input.project.approvalMode, title: `Verify ${run.source.checkedCommit!.slice(0, 12)}`, verificationRunId: id });
      this.patch(id, { status: 'running', chatId: chat.id, startedAt: this.now() });
      const stop = () => { void this.options.chats.interrupt(chat.id).catch(() => {}); };
      abort.signal.addEventListener('abort', stop, { once: true });
      try {
        assertCurrent();
        const context = await this.options.quality.context({ authority: run.authority, source: run.source, referenceIds: run.quality.referenceIds });
        assertCurrent();
        dispatched = true;
        await abortable(this.options.chats.run(chat.id, this.prompt(this.get(id), context), { attemptId: run.authority.attemptId, verificationRunId: id, autonomous: true, systemInstructions: factoryQualityInstructions('evaluator') }), abort.signal);
        providerEnded = true;
      } finally { abort.signal.removeEventListener('abort', stop); }
      assertCurrent();
      await this.snapshotManager(id).verify(snapshot, abort.signal);
      const checked = await this.options.quality.check({ authority: run.authority, quality: run.quality, source: run.source, candidateCommit: run.source.candidateCommit!, checkedCommit: run.source.checkedCommit });
      assertCurrent();
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
    return [
      'Independently verify the exact saved application source below. The author has finished; you are a separate verifier and must not resume, repair, commit or integrate its source. Build and launch only with the Factory inspection tools, which are bound to the immutable checked snapshot. Use shell only to inspect source and discover the declared build/reference paths. Keep generated files out of source roots.',
      `Verification run: ${run.id}\nChecked source: ${JSON.stringify(run.source)}\nFrozen quality requirements: ${JSON.stringify(run.quality)}`,
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
          const frozen = await importInspectionSnapshot({ dataDir: path.join(this.options.app.dataDir, 'workspace-data', 'inspection-verification', run.id), artifacts: this.artifacts, sourceArtifacts: inputs.transfer.sourceArtifacts, sourceManifest: inputs.transfer.sourceManifest, expectedSource: { snapshotId: run.source.snapshotId, sourceDigest: run.source.sha256 }, context: run.authority });
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
                preserved = await manager.create({ roots: [{ id: frozen.roots[0]!.id, name: frozen.roots[0]!.name, path: workspace.path, kind: 'git' }], includeAll: true, context: run.authority });
                primarySource = await exportInspectionSnapshot({ snapshot: preserved, artifacts: this.artifacts, context: run.authority });
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
      if (execution.kind === 'container') exported = await exportInspectionContainerRoots({ endpoint: this.options.app.runtime.endpoint, containerId: execution.containerId!, roots, scratchDirectory: path.join(this.options.app.dataDir, 'workspace-data', 'verification-exports', sessionId), signal });
      actual = await manager.create({ roots: exported?.roots ?? roots, signal });
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
