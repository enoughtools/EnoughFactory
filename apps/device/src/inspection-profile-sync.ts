import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Goal, InspectionAuthority, InspectionSourceIdentity } from '@enoughfactory/contracts';
import type { PeerManager } from '@enoughfactory/peers';
import { importInspectionSnapshot, type ArtifactManifest, type ArtifactStore, type InspectionSnapshot, type InspectionSnapshotTransfer } from '@enoughfactory/workspaces';
import type { DeviceApp } from './app.ts';
import type { NativeFixtureProfile } from './inspection-native.ts';
import { validateNativeProfileProposal, type NativeProfileAudit, type NativeProfileProposal } from './inspection-profile-setup.ts';
import { HttpError } from './util.ts';
import { INSPECTION_SOURCE_MAX_BYTES } from './inspection-source-policy.ts';

const route = '/api/inspection/native-profiles';
const bucket = 'inspection-profile-peer-installs';
const outgoingBucket = 'inspection-profile-peer-outgoing';
const deliveryBucket = 'inspection-profile-peer-deliveries';
const purposes = ['entry', 'storage', 'credentials', 'providers', 'preferences', 'notifications', 'build'];
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
const safePath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') && value.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._-]{1,160}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export interface NativeProfileAuditRead {
  id: string; runId: string; chatId: string; rootId: string; path: string;
  fileSha256: string; offset: number; length: number; fileSize: number; artifact: ArtifactManifest;
}
interface OriginalAudit {
  id: string; status: 'configured'; proposalSha256: string; proposal: NativeProfileProposal;
  authority: InspectionAuthority; source: InspectionSourceIdentity; ownerDeviceId: string; projectId: string;
  chatId: string; receipt: ArtifactManifest; verdict: ArtifactManifest; transfer: InspectionSnapshotTransfer;
}
interface OriginalReply { audit: OriginalAudit; reads: NativeProfileAuditRead[]; }
interface InstallInput {
  auditId: string; projectId: string; authority: InspectionAuthority; source: InspectionSourceIdentity;
  proposalSha256: string; profile: NativeFixtureProfile; transfer: InspectionSnapshotTransfer;
}
export interface NativeProfileSyncResult {
  id: string; ownerDeviceId: string; auditId: string; profileId: string;
  status: 'validating' | 'unknown' | 'configured' | 'rejected'; reason?: string;
}
interface Install extends NativeProfileSyncResult { peerId: string; input: InstallInput; inputSha256: string; createdAt: string; updatedAt: string; }
interface Outgoing { id: string; ownerDeviceId: string; input: InstallInput; status: 'sending' | 'unknown' | 'configured' | 'rejected'; }
interface ReceivedArtifact { id: string; peerId: string; manifest: ArtifactManifest; path: string; }
export interface NativeProfileSyncOptions {
  app: DeviceApp; peers: Pick<PeerManager, 'request' | 'uploadArtifact'>; artifacts: ArtifactStore;
  /** Original service-owned records, never tool arguments. This callback must not start an audit. */
  auditOriginal(id: string): Promise<{ audit: NativeProfileAudit; reads: NativeProfileAuditRead[] }>;
  authorityCurrent(authority: InspectionAuthority): boolean;
  /** Exact durable selective-policy decision for this audit/source/proposal; configured status is insufficient. */
  auditApproved?(audit: NativeProfileAudit): boolean;
  /** Synchronous persistence into app.store; configuration and its journal commit share one transaction. */
  configure(projectId: string, profile: NativeFixtureProfile): void;
}

/** Transfers a completed independent source audit. Pairing alone never approves author-supplied profiles. */
export class NativeProfileSync {
  private initialized = false;
  private readonly active = new Map<string, Promise<NativeProfileSyncResult>>();
  private reconciling?: Promise<NativeProfileSyncResult[]>;
  constructor(private readonly options: NativeProfileSyncOptions) {}

  initialize(): void {
    if (this.initialized) return; this.initialized = true;
    for (const install of this.options.app.store.list<Install>(bucket)) if (install.status === 'validating') this.patch(install, { status: 'unknown', reason: 'The service restarted during source audit transfer. Query this same install before continuing.' });
    this.options.app.extensions.push(async ({ method, url, body, peerId }) => method === 'POST' && url.pathname === route ? this.handle(peerId, body) : undefined);
  }

  async sync(run: NativeProfileAudit, profile: NativeFixtureProfile, ownerDeviceId: string): Promise<NativeProfileSyncResult> {
    this.requirePeer(ownerDeviceId);
    const input = this.input(run), key = this.key(this.options.app.device.id, ownerDeviceId, input);
    if (!same(this.profile({ proposal: run.proposal, receipt: run.receipt! }), profile)) throw new Error('Native profile sync requires the original configured audit and exact service-issued profile.');
    const prior = this.options.app.store.get<Outgoing>(outgoingBucket, key);
    if (prior && (!same(prior.input, input) || prior.ownerDeviceId !== ownerDeviceId)) throw new Error('Native profile transfer identity collision.');
    if (prior) {
      try {
        const status = await this.call(ownerDeviceId, { op: 'status', id: key });
        const result = this.result(status, ownerDeviceId, input, key);
        this.saveOutgoing(input, result);
        if (result.status !== 'unknown') return result;
      } catch (error) {
        // A missing owner journal is positive evidence that installation has not begun.
        if (!(error instanceof HttpError) || error.status !== 404) return this.unknown(key, ownerDeviceId, input, error);
      }
    }
    const original = await this.original(run.id);
    if (!same(this.input(original.audit), input)) throw new Error('Native profile sync requires the original configured audit and exact service-issued profile.');
    this.options.app.store.set<Outgoing>(outgoingBucket, { id: key, ownerDeviceId, input, status: 'sending' });
    try {
      for (const manifest of this.dependencies(original)) await this.upload(ownerDeviceId, manifest);
      await this.original(run.id); // Recheck authority and original records after potentially long uploads.
      const value = this.result(await this.call(ownerDeviceId, { op: 'install', id: key, input }), ownerDeviceId, input, key);
      this.saveOutgoing(input, value);
      return value;
    } catch (error) { return this.unknown(key, ownerDeviceId, input, error); }
  }

  /** Reconcile only persisted requests. This never authorizes or resends an installation. */
  reconcilePending(): Promise<NativeProfileSyncResult[]> {
    if (this.reconciling) return this.reconciling;
    const pending = this.options.app.store.list<Outgoing>(outgoingBucket).filter(value => ['sending', 'unknown'].includes(value.status));
    this.reconciling = Promise.all(pending.map(async previous => {
      try { const result = this.result(await this.call(previous.ownerDeviceId, { op: 'status', id: previous.id }), previous.ownerDeviceId, previous.input, previous.id); this.saveOutgoing(previous.input, result); return result; }
      catch (error) { return this.unknown(previous.id, previous.ownerDeviceId, previous.input, error); }
    })).finally(() => { this.reconciling = undefined; });
    return this.reconciling;
  }

  async handle(peerId: string | undefined, body: Record<string, unknown>): Promise<unknown> {
    if (!peerId) throw new HttpError(403, 'Native profiles require an authenticated paired device.');
    this.requirePeer(peerId);
    if (Buffer.byteLength(JSON.stringify(body)) > 1024 * 1024) throw new HttpError(413, 'Native profile request is too large.');
    if (body.op === 'audit') {
      if (!id(body.auditId)) throw new HttpError(400, 'Select an original native audit.');
      return this.original(body.auditId);
    }
    if (!/^[a-f0-9]{64}$/.test(String(body.id))) throw new HttpError(400, 'Select a stable native profile installation identity.');
    if (body.op === 'status') {
      const install = this.options.app.store.get<Install>(bucket, String(body.id));
      if (!install || install.peerId !== peerId) throw new HttpError(404, 'The native profile installation is unavailable.');
      return this.view(install);
    }
    if (body.op !== 'install') throw new HttpError(400, 'Unsupported native profile operation.');
    const input = body.input as InstallInput;
    this.validateInput(input);
    const key = this.key(peerId, this.options.app.device.id, input);
    if (key !== body.id) throw new HttpError(409, 'The native profile install identity differs from its immutable payload.');
    const previous = this.options.app.store.get<Install>(bucket, key);
    if (previous && (previous.peerId !== peerId || !same(previous.input, input))) throw new HttpError(409, 'Native profile installation identity collision.');
    if (previous && ['configured', 'rejected'].includes(previous.status)) return this.view(previous);
    const active = this.active.get(key); if (active) return active;
    const at = new Date().toISOString(), install: Install = previous ?? { id: key, ownerDeviceId: this.options.app.device.id, peerId, auditId: input.auditId, profileId: input.profile.id, status: 'validating', input, inputSha256: hash(input), createdAt: at, updatedAt: at };
    this.options.app.store.set(bucket, { ...install, status: 'validating', updatedAt: at });
    const operation = this.install({ ...install, status: 'validating' }).finally(() => this.active.delete(key));
    this.active.set(key, operation); return operation;
  }

  private async original(auditId: string): Promise<OriginalReply> {
    const reply = this.originalRecord(auditId, await this.options.auditOriginal(auditId));
    for (const manifest of this.dependencies(reply)) await this.authenticate(manifest);
    const latest = this.originalRecord(auditId, await this.options.auditOriginal(auditId));
    if (!same(reply, latest)) throw new HttpError(409, 'The original independent audit changed while its dependencies were authenticated.');
    return reply;
  }

  private originalRecord(auditId: string, original: { audit: NativeProfileAudit; reads: NativeProfileAuditRead[] }): OriginalReply {
    const { audit, reads } = original, goal = this.options.app.store.get<Goal>('goals', audit.authority.goalId);
    if (audit.id !== auditId || audit.status !== 'configured' || audit.ownerDeviceId !== this.options.app.device.id || !audit.receipt || !audit.verdict || !audit.chatId || !this.options.authorityCurrent(audit.authority) || goal?.projectId !== audit.projectId || ['completed', 'failed', 'canceled'].includes(goal.status) || audit.proposalSha256 !== hash(audit.proposal)) throw new HttpError(409, 'The original configured native source audit is no longer current.', 'NATIVE_PROFILE_AUDIT_STALE');
    if (goal.approvalMode !== 'approve-all' && !this.options.auditApproved?.(audit) || goal.status === 'paused') throw new HttpError(409, 'The original configured native source audit is no longer current while its goal is paused or awaits approval.', 'NATIVE_PROFILE_AUDIT_WAITING');
    const record: OriginalAudit = { id: audit.id, status: 'configured', proposalSha256: audit.proposalSha256, proposal: audit.proposal, authority: audit.authority, source: audit.source, ownerDeviceId: audit.ownerDeviceId, projectId: audit.projectId, chatId: audit.chatId, receipt: audit.receipt, verdict: audit.verdict, transfer: audit.transfer };
    const reply = { audit: structuredClone(record), reads: structuredClone(reads) };
    this.validateOriginal(reply, audit.ownerDeviceId);
    return reply;
  }

  private async install(install: Install): Promise<NativeProfileSyncResult> {
    try {
      const original = await this.fetchOriginal(install);
      for (const manifest of this.dependencies(original)) await this.importArtifact(install.peerId, manifest);
      await this.validateTransfer(original);
      const snapshot = await importInspectionSnapshot({ dataDir: path.join(this.options.app.dataDir, 'inspection'), artifacts: this.options.artifacts, sourceArtifacts: original.audit.transfer.sourceArtifacts, sourceManifest: original.audit.transfer.sourceManifest, expectedSource: { snapshotId: original.audit.source.snapshotId, sourceDigest: original.audit.source.sha256 }, context: original.audit.authority, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
      await this.validateEvidence(original, snapshot);
      const refreshed = await this.fetchOriginal(install);
      if (!same(original, refreshed)) throw new Error('The original independent audit changed during transfer.');
      this.requirePeer(install.peerId);
      return this.options.app.store.transaction(() => {
        const current = this.options.app.store.get<Install>(bucket, install.id);
        if (!current || current.inputSha256 !== install.inputSha256 || current.peerId !== install.peerId || !same(current.input, install.input)) throw new Error('The native profile install journal changed.');
        if (current.status === 'configured') return this.view(current);
        this.options.configure(install.input.projectId, structuredClone(install.input.profile));
        return this.view(this.patch(current, { status: 'configured', reason: undefined }));
      });
    } catch (error) {
      const uncertain = !(error instanceof HttpError) || error.status >= 500 || ['SERVICE_UPDATING', 'NATIVE_PROFILE_AUDIT_WAITING'].includes(error.code ?? '');
      return this.view(this.patch(install, { status: uncertain ? 'unknown' : 'rejected', reason: error instanceof Error ? error.message : 'Native profile transfer remains unresolved.' }));
    }
  }

  private async fetchOriginal(install: Install): Promise<OriginalReply> {
    const original = await this.call(install.peerId, { op: 'audit', auditId: install.input.auditId }) as OriginalReply;
    this.validateOriginal(original, install.peerId);
    if (!same(this.input(original.audit), install.input)) throw new HttpError(409, 'The original configured source audit differs from the proposed native profile installation.');
    return original;
  }

  private validateOriginal(original: OriginalReply, sender: string): void {
    const audit = original?.audit;
    if (!audit || audit.status !== 'configured' || audit.ownerDeviceId !== sender || !id(audit.id) || !audit.id.startsWith('profile-audit-') || !id(audit.chatId) || !object(audit.proposal) || !object(audit.proposal.profile) || !Array.isArray(audit.proposal.auditPaths) || audit.proposalSha256 !== hash(audit.proposal) || !Array.isArray(original.reads) || original.reads.length < 1 || original.reads.length > 512 || !audit.verdict || !audit.receipt || audit.receipt.mime !== 'application/json' || audit.receipt.size < 1 || audit.receipt.size > 1024 * 1024 || audit.verdict.mime !== 'application/json' || audit.verdict.size < 1 || audit.verdict.size > 128 * 1024) throw new HttpError(409, 'The paired source owner returned no original independent native audit.');
    this.validateInput(this.input(audit));
    const seen = new Set<string>(); let size = 0;
    for (const read of original.reads) {
      if (!read || !id(read.id) || seen.has(read.id) || read.runId !== audit.id || read.chatId !== audit.chatId || !id(read.rootId) || !safePath(read.path) || !/^[a-f0-9]{64}$/.test(read.fileSha256) || !Number.isSafeInteger(read.offset) || !Number.isSafeInteger(read.length) || !Number.isSafeInteger(read.fileSize) || read.offset < 0 || read.length < 0 || read.length > 64 * 1024 || read.fileSize < 0 || read.offset + read.length > read.fileSize || read.artifact?.size !== read.length || read.artifact.mime !== 'application/octet-stream' || (size += read.length) > 16 * 1024 * 1024) throw new HttpError(409, 'The original independent source read metadata is invalid.');
      seen.add(read.id);
    }
    for (const artifact of this.dependencies(original)) this.validateArtifact(artifact, sender, audit.authority);
  }

  private async validateEvidence(original: OriginalReply, snapshot: InspectionSnapshot): Promise<void> {
    const { audit, reads } = original, profile = this.profile(audit), manifest = snapshot.manifest;
    try { if (!same(validateNativeProfileProposal(audit.proposal, snapshot), audit.proposal)) throw new Error('Proposal normalization differs.'); }
    catch (error) { throw new HttpError(409, `The original native proposal does not match the captured app: ${(error as Error).message}`); }
    const roots = manifest.roots.map(root => ({ id: root.id, sha256: root.sourceDigest }));
    if (manifest.sourceDigest !== audit.source.sha256 || !same(roots, (audit.source.roots ?? []).map(root => ({ id: root.id, sha256: root.sha256 })))) throw new HttpError(409, 'The transferred native audit source differs from its complete declared root identities.');
    const receipt = await this.json(audit.receipt);
    if (audit.receipt.mime !== 'application/json' || audit.receipt.size > 1024 * 1024 || receipt.version !== 2 || receipt.kind !== 'native-fixture-source-audit' || receipt.profileId !== profile.id || receipt.sourceSha256 !== manifest.sourceDigest || !same(receipt.sourceManifest, audit.transfer.sourceManifest) || !same(receipt.build, profile.build) || !same(receipt.launchArguments, profile.launchArguments) || receipt.fixtureExpectedDataRoot !== profile.fixtureExpectedDataRoot || receipt.bundleIdentifier !== profile.bundleIdentifier || profile.fixtureEvidenceSha256 !== audit.receipt.sha256 || !same(receipt.independentReview, { runId: audit.id, chatId: audit.chatId, verdict: audit.verdict, reads: reads.map(read => read.artifact), judgment: 'source-review-not-runtime-proof' }) || !Array.isArray(receipt.roots) || receipt.roots.length !== manifest.roots.length) throw new HttpError(409, 'The original native receipt does not authorize this exact independent audit, profile and source.');
    const seenRoots = new Set<string>();
    for (const audited of receipt.roots) {
      if (!object(audited)) throw new HttpError(409, 'The original native receipt contains an invalid source root.');
      const root = manifest.roots.find(root => root.name === audited.name);
      if (!root || seenRoots.has(root.name) || audited.sourceDigest !== root.sourceDigest || audited.allowedPaths !== undefined && (!Array.isArray(audited.allowedPaths) || audited.allowedPaths.length > 0) || audited.protectedSourceDirectories !== undefined && (!Array.isArray(audited.protectedSourceDirectories) || audited.protectedSourceDirectories.length > 0) || !Array.isArray(audited.entries) || audited.entries.length > 0 && !same(audited.entries, root.entries.filter(entry => entry.kind === 'file').map(entry => ({ path: entry.path, sha256: entry.sha256 })))) throw new HttpError(409, 'Automatic native profiles require exact whole source roots with no editable exceptions.');
      seenRoots.add(root.name);
    }
    const verdict = await this.json(audit.verdict);
    if (audit.verdict.mime !== 'application/json' || audit.verdict.size > 128 * 1024 || verdict.version !== 1 || verdict.kind !== 'independent-native-fixture-judgment' || verdict.runId !== audit.id || verdict.chatId !== audit.chatId || !same(verdict.source, audit.source) || verdict.proposalSha256 !== audit.proposalSha256 || verdict.judgment !== 'source-review-not-runtime-proof' || !same(verdict.readIds, reads.map(read => read.id)) || !object(verdict.verdict) || verdict.verdict.approved !== true || verdict.verdict.blockedReasons !== undefined && (!Array.isArray(verdict.verdict.blockedReasons) || verdict.verdict.blockedReasons.length > 0) || !Array.isArray(verdict.verdict.findings) || verdict.verdict.findings.length > 32 || verdict.verdict.findings.some((finding: unknown) => !object(finding) || !Array.isArray(finding.files) || finding.files.some(file => !object(file) || !id(file.rootId) || !safePath(file.path)))) throw new HttpError(409, 'The original independent native verdict does not approve this source and its own retained reads.');
    for (const read of reads) {
      const entry = manifest.roots.find(root => root.id === read.rootId)?.entries.find(entry => entry.path === read.path), root = snapshot.roots.find(root => root.id === read.rootId);
      if (!root || entry?.kind !== 'file' || entry.sha256 !== read.fileSha256 || entry.size !== read.fileSize) throw new HttpError(409, 'An original audit read references different captured source.');
      const bytes = await this.options.artifacts.read(read.artifact), source = await readFile(path.join(root.path, ...read.path.split('/')));
      if (!bytes.equals(source.subarray(read.offset, read.offset + read.length))) throw new HttpError(409, 'An original audit read body differs from its captured source bytes.');
    }
    const fullyRead = (file: { rootId: string; path: string }): boolean => {
      const chunks = reads.filter(read => read.rootId === file.rootId && read.path === file.path).sort((a, b) => a.offset - b.offset); let end = 0;
      for (const chunk of chunks) { if (chunk.offset > end) return false; end = Math.max(end, chunk.offset + chunk.length); }
      return chunks.length > 0 && end === chunks[0]!.fileSize;
    };
    if (audit.proposal.auditPaths.some(file => !fullyRead(file))) throw new HttpError(409, 'The independent native reviewer did not read every original starting file completely.');
    for (const purpose of purposes) {
      const finding = verdict.verdict.findings.find((finding: { purpose: string }) => finding.purpose === purpose);
      if (!finding || typeof finding.reasoning !== 'string' || finding.reasoning.trim().length < 30 || finding.reasoning.length > 8000 || !Array.isArray(finding.files) || !finding.files.length || finding.files.some((file: { rootId: string; path: string }) => !safePath(file.path) || !fullyRead(file))) throw new HttpError(409, `The original independent ${purpose} judgment lacks complete source reads.`);
    }
  }

  /** Malformed immutable manifests are rejected; the importer retains its separate OS/teardown uncertainty. */
  private async validateTransfer(original: OriginalReply): Promise<void> {
    const { source, transfer } = original.audit, artifact = transfer.sourceManifest;
    if (artifact.mime !== 'application/json' || artifact.size < 1 || artifact.size > 16 * 1024 * 1024) throw new HttpError(409, 'The original native source transfer manifest is invalid.');
    const pack = await this.json(artifact), snapshot = pack.snapshot;
    if (pack.version !== 1 || pack.purpose !== 'inspection-snapshot-transfer' || !object(snapshot) || snapshot.version !== 1 || snapshot.purpose !== 'development-inspection' || snapshot.previewOnly !== true || snapshot.id !== source.snapshotId || snapshot.sourceDigest !== source.sha256 || !Array.isArray(snapshot.roots) || snapshot.roots.length !== source.roots!.length || !same(pack.sourceArtifacts, transfer.sourceArtifacts)) throw new HttpError(409, 'The original native source transfer does not match its exact snapshot.');
    let entries = 0;
    const rawHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    for (let index = 0; index < snapshot.roots.length; index++) {
      const root: unknown = snapshot.roots[index], expected = source.roots![index]!;
      if (!object(root) || root.id !== expected.id || root.sourceDigest !== expected.sha256 || typeof root.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/.test(root.name) || !['git', 'folder'].includes(String(root.kind)) || typeof root.commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(root.commit) || !Array.isArray(root.entries) || (entries += root.entries.length) > 30_000 || root.entries.some((entry: unknown) => !object(entry) || typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') || entry.path.includes('\0') || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git') || !['file', 'directory', 'symlink'].includes(String(entry.kind)) || !Number.isSafeInteger(entry.mode) || (entry.mode as number) < 0 || (entry.mode as number) > 0o777 || entry.kind === 'file' && (typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0) || entry.kind === 'symlink' && typeof entry.target !== 'string') || rawHash(root.entries) !== root.sourceDigest) throw new HttpError(409, 'The original native source root has invalid immutable inventory.');
    }
    if (rawHash(snapshot.roots.map((root: { id: string; name: string; sourceDigest: string }) => ({ id: root.id, name: root.name, sourceDigest: root.sourceDigest }))) !== source.sha256) throw new HttpError(409, 'The original native source roots do not match their aggregate identity.');
  }

  private profile(audit: Pick<OriginalAudit, 'proposal' | 'receipt'>): NativeFixtureProfile { return { ...audit.proposal.profile, fixtureEvidenceSha256: audit.receipt.sha256, receipt: audit.receipt }; }
  private input(audit: Pick<NativeProfileAudit, 'id' | 'projectId' | 'authority' | 'source' | 'proposalSha256' | 'proposal' | 'receipt' | 'transfer'>): InstallInput {
    if (!audit.receipt) throw new HttpError(409, 'Native profile has no service-issued audit receipt.');
    return { auditId: audit.id, projectId: audit.projectId, authority: audit.authority, source: audit.source, proposalSha256: audit.proposalSha256, profile: this.profile({ proposal: audit.proposal, receipt: audit.receipt }), transfer: audit.transfer };
  }
  private key(sender: string, owner: string, input: InstallInput): string { return hash([sender, owner, input]); }
  private dependencies(original: OriginalReply): ArtifactManifest[] {
    const manifests = [original.audit.receipt, original.audit.verdict, ...original.reads.map(read => read.artifact), original.audit.transfer.sourceManifest, ...original.audit.transfer.sourceArtifacts.map(source => source.manifest)], unique = new Map<string, ArtifactManifest>();
    for (const manifest of manifests) { const prior = unique.get(manifest?.id); if (prior && !same(prior, manifest)) throw new HttpError(409, 'Original native audit artifact identity collision.'); unique.set(manifest.id, manifest); }
    return [...unique.values()];
  }
  private validateInput(input: InstallInput): void {
    if (!input || !id(input.auditId) || !input.auditId.startsWith('profile-audit-') || !id(input.projectId) || !input.authority || !id(input.authority.goalId) || !id(input.authority.taskId) || !id(input.authority.attemptId) || !Number.isSafeInteger(input.authority.goalRevision) || input.authority.goalRevision < 1 || !Number.isSafeInteger(input.authority.authorityGeneration) || input.authority.authorityGeneration < 1 || input.authority.policyRevision !== input.authority.goalRevision || !input.source || !id(input.source.snapshotId) || !/^[a-f0-9]{64}$/.test(input.source.sha256) || !Array.isArray(input.source.roots) || !input.source.roots.length || input.source.roots.length > 9 || input.source.roots.some(root => !root || !id(root.id) || !/^[a-f0-9]{64}$/.test(root.sha256)) || new Set(input.source.roots.map(root => root.id)).size !== input.source.roots.length || !/^[a-f0-9]{64}$/.test(input.proposalSha256) || !input.profile?.receipt || input.profile.fixtureEvidenceSha256 !== input.profile.receipt.sha256 || !id(input.profile.id) || input.transfer?.version !== 1 || input.transfer.snapshotId !== input.source.snapshotId || input.transfer.sourceDigest !== input.source.sha256 || !Array.isArray(input.transfer.sourceArtifacts) || input.transfer.sourceArtifacts.length !== input.source.roots.length || input.transfer.sourceArtifacts.some(source => !source || !id(source.rootId) || !source.manifest) || !input.transfer.sourceManifest) throw new HttpError(400, 'Invalid immutable native profile installation.');
  }
  private validateArtifact(manifest: ArtifactManifest, sender: string, authority: InspectionAuthority): void {
    if (!manifest || !id(manifest.id) || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) || manifest.size < 0 || manifest.deviceId !== sender || manifest.goalId !== authority.goalId || manifest.taskId !== authority.taskId || manifest.attemptId !== authority.attemptId) throw new HttpError(409, 'Native audit artifact is not owned by the authenticated source owner and exact author attempt.');
  }
  private requirePeer(peerId: string): void {
    if (peerId === this.options.app.device.id || !this.options.app.devices.some(device => device.id === peerId && device.platform !== 'browser' && !device.local)) throw new HttpError(403, 'Native profile sync requires a paired execution device.');
  }
  private async authenticate(manifest: ArtifactManifest): Promise<void> {
    if (!same(await this.options.artifacts.get(manifest.id), manifest)) throw new HttpError(409, 'The native audit artifact manifest differs from its original.');
    await this.options.artifacts.path(manifest);
  }
  private async json(manifest: ArtifactManifest): Promise<Record<string, any>> {
    try { const body: unknown = JSON.parse((await this.options.artifacts.read(manifest)).toString('utf8')); if (!object(body)) throw new Error('Expected a JSON object.'); return body; }
    catch (error) { if (error instanceof SyntaxError || error instanceof Error && error.message === 'Expected a JSON object.') throw new HttpError(409, 'The original native audit artifact has invalid structured evidence.'); throw error; }
  }
  private async upload(peerId: string, manifest: ArtifactManifest): Promise<void> {
    this.requirePeer(peerId); await this.authenticate(manifest);
    const key = hash([peerId, manifest]); if (this.options.app.store.get(deliveryBucket, key)) return;
    await this.options.peers.uploadArtifact(peerId, await this.options.artifacts.path(manifest), { ...manifest });
    this.options.app.store.set(deliveryBucket, { id: key, peerId, manifest, deliveredAt: new Date().toISOString() });
  }
  private async importArtifact(peerId: string, manifest: ArtifactManifest): Promise<void> {
    const transferred = this.options.app.store.get<ReceivedArtifact>('peer-artifacts', manifest.id);
    if (!transferred || transferred.peerId !== peerId || !same(transferred.manifest, manifest)) throw new HttpError(409, 'Native profile needs an exact authenticated original artifact transfer.');
    try { await this.authenticate(manifest); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await this.options.artifacts.importFile(transferred.path, manifest);
  }
  private async call(peerId: string, body: Record<string, unknown>): Promise<unknown> {
    this.requirePeer(peerId);
    const response = await this.options.peers.request(peerId, { method: 'POST', path: route, body }, 60_000);
    if (response.status !== 200) { const detail = response.body as { error?: string; code?: string }; throw new HttpError(response.status, detail?.error ?? 'The paired native profile endpoint rejected this request.', detail?.code); }
    return response.body;
  }
  private result(value: unknown, owner: string, input: InstallInput, key: string): NativeProfileSyncResult {
    const result = value as NativeProfileSyncResult;
    if (!result || result.id !== key || result.ownerDeviceId !== owner || result.auditId !== input.auditId || result.profileId !== input.profile.id || !['validating', 'unknown', 'configured', 'rejected'].includes(result.status)) throw new Error('The paired native profile installation response differs from its original request.');
    return result;
  }
  private unknown(key: string, owner: string, input: InstallInput, error: unknown): NativeProfileSyncResult {
    this.options.app.store.set<Outgoing>(outgoingBucket, { id: key, ownerDeviceId: owner, input, status: 'unknown' });
    return { id: key, ownerDeviceId: owner, auditId: input.auditId, profileId: input.profile.id, status: 'unknown', reason: error instanceof Error ? error.message : 'The paired native profile installation remains unresolved.' };
  }
  private saveOutgoing(input: InstallInput, result: NativeProfileSyncResult): void { this.options.app.store.set<Outgoing>(outgoingBucket, { id: result.id, ownerDeviceId: result.ownerDeviceId, input, status: result.status === 'configured' ? 'configured' : result.status === 'rejected' ? 'rejected' : 'unknown' }); }
  private patch(install: Install, fields: Partial<Install>): Install { const value = { ...install, ...fields, updatedAt: new Date().toISOString() }; this.options.app.store.set(bucket, value); return value; }
  private view(install: Install): NativeProfileSyncResult { return { id: install.id, ownerDeviceId: install.ownerDeviceId, auditId: install.auditId, profileId: install.profileId, status: install.status, ...(install.reason ? { reason: install.reason } : {}) }; }
}
