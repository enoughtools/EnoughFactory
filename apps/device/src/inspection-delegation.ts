import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Attempt, FactoryTask, Goal, InspectionAction, InspectionAuthority, InspectionEvidence, InspectionJob, InspectionSession, InspectionSourceIdentity, Project } from '@enoughfactory/contracts';
import { exportInspectionSnapshot, type ArtifactStore, type InspectionSnapshot } from '@enoughfactory/workspaces';
import type { PeerManager } from '@enoughfactory/peers';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext } from './chats.ts';
import type { InspectionJobs, InspectionObservation } from './inspection-jobs.ts';
import type { InspectionJournalPage, InspectionJournalEvent } from './inspection-delegation-journal.ts';
import type { NativeFixtureProfile, NativeInspectionAdapter } from './inspection-native.ts';
import type { NativeBuildRunner } from './inspection-build-runner.ts';
import { NativeDelegationOwner } from './inspection-delegation-owner.ts';
import { InspectionRemote, RemoteInspectionOutcomeUnknown, type MaterializedInspectionReply, type RemoteInspectionAssignmentInput, type RemoteInspectionHandle, type RemoteInspectionOperation } from './inspection-remote.ts';
import { HttpError } from './util.ts';

const buckets = { bindings: 'inspection-delegation-private-bindings', jobs: 'inspection-delegation-author-jobs', sessions: 'inspection-delegation-author-sessions', requests: 'inspection-delegation-author-requests', projections: 'inspection-delegation-projections', cursors: 'inspection-delegation-journal-cursors', events: 'inspection-delegation-imported-events' };
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: unknown) => ({ type: 'text' as const, text: JSON.stringify(value) });
interface Binding { id: string; authority: InspectionAuthority; handle: RemoteInspectionHandle; input: RemoteInspectionAssignmentInput; }
interface BindingRef { id: string; bindingId: string; authority: InspectionAuthority; }
interface RequestRef extends BindingRef { requestId: string; }
interface Projection { id: string; job: InspectionJob; sessions: InspectionSession[]; evidence: InspectionEvidence[]; }
export interface InspectionDelegationOptions {
  app: DeviceApp; peers: Pick<PeerManager, 'request' | 'uploadArtifact'>; jobs: InspectionJobs;
  native: NativeInspectionAdapter; artifacts: ArtifactStore;
  builds: Pick<NativeBuildRunner, 'build' | 'cancel' | 'recover'>;
  profiles(projectId: string): NativeFixtureProfile[];
  /** Local task/worker authority only, excluding acceptedAuthorityCurrent to avoid recursive validation. */
  localAuthorityCurrent(authority: InspectionAuthority): boolean;
  capture(context: AgentToolBridgeContext, authority: InspectionAuthority): Promise<InspectionSnapshot | { snapshot: InspectionSnapshot; source: InspectionSourceIdentity }>;
  platform?: NodeJS.Platform;
}
interface RemoteProfile { id: string; platform: 'macos' | 'ios-simulator'; }

/** Connects the live service tool route to authenticated paired native owners. */
export class InspectionDelegation {
  readonly remote: InspectionRemote;
  readonly owner: NativeDelegationOwner;
  private initialized = false;
  private authorityTimer?: ReturnType<typeof setInterval>;
  private sweeping?: Promise<void>;
  private readonly journalSyncs = new Map<string, Promise<void>>();
  constructor(private readonly options: InspectionDelegationOptions) {
    let remote!: InspectionRemote;
    this.owner = new NativeDelegationOwner({ app: options.app, jobs: options.jobs, native: options.native, builds: options.builds, artifacts: options.artifacts, profiles: options.profiles, refreshAuthority: id => remote.refreshAuthority(id) });
    remote = this.remote = new InspectionRemote({ store: options.app.store, deviceId: options.app.device.id, artifacts: options.artifacts, peers: options.peers,
      isPairedDevice: id => this.paired(id), authorityCurrent: options.localAuthorityCurrent,
      authorOwnsAuthority: (authority, author) => this.authorOwnsAuthority(authority, author),
      verifySourceIdentity: (...args) => this.owner.verifySourceIdentity(...args), execute: (...args) => this.owner.execute(...args), reconcile: (...args) => this.owner.reconcile(...args), authorityRetired: (assignment, reason) => this.owner.retireAssignment(assignment.id, reason) });
  }
  initialize(): void {
    if (this.initialized) return; this.initialized = true; this.remote.recoverAfterRestart();
    this.options.app.extensions.push(async ({ method, url, body, peerId }) => {
      if (method !== 'POST' || url.pathname !== '/api/inspection/delegated') return undefined;
      if (body.op === 'profiles') {
        if (!peerId || !this.paired(peerId)) throw new HttpError(403, 'Native testing profiles are available only to paired execution devices.');
        if (typeof body.projectId !== 'string' || body.projectId.length > 128) throw new HttpError(400, 'Select a project for native testing.');
        return { profiles: this.options.profiles(body.projectId).map(profile => ({ id: profile.id, platform: profile.build.tool === 'xcodebuild' ? profile.build.platform : 'macos' })) };
      }
      return this.remote.handle(peerId, body);
    });
    this.options.app.serviceActivityHooks.push(() => this.owner.activity());
    this.authorityTimer = setInterval(() => { void this.reconcileOwnerAuthority(); }, 10_000); this.authorityTimer.unref();
  }
  acceptedAuthorityCurrent(authority: InspectionAuthority): boolean { return this.remote.acceptedAuthorityCurrent(authority); }

  async capabilities(projectId: string): Promise<unknown[]> {
    const targets: unknown[] = [];
    for (const device of this.nativeOwners()) {
      let profiles: RemoteProfile[] = [];
      try { profiles = await this.remoteProfiles(device.id, projectId); } catch { /* Preserve the probed device state; profile discovery can return after reconnect. */ }
      targets.push({ deviceId: device.id, name: device.name, executionTargets: device.executionTargets, profiles });
    }
    return targets;
  }

  /** Return undefined for tools owned by the local service, otherwise a real MCP response. */
  async dispatch(context: AgentToolBridgeContext, token: string, name: string, args: Record<string, unknown>): Promise<unknown | undefined> {
    const authority = this.options.jobs.authorize(token).authority;
    if (name === 'factory_native_build') return this.build(context, authority, args);
    const id = typeof args.jobId === 'string' ? args.jobId : typeof args.buildJobId === 'string' ? args.buildJobId : typeof args.sessionId === 'string' ? args.sessionId : undefined;
    if (!id) return undefined;
    const request = this.options.app.store.get<RequestRef>(buckets.requests, id);
    const ref = request ?? this.options.app.store.get<BindingRef>(buckets.jobs, id) ?? this.options.app.store.get<BindingRef>(buckets.sessions, id);
    if (!ref) return undefined;
    if (!sameAuthority(ref.authority, authority)) throw new HttpError(403, 'This native inspection belongs to another author attempt.');
    const binding = this.binding(ref.bindingId, authority);
    if (name === 'factory_job_status' && request) return this.queryRequest(binding, request);
    let operation: RemoteInspectionOperation;
    if (name === 'factory_job_status') operation = { name: 'status', arguments: { jobId: id } };
    else if (name === 'factory_native_start') operation = { name: 'start', arguments: { buildJobId: id } };
    else if (name === 'factory_observe') operation = { name: 'observe', arguments: { sessionId: id } };
    else if (name === 'factory_native_restart') operation = { name: 'restart', arguments: { sessionId: id, observationId: args.observationId } };
    else if (name === 'factory_stop') operation = { name: 'stop', arguments: { sessionId: id } };
    else if (name === 'factory_assert') operation = { name: 'run-tests', arguments: { sessionId: id, observationId: args.observationId, assertions: [{ labelIncludes: args.labelIncludes, ...(typeof args.valueIncludes === 'string' ? { valueIncludes: args.valueIncludes } : {}), ...(args.absent === true ? { absent: true } : {}) }] } };
    else if (name === 'factory_native_action') {
      const action = args.action as Record<string, unknown>;
      if (!action || !['click', 'type', 'key', 'scroll'].includes(String(action.kind))) throw new HttpError(400, 'Choose a supported native action.');
      operation = { name: action.kind as 'click' | 'type' | 'key' | 'scroll', arguments: { sessionId: id, observationId: args.observationId, action } };
    } else return undefined;
    const requestId = name === 'factory_job_status' ? `status-${randomUUID()}` : typeof args.requestId === 'string' ? args.requestId : `${operation.name}-${sha(operation.arguments).slice(0, 48)}`;
    return this.invoke(binding, requestId, operation);
  }

  taskInspection(taskId: string): { jobs: InspectionJob[]; sessions: InspectionSession[]; evidence: InspectionEvidence[] } {
    const projections = this.options.app.store.list<Projection>(buckets.projections).filter(value => value.job.authority.taskId === taskId);
    return { jobs: projections.map(value => value.job), sessions: projections.flatMap(value => value.sessions), evidence: projections.flatMap(value => value.evidence) };
  }
  evidenceForAuthority(authority: InspectionAuthority): InspectionEvidence[] { return this.options.app.store.list<Projection>(buckets.projections).filter(value => sameAuthority(value.job.authority, authority)).flatMap(value => value.evidence); }
  async stopAuthoritySessions(authority: InspectionAuthority): Promise<void> {
    for (const projection of this.options.app.store.list<Projection>(buckets.projections).filter(value => sameAuthority(value.job.authority, authority))) for (const session of projection.sessions.filter(session => ['ready', 'unknown', 'waiting'].includes(session.status))) {
      const ref = this.options.app.store.get<BindingRef>(buckets.sessions, session.id); if (!ref) continue;
      try { await this.invoke(this.binding(ref.bindingId, authority), `stop-${sha(session.id).slice(0, 48)}`, { name: 'stop', arguments: { sessionId: session.id } }); }
      catch (error) { this.options.app.emit('inspection-error', { jobId: projection.job.id, error: error instanceof Error ? error.message : 'The paired native owner has not confirmed termination.' }); }
    }
  }
  /** Active owner work learns positive retirement even if the disconnected author cannot ask it to stop. */
  reconcileOwnerAuthority(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const ids = new Set(this.options.jobs.listJobs().filter(job => job.ownerDeviceId === this.options.app.device.id && !['succeeded', 'failed', 'canceled'].includes(job.status))
      .map(job => this.options.app.store.get<{ id: string; assignmentId: string }>('inspection-delegation-owner-jobs', job.id)?.assignmentId).filter((id): id is string => Boolean(id)));
    this.sweeping = Promise.allSettled([...ids].map(id => this.remote.refreshAuthority(id))).then(() => this.owner.reconcileBuilds()).finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }
  async close(): Promise<void> { if (this.authorityTimer) clearInterval(this.authorityTimer); await this.sweeping; await this.owner.close(); }

  private async build(context: AgentToolBridgeContext, authority: InspectionAuthority, args: Record<string, unknown>): Promise<unknown | undefined> {
    const project = this.options.app.store.get<Project>('projects', context.session.projectId), projectId = project?.sourceProjectId ?? project?.id;
    if (!projectId || typeof args.profileId !== 'string' || typeof args.requestId !== 'string') throw new HttpError(400, 'Native build requires a configured project profile and stable request identity.');
    const localProfile = this.options.profiles(projectId).find(profile => profile.id === args.profileId);
    if ((this.options.platform ?? process.platform) === 'darwin' && localProfile?.build.tool === 'xcodebuild' && (await this.options.native.readiness(localProfile.build.platform)).status === 'ready') return undefined;
    const bindingId = sha([authority, args.requestId]), saved = this.options.app.store.get<Binding>(buckets.bindings, bindingId);
    if (saved) {
      if (!sameAuthority(saved.authority, authority) || saved.input.profile.profileId !== args.profileId) throw new HttpError(409, 'Native build request identity was reused for another profile.');
      return this.invoke(saved, args.requestId, { name: 'build', arguments: { profileId: args.profileId } });
    }
    let selected: { deviceId: string; targetId: string; profile: RemoteProfile } | undefined;
    for (const device of this.nativeOwners()) {
      let profiles: RemoteProfile[];
      try { profiles = await this.remoteProfiles(device.id, projectId); } catch { continue; }
      const profile = profiles.find(profile => profile.id === args.profileId); if (!profile) continue;
      const capability = profile.platform === 'macos' ? 'macos-app-inspection' : 'ios-simulator-inspection';
      const target = device.executionTargets?.find(target => target.kind === 'host-macos' && target.protocolVersion === 1 && target.capabilities.some(item => item.kind === 'apple-compilation' && ['ready', 'preparing'].includes(item.readiness)) && target.capabilities.some(item => item.kind === capability && ['ready', 'preparing', 'busy'].includes(item.readiness)));
      if (target) { selected = { deviceId: device.id, targetId: target.id, profile }; break; }
    }
    if (!selected) {
      if ((this.options.platform ?? process.platform) === 'darwin' && localProfile) return undefined;
      return { content: [text({ status: 'waiting', reason: 'Native work needs a paired Mac with a ready build toolchain and the selected isolated test profile.', setupAction: 'Pair a Mac in Devices and configure this project’s native testing profile on that Mac.', profileId: args.profileId })] };
    }
    const captured = await this.options.capture(context, authority), snapshot = 'snapshot' in captured ? captured.snapshot : captured;
    const source: InspectionSourceIdentity = 'source' in captured ? captured.source : { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })) };
    if (source.snapshotId !== snapshot.id || source.sha256 !== snapshot.sourceDigest || !isDeepStrictEqual(source.roots?.map(root => ({ id: root.id, sha256: root.sha256 })), snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })))) throw new Error('The protected source identity differs from its captured native snapshot.');
    const transfer = await exportInspectionSnapshot({ snapshot, artifacts: this.options.artifacts, context: { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId }, signal: context.signal });
    const input: RemoteInspectionAssignmentInput = { authority, coordinatorId: this.coordinator(authority), authorDeviceId: this.options.app.device.id, ownerDeviceId: selected.deviceId, executionTargetId: selected.targetId,
      capability: selected.profile.platform === 'macos' ? 'macos-app-inspection' : 'ios-simulator-inspection', source,
      profile: { projectId, profileId: selected.profile.id }, sourceArtifacts: transfer.sourceArtifacts, sourceManifest: transfer.sourceManifest };
    const handle = await this.remote.delegate(input, bindingId), binding: Binding = { id: bindingId, authority, handle, input };
    this.options.app.store.set(buckets.bindings, binding); return this.invoke(binding, args.requestId, { name: 'build', arguments: { profileId: args.profileId } });
  }
  private async invoke(binding: Binding, requestId: string, operation: RemoteInspectionOperation): Promise<unknown> {
    const requestKey = `remote-request-${sha([binding.id, requestId]).slice(0, 48)}`;
    this.options.app.store.set<RequestRef>(buckets.requests, { id: requestKey, bindingId: binding.id, authority: binding.authority, requestId });
    try { const reply = await this.remote.invoke(binding.handle, requestId, operation); return await this.accept(binding, reply, requestKey); }
    catch (error) {
      if (!(error instanceof RemoteInspectionOutcomeUnknown)) throw error;
      return { content: [text({ jobId: requestKey, status: 'unknown', reason: error.message, ownerDeviceId: binding.handle.ownerDeviceId, requestId, source: binding.input.source, nextAction: 'Read this same job with factory_job_status; the original operation will not be replayed.' })] };
    } finally { this.options.app.store.set(buckets.bindings, binding); }
  }
  private async queryRequest(binding: Binding, request: RequestRef): Promise<unknown> {
    try { return await this.accept(binding, await this.remote.result(binding.handle, request.requestId), request.id); }
    catch (error) { if (!(error instanceof RemoteInspectionOutcomeUnknown)) throw error; return { content: [text({ jobId: request.id, status: 'unknown', reason: error.message })] }; }
    finally { this.options.app.store.set(buckets.bindings, binding); }
  }
  private async accept(binding: Binding, reply: MaterializedInspectionReply, requestKey: string): Promise<unknown> {
    const value = reply.value ?? {}, job = value.job as InspectionJob | undefined, sessions = Array.isArray(value.sessions) ? value.sessions as InspectionSession[] : [], evidence = Array.isArray(value.evidence) ? value.evidence as InspectionEvidence[] : [];
    if (job) {
      this.validateJob(binding, job);
      for (const session of sessions) this.validateSession(binding, job, session);
      for (const item of evidence) this.validateEvidence(binding, job, item);
      this.options.app.store.set<BindingRef>(buckets.jobs, { id: job.id, bindingId: binding.id, authority: binding.authority });
      for (const session of sessions) this.options.app.store.set<BindingRef>(buckets.sessions, { id: session.id, bindingId: binding.id, authority: binding.authority });
    }
    if (typeof value.sessionId === 'string') {
      const ref = this.options.app.store.get<BindingRef>(buckets.sessions, value.sessionId);
      if (!ref || ref.bindingId !== binding.id || !sameAuthority(ref.authority, binding.authority)) throw new Error('The paired result refers to a session outside its validated assignment.');
    }
    for (const artifact of reply.artifacts ?? []) this.options.app.store.set('factory-artifacts', artifact);
    const projected = job ?? (typeof value.sessionId === 'string' ? this.options.app.store.list<Projection>(buckets.projections).find(projection => projection.sessions.some(session => session.id === value.sessionId))?.job : undefined);
    if (projected && reply.status === 'completed') await this.syncJournal(binding, projected.id);
    this.options.app.changed();
    return { content: [...(reply.status === 'completed' ? [] : [text({ jobId: requestKey, status: reply.status, reason: reply.reason, ownerDeviceId: binding.handle.ownerDeviceId })]), ...reply.content], ...(reply.isError ? { isError: true } : {}) };
  }
  /** Only paired owner responses can populate these read records. Provider-authored reports never enter this path. */
  private async syncJournal(binding: Binding, jobId: string): Promise<void> {
    const key = sha([binding.handle.ownerDeviceId, jobId]);
    const previous = this.journalSyncs.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.syncJournalPages(binding, jobId));
    this.journalSyncs.set(key, next);
    try { await next; } finally { if (this.journalSyncs.get(key) === next) this.journalSyncs.delete(key); }
  }
  private async syncJournalPages(binding: Binding, jobId: string): Promise<void> {
    const cursorId = sha([binding.handle.ownerDeviceId, jobId]);
    let after = this.options.app.store.get<{ id: string; after: number }>(buckets.cursors, cursorId)?.after ?? 0;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber++) {
      const reply = await this.remote.invoke(binding.handle, `journal-${randomUUID()}`, { name: 'journal', arguments: { jobId, after } });
      if (reply.status !== 'completed' || reply.isError) throw new Error('The paired native journal is unavailable; its evidence cannot yet be submitted for acceptance.');
      const page = reply.value as unknown as InspectionJournalPage;
      if (!page || !Array.isArray(page.events) || !Array.isArray(page.sessions) || !Number.isSafeInteger(page.after) || page.after < after || typeof page.hasMore !== 'boolean') throw new Error('The paired native journal page is invalid.');
      this.validateJob(binding, page.job); if (page.job.id !== jobId) throw new Error('The paired native journal returned a different job.');
      const previousJob = this.options.app.store.get<InspectionJob>('inspection-jobs', jobId);
      if (previousJob && (previousJob.ownerDeviceId !== binding.handle.ownerDeviceId || !sameAuthority(previousJob.authority, binding.authority))) throw new Error('The paired journal cannot replace another device’s owned job.');
      for (const session of page.sessions) this.validateSession(binding, page.job, session);
      const records: NonNullable<InspectionJournalEvent['record']>[] = [];
      let previousSequence = after;
      for (const event of page.events) {
        if (!Number.isSafeInteger(event.seq) || event.seq <= previousSequence || event.seq > page.after || typeof event.entity !== 'string' || !event.value || typeof event.value.kind !== 'string' || typeof event.value.at !== 'string') throw new Error('The paired native journal sequence is invalid.');
        previousSequence = event.seq;
        let record = event.record;
        if (event.recordArtifact) {
          const original = await this.options.artifacts.get(event.recordArtifact.id);
          if (!isDeepStrictEqual(original, event.recordArtifact) || original.deviceId !== binding.handle.ownerDeviceId || original.goalId !== binding.authority.goalId || original.taskId !== binding.authority.taskId || original.attemptId !== binding.authority.attemptId || original.mime !== 'application/json' || original.size > 256 * 1024 || original.metadata?.purpose !== 'inspection-public-journal-record' || original.metadata.jobId !== jobId || original.metadata.entity !== event.entity || original.metadata.sourceDigest !== binding.input.source.sha256 || original.metadata.sha256 !== original.sha256) throw new Error('The paired broker record artifact differs from its original manifest.');
          record = JSON.parse((await this.options.artifacts.read(original)).toString('utf8')) as NonNullable<InspectionJournalEvent['record']>;
        }
        if (record) {
          this.validateRecord(binding, page.job, page.sessions, event, record); records.push(record);
          if (record.bucket === 'inspection-evidence') {
            const original = await this.options.artifacts.get(record.value.artifact.id);
            if (!isDeepStrictEqual(original, record.value.artifact)) throw new Error('The paired journal evidence differs from its original transferred artifact.');
          }
        }
        const expectedBucket = event.value.kind.startsWith('action-') ? 'inspection-actions' : event.value.kind === 'observation-recorded' ? 'inspection-observations' : event.value.kind === 'evidence-published' ? 'inspection-evidence' : undefined;
        if (expectedBucket && record?.bucket !== expectedBucket) throw new Error('The paired native journal omitted its original matching broker record.');
        if (!record && event.entity !== jobId && !page.sessions.some(session => session.id === event.entity)) throw new Error('The paired native journal event belongs to another job or session.');
        if (event.value.kind.startsWith('job-') && event.entity !== jobId) throw new Error('The paired native journal job event belongs to another job.');
        if (event.value.kind.startsWith('session-') && !page.sessions.some(session => session.id === event.entity)) throw new Error('The paired native journal session event belongs to another session.');
      }
      if (page.after !== previousSequence || (page.hasMore && !page.events.length)) throw new Error('The paired native journal cursor does not match its delivered events.');
      this.options.app.store.transaction(() => {
        if (!this.options.localAuthorityCurrent(binding.authority)) throw new Error('Native author authority was retired during journal import.');
        this.options.app.store.set('inspection-jobs', page.job);
        for (const session of page.sessions) this.options.app.store.set('inspection-sessions', session);
        for (const record of records) this.options.app.store.set(record.bucket, record.value);
        for (const event of [...page.events].sort((a, b) => a.seq - b.seq)) {
          const eventId = sha([binding.handle.ownerDeviceId, jobId, event.seq]);
          if (this.options.app.store.get(buckets.events, eventId)) continue;
          this.options.app.store.append('inspection-journal', event.entity, event.value);
          this.options.app.store.set(buckets.events, { id: eventId, jobId, ownerDeviceId: binding.handle.ownerDeviceId, ownerSequence: event.seq });
        }
        this.options.app.store.set(buckets.cursors, { id: cursorId, after: page.after });
        this.options.app.store.set<Projection>(buckets.projections, { id: jobId, job: page.job, sessions: page.sessions, evidence: this.options.app.store.list<InspectionEvidence>('inspection-evidence').filter(item => item.jobId === jobId) });
      });
      if (!page.hasMore) return;
      if (page.after === after) throw new Error('The paired native journal did not advance.');
      after = page.after;
    }
    throw new Error('The paired native journal is too large to synchronize in a single operation.');
  }
  private validateJob(binding: Binding, job: InspectionJob): void {
    if (!job || typeof job.id !== 'string' || job.ownerDeviceId !== binding.handle.ownerDeviceId || !sameAuthority(job.authority, binding.authority) || !isDeepStrictEqual(job.source, binding.input.source)) throw new Error('The paired native job has a different owner, authority or source.');
  }
  private validateSession(binding: Binding, job: InspectionJob, session: InspectionSession): void {
    if (!session || session.jobId !== job.id || session.ownerDeviceId !== binding.handle.ownerDeviceId || !sameAuthority(session.authority, binding.authority) || !isDeepStrictEqual(session.source, binding.input.source)) throw new Error('The paired native session differs from the immutable assignment.');
    const previous = this.options.app.store.get<InspectionSession>('inspection-sessions', session.id);
    if (previous && (previous.jobId !== job.id || previous.ownerDeviceId !== binding.handle.ownerDeviceId)) throw new Error('The paired native session cannot replace another owned session.');
  }
  private validateEvidence(binding: Binding, job: InspectionJob, item: InspectionEvidence): void {
    if (!item || item.jobId !== job.id || !sameAuthority(item.authority, binding.authority) || !isDeepStrictEqual(item.source, binding.input.source) || item.artifact.deviceId !== binding.handle.ownerDeviceId || item.artifact.goalId !== binding.authority.goalId || item.artifact.taskId !== binding.authority.taskId || item.artifact.attemptId !== binding.authority.attemptId) throw new Error('The paired evidence differs from the immutable assignment.');
  }
  private validateRecord(binding: Binding, job: InspectionJob, sessions: InspectionSession[], event: InspectionJournalEvent, record: NonNullable<InspectionJournalEvent['record']>): void {
    if (!record || !record.value || record.value.id !== event.entity || !['inspection-actions', 'inspection-observations', 'inspection-evidence'].includes(record.bucket)) throw new Error('The paired journal record is invalid.');
    if (record.bucket === 'inspection-actions') {
      const action = record.value as InspectionAction;
      if (action.jobId !== job.id || !sameAuthority(action.authority, binding.authority) || !sessions.some(session => session.id === action.sessionId)) throw new Error('The paired action differs from the assigned job/session.');
    } else if (record.bucket === 'inspection-evidence') this.validateEvidence(binding, job, record.value as InspectionEvidence);
    else if (!sessions.some(session => session.id === (record.value as InspectionObservation).sessionId)) throw new Error('The paired observation differs from the assigned session.');
    const previous = this.options.app.store.get<{ id: string; jobId?: string; sessionId?: string }>(record.bucket, record.value.id);
    if (previous && ((previous.jobId !== undefined && previous.jobId !== job.id) || (previous.sessionId !== undefined && !sessions.some(session => session.id === previous.sessionId)))) throw new Error('The paired journal cannot replace another owned broker record.');
  }
  private binding(id: string, authority: InspectionAuthority): Binding { const binding = this.options.app.store.get<Binding>(buckets.bindings, id); if (!binding || !sameAuthority(binding.authority, authority) || !this.options.localAuthorityCurrent(authority)) throw new HttpError(403, 'This delegated native session is no longer authorized.'); return binding; }
  private coordinator(authority: InspectionAuthority): string {
    const goal = this.options.app.store.get<Goal>('goals', authority.goalId); if (goal) return goal.coordinatorId;
    const worker = this.options.app.store.get<{ id: string; coordinatorId: string }>('factory-workers', authority.attemptId); if (worker) return worker.coordinatorId;
    throw new HttpError(409, 'The author has no current coordinator assignment.');
  }
  private authorOwnsAuthority(authority: InspectionAuthority, author: string): boolean {
    if (!this.options.localAuthorityCurrent(authority)) return false;
    const attempt = this.options.app.store.get<Attempt>('attempts', authority.attemptId), task = this.options.app.store.get<FactoryTask>('tasks', authority.taskId), goal = this.options.app.store.get<Goal>('goals', authority.goalId);
    return Boolean(attempt && task && goal && task.currentAttemptId === attempt.id && attempt.deviceId === author && goal.coordinatorId === this.options.app.device.id);
  }
  private nativeOwners() { return this.options.app.devices.filter(device => device.id !== this.options.app.device.id && device.online && this.paired(device.id) && device.executionTargets?.some(target => target.kind === 'host-macos' && target.protocolVersion === 1)); }
  private paired(id: string): boolean { return this.options.app.devices.some(device => device.id === id && device.platform !== 'browser' && (id !== this.options.app.device.id || device.local)); }
  private async remoteProfiles(deviceId: string, projectId: string): Promise<RemoteProfile[]> {
    const response = await this.options.peers.request(deviceId, { method: 'POST', path: '/api/inspection/delegated', body: { op: 'profiles', projectId } });
    if (response.status >= 400) throw new HttpError(response.status, 'The paired Mac’s native profiles are unavailable.');
    const profiles = (response.body as { profiles?: unknown[] })?.profiles;
    return Array.isArray(profiles) ? profiles.filter((profile): profile is RemoteProfile => Boolean(profile && typeof profile === 'object' && typeof (profile as RemoteProfile).id === 'string' && ['macos', 'ios-simulator'].includes((profile as RemoteProfile).platform))).slice(0, 16) : [];
  }
}
function sameAuthority(a: InspectionAuthority, b: InspectionAuthority): boolean { return ['goalId', 'goalRevision', 'taskId', 'attemptId', 'authorityGeneration', 'policyRevision'].every(key => a[key as keyof InspectionAuthority] === b[key as keyof InspectionAuthority]); }
