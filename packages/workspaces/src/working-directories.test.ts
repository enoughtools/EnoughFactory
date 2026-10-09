import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { ArtifactStore } from "./artifacts.ts";
import { git } from "./process.ts";
import { fingerprintWorkingDirectories, validateWorkingDirectories, workingDirectoryEmptyDirectories, WorkingDirectoryManager } from "./working-directories.ts";

test("unchanged Git and folder inputs share CAS bundles across independent attempt identities while outputs retain separate receipts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-working-dedup-")));
  try {
    const source = join(root, "source"), folder = join(root, "folder"), owned = join(root, "owned");
    await mkdir(source); await mkdir(folder); await mkdir(owned);
    await git(source, "init", "--quiet");
    await git(source, "config", "user.name", "Fixture"); await git(source, "config", "user.email", "fixture@example.test");
    await writeFile(join(source, "tracked.txt"), "history\n");
    await git(source, "add", "."); await git(source, "commit", "-m", "original");
    const ancestor = await git(source, "rev-parse", "HEAD");
    await git(source, "branch", "earlier", ancestor); await git(source, "tag", "original", ancestor);
    await writeFile(join(source, "tracked.txt"), "current source\n");
    await git(source, "add", "."); await git(source, "commit", "-m", "current");
    await writeFile(join(source, "untracked.txt"), "untracked input\n");
    await writeFile(join(folder, "notes.txt"), "folder input\n");
    await mkdir(join(folder, "empty"), { mode: 0o750 }); await chmod(join(folder, "empty"), 0o750);
    const sources = [{ id: "git", name: "reference", path: source }, { id: "folder", name: "notes", path: folder }];
    const sourceRefs = await git(source, "show-ref"), sourceStatus = await git(source, "status", "--porcelain=v1", "--untracked-files=all");
    const artifacts = new ArtifactStore(join(owned, "artifacts"), "fixture-device");
    const manager = new WorkingDirectoryManager({ dataDir: owned, artifacts });
    const first = await manager.prepare({ identity: "first", sources });
    // Cross a Git timestamp boundary as well as changing the attempt identity.
    await setTimeout(1_100);
    const second = await manager.prepare({ identity: "second", sources });
    for (let index = 0; index < first.length; index++) {
      const before = first[index]!, after = second[index]!;
      assert.notEqual(before.path, after.path);
      assert.notEqual(before.sourceArtifact.id, after.sourceArtifact.id);
      assert.equal(before.baseCommit, after.baseCommit);
      assert.equal(before.sourceArtifact.sha256, after.sourceArtifact.sha256);
      assert.equal(await artifacts.path(before.sourceArtifact), await artifacts.path(after.sourceArtifact));
      assert.deepEqual(await artifacts.read(before.sourceArtifact), await artifacts.read(after.sourceArtifact));
    }
    await git(first[0]!.path, "merge-base", "--is-ancestor", ancestor, first[0]!.baseCommit);
    assert.equal(await git(source, "show-ref"), sourceRefs);
    assert.equal(await git(source, "status", "--porcelain=v1", "--untracked-files=all"), sourceStatus);

    const exported = join(owned, "exported"); await cp(first[1]!.path, exported, { recursive: true });
    await writeFile(join(exported, "notes.txt"), "author output\n");
    const outputOne = await manager.captureFromPath(first[1]!, exported, { attemptId: "attempt-one" });
    const outputTwo = await manager.captureFromPath(second[1]!, exported, { attemptId: "attempt-two" });
    assert.notEqual(outputOne.bundleArtifact.id, outputTwo.bundleArtifact.id);
    assert.notEqual(outputOne.bundleArtifact.metadata?.ref, outputTwo.bundleArtifact.metadata?.ref);
    assert.equal(outputOne.bundleArtifact.attemptId, "attempt-one");
    assert.equal(outputTwo.bundleArtifact.attemptId, "attempt-two");
    await writeFile(join(first[1]!.path, "notes.txt"), "private attempt edit\n");
    assert.equal(await readFile(join(second[1]!.path, "notes.txt"), "utf8"), "folder input\n");
    const { path: _privatePath, ...transferred } = first[1]!;
    const restored = (await manager.prepare({ identity: "restored", transferred: [transferred] }))[0]!;
    assert.equal(await readFile(join(restored.path, "notes.txt"), "utf8"), "folder input\n");
    assert.equal((await lstat(join(restored.path, "empty"))).mode & 0o777, 0o750);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("baseline dedup distinguishes file bytes, executable modes, symlink targets and empty directory inventories", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-working-dedup-inputs-")));
  try {
    const source = join(root, "source"), owned = join(root, "owned"); await mkdir(source); await mkdir(owned);
    await writeFile(join(source, "input.txt"), "original bytes\n"); await chmod(join(source, "input.txt"), 0o644);
    await symlink("target-one", join(source, "link"));
    await mkdir(join(source, "empty"), { mode: 0o750 }); await chmod(join(source, "empty"), 0o750);
    const sources = [{ id: "input", name: "input", path: source }];
    const artifacts = new ArtifactStore(join(owned, "artifacts"), "fixture-device");
    const manager = new WorkingDirectoryManager({ dataDir: owned, artifacts });
    let identity = 0;
    const snapshot = async () => (await manager.prepare({ identity: `input-${identity++}`, sources }))[0]!;
    const original = await snapshot();
    const differs = async () => {
      const changed = await snapshot();
      assert.notEqual(changed.baseCommit, original.baseCommit);
      assert.notEqual(changed.sourceArtifact.sha256, original.sourceArtifact.sha256);
      return changed;
    };
    await writeFile(join(source, "input.txt"), "changed bytes\n"); await differs();
    await writeFile(join(source, "input.txt"), "original bytes\n");
    await chmod(join(source, "input.txt"), 0o755); await differs(); await chmod(join(source, "input.txt"), 0o644);
    await rm(join(source, "link")); await symlink("target-two", join(source, "link")); await differs();
    await rm(join(source, "link")); await symlink("target-one", join(source, "link"));
    await chmod(join(source, "empty"), 0o700); await differs(); await chmod(join(source, "empty"), 0o750);
    await mkdir(join(source, "new-empty"));
    const addedDirectory = await differs();
    const { path: _privatePath, ...transferred } = addedDirectory;
    const restored = (await manager.prepare({ identity: "changed-inventory-transfer", transferred: [transferred] }))[0]!;
    assert.deepEqual(await workingDirectoryEmptyDirectories(restored.path), await workingDirectoryEmptyDirectories(source));
    await rm(join(source, "new-empty"), { recursive: true });
    const reverted = await snapshot();
    assert.equal(reverted.baseCommit, original.baseCommit);
    assert.equal(reverted.sourceArtifact.sha256, original.sourceArtifact.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("extra roots retain ignored/untracked files, isolate identities, and reconstruct exact output without original or agent Git writes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-working-roots-")));
  try {
    const source = join(root, "original"), primary = join(root, "primary"), owned = join(root, "owned");
    await mkdir(source); await mkdir(primary); await mkdir(owned);
    await git(source, "init", "--quiet");
    await git(source, "config", "user.name", "Fixture"); await git(source, "config", "user.email", "fixture@example.test");
    await writeFile(join(source, "tracked.txt"), "original\n");
    await writeFile(join(source, ".gitignore"), "ignored.txt\n");
    await git(source, "add", "."); await git(source, "commit", "-m", "original");
    const originalHead = await git(source, "rev-parse", "HEAD");
    await writeFile(join(source, "tracked.txt"), "local edit\n");
    await writeFile(join(source, "ignored.txt"), "ignored input\n");
    await writeFile(join(source, "untracked.txt"), "untracked input\n");
    await mkdir(join(source, "nested")); await writeFile(join(source, "nested", ".git"), "metadata must not be copied\n");
    await mkdir(join(source, "empty-parent", "child"), { recursive: true }); await chmod(join(source, "empty-parent", "child"), 0o750);
    await symlink("/a/path/that/does/not/exist", join(source, "preserved-link"));
    const link = join(root, "source-link"); await symlink(source, link);
    const configuration = [{ id: "extra", name: "reference", path: link }];
    const normalized = await validateWorkingDirectories(primary, configuration);
    assert.equal(normalized[0]!.path, source);
    await assert.rejects(validateWorkingDirectories(source, configuration), /overlap/);
    await assert.rejects(validateWorkingDirectories(primary, [{ ...configuration[0]!, name: "../escape" }]), /names/);
    const originalStatus = await git(source, "status", "--porcelain=v1", "--untracked-files=all");
    const originalRefs = await git(source, "show-ref");
    const fingerprint = await fingerprintWorkingDirectories(configuration);
    await writeFile(join(source, "ignored.txt"), "changed ignored input\n");
    assert.notEqual(await fingerprintWorkingDirectories(configuration), fingerprint);
    await writeFile(join(source, "ignored.txt"), "ignored input\n");
    const artifacts = new ArtifactStore(join(owned, "artifacts"), "fixture-device");
    const manager = new WorkingDirectoryManager({ dataDir: owned, artifacts });
    const [first, concurrent] = await Promise.all([manager.prepare({ identity: "attempt-one", sources: configuration }), manager.prepare({ identity: "attempt-one", sources: configuration })]);
    assert.deepEqual(concurrent, first);
    const snapshot = first[0]!;
    assert.equal(snapshot.kind, "git"); assert.equal(snapshot.sourceCommit, originalHead);
    assert.equal(await readFile(join(snapshot.path, "tracked.txt"), "utf8"), "local edit\n");
    assert.equal(await readFile(join(snapshot.path, "ignored.txt"), "utf8"), "ignored input\n");
    assert.equal(await readFile(join(snapshot.path, "untracked.txt"), "utf8"), "untracked input\n");
    assert.deepEqual(await readdir(join(snapshot.path, "nested")), []);
    assert.equal((await lstat(join(snapshot.path, "empty-parent", "child"))).mode & 0o777, 0o750);
    assert.deepEqual(snapshot.sourceArtifact.metadata?.emptyDirectories, await workingDirectoryEmptyDirectories(snapshot.path));
    assert.match(await git(snapshot.path, "ls-files"), /ignored.txt/);
    await git(snapshot.path, "merge-base", "--is-ancestor", originalHead, snapshot.baseCommit);
    await writeFile(join(source, "untracked.txt"), "changed source after snapshot\n");
    assert.deepEqual(await manager.prepare({ identity: "attempt-one", sources: configuration }), first);
    const second = (await manager.prepare({ identity: "attempt-two", sources: configuration }))[0]!;
    assert.notEqual(first[0]!.path, second.path);
    assert.equal(await readFile(join(second.path, "untracked.txt"), "utf8"), "changed source after snapshot\n");
    const { path: _privatePath, ...transferSource } = snapshot;
    const transferred = (await manager.prepare({ identity: "remote-attempt", transferred: [transferSource] }))[0]!;
    assert.equal(await readFile(join(transferred.path, "untracked.txt"), "utf8"), "untracked input\n");
    assert.equal((await lstat(join(transferred.path, "empty-parent", "child"))).mode & 0o777, 0o750);
    assert.deepEqual(await workingDirectoryEmptyDirectories(transferred.path), snapshot.sourceArtifact.metadata?.emptyDirectories);
    const folder = join(root, "folder"); await mkdir(folder); await writeFile(join(folder, "notes.txt"), "folder input\n");
    const plain = (await manager.prepare({ identity: "folder-attempt", sources: [{ id: "notes", name: "notes", path: folder }] }))[0]!;
    assert.equal(plain.kind, "folder"); assert.equal(plain.sourceCommit, undefined);
    assert.equal(await readFile(join(plain.path, "notes.txt"), "utf8"), "folder input\n");

    const exported = join(owned, "exported"); await mkdir(exported);
    await writeFile(join(exported, "tracked.txt"), "agent output\n");
    await writeFile(join(exported, "result.txt"), "new output\n");
    await mkdir(join(exported, "empty-output", "child"), { recursive: true }); await chmod(join(exported, "empty-output", "child"), 0o750);
    await symlink(source, join(exported, "blocked-link"));
    await mkdir(join(exported, ".git")); await mkdir(join(exported, ".git", "hooks"));
    await writeFile(join(exported, ".git", "config"), "invalid untrusted config\n");
    await writeFile(join(exported, ".git", "hooks", "pre-commit"), "untrusted\n");
    const capture = await manager.captureFromPath(snapshot, exported);
    assert.equal(await readFile(join(exported, ".git", "config"), "utf8"), "invalid untrusted config\n");
    assert.equal(await readFile(join(exported, "tracked.txt"), "utf8"), "agent output\n");
    const imported = join(owned, "checks", "exact-extra"); await manager.importCapture(capture, imported);
    await manager.importCapture(capture, imported);
    assert.equal(await git(imported, "rev-parse", "HEAD"), capture.commit);
    await git(imported, "merge-base", "--is-ancestor", snapshot.baseCommit, capture.commit);
    assert.equal(await readFile(join(imported, "result.txt"), "utf8"), "new output\n");
    assert.equal((await lstat(join(imported, "empty-output", "child"))).mode & 0o777, 0o750);
    assert.deepEqual(await workingDirectoryEmptyDirectories(imported), capture.bundleArtifact.metadata?.emptyDirectories);
    await rm(join(imported, "empty-output", "child"), { recursive: true });
    await assert.rejects(manager.importCapture(capture, imported), /inventory changed/);
    await mkdir(join(imported, "empty-output", "child"), { mode: 0o750 }); await chmod(join(imported, "empty-output", "child"), 0o750);
    await manager.importCapture(capture, imported);
    await mkdir(join(imported, "new-empty"));
    await assert.rejects(manager.importCapture(capture, imported), /inventory changed/);
    await rm(join(imported, "new-empty"), { recursive: true });
    const unsafeInventory = [{ path: "../escape", mode: 0o750 }];
    const unsafeCapture = { ...capture, bundleArtifact: { ...capture.bundleArtifact, metadata: { ...capture.bundleArtifact.metadata, emptyDirectories: unsafeInventory, emptyDirectoriesSha256: createHash("sha256").update(JSON.stringify(unsafeInventory)).digest("hex") } } };
    await assert.rejects(manager.importCapture(unsafeCapture, join(owned, "unsafe")), /inventory path/);
    const linkedInventory = [{ path: "blocked-link/child", mode: 0o750 }];
    const linkedCapture = { ...capture, bundleArtifact: { ...capture.bundleArtifact, metadata: { ...capture.bundleArtifact.metadata, emptyDirectories: linkedInventory, emptyDirectoriesSha256: createHash("sha256").update(JSON.stringify(linkedInventory)).digest("hex") } } };
    await assert.rejects(manager.importCapture(linkedCapture, join(owned, "linked")), /symlink/);
    assert.match((await artifacts.read(capture.diffArtifact)).toString(), /agent output/);
    await assert.rejects(manager.importCapture({ ...capture, commit: originalHead }, join(owned, "forged")), /metadata/);
    await assert.rejects(manager.captureFromPath(snapshot, source), /app-owned/);
    assert.equal(await git(source, "rev-parse", "HEAD"), originalHead);
    assert.equal(await git(source, "show-ref"), originalRefs);
    assert.equal(await git(source, "status", "--porcelain=v1", "--untracked-files=all"), originalStatus);
    assert.equal(await readFile(join(source, "tracked.txt"), "utf8"), "local edit\n");
    assert.equal(await readFile(join(source, "ignored.txt"), "utf8"), "ignored input\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("extra-root capture separates generated Swift caches from source without dropping tracked or arbitrary build inputs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-working-swift-cache-")));
  try {
    const source = join(root, "source"), owned = join(root, "owned"), exported = join(owned, "exported");
    await mkdir(source); await mkdir(owned);
    await git(source, "init", "--quiet");
    await git(source, "config", "user.name", "Fixture"); await git(source, "config", "user.email", "fixture@example.test");
    await writeFile(join(source, ".gitignore"), "*.txt\n");
    for (const name of ["Generated", "Tracked", "Linked"]) {
      await mkdir(join(source, "Packages", name), { recursive: true });
      await writeFile(join(source, "Packages", name, "Package.swift"), "// swift-tools-version: 6.0\n");
    }
    await mkdir(join(source, "Packages", "Tracked", ".build"));
    await writeFile(join(source, "Packages", "Tracked", ".build", "input.swift"), "let authoredInput = true\n");
    await git(source, "add", "."); await git(source, "commit", "-m", "Swift source and tracked build input");
    const artifacts = new ArtifactStore(join(owned, "artifacts"), "fixture-device");
    const manager = new WorkingDirectoryManager({ dataDir: owned, artifacts });
    const snapshot = (await manager.prepare({ identity: "swift-attempt", sources: [{ id: "swift", name: "swift", path: source }] }))[0]!;
    await cp(snapshot.path, exported, { recursive: true });
    await writeFile(join(exported, ".git", "config"), "untrusted exported metadata\n");
    await mkdir(join(exported, "Packages", "New"), { recursive: true });
    await writeFile(join(exported, "Packages", "New", "Package.swift"), "// swift-tools-version: 6.0\n");
    await writeFile(join(exported, "cache-input.bin"), "authored symlink target\n");
    for (const name of ["Generated", "Tracked", "New", "Linked"]) {
      const cache = join(exported, "Packages", name, ".build");
      await mkdir(join(cache, "aarch64-unknown-linux-gnu", "debug"), { recursive: true });
      if (name === "Linked") await symlink("../../../cache-input.bin", join(cache, "build.db"));
      else await writeFile(join(cache, "build.db"), `${name} generated cache\n`);
      await writeFile(join(cache, "aarch64-unknown-linux-gnu", "debug", "description.json"), "{}\n");
      await writeFile(join(cache, "aarch64-unknown-linux-gnu", "debug", "output.o"), "generated object\n");
    }
    await writeFile(join(exported, "analysis.txt"), "authored ignored output\n");
    await writeFile(join(exported, "Added.swift"), "let addedSource = true\n");
    await mkdir(join(exported, "notes", ".build"), { recursive: true });
    await writeFile(join(exported, "notes", ".build", "design.txt"), "authored arbitrary build directory\n");
    const capture = await manager.captureFromPath(snapshot, exported);
    const imported = join(owned, "checks", "swift");
    await manager.importCapture(capture, imported);
    const tracked = (await git(imported, "ls-files", "-z")).split("\0").filter(Boolean);
    for (const name of ["Generated", "New"]) {
      assert.equal(tracked.some((path) => path.startsWith(`Packages/${name}/.build/`)), false);
      assert.ok(tracked.includes(`Packages/${name}/Package.swift`));
      assert.equal(await readFile(join(exported, "Packages", name, ".build", "build.db"), "utf8"), `${name} generated cache\n`);
    }
    assert.ok(tracked.includes("Packages/Tracked/.build/input.swift"));
    assert.ok(tracked.includes("Packages/Tracked/.build/build.db"));
    assert.ok(tracked.includes("Packages/Linked/.build/build.db"));
    assert.equal((await lstat(join(imported, "Packages", "Linked", ".build", "build.db"))).isSymbolicLink(), true);
    assert.equal(await readFile(join(imported, "analysis.txt"), "utf8"), "authored ignored output\n");
    assert.equal(await readFile(join(imported, "Added.swift"), "utf8"), "let addedSource = true\n");
    assert.equal(await readFile(join(imported, "notes", ".build", "design.txt"), "utf8"), "authored arbitrary build directory\n");
    assert.equal(await readFile(join(exported, ".git", "config"), "utf8"), "untrusted exported metadata\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
