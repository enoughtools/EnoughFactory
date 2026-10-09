import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InspectionActionKind, InspectionAuthority, InspectionJob, InspectionSession } from '@enoughfactory/contracts';
import type { NativeAction, NativeObservation } from '@enoughfactory/native-inspection';
import { importInspectionSnapshot, InspectionSnapshotManager, type ArtifactManifest, type ArtifactStore, type InspectionSnapshot } from '@enoughfactory/workspaces';
import { InspectionJobs } from './inspection-jobs.ts';
import { evaluateObservedCondition } from './inspection-condition.ts';
import type { InspectionJournalEvent, InspectionJournalPage, InspectionJournalRecord } from './inspection-delegation-journal.ts';
import type { NativeFixtureProfile, NativeInspectionAdapter, NativeInspectionBuild } from './inspection-native.ts';
import type { NativeBuildRunner } from './inspection-build-runner.ts';
import type { RemoteInspectionAssignment, RemoteInspectionOperation, RemoteInspectionResult, VerifiedRemoteInspectionSource } from './inspection-remote.ts';
import type { Store } from './store.ts';

type OwnerStore = Pick<Store, 'get' | 'set' | 'list' | 'transaction' | 'events'>;
export interface NativeDelegationOwnerOptions {
  app: { dataDir: string; device: { id: string }; store: OwnerStore; withServiceOperation<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>; changed(): void };
  jobs: InspectionJobs;
  native: Pick<NativeInspectionAdapter, 'build' | 'product' | 'readiness' | 'start' | 'restart' | 'observe' | 'act' | 'stop' | 'discover'>;
  /** The service-owned supervisor journals compiler identity and positively confirms original teardown. */
  builds: Pick<NativeBuildRunner, 'build' | 'recover' | 'cancel'>;
  artifacts: ArtifactStore;
  profiles(projectId: string): NativeFixtureProfile[];
  /** Fresh paired-coordinator validation, including after a long native compilation. */
  refreshAuthority(assignmentId: string): Promise<void>;
}
interface OwnerAssignment { id: string; assignment: RemoteInspectionAssignment; token: string; grantId: string; snapshot: InspectionSnapshot; retiredAt?: string; retirementReason?: string }
interface OwnerJob { id: string; assignmentId: string; kind: 'build' | 'native'; profile: NativeFixtureProfile; buildJobId?: string; buildId?: string; backendSessionId?: string; startActionId?: string; effectStartedAt?: string }
interface OwnerRequest { id: string; assignmentId: string; requestId: string; digest: string; jobId?: string; actionId?: string; result?: RemoteInspectionResult }
interface ObservationRecord { id: string; backendObservationId: string; observation: NativeObservation }
const buckets = { assignments: 'inspection-delegation-owner-assignments', jobs: 'inspection-delegation-owner-jobs', requests: 'inspection-delegation-owner-requests', observations: 'inspection-delegation-owner-observations', builds: 'inspection-delegation-owner-builds' };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value) });
const terminal = (job: InspectionJob) => ['succeeded', 'failed', 'canceled'].includes(job.status);

/** Owner-side native work uses the common effect journal and resource pools, never Docker admission. */
export class NativeDelegationOwner {
  private readonly active = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly cleanup = new Map<string, Promise<void>>();
  private readonly snapshots: InspectionSnapshotManager;
  private pumping?: Promise<void>;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: NativeDelegationOwnerOptions) {
    // The shared native adapter verifies ownership with this same service snapshot root.
    this.snapshots = new InspectionSnapshotManager({ dataDir: join(options.app.dataDir, 'inspection'), artifacts: options.artifacts });
  }

  async verifySourceIdentity(assignment: RemoteInspectionAssignment, sources: VerifiedRemoteInspectionSource[]): Promise<void> {
    if (this.retired(assignment.id)) throw new Error('The paired coordinator retired this native assignment.');
    this.profile(assignment);
    if (assignment.ownerDeviceId !== this.options.app.device.id) throw new Error('This native assignment belongs to a different owner.');
    if (sources.length !== assignment.sourceArtifacts.length || sources.some((source, index) => source.rootId !== assignment.sourceArtifacts[index]?.rootId || canonical(source.manifest) !== canonical(assignment.sourceArtifacts[index]?.manifest))) throw new Error('The verified native source set differs from its coordinator assignment.');
    // importInspectionSnapshot verifies the original manifest, every bundle/tree and extracted byte.
    const snapshot = await importInspectionSnapshot({ dataDir: join(this.options.app.dataDir, 'inspection'), artifacts: this.options.artifacts,
      sourceArtifacts: assignment.sourceArtifacts, sourceManifest: assignment.sourceManifest,
      expectedSource: { snapshotId: assignment.source.snapshotId, sourceDigest: assignment.source.sha256 }, context: context(assignment.authority) });
    const expected = assignment.source.roots;
    if (!expected || expected.length !== snapshot.roots.length || snapshot.roots.some((root, index) => root.id !== expected[index]?.id || root.sourceDigest !== expected[index]?.sha256 || (expected[index]?.commit !== undefined && root.sourceCommit !== expected[index]?.commit))) throw new Error('The original native snapshot roots differ from the assigned identities.');
    const previous = this.options.app.store.get<OwnerAssignment>(buckets.assignments, assignment.id);
    if (previous) {
      if (canonical(immutable(previous.assignment)) !== canonical(immutable(assignment))) throw new Error('A native assignment cannot replace its immutable source or ownership.');
      this.options.app.store.set(buckets.assignments, { ...previous, assignment, snapshot });
      return;
    }
    const profile = this.profile(assignment), capability = profile.build.tool === 'xcodebuild' && profile.build.platform === 'ios-simulator' ? 'ios-simulator-inspection' : 'macos-app-inspection';
    await this.options.refreshAuthority(assignment.id);
    // Another paired request may have finished importing the same immutable source
    // while coordinator validation was in flight. Never rotate that job's core grant.
    const concurrent = this.options.app.store.get<OwnerAssignment>(buckets.assignments, assignment.id);
    if (concurrent) {
      if (canonical(immutable(concurrent.assignment)) !== canonical(immutable(assignment))) throw new Error('A native assignment cannot replace its immutable source or ownership.');
      this.options.app.store.set(buckets.assignments, { ...concurrent, assignment, snapshot }); return;
    }
    const grant = this.options.jobs.issueAuthority(assignment.authority, { capabilities: ['apple-compilation', capability], executionTargetIds: [assignment.executionTargetId], ttlMs: 24 * 60 * 60_000 });
    this.options.app.store.set(buckets.assignments, { id: assignment.id, assignment, token: grant.token, grantId: grant.grant.id, snapshot } satisfies OwnerAssignment);
  }

  async execute(assignment: RemoteInspectionAssignment, operation: RemoteInspectionOperation, sources: VerifiedRemoteInspectionSource[], requestId: string): Promise<RemoteInspectionResult> {
    await this.options.refreshAuthority(assignment.id);
    let owner = this.options.app.store.get<OwnerAssignment>(buckets.assignments, assignment.id);
    if (!owner) { await this.verifySourceIdentity(assignment, sources); owner = this.assignment(assignment); }
    else owner = this.assignment(assignment);
    this.options.jobs.authorize(owner.token);
    if (operation.name === 'journal') return this.journal(assignment, string(operation.arguments.jobId, 'job identity'), operation.arguments.after);
    if (operation.name === 'status') { const id = string(operation.arguments.jobId, 'job identity'); await this.recoverBuild(assignment, id); this.pump(); return this.status(assignment, id); }
    if (operation.name === 'build' || operation.name === 'start') return this.submit(owner, operation, requestId);
    try { return await this.options.app.withServiceOperation(async () => this.sessionOperation(owner!, operation, requestId)); }
    finally {
      if (this.retired(owner.id) && typeof operation.arguments.sessionId === 'string') {
        const session = this.options.jobs.getSession(operation.arguments.sessionId);
        const record = session && this.options.app.store.get<OwnerJob>(buckets.jobs, session.jobId);
        if (record?.assignmentId === owner.id) await this.retireJob(record.id);
      }
    }
  }

  /** Discovery never repeats a launch/input. Unknown action outcomes remain reserved and visible. */
  async reconcile(assignment: RemoteInspectionAssignment, operation: RemoteInspectionOperation, requestId: string): Promise<RemoteInspectionResult | undefined> {
    await this.options.refreshAuthority(assignment.id);
    const owner = this.assignment(assignment), request = this.request(owner.assignment.id, requestId, operation, false);
    if (request?.result) return request.result;
    if (request?.jobId) { await this.recoverBuild(assignment, request.jobId); return this.status(assignment, request.jobId); }
    if (request?.actionId) {
      const session = this.session(assignment, operation.arguments.sessionId), action = this.options.jobs.actions(session.id).find(item => item.id === request.actionId);
      if (action && ['succeeded', 'failed', 'canceled'].includes(action.status)) return { content: [text({ action })], value: { actionId: action.id, sessionId: session.id, sourceDigest: assignment.source.sha256 }, isError: action.status !== 'succeeded' };
      const record = this.options.app.store.get<OwnerJob>(buckets.jobs, session.jobId);
      const discovered = await this.options.native.discover();
      const backend = discovered.find(item => item.id === record?.backendSessionId);
      return { content: [text({ action, backend: backend ? { id: backend.id, status: backend.status, pid: backend.pid, simulatorId: backend.simulatorId } : undefined, outcome: 'unknown', reason: 'The original native effect requires confirmed backend reconciliation; it will not be replayed.' })], value: { actionId: request.actionId, sessionId: session.id, sourceDigest: assignment.source.sha256, outcomeUnknown: true }, isError: true };
    }
    return undefined;
  }

  /** Trusted owner boundary: call only after the paired coordinator explicitly retires this authority. */
  async retireAssignment(assignmentId: string, reason: string): Promise<void> {
    const owner = this.options.app.store.get<OwnerAssignment>(buckets.assignments, assignmentId);
    if (!owner) return;
    if (typeof reason !== 'string' || !reason.trim() || reason.includes('\0')) throw new Error('Invalid native retirement reason.');
    const retirementReason = reason.trim().slice(0, 2000);
    if (!owner.retiredAt) this.options.app.store.set(buckets.assignments, { ...owner, retiredAt: new Date().toISOString(), retirementReason });
    this.options.jobs.revokeAuthority(owner.grantId, retirementReason);
    const jobs = this.options.app.store.list<OwnerJob>(buckets.jobs).filter(record => record.assignmentId === assignmentId);
    for (const record of jobs) {
      const job = this.options.jobs.getJob(record.id);
      if (!job || terminal(job)) continue;
      this.options.jobs.cancelOwnerJob(job.id, retirementReason);
      this.aborts.get(job.id)?.abort(new Error(retirementReason));
    }
    await Promise.all(jobs.map(record => this.retireJob(record.id)));
    this.options.app.changed(); this.pump();
  }

  private retired(assignmentId: string): OwnerAssignment | undefined {
    const owner = this.options.app.store.get<OwnerAssignment>(buckets.assignments, assignmentId);
    return owner?.retiredAt ? owner : undefined;
  }

  /** Startup/maintenance discovers the original supervised outcome; it never launches another compiler. */
  async reconcileBuilds(): Promise<void> {
    if (this.closing) return;
    const pending = this.options.app.store.list<OwnerJob>(buckets.jobs).filter(record => record.kind === 'build' && this.options.jobs.getJob(record.id)?.status === 'unknown' && !this.active.has(record.id)).slice(0, 16);
    await Promise.allSettled(pending.map(record => this.options.app.withServiceOperation(async () => {
      const owner = this.options.app.store.get<OwnerAssignment>(buckets.assignments, record.assignmentId);
      if (!owner) return;
      if (owner.retiredAt) await this.retireJob(record.id);
      else await this.recoverBuild(owner.assignment, record.id);
    })));
  }

  private async retireJob(id: string): Promise<void> {
    const pending = this.cleanup.get(id); if (pending) return pending;
    const record = this.options.app.store.get<OwnerJob>(buckets.jobs, id), job = this.options.jobs.getJob(id);
    if (!record || !job || terminal(job) || !this.retired(record.assignmentId)) return;
    const reason = this.retired(record.assignmentId)!.retirementReason || 'The paired coordinator retired this native assignment.';
    const operation = (async () => {
      if (record.backendSessionId) {
        try {
          await this.options.native.stop(record.backendSessionId);
          this.options.jobs.confirmCanceled(id, `${reason} The original owned native backend confirmed termination.`);
        } catch (error) {
          // A stop request is not proof of termination; retain the same resource lease.
          const current = this.options.jobs.getJob(id);
          if (current && !terminal(current)) this.options.jobs.markUnknown(id, `Retired native backend termination is unconfirmed: ${message(error)}`);
        }
      } else if (!record.effectStartedAt && !this.active.has(id)) {
        this.options.jobs.confirmCanceled(id, `${reason} The original operation ended before any backend dispatch.`);
      } else if (record.kind === 'build') {
        try {
          const outcome = await this.options.builds.cancel(id);
          if (outcome.status === 'completed') {
            if (outcome.record.jobId !== id) throw new Error('The original build supervisor returned another job’s completion.');
            if (outcome.build) this.retainBuildReceipt(record, outcome.build);
            this.options.jobs.confirmCanceled(id, `${reason} The original supervised native compiler confirmed teardown.`);
          } else if (!terminal(this.options.jobs.getJob(id)!)) this.options.jobs.markUnknown(id, `${reason} ${outcome.reason}`);
        } catch (error) { if (!terminal(this.options.jobs.getJob(id)!)) this.options.jobs.markUnknown(id, `Original supervised compiler cleanup remains unconfirmed: ${message(error)}`); }
      }
      // A start with no returned backend ID may already have launched. Its callback
      // stores that exact ID and re-enters cleanup; no replacement is ever launched.
    })().finally(() => { this.cleanup.delete(id); this.options.app.changed(); });
    this.cleanup.set(id, operation); return operation;
  }

  private submit(owner: OwnerAssignment, operation: RemoteInspectionOperation, requestId: string): RemoteInspectionResult {
    const request = this.request(owner.id, requestId, operation)!;
    if (request.jobId) { this.pump(); return this.status(owner.assignment, request.jobId); }
    const profile = this.profile(owner.assignment), requestedProfile = operation.arguments.profileId;
    if (requestedProfile !== undefined && requestedProfile !== profile.id) throw new Error('The requested native profile differs from the trusted coordinator assignment.');
    let buildJobId: string | undefined, buildId: string | undefined;
    if (operation.name === 'start') {
      buildJobId = string(operation.arguments.buildJobId, 'build job identity');
      const buildJob = this.job(owner.assignment, buildJobId), record = this.options.app.store.get<OwnerJob>(buckets.jobs, buildJobId);
      if (buildJob.status !== 'succeeded' || record?.kind !== 'build' || !record.buildId) throw new Error('The original exact-source native build must succeed before launch.');
      buildId = record.buildId;
    }
    const capability = operation.name === 'build' ? 'apple-compilation' : profile.build.tool === 'xcodebuild' && profile.build.platform === 'ios-simulator' ? 'ios-simulator-inspection' : 'macos-app-inspection';
    const job = this.options.jobs.createJob(owner.token, { idempotencyKey: `delegated:${requestId}`, executionTargetId: owner.assignment.executionTargetId, capability,
      source: owner.assignment.source, profile: { profileId: profile.id, assignmentId: owner.id, ...(buildId ? { buildId } : {}) } });
    this.options.app.store.transaction(() => {
      this.options.app.store.set(buckets.jobs, { id: job.id, assignmentId: owner.id, kind: operation.name === 'build' ? 'build' : 'native', profile, buildJobId, buildId } satisfies OwnerJob);
      this.options.app.store.set(buckets.requests, { ...request, jobId: job.id });
    });
    this.pump(); this.options.app.changed(); return this.status(owner.assignment, job.id);
  }

  private status(assignment: RemoteInspectionAssignment, id: string): RemoteInspectionResult {
    const job = this.job(assignment, id), record = this.options.app.store.get<OwnerJob>(buckets.jobs, id)!;
    const allEvidence = this.options.jobs.evidence(id), evidence = allEvidence.slice(-24), sessions = this.options.jobs.sessions(id);
    const value = { job, jobId: id, sessions, sessionId: job.sessionId, evidence, evidenceCount: allEvidence.length, buildId: record.buildId, sourceDigest: assignment.source.sha256 };
    return { value, content: [text({ jobId: id, status: job.status, sessionId: job.sessionId, evidenceCount: allEvidence.length, sourceDigest: assignment.source.sha256 })], artifacts: unique(evidence.map(item => item.artifact as ArtifactManifest)) };
  }

  private async journal(assignment: RemoteInspectionAssignment, id: string, cursor: unknown): Promise<RemoteInspectionResult> {
    const after = cursor === undefined ? 0 : cursor;
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) throw new Error('Native journal cursor must be a nonnegative SQLite sequence.');
    const job = this.job(assignment, id), sessions = this.options.jobs.sessions(id);
    const records = new Map<string, InspectionJournalRecord>();
    for (const session of sessions) for (const action of this.options.jobs.actions(session.id)) records.set(action.id, { bucket: 'inspection-actions', value: action });
    const sessionIds = new Set(sessions.map(session => session.id));
    for (const observation of this.options.app.store.list<import('./inspection-jobs.ts').InspectionObservation>('inspection-observations')) if (sessionIds.has(observation.sessionId)) records.set(observation.id, { bucket: 'inspection-observations', value: observation });
    const evidenceById = new Map(this.options.jobs.evidence(id).map(evidence => [evidence.id, evidence]));
    for (const evidence of evidenceById.values()) records.set(evidence.id, { bucket: 'inspection-evidence', value: evidence });
    const entities = new Set([id, ...sessionIds, ...records.keys()]);
    const chronology = [...entities].flatMap(entity => this.options.app.store.events<InspectionJournalEvent['value']>('inspection-journal', entity, 0).map(event => ({ ...event, entity }))).sort((a, b) => a.seq - b.seq);
    if (after > (chronology.at(-1)?.seq ?? 0)) throw new Error('Native journal cursor is ahead of the original job history.');
    const original = chronology.filter(event => event.seq > after);
    const events: InspectionJournalEvent[] = [], artifacts = new Map<string, ArtifactManifest>();
    const page: InspectionJournalPage = { job, sessions, events, after, hasMore: false };
    for (const originalEvent of original) {
      if (typeof originalEvent.value.kind !== 'string' || typeof originalEvent.value.at !== 'string') throw new Error('Original native journal metadata is invalid.');
      let event: InspectionJournalEvent = { seq: originalEvent.seq, entity: originalEvent.entity, value: originalEvent.value };
      const record = records.get(event.entity), pendingArtifacts: ArtifactManifest[] = [];
      if (record) {
        event.record = record;
        if (record.bucket === 'inspection-evidence') pendingArtifacts.push(record.value.artifact as ArtifactManifest);
        if (record.bucket === 'inspection-observations' && record.value.screenshotEvidenceId) {
          const screenshot = evidenceById.get(record.value.screenshotEvidenceId);
          if (screenshot) pendingArtifacts.push(screenshot.artifact as ArtifactManifest);
        }
        if (record.bucket === 'inspection-actions') for (const evidenceId of record.value.evidenceIds ?? []) {
          const evidence = evidenceById.get(evidenceId);
          if (evidence) pendingArtifacts.push(evidence.artifact as ArtifactManifest);
        }
        if (Buffer.byteLength(JSON.stringify({ ...page, events: [event] })) > 48_000) {
          // A single legal action/observation may be larger than an entire relay page.
          // Keep its exact public record in the existing authenticated artifact lane.
          const body = JSON.stringify(record), cacheId = sha(`${id}:${event.entity}:${sha(body)}`);
          const cached = this.options.app.store.get<{ id: string; artifact: ArtifactManifest }>('inspection-delegation-owner-journal-records', cacheId);
          const artifact = cached?.artifact ?? await this.options.artifacts.put(body, { ...context(assignment.authority), name: `native-journal-${event.entity}.json`, mime: 'application/json', metadata: { purpose: 'inspection-public-journal-record', jobId: id, entity: event.entity, sourceDigest: assignment.source.sha256, sha256: sha(body) } });
          if (cached) { if (canonical(await this.options.artifacts.get(artifact.id)) !== canonical(artifact)) throw new Error('Original native journal record artifact changed.'); await this.options.artifacts.path(artifact); }
          else this.options.app.store.set('inspection-delegation-owner-journal-records', { id: cacheId, artifact });
          event = { ...event, record: undefined, recordArtifact: artifact }; pendingArtifacts.push(artifact);
        }
      }
      const nextArtifacts = new Map(artifacts); for (const artifact of pendingArtifacts) nextArtifacts.set(artifact.id, artifact);
      const candidate = { ...page, events: [...events, event], after: event.seq, hasMore: true };
      if (nextArtifacts.size > 16 || Buffer.byteLength(JSON.stringify({ value: candidate, artifacts: [...nextArtifacts.values()] })) > 50_000) {
        if (!events.length) throw new Error('Original native journal event exceeds the bounded relay page.');
        break;
      }
      events.push(event); page.after = event.seq;
      for (const [key, artifact] of nextArtifacts) artifacts.set(key, artifact);
    }
    page.hasMore = original.some(event => event.seq > page.after);
    await this.options.refreshAuthority(assignment.id);
    return { value: { ...page }, content: [text({ jobId: id, eventCount: events.length, after: page.after, hasMore: page.hasMore, sourceDigest: assignment.source.sha256 })], artifacts: [...artifacts.values()] };
  }

  private async sessionOperation(owner: OwnerAssignment, operation: RemoteInspectionOperation, requestId: string): Promise<RemoteInspectionResult> {
    const session = this.session(owner.assignment, operation.arguments.sessionId), record = this.options.app.store.get<OwnerJob>(buckets.jobs, session.jobId);
    if (!record?.backendSessionId) throw new Error('The native session has no confirmed backend identity. Reconcile it before any replacement.');
    const request = this.request(owner.id, requestId, operation)!;
    if (request.result) return request.result;
    const args = operation.arguments.action && typeof operation.arguments.action === 'object' && !Array.isArray(operation.arguments.action) ? operation.arguments.action as Record<string, unknown> : operation.arguments;
    const observationId = typeof operation.arguments.observationId === 'string' ? operation.arguments.observationId : typeof args.observationId === 'string' ? args.observationId : undefined;
    if (operation.name === 'run-tests') return this.assertions(owner, session, operation, request, observationId);
    const kind = operation.name;
    if (!['observe', 'screenshot', 'restart', 'click', 'type', 'key', 'scroll', 'stop'].includes(kind)) throw new Error('Unsupported native inspection operation.');
    if (kind === 'stop' && ['unknown', 'cancellation-requested'].includes(this.job(owner.assignment, session.jobId).status)) {
      // Cancellation is the journaled cleanup intent for an unresolved input. It may
      // terminate the existing backend, but it cannot replay or bless that input.
      this.options.jobs.requestCancel(owner.token, session.jobId, 'The author requested termination of the original unresolved native session.');
      await this.options.native.stop(record.backendSessionId);
      this.options.jobs.confirmCanceled(session.jobId, 'The original native backend confirmed termination.');
      const result: RemoteInspectionResult = { content: [text({ stopped: true, sessionId: session.id, priorActionOutcome: 'unknown' })], value: { stopped: true, sessionId: session.id, sourceDigest: owner.assignment.source.sha256, priorActionOutcome: 'unknown' } };
      this.options.app.store.set(buckets.requests, { ...request, result }); this.options.app.changed(); this.pump(); return result;
    }
    const nativeAction = ['click', 'type', 'key', 'scroll'].includes(kind) ? action(kind, args, observationId) : undefined;
    const begun = this.options.jobs.beginAction(owner.token, session.id, { idempotencyKey: `delegated:${requestId}`, kind: kind as InspectionActionKind, arguments: nativeAction ? { ...nativeAction } : {}, observationId });
    this.options.app.store.set(buckets.requests, { ...request, actionId: begun.action.id });
    if (!begun.execute) return { content: [text({ action: begun.action, replayed: false })], value: { sessionId: session.id, actionId: begun.action.id, sourceDigest: owner.assignment.source.sha256 }, isError: !['succeeded'].includes(begun.action.status) };
    this.options.jobs.markActionRunning(begun.action.id);
    try {
      let result: RemoteInspectionResult;
      if (kind === 'observe' || kind === 'screenshot') result = await this.observe(owner, session, record.backendSessionId, begun.action.id);
      else if (kind === 'restart') {
        const observation = observationId && this.options.app.store.get<ObservationRecord>(buckets.observations, observationId);
        if (!observation) throw new Error('The original native observation is unavailable. Observe again before restarting.');
        const outcome = await this.options.native.restart(record.backendSessionId, observation.backendObservationId);
        if (outcome.previousProcessExited !== true) throw new Error('The original native process did not confirm termination during restart.');
        await this.options.refreshAuthority(owner.id);
        this.options.jobs.confirmSessionRestarted(session.id, { previousProcessExited: true, ...(outcome.pid ? { processIdentity: { pid: outcome.pid, startedAt: new Date().toISOString() } } : {}) });
        this.options.jobs.actionComplete(begun.action.id, { status: 'succeeded' });
        result = { content: [text({ actionId: begun.action.id, ...outcome })], value: { actionId: begun.action.id, sessionId: session.id, sourceDigest: owner.assignment.source.sha256, ...outcome } };
      }
      else if (kind === 'stop') {
        await this.options.native.stop(record.backendSessionId);
        // Cleanup acknowledgement remains valid even if the author was retired during stop.
        this.options.jobs.confirmSessionStopped(session.id);
        await this.options.refreshAuthority(owner.id);
        this.options.jobs.actionComplete(begun.action.id, { status: 'succeeded' });
        this.options.jobs.finishJob(session.jobId, { status: 'succeeded' });
        result = { content: [text({ stopped: true, sessionId: session.id })], value: { stopped: true, sessionId: session.id, sourceDigest: owner.assignment.source.sha256 } };
        this.pump();
      } else {
        const observation = observationId && this.options.app.store.get<ObservationRecord>(buckets.observations, observationId);
        if (!observation) throw new Error('The original native observation is unavailable. Observe again before acting.');
        const outcome = await this.options.native.act(record.backendSessionId, { ...nativeAction!, observationId: observation.backendObservationId });
        await this.options.refreshAuthority(owner.id);
        this.options.jobs.actionComplete(begun.action.id, { status: 'succeeded' });
        result = { content: [text({ actionId: begun.action.id, ...outcome })], value: { actionId: begun.action.id, sessionId: session.id, sourceDigest: owner.assignment.source.sha256, ...outcome } };
      }
      this.options.app.store.set(buckets.requests, { ...request, actionId: begun.action.id, result }); this.options.app.changed(); return result;
    } catch (error) {
      // Backend exceptions can occur after input. Keep the lease unless failure explicitly proves no effect.
      const current = this.options.jobs.getJob(session.jobId);
      if (current && terminal(current)) { /* Trusted retirement already confirmed backend cleanup. */ }
      else if (kind === 'stop' && this.options.jobs.getSession(session.id)?.status === 'stopped') this.options.jobs.reconcileJob(session.jobId, { status: 'failed', reason: `Backend termination was confirmed; ${message(error)}`, releaseConfirmed: true });
      else if (knownNoEffect(error)) this.options.jobs.actionComplete(begun.action.id, { status: 'failed', reason: message(error) });
      else this.options.jobs.markActionUnknown(begun.action.id, message(error));
      this.options.app.changed(); throw error;
    } finally { if (this.retired(owner.id)) await this.retireJob(session.jobId); }
  }

  private async observe(owner: OwnerAssignment, session: InspectionSession, backendSessionId: string, actionId: string): Promise<RemoteInspectionResult> {
    const observed = await this.options.native.observe(backendSessionId), bytes = await readFile(observed.screenshot.path);
    if (bytes.length > 10 * 1024 * 1024 || sha(bytes) !== observed.screenshot.sha256 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('The owned native screenshot bytes failed verification.');
    const artifact = await this.options.artifacts.put(bytes, { ...context(owner.assignment.authority), name: `native-${observed.observationId}.png`, mime: 'image/png' });
    await this.options.refreshAuthority(owner.id);
    const evidence = this.options.jobs.publishEvidence(session.jobId, { kind: 'screenshot', sessionId: session.id, actionId, artifact,
      metadata: { platform: session.capability === 'macos-app-inspection' ? 'macos' : 'ios-simulator', backendObservationId: observed.observationId, assignmentId: owner.id } });
    // Element metadata is text, not image bytes. Bound it once; the complete local observation
    // remains available for evidence while provider-visible IDs only refer to the delivered tree.
    const elements = boundedElements(observed.elements), truncated = observed.truncated || elements.length !== observed.elements.length;
    const uiTree = JSON.stringify(elements);
    const observation = this.options.jobs.recordObservation(actionId, { elementIds: elements.map(element => element.id), uiTree, screenshotEvidenceId: evidence.id,
      viewport: { width: observed.screenshot.width, height: observed.screenshot.height, scale: 1 } });
    this.options.app.store.transaction(() => {
      this.options.app.store.set(buckets.observations, { id: observation.id, backendObservationId: observed.observationId, observation: observed } satisfies ObservationRecord);
      this.options.app.store.set('inspection-structured-observations', { id: observation.id, elements, truncated });
      this.options.app.store.set('inspection-observation-backends', { id: observation.id, backendObservationId: observed.observationId });
      this.options.app.store.set('factory-artifacts', artifact);
    });
    this.options.jobs.actionComplete(actionId, { status: 'succeeded', evidenceIds: [evidence.id] });
    const value = { sessionId: session.id, observationId: observation.id, screenshotEvidenceId: evidence.id, actionId, truncated, appState: observed.appState, sourceDigest: owner.assignment.source.sha256 };
    return { value, content: [text({ ...value, elements }), { type: 'image', artifactId: artifact.id }], artifacts: [artifact] };
  }

  private async assertions(owner: OwnerAssignment, session: InspectionSession, operation: RemoteInspectionOperation, request: OwnerRequest, observationId?: string): Promise<RemoteInspectionResult> {
    if (!observationId || observationId !== session.latestObservationId) throw new Error('Workflow assertions require a fresh current native observation.');
    const observation = this.options.app.store.get<ObservationRecord>(buckets.observations, observationId);
    const checks = operation.arguments.assertions;
    if (!observation || !Array.isArray(checks) || !checks.length || checks.length > 32) throw new Error('Provide between one and 32 concrete observed workflow assertions.');
    const results = checks.map((check: unknown) => {
      if (!check || typeof check !== 'object' || Array.isArray(check)) throw new Error('Invalid workflow assertion.');
      const input = check as Record<string, unknown>, needle = string(input.labelIncludes, 'assertion label');
      if (input.absent === true && observation.observation.truncated) throw new Error('A truncated native observation cannot prove absence.');
      return { condition: input, passed: evaluateObservedCondition(observation.observation.elements, { ...input, labelIncludes: needle }) };
    });
    const begun = this.options.jobs.beginAction(owner.token, session.id, { idempotencyKey: `delegated:${request.requestId}`, kind: 'run-tests', arguments: { observationId, assertions: checks } });
    this.options.app.store.set(buckets.requests, { ...request, actionId: begun.action.id });
    if (!begun.execute) return { content: [text({ action: begun.action })], value: { actionId: begun.action.id, sourceDigest: owner.assignment.source.sha256 } };
    this.options.jobs.markActionRunning(begun.action.id);
    try {
      const artifact = await this.options.artifacts.put(JSON.stringify({ observationId, results, passed: results.every(result => result.passed), kind: 'observed-workflow-assertions' }), { ...context(owner.assignment.authority), name: 'native-workflow-assertions.json', mime: 'application/json' });
      await this.options.refreshAuthority(owner.id);
      const passed = results.every(result => result.passed), evidence = this.options.jobs.publishEvidence(session.jobId, { kind: 'assertion', sessionId: session.id, actionId: begun.action.id, artifact, metadata: { passed, observationId, platform: session.capability === 'macos-app-inspection' ? 'macos' : 'ios-simulator' } });
      this.options.jobs.actionComplete(begun.action.id, { status: passed ? 'succeeded' : 'failed', evidenceIds: [evidence.id] });
      this.options.app.store.set('factory-artifacts', artifact);
      const value = { passed, results, evidenceId: evidence.id, actionId: begun.action.id, sessionId: session.id, sourceDigest: owner.assignment.source.sha256 };
      const result: RemoteInspectionResult = { content: [text({ passed, evidenceId: evidence.id, actionId: begun.action.id })], value, artifacts: [artifact], isError: !passed };
      this.options.app.store.set(buckets.requests, { ...request, actionId: begun.action.id, result }); this.options.app.changed(); return result;
    } catch (error) { const current = this.options.jobs.getJob(session.jobId); if (current && !terminal(current)) this.options.jobs.markActionUnknown(begun.action.id, message(error)); this.options.app.changed(); throw error; }
  }

  private pump(): void {
    if (this.closing || this.pumping) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.pumping = this.claim().finally(() => {
      this.pumping = undefined;
      if (!this.closing && this.options.app.store.list<OwnerJob>(buckets.jobs).some(record => this.options.jobs.getJob(record.id)?.status === 'queued')) {
        this.timer = setTimeout(() => this.pump(), 1000); this.timer.unref();
      }
    });
  }
  private async claim(): Promise<void> {
    for (const record of this.options.app.store.list<OwnerJob>(buckets.jobs)) {
      if (this.closing) return;
      if (this.options.jobs.getJob(record.id)?.status !== 'queued') continue;
      try { await this.options.refreshAuthority(record.assignmentId); }
      catch { continue; } // Keep the queued identity; offline authority never licenses an effect.
      if (this.closing) return;
      if (this.retired(record.assignmentId)) continue;
      const job = this.options.jobs.claimNext(undefined, candidate => candidate.id === record.id);
      if (!job) continue;
      const abort = new AbortController(); this.aborts.set(job.id, abort);
      const operation = this.options.app.withServiceOperation(async serviceSignal => {
        const signal = AbortSignal.any([serviceSignal, abort.signal]);
        signal.throwIfAborted();
        this.options.jobs.markRunning(job.id);
        const owner = this.options.app.store.get<OwnerAssignment>(buckets.assignments, record.assignmentId);
        if (!owner) throw new Error('Native assignment preparation is unavailable.');
        if (record.kind === 'build') {
          await this.snapshots.verify(owner.snapshot, signal);
          const dispatched = { ...record, effectStartedAt: new Date().toISOString() };
          this.options.app.store.set(buckets.jobs, dispatched);
          const built = await this.options.builds.build(owner.snapshot, record.profile, { authority: job.authority, jobId: job.id, signal });
          // Save the complete result before any publication. A stale author cannot receive it as acceptance.
          this.retainBuildReceipt(dispatched, built);
          if (this.retired(record.assignmentId)) { await this.retireJob(job.id); return; }
          if (built.status === 'canceled') { this.options.jobs.confirmCanceled(job.id, built.error || 'The original supervised native compiler confirmed cancellation and teardown.'); return; }
          await this.options.refreshAuthority(record.assignmentId);
          const artifacts = unique([built.reportArtifact, built.preparationArtifact, built.snapshotArtifact, ...built.evidenceArtifacts, ...built.productArtifacts]);
          for (const artifact of artifacts) {
            this.options.app.store.set('factory-artifacts', artifact);
            this.options.jobs.publishEvidence(job.id, { kind: built.productArtifacts.some(product => product.id === artifact.id) ? 'build-product' : 'log', artifact, metadata: { status: built.status, previewOnly: true, assignmentId: record.assignmentId } });
          }
          this.options.jobs.finishJob(job.id, { status: built.status === 'passed' ? 'succeeded' : 'failed', reason: built.error });
        } else {
          const session = this.options.jobs.openSession(job.id);
          const start = this.options.jobs.beginAction(owner.token, session.id, { idempotencyKey: `start:${job.id}`, kind: 'start', arguments: { buildId: record.buildId! } });
          this.options.app.store.set(buckets.jobs, { ...record, startActionId: start.action.id });
          this.options.jobs.markActionRunning(start.action.id);
          const dispatched = { ...record, startActionId: start.action.id, backendSessionId: session.id, effectStartedAt: new Date().toISOString() };
          this.options.app.store.set(buckets.jobs, dispatched);
          const owned = await this.options.native.start(record.buildId!, job.authority.attemptId, session.id);
          if (owned.id !== session.id) throw new Error('The native backend returned a different session owner; reconcile the original journaled identity.');
          if (this.retired(record.assignmentId)) { await this.retireJob(job.id); return; }
          await this.options.refreshAuthority(record.assignmentId);
          this.options.jobs.markSessionReady(session.id, { ...(owned.pid ? { processIdentity: { pid: owned.pid, startedAt: owned.startedAt } } : {}), ...(owned.simulatorId ? { simulatorId: owned.simulatorId } : {}) });
          this.options.jobs.actionComplete(start.action.id, { status: 'succeeded' });
        }
      }).catch(async error => {
        const current = this.options.jobs.getJob(job.id);
        if (!current || terminal(current)) return;
        const sessions = this.options.jobs.sessions(job.id), failure = error as { code?: string; allocationOutcome?: string; sessionId?: string };
        const notAllocated = record.kind === 'native' && failure.code === 'session-not-allocated' && failure.allocationOutcome === 'not-allocated' && sessions.length === 1 && failure.sessionId === sessions[0]!.id;
        if (notAllocated) {
          // Only this exact journaled session's explicit pre-allocation proof
          // permits release. Busy/old ownership and lost launch replies do not.
          for (const action of this.options.jobs.actions(sessions[0]!.id)) {
            if (['requested', 'running'].includes(action.status)) this.options.jobs.markActionUnknown(action.id, 'Reconciling the original backend’s exact no-allocation proof.');
            if (['requested', 'running', 'unknown', 'cancellation-requested'].includes(action.status)) this.options.jobs.reconcileAction(action.id, { status: 'failed', reason: message(error), outcomeConfirmed: true });
          }
          this.options.jobs.confirmSessionStopped(sessions[0]!.id, 'The backend explicitly confirmed that this exact session was not allocated.');
          this.options.jobs.reconcileJob(job.id, { status: this.retired(record.assignmentId) ? 'canceled' : 'failed', reason: message(error), releaseConfirmed: true });
          return;
        }
        if (this.retired(record.assignmentId)) {
          const original = this.options.app.store.get<OwnerJob>(buckets.jobs, job.id)!;
          if (!original.effectStartedAt) this.options.jobs.confirmCanceled(job.id, `Retired native operation ended before a backend effect: ${message(error)}`);
          else { this.options.jobs.markUnknown(job.id, `Retired native operation requires original-backend cleanup: ${message(error)}`); await this.retireJob(job.id); }
          return;
        }
        if (record.kind === 'build') {
          const original = this.options.app.store.get<OwnerJob>(buckets.jobs, job.id)!;
          if (original.effectStartedAt) {
            try {
              const outcome = await this.options.builds.recover(job.id);
              if (outcome.status === 'completed') {
                if (outcome.record.jobId !== job.id) throw new Error('The original build supervisor returned another job’s completion.');
                if (outcome.build) this.retainBuildReceipt(original, outcome.build);
                this.options.jobs.reconcileJob(job.id, { status: outcome.canceled || outcome.build?.status === 'canceled' ? 'canceled' : 'failed', reason: `The original supervised compiler confirmed teardown; publication failed: ${outcome.error || message(error)}`, releaseConfirmed: true });
              } else this.options.jobs.markUnknown(job.id, outcome.reason);
            } catch (recoveryError) { this.options.jobs.markUnknown(job.id, `Original supervised compiler cleanup remains unconfirmed: ${message(recoveryError)}`); }
            return;
          }
        }
        if (record.kind === 'native' && sessions.length) { this.options.jobs.markUnknown(job.id, `Reconcile the original owned native session before release: ${message(error)}`); return; }
        if (knownNoEffect(error)) {
          try {
            for (const session of this.options.jobs.sessions(job.id)) {
              for (const action of this.options.jobs.actions(session.id).filter(action => ['requested', 'running'].includes(action.status))) this.options.jobs.actionComplete(action.id, { status: 'failed', reason: message(error) });
              this.options.jobs.confirmSessionStopped(session.id, 'The backend rejected launch before an application effect.');
            }
            this.options.jobs.finishJob(job.id, { status: 'failed', reason: message(error) });
          } catch { this.options.jobs.markUnknown(job.id, message(error)); }
        } else this.options.jobs.markUnknown(job.id, message(error));
      }).finally(() => { this.active.delete(job.id); this.aborts.delete(job.id); this.options.app.changed(); this.pump(); });
      this.active.set(job.id, operation);
    }
  }

  private assignment(assignment: RemoteInspectionAssignment): OwnerAssignment {
    const owner = this.options.app.store.get<OwnerAssignment>(buckets.assignments, assignment.id);
    if (!owner || canonical(immutable(owner.assignment)) !== canonical(immutable(assignment))) throw new Error('This native assignment has no matching authenticated preparation.');
    if (owner.retiredAt) throw new Error('The paired coordinator retired this native assignment.');
    return owner;
  }
  private async recoverBuild(assignment: RemoteInspectionAssignment, id: string): Promise<void> {
    const job = this.job(assignment, id), record = this.options.app.store.get<OwnerJob>(buckets.jobs, id)!;
    if (job.status !== 'unknown' || record.kind !== 'build' || this.active.has(id)) return;
    // A disconnected worker may still own compiler children. Its durable receipt,
    // never PID absence or an in-memory report, decides whether the lease is free.
    const outcome = await this.options.builds.cancel(id);
    if (outcome.status !== 'completed') { this.options.jobs.markUnknown(id, outcome.reason); return; }
    if (outcome.record.jobId !== id) throw new Error('The original build supervisor returned another job’s completion.');
    const built = outcome.build;
    if (built) this.retainBuildReceipt(record, built);
    if (outcome.canceled || built?.status === 'canceled' || this.retired(assignment.id)) { this.options.jobs.confirmCanceled(id, outcome.error || 'The original supervised native compiler confirmed cancellation and teardown.'); return; }
    if (!built) { this.options.jobs.reconcileJob(id, { status: 'failed', reason: outcome.error || 'The original supervised native worker ended before creating a build product.', releaseConfirmed: true }); return; }
    try {
      const owner = this.assignment(assignment);
      await this.snapshots.verify(owner.snapshot);
      const artifacts = unique([built.reportArtifact, built.preparationArtifact, built.snapshotArtifact, ...built.evidenceArtifacts, ...built.productArtifacts]);
      for (const artifact of artifacts) {
        if (canonical(await this.options.artifacts.get(artifact.id)) !== canonical(artifact)) throw new Error('Original native build evidence changed during recovery.');
        await this.options.artifacts.path(artifact);
      }
      if (built.status === 'passed') await this.options.native.product(built.id);
      await this.options.refreshAuthority(assignment.id);
      // This resumes bookkeeping for the confirmed original build only, without rerunning it.
      this.options.jobs.reconcileJob(id, { status: 'running', reason: 'Recovered the complete original native build report.' });
      const existing = new Set(this.options.jobs.evidence(id).map(item => item.artifact.id));
      for (const artifact of artifacts) if (!existing.has(artifact.id)) this.options.jobs.publishEvidence(id, { kind: built.productArtifacts.some(product => product.id === artifact.id) ? 'build-product' : 'log', artifact, metadata: { status: built.status, previewOnly: true, assignmentId: assignment.id } });
      this.options.jobs.finishJob(id, { status: built.status === 'passed' ? 'succeeded' : 'failed', reason: built.error });
    } catch (error) {
      // The worker receipt already proved teardown. Unavailable authority or
      // evidence cannot turn that old outcome into success or consume a live lease.
      if (!terminal(this.options.jobs.getJob(id)!)) this.options.jobs.reconcileJob(id, { status: 'failed', reason: `The original supervised compiler ended, but its retained delivery could not be accepted: ${message(error)}`, releaseConfirmed: true });
    }
    this.options.app.changed();
  }
  private retainBuildReceipt(record: OwnerJob, built: NativeInspectionBuild): void {
    const owner = this.options.app.store.get<OwnerAssignment>(buckets.assignments, record.assignmentId);
    if (!owner || built.candidate.goalId !== owner.assignment.authority.goalId || built.candidate.taskId !== owner.assignment.authority.taskId || built.candidate.attemptId !== owner.assignment.authority.attemptId
      || built.candidate.commit !== owner.snapshot.roots[0]?.commit || built.report.candidateId !== built.candidate.id || built.report.commit !== built.candidate.commit || built.fixtureProfileId !== record.profile.id) throw new Error('The supervised build receipt differs from its original owner, source or profile.');
    this.options.app.store.set(buckets.builds, { id: record.id, build: built });
    this.options.app.store.set(buckets.jobs, { ...record, buildId: built.id });
  }
  private profile(assignment: RemoteInspectionAssignment): NativeFixtureProfile {
    if (!assignment.profile || Object.keys(assignment.profile).some(key => !['projectId', 'profileId'].includes(key))) throw new Error('Native assignments select a trusted project profile; raw build or launch paths are forbidden.');
    const projectId = string(assignment.profile.projectId, 'project identity'), profileId = string(assignment.profile.profileId, 'profile identity');
    const profile = this.options.profiles(projectId).find(profile => profile.id === profileId);
    if (!profile || profile.build.tool !== 'xcodebuild') throw new Error('This native owner has no configured isolated fixture profile for the assigned project.');
    const capability = profile.build.platform === 'ios-simulator' ? 'ios-simulator-inspection' : 'macos-app-inspection';
    if (!['apple-compilation', capability].includes(assignment.capability)) throw new Error('The native fixture platform differs from the assigned capability.');
    return structuredClone(profile);
  }
  private job(assignment: RemoteInspectionAssignment, id: string): InspectionJob {
    const job = this.options.jobs.getJob(id), record = this.options.app.store.get<OwnerJob>(buckets.jobs, id);
    if (!job || record?.assignmentId !== assignment.id || canonical(job.authority) !== canonical(assignment.authority) || canonical(job.source) !== canonical(assignment.source)) throw new Error('The native job belongs to a different assignment or immutable source.');
    return job;
  }
  private session(assignment: RemoteInspectionAssignment, id: unknown): InspectionSession {
    const session = this.options.jobs.getSession(string(id, 'session identity'));
    if (!session) throw new Error('The owned native session is unavailable.');
    this.job(assignment, session.jobId); return session;
  }
  private request(assignmentId: string, requestId: string, operation: RemoteInspectionOperation, create = true): OwnerRequest | undefined {
    if (!requestId || requestId.length > 512) throw new Error('Invalid native operation identity.');
    const id = sha(`${assignmentId}:${requestId}`), digest = sha(canonical(operation));
    const previous = this.options.app.store.get<OwnerRequest>(buckets.requests, id);
    if (previous) { if (previous.digest !== digest) throw new Error('Native request identity was reused for different arguments.'); return previous; }
    if (!create) return;
    const request = { id, assignmentId, requestId, digest }; this.options.app.store.set(buckets.requests, request); return request;
  }
  activity(): string[] { return this.options.app.store.list<OwnerJob>(buckets.jobs).filter(record => { const job = this.options.jobs.getJob(record.id); return job && !terminal(job); }).map(record => `Delegated native ${record.kind}: ${this.options.jobs.getJob(record.id)!.status}`); }
  async close(): Promise<void> {
    this.closing = true; if (this.timer) clearTimeout(this.timer); await this.pumping;
    for (const abort of this.aborts.values()) abort.abort(new Error('Native inspection owner service is closing.'));
    const builds = this.options.app.store.list<OwnerJob>(buckets.jobs).filter(record => record.kind === 'build' && record.effectStartedAt && !terminal(this.options.jobs.getJob(record.id)!));
    await Promise.allSettled(builds.map(record => this.options.builds.cancel(record.id)));
    await Promise.allSettled([...this.active.values()]);
  }
}

function context(authority: InspectionAuthority) { return { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId }; }
function immutable({ createdAt: _created, expiresAt: _expires, digest: _digest, ...assignment }: RemoteInspectionAssignment) { return assignment; }
function string(value: unknown, name: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 512 || value.includes('\0')) throw new Error(`Invalid native ${name}.`); return value; }
function unique(values: ArtifactManifest[]): ArtifactManifest[] { return [...new Map(values.map(value => [value.id, value])).values()]; }
function boundedElements(elements: NativeObservation['elements']): NativeObservation['elements'] { let bytes = 2; const result: NativeObservation['elements'] = []; for (const element of elements) { const size = Buffer.byteLength(JSON.stringify(element)) + 1; if (bytes + size > 40_000 || result.length >= 300) break; bytes += size; result.push(element); } return result; }
function knownNoEffect(error: unknown): boolean { return ['invalid-request', 'stale-observation', 'invalid-profile', 'fixture-required', 'invalid-owner', 'setup-required', 'unsupported', 'native-busy', 'session-busy', 'element-not-found', 'element-disabled', 'focus-changed'].includes(String((error as { code?: string })?.code)); }
function action(kind: string, args: Record<string, unknown>, observationId?: string): NativeAction {
  if (!observationId) throw new Error('Native input requires a fresh observation identity.');
  if (args.kind !== undefined && args.kind !== kind) throw new Error('Native action kind differs from its delegated operation.');
  if (kind === 'key') {
    if (!['enter', 'backspace', 'escape', 'tab', 'selectAll'].includes(String(args.key))) throw new Error('Unsupported native key.');
    return { kind, observationId, key: args.key as 'enter' };
  }
  const elementId = string(args.elementId, 'element identity');
  if (kind === 'click') return { kind, observationId, elementId };
  if (kind === 'type') {
    if (typeof args.text !== 'string' || Buffer.byteLength(args.text) > 65_536 || (args.mode !== undefined && !['append', 'replace'].includes(String(args.mode)))) throw new Error('Invalid native text input.');
    return { kind, observationId, elementId, text: args.text, ...(args.mode ? { mode: args.mode as 'append' | 'replace' } : {}) };
  }
  if (kind === 'scroll' && ['up', 'down', 'left', 'right'].includes(String(args.direction))) return { kind, observationId, elementId, direction: args.direction as 'up' };
  throw new Error('Invalid native inspection action.');
}
