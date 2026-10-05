import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager, ArtifactStore, dockerCheckExecutor } from "../src/index.ts";
import { git, run } from "../src/process.ts";
import type { CheckExecutor } from "../src/types.ts";

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
