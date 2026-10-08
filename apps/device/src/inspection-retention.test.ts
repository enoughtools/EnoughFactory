import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, InspectionSnapshotManager, type InspectionSnapshot, type InspectionSnapshotTransfer } from '@enoughfactory/workspaces';
import type { InspectionAuthority, InspectionJob, InspectionSession } from '@enoughfactory/contracts';
import { InspectionJobs, type InspectionLease } from './inspection-jobs.ts';
import { InspectionRetention } from './inspection-retention.ts';
import { Store } from './store.ts';

const authority: InspectionAuthority = { goalId: 'goal-mail', goalRevision: 4, taskId: 'native-ui', attemptId: 'author-2', authorityGeneration: 2, policyRevision: 1 };
type Reader = Pick<InspectionJobs, 'listJobs' | 'sessions' | 'leases'>;
interface Receipt { id: string; version: 1; sourceDigest: string; authority: InspectionAuthority; transfer: InspectionSnapshotTransfer; retainedAt: number; lastUsedAt: number; retiredAt?: number }

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'enough-inspection-retention-')));
  const dataDir = join(directory, 'device'), primary = join(directory, 'mail'), secondary = join(directory, 'design-system');
  await mkdir(primary); await mkdir(join(secondary, 'empty'), { recursive: true });
  await writeFile(join(primary, 'app.ts'), 'export const layout = "repaired";\r\n');
  await writeFile(join(secondary, 'tokens.css'), ':root { --spacing: 12px; }\n', { mode: 0o444 });
  await chmod(join(secondary, 'empty'), 0o555);
  const artifacts = new ArtifactStore(join(dataDir, 'artifacts'), 'mac-device');
  const snapshots = new InspectionSnapshotManager({ dataDir, artifacts });
  let store = new Store(dataDir), time = Date.parse('2026-10-08T22:00:00.000Z');
  const active = new Set<string>();
  const jobsOptions = { deviceId: 'mac-device', authorityCurrent: () => true, now: () => new Date(time).toISOString() };
  let jobs = new InspectionJobs(store, jobsOptions), reader: Reader = jobs;
  const createRetention = () => new InspectionRetention({ dataDir, artifacts, store, jobs: reader, activeJobIds: () => active, clock: () => time });
  let retention = createRetention();
  t.after(async () => { store.close(); await chmod(join(secondary, 'empty'), 0o755).catch(() => undefined); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, dataDir, primary, secondary, artifacts, snapshots, active,
    get store() { return store; }, get jobs() { return jobs; }, get retention() { return retention; },
    advance(ms = 6 * 60_000) { time += ms; },
    useReader(value: Reader) { reader = value; retention = createRetention(); },
    restart() { store.close(); store = new Store(dataDir); jobs = new InspectionJobs(store, jobsOptions); reader = jobs; retention = createRetention(); },
    capture: () => snapshots.create({ roots: [{ id: 'mail', name: 'Mail', path: primary }, { id: 'ui', name: 'EnoughUI', path: secondary }] }),
    receipt: (id: string) => store.get<Receipt>('inspection-source-retention', id)!,
    job(snapshot: InspectionSnapshot, scope = authority) {
      const grant = jobs.issueAuthority(scope, { capabilities: ['macos-app-inspection'], executionTargetIds: ['mac'] });
      const job = jobs.createJob(grant.token, { idempotencyKey: `inspect-${snapshot.id}-${scope.attemptId}`, capability: 'macos-app-inspection', executionTargetId: 'mac', profile: { fixture: 'private' }, source: { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, commit: root.commit })) } });
      return { job, token: grant.token };
    },
  };
}

test('retained all-root source survives cold cleanup and service restart with exact preview identity and durable artifacts', async t => {
  const f = await fixture(t), snapshot = await f.capture();
  const receipt = await f.retention.retain(snapshot, authority);
  assert.equal(receipt.id, snapshot.id);
  assert.equal(receipt.sourceDigest, snapshot.sourceDigest);
  assert.equal(receipt.transfer.sourceArtifacts.length, 2);
  assert.deepEqual(f.receipt(snapshot.id).transfer, receipt.transfer);
  const retainedArtifacts = [...receipt.transfer.sourceArtifacts.map(entry => entry.manifest), receipt.transfer.sourceManifest];
  const catalogIds = new Set(f.store.list<{ id: string }>('factory-artifacts').map(artifact => artifact.id));
  for (const artifact of retainedArtifacts) { assert.ok(catalogIds.has(artifact.id)); await f.artifacts.path(artifact); }
  const duplicate = await f.retention.retain(snapshot, authority);
  assert.deepEqual(duplicate.transfer, receipt.transfer, 'reusing the same frozen source and authority should not create new retention artifacts');
  f.advance();
  const swept = await f.retention.sweep();
  assert.deepEqual(swept.retiredSnapshotIds, [snapshot.id]);
  assert.ok(swept.retiredBytes > 0);
  await assert.rejects(lstat(snapshot.path), { code: 'ENOENT' });
  for (const artifact of retainedArtifacts) await f.artifacts.path(artifact);
  assert.ok(f.receipt(snapshot.id).retiredAt);
  f.restart();
  const restored = await f.retention.restore(snapshot.id);
  assert.equal(restored.id, snapshot.id); assert.equal(restored.sourceDigest, snapshot.sourceDigest);
  assert.deepEqual(restored.roots.map(({ id, commit, sourceDigest }) => ({ id, commit, sourceDigest })), snapshot.roots.map(({ id, commit, sourceDigest }) => ({ id, commit, sourceDigest })));
  assert.equal(await readFile(join(restored.roots[0]!.path, 'app.ts'), 'utf8'), 'export const layout = "repaired";\r\n');
  assert.equal(await readFile(join(restored.roots[1]!.path, 'tokens.css'), 'utf8'), ':root { --spacing: 12px; }\n');
  assert.equal((await lstat(join(restored.roots[1]!.path, 'tokens.css'))).mode & 0o777, 0o444);
  assert.equal((await lstat(join(restored.roots[1]!.path, 'empty'))).mode & 0o777, 0o555);
  await f.snapshots.verify(restored);
  assert.equal(f.receipt(snapshot.id).retiredAt, undefined);
  const fresh = await f.retention.sweep(); assert.ok(fresh.keptSnapshotIds.includes(snapshot.id));
  assert.equal(await readFile(join(f.primary, 'app.ts'), 'utf8'), 'export const layout = "repaired";\r\n');
});

test('byte pressure retires eligible old copies but keeps newly captured source even for a continuing author', async t => {
  const f = await fixture(t), old = await f.capture(); await f.retention.retain(old, authority);
  f.advance(20_000);
  await writeFile(join(f.primary, 'app.ts'), 'export const layout = "newer";\n');
  const fresh = await f.capture(); await f.retention.retain(fresh, authority);
  const swept = await f.retention.sweep({ maxSnapshotBytes: 1 });
  assert.ok(swept.retiredSnapshotIds.includes(old.id), 'disk pressure can retire an unused source before the normal five minute idle limit');
  assert.ok(swept.keptSnapshotIds.includes(fresh.id), 'new captures keep a grace period even under pressure');
  await assert.rejects(lstat(old.path), { code: 'ENOENT' }); await lstat(fresh.path);
  const restored = await f.retention.restore(old.id);
  assert.equal(await readFile(join(restored.roots[0]!.path, 'app.ts'), 'utf8'), 'export const layout = "repaired";\r\n');
  assert.equal(await readFile(join(fresh.roots[0]!.path, 'app.ts'), 'utf8'), 'export const layout = "newer";\n');
});

test('queued, admitted and uncertain jobs preserve their source until backend termination is positively confirmed', async t => {
  const f = await fixture(t), snapshot = await f.capture(); await f.retention.retain(snapshot, authority);
  const { job, token } = f.job(snapshot); f.advance();
  assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id));
  assert.equal(f.jobs.claimNext()?.id, job.id);
  f.jobs.markRunning(job.id); const session = f.jobs.openSession(job.id); f.jobs.markSessionReady(session.id);
  f.jobs.markUnknown(job.id, 'Native helper disconnected without termination acknowledgement');
  assert.ok(f.jobs.leases(job.id).some(lease => lease.status === 'held'));
  assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id));
  f.jobs.requestCancel(token, job.id);
  assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id));
  f.jobs.confirmSessionStopped(session.id); f.jobs.confirmCanceled(job.id);
  assert.ok(f.jobs.leases(job.id).every(lease => lease.status === 'released'));
  assert.ok((await f.retention.sweep()).retiredSnapshotIds.includes(snapshot.id));
});

test('live sessions, held leases and service-active work independently protect a terminal job source across authorities', async t => {
  const f = await fixture(t), snapshot = await f.capture(); await f.retention.retain(snapshot, authority);
  const otherAuthority = { ...authority, attemptId: 'new-author', authorityGeneration: 3 };
  const base: InspectionJob = { id: 'terminal-job', authority: otherAuthority, ownerDeviceId: 'mac-device', executionTargetId: 'mac', capability: 'macos-app-inspection', source: { snapshotId: snapshot.id, sha256: snapshot.sourceDigest }, profile: {}, status: 'succeeded', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let sessionStatus: InspectionSession['status'] = 'ready', held = false;
  const session: InspectionSession = { id: 'session', jobId: base.id, authority: otherAuthority, ownerDeviceId: 'mac-device', executionTargetId: 'mac', capability: 'macos-app-inspection', source: base.source, status: 'ready', createdAt: base.createdAt, updatedAt: base.updatedAt };
  const lease: InspectionLease = { id: 'lease', jobId: base.id, pool: 'native-desktop', key: 'mac-device', units: 1, status: 'held', createdAt: base.createdAt };
  f.useReader({ listJobs: () => [base], sessions: () => [{ ...session, status: sessionStatus }], leases: () => [{ ...lease, status: held ? 'held' : 'released' }] });
  f.advance();
  for (const status of ['ready', 'waiting', 'stopping', 'unknown'] as const) { sessionStatus = status; assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id), status); }
  sessionStatus = 'stopped'; held = true;
  assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id), 'a held lease is protection even if the journal says terminal');
  held = false; f.active.add(base.id);
  assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id));
  f.active.clear();
  assert.ok((await f.retention.sweep()).retiredSnapshotIds.includes(snapshot.id));
});

test('a newer author reusing a retained snapshot is protected even when its receipt belongs to the previous author', async t => {
  const f = await fixture(t), snapshot = await f.capture(); await f.retention.retain(snapshot, authority);
  const newer = { ...authority, attemptId: 'author-3', authorityGeneration: 3 }; const { job } = f.job(snapshot, newer);
  f.advance();
  assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id));
  await lstat(snapshot.path);
  assert.equal(f.jobs.getJob(job.id)?.status, 'queued');
});

test('missing secondary CAS data cannot retire the only private source and restore rejects incomplete retained evidence', async t => {
  const f = await fixture(t), snapshot = await f.capture(); const receipt = await f.retention.retain(snapshot, authority);
  const missing = receipt.transfer.sourceArtifacts[1]!.manifest; await rm(await f.artifacts.path(missing)); f.advance();
  const sweep = await f.retention.sweep({ maxSnapshotBytes: 1 });
  assert.ok(sweep.keptSnapshotIds.includes(snapshot.id));
  assert.ok(sweep.errors.some(error => error.snapshotId === snapshot.id), 'the owner should receive a concrete retention-integrity failure');
  await f.snapshots.verify(snapshot);
  assert.equal(f.receipt(snapshot.id).retiredAt, undefined);
  await f.snapshots.remove(snapshot);
  await assert.rejects(f.retention.restore(snapshot.id), /ENOENT|artifact|source|retained|missing/i);
  assert.equal(f.receipt(snapshot.id).transfer.sourceArtifacts.length, 2);
  await assert.rejects(lstat(snapshot.path), { code: 'ENOENT' });
});

test('work becoming active during asynchronous CAS verification is rechecked before destructive cleanup', async t => {
  const f = await fixture(t), snapshot = await f.capture(); await f.retention.retain(snapshot, authority);
  const { job } = f.job(snapshot); f.jobs.claimNext(); f.jobs.finishJob(job.id, { status: 'succeeded' });
  f.advance();
  const original = f.artifacts.path.bind(f.artifacts); let activate = true;
  f.artifacts.path = async artifact => { const path = await original(artifact); if (activate) { activate = false; f.active.add(job.id); } return path; };
  const swept = await f.retention.sweep({ maxSnapshotBytes: 1 });
  assert.ok(swept.keptSnapshotIds.includes(snapshot.id)); await f.snapshots.verify(snapshot);
});

test('an in-flight restore cannot race idle cleanup and lose the source being reopened', async t => {
  const f = await fixture(t), snapshot = await f.capture(); await f.retention.retain(snapshot, authority); f.advance();
  const original = f.artifacts.path.bind(f.artifacts);
  let release!: () => void, reached!: () => void, pause = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { reached = resolve; });
  f.artifacts.path = async artifact => { const path = await original(artifact); if (pause) { pause = false; reached(); await gate; } return path; };
  const restoring = f.retention.restore(snapshot.id);
  try {
    await entered;
    const swept = await f.retention.sweep({ maxSnapshotBytes: 1 });
    assert.ok(swept.keptSnapshotIds.includes(snapshot.id)); await lstat(snapshot.path);
  } finally { release(); }
  const restored = await restoring; await f.snapshots.verify(restored);
});

test('overlapping retained-source readers pin a reopened copy until the last build or inspection finishes', async t => {
  const f = await fixture(t), snapshot = await f.capture(); await f.retention.retain(snapshot, authority);
  let releaseFirst!: () => void, releaseSecond!: () => void, entered!: () => void, readers = 0;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const bothEntered = new Promise<void>(resolve => { entered = resolve; });
  const read = async (source: InspectionSnapshot, gate: Promise<void>) => {
    if (++readers === 2) entered(); await gate;
    assert.equal(await readFile(join(source.roots[0]!.path, 'app.ts'), 'utf8'), 'export const layout = "repaired";\r\n');
  };
  const first = f.retention.use(snapshot.id, source => read(source, firstGate));
  const second = f.retention.use(snapshot.id, source => read(source, secondGate));
  try {
    await bothEntered; f.advance();
    assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id));
    releaseFirst(); await first;
    assert.ok((await f.retention.sweep({ maxSnapshotBytes: 1 })).keptSnapshotIds.includes(snapshot.id), 'one completed reader must not unpin another live reader');
  } finally { releaseFirst(); releaseSecond(); }
  await Promise.all([first, second]);
  assert.ok((await f.retention.sweep()).retiredSnapshotIds.includes(snapshot.id));
});

test('failed all-root retention never licenses private source deletion or publishes an incomplete receipt', async t => {
  const f = await fixture(t), snapshot = await f.capture();
  const original = f.artifacts.putFile.bind(f.artifacts); let calls = 0;
  f.artifacts.putFile = async (file, metadata) => { if (++calls === 2) throw new Error('Secondary source persistence failed'); return original(file, metadata); };
  await assert.rejects(f.retention.retain(snapshot, authority), /Secondary source persistence failed/);
  assert.equal(f.store.get('inspection-source-retention', snapshot.id), undefined);
  f.advance();
  const swept = await f.retention.sweep({ maxSnapshotBytes: 1 });
  assert.equal(swept.retiredSnapshotIds.includes(snapshot.id), false);
  await f.snapshots.verify(snapshot);
});
