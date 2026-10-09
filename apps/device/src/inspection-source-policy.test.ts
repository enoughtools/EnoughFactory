import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ArtifactStore, InspectionSnapshotManager, exportInspectionSnapshot, importInspectionSnapshot } from '@enoughfactory/workspaces';
import { INSPECTION_SOURCE_MAX_BYTES } from './inspection-source-policy.ts';

const context = { goalId: 'mail-goal', taskId: 'native-review', attemptId: 'checked-author' };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('service source transfer policy retains exact roots and admits over-256 MiB declarations without trusting missing bytes', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'enough-inspection-source-policy-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'mail'), reference = join(directory, 'declared-evidence');
  await mkdir(source); await mkdir(reference);
  await writeFile(join(source, 'App.swift'), 'import SwiftUI\n');
  await writeFile(join(reference, 'historical-proof.json'), '{"status":"unverified"}\n');
  const authorData = join(directory, 'author'), ownerData = join(directory, 'owner');
  const artifacts = new ArtifactStore(join(directory, 'artifacts'), 'author-device');
  const manager = new InspectionSnapshotManager({ dataDir: authorData });
  const snapshot = await manager.create({ roots: [
    { id: 'primary', name: 'mail', path: source },
    { id: 'native-proof', name: 'declared-evidence', path: reference },
  ], maxBytes: INSPECTION_SOURCE_MAX_BYTES });
  const transfer = await exportInspectionSnapshot({ snapshot, artifacts, context, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
  const imported = await importInspectionSnapshot({ dataDir: ownerData, artifacts, ...transfer, context, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
  assert.deepEqual(imported.manifest, JSON.parse(JSON.stringify(snapshot.manifest)));
  assert.equal(await readFile(join(imported.roots[1]!.path, 'historical-proof.json'), 'utf8'), '{"status":"unverified"}\n');
  await new InspectionSnapshotManager({ dataDir: ownerData }).remove(imported);

  // Exercise the policy boundary with metadata rather than allocating hundreds
  // of MiB. The real Git bundle remains small, so byte integrity must still fail.
  const pack = JSON.parse((await artifacts.read(transfer.sourceManifest)).toString('utf8'));
  pack.snapshot.roots[1].entries.find((entry: { kind: string }) => entry.kind === 'file').size = 281_462_331;
  pack.snapshot.roots[1].sourceDigest = hash(pack.snapshot.roots[1].entries);
  pack.snapshot.sourceDigest = hash(pack.snapshot.roots.map((root: { id: string; name: string; sourceDigest: string }) => ({ id: root.id, name: root.name, sourceDigest: root.sourceDigest })));
  const originalBundle = transfer.sourceArtifacts[1]!.manifest;
  pack.sourceArtifacts[1].manifest = await artifacts.putFile(await artifacts.path(originalBundle), {
    ...context, name: 'declared-large-proof.bundle', mime: originalBundle.mime,
    metadata: { ...originalBundle.metadata, sourceDigest: pack.snapshot.roots[1].sourceDigest },
  });
  const sourceManifest = await artifacts.put(JSON.stringify(pack), {
    ...context, name: 'declared-large-source.json', mime: transfer.sourceManifest.mime,
    metadata: { ...transfer.sourceManifest.metadata, sourceDigest: pack.snapshot.sourceDigest },
  });
  const input = { dataDir: ownerData, artifacts, sourceArtifacts: pack.sourceArtifacts, sourceManifest, context };
  await assert.rejects(importInspectionSnapshot(input), /source exceeds its byte limit/);
  await assert.rejects(importInspectionSnapshot({ ...input, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } }), /blob does not match its source digest/);
  assert.deepEqual(await readdir(join(ownerData, 'inspection-snapshots')), [], 'fabricated declared length must never publish a source');
  await manager.verify(snapshot);
  assert.equal(await readFile(join(reference, 'historical-proof.json'), 'utf8'), '{"status":"unverified"}\n');
  await manager.remove(snapshot);
});
