import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/manager.ts";
import { git, run } from "../src/process.ts";

test("exact source commits retain one verified bundle across concurrent exports and source repacks", async () => {
  const root = await mkdtemp(join(tmpdir(), "enough-source-export-"));
  const project = join(root, "project"), dataDir = join(root, "data");
  try {
    await mkdir(project);
    assert.equal((await run("git", ["init", "-b", "main", project])).exitCode, 0);
    await git(project, "config", "user.name", "Source Test");
    await git(project, "config", "user.email", "source@example.com");
    await writeFile(join(project, "source.txt"), "base\n".repeat(1_000));
    await git(project, "add", "source.txt"); await git(project, "commit", "-m", "Base");
    const base = await git(project, "rev-parse", "HEAD");
    await writeFile(join(project, "source.txt"), "first\n" + "base\n".repeat(1_000));
    await git(project, "commit", "-am", "First");
    const firstCommit = await git(project, "rev-parse", "HEAD");
    await writeFile(join(project, "source.txt"), "second\n" + "base\n".repeat(1_000));
    await git(project, "commit", "-am", "Second");
    const secondCommit = await git(project, "rev-parse", "HEAD");
    // A project ref with the same spelling belongs to the user and must remain untouched.
    await git(project, "update-ref", `refs/enoughfactory/source/${firstCommit}`, secondCommit);
    const originalRefs = await git(project, "show-ref");
    const firstManager = new WorkspaceManager({ dataDir, deviceId: "device-a" });
    const secondManager = new WorkspaceManager({ dataDir, deviceId: "device-a" });
    const [first, duplicateFirst, second, duplicateSecond] = await Promise.all([
      firstManager.exportSource({ projectPath: project, reference: firstCommit }),
      secondManager.exportSource({ projectPath: project, reference: firstCommit }),
      firstManager.exportSource({ projectPath: project, reference: secondCommit }),
      secondManager.exportSource({ projectPath: project, reference: secondCommit }),
    ]);
    assert.deepEqual(first, duplicateFirst); assert.deepEqual(second, duplicateSecond);
    assert.notEqual(first.sha256, second.sha256);
    await git(project, "config", "pack.compression", "0");
    await git(project, "repack", "-adf", "--window=0");
    const recovered = new WorkspaceManager({ dataDir, deviceId: "device-a" });
    assert.deepEqual(await recovered.exportSource({ projectPath: project, reference: firstCommit }), first);
    assert.deepEqual(await recovered.exportSource({ projectPath: project }), second);
    assert.equal(await git(project, "show-ref"), originalRefs);
    const objectDirectories = await readdir(join(dataDir, "artifacts", "objects"));
    const objects = (await Promise.all(objectDirectories.map(directory => readdir(join(dataDir, "artifacts", "objects", directory))))).flat();
    assert.equal(objects.length, 2, "unchanged commits must share their existing CAS object");
    assert.deepEqual((await readdir(join(dataDir, "source"))).sort(), [`sha1-${firstCommit}.json`, `sha1-${secondCommit}.json`].sort());
    const receiver = new WorkspaceManager({ dataDir: join(root, "receiver"), deviceId: "device-b" });
    for (const [artifact, expectedCommit, count] of [[first, firstCommit, "2"], [second, secondCommit, "3"]] as const) {
      await receiver.artifacts.importFile(await firstManager.artifacts.path(artifact), artifact);
      const targetPath = join(root, `import-${expectedCommit}`);
      assert.equal(await receiver.importSource({ artifact, targetPath }), expectedCommit);
      assert.equal(await git(targetPath, "rev-parse", "HEAD"), expectedCommit);
      assert.equal(await git(targetPath, "rev-list", "--count", "HEAD"), count);
      assert.equal(await git(targetPath, "merge-base", base, "HEAD"), base);
    }
    const artifactPath = await firstManager.artifacts.path(first);
    await writeFile(artifactPath, "corrupt source bundle");
    await assert.rejects(recovered.exportSource({ projectPath: project, reference: firstCommit }), /failed integrity verification/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SHA256 source exports import their exact format and infer legacy manifests without changing advertised refs", async context => {
  const root = await mkdtemp(join(tmpdir(), "enough-sha256-source-"));
  const project = join(root, "project");
  try {
    const initialized = await run("git", ["init", "--quiet", "-b", "main", "--object-format=sha256", project]);
    if (initialized.exitCode !== 0 && /unknown hash algorithm|unknown option.*object-format|not supported|unsupported/i.test(initialized.stderr)) {
      context.skip("This Git installation does not support SHA256 repositories"); return;
    }
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    await git(project, "config", "user.name", "Source Test");
    await git(project, "config", "user.email", "source@example.com");
    await writeFile(join(project, "source.txt"), "SHA256 source\n");
    await git(project, "add", "source.txt"); await git(project, "commit", "-m", "SHA256 source");
    const commit = await git(project, "rev-parse", "HEAD");
    assert.equal(commit.length, 64);
    const manager = new WorkspaceManager({ dataDir: join(root, "data"), deviceId: "device-a" });
    const artifact = await manager.exportSource({ projectPath: project });
    assert.equal(artifact.metadata?.objectFormat, "sha256");
    const targetPath = join(root, "import");
    assert.equal(await manager.importSource({ artifact, targetPath }), commit);
    assert.equal(await git(targetPath, "rev-parse", "--show-object-format"), "sha256");
    assert.equal(await git(targetPath, "rev-parse", "HEAD"), commit);
    const ref = "refs/enoughfactory/source/legacy-uuid-ref";
    await git(project, "update-ref", ref, commit);
    const bundle = join(root, "legacy.bundle");
    await git(project, "bundle", "create", bundle, ref);
    const legacy = await manager.artifacts.putFile(bundle, { name: "legacy.bundle", mime: "application/x-git-bundle", metadata: { commit, ref } });
    const legacyPath = join(root, "legacy-import");
    assert.equal(await manager.importSource({ artifact: legacy, targetPath: legacyPath }), commit);
    assert.equal(await git(legacyPath, "rev-parse", "--show-object-format"), "sha256");
    assert.equal(await git(legacyPath, "rev-parse", "HEAD"), commit);
    await assert.rejects(manager.importSource({ artifact: { ...artifact, metadata: { ...artifact.metadata, objectFormat: "sha1" } }, targetPath: join(root, "invalid") }), /object format does not match/);
    await assert.rejects(manager.importSource({ artifact: { ...artifact, metadata: { ...artifact.metadata, objectFormat: "unknown" } }, targetPath: join(root, "unknown") }), /object format does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
