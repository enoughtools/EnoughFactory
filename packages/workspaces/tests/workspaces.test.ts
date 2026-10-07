import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SWIFT_TOOLCHAIN } from "@enoughfactory/runtime";
import { WorkspaceManager, WorkingDirectoryManager, ArtifactStore, dockerCheckExecutor } from "../src/index.ts";
import { git, run } from "../src/process.ts";
import type { CheckExecutor, DevelopmentToolchain } from "../src/types.ts";

const executor: CheckExecutor = async (context) => {
  const startedAt = new Date().toISOString();
  const result = await run("sh", ["-c", context.command], { cwd: context.path, timeoutMs: context.timeoutMs });
  return { ...result, command: context.command, startedAt, endedAt: new Date().toISOString() };
};

async function fixture() {
  const root = await mkdtemp(join(process.env.ENOUGHFACTORY_WORKSPACE_ROOT ?? tmpdir(), "enough-workspaces-"));
  const project = join(root, "project");
  await mkdir(project);
  await run("git", ["init", "-b", "main", project]);
  await git(project, "config", "user.name", "Test User");
  await git(project, "config", "user.email", "test@example.com");
  await writeFile(join(project, "hello.txt"), "base\n");
  await git(project, "add", "hello.txt");
  await git(project, "commit", "-m", "Base");
  const manager = new WorkspaceManager({ dataDir: join(root, "data"), deviceId: "device-a", checkExecutor: executor });
  return { root, project, manager };
}

test("isolated attempts cross a bundle boundary, recheck their combined exact commit and preserve rejected authority", async () => {
  const { root, project, manager } = await fixture();
  try {
    const first = await manager.create({ projectPath: project, goalId: "goal", taskId: "task-a", attemptId: "attempt-a" });
    const second = await manager.create({ projectPath: project, goalId: "goal", taskId: "task-b", attemptId: "attempt-b" });
    await writeFile(join(first.path, "a.txt"), "first\n");
    await git(first.path, "add", "a.txt"); await git(first.path, "commit", "-m", "First attempt");
    const candidateA = await manager.capture({ workspaceId: first.id });
    await writeFile(join(second.path, "b.txt"), "second\n");
    await git(second.path, "add", "b.txt"); await git(second.path, "commit", "-m", "Second attempt");
    const candidateB = await manager.capture({ workspaceId: second.id });
    assert.equal(await readFile(join(project, "hello.txt"), "utf8"), "base\n");
    await assert.rejects(readFile(join(project, "a.txt")), /ENOENT/);
    const checked = await manager.verify({ candidateId: candidateA.id, commands: ["test -f a.txt && test ! -f b.txt"] });
    assert.equal(checked.status, "passed"); assert.equal(checked.commit, candidateA.commit);
    const accepted = await manager.integrate({ candidateId: candidateA.id, projectPath: project, commands: ["test -f a.txt"], isCurrent: () => true });
    assert.equal(accepted.status, "integrated");
    assert.equal(await readFile(join(project, "a.txt"), "utf8"), "first\n");
    const acceptedB = await manager.integrate({ candidateId: candidateB.id, projectPath: project, commands: ["test -f a.txt && test -f b.txt"], isCurrent: () => true });
    assert.equal(acceptedB.status, "integrated");
    assert.notEqual(acceptedB.report?.commit, candidateB.commit);
    assert.equal(acceptedB.report?.baseCommit, accepted.commit);
    const recoveredManager = new WorkspaceManager({ dataDir: join(root, "data"), deviceId: "device-a", checkExecutor: executor });
    const recovered = await recoveredManager.reconcileIntegration({ candidateId: candidateB.id, projectPath: project });
    assert.equal(recovered?.status, "integrated"); assert.equal(recovered?.commit, acceptedB.commit);
    let authority = true;
    const revokedManager = new WorkspaceManager({ dataDir: join(root, "data"), deviceId: "device-a", checkExecutor: async context => { authority = false; return executor(context); } });
    const headBefore = await git(project, "rev-parse", "HEAD");
    const revoked = await revokedManager.integrate({ candidateId: candidateB.id, projectPath: project, commands: ["true"], isCurrent: () => authority });
    assert.equal(revoked.status, "stale"); assert.equal(await git(project, "rev-parse", "HEAD"), headBefore);
    const cancellation = new AbortController(); let authorityReads = 0;
    const canceled = await manager.integrate({ candidateId: candidateB.id, projectPath: project, commands: ["true"], signal: cancellation.signal, isCurrent: () => { if (++authorityReads === 3) cancellation.abort(); return true; } });
    assert.equal(canceled.status, "stale");
    await git(project, "checkout", "-b", "operator");
    await writeFile(join(project, "operator.txt"), "operator branch\n"); await git(project, "add", "operator.txt"); await git(project, "commit", "-m", "Operator branch");
    await git(project, "checkout", "main");
    const switchingManager = new WorkspaceManager({ dataDir: join(root, "data"), deviceId: "device-a", checkExecutor: async context => { await git(project, "checkout", "operator"); return executor(context); } });
    const switched = await switchingManager.integrate({ candidateId: candidateB.id, projectPath: project, commands: ["true"], isCurrent: () => true });
    assert.equal(switched.status, "target-moved"); assert.equal(await git(project, "branch", "--show-current"), "operator");
    assert.equal(await git(project, "status", "--porcelain"), ""); assert.equal(await readFile(join(project, "operator.txt"), "utf8"), "operator branch\n");
    const receiver = new WorkspaceManager({ dataDir: join(root, "receiver"), deviceId: "device-b", checkExecutor: executor });
    await receiver.acceptCandidate(candidateA, await manager.artifacts.path(candidateA.bundleArtifact));
    assert.equal((await receiver.verify({ candidateId: candidateA.id, commands: ["test -f a.txt"] })).status, "passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("conflicting candidates retain immutable evidence and corrupt peer artifacts are refused", async () => {
  const { root, project, manager } = await fixture();
  try {
    const workspace = await manager.create({ projectPath: project, goalId: "goal", taskId: "task", attemptId: "attempt" });
    await writeFile(join(workspace.path, "hello.txt"), "candidate\n");
    await git(workspace.path, "commit", "-am", "Candidate");
    const candidate = await manager.capture({ workspaceId: workspace.id });
    await writeFile(join(project, "hello.txt"), "operator\n");
    await git(project, "commit", "-am", "Operator");
    const result = await manager.integrate({ candidateId: candidate.id, projectPath: project, commands: [], isCurrent: () => true });
    assert.equal(result.status, "conflict"); assert.deepEqual(result.conflicts, ["hello.txt"]);
    assert.equal(await readFile(join(project, "hello.txt"), "utf8"), "operator\n");
    assert.equal((await manager.candidate(candidate.id)).commit, candidate.commit);
    const repair = await manager.create({ projectPath: project, goalId: "goal", taskId: "task", attemptId: "repair-attempt" });
    const repairInput = await manager.promotePreviousCandidate({ candidateId: candidate.id, workspaceId: repair.id });
    assert.deepEqual(repairInput.conflicts, ["hello.txt"]);
    const unresolved = await manager.capture({ workspaceId: repair.id });
    assert.equal((await manager.verify({ candidateId: unresolved.id, commands: [] })).status, "failed");
    await writeFile(join(repair.path, "hello.txt"), "resolved\n");
    await git(repair.path, "commit", "-am", "Resolve retained work");
    const resolved = await manager.capture({ workspaceId: repair.id });
    assert.equal((await manager.verify({ candidateId: resolved.id, commands: ["test \"$(cat hello.txt)\" = resolved"] })).status, "passed");
    const corrupt = join(root, "corrupt.bundle"); await writeFile(corrupt, "wrong bytes");
    const artifacts = new ArtifactStore(join(root, "receiver"), "device-b");
    await assert.rejects(artifacts.importFile(corrupt, candidate.bundleArtifact), /does not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("checks use retained secondary snapshots, reject their changed trees or heads and leave source folders untouched", async () => {
  const { root, project, manager } = await fixture();
  try {
    const source = join(root, "secondary-source");
    await mkdir(source);
    await writeFile(join(source, "reference.txt"), "original source\n");
    const directories = new WorkingDirectoryManager({ dataDir: join(root, "data"), artifacts: manager.artifacts });
    const [snapshot] = await directories.prepare({ identity: "secondary-attempt", sources: [{ id: "reference", name: "reference", path: source }] });
    const exported = join(root, "data", "secondary-export");
    await mkdir(exported);
    await writeFile(join(exported, "reference.txt"), "retained output\n");
    const capture = await directories.captureFromPath(snapshot!, exported);
    const workspace = await manager.create({ projectPath: project, goalId: "goal", taskId: "task", attemptId: "secondary-attempt" });
    const candidate = await manager.capture({ workspaceId: workspace.id, workingDirectories: [capture] });
    const contexts = new Map<string, string>();
    const check: CheckExecutor = async context => {
      const [secondary] = context.workingDirectories ?? [];
      assert.ok(secondary);
      assert.equal(secondary.containerPath, "/workspaces/reference");
      assert.equal(secondary.commit, capture.commit);
      assert.notEqual(secondary.path, source);
      assert.notEqual(secondary.path, snapshot!.path);
      assert.equal(await git(secondary.path, "rev-parse", "HEAD"), capture.commit);
      assert.equal(await readFile(join(secondary.path, "reference.txt"), "utf8"), "retained output\n");
      if (contexts.has(context.path)) assert.equal(secondary.path, contexts.get(context.path));
      contexts.set(context.path, secondary.path);
      if (context.command === "change-tree") await writeFile(join(secondary.path, "reference.txt"), "check mutation\n");
      if (context.command === "change-head") await git(secondary.path, "reset", "--hard", capture.baseCommit);
      if (context.command === "add-untracked") await writeFile(join(secondary.path, "unexpected.txt"), "unchecked input\n");
      return { command: context.command, exitCode: 0, stdout: "", stderr: "", startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
    };
    const receiver = new WorkspaceManager({ dataDir: join(root, "receiver"), deviceId: "device-b", checkExecutor: check });
    for (const artifact of [capture.bundleArtifact, capture.diffArtifact]) await receiver.artifacts.importFile(await manager.artifacts.path(artifact), artifact);
    await receiver.acceptCandidate(candidate, await manager.artifacts.path(candidate.bundleArtifact), await manager.artifacts.path(candidate.diffArtifact));
    assert.equal((await receiver.verify({ candidateId: candidate.id, commands: ["inspect", "inspect"] })).status, "passed");
    for (const command of ["change-tree", "change-head", "add-untracked"]) {
      const report = await receiver.verify({ candidateId: candidate.id, commands: [command] });
      assert.equal(report.status, "failed");
      const evidence = JSON.parse((await receiver.artifacts.read(report.logArtifact)).toString());
      assert.equal(evidence.workingDirectories[0].containerPath, "/workspaces/reference");
      assert.ok(evidence.workingDirectories[0].dirty || evidence.workingDirectories[0].actualHead !== capture.commit);
    }
    assert.equal((await receiver.integrate({ candidateId: candidate.id, projectPath: project, commands: ["inspect"], isCurrent: () => true })).status, "integrated");
    assert.equal(await readFile(join(source, "reference.txt"), "utf8"), "original source\n");
    assert.equal(await git(project, "status", "--porcelain"), "");
    for (const path of contexts.values()) await assert.rejects(readFile(join(path, "reference.txt")), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("candidate toolchains stay frozen across transfer and combined checks record their actual local image", async () => {
  const { root, project, manager } = await fixture();
  try {
    const author: DevelopmentToolchain = { id: SWIFT_TOOLCHAIN.id, recipeSha256: SWIFT_TOOLCHAIN.recipeSha256, image: `sha256:${"1".repeat(64)}`, baseImage: SWIFT_TOOLCHAIN.baseImage, platform: "linux/arm64", swiftVersion: SWIFT_TOOLCHAIN.swiftVersion, nodeVersion: SWIFT_TOOLCHAIN.nodeVersion };
    const selected = { ...author };
    const plain = await manager.create({ projectPath: project, goalId: "goal", taskId: "plain", attemptId: "plain-toolchain" });
    const swift = await manager.create({ projectPath: project, goalId: "goal", taskId: "swift", attemptId: "swift-toolchain", developmentToolchain: selected });
    selected.image = `sha256:${"2".repeat(64)}`;
    assert.deepEqual(swift.developmentToolchain, author);
    await assert.rejects(manager.create({ projectPath: project, goalId: "goal", taskId: "swift", attemptId: swift.id, developmentToolchain: selected }), /frozen development toolchain/);
    const plainCandidate = await manager.capture({ workspaceId: plain.id });
    const swiftCandidate = await manager.capture({ workspaceId: swift.id });
    assert.equal(plainCandidate.developmentToolchain, undefined);
    assert.deepEqual(swiftCandidate.developmentToolchain, author);
    assert.deepEqual(swiftCandidate.bundleArtifact.metadata?.developmentToolchain, author);
    const checker: DevelopmentToolchain = { ...author, platform: "linux/amd64", image: `sha256:${"3".repeat(64)}` };
    const seen: Array<DevelopmentToolchain | undefined> = [];
    const check: CheckExecutor = async context => {
      const frozen = context.candidate.developmentToolchain;
      seen.push(frozen ? { ...frozen } : undefined);
      return { command: context.command, exitCode: 0, stdout: "", stderr: "", developmentToolchain: frozen ? checker : undefined, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
    };
    const local = new WorkspaceManager({ dataDir: join(root, "data"), deviceId: "device-a", checkExecutor: check });
    assert.equal((await local.verify({ candidateId: plainCandidate.id, commands: ["plain check"] })).developmentToolchain, undefined);
    const receiver = new WorkspaceManager({ dataDir: join(root, "toolchain-receiver"), deviceId: "device-b", checkExecutor: check });
    await assert.rejects(receiver.acceptCandidate({ ...swiftCandidate, developmentToolchain: selected }, await manager.artifacts.path(swiftCandidate.bundleArtifact)), /immutable source evidence/);
    await receiver.acceptCandidate(swiftCandidate, await manager.artifacts.path(swiftCandidate.bundleArtifact), await manager.artifacts.path(swiftCandidate.diffArtifact));
    const verified = await receiver.verify({ candidateId: swiftCandidate.id, commands: ["node and swift check", "second check"] });
    assert.deepEqual(verified.candidateDevelopmentToolchain, author);
    assert.deepEqual(verified.developmentToolchain, checker);
    const integrated = await receiver.integrate({ candidateId: swiftCandidate.id, projectPath: project, commands: ["combined check"], isCurrent: () => true });
    assert.equal(integrated.status, "integrated");
    assert.deepEqual(integrated.report?.candidateDevelopmentToolchain, author);
    assert.deepEqual(integrated.report?.developmentToolchain, checker);
    const evidence = JSON.parse((await receiver.artifacts.read(integrated.report!.logArtifact)).toString());
    assert.deepEqual(evidence.candidateDevelopmentToolchain, author);
    assert.deepEqual(evidence.developmentToolchain, checker);
    assert.deepEqual(integrated.report!.logArtifact.metadata?.developmentToolchain, checker);
    assert.equal(seen[0], undefined);
    for (const frozen of seen.slice(1)) assert.deepEqual(frozen, author);
    await assert.rejects(manager.create({ projectPath: project, goalId: "goal", taskId: "invalid", attemptId: "invalid-toolchain", developmentToolchain: { ...author, image: "unrelated:latest" } }), /pinned recipe/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configured checks run with root access inside a real container against exact source", { skip: !process.env.ENOUGHFACTORY_CHECK_IMAGE }, async () => {
  const { root, project } = await fixture();
  try {
    const manager = new WorkspaceManager({ dataDir: join(root, "docker-data"), deviceId: "device-a", checkExecutor: dockerCheckExecutor({ image: process.env.ENOUGHFACTORY_CHECK_IMAGE }) });
    const workspace = await manager.create({ projectPath: project, goalId: "goal", taskId: "task", attemptId: "container-attempt" });
    const candidate = await manager.capture({ workspaceId: workspace.id });
    const escaped = join(root, "escaped-host-marker");
    const report = await manager.verify({ candidateId: candidate.id, commands: ["test \"$(id -u)\" = 0 && test -f /.dockerenv && test -f hello.txt && touch /tmp/enoughfactory-check", `printf '\\n[core]\\n\\tfsmonitor = "touch ${escaped};"\\n' >> .git/config`] });
    assert.equal(report.status, "passed"); assert.equal(report.commit, candidate.commit);
    await assert.rejects(readFile(escaped), /ENOENT/);
    assert.equal(await git(project, "status", "--porcelain"), "");
  } finally { await rm(root, { recursive: true, force: true }); }
});
