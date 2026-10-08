import assert from "node:assert/strict";
import { chmod, lchmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { InspectionSnapshotManager } from "../src/inspection-snapshots.ts";
import { exportInspectionSnapshot, importInspectionSnapshot, type InspectionSnapshotTransfer } from "../src/inspection-snapshot-transfer.ts";

const context = { goalId: "goal", taskId: "task", attemptId: "attempt" };
async function cleanupFixture(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isDirectory() && !entry.isSymbolicLink()) { await chmod(path, (entry.mode & 0o777) | 0o700); for (const name of await readdir(path)) await cleanupFixture(join(path, name)); }
  await rm(path, { recursive: true, force: true });
}

async function fixture(largeBlob = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-transfer-")));
  const source = join(directory, "source"), secondary = join(directory, "secondary"), authorData = join(directory, "author"), ownerData = join(directory, "owner");
  await mkdir(source); await mkdir(join(source, "readonly")); await mkdir(join(secondary, "empty"), { recursive: true });
  await writeFile(join(source, ".gitattributes"), "*.txt text eol=crlf\n");
  if (largeBlob) await writeFile(join(source, "阅读-🦊\nsource.bin"), Buffer.alloc(9 * 1024 * 1024 + 13, 0xa5));
  await writeFile(join(source, "readonly", "source.txt"), "exact raw CRLF\r\n"); await chmod(join(source, "readonly", "source.txt"), 0o600);
  await chmod(join(source, "readonly"), 0o550); await chmod(join(secondary, "empty"), 0o750);
  await writeFile(join(secondary, "notes.md"), "independent root\n"); await symlink("readonly/source.txt", join(source, "source-link"));
  if (process.platform === "darwin") await lchmod(join(source, "source-link"), 0o777);
  const author = new ArtifactStore(join(authorData, "artifacts"), "author-device"), owner = new ArtifactStore(join(ownerData, "artifacts"), "owner-device");
  const manager = new InspectionSnapshotManager({ dataDir: authorData });
  const snapshot = await manager.create({ roots: [{ id: "primary", name: "primary", path: source }, { id: "docs", name: "docs", path: secondary }] });
  const transfer = await exportInspectionSnapshot({ snapshot, artifacts: author, context });
  const send = async (value: InspectionSnapshotTransfer = transfer) => { for (const artifact of [...value.sourceArtifacts.map(entry => entry.manifest), value.sourceManifest]) await owner.importFile(await author.path(artifact), artifact); };
  await send();
  return { directory, author, owner, ownerData, manager, snapshot, transfer, send };
}

test("remote snapshot transfer preserves dirty source identities, root modes, empty directories and symlink targets", async () => {
  const f = await fixture();
  try {
    const imported = await importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, context, expectedSource: { snapshotId: f.snapshot.id, sourceDigest: f.snapshot.sourceDigest } });
    assert.equal(imported.id, f.snapshot.id); assert.equal(imported.sourceDigest, f.snapshot.sourceDigest); assert.deepEqual(imported.manifest, JSON.parse(JSON.stringify(f.snapshot.manifest)));
    assert.equal(imported.roots[0]!.commit, f.snapshot.roots[0]!.commit); assert.notEqual(imported.roots[0]!.path, f.snapshot.roots[0]!.path);
    assert.equal(await readFile(join(imported.roots[0]!.path, "readonly", "source.txt"), "utf8"), "exact raw CRLF\r\n");
    assert.equal((await lstat(join(imported.roots[0]!.path, "readonly", "source.txt"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(imported.roots[0]!.path, "readonly"))).mode & 0o777, 0o550);
    assert.equal((await lstat(join(imported.roots[1]!.path, "empty"))).mode & 0o777, 0o750);
    assert.equal(await readlink(join(imported.roots[0]!.path, "source-link")), "readonly/source.txt");
    assert.equal((await lstat(join(imported.roots[0]!.path, "source-link"))).mode & 0o777, 0o777);
    const again = await importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, context });
    assert.equal(again.path, imported.path);
    const manager = new InspectionSnapshotManager({ dataDir: f.ownerData }); await manager.verify(imported); await manager.remove(imported);
    assert.equal(f.transfer.sourceArtifacts.every(entry => entry.manifest.deviceId === "author-device" && entry.manifest.attemptId === context.attemptId), true);
    await f.manager.verify(f.snapshot); await f.manager.remove(f.snapshot);
  } finally { await cleanupFixture(f.directory); }
});

test("wrong source, artifact sets, authority, manifest digests and escaping entries are rejected before publication", async () => {
  const f = await fixture();
  try {
    const base = { dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, context };
    await assert.rejects(importInspectionSnapshot({ ...base, expectedSource: { snapshotId: f.snapshot.id, sourceDigest: "0".repeat(64) } }), /different requested source/);
    await assert.rejects(importInspectionSnapshot({ ...base, sourceArtifacts: [...f.transfer.sourceArtifacts].reverse() }), /artifact set/);
    await assert.rejects(importInspectionSnapshot({ ...base, context: { ...context, attemptId: "different" } }), /author authority/);
    const pack = JSON.parse((await f.author.read(f.transfer.sourceManifest)).toString());
    for (const mode of ["digest", "path", "symlink"]) {
      const altered = structuredClone(pack);
      if (mode === "digest") altered.snapshot.roots[0].entries.find((entry: { kind: string }) => entry.kind === "file").sha256 = "f".repeat(64);
      if (mode === "path") altered.snapshot.roots[0].entries[0].path = "../escape";
      if (mode === "symlink") altered.snapshot.roots[0].entries.find((entry: { kind: string }) => entry.kind === "symlink").target = "/Users/someone/personal";
      const sourceManifest = await f.author.put(JSON.stringify(altered), { ...context, name: "tampered.json", mime: "application/json", metadata: f.transfer.sourceManifest.metadata }); await f.owner.importFile(await f.author.path(sourceManifest), sourceManifest);
      await assert.rejects(importInspectionSnapshot({ ...base, sourceManifest }), /digest|path|symlink/);
    }
    const storage = join(f.ownerData, "inspection-snapshots");
    await assert.rejects(lstat(storage), { code: "ENOENT" });
  } finally { await f.manager.remove(f.snapshot); await cleanupFixture(f.directory); }
});

test("corrupt bundles and advertised commit mismatches preserve unrelated snapshots and remove incomplete imports", async () => {
  const f = await fixture();
  try {
    const pack = JSON.parse((await f.author.read(f.transfer.sourceManifest)).toString());
    const fakeCommit = "e".repeat(40); pack.snapshot.roots[0].commit = fakeCommit; pack.sourceArtifacts[0].manifest.metadata.commit = fakeCommit;
    const sourceManifest = await f.author.put(JSON.stringify(pack), { ...context, name: "mismatched-commit.json", mime: "application/json", metadata: f.transfer.sourceManifest.metadata }); await f.owner.importFile(await f.author.path(sourceManifest), sourceManifest);
    await assert.rejects(importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, sourceManifest, sourceArtifacts: pack.sourceArtifacts, context }), /different synthetic commit/);
    assert.deepEqual(await readdir(join(f.ownerData, "inspection-snapshots")), []);
    const bundlePath = await f.owner.path(f.transfer.sourceArtifacts[0]!.manifest); await writeFile(bundlePath, "corrupt bundle\n");
    await assert.rejects(importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, context }), /integrity verification/);
    assert.deepEqual(await readdir(join(f.ownerData, "inspection-snapshots")), []);
    const unrelated = join(f.ownerData, "inspection-snapshots", f.snapshot.id); await mkdir(unrelated); await writeFile(join(unrelated, "keep.txt"), "uncertain preexisting work\n");
    await assert.rejects(importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, context }));
    assert.equal(await readFile(join(unrelated, "keep.txt"), "utf8"), "uncertain preexisting work\n");
  } finally { await f.manager.remove(f.snapshot); await cleanupFixture(f.directory); }
});

test("transfer byte limits and cancellation do not publish or mutate the author source", async () => {
  const f = await fixture();
  try {
    await assert.rejects(exportInspectionSnapshot({ snapshot: f.snapshot, artifacts: f.author, context, limits: { maxBytes: 1 } }), /byte limit/);
    await assert.rejects(importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, context, limits: { maxManifestBytes: 1 } }), /manifest exceeds/);
    const controller = new AbortController(); controller.abort(new Error("cancelled transfer"));
    await assert.rejects(exportInspectionSnapshot({ snapshot: f.snapshot, artifacts: f.author, context, signal: controller.signal }), /cancelled transfer/);
    await f.manager.verify(f.snapshot);
    assert.equal((await readdir(f.snapshot.path)).some(name => name.startsWith("transfer-")), false);
  } finally { await f.manager.remove(f.snapshot); await cleanupFixture(f.directory); }
});


test("remote blobs larger than text output limits stream without truncation and preserve Unicode paths", async () => {
  const f = await fixture(true);
  try {
    const imported = await importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, context });
    const bytes = await readFile(join(imported.roots[0]!.path, "阅读-🦊\nsource.bin"));
    assert.equal(bytes.length, 9 * 1024 * 1024 + 13); assert.equal(bytes.every(value => value === 0xa5), true);
    const manager = new InspectionSnapshotManager({ dataDir: f.ownerData }); await manager.verify(imported); await manager.remove(imported);
    await assert.rejects(exportInspectionSnapshot({ snapshot: f.snapshot, artifacts: f.author, context: { ...context, attemptId: undefined! } }), /complete author authority/);
    const incomplete = { ...f.transfer.sourceManifest, goalId: undefined, taskId: undefined, attemptId: undefined };
    await assert.rejects(importInspectionSnapshot({ dataDir: f.ownerData, artifacts: f.owner, ...f.transfer, sourceManifest: incomplete }), /complete author authority/);
  } finally { await f.manager.remove(f.snapshot); await cleanupFixture(f.directory); }
});
