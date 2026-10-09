import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Goal, InspectionAuthority, InspectionSourceIdentity } from '@enoughfactory/contracts';
import { ArtifactStore, InspectionSnapshotManager, exportInspectionSnapshot, type ArtifactManifest } from '@enoughfactory/workspaces';
import type { DeviceApp } from './app.ts';
import type { NativeFixtureProfile } from './inspection-native.ts';
import type { NativeProfileAudit, NativeProfileProposal } from './inspection-profile-setup.ts';
import { NativeProfileSync, type NativeProfileAuditRead, type NativeProfileSyncOptions } from './inspection-profile-sync.ts';
import { Store } from './store.ts';
import { HttpError } from './util.ts';

const purposes = ['entry', 'storage', 'credentials', 'providers', 'preferences', 'notifications', 'build'];
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');

/** Real SQLite, frozen all-root source, Git bundle import and original read bytes; only paired transport is injected. */
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-profile-sync-'))), primary = path.join(directory, 'app'), secondary = path.join(directory, 'design');
  await mkdir(path.join(primary, 'Demo.xcodeproj'), { recursive: true }); await mkdir(secondary);
  await writeFile(path.join(primary, 'App.swift'), '// Fixture arguments are validated before all production constructors.\nlet fixtureOnly = true\n');
  await writeFile(path.join(primary, 'Demo.xcodeproj', 'project.pbxproj'), '// Original fixed isolated build recipe.\n');
  await writeFile(path.join(secondary, 'Tokens.swift'), '// Original fixture preferences use a fresh run namespace.\n');
  const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 3, taskId: 'task', attemptId: 'attempt', authorityGeneration: 2, policyRevision: 3 };
  const context = { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId };
  interface Device { app: DeviceApp; store: Store; artifacts: ArtifactStore; sync: NativeProfileSync; options: NativeProfileSyncOptions; configured: NativeFixtureProfile[]; }
  const devices = new Map<string, Device>(), transfers: Array<{ sender: string; recipient: string; manifest: ArtifactManifest }> = [], requests: Array<{ sender: string; recipient: string; body: Record<string, unknown> }> = [];
  let audit!: NativeProfileAudit, reads: NativeProfileAuditRead[] = [], current = true, dropReply = false, failConfiguration = false;
  let transformReply: ((reply: unknown) => unknown) | undefined, afterTransfer: (() => void) | undefined, onOriginal: (() => void) | undefined;
  for (const deviceId of ['linux', 'mac']) {
    const home = path.join(directory, deviceId), store = new Store(home), artifacts = new ArtifactStore(path.join(home, 'artifacts'), deviceId), configured: NativeFixtureProfile[] = [];
    const app = { dataDir: home, device: { id: deviceId }, devices: [{ id: deviceId, platform: deviceId === 'mac' ? 'darwin' : 'linux', local: true }, { id: deviceId === 'mac' ? 'linux' : 'mac', platform: deviceId === 'mac' ? 'linux' : 'darwin', local: false }], store, extensions: [] } as unknown as DeviceApp;
    store.set('goals', { id: authority.goalId, projectId: 'project', status: 'running', approvalMode: 'approve-all' } as Goal);
    const options: NativeProfileSyncOptions = {
      app, artifacts,
      authorityCurrent: value => current && canonical(value) === canonical(authority),
      auditOriginal: async id => { assert.equal(deviceId, 'linux'); if (id !== audit.id) throw new HttpError(404, 'Unknown original audit.'); onOriginal?.(); return { audit, reads }; },
      configure: (projectId, profile) => {
        assert.equal(deviceId, 'mac'); assert.equal(projectId, 'project');
        store.set('inspection-project-profiles', { id: projectId, profiles: [profile] });
        if (failConfiguration) throw new Error('Interruption before the configuration transaction committed.');
        configured.push(profile);
      },
      peers: {
        async request(recipient, request) {
          requests.push({ sender: deviceId, recipient, body: request.body as Record<string, unknown> });
          try {
            let body = await devices.get(recipient)!.sync.handle(deviceId, request.body as Record<string, unknown>);
            if (transformReply && (request.body as { op: string }).op === 'audit') body = transformReply(body);
            if (dropReply && (request.body as { op: string }).op === 'install') { dropReply = false; throw new Error('Transport disconnected after remote configuration committed.'); }
            return { v: 1, id: 'rpc', status: 200, body };
          } catch (error) { if (!(error instanceof HttpError)) throw error; return { v: 1, id: 'rpc', status: error.status, body: { error: error.message, code: error.code } }; }
        },
        async uploadArtifact(recipient, filename, peerManifest) {
          const manifest = peerManifest as unknown as ArtifactManifest;
          const target = devices.get(recipient)!, transfer = path.join(directory, recipient, 'transfers', manifest.id);
          await mkdir(path.dirname(transfer), { recursive: true }); await copyFile(filename, transfer);
          target.store.set('peer-artifacts', { id: manifest.id, peerId: deviceId, manifest, path: transfer });
          transfers.push({ sender: deviceId, recipient, manifest }); afterTransfer?.();
        },
      },
    };
    const sync = new NativeProfileSync(options); sync.initialize(); devices.set(deviceId, { app, store, artifacts, sync, options, configured });
  }
  t.after(async () => { for (const device of devices.values()) device.store.close(); await rm(directory, { recursive: true, force: true }); });
  const linux = devices.get('linux')!, mac = devices.get('mac')!, snapshots = new InspectionSnapshotManager({ dataDir: path.join(directory, 'snapshots'), artifacts: linux.artifacts });
  const snapshot = await snapshots.create({ roots: [{ id: 'primary', name: 'primary', path: primary }, { id: 'design', name: 'design', path: secondary }], context });
  const source: InspectionSourceIdentity = { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) };
  const proposal: NativeProfileProposal = { profile: { id: 'demo', build: { tool: 'xcodebuild', project: 'Demo.xcodeproj', scheme: 'Demo', platform: 'macos', configuration: 'Debug' }, launchArguments: ['--fixture', '{runId}'], fixtureExpectedDataRoot: '/tmp/enoughfactory-fixtures/{runId}', bundleIdentifier: 'tools.enough.demo' }, auditPaths: [{ rootId: 'primary', path: 'App.swift', purposes: ['entry', 'storage', 'credentials', 'providers', 'preferences', 'notifications'] }, { rootId: 'primary', path: 'Demo.xcodeproj/project.pbxproj', purposes: ['build'] }, { rootId: 'design', path: 'Tokens.swift', purposes: ['preferences'] }] };
  audit = { id: 'profile-audit-original', status: 'configured', requestKey: 'request', proposalSha256: hash(proposal), proposal, authority, source, ownerDeviceId: 'linux', projectId: 'project', sourceSessionId: 'author-session', snapshot, transfer: await exportInspectionSnapshot({ snapshot, artifacts: linux.artifacts, context }), chatId: 'independent-review-chat', sessionId: 'independent-review-session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  for (const root of snapshot.manifest.roots) for (const entry of root.entries) if (entry.kind === 'file') {
    const bytes = await readFile(path.join(snapshot.roots.find(value => value.id === root.id)!.path, ...entry.path.split('/'))), artifact = await linux.artifacts.put(bytes, { ...context, name: `audit-read-${reads.length}`, mime: 'application/octet-stream' });
    reads.push({ id: `read-${reads.length}`, runId: audit.id, chatId: audit.chatId!, rootId: root.id, path: entry.path, fileSha256: entry.sha256, offset: 0, length: bytes.length, fileSize: bytes.length, artifact });
  }
  let verdictBody: Record<string, any>, receiptBody: Record<string, any>;
  const refreshVerdict = async (mutate?: (body: Record<string, any>) => void) => {
    verdictBody = { version: 1, kind: 'independent-native-fixture-judgment', runId: audit.id, chatId: audit.chatId, source: audit.source, proposalSha256: audit.proposalSha256, judgment: 'source-review-not-runtime-proof', readIds: reads.map(read => read.id), verdict: { approved: true, findings: purposes.map(purpose => ({ purpose, reasoning: `Actual original ${purpose} control flow uses an isolated fixture namespace before production construction.`, files: purpose === 'build' ? [{ rootId: 'primary', path: 'Demo.xcodeproj/project.pbxproj' }] : [{ rootId: 'primary', path: 'App.swift' }] })) } };
    mutate?.(verdictBody); audit.verdict = await linux.artifacts.put(JSON.stringify(verdictBody), { ...context, name: 'original-verdict.json', mime: 'application/json' });
  };
  const refreshReceipt = async (mutate?: (body: Record<string, any>) => void) => {
    receiptBody = { version: 2, kind: 'native-fixture-source-audit', profileId: proposal.profile.id, ...proposal.profile, sourceSha256: snapshot.sourceDigest, sourceManifest: audit.transfer.sourceManifest, roots: snapshot.manifest.roots.map(root => ({ name: root.name, sourceDigest: root.sourceDigest, entries: root.entries.filter(entry => entry.kind === 'file').map(entry => ({ path: entry.path, sha256: entry.sha256 })) })), independentReview: { runId: audit.id, chatId: audit.chatId, verdict: audit.verdict, reads: reads.map(read => read.artifact), judgment: 'source-review-not-runtime-proof' } };
    mutate?.(receiptBody); audit.receipt = await linux.artifacts.put(JSON.stringify(receiptBody), { ...context, name: 'original-receipt.json', mime: 'application/json' });
  };
  await refreshVerdict(); await refreshReceipt();
  const profile = (): NativeFixtureProfile => ({ ...proposal.profile, fixtureEvidenceSha256: audit.receipt!.sha256, receipt: audit.receipt });
  return { directory, devices, linux, mac, audit, reads, snapshot, transfers, requests, profile, refreshVerdict, refreshReceipt, configureFailure(value: boolean) { failConfiguration = value; }, current(value: boolean) { current = value; }, dropReply() { dropReply = true; }, transformReply(value: typeof transformReply) { transformReply = value; }, afterTransfer(value: typeof afterTransfer) { afterTransfer = value; }, onOriginal(value: typeof onOriginal) { onOriginal = value; } };
}

test('a Linux source owner automatically syncs its original independent all-root native fixture audit to a paired Mac', async t => {
  const f = await fixture(t), profile = f.profile();
  const result = await f.linux.sync.sync(f.audit, profile, 'mac');
  assert.equal(result.status, 'configured'); assert.equal(f.mac.configured.length, 1); assert.deepEqual(f.mac.configured[0], profile);
  assert.equal(f.transfers.length, 2 + f.reads.length + 1 + f.audit.transfer.sourceArtifacts.length);
  for (const transfer of f.transfers) assert.deepEqual(await f.mac.artifacts.get(transfer.manifest.id), transfer.manifest);
  assert.equal(f.requests.filter(request => request.body.op === 'audit').length, 2, 'Owner independently fetches original configured audit before and after validation');
  assert.equal(f.mac.app.extensions.length, 1); assert.equal(f.linux.app.extensions.length, 1);
  const again = await f.linux.sync.sync(f.audit, profile, 'mac');
  assert.equal(again.status, 'configured'); assert.equal(f.mac.configured.length, 1); assert.equal(f.transfers.length, 2 + f.reads.length + 1 + f.audit.transfer.sourceArtifacts.length);
});

test('a lost remote install reply resolves through the same journal without repeating configuration', async t => {
  const f = await fixture(t); f.dropReply();
  const unknown = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(unknown.status, 'unknown'); assert.equal(f.mac.configured.length, 1);
  const done = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(done.status, 'configured'); assert.equal(done.id, unknown.id); assert.equal(f.mac.configured.length, 1);
  assert.equal(f.requests.filter(request => request.body.op === 'install').length, 1); assert.equal(f.requests.at(-1)!.body.op, 'status');
});

test('configuration and its successful journal commit roll back together, then the exact unknown install can resume', async t => {
  const f = await fixture(t); f.configureFailure(true);
  const unknown = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(unknown.status, 'unknown'); assert.equal(f.mac.store.get('inspection-project-profiles', 'project'), undefined); assert.equal(f.mac.configured.length, 0);
  f.configureFailure(false);
  const done = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(done.status, 'configured'); assert.equal(done.id, unknown.id); assert.equal(f.mac.configured.length, 1);
});

test('only paired execution devices can fetch or install original audit records', async t => {
  const f = await fixture(t);
  await assert.rejects(f.linux.sync.handle(undefined, { op: 'audit', auditId: f.audit.id }), /authenticated paired/);
  await assert.rejects(f.linux.sync.handle('stranger', { op: 'audit', auditId: f.audit.id }), /paired execution/);
  f.linux.app.devices.push({ id: 'web', platform: 'browser' } as never);
  await assert.rejects(f.linux.sync.handle('web', { op: 'audit', auditId: f.audit.id }), /paired execution/);
  assert.equal(f.mac.configured.length, 0);
});

test('an author supplied profile cannot replace the original configured audit', async t => {
  const f = await fixture(t);
  await assert.rejects(f.linux.sync.sync(f.audit, { ...f.profile(), launchArguments: ['--production'] }, 'mac'), /original configured/);
  f.audit.status = 'running'; await assert.rejects(f.linux.sync.sync(f.audit, f.profile(), 'mac'), /no longer current/);
  assert.equal(f.transfers.length, 0); assert.equal(f.mac.configured.length, 0);
});

test('the source owner enforces original goal project, current authority and Approve all policy', async t => {
  const f = await fixture(t);
  f.current(false); await assert.rejects(f.linux.sync.sync(f.audit, f.profile(), 'mac'), /no longer current/); f.current(true);
  f.linux.store.set('goals', { id: 'goal', projectId: 'different-project', status: 'running', approvalMode: 'approve-all' });
  await assert.rejects(f.linux.sync.sync(f.audit, f.profile(), 'mac'), /no longer current/);
  f.linux.store.set('goals', { id: 'goal', projectId: 'project', status: 'running', approvalMode: 'manual' });
  await assert.rejects(f.linux.sync.sync(f.audit, f.profile(), 'mac'), /no longer current/); assert.equal(f.mac.configured.length, 0);
});

test('authority retirement after transfer or before commit never configures the paired profile', async t => {
  const f = await fixture(t); f.afterTransfer(() => f.current(false));
  const first = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.notEqual(first.status, 'configured'); assert.equal(f.mac.configured.length, 0);
  f.current(true); f.afterTransfer(undefined); let fetches = 0;
  f.onOriginal(() => { if (++fetches === 4) f.current(false); });
  const second = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.notEqual(second.status, 'configured'); assert.equal(f.mac.configured.length, 0);
});

for (const [name, change] of [
  ['run identity', (body: Record<string, any>) => { body.runId = 'profile-audit-other'; }],
  ['chat identity', (body: Record<string, any>) => { body.chatId = 'author-chat'; }],
  ['source identity', (body: Record<string, any>) => { body.source = { ...body.source, sha256: '0'.repeat(64) }; }],
  ['original read IDs', (body: Record<string, any>) => { body.readIds = ['invented']; }],
  ['approval judgment', (body: Record<string, any>) => { body.verdict.approved = false; }],
  ['all purpose findings', (body: Record<string, any>) => { body.verdict.findings = body.verdict.findings.filter((finding: { purpose: string }) => finding.purpose !== 'credentials'); }],
] as const) test(`a transferred independent verdict with changed ${name} is rejected before native configuration`, async t => {
  const f = await fixture(t); await f.refreshVerdict(change); await f.refreshReceipt();
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.equal(f.mac.configured.length, 0);
});

for (const [name, change] of [
  ['legacy receipt', (body: Record<string, any>) => { body.version = 1; }],
  ['root digest', (body: Record<string, any>) => { body.roots[1].sourceDigest = '0'.repeat(64); }],
  ['missing secondary source', (body: Record<string, any>) => { body.roots.pop(); }],
  ['omitted file', (body: Record<string, any>) => { body.roots[0].entries.pop(); }],
  ['editable exception', (body: Record<string, any>) => { body.roots[0].allowedPaths = ['App.swift']; }],
  ['subdirectory exception', (body: Record<string, any>) => { body.roots[0].protectedSourceDirectories = ['Sources']; }],
  ['different read dependencies', (body: Record<string, any>) => { body.independentReview.reads = []; }],
  ['missing source transfer manifest', (body: Record<string, any>) => { delete body.sourceManifest; }],
  ['substituted source transfer manifest', (body: Record<string, any>) => { body.sourceManifest = { ...body.sourceManifest, id: 'substituted-manifest' }; }],
] as const) test(`automatic paired profiles reject ${name} in an otherwise authentic receipt`, async t => {
  const f = await fixture(t); await f.refreshReceipt(change);
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.equal(f.mac.configured.length, 0);
});

test('artifact bodies from the original reader must equal their exact source offsets', async t => {
  const f = await fixture(t), original = f.reads[0]!;
  original.artifact = await f.linux.artifacts.put(Buffer.alloc(original.length, 0x78), { goalId: 'goal', taskId: 'task', attemptId: 'attempt', name: 'false-original-read', mime: 'application/octet-stream' });
  await f.refreshVerdict(); await f.refreshReceipt();
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.match(result.reason!, /read body differs/); assert.equal(f.mac.configured.length, 0);
});

test('partial original source reads do not count as a complete independent fixture review', async t => {
  const f = await fixture(t), read = f.reads.find(read => read.path === 'App.swift')!;
  read.length--;
  const original = await f.linux.artifacts.read(read.artifact); read.artifact = await f.linux.artifacts.put(original.subarray(0, read.length), { goalId: 'goal', taskId: 'task', attemptId: 'attempt', name: 'partial-original-read', mime: 'application/octet-stream' });
  await f.refreshVerdict(); await f.refreshReceipt();
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.match(result.reason!, /read every original starting file completely/); assert.equal(f.mac.configured.length, 0);
});

test('read metadata from the author chat cannot masquerade as the original independent review', async t => {
  const f = await fixture(t); f.reads[0]!.chatId = 'author-chat';
  await assert.rejects(f.linux.sync.sync(f.audit, f.profile(), 'mac'), /original independent source read metadata/); assert.equal(f.mac.configured.length, 0);
});

test('the owner compares the fetched original payload and immutable transfer manifests with the install request', async t => {
  const f = await fixture(t);
  f.transformReply(reply => { const copy = structuredClone(reply) as { audit: NativeProfileAudit }; copy.audit.projectId = 'different-project'; return copy; });
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.match(result.reason!, /differs from the proposed/); assert.equal(f.mac.configured.length, 0);
});

test('a copied original object without a matching sender transfer cannot configure a paired profile', async t => {
  const f = await fixture(t); f.afterTransfer(() => {
    const transfer = f.transfers.at(-1)!; const record = f.mac.store.get<{ id: string; peerId: string; manifest: ArtifactManifest; path: string }>('peer-artifacts', transfer.manifest.id)!;
    f.mac.store.set('peer-artifacts', { ...record, peerId: 'different-device' });
  });
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.match(result.reason!, /exact authenticated original artifact transfer/); assert.equal(f.mac.configured.length, 0);
});

test('retained validating installs become unknown after service restart without replaying configuration', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  f.mac.store.set('inspection-profile-peer-installs', { id: 'a'.repeat(64), ownerDeviceId: 'mac', peerId: 'linux', auditId: f.audit.id, profileId: f.profile().id, status: 'validating', input: {}, inputSha256: 'b'.repeat(64), createdAt: at, updatedAt: at });
  const resumed = new NativeProfileSync(f.mac.options); resumed.initialize();
  const status = await resumed.handle('linux', { op: 'status', id: 'a'.repeat(64) }) as { status: string; reason: string };
  assert.equal(status.status, 'unknown'); assert.match(status.reason, /service restarted/); assert.equal(f.mac.configured.length, 0);
});

test('compact v2 receipts bind every imported source root without duplicating the full file inventory', async t => {
  const f = await fixture(t); await f.refreshReceipt(body => { for (const root of body.roots) root.entries = []; });
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'configured'); assert.equal(f.mac.configured.length, 1);
});

test('an exact committed install remains reconcilable after the source goal is paused and author authority retires', async t => {
  const f = await fixture(t); f.dropReply();
  const unknown = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(unknown.status, 'unknown'); assert.equal(f.mac.configured.length, 1);
  f.current(false); f.linux.store.set('goals', { id: 'goal', projectId: 'project', status: 'paused', approvalMode: 'manual' });
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'configured'); assert.equal(result.id, unknown.id); assert.equal(f.mac.configured.length, 1);
  assert.equal(f.requests.filter(request => request.body.op === 'install').length, 1);
  assert.equal(f.linux.store.get<{ status: string }>('inspection-profile-peer-outgoing', unknown.id)?.status, 'configured');
});

test('maintenance reconciles pending committed outcomes after author retirement without uploading or installing', async t => {
  const f = await fixture(t); f.dropReply();
  const unknown = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(unknown.status, 'unknown'); f.current(false);
  const transferred = f.transfers.length, requests = f.requests.length;
  const results = await f.linux.sync.reconcilePending(); assert.equal(results.length, 1); assert.equal(results[0]!.status, 'configured'); assert.equal(results[0]!.id, unknown.id);
  assert.equal(f.mac.configured.length, 1); assert.equal(f.transfers.length, transferred); assert.deepEqual(f.requests.slice(requests).map(request => request.body.op), ['status']);
  assert.deepEqual(await f.linux.sync.reconcilePending(), []);
});

test('a source service update is unknown and the same installation resumes after the update', async t => {
  const f = await fixture(t); let update = true;
  f.transformReply(reply => { if (update) { update = false; throw new HttpError(409, 'Device service is updating.', 'SERVICE_UPDATING'); } return reply; });
  const unknown = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(unknown.status, 'unknown'); assert.equal(f.mac.configured.length, 0);
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'configured'); assert.equal(result.id, unknown.id); assert.equal(f.mac.configured.length, 1);
});

test('authority retirement during artifact authentication prevents serving the original audit', async t => {
  const f = await fixture(t), original = f.linux.artifacts.path.bind(f.linux.artifacts); let retired = false;
  f.linux.artifacts.path = async manifest => { const result = await original(manifest); if (!retired) { retired = true; f.current(false); } return result; };
  await assert.rejects(f.linux.sync.handle('mac', { op: 'audit', auditId: f.audit.id }), /no longer current/); assert.equal(f.mac.configured.length, 0);
});

test('selective policy requires an exact trusted durable audit approval for paired transfer', async t => {
  const f = await fixture(t); f.linux.store.set('goals', { id: 'goal', projectId: 'project', status: 'running', approvalMode: 'manual' });
  f.linux.options.auditApproved = audit => audit.id === f.audit.id && audit.proposalSha256 === f.audit.proposalSha256 && audit.source.sha256 === f.snapshot.sourceDigest;
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'configured'); assert.equal(f.mac.configured.length, 1);
});

for (const kind of ['receipt', 'verdict'] as const) for (const body of ['not JSON', 'null', '[]']) test(`invalid ${kind} structured evidence ${body} is rejected permanently rather than retried as unknown`, async t => {
  const f = await fixture(t), artifact = await f.linux.artifacts.put(body, { goalId: 'goal', taskId: 'task', attemptId: 'attempt', name: `invalid-${kind}`, mime: 'application/json' });
  f.audit[kind] = artifact; if (kind === 'verdict') await f.refreshReceipt();
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.match(result.reason!, /invalid structured evidence/); assert.equal(f.mac.configured.length, 0);
});

test('malformed immutable source roots are a typed rejection before an install journal can be written', async t => {
  const f = await fixture(t);
  await assert.rejects(f.mac.sync.handle('linux', { op: 'install', id: 'a'.repeat(64), input: { auditId: f.audit.id, projectId: 'project', authority: f.audit.authority, source: { ...f.audit.source, roots: [null] }, proposalSha256: f.audit.proposalSha256, profile: f.profile(), transfer: f.audit.transfer } }), error => error instanceof HttpError && error.status === 400);
  assert.equal(f.mac.store.list('inspection-profile-peer-installs').length, 0); assert.equal(f.mac.configured.length, 0);
});

for (const [name, change] of [
  ['null root', (body: Record<string, any>) => { body.roots = [null]; }],
  ['non-array exception', (body: Record<string, any>) => { body.roots[0].allowedPaths = {}; }],
] as const) test(`malformed receipt ${name} is rejected as immutable invalid evidence`, async t => {
  const f = await fixture(t); await f.refreshReceipt(change);
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.equal(f.mac.configured.length, 0);
});

test('malformed verdict findings are rejected as immutable invalid evidence', async t => {
  const f = await fixture(t); await f.refreshVerdict(body => { body.verdict.findings[0] = null; }); await f.refreshReceipt();
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.equal(f.mac.configured.length, 0);
});

for (const body of ['null', 'not JSON', '{"version":1,"purpose":"inspection-snapshot-transfer","snapshot":null}']) test(`invalid source transfer ${body} is rejected before workspace materialization`, async t => {
  const f = await fixture(t), original = f.audit.transfer.sourceManifest;
  f.audit.transfer.sourceManifest = await f.linux.artifacts.put(body, { goalId: 'goal', taskId: 'task', attemptId: 'attempt', name: 'invalid-transfer.json', mime: 'application/json', metadata: original.metadata });
  const result = await f.linux.sync.sync(f.audit, f.profile(), 'mac'); assert.equal(result.status, 'rejected'); assert.equal(f.mac.configured.length, 0);
});
