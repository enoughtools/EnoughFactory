import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EXECUTION_CAPABILITIES, type ExecutionCapability, type InspectionAction, type InspectionActionKind, type InspectionAuthority, type InspectionEvidence, type InspectionJob, type InspectionSession, type InspectionSourceIdentity } from '@enoughfactory/contracts';
import type { Store } from './store.ts';

type Journal = Pick<Store, 'get' | 'set' | 'list' | 'transaction' | 'append'>;
export type InspectionLeasePool = 'browser' | 'native-desktop' | 'ios-simulator' | 'apple-build';
export interface InspectionLeaseRequest { pool: InspectionLeasePool; key?: string; units?: number; }
export interface InspectionLease {
  id: string; jobId: string; pool: InspectionLeasePool; key: string; units: number;
  status: 'held' | 'released'; createdAt: string; releasedAt?: string;
}
export interface InspectionGrant {
  id: string; authority: InspectionAuthority; capabilities: ExecutionCapability[]; executionTargetIds: string[];
  createdAt: string; expiresAt: string; revokedAt?: string;
}
interface GrantRecord extends InspectionGrant { tokenHash: string; }
interface JobRecord extends InspectionJob { grantId: string; requestKey: string; requestHash: string; queueSequence: number; resources: InspectionLeaseRequest[]; }
interface ActionRecord extends InspectionAction { requestKey: string; requestHash: string; }
export interface InspectionObservation {
  id: string; sessionId: string; actionId: string; createdAt: string;
  /** Backend-issued element identities from this observation, never arbitrary provider selectors. */
  elementIds?: string[]; uiTree?: string; screenshotEvidenceId?: string;
  viewport?: { width: number; height: number; scale: number };
}
export interface CreateInspectionJob {
  idempotencyKey: string; executionTargetId: string; capability: ExecutionCapability;
  source: InspectionSourceIdentity; profile: Record<string, unknown>; resources?: InspectionLeaseRequest[];
}
export interface BeginInspectionAction {
  idempotencyKey: string; kind: InspectionActionKind; arguments: Record<string, unknown>; observationId?: string;
}
export interface InspectionJobsOptions {
  deviceId: string;
  /** Must check current coordinator authority, attempt retirement and policy, not only device ownership. */
  authorityCurrent: (authority: InspectionAuthority) => boolean;
  capacities?: Partial<Record<InspectionLeasePool, number>>; now?: () => string;
}
const B = {
  grants: 'inspection-private-grants', tokens: 'inspection-private-token-index', jobs: 'inspection-jobs', sessions: 'inspection-sessions',
  actions: 'inspection-actions', observations: 'inspection-observations', leases: 'inspection-leases', evidence: 'inspection-evidence',
} as const;
const pools: InspectionLeasePool[] = ['browser', 'native-desktop', 'ios-simulator', 'apple-build'];
const terminalJobs = new Set<InspectionJob['status']>(['succeeded', 'failed', 'canceled']);
const terminalActions = new Set<InspectionAction['status']>(['succeeded', 'failed', 'canceled']);
const mutations = new Set<InspectionActionKind>(['start', 'restart', 'navigate', 'click', 'type', 'key', 'scroll', 'run-tests', 'stop']);
const invalidatesObservation = new Set<InspectionActionKind>([...mutations, 'observe', 'screenshot']);
const freshInput = new Set<InspectionActionKind>(['restart', 'click', 'type', 'key', 'scroll']);
const actionKinds: InspectionActionKind[] = ['build', 'start', 'restart', 'navigate', 'observe', 'screenshot', 'click', 'type', 'key', 'scroll', 'run-tests', 'stop'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Inspection arguments must contain finite numbers');
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error('Inspection arguments must be JSON values');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Inspection arguments must be plain JSON records');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function bounded(value: unknown, limit = 65_536): void {
  if (Buffer.byteLength(canonical(value)) > limit) throw new Error('Inspection metadata exceeds its bounded input size; use an artifact reference');
}
function nonblank(value: string, name: string): void { if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`Invalid inspection ${name}`); }
function sameAuthority(a: InspectionAuthority, b: InspectionAuthority): boolean { return canonical(a) === canonical(b); }

/** Durable effect journal. Trusted owner methods journal backend acknowledgements; they never execute effects themselves. */
export class InspectionJobs {
  private readonly clock: () => string;
  private readonly capacities: Record<InspectionLeasePool, number>;
  constructor(private readonly store: Journal, private readonly options: InspectionJobsOptions) {
    this.clock = options.now ?? (() => new Date().toISOString());
    this.capacities = { browser: 2, 'native-desktop': 1, 'ios-simulator': 1, 'apple-build': 2, ...options.capacities };
    for (const pool of pools) if (!Number.isSafeInteger(this.capacities[pool]) || this.capacities[pool] < 0 || this.capacities[pool] > 64) throw new Error(`Invalid ${pool} inspection capacity`);
    if (this.capacities['native-desktop'] > 1) throw new Error('Native desktop inspection requires a single foreground lease');
  }

  issueAuthority(authority: InspectionAuthority, input: { capabilities: ExecutionCapability[]; executionTargetIds: string[]; ttlMs?: number }): { token: string; grant: InspectionGrant } {
    this.assertAuthority(authority);
    if (!input.capabilities.length || input.capabilities.some(value => !EXECUTION_CAPABILITIES.includes(value))) throw new Error('Invalid inspection capabilities');
    if (!input.executionTargetIds.length) throw new Error('An inspection grant needs an explicit execution target');
    for (const target of input.executionTargetIds) nonblank(target, 'target');
    const ttl = input.ttlMs ?? 8 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 24 * 60 * 60 * 1000) throw new Error('Invalid inspection grant lifetime');
    const token = randomBytes(32).toString('base64url'), at = this.clock();
    const record: GrantRecord = { id: randomUUID(), tokenHash: digest(token), authority: structuredClone(authority), capabilities: [...new Set(input.capabilities)], executionTargetIds: [...new Set(input.executionTargetIds)], createdAt: at, expiresAt: new Date(Date.parse(at) + ttl).toISOString() };
    this.store.transaction(() => { this.store.set(B.grants, record); this.store.set(B.tokens, { id: record.tokenHash, grantId: record.id }); this.event('authority-issued', record.id, { authority, expiresAt: record.expiresAt }); });
    return { token, grant: this.publicGrant(record) };
  }

  authorize(token: string, capability?: ExecutionCapability, executionTargetId?: string): InspectionGrant {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid inspection authority');
    const index = this.store.get<{ id: string; grantId: string }>(B.tokens, digest(token));
    const grant = index && this.store.get<GrantRecord>(B.grants, index.grantId);
    if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.parse(this.clock())) throw new Error('Expired or revoked inspection authority');
    this.assertAuthority(grant.authority);
    if (capability && !grant.capabilities.includes(capability)) throw new Error('Inspection capability is outside this authority');
    if (executionTargetId && !grant.executionTargetIds.includes(executionTargetId)) throw new Error('Inspection target is outside this authority');
    return this.publicGrant(grant);
  }

  /** Trusted coordinator revocation retains active reservations until the owning backend confirms termination. */
  revokeAuthority(grantId: string, reason = 'Author authority was retired'): void {
    this.store.transaction(() => {
      const grant = this.store.get<GrantRecord>(B.grants, grantId);
      if (!grant || grant.revokedAt) return;
      this.store.set(B.grants, { ...grant, revokedAt: this.clock() });
      for (const job of this.store.list<JobRecord>(B.jobs).filter(job => job.grantId === grantId)) this.cancel(job, reason);
      this.event('authority-revoked', grantId, { reason });
    });
  }

  createJob(token: string, input: CreateInspectionJob): InspectionJob {
    return this.store.transaction(() => {
      const grant = this.authorize(token, input.capability, input.executionTargetId);
      nonblank(input.idempotencyKey, 'idempotency key'); this.validateSource(input.source); bounded(input.profile);
      const resources = this.validateResources(input.resources ?? [{ pool: this.defaultPool(input.capability) }]);
      if (!resources.some(resource => resource.pool === this.defaultPool(input.capability))) throw new Error('Inspection jobs cannot bypass the required capability resource pool');
      const requestHash = digest(canonical({ executionTargetId: input.executionTargetId, capability: input.capability, source: input.source, profile: input.profile, resources }));
      const existing = this.store.list<JobRecord>(B.jobs).find(job => job.grantId === grant.id && job.requestKey === input.idempotencyKey);
      if (existing) { if (existing.requestHash !== requestHash) throw new Error('Inspection job idempotency key was reused for different inputs'); return this.publicJob(existing); }
      const at = this.clock(), jobId = randomUUID();
      const queueSequence = this.event('job-queued', jobId, { authority: grant.authority, capability: input.capability });
      const job: JobRecord = { id: jobId, authority: grant.authority, grantId: grant.id, requestKey: input.idempotencyKey, requestHash, queueSequence, ownerDeviceId: this.options.deviceId, executionTargetId: input.executionTargetId, capability: input.capability, source: structuredClone(input.source), profile: structuredClone(input.profile), resources, status: 'queued', createdAt: at, updatedAt: at };
      this.store.set(B.jobs, job); return this.publicJob(job);
    });
  }

  /** FIFO among jobs competing for a resource; all requested resources are acquired atomically. */
  claimNext(pool?: InspectionLeasePool, accepts?: (job: InspectionJob) => boolean): InspectionJob | undefined {
    return this.store.transaction(() => {
      const queue = this.store.list<JobRecord>(B.jobs).filter(job => job.ownerDeviceId === this.options.deviceId && job.status === 'queued').sort((a, b) => a.queueSequence - b.queueSequence);
      for (const job of queue) {
        if (pool && !job.resources.some(resource => resource.pool === pool)) continue;
        if (accepts && !accepts(this.publicJob(job))) continue;
        if (!this.jobAuthorityCurrent(job)) { this.cancel(job, 'Inspection authority is no longer current'); continue; }
        if (!this.canAcquire(job.resources)) continue;
        // Do not let a later overlapping request jump an earlier request waiting on another resource.
        if (queue.some(earlier => earlier.queueSequence < job.queueSequence && earlier.status === 'queued' && this.jobAuthorityCurrent(earlier) && earlier.resources.some(a => job.resources.some(b => a.pool === b.pool && (a.key ?? this.options.deviceId) === (b.key ?? this.options.deviceId))))) continue;
        const at = this.clock(), leaseIds: string[] = [];
        for (const request of job.resources) {
          const lease: InspectionLease = { id: randomUUID(), jobId: job.id, pool: request.pool, key: request.key ?? this.options.deviceId, units: request.units ?? 1, status: 'held', createdAt: at };
          this.store.set(B.leases, lease); leaseIds.push(lease.id);
        }
        const claimed = { ...job, status: 'preparing' as const, leaseIds, updatedAt: at };
        this.store.set(B.jobs, claimed); this.event('job-claimed', job.id, { leaseIds }); return this.publicJob(claimed);
      }
      return undefined;
    });
  }

  markRunning(jobId: string): InspectionJob { return this.transition(jobId, ['preparing', 'waiting'], 'running'); }
  markWaiting(jobId: string, reason: string): InspectionJob { return this.transition(jobId, ['preparing', 'running', 'waiting'], 'waiting', reason); }

  /** Trusted owner boundary: a timeout/lost connection preserves every potentially live reservation. */
  markUnknown(jobId: string, reason: string): InspectionJob {
    return this.store.transaction(() => {
      const job = this.job(jobId);
      if (terminalJobs.has(job.status)) throw new Error('A terminal inspection job cannot become unknown');
      const next = { ...job, status: 'unknown' as const, reason, updatedAt: this.clock() };
      this.store.set(B.jobs, next);
      for (const session of this.sessions(jobId)) if (!['stopped', 'failed'].includes(session.status)) this.store.set(B.sessions, { ...session, status: 'unknown', latestObservationId: undefined, reason, updatedAt: this.clock() });
      for (const action of this.store.list<ActionRecord>(B.actions).filter(action => action.jobId === jobId && !terminalActions.has(action.status))) this.store.set(B.actions, { ...action, status: 'unknown', reason, updatedAt: this.clock() });
      this.event('job-outcome-unknown', jobId, { reason }); return this.publicJob(next);
    });
  }

  markActionUnknown(actionId: string, reason: string): InspectionAction {
    return this.store.transaction(() => {
      const action = this.action(actionId);
      if (terminalActions.has(action.status)) throw new Error('A terminal inspection action cannot become unknown');
      this.markUnknown(action.jobId, reason); return this.publicAction(this.action(actionId));
    });
  }

  openSession(jobId: string, input: Pick<InspectionSession, 'processIdentity' | 'simulatorId'> & { id?: string } = {}): InspectionSession {
    return this.store.transaction(() => {
      const job = this.currentJob(jobId);
      if (!['preparing', 'running'].includes(job.status)) throw new Error('Inspection job is not admitted');
      if (job.sessionId) throw new Error('Inspection job already owns a session; reconcile it before replacement');
      const at = this.clock();
      const session: InspectionSession = { id: input.id ?? randomUUID(), jobId, authority: job.authority, ownerDeviceId: job.ownerDeviceId, executionTargetId: job.executionTargetId, capability: job.capability, source: job.source, status: 'starting', createdAt: at, updatedAt: at, ...(input.processIdentity ? { processIdentity: input.processIdentity } : {}), ...(input.simulatorId ? { simulatorId: input.simulatorId } : {}) };
      if (this.store.get(B.sessions, session.id)) throw new Error('Inspection session identifier is already owned');
      this.store.set(B.sessions, session); this.store.set(B.jobs, { ...job, sessionId: session.id, updatedAt: at });
      this.event('session-opened', session.id, { jobId }); return session;
    });
  }

  markSessionReady(sessionId: string, identity: Pick<InspectionSession, 'processIdentity' | 'simulatorId'> = {}): InspectionSession {
    return this.store.transaction(() => {
      const session = this.session(sessionId); this.currentJob(session.jobId);
      if (!['starting', 'waiting'].includes(session.status)) throw new Error('Inspection session cannot become ready without reconciliation');
      const ready: InspectionSession = { ...session, ...identity, status: 'ready', reason: undefined, updatedAt: this.clock() };
      this.store.set(B.sessions, ready); this.event('session-ready', sessionId, {}); return ready;
    });
  }

  confirmSessionRestarted(sessionId: string, input: { previousProcessExited: true; processIdentity?: InspectionSession['processIdentity']; simulatorId?: string }): InspectionSession {
    return this.store.transaction(() => {
      const session = this.session(sessionId); this.currentJob(session.jobId);
      if (input.previousProcessExited !== true || session.status !== 'ready') throw new Error('Native restart requires confirmed previous process exit and the same ready owned session');
      const restart = this.actions(sessionId).reverse().find(action => action.kind === 'restart');
      if (!restart || !['running', 'succeeded'].includes(restart.status)) throw new Error('Native restart has no matching journaled effect');
      if (input.processIdentity && (!Number.isSafeInteger(input.processIdentity.pid) || input.processIdentity.pid < 1 || !Number.isFinite(Date.parse(input.processIdentity.startedAt)))) throw new Error('Native restart requires a valid new owned process identity');
      const next: InspectionSession = { ...session, ...(input.processIdentity ? { processIdentity: input.processIdentity } : {}), ...(input.simulatorId ? { simulatorId: input.simulatorId } : {}), latestObservationId: undefined, updatedAt: this.clock() };
      this.store.set(B.sessions, next); this.event('session-restarted', sessionId, { actionId: restart.id, previousProcessExited: true, processIdentity: next.processIdentity }); return next;
    });
  }

  beginAction(token: string, sessionId: string, input: BeginInspectionAction): { action: InspectionAction; execute: boolean } {
    return this.store.transaction(() => {
      const session = this.session(sessionId), job = this.currentJob(session.jobId), grant = this.authorize(token, job.capability, job.executionTargetId);
      if (grant.id !== job.grantId) throw new Error('Inspection session belongs to a different authority grant');
      nonblank(input.idempotencyKey, 'action idempotency key'); bounded(input.arguments);
      if (!actionKinds.includes(input.kind)) throw new Error('Unsupported inspection action');
      const requestHash = digest(canonical({ kind: input.kind, arguments: input.arguments, observationId: input.observationId ?? null }));
      const prior = this.store.list<ActionRecord>(B.actions).find(action => action.sessionId === sessionId && action.requestKey === input.idempotencyKey);
      if (prior) { if (prior.requestHash !== requestHash) throw new Error('Inspection action idempotency key was reused for different inputs'); return { action: this.publicAction(prior), execute: false }; }
      if (this.actions(sessionId).some(action => !terminalActions.has(action.status))) throw new Error('An inspection action has an unresolved outcome; reconcile it before another effect');
      if (session.status !== 'ready' && !(input.kind === 'start' && session.status === 'starting') && !(input.kind === 'stop' && ['starting', 'waiting'].includes(session.status))) throw new Error('Inspection session is not ready');
      if (freshInput.has(input.kind)) this.validateObservation(session, input);
      const at = this.clock(), action: ActionRecord = { id: randomUUID(), jobId: job.id, sessionId, authority: job.authority, kind: input.kind, arguments: structuredClone(input.arguments), ...(input.observationId ? { observationId: input.observationId } : {}), status: 'requested', requestKey: input.idempotencyKey, requestHash, createdAt: at, updatedAt: at };
      this.store.set(B.actions, action);
      if (invalidatesObservation.has(input.kind)) this.store.set(B.sessions, { ...session, latestObservationId: undefined, updatedAt: at });
      this.event('action-requested', action.id, { jobId: job.id, sessionId, kind: input.kind }); return { action: this.publicAction(action), execute: true };
    });
  }

  markActionRunning(actionId: string): InspectionAction {
    return this.store.transaction(() => {
      const action = this.action(actionId); this.currentJob(action.jobId);
      if (action.status !== 'requested') throw new Error('Inspection action has already started or needs reconciliation');
      const running = { ...action, status: 'running' as const, updatedAt: this.clock() };
      this.store.set(B.actions, running); this.event('action-running', actionId, {}); return this.publicAction(running);
    });
  }

  actionComplete(actionId: string, input: { status: 'succeeded' | 'failed'; reason?: string; evidenceIds?: string[] }): InspectionAction {
    return this.store.transaction(() => {
      const action = this.action(actionId); this.currentJob(action.jobId);
      if (!['requested', 'running'].includes(action.status)) throw new Error('Inspection action completion is stale or requires reconciliation');
      for (const id of input.evidenceIds ?? []) if (this.store.get<InspectionEvidence>(B.evidence, id)?.actionId !== actionId) throw new Error('Inspection action evidence belongs to another effect');
      const completed = { ...action, ...input, updatedAt: this.clock() };
      this.store.set(B.actions, completed); this.event('action-completed', actionId, { status: input.status }); return this.publicAction(completed);
    });
  }

  recordObservation(actionId: string, input: Omit<InspectionObservation, 'id' | 'sessionId' | 'actionId' | 'createdAt'>): InspectionObservation {
    return this.store.transaction(() => {
      const action = this.action(actionId), job = this.currentJob(action.jobId), session = this.session(action.sessionId);
      if (!['observe', 'screenshot'].includes(action.kind) || !['requested', 'running'].includes(action.status)) throw new Error('Only an active observation action can record a fresh observation');
      bounded(input, 131_072);
      if (input.elementIds && (input.elementIds.length > 2000 || new Set(input.elementIds).size !== input.elementIds.length || input.elementIds.some(id => typeof id !== 'string' || id.length > 512))) throw new Error('Invalid observation element identities');
      if (input.viewport && (!Number.isFinite(input.viewport.width) || !Number.isFinite(input.viewport.height) || !Number.isFinite(input.viewport.scale) || input.viewport.width <= 0 || input.viewport.height <= 0 || input.viewport.scale <= 0)) throw new Error('Invalid observation viewport');
      if (input.screenshotEvidenceId) {
        const evidence = this.store.get<InspectionEvidence>(B.evidence, input.screenshotEvidenceId);
        if (!evidence || evidence.jobId !== job.id || evidence.sessionId !== session.id || evidence.kind !== 'screenshot' || !sameAuthority(evidence.authority, job.authority)) throw new Error('Observation screenshot is not owned by this session');
      }
      const prior = this.store.list<InspectionObservation>(B.observations).find(value => value.actionId === actionId);
      if (prior) throw new Error('Observation action already has an immutable result');
      const observation: InspectionObservation = { ...structuredClone(input), id: randomUUID(), sessionId: session.id, actionId, createdAt: this.clock() };
      this.store.set(B.observations, observation); this.store.set(B.sessions, { ...session, latestObservationId: observation.id, updatedAt: this.clock() });
      this.event('observation-recorded', observation.id, { jobId: job.id, actionId }); return observation;
    });
  }

  publishEvidence(jobId: string, input: Omit<InspectionEvidence, 'id' | 'jobId' | 'authority' | 'source' | 'createdAt'>): InspectionEvidence {
    return this.store.transaction(() => {
      const job = this.currentJob(jobId); bounded(input.metadata ?? {});
      if (terminalJobs.has(job.status)) throw new Error('Inspection job has already ended');
      if (!/^[a-f0-9]{64}$/.test(input.artifact.sha256) || !Number.isSafeInteger(input.artifact.size) || input.artifact.size < 0 || input.artifact.deviceId !== this.options.deviceId) throw new Error('Invalid inspection artifact identity');
      if (input.artifact.goalId !== job.authority.goalId || input.artifact.taskId !== job.authority.taskId || input.artifact.attemptId !== job.authority.attemptId) throw new Error('Inspection artifact does not belong to this author attempt');
      if (input.sessionId && this.session(input.sessionId).jobId !== job.id) throw new Error('Inspection evidence session belongs to another job');
      if (input.actionId) {
        const action = this.action(input.actionId);
        if (action.jobId !== job.id || action.sessionId !== input.sessionId || !['requested', 'running'].includes(action.status)) throw new Error('Inspection evidence action is stale or belongs to another session');
      }
      const evidence: InspectionEvidence = { ...structuredClone(input), id: randomUUID(), jobId, authority: job.authority, source: job.source, createdAt: this.clock() };
      this.store.set(B.evidence, evidence); this.event('evidence-published', evidence.id, { jobId, artifactId: input.artifact.id, kind: input.kind }); return evidence;
    });
  }

  requestCancel(token: string, jobId: string, reason = 'Cancellation requested'): InspectionJob {
    return this.store.transaction(() => {
      const grant = this.authorize(token), job = this.job(jobId);
      if (job.grantId !== grant.id) throw new Error('Inspection job belongs to another authority grant');
      return this.publicJob(this.cancel(job, reason));
    });
  }

  /** Owner cleanup after an authenticated coordinator retirement; it cannot authorize another agent effect. */
  cancelOwnerJob(jobId: string, reason = 'The coordinator retired this author assignment'): InspectionJob {
    return this.store.transaction(() => this.publicJob(this.cancel(this.job(jobId), reason)));
  }

  /** Positive backend acknowledgement only; a timeout or lost socket is not confirmation. */
  confirmCanceled(jobId: string, reason = 'Owning backend confirmed termination'): InspectionJob {
    return this.reconcileJob(jobId, { status: 'canceled', reason, releaseConfirmed: true });
  }

  finishJob(jobId: string, input: { status: 'succeeded' | 'failed'; reason?: string }): InspectionJob {
    return this.store.transaction(() => {
      const job = this.currentJob(jobId);
      if (terminalJobs.has(job.status)) throw new Error('Inspection job has already ended');
      this.assertQuiescent(jobId);
      return this.finalize(job, input.status, input.reason);
    });
  }

  /** Session cleanup is trusted owner bookkeeping, permitted even after author authority was revoked. */
  confirmSessionStopped(sessionId: string, reason?: string): InspectionSession {
    return this.store.transaction(() => {
      const session = this.session(sessionId), stopped: InspectionSession = { ...session, status: 'stopped', latestObservationId: undefined, reason, updatedAt: this.clock() };
      this.store.set(B.sessions, stopped); this.event('session-stopped', sessionId, { reason }); return stopped;
    });
  }

  /** No automatic retry on startup. Unknown sessions and effects retain their exact leases. */
  recoverAfterRestart(): InspectionJob[] {
    return this.store.transaction(() => {
      const recovered: InspectionJob[] = [];
      for (const job of this.store.list<JobRecord>(B.jobs)) {
        if (job.ownerDeviceId !== this.options.deviceId) continue;
        if (terminalJobs.has(job.status) || job.status === 'queued') continue;
        const reason = 'Service restarted; reconcile the owned backend before continuing';
        const next = { ...job, status: 'unknown' as const, reason, updatedAt: this.clock() };
        this.store.set(B.jobs, next); recovered.push(this.publicJob(next));
        for (const session of this.sessions(job.id)) if (!['stopped', 'failed'].includes(session.status)) this.store.set(B.sessions, { ...session, status: 'unknown', latestObservationId: undefined, reason, updatedAt: this.clock() });
        for (const action of this.store.list<ActionRecord>(B.actions).filter(value => value.jobId === job.id)) if (!terminalActions.has(action.status)) this.store.set(B.actions, { ...action, status: 'unknown', reason, updatedAt: this.clock() });
        this.event('job-recovery-required', job.id, { reason });
      }
      return recovered;
    });
  }

  /** Backend discovery may restore the same owned session, never a newly launched replacement. */
  reconcileSession(sessionId: string, input: { status: 'ready' | 'waiting' | 'stopped' | 'failed'; reason?: string; identityConfirmed: true }): InspectionSession {
    return this.store.transaction(() => {
      const session = this.session(sessionId);
      if (input.identityConfirmed !== true) throw new Error('Session reconciliation requires confirmed backend identity');
      if (['ready', 'waiting'].includes(input.status)) this.assertAuthority(session.authority);
      const next: InspectionSession = { ...session, status: input.status, latestObservationId: undefined, reason: input.reason, updatedAt: this.clock() };
      this.store.set(B.sessions, next); this.event('session-reconciled', sessionId, { status: input.status }); return next;
    });
  }

  reconcileAction(actionId: string, input: { status: 'succeeded' | 'failed' | 'canceled'; reason: string; outcomeConfirmed: true }): InspectionAction {
    return this.store.transaction(() => {
      const action = this.action(actionId);
      if (input.outcomeConfirmed !== true || !['unknown', 'cancellation-requested'].includes(action.status)) throw new Error('Only an unresolved action can accept a confirmed reconciled outcome');
      // Revoked work may be retained as canceled/failed, but cannot acquire new successful evidence.
      if (input.status === 'succeeded' && !this.jobAuthorityCurrent(this.job(action.jobId))) throw new Error('Reconciled success belongs to stale inspection authority');
      const next = { ...action, status: input.status, reason: input.reason, updatedAt: this.clock() };
      this.store.set(B.actions, next); this.event('action-reconciled', actionId, { status: input.status }); return this.publicAction(next);
    });
  }

  reconcileJob(jobId: string, input: { status: 'running' | 'waiting' | 'failed' | 'canceled'; reason?: string; releaseConfirmed?: boolean }): InspectionJob {
    return this.store.transaction(() => {
      const job = this.job(jobId);
      if (terminalJobs.has(job.status)) return this.publicJob(job);
      if (input.status === 'running' || input.status === 'waiting') {
        this.assertAuthority(job.authority);
        if (!this.jobAuthorityCurrent(job)) throw new Error('Inspection grant is expired or revoked');
        if (this.store.list<InspectionAction>(B.actions).some(action => action.jobId === jobId && ['unknown', 'cancellation-requested'].includes(action.status))) throw new Error('Reconcile inspection actions before resuming the job');
        if (this.sessions(jobId).some(session => ['unknown', 'stopping'].includes(session.status))) throw new Error('Reconcile inspection session ownership before resuming the job');
        const next = { ...job, status: input.status, reason: input.reason, updatedAt: this.clock() };
        this.store.set(B.jobs, next); this.event('job-reconciled', jobId, { status: input.status }); return this.publicJob(next);
      }
      if (input.releaseConfirmed !== true) throw new Error('Unknown or canceled inspection resources require positive backend termination confirmation');
      for (const session of this.sessions(jobId)) this.confirmSessionStopped(session.id, input.reason);
      // Process termination proves the reservation is free, not that an input never took effect.
      for (const action of this.store.list<ActionRecord>(B.actions).filter(action => action.jobId === jobId && !terminalActions.has(action.status))) this.store.set(B.actions, { ...action, status: 'unknown', reason: `${input.reason ?? 'Owned backend terminated'}; action outcome remains unconfirmed`, updatedAt: this.clock() });
      return this.finalize(job, input.status, input.reason);
    });
  }

  getJob(id: string): InspectionJob | undefined { const job = this.store.get<JobRecord>(B.jobs, id); return job && this.publicJob(job); }
  listJobs(authority?: InspectionAuthority): InspectionJob[] { return this.store.list<JobRecord>(B.jobs).filter(job => !authority || sameAuthority(job.authority, authority)).map(job => this.publicJob(job)); }
  getSession(id: string): InspectionSession | undefined { return this.store.get<InspectionSession>(B.sessions, id); }
  sessions(jobId: string): InspectionSession[] { return this.store.list<InspectionSession>(B.sessions).filter(session => session.jobId === jobId); }
  actions(sessionId: string): InspectionAction[] { return this.store.list<ActionRecord>(B.actions).filter(action => action.sessionId === sessionId).map(action => this.publicAction(action)); }
  evidence(jobId: string): InspectionEvidence[] { return this.store.list<InspectionEvidence>(B.evidence).filter(evidence => evidence.jobId === jobId); }
  observation(id: string): InspectionObservation | undefined { return this.store.get<InspectionObservation>(B.observations, id); }
  leases(jobId?: string): InspectionLease[] { return this.store.list<InspectionLease>(B.leases).filter(lease => !jobId || lease.jobId === jobId); }

  private assertAuthority(authority: InspectionAuthority): void {
    for (const field of ['goalId', 'taskId', 'attemptId'] as const) nonblank(authority[field], field);
    for (const field of ['goalRevision', 'authorityGeneration', 'policyRevision'] as const) if (!Number.isSafeInteger(authority[field]) || authority[field] < 0) throw new Error(`Invalid inspection ${field}`);
    if (!this.options.authorityCurrent(authority)) throw new Error('Inspection author authority is stale');
  }
  private jobAuthorityCurrent(job: JobRecord): boolean {
    const grant = this.store.get<GrantRecord>(B.grants, job.grantId);
    return Boolean(grant && !grant.revokedAt && Date.parse(grant.expiresAt) > Date.parse(this.clock()) && sameAuthority(grant.authority, job.authority) && this.options.authorityCurrent(job.authority));
  }
  private job(id: string): JobRecord { const job = this.store.get<JobRecord>(B.jobs, id); if (!job) throw new Error('Inspection job was not found'); if (job.ownerDeviceId !== this.options.deviceId) throw new Error('Paired inspection jobs are read projections; only their original owner may mutate them'); return job; }
  private currentJob(id: string): JobRecord { const job = this.job(id); if (!this.jobAuthorityCurrent(job)) throw new Error('Inspection job authority is stale, expired or revoked'); if (['cancellation-requested', 'unknown'].includes(job.status)) throw new Error('Inspection job needs cancellation or outcome reconciliation'); return job; }
  private session(id: string): InspectionSession { const session = this.getSession(id); if (!session) throw new Error('Inspection session was not found'); this.job(session.jobId); return session; }
  private action(id: string): ActionRecord { const action = this.store.get<ActionRecord>(B.actions, id); if (!action) throw new Error('Inspection action was not found'); this.job(action.jobId); return action; }
  private publicJob({ grantId: _grant, requestKey: _key, requestHash: _hash, queueSequence: _sequence, resources: _resources, ...job }: JobRecord): InspectionJob { return job; }
  private publicAction({ requestKey: _key, requestHash: _hash, ...action }: ActionRecord): InspectionAction { return action; }
  private publicGrant({ tokenHash: _hash, ...grant }: GrantRecord): InspectionGrant { return grant; }
  private event(kind: string, entity: string, value: unknown): number { return this.store.append('inspection-journal', entity, { kind, at: this.clock(), value }); }
  private validateSource(source: InspectionSourceIdentity): void {
    nonblank(source.snapshotId, 'source snapshot');
    if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Inspection source requires a complete immutable snapshot digest');
    for (const root of source.roots ?? []) { nonblank(root.id, 'source root'); if (!/^[a-f0-9]{64}$/.test(root.sha256)) throw new Error('Invalid inspection root digest'); }
    if (new Set(source.roots?.map(root => root.id)).size !== (source.roots?.length ?? 0)) throw new Error('Duplicate inspection source root');
    bounded(source);
  }
  private validateResources(resources: InspectionLeaseRequest[]): InspectionLeaseRequest[] {
    if (!resources.length || resources.length > 4) throw new Error('Inspection jobs need a bounded resource reservation');
    const keys = new Set<string>();
    const validated = resources.map(resource => {
      if (!pools.includes(resource.pool)) throw new Error('Unknown inspection resource pool');
      const units = resource.units ?? 1, key = resource.key ?? this.options.deviceId;
      nonblank(key, 'resource identity');
      if (!Number.isSafeInteger(units) || units < 1 || units > this.capacities[resource.pool]) throw new Error('Inspection resource request exceeds configured capacity');
      const identity = `${resource.pool}:${key}`; if (keys.has(identity)) throw new Error('Duplicate inspection resource request'); keys.add(identity);
      return { pool: resource.pool, key, units };
    });
    for (const pool of pools) if (validated.filter(resource => resource.pool === pool).reduce((sum, resource) => sum + resource.units, 0) > this.capacities[pool]) throw new Error('Combined inspection resource request exceeds configured capacity');
    return validated;
  }
  private defaultPool(capability: ExecutionCapability): InspectionLeasePool {
    if (capability === 'chromium-inspection') return 'browser';
    if (capability === 'macos-app-inspection') return 'native-desktop';
    if (capability === 'ios-simulator-inspection') return 'ios-simulator';
    return 'apple-build';
  }
  private canAcquire(requests: InspectionLeaseRequest[]): boolean {
    const held = this.leases().filter(lease => lease.status === 'held');
    if (requests.some(request => request.pool === 'ios-simulator' && held.some(lease => lease.pool === 'ios-simulator' && lease.key === (request.key ?? this.options.deviceId)))) return false;
    return pools.every(pool => held.filter(lease => lease.pool === pool).reduce((sum, lease) => sum + lease.units, 0) + requests.filter(request => request.pool === pool).reduce((sum, request) => sum + (request.units ?? 1), 0) <= this.capacities[pool]);
  }
  private validateObservation(session: InspectionSession, action: BeginInspectionAction): void {
    if (!action.observationId || action.observationId !== session.latestObservationId) throw new Error('Stale inspection observation; observe the current interface before acting');
    const observation = this.observation(action.observationId);
    if (!observation || observation.sessionId !== session.id) throw new Error('Inspection observation belongs to another session');
    if (action.arguments.elementId !== undefined && (typeof action.arguments.elementId !== 'string' || !observation.elementIds?.includes(action.arguments.elementId))) throw new Error('Element is absent from the fresh inspection observation');
    if (action.arguments.x !== undefined || action.arguments.y !== undefined) {
      if (!observation.screenshotEvidenceId || !observation.viewport || canonical(action.arguments.viewport ?? null) !== canonical(observation.viewport)) throw new Error('Coordinate input requires this observation screenshot and matching viewport');
      const { x, y } = action.arguments;
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= observation.viewport.width || y >= observation.viewport.height) throw new Error('Coordinate input is outside the observed viewport');
    }
  }
  private cancel(job: JobRecord, reason: string): JobRecord {
    if (terminalJobs.has(job.status)) return job;
    if (job.status === 'queued') { this.finalize(job, 'canceled', reason); return this.job(job.id); }
    const canceled = { ...job, status: 'cancellation-requested' as const, reason, updatedAt: this.clock() };
    this.store.set(B.jobs, canceled);
    for (const action of this.store.list<ActionRecord>(B.actions).filter(action => action.jobId === job.id && !terminalActions.has(action.status))) this.store.set(B.actions, { ...action, status: 'cancellation-requested', reason, updatedAt: this.clock() });
    this.event('job-cancellation-requested', job.id, { reason }); return canceled;
  }
  private transition(id: string, from: InspectionJob['status'][], to: InspectionJob['status'], reason?: string): InspectionJob {
    return this.store.transaction(() => { const job = this.currentJob(id); if (!from.includes(job.status)) throw new Error('Invalid inspection job transition'); const next = { ...job, status: to, reason, updatedAt: this.clock() }; this.store.set(B.jobs, next); this.event(`job-${to}`, id, { reason }); return this.publicJob(next); });
  }
  private assertQuiescent(jobId: string): void {
    if (this.sessions(jobId).some(session => !['stopped', 'failed'].includes(session.status)) || this.store.list<InspectionAction>(B.actions).some(action => action.jobId === jobId && !terminalActions.has(action.status))) throw new Error('Inspection resources still have a live or unknown owner');
  }
  private finalize(job: JobRecord, status: 'succeeded' | 'failed' | 'canceled', reason?: string): InspectionJob {
    const at = this.clock(), next = { ...job, status, reason, updatedAt: at };
    for (const lease of this.leases(job.id)) if (lease.status === 'held') this.store.set(B.leases, { ...lease, status: 'released', releasedAt: at });
    this.store.set(B.jobs, next); this.event('job-ended', job.id, { status, reason }); return this.publicJob(next);
  }
}
