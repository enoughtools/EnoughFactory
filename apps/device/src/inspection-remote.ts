import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EXECUTION_CAPABILITIES, type ExecutionCapability, type InspectionAuthority, type InspectionSourceIdentity, type RpcResponse } from '@enoughfactory/contracts';
import { ArtifactStore, type ArtifactManifest } from '@enoughfactory/workspaces';
import type { PeerManager } from '@enoughfactory/peers';
import type { Store } from './store.ts';
import { HttpError } from './util.ts';

const route = '/api/inspection/delegated';
const buckets = { assignments: 'inspection-remote-assignments', assignmentKeys: 'inspection-remote-assignment-keys', outgoing: 'inspection-remote-outgoing', accepted: 'inspection-remote-accepted', grants: 'inspection-remote-private-grants', requests: 'inspection-remote-requests', delivered: 'inspection-remote-artifact-deliveries' };
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string { return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item); }
const names = ['build', 'start', 'restart', 'navigate', 'observe', 'screenshot', 'click', 'type', 'key', 'scroll', 'run-tests', 'stop', 'status', 'journal'] as const;
export interface RemoteInspectionSource { rootId: string; manifest: ArtifactManifest; }
export interface RemoteInspectionAssignmentInput {
  authority: InspectionAuthority; coordinatorId: string; authorDeviceId: string; ownerDeviceId: string;
  executionTargetId: string; capability: ExecutionCapability; source: InspectionSourceIdentity;
  profile: Record<string, unknown>; sourceArtifacts: RemoteInspectionSource[]; sourceManifest: ArtifactManifest;
}
export interface RemoteInspectionAssignment extends RemoteInspectionAssignmentInput { id: string; createdAt: string; expiresAt: string; digest: string; }
export interface RemoteInspectionHandle { assignmentId: string; ownerDeviceId: string; token: string; }
export interface RemoteInspectionOperation { name: typeof names[number]; arguments: Record<string, unknown>; }
export type RemoteInspectionContent = { type: 'text'; text: string } | { type: 'image'; artifactId: string };
export interface RemoteInspectionResult { content?: RemoteInspectionContent[]; artifacts?: ArtifactManifest[]; value?: Record<string, unknown>; isError?: boolean; }
export interface RemoteInspectionReply extends RemoteInspectionResult { protocol: 1; requestId: string; status: 'completed' | 'running' | 'unknown'; reason?: string; }
export interface MaterializedInspectionReply extends Omit<RemoteInspectionReply, 'content'> {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
}
export interface VerifiedRemoteInspectionSource { rootId: string; manifest: ArtifactManifest; path: string; }
interface AcceptedAssignment { id: string; assignment: RemoteInspectionAssignment; validatedAt: string; }
interface RemoteGrant { id: string; assignmentId: string; peerId: string; expiresAt: string; }
interface RemoteRequest {
  id: string; assignmentId: string; requestId: string; operation: RemoteInspectionOperation; requestHash: string;
  status: 'running' | 'unknown' | 'completed'; createdAt: string; updatedAt: string; result?: RemoteInspectionResult; reason?: string;
}
interface ReceivedArtifact { id: string; peerId: string; manifest: ArtifactManifest; path: string; }
export interface InspectionRemoteOptions {
  store: Pick<Store, 'get' | 'set' | 'list' | 'transaction'>; deviceId: string; artifacts: ArtifactStore;
  peers: Pick<PeerManager, 'request' | 'uploadArtifact'>;
  /** Exclude browser controllers, unknown devices and devices no longer paired. */
  isPairedDevice: (id: string) => boolean;
  authorityCurrent: (authority: InspectionAuthority) => boolean;
  /** Coordinator checks the actual task/worker assignment, not merely that the peer is paired. */
  authorOwnsAuthority: (authority: InspectionAuthority, authorDeviceId: string) => boolean;
  /** Reconstruct and verify the snapshot manifest and every extracted root inventory before any backend effect. */
  verifySourceIdentity: (assignment: RemoteInspectionAssignment, sources: VerifiedRemoteInspectionSource[]) => Promise<void>;
  /** Inputs contain owner-local content-addressed objects only. The backend must journal requestId before effects. */
  execute: (assignment: RemoteInspectionAssignment, operation: RemoteInspectionOperation, sources: VerifiedRemoteInspectionSource[], requestId: string) => Promise<RemoteInspectionResult>;
  /** Discovery only. This callback must never launch a replacement or replay the original operation. */
  reconcile?: (assignment: RemoteInspectionAssignment, operation: RemoteInspectionOperation, requestId: string) => Promise<RemoteInspectionResult | undefined>;
  /** Called only after the authenticated selected coordinator positively retires an accepted assignment. */
  authorityRetired?: (assignment: RemoteInspectionAssignment, reason: string) => Promise<void>;
  now?: () => string; grantLifetimeMs?: number;
}

export class RemoteInspectionOutcomeUnknown extends Error {
  readonly code = 'REMOTE_INSPECTION_OUTCOME_UNKNOWN';
  constructor(readonly requestId: string, message = 'The inspection owner disconnected. Check the original request before retrying.') { super(message); }
}

/** Small authenticated peer protocol; source and image bytes use the existing resumable artifact lane. */
export class InspectionRemote {
  private readonly now: () => string;
  private readonly lifetime: number;
  constructor(private readonly options: InspectionRemoteOptions) {
    this.now = options.now ?? (() => new Date().toISOString()); this.lifetime = options.grantLifetimeMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.lifetime) || this.lifetime < 1000 || this.lifetime > 60 * 60_000) throw new Error('Invalid delegated inspection grant lifetime');
  }

  issueAssignment(input: RemoteInspectionAssignmentInput, idempotencyKey = sha(canonical(input))): RemoteInspectionAssignment {
    this.validateInput(input);
    if (input.coordinatorId !== this.options.deviceId || !this.options.authorityCurrent(input.authority) || !this.options.authorOwnsAuthority(input.authority, input.authorDeviceId)) throw new HttpError(403, 'The coordinator does not authorize this author attempt.', 'INSPECTION_AUTHORITY_STALE');
    this.requireDevice(input.authorDeviceId); this.requireDevice(input.ownerDeviceId);
    this.validId(idempotencyKey);
    return this.options.store.transaction(() => {
      const key = sha(`${input.authorDeviceId}:${input.authority.attemptId}:${idempotencyKey}`), inputHash = sha(canonical(input));
      const prior = this.options.store.get<{ id: string; assignmentId: string; inputHash: string }>(buckets.assignmentKeys, key);
      if (prior) {
        if (prior.inputHash !== inputHash) throw new HttpError(409, 'Delegation identity was reused for different immutable inputs.');
        const assignment = this.options.store.get<RemoteInspectionAssignment>(buckets.assignments, prior.assignmentId);
        if (!assignment) throw new Error('Delegation assignment journal is incomplete');
        this.validateAssignment(assignment, true); return this.reauthorizeIssued(assignment);
      }
      const at = this.now(), value = { ...structuredClone(input), id: randomUUID(), createdAt: at, expiresAt: new Date(Date.parse(at) + this.lifetime).toISOString() };
      const assignment: RemoteInspectionAssignment = { ...value, digest: sha(canonical(value)) };
      this.options.store.set(buckets.assignments, assignment); this.options.store.set(buckets.assignmentKeys, { id: key, assignmentId: assignment.id, inputHash }); return assignment;
    });
  }

  /** Author service freezes/captures source first, then sends only approved immutable artifact identities. */
  async delegate(input: RemoteInspectionAssignmentInput, idempotencyKey = sha(canonical(input))): Promise<RemoteInspectionHandle> {
    this.validateInput(input);
    if (input.authorDeviceId !== this.options.deviceId || !this.options.authorityCurrent(input.authority)) throw new HttpError(403, 'This service does not own the current author attempt.', 'INSPECTION_AUTHORITY_STALE');
    this.requireDevice(input.coordinatorId); this.requireDevice(input.ownerDeviceId);
    this.validId(idempotencyKey);
    const assignment = input.coordinatorId === this.options.deviceId ? this.issueAssignment(input, idempotencyKey) : await this.call<RemoteInspectionAssignment>(input.coordinatorId, { op: 'issue', assignment: input, idempotencyKey }, 'assignment');
    this.validateAssignment(assignment);
    if (canonical(this.assignmentInput(assignment)) !== canonical(input)) throw new Error('Coordinator changed the immutable inspection assignment');
    this.options.store.set(buckets.outgoing, assignment);
    if (assignment.sourceManifest) await this.upload(input.ownerDeviceId, assignment.sourceManifest);
    for (const source of assignment.sourceArtifacts) await this.upload(input.ownerDeviceId, source.manifest);
    const opened = await this.call<{ assignmentId: string; token: string }>(input.ownerDeviceId, { op: 'open', assignment }, assignment.id);
    if (opened.assignmentId !== assignment.id || !/^[A-Za-z0-9_-]{43}$/.test(opened.token)) throw new Error('Inspection owner returned an invalid scoped grant');
    return { assignmentId: assignment.id, ownerDeviceId: input.ownerDeviceId, token: opened.token };
  }

  async invoke(handle: RemoteInspectionHandle, requestId: string, operation: RemoteInspectionOperation): Promise<MaterializedInspectionReply> {
    this.outgoing(handle);
    this.validateOperation(operation); this.validId(requestId);
    const reply = await this.callWithRenewal(handle, { op: 'invoke', assignmentId: handle.assignmentId, requestId, operation }, requestId);
    return this.materialize(handle, reply, requestId);
  }

  async result(handle: RemoteInspectionHandle, requestId: string): Promise<MaterializedInspectionReply> {
    this.outgoing(handle);
    this.validId(requestId);
    const reply = await this.callWithRenewal(handle, { op: 'result', assignmentId: handle.assignmentId, requestId }, requestId);
    return this.materialize(handle, reply, requestId);
  }

  /** Reauthorize the same immutable assignment and request journal; never substitute a fresh native session. */
  async renew(handle: RemoteInspectionHandle): Promise<RemoteInspectionHandle> {
    this.outgoing(handle);
    const renewed = await this.call<{ assignmentId: string; token: string }>(handle.ownerDeviceId, { op: 'renew', assignmentId: handle.assignmentId, token: handle.token }, handle.assignmentId);
    if (renewed.assignmentId !== handle.assignmentId || !/^[A-Za-z0-9_-]{43}$/.test(renewed.token)) throw new Error('Invalid renewed inspection grant');
    const updated = { ...handle, token: renewed.token }; handle.token = renewed.token; return updated;
  }

  /** Register exactly POST /api/inspection/delegated in the device extension, with ApiCall.peerId intact. */
  async handle(peerId: string | undefined, body: Record<string, unknown>): Promise<unknown> {
    if (!peerId || !this.options.isPairedDevice(peerId)) throw new HttpError(403, 'Delegated inspection requires an authenticated paired device.', 'INSPECTION_PEER_REQUIRED');
    this.bounded(body, 131_072);
    if (body.op === 'issue') {
      const input = body.assignment as RemoteInspectionAssignmentInput; this.validateInput(input);
      if (input.authorDeviceId !== peerId) throw new HttpError(403, 'The peer does not own this author assignment.');
      return this.issueAssignment(input, typeof body.idempotencyKey === 'string' ? body.idempotencyKey : undefined);
    }
    if (body.op === 'validate') {
      const assignment = this.options.store.get<RemoteInspectionAssignment>(buckets.assignments, String(body.assignmentId));
      if (!assignment || assignment.ownerDeviceId !== peerId || sha(canonical(this.assignmentInput(assignment))) !== body.inputDigest || assignment.authorDeviceId !== body.authorDeviceId) throw new HttpError(403, 'The paired coordinator assignment does not match this owner.');
      this.validateAssignment(assignment, true);
      if (!this.options.authorityCurrent(assignment.authority) || !this.options.authorOwnsAuthority(assignment.authority, assignment.authorDeviceId)) throw new HttpError(409, 'The delegated author attempt is no longer current.', 'INSPECTION_AUTHORITY_STALE');
      const renewed = this.reauthorizeIssued(assignment);
      return { valid: true, digest: renewed.digest, expiresAt: renewed.expiresAt, assignment: renewed };
    }
    if (body.op === 'open') {
      let assignment = body.assignment as RemoteInspectionAssignment; this.validateAssignment(assignment, true);
      if (assignment.ownerDeviceId !== this.options.deviceId || assignment.authorDeviceId !== peerId) throw new HttpError(403, 'The delegated inspection does not belong to this peer and owner.');
      assignment = await this.validateWithCoordinator(assignment);
      try { await this.options.verifySourceIdentity(assignment, await this.importSources(assignment)); }
      catch (error) { throw new HttpError(409, error instanceof Error ? error.message : 'Immutable inspection source verification failed.', 'INSPECTION_SOURCE_IDENTITY_MISMATCH'); }
      const token = this.issueGrant(peerId, assignment);
      return { assignmentId: assignment.id, token };
    }
    if (body.op === 'renew') {
      const assignment = await this.authorize(peerId, String(body.token), String(body.assignmentId), true);
      return { assignmentId: assignment.id, token: this.issueGrant(peerId, assignment) };
    }
    if (body.op !== 'invoke' && body.op !== 'result') throw new HttpError(400, 'Unsupported delegated inspection operation.');
    const assignment = await this.authorize(peerId, String(body.token), String(body.assignmentId));
    const requestId = String(body.requestId); this.validId(requestId);
    const key = sha(`${assignment.id}:${requestId}`);
    let record = this.options.store.get<RemoteRequest>(buckets.requests, key);
    if (body.op === 'invoke') {
      const operation = body.operation as RemoteInspectionOperation; this.validateOperation(operation);
      const hash = sha(canonical(operation));
      if (record && record.requestHash !== hash) throw new HttpError(409, 'Inspection request identity was reused for a different operation.');
      if (!record) {
        const at = this.now(); record = { id: key, assignmentId: assignment.id, requestId, operation: structuredClone(operation), requestHash: hash, status: 'running', createdAt: at, updatedAt: at };
        this.options.store.set(buckets.requests, record);
        let effectStarted = false;
        try {
          const sources = await this.importSources(assignment); await this.options.verifySourceIdentity(assignment, sources);
          await this.validateWithCoordinator(assignment);
          effectStarted = true;
          const result = await this.options.execute(assignment, operation, sources, requestId);
          await this.validateWithCoordinator(assignment); this.validateResult(result, assignment);
          record = { ...record, status: 'completed', result: structuredClone(result), updatedAt: this.now() };
          this.options.store.set(buckets.requests, record);
        } catch (error) {
          // A backend/connection exception is not proof that the original effect did not happen.
          const reason = error instanceof Error ? error.message.slice(0, 2000) : 'Inspection outcome is unconfirmed';
          record = effectStarted ? { ...record, status: 'unknown', reason, updatedAt: this.now() } : { ...record, status: 'completed', result: { isError: true, content: [{ type: 'text', text: reason }], value: { backendStarted: false } }, updatedAt: this.now() };
          this.options.store.set(buckets.requests, record);
        }
      }
    }
    if (!record) throw new HttpError(404, 'The original delegated inspection request was not found.');
    if (body.op === 'result' && record.status === 'unknown' && this.options.reconcile) {
      const result = await this.options.reconcile(assignment, record.operation, requestId);
      if (result) { await this.validateWithCoordinator(assignment); this.validateResult(result, assignment); record = { ...record, status: 'completed', result, reason: undefined, updatedAt: this.now() }; this.options.store.set(buckets.requests, record); }
    }
    if (record.status === 'completed') for (const artifact of record.result?.artifacts ?? []) await this.upload(peerId, artifact);
    return { protocol: 1, requestId, status: record.status, ...(record.result ?? {}), ...(record.reason ? { reason: record.reason } : {}) } satisfies RemoteInspectionReply;
  }

  /** Use this before backend publication after a long build; synchronous job fencing uses the recent verified cache. */
  async refreshAuthority(assignmentId: string): Promise<void> {
    const accepted = this.options.store.get<AcceptedAssignment>(buckets.accepted, assignmentId);
    if (!accepted) throw new HttpError(403, 'Delegated inspection assignment is not accepted by this owner.');
    await this.validateWithCoordinator(accepted.assignment);
  }

  acceptedAuthorityCurrent(authority: InspectionAuthority): boolean {
    return this.options.store.list<AcceptedAssignment>(buckets.accepted).some(value => canonical(value.assignment.authority) === canonical(authority) && value.assignment.ownerDeviceId === this.options.deviceId && Date.parse(value.assignment.expiresAt) > Date.parse(this.now()) && Date.parse(this.now()) - Date.parse(value.validatedAt) < 30_000 && this.options.isPairedDevice(value.assignment.authorDeviceId) && (value.assignment.coordinatorId === this.options.deviceId ? this.options.authorityCurrent(authority) : this.options.isPairedDevice(value.assignment.coordinatorId)));
  }

  recoverAfterRestart(): void {
    this.options.store.transaction(() => {
      for (const record of this.options.store.list<RemoteRequest>(buckets.requests)) if (record.status === 'running') this.options.store.set(buckets.requests, { ...record, status: 'unknown', reason: 'Owner service restarted; discover the original operation before continuing', updatedAt: this.now() });
      // Freshly revalidate all coordinator assignments before new effects after restart.
      for (const accepted of this.options.store.list<AcceptedAssignment>(buckets.accepted)) this.options.store.set(buckets.accepted, { ...accepted, validatedAt: '1970-01-01T00:00:00.000Z' });
    });
  }

  private async authorize(peerId: string, token: string, assignmentId: string, allowExpiredToken = false): Promise<RemoteInspectionAssignment> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(403, 'Invalid delegated inspection grant.');
    const grant = this.options.store.get<RemoteGrant>(buckets.grants, sha(token)), accepted = this.options.store.get<AcceptedAssignment>(buckets.accepted, assignmentId);
    if (!grant || grant.peerId !== peerId || grant.assignmentId !== assignmentId || !accepted) throw new HttpError(403, 'Mismatched delegated inspection grant.');
    if (!allowExpiredToken && Date.parse(grant.expiresAt) <= Date.parse(this.now())) throw new HttpError(403, 'Expired delegated inspection grant.', 'INSPECTION_GRANT_EXPIRED');
    return this.validateWithCoordinator(accepted.assignment);
  }
  private async validateWithCoordinator(assignment: RemoteInspectionAssignment): Promise<RemoteInspectionAssignment> {
    try { return await this.confirmWithCoordinator(assignment); }
    catch (error) {
      const accepted = this.options.store.get<AcceptedAssignment>(buckets.accepted, assignment.id);
      if (accepted) this.options.store.set(buckets.accepted, { ...accepted, validatedAt: '1970-01-01T00:00:00.000Z' });
      if (accepted && error instanceof HttpError && error.code === 'INSPECTION_AUTHORITY_STALE') {
        try { await this.options.authorityRetired?.(accepted.assignment, error.message); }
        catch { /* Cleanup failure cannot authorize publication or imply that an owned process exited. */ }
      }
      throw error;
    }
  }
  private async confirmWithCoordinator(assignment: RemoteInspectionAssignment): Promise<RemoteInspectionAssignment> {
    this.validateAssignment(assignment, true); this.requireDevice(assignment.authorDeviceId); this.requireDevice(assignment.coordinatorId);
    if (assignment.coordinatorId === this.options.deviceId) {
      const issued = this.options.store.get<RemoteInspectionAssignment>(buckets.assignments, assignment.id);
      if (!issued || canonical(this.assignmentInput(issued)) !== canonical(this.assignmentInput(assignment)) || !this.options.authorityCurrent(assignment.authority) || !this.options.authorOwnsAuthority(assignment.authority, assignment.authorDeviceId)) throw new HttpError(409, 'The current coordinator assignment does not authorize this inspection.', 'INSPECTION_AUTHORITY_STALE');
      assignment = this.reauthorizeIssued(issued);
    } else {
      const reply = await this.call<{ valid: boolean; digest: string; assignment: RemoteInspectionAssignment }>(assignment.coordinatorId, { op: 'validate', assignmentId: assignment.id, inputDigest: sha(canonical(this.assignmentInput(assignment))), authorDeviceId: assignment.authorDeviceId }, assignment.id);
      this.validateAssignment(reply.assignment);
      if (reply.valid !== true || reply.digest !== reply.assignment.digest || reply.assignment.id !== assignment.id || canonical(this.assignmentInput(reply.assignment)) !== canonical(this.assignmentInput(assignment))) throw new HttpError(403, 'Coordinator did not confirm the exact delegated assignment.');
      assignment = reply.assignment;
    }
    this.options.store.set<AcceptedAssignment>(buckets.accepted, { id: assignment.id, assignment, validatedAt: this.now() });
    return assignment;
  }
  private reauthorizeIssued(assignment: RemoteInspectionAssignment): RemoteInspectionAssignment {
    if (Date.parse(assignment.expiresAt) - Date.parse(this.now()) >= this.lifetime / 2) return assignment;
    const { digest: _old, ...value } = assignment, updated = { ...value, expiresAt: new Date(Date.parse(this.now()) + this.lifetime).toISOString() };
    const renewed = { ...updated, digest: sha(canonical(updated)) }; this.options.store.set(buckets.assignments, renewed); return renewed;
  }
  private issueGrant(peerId: string, assignment: RemoteInspectionAssignment): string {
    const token = randomBytes(32).toString('base64url');
    this.options.store.set<RemoteGrant>(buckets.grants, { id: sha(token), assignmentId: assignment.id, peerId, expiresAt: new Date(Math.min(Date.parse(assignment.expiresAt), Date.parse(this.now()) + this.lifetime)).toISOString() }); return token;
  }
  private async callWithRenewal(handle: RemoteInspectionHandle, body: Record<string, unknown>, requestId: string): Promise<RemoteInspectionReply> {
    try { return await this.call(handle.ownerDeviceId, { ...body, token: handle.token }, requestId); }
    catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'INSPECTION_GRANT_EXPIRED') throw error;
      await this.renew(handle); return this.call(handle.ownerDeviceId, { ...body, token: handle.token }, requestId);
    }
  }
  private async importSources(assignment: RemoteInspectionAssignment): Promise<VerifiedRemoteInspectionSource[]> {
    const sources: VerifiedRemoteInspectionSource[] = [];
    if (assignment.sourceManifest) await this.importArtifact(assignment.authorDeviceId, assignment.sourceManifest);
    for (const source of assignment.sourceArtifacts) { await this.importArtifact(assignment.authorDeviceId, source.manifest); sources.push({ rootId: source.rootId, manifest: source.manifest, path: await this.options.artifacts.path(source.manifest) }); }
    return sources;
  }
  private async importArtifact(peerId: string, manifest: ArtifactManifest): Promise<void> {
    const receipt = this.options.store.get<ReceivedArtifact>('peer-artifacts', manifest.id);
    if (peerId === this.options.deviceId) { const own = await this.options.artifacts.get(manifest.id); if (canonical(own) !== canonical(manifest)) throw new Error('Local artifact manifest differs from the immutable assignment'); await this.options.artifacts.path(manifest); return; }
    if (!receipt || receipt.peerId !== peerId || canonical(receipt.manifest) !== canonical(manifest)) throw new HttpError(409, 'A matching authenticated artifact transfer is required before inspection.');
    // Reuse an already verified immutable object without relying on a temporary transfer file forever.
    try { const own = await this.options.artifacts.get(manifest.id); if (canonical(own) !== canonical(manifest)) throw new Error('Immutable artifact identifier collision'); await this.options.artifacts.path(manifest); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.options.artifacts.importFile(receipt.path, manifest);
  }
  private async upload(peerId: string, manifest: ArtifactManifest): Promise<void> {
    if (peerId === this.options.deviceId) return;
    this.requireDevice(peerId);
    const id = sha(`${peerId}:${manifest.id}:${sha(canonical(manifest))}`);
    if (this.options.store.get(buckets.delivered, id)) return;
    await this.options.peers.uploadArtifact(peerId, await this.options.artifacts.path(manifest), { ...manifest });
    this.options.store.set(buckets.delivered, { id, peerId, artifactId: manifest.id, sha256: manifest.sha256, deliveredAt: this.now() });
  }
  private async materialize(handle: RemoteInspectionHandle, reply: RemoteInspectionReply, requestId: string): Promise<MaterializedInspectionReply> {
    const assignment = this.outgoing(handle), peerId = handle.ownerDeviceId;
    if (reply.protocol !== 1 || reply.requestId !== requestId || !['completed', 'running', 'unknown'].includes(reply.status)) throw new Error('Malformed delegated inspection response');
    this.bounded(reply, 131_072);
    const artifacts = new Map<string, ArtifactManifest>();
    for (const manifest of reply.artifacts ?? []) { this.validateManifest(manifest); if (manifest.deviceId !== peerId || manifest.goalId !== assignment.authority.goalId || manifest.taskId !== assignment.authority.taskId || manifest.attemptId !== assignment.authority.attemptId) throw new Error('Inspection evidence is not owned by the requested device and author attempt'); await this.importArtifact(peerId, manifest); artifacts.set(manifest.id, manifest); }
    const content: MaterializedInspectionReply['content'] = [];
    for (const item of reply.content ?? []) {
      if (item.type === 'text') content.push({ type: 'text', text: item.text });
      else if (item.type === 'image') {
        const manifest = artifacts.get(item.artifactId);
        if (!manifest || !['image/png', 'image/jpeg', 'image/webp'].includes(manifest.mime) || manifest.size > 10 * 1024 * 1024) throw new Error('Inspection image must be a bounded verified owner artifact');
        content.push({ type: 'image', mimeType: manifest.mime, data: (await this.options.artifacts.read(manifest)).toString('base64') });
      } else throw new Error('Unsupported inspection content block');
    }
    return { ...reply, content };
  }
  private async call<T>(peerId: string, body: Record<string, unknown>, requestId: string): Promise<T> {
    this.requireDevice(peerId);
    let response: RpcResponse;
    try { response = await this.options.peers.request(peerId, { method: 'POST', path: route, body }); }
    catch { throw new RemoteInspectionOutcomeUnknown(requestId); }
    if (response.status >= 500) throw new RemoteInspectionOutcomeUnknown(requestId);
    if (response.status >= 400) { const error = response.body as { error?: string; code?: string }; throw new HttpError(response.status, error?.error ?? 'The inspection owner rejected the operation.', error?.code); }
    return response.body as T;
  }
  private outgoing(handle: RemoteInspectionHandle): RemoteInspectionAssignment {
    const assignment = this.options.store.get<RemoteInspectionAssignment>(buckets.outgoing, handle.assignmentId);
    if (!assignment || assignment.authorDeviceId !== this.options.deviceId || assignment.ownerDeviceId !== handle.ownerDeviceId || !this.options.authorityCurrent(assignment.authority)) throw new HttpError(409, 'The local author no longer owns this delegated inspection.', 'INSPECTION_AUTHORITY_STALE');
    return assignment;
  }
  private requireDevice(deviceId: string): void { if (deviceId !== this.options.deviceId && !this.options.isPairedDevice(deviceId)) throw new HttpError(403, 'Inspection requires a currently paired execution device.'); }
  private validId(value: string): void { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw new HttpError(400, 'Invalid inspection request or source identity.'); }
  private bounded(value: unknown, maximum = 65_536): void { const encoded = canonical(value); if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maximum) throw new HttpError(400, 'Inspection metadata exceeded its bound; transfer bytes as artifacts.'); }
  private validateManifest(value: ArtifactManifest): void {
    if (!value || typeof value !== 'object') throw new HttpError(400, 'Invalid inspection artifact manifest.');
    this.validId(value.id);
    if (!/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 10 * 1024 ** 3 || typeof value.deviceId !== 'string' || typeof value.mime !== 'string') throw new HttpError(400, 'Invalid inspection artifact identity.');
  }
  private validateInput(input: RemoteInspectionAssignmentInput): void {
    if (!input || typeof input !== 'object') throw new HttpError(400, 'Invalid delegated inspection assignment.');
    this.bounded(input, 65_536);
    for (const key of ['coordinatorId', 'authorDeviceId', 'ownerDeviceId', 'executionTargetId'] as const) this.validId(input[key]);
    const authority = input.authority;
    if (!authority || ['goalRevision', 'authorityGeneration', 'policyRevision'].some(key => !Number.isSafeInteger(authority[key as keyof InspectionAuthority]) || Number(authority[key as keyof InspectionAuthority]) < 0)) throw new HttpError(400, 'Invalid delegated inspection authority.');
    for (const key of ['goalId', 'taskId', 'attemptId'] as const) this.validId(authority[key]);
    if (!EXECUTION_CAPABILITIES.includes(input.capability) || !input.source || !/^[a-f0-9]{64}$/.test(input.source.sha256) || typeof input.source.snapshotId !== 'string' || !input.profile || Array.isArray(input.profile) || typeof input.profile !== 'object') throw new HttpError(400, 'Invalid delegated inspection capability or immutable source.');
    if (!Array.isArray(input.sourceArtifacts) || input.sourceArtifacts.length < 1 || input.sourceArtifacts.length > 9) throw new HttpError(400, 'Inspection requires one primary and at most eight additional immutable source roots.');
    const ids = new Set<string>();
    if (!input.sourceManifest) throw new HttpError(400, 'Delegated inspection requires the original immutable snapshot manifest.');
    if (input.sourceManifest) {
      this.validateManifest(input.sourceManifest);
      if (input.sourceManifest.deviceId !== input.authorDeviceId || input.sourceManifest.goalId !== authority.goalId || input.sourceManifest.taskId !== authority.taskId || input.sourceManifest.attemptId !== authority.attemptId) throw new HttpError(403, 'The source manifest does not belong to the assigned author attempt.');
    }
    for (const source of input.sourceArtifacts) {
      this.validId(source.rootId); this.validateManifest(source.manifest);
      if (ids.has(source.rootId)) throw new HttpError(400, 'Duplicate inspection source root.'); ids.add(source.rootId);
      if (source.manifest.deviceId !== input.authorDeviceId || source.manifest.goalId !== authority.goalId || source.manifest.taskId !== authority.taskId || source.manifest.attemptId !== authority.attemptId) throw new HttpError(403, 'The source artifact does not belong to the assigned author attempt.');
      if (Object.hasOwn(source, 'path')) throw new HttpError(400, 'Inspection source contracts cannot contain author filesystem paths.');
    }
    if (input.source.roots && (input.source.roots.length !== ids.size || new Set(input.source.roots.map(root => root.id)).size !== ids.size || input.source.roots.some(root => !ids.has(root.id) || !/^[a-f0-9]{64}$/.test(root.sha256)))) throw new HttpError(400, 'Every immutable source root must have exactly one transferred artifact.');
  }
  private validateAssignment(assignment: RemoteInspectionAssignment, allowExpired = false): void {
    this.validateInput(assignment); this.validId(assignment.id);
    const { digest, ...value } = assignment;
    if (!/^[a-f0-9]{64}$/.test(digest) || sha(canonical(value)) !== digest || !Number.isFinite(Date.parse(assignment.createdAt)) || !Number.isFinite(Date.parse(assignment.expiresAt)) || (!allowExpired && Date.parse(assignment.expiresAt) <= Date.parse(this.now())) || Date.parse(assignment.expiresAt) - Date.parse(this.now()) > 60 * 60_000) throw new HttpError(403, 'Expired or modified delegated inspection assignment.');
  }
  private validateOperation(operation: RemoteInspectionOperation): void {
    if (!operation || !names.includes(operation.name) || !operation.arguments || typeof operation.arguments !== 'object' || Array.isArray(operation.arguments)) throw new HttpError(400, 'Unsupported delegated inspection operation.');
    this.bounded(operation);
  }
  private validateResult(result: RemoteInspectionResult, assignment: RemoteInspectionAssignment): void {
    this.bounded(result, 131_072);
    if ((result.artifacts?.length ?? 0) > 32 || (result.content?.length ?? 0) > 32) throw new Error('Inspection result exceeds its artifact bound');
    const ids = new Set<string>();
    for (const artifact of result.artifacts ?? []) {
      this.validateManifest(artifact);
      if (artifact.deviceId !== this.options.deviceId || artifact.goalId !== assignment.authority.goalId || artifact.taskId !== assignment.authority.taskId || artifact.attemptId !== assignment.authority.attemptId || ids.has(artifact.id)) throw new Error('Inspection result artifact has a different owner or authority'); ids.add(artifact.id);
    }
    for (const item of result.content ?? []) if (item.type === 'image' ? !ids.has(item.artifactId) : item.type !== 'text' || typeof item.text !== 'string') throw new Error('Invalid inspection result content');
  }
  private assignmentInput({ id: _id, createdAt: _created, expiresAt: _expires, digest: _digest, ...input }: RemoteInspectionAssignment): RemoteInspectionAssignmentInput { return input; }
}
