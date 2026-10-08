import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifacts.ts";
import { InspectionSnapshotManager } from "../src/inspection-snapshots.ts";
import { exportInspectionSnapshot } from "../src/inspection-snapshot-transfer.ts";
import { git } from "../src/process.ts";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-")));
  const source = join(directory, "source"), dataDir = join(directory, "owned");
  await mkdir(source); await mkdir(dataDir);
  await git(source, "init", "--quiet"); await git(source, "config", "user.name", "Fixture"); await git(source, "config", "user.email", "fixture@example.test");
  await writeFile(join(source, "source.txt"), "base\n"); await git(source, "add", "."); await git(source, "commit", "--quiet", "-m", "base");
  return { directory, source, dataDir, roots: [{ id: "primary", name: "app", path: source }], manager: new InspectionSnapshotManager({ dataDir, artifacts: new ArtifactStore(join(dataDir, "artifacts"), "fixture") }) };
}

test("dirty multi-root previews preserve exact bytes and untracked source without changing author Git or copying ignored caches", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, ".gitignore"), "ignored/\nignored-tracked.txt\n");
    await writeFile(join(f.source, ".gitattributes"), "*.txt text eol=lf\n");
    await writeFile(join(f.source, "ignored-tracked.txt"), "tracked input\n");
    await mkdir(join(f.source, "deleted")); await writeFile(join(f.source, "deleted", "old.txt"), "gone\n");
    await git(f.source, "add", "--force", "."); await git(f.source, "commit", "--quiet", "-m", "input rules");
    await writeFile(join(f.source, "source.txt"), "staged\n"); await git(f.source, "add", "source.txt");
    await writeFile(join(f.source, "source.txt"), "working CRLF\r\n"); await writeFile(join(f.source, "new.txt"), "untracked\r\n");
    await mkdir(join(f.source, "ignored")); await writeFile(join(f.source, "ignored", "cache.bin"), "never copy\n");
    await rm(join(f.source, "deleted"), { recursive: true });
    await symlink("source.txt", join(f.source, "source-link"));
    const extra = join(f.directory, "extra"); await mkdir(join(extra, "empty"), { recursive: true });
    await chmod(join(extra, "empty"), 0o550); await writeFile(join(extra, "notes.md"), "another declared root\n");
    const originalHead = await git(f.source, "rev-parse", "HEAD"), originalStatus = await git(f.source, "status", "--porcelain=v1", "--untracked-files=all");
    const originalIndex = createHash("sha256").update(await readFile(join(f.source, ".git", "index"))).digest("hex");
    const snapshot = await f.manager.create({ roots: [...f.roots, { id: "reference", name: "reference", path: extra }] });
    assert.equal(snapshot.manifest.previewOnly, true); assert.equal(snapshot.manifest.purpose, "development-inspection");
    assert.equal(snapshot.roots[0]!.sourceCommit, originalHead); assert.notEqual(snapshot.roots[0]!.commit, originalHead);
    assert.equal(snapshot.roots[0]!.path, join(snapshot.path, "source")); assert.equal(snapshot.roots[1]!.path, join(snapshot.path, "source-working-directories", "reference"));
    assert.equal(await readFile(join(snapshot.roots[0]!.path, "source.txt"), "utf8"), "working CRLF\r\n");
    assert.equal(await git(snapshot.roots[0]!.path, "show", "HEAD:source.txt"), "working CRLF");
    const committed = await import("../src/process.ts").then(({ run }) => run("git", ["-C", snapshot.roots[0]!.path, "show", "HEAD:new.txt"]));
    assert.equal(committed.stdout, "untracked\r\n", "synthetic commit must preserve raw bytes despite source .gitattributes");
    assert.equal(await readFile(join(snapshot.roots[0]!.path, "ignored-tracked.txt"), "utf8"), "tracked input\n");
    await assert.rejects(lstat(join(snapshot.roots[0]!.path, "ignored")), { code: "ENOENT" });
    await assert.rejects(lstat(join(snapshot.roots[0]!.path, "deleted")), { code: "ENOENT" });
    assert.equal(await readlink(join(snapshot.roots[0]!.path, "source-link")), "source.txt");
    assert.equal((await lstat(join(snapshot.roots[1]!.path, "empty"))).mode & 0o777, 0o550);
    assert.ok(snapshot.manifestArtifact); await f.manager.verify(snapshot);
    assert.equal(await git(f.source, "rev-parse", "HEAD"), originalHead);
    assert.equal(await git(f.source, "status", "--porcelain=v1", "--untracked-files=all"), originalStatus);
    assert.equal(createHash("sha256").update(await readFile(join(f.source, ".git", "index"))).digest("hex"), originalIndex);
    await writeFile(join(snapshot.roots[0]!.path, "source.txt"), "unexpected mutation\n");
    await assert.rejects(f.manager.verify(snapshot), /source changed/);
    await assert.rejects(f.manager.remove({ ...snapshot, path: f.source }), /not owned/);
    await f.manager.remove(snapshot); await assert.rejects(lstat(snapshot.path), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("identical source deduplicates preview commits and bundle bytes while retaining independent author provenance", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, "source.txt"), "same dirty source\n");
    const first = await f.manager.create({ roots: f.roots });
    await git(f.source, "commit", "--quiet", "--allow-empty", "-m", "author provenance only");
    const second = await f.manager.create({ roots: f.roots });
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.roots[0]!.sourceCommit, second.roots[0]!.sourceCommit);
    assert.equal(first.sourceDigest, second.sourceDigest);
    assert.equal(first.roots[0]!.commit, second.roots[0]!.commit);
    assert.equal(await git(second.roots[0]!.path, "log", "-1", "--format=%at %ct %an <%ae> %cn <%ce>"), "946684800 946684800 EnoughFactory <factory@enoughtools.com> EnoughFactory <factory@enoughtools.com>");
    const artifacts = new ArtifactStore(join(f.dataDir, "dedupe-artifacts"), "fixture");
    const context = { goalId: "goal", taskId: "task", attemptId: "attempt" };
    const firstTransfer = await exportInspectionSnapshot({ snapshot: first, artifacts, context });
    const secondTransfer = await exportInspectionSnapshot({ snapshot: second, artifacts, context });
    assert.equal(firstTransfer.sourceArtifacts[0]!.manifest.sha256, secondTransfer.sourceArtifacts[0]!.manifest.sha256);
    assert.deepEqual(await artifacts.read(firstTransfer.sourceArtifacts[0]!.manifest), await artifacts.read(secondTransfer.sourceArtifacts[0]!.manifest));
    assert.notEqual(firstTransfer.sourceManifest.sha256, secondTransfer.sourceManifest.sha256, "source observation/provenance manifests stay independent");
    const renamed = await f.manager.create({ roots: [{ ...f.roots[0]!, id: "other-root" }] });
    assert.notEqual(renamed.roots[0]!.commit, second.roots[0]!.commit, "preview identity includes the declared root");
    await f.manager.remove(first); await f.manager.remove(second); await f.manager.remove(renamed);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("explicit all-file retirement capture includes ignored bytes and empty directories without inventing export provenance", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, ".gitignore"), "generated/\n");
    await mkdir(join(f.source, "generated", "empty"), { recursive: true });
    await writeFile(join(f.source, "generated", "result.json"), '{"useful":true}\n');
    await chmod(join(f.source, "generated", "empty"), 0o550);
    const head = await git(f.source, "rev-parse", "HEAD");
    const standard = await f.manager.create({ roots: f.roots });
    await assert.rejects(lstat(join(standard.roots[0]!.path, "generated")), { code: "ENOENT" });
    const complete = await f.manager.create({ roots: f.roots, includeAll: true });
    assert.equal(complete.roots[0]!.sourceCommit, head);
    assert.equal(complete.roots[0]!.originalPath, undefined);
    assert.equal(complete.roots[0]!.manifestSha256, undefined);
    assert.equal(await readFile(join(complete.roots[0]!.path, "generated", "result.json"), "utf8"), '{"useful":true}\n');
    assert.equal((await lstat(join(complete.roots[0]!.path, "generated", "empty"))).mode & 0o777, 0o550);
    assert.notEqual(complete.sourceDigest, standard.sourceDigest);
    await f.manager.verify(complete);
    // The second inventory must use the same complete-file contract.
    await assert.rejects(f.manager.create({ roots: f.roots, includeAll: true, maxRetries: 0, onProgress: async event => {
      if (event.phase === "verifying") await writeFile(join(f.source, "generated", "result.json"), '{"useful":"changed"}\n');
    } }), /changed while/);
    assert.equal(await git(f.source, "rev-parse", "HEAD"), head);
    await f.manager.remove(standard); await f.manager.remove(complete);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a source change across any selected root retries the whole preview and does not leave partial snapshots", async () => {
  const f = await fixture();
  try {
    const extra = join(f.directory, "extra"); await mkdir(extra); await writeFile(join(extra, "notes.md"), "before\n");
    let retries = 0;
    const snapshot = await f.manager.create({ roots: [...f.roots, { id: "reference", name: "reference", path: extra }], onProgress: async event => {
      if (event.phase === "verifying" && event.attempt === 0) { await writeFile(join(extra, "notes.md"), "changed during primary build input capture\n"); retries++; }
    } });
    assert.equal(retries, 1); assert.equal(await readFile(join(snapshot.roots[1]!.path, "notes.md"), "utf8"), "changed during primary build input capture\n");
    assert.deepEqual(await readdir(join(f.dataDir, "inspection-snapshots")), [snapshot.id]);
    await f.manager.verify(snapshot); await f.manager.remove(snapshot);
    await assert.rejects(f.manager.create({ roots: f.roots, maxRetries: 0, onProgress: async event => { if (event.phase === "verifying") await writeFile(join(f.source, "source.txt"), "changed again\n"); } }), /changed while/);
    assert.deepEqual(await readdir(join(f.dataDir, "inspection-snapshots")), []);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("bounds, cancellation and escaping symlinks fail before publishing a preview", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.create({ roots: f.roots, maxBytes: 2 }), /byte limit/);
    await mkdir(join(f.source, "a")); await writeFile(join(f.source, "a", "x"), "x");
    await assert.rejects(f.manager.create({ roots: f.roots, maxEntries: 1 }), /entry limit/);
    const controller = new AbortController(); controller.abort(new Error("cancelled test"));
    await assert.rejects(f.manager.create({ roots: f.roots, signal: controller.signal }), /cancelled test/);
    await symlink("../outside", join(f.source, "unsafe"));
    await assert.rejects(f.manager.create({ roots: f.roots }), /symlink must remain inside/);
    assert.deepEqual(await readdir(join(f.dataDir, "inspection-snapshots")), []);
    const linked = join(f.directory, "linked"); await symlink(f.dataDir, linked);
    await assert.rejects(new InspectionSnapshotManager({ dataDir: linked }).create({ roots: f.roots }), /storage contains a symlink/);
    await assert.rejects(f.manager.create({ roots: [...f.roots, { id: "duplicate", name: "other", path: join(f.source, "a") }] }), /overlap/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("verified container exports retain original provenance while preview commits remain synthetic", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-export-")));
  try {
    const source = join(directory, "exported"); await mkdir(source); await writeFile(join(source, "source.swift"), "let fromContainer = true\n");
    const manager = new InspectionSnapshotManager({ dataDir: join(directory, "owned") });
    const sourceCommit = "a".repeat(40);
    const snapshot = await manager.create({ roots: [{ id: "primary", name: "app", path: source, kind: "git", sourceCommit }] });
    assert.equal(snapshot.roots[0]!.kind, "git"); assert.equal(snapshot.roots[0]!.sourceCommit, sourceCommit); assert.notEqual(snapshot.roots[0]!.commit, sourceCommit);
    await manager.verify(snapshot); await manager.remove(snapshot);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ignored cache churn does not invalidate an unchanged selected source tree", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.source, "Sources")); await writeFile(join(f.source, "Sources", "source.swift"), "let authored = true\n");
    await writeFile(join(f.source, ".gitignore"), "Sources/.build/\n"); await git(f.source, "add", "."); await git(f.source, "commit", "--quiet", "-m", "nested source");
    const snapshot = await f.manager.create({ roots: f.roots, maxRetries: 0, onProgress: async event => {
      if (event.phase === "verifying") { await mkdir(join(f.source, "Sources", ".build")); await writeFile(join(f.source, "Sources", ".build", "cache"), "concurrent build output\n"); }
    } });
    await f.manager.verify(snapshot); await f.manager.remove(snapshot);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("working-tree type changes replace old tracked descendants without traversing new symlinks", async () => {
  const f = await fixture();
  try {
    for (const directory of ["becomes-file", "becomes-link"]) { await mkdir(join(f.source, directory)); await writeFile(join(f.source, directory, "tracked.txt"), "old tracked descendant\n"); }
    await mkdir(join(f.source, "target")); await writeFile(join(f.source, "target", "kept.txt"), "contained link destination\n");
    await git(f.source, "add", "."); await git(f.source, "commit", "--quiet", "-m", "original directory trees");
    await rm(join(f.source, "becomes-file"), { recursive: true }); await writeFile(join(f.source, "becomes-file"), "replacement file\n");
    await rm(join(f.source, "becomes-link"), { recursive: true }); await symlink("target", join(f.source, "becomes-link"));
    const snapshot = await f.manager.create({ roots: f.roots, maxRetries: 0 });
    assert.equal(await readFile(join(snapshot.roots[0]!.path, "becomes-file"), "utf8"), "replacement file\n");
    assert.equal(await readlink(join(snapshot.roots[0]!.path, "becomes-link")), "target");
    assert.equal(snapshot.manifest.roots[0]!.entries.some(entry => entry.path === "becomes-link/tracked.txt"), false);
    await f.manager.verify(snapshot); await f.manager.remove(snapshot);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("exported bytes inside an ignored host repository folder retain their container identity", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, ".gitignore"), "scratch/\n"); await git(f.source, "add", ".gitignore"); await git(f.source, "commit", "--quiet", "-m", "host scratch ignore");
    const exported = join(f.source, "scratch", "container-root"); await mkdir(exported, { recursive: true }); await writeFile(join(exported, "new.swift"), "let dirtyContainerSource = true\n");
    const originalPath = "/workspaces/app", sourceCommit = "c".repeat(40), manifestSha256 = "d".repeat(64);
    const snapshot = await f.manager.create({ roots: [{ id: "primary", name: "app", path: exported, kind: "git", sourceCommit, originalPath, manifestSha256 }] });
    assert.equal(snapshot.roots[0]!.sourceCommit, sourceCommit); assert.equal(snapshot.roots[0]!.originalPath, originalPath); assert.equal(snapshot.roots[0]!.manifestSha256, manifestSha256);
    assert.equal(snapshot.manifest.roots[0]!.sourceCommit, sourceCommit); assert.equal(snapshot.manifest.roots[0]!.manifestSha256, manifestSha256);
    assert.equal(await readFile(join(snapshot.roots[0]!.path, "new.swift"), "utf8"), "let dirtyContainerSource = true\n");
    await f.manager.verify(snapshot); await f.manager.remove(snapshot);
    // Ordinary explicitly selected folders are independent roots too, even below another repo.
    const folder = await f.manager.create({ roots: [{ id: "folder", name: "folder", path: exported }] });
    assert.equal(folder.roots[0]!.kind, "folder"); assert.equal(folder.roots[0]!.sourceCommit, undefined);
    assert.equal(await readFile(join(folder.roots[0]!.path, "new.swift"), "utf8"), "let dirtyContainerSource = true\n");
    await f.manager.verify(folder); await f.manager.remove(folder);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
