import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { InspectionAuthority } from '@enoughfactory/contracts';
import { ArtifactStore, type ArtifactManifest } from '@enoughfactory/workspaces';
import { InspectionRemote, RemoteInspectionOutcomeUnknown, type InspectionRemoteOptions, type RemoteInspectionAssignmentInput, type RemoteInspectionOperation, type RemoteInspectionResult } from './inspection-remote.ts';
import { Store } from './store.ts';
import { HttpError } from './util.ts';

const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lH8AAAAASUVORK5CYII=', 'base64');
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'enough-inspection-peers-'));
  const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 7, taskId: 'task', attemptId: 'attempt-4', authorityGeneration: 4, policyRevision: 7 };
  const devices = new Map<string, { store: Store; artifacts: ArtifactStore; remote: InspectionRemote; options: InspectionRemoteOptions }>();
  const control: Array<{ sender: string; recipient: string; body: unknown }> = [];
  const transfers: Array<{ sender: string; recipient: string; manifest: ArtifactManifest }> = [];
  let current = true, effects = 0, dropReply = false, time = '2026-10-08T22:00:00.000Z';
  let execution: InspectionRemoteOptions['execute'] | undefined;
  let reconcile: InspectionRemoteOptions['reconcile'] | undefined;
  let corruptTransfer = false;
  for (const deviceId of ['coordinator', 'linux-author', 'mac-owner']) {
    const home = path.join(directory, deviceId), store = new Store(home), artifacts = new ArtifactStore(path.join(home, 'artifacts'), deviceId);
    const options: InspectionRemoteOptions = {
      store, artifacts, deviceId, now: () => time,
      isPairedDevice: id => ['coordinator', 'linux-author', 'mac-owner'].includes(id),
      authorityCurrent: value => current && JSON.stringify(value) === JSON.stringify(authority),
      authorOwnsAuthority: (value, author) => current && author === 'linux-author' && JSON.stringify(value) === JSON.stringify(authority),
      async verifySourceIdentity(assignment, sources) {
        const manifest = JSON.parse((await artifacts.read(assignment.sourceManifest)).toString('utf8')) as { sourceDigest: string; roots: Array<{ id: string; sourceDigest: string }> };
        assert.equal(manifest.sourceDigest, assignment.source.sha256, 'Snapshot manifest must match the claimed source identity');
        assert.deepEqual(manifest.roots, assignment.source.roots!.map(root => ({ id: root.id, sourceDigest: root.sha256 })));
        for (const source of sources) assert.equal(source.manifest.sha256, assignment.source.roots!.find(root => root.id === source.rootId)!.sha256, 'Transferred fixture inventory must match the claimed root identity');
      },
      peers: {
        async request(recipient, request) {
          control.push({ sender: deviceId, recipient, body: request.body });
          try {
            const value = await devices.get(recipient)!.remote.handle(deviceId, request.body as Record<string, unknown>);
            if (dropReply && request.body && (request.body as { op: string }).op === 'invoke') { dropReply = false; throw new Error('Transport closed after owner effect'); }
            return { v: 1, id: 'rpc-id', status: 200, body: value };
          } catch (error) { if (!(error instanceof HttpError)) throw error; return { v: 1, id: 'rpc-id', status: error.status, body: { error: error.message, code: error.code } }; }
        },
        async uploadArtifact(recipient, source, peerManifest) {
          const manifest = peerManifest as unknown as ArtifactManifest, target = devices.get(recipient)!;
          const transfer = path.join(directory, recipient, 'transfers', manifest.id); await mkdir(path.dirname(transfer), { recursive: true }); await copyFile(source, transfer);
          if (corruptTransfer) { corruptTransfer = false; await writeFile(transfer, 'changed bytes'); }
          target.store.set('peer-artifacts', { id: manifest.id, peerId: deviceId, manifest, path: transfer });
          transfers.push({ sender: deviceId, recipient, manifest });
        },
      },
      async execute(assignment, operation, sources, requestId) {
        assert.equal(deviceId, 'mac-owner'); effects++;
        assert.equal(sources.length, 2);
        assert.equal(await readFile(sources[0]!.path, 'utf8'), 'immutable primary source');
        assert.equal(await readFile(sources[1]!.path, 'utf8'), 'immutable component library');
        if (execution) return execution(assignment, operation, sources, requestId);
        const artifact = await artifacts.put(pixels, { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId, name: 'native-observation.png', mime: 'image/png' });
        return { content: [{ type: 'text', text: 'Inbox: observed on the owning Mac' }, { type: 'image', artifactId: artifact.id }], artifacts: [artifact], value: { sessionId: 'owned-native-session', sourceDigest: assignment.source.sha256 } };
      },
      reconcile: (...args) => reconcile?.(...args) ?? Promise.resolve(undefined),
    };
    devices.set(deviceId, { store, artifacts, options, remote: new InspectionRemote(options) });
  }
  t.after(async () => { for (const device of devices.values()) device.store.close(); await rm(directory, { recursive: true, force: true }); });
  const author = devices.get('linux-author')!, owner = devices.get('mac-owner')!, coordinator = devices.get('coordinator')!;
  const context = { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId };
  const main = await author.artifacts.put('immutable primary source', { ...context, name: 'primary.bundle', mime: 'application/x-git-bundle' });
  const component = await author.artifacts.put('immutable component library', { ...context, name: 'components.bundle', mime: 'application/x-git-bundle' });
  const roots = [{ id: 'primary', sha256: main.sha256 }, { id: 'components', sha256: component.sha256 }];
  const sourceDigest = createHash('sha256').update(JSON.stringify(roots)).digest('hex');
  const manifest = await author.artifacts.put(JSON.stringify({ purpose: 'development-inspection', previewOnly: true, sourceDigest, roots: roots.map(root => ({ id: root.id, sourceDigest: root.sha256 })) }), { ...context, name: 'snapshot.json', mime: 'application/json' });
  const assignment: RemoteInspectionAssignmentInput = {
    authority, coordinatorId: 'coordinator', authorDeviceId: 'linux-author', ownerDeviceId: 'mac-owner', executionTargetId: 'mac-host', capability: 'macos-app-inspection',
    source: { snapshotId: 'dirty-snapshot', sha256: sourceDigest, roots },
    profile: { profileId: 'mac-fixture' }, sourceArtifacts: [{ rootId: 'primary', manifest: main }, { rootId: 'components', manifest: component }], sourceManifest: manifest,
  };
  return {
    devices, author, owner, coordinator, authority, assignment, control, transfers,
    get effects() { return effects; }, dropReply: () => { dropReply = true; }, retire: () => { current = false; }, corruptTransfer: () => { corruptTransfer = true; },
    advance: () => { time = '2026-10-08T23:00:01.000Z'; }, setExecute: (value: InspectionRemoteOptions['execute']) => { execution = value; }, setReconcile: (value: InspectionRemoteOptions['reconcile']) => { reconcile = value; },
    restartOwner: () => { owner.store.close(); owner.store = new Store(path.join(directory, 'mac-owner')); owner.options = { ...owner.options, store: owner.store }; owner.remote = new InspectionRemote(owner.options); owner.remote.recoverAfterRestart(); },
  };
}
const observe: RemoteInspectionOperation = { name: 'observe', arguments: { sessionId: 'owned-native-session' } };

test('paired Linux author delegates to Mac through coordinator and receives verified screenshot pixels', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment, 'native-preview-1');
  const reply = await f.author.remote.invoke(handle, 'observe-1', observe);
  assert.equal(reply.status, 'completed'); assert.equal(f.effects, 1);
  const image = reply.content.find(item => item.type === 'image'); assert.equal(image?.type, 'image');
  if (image?.type === 'image') assert.deepEqual(Buffer.from(image.data, 'base64'), pixels);
  assert.equal(f.owner.remote.acceptedAuthorityCurrent(f.authority), true);
  assert.equal(f.transfers.filter(transfer => transfer.sender === 'linux-author' && transfer.recipient === 'mac-owner').length, 3, 'primary, components and original source manifest all transfer through the artifact lane');
  assert.equal(f.transfers.filter(transfer => transfer.sender === 'mac-owner' && transfer.recipient === 'linux-author').length, 1);
  assert.equal(JSON.stringify(f.control).includes(pixels.toString('base64')), false, 'image bytes never inflate the control or journal payload');
  assert.equal(JSON.stringify(f.owner.store.list('inspection-remote-private-grants')).includes(handle.token), false);
  assert.equal(JSON.stringify(f.owner.store.list('inspection-remote-requests')).includes(pixels.toString('base64')), false);
  assert.ok(f.control.some(call => call.sender === 'mac-owner' && call.recipient === 'coordinator' && (call.body as { op: string }).op === 'validate'));
});

test('repeated delegation and operation identities reuse the same journaled owner effect across new scoped grants', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment, 'native-preview-1');
  await f.author.remote.invoke(handle, 'observe-1', observe);
  const resumed = await f.author.remote.delegate(f.assignment, 'native-preview-1');
  assert.equal(resumed.assignmentId, handle.assignmentId); assert.notEqual(resumed.token, handle.token);
  await f.author.remote.invoke(resumed, 'observe-1', observe); assert.equal(f.effects, 1);
  await assert.rejects(f.author.remote.invoke(resumed, 'observe-1', { ...observe, arguments: { sessionId: 'different' } }), /different operation/);
  await assert.rejects(f.author.remote.delegate({ ...f.assignment, profile: { profileId: 'different' } }, 'native-preview-1'), /different immutable inputs/);
});

test('lost response after a native effect is recovered through the original request instead of replayed', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment);
  f.dropReply();
  await assert.rejects(f.author.remote.invoke(handle, 'observe-1', observe), error => error instanceof RemoteInspectionOutcomeUnknown && error.requestId === 'observe-1');
  assert.equal(f.effects, 1);
  const recovered = await f.author.remote.result(handle, 'observe-1'); assert.equal(recovered.status, 'completed'); assert.equal(f.effects, 1);
  await f.author.remote.invoke(handle, 'observe-1', observe); assert.equal(f.effects, 1);
});

test('owner restart retains an unknown request and only a discovered outcome can resolve it', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment);
  f.setExecute(async () => { throw new Error('Native helper disconnected after dispatch'); });
  assert.equal((await f.author.remote.invoke(handle, 'edit-1', { name: 'type', arguments: { text: 'A draft' } })).status, 'unknown');
  f.restartOwner(); assert.equal(f.owner.remote.acceptedAuthorityCurrent(f.authority), false);
  assert.equal((await f.author.remote.invoke(handle, 'edit-1', { name: 'type', arguments: { text: 'A draft' } })).status, 'unknown'); assert.equal(f.effects, 1);
  f.setReconcile(async (_assignment, _operation, requestId) => ({ content: [{ type: 'text', text: 'Owned app confirms draft value' }], value: { requestId, observedBody: 'A draft' } }));
  assert.equal((await f.author.remote.result(handle, 'edit-1')).status, 'completed'); assert.equal(f.effects, 1);
});

test('a paired device cannot hijack another author grant, invent a coordinator assignment or supply author paths', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment);
  await assert.rejects(f.owner.remote.handle('coordinator', { op: 'invoke', assignmentId: handle.assignmentId, token: handle.token, requestId: 'hijack', operation: observe }), /mismatched/i);
  await assert.rejects(f.owner.remote.handle(undefined, { op: 'invoke' }), /authenticated paired/);
  await assert.rejects(f.owner.remote.handle('browser-controller', { op: 'open' }), /authenticated paired/);
  await assert.rejects(f.coordinator.remote.handle('mac-owner', { op: 'issue', assignment: f.assignment }), /does not own/);
  await assert.rejects(f.author.remote.delegate({ ...f.assignment, sourceArtifacts: [{ ...f.assignment.sourceArtifacts[0]!, path: '/Users/private' } as never] }), /filesystem paths/);
  const issued = f.coordinator.remote.issueAssignment(f.assignment);
  await assert.rejects(f.owner.remote.handle('linux-author', { op: 'open', assignment: { ...issued, profile: { profileId: 'changed-after-authorization' } } }), /modified/);
  assert.equal(f.effects, 0);
});

test('retired authority blocks new native effects and prevents successful result publication', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment);
  f.setExecute(async () => { f.retire(); return { content: [{ type: 'text', text: 'Backend ended after author retirement' }], value: { allegedPassed: true } }; });
  await assert.rejects(f.author.remote.invoke(handle, 'long-build', { name: 'build', arguments: {} }), /no longer owns/);
  const record = f.owner.store.list<{ status: string; result?: unknown }>('inspection-remote-requests')[0]!;
  assert.equal(record.status, 'unknown'); assert.equal(record.result, undefined);
  await assert.rejects(f.author.remote.invoke(handle, 'another-build', { name: 'build', arguments: {} }), /no longer owns/); assert.equal(f.effects, 1);
});

test('source transfer tampering is rejected before native execution and grants expire', async t => {
  const f = await fixture(t); f.corruptTransfer();
  await assert.rejects(f.author.remote.delegate(f.assignment), /hash or size/); assert.equal(f.effects, 0);
  const other = await fixture(t), handle = await other.author.remote.delegate(other.assignment);
  other.advance(); other.retire();
  await assert.rejects(other.author.remote.invoke(handle, 'late', observe), /no longer owns/); assert.equal(other.effects, 0);
});

test('long native work and expired tokens reauthorize the same source/session journal without repeating effects', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment), originalToken = handle.token;
  f.setExecute(async () => { f.advance(); return { content: [{ type: 'text', text: 'Long native build completed' }], value: { originalSessionId: 'owned-native-session' } }; });
  assert.equal((await f.author.remote.invoke(handle, 'long-build', { name: 'build', arguments: {} })).status, 'completed');
  const reply = await f.author.remote.result(handle, 'long-build');
  assert.equal(reply.status, 'completed'); assert.equal(reply.value?.originalSessionId, 'owned-native-session'); assert.notEqual(handle.token, originalToken); assert.equal(f.effects, 1);
  const renewed = await f.author.remote.delegate(f.assignment); assert.equal(renewed.assignmentId, handle.assignmentId);
});

test('a claimed snapshot digest unrelated to the transferred source is rejected before any Mac effect', async t => {
  const f = await fixture(t);
  await assert.rejects(f.author.remote.delegate({ ...f.assignment, source: { ...f.assignment.source, sha256: 'a'.repeat(64) } }), /claimed source identity/);
  assert.equal(f.effects, 0);
});

test('image artifacts from another author attempt never reach the delegate conversation', async t => {
  const f = await fixture(t), handle = await f.author.remote.delegate(f.assignment);
  f.setExecute(async () => {
    const artifact = await f.owner.artifacts.put(pixels, { goalId: 'goal', taskId: 'task', attemptId: 'previous-attempt', name: 'wrong-source.png', mime: 'image/png' });
    return { artifacts: [artifact], content: [{ type: 'image', artifactId: artifact.id }] } satisfies RemoteInspectionResult;
  });
  const reply = await f.author.remote.invoke(handle, 'wrong-image', observe);
  assert.equal(reply.status, 'unknown'); assert.equal(reply.content.length, 0);
  assert.equal(f.transfers.some(transfer => transfer.sender === 'mac-owner'), false);
});
