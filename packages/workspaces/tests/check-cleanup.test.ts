import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkspaceManager } from "../src/manager.ts";
import { WorkingDirectoryManager } from "../src/working-directories.ts";
import { git, run } from "../src/process.ts";
import type { CheckCompatibilityEvidence, CheckExecutor, CommandResult } from "../src/types.ts";

const compatibility: CheckCompatibilityEvidence = {
  id: "swift-foundation-provenance-v1", helperSha256: "1".repeat(64), sourceSha256: "2".repeat(64), compiledSha256: "3".repeat(64),
  scope: "check-command-and-descendants; suppress-only-EOPNOTSUPP/ENOTSUP-for-com.apple.provenance-on-real-directories",
};

function commandResult(command: string, extra: Partial<CommandResult> = {}): CommandResult {
  return { command, exitCode: 0, stdout: "original compiler stdout", stderr: "original compiler stderr", runtimeCompatibility: compatibility, startedAt: "2026-10-07T00:00:00.000Z", endedAt: "2026-10-07T00:00:01.000Z", ...extra };
}

async function fixture(executor: CheckExecutor, secondary = false) {
  const root = await mkdtemp(join(tmpdir(), "enough-check-cleanup-"));
  const project = join(root, "project"), dataDir = join(root, "data");
  await mkdir(project);
  assert.equal((await run("git", ["init", "-b", "main", project])).exitCode, 0);
  await git(project, "config", "user.name", "Cleanup Test");
  await git(project, "config", "user.email", "cleanup@example.com");
  await writeFile(join(project, "source.txt"), "saved source\n");
  await git(project, "add", ".");
  await git(project, "commit", "-m", "Saved source");
  const manager = new WorkspaceManager({ dataDir, deviceId: "cleanup-test", checkExecutor: executor });
  const workspace = await manager.create({ projectPath: project, goalId: "goal", taskId: "task", attemptId: "attempt" });
  await writeFile(join(workspace.path, "candidate.txt"), "retained candidate\n");
  await git(workspace.path, "add", ".");
  await git(workspace.path, "commit", "-m", "Candidate source");
  const captures = [];
  if (secondary) {
    const source = join(root, "secondary");
    await mkdir(join(source, "saved-empty"), { recursive: true });
    await writeFile(join(source, "reference.txt"), "saved reference\n");
    const directories = new WorkingDirectoryManager({ dataDir, artifacts: manager.artifacts });
    const [snapshot] = await directories.prepare({ identity: "secondary", sources: [{ id: "reference", name: "reference", path: source }] });
    captures.push(await directories.captureFromPath(snapshot!, snapshot!.path));
  }
  const candidate = await manager.capture({ workspaceId: workspace.id, workingDirectories: captures });
  return { root, project, dataDir, manager, candidate };
}

test("command cleanup errors stop subsequent checks and preserve the completed command evidence", async () => {
  const seen: string[] = [];
  let checkPath = "", releases = 0;
  const expected = commandResult("first", { cleanupErrors: ["exact check container termination was not confirmed"] });
  const executor: CheckExecutor = async context => {
    seen.push(context.command); checkPath = context.path;
    return expected;
  };
  executor.release = async () => { releases++; };
  const f = await fixture(executor);
  try {
    const report = await f.manager.verify({ candidateId: f.candidate.id, commands: ["first", "must not run"] });
    assert.equal(report.status, "failed");
    assert.deepEqual(seen, ["first"]);
    assert.deepEqual(report.commands, [expected]);
    assert.deepEqual(report.cleanupErrors, expected.cleanupErrors);
    assert.equal(releases, 1);
    assert.equal(await readFile(join(checkPath, "candidate.txt"), "utf8"), "retained candidate\n");
    const evidence = JSON.parse((await f.manager.artifacts.read(report.logArtifact)).toString());
    assert.deepEqual(evidence.commands, [expected]);
    assert.deepEqual(evidence.cleanupErrors, expected.cleanupErrors);
    assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, "reports", `${report.id}.json`), "utf8")), JSON.parse(JSON.stringify(report)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unconfirmed release retains both snapshots and returns durable original failure evidence without auditing active mounts", async () => {
  let checkPath = "", secondaryPath = "", releases = 0;
  const expected = commandResult("swift test", { exitCode: 17, timedOut: true });
  const executor: CheckExecutor = async context => {
    checkPath = context.path; secondaryPath = context.workingDirectories![0]!.path;
    // An audit would now throw. Release failure must preserve the completed result instead.
    await rm(join(checkPath, ".git", "HEAD"));
    return expected;
  };
  executor.release = async () => { releases++; throw new Error("exact container is still unconfirmed"); };
  const f = await fixture(executor, true);
  try {
    const report = await f.manager.verify({ candidateId: f.candidate.id, commands: ["swift test", "must not run"] });
    assert.equal(report.status, "failed");
    assert.deepEqual(report.commands, [expected]);
    assert.equal(releases, 1);
    assert.match(report.cleanupErrors![0]!, /exact container is still unconfirmed/);
    assert.equal(await readFile(join(checkPath, "candidate.txt"), "utf8"), "retained candidate\n");
    assert.equal(await readFile(join(secondaryPath, "reference.txt"), "utf8"), "saved reference\n");
    const evidence = JSON.parse((await f.manager.artifacts.read(report.logArtifact)).toString());
    assert.deepEqual(evidence.commands, [expected]);
    assert.match(evidence.sourceAuditSkipped, /release was not confirmed/);
    assert.equal(evidence.actualHead, undefined);
    assert.equal(evidence.workingDirectories, undefined);
    assert.equal(evidence.retainedCheckPath, checkPath);
    assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, "reports", `${report.id}.json`), "utf8")), JSON.parse(JSON.stringify(report)));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("report release removes stable mountpoints before secondary source and empty-directory audits", async () => {
  const events: string[] = [];
  let checkPath = "", secondaryPath = "", mountpoint = "", inode: number | undefined;
  const executor: CheckExecutor = async context => {
    events.push(context.command); checkPath = context.path; secondaryPath = context.workingDirectories![0]!.path;
    mountpoint = join(secondaryPath, ".build");
    await mkdir(mountpoint, { recursive: true });
    const current = (await stat(mountpoint)).ino;
    if (inode !== undefined) assert.equal(current, inode);
    inode = current;
    return commandResult(context.command);
  };
  executor.release = async () => { events.push("release"); await rmdir(mountpoint); };
  const f = await fixture(executor, true);
  try {
    const report = await f.manager.verify({ candidateId: f.candidate.id, commands: ["first", "second"] });
    assert.equal(report.status, "passed");
    assert.deepEqual(events, ["first", "second", "release"]);
    const evidence = JSON.parse((await f.manager.artifacts.read(report.logArtifact)).toString());
    assert.equal(evidence.workingDirectories[0].emptyDirectoriesMatch, true);
    assert.deepEqual(evidence.workingDirectories[0].emptyDirectories, evidence.workingDirectories[0].expectedEmptyDirectories);
    await assert.rejects(stat(checkPath), /ENOENT/);
    await assert.rejects(stat(secondaryPath), /ENOENT/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("integration retains its failed report and cannot accept a commit when runtime release is unconfirmed", async () => {
  let checkPath = "", releases = 0;
  const expected = commandResult("check");
  const executor: CheckExecutor = async context => { checkPath = context.path; return expected; };
  executor.release = async () => { releases++; throw new Error("cannot confirm exact integration container exit"); };
  const f = await fixture(executor);
  try {
    const before = await git(f.project, "rev-parse", "HEAD");
    const result = await f.manager.integrate({ candidateId: f.candidate.id, projectPath: f.project, commands: ["check"], isCurrent: () => true });
    assert.equal(result.status, "checks-failed");
    assert.equal(result.report!.status, "failed");
    assert.deepEqual(result.report!.commands, [expected]);
    assert.equal(releases, 1);
    assert.equal(await git(f.project, "rev-parse", "HEAD"), before);
    await assert.rejects(readFile(join(f.project, "candidate.txt")), /ENOENT/);
    assert.equal(await readFile(join(checkPath, "candidate.txt"), "utf8"), "retained candidate\n");
    const evidence = JSON.parse((await f.manager.artifacts.read(result.report!.logArtifact)).toString());
    assert.deepEqual(evidence.commands, [expected]);
    assert.match(evidence.cleanupErrors[0], /integration container exit/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("healthy integration releases once, preserves command evidence and accepts imported merged objects", async () => {
  let checkPath = "", releases = 0;
  const expected = commandResult("check");
  const executor: CheckExecutor = async context => { checkPath = context.path; return expected; };
  executor.release = async () => { releases++; };
  const f = await fixture(executor);
  try {
    const result = await f.manager.integrate({ candidateId: f.candidate.id, projectPath: f.project, commands: ["check"], isCurrent: () => true });
    assert.equal(result.status, "integrated");
    assert.equal(result.report!.status, "passed");
    assert.deepEqual(result.report!.commands, [expected]);
    assert.equal(releases, 1);
    assert.equal(await git(f.project, "rev-parse", "HEAD"), result.commit);
    assert.equal(await readFile(join(f.project, "candidate.txt"), "utf8"), "retained candidate\n");
    await assert.rejects(stat(checkPath), /ENOENT/);
    const evidence = JSON.parse((await f.manager.artifacts.read(result.report!.logArtifact)).toString());
    assert.deepEqual(evidence.commands, [expected]);
    assert.equal(evidence.actualHead, result.commit);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("snapshot cleanup failures update durable evidence before integration acceptance", { skip: process.getuid?.() === 0 }, async () => {
  let parent = "";
  const expected = commandResult("check");
  const executor: CheckExecutor = async context => {
    parent = dirname(context.path);
    await chmod(parent, 0o500);
    return expected;
  };
  const f = await fixture(executor);
  try {
    const before = await git(f.project, "rev-parse", "HEAD");
    const result = await f.manager.integrate({ candidateId: f.candidate.id, projectPath: f.project, commands: ["check"], isCurrent: () => true });
    assert.equal(result.status, "checks-failed");
    assert.equal(result.report!.status, "failed");
    assert.deepEqual(result.report!.commands, [expected]);
    assert.match(result.report!.cleanupErrors![0]!, /Could not remove check snapshots/);
    assert.equal(await git(f.project, "rev-parse", "HEAD"), before);
    const evidence = JSON.parse((await f.manager.artifacts.read(result.report!.logArtifact)).toString());
    assert.equal(evidence.status, "failed");
    assert.deepEqual(evidence.cleanupErrors, result.report!.cleanupErrors);
    assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, "reports", `${result.report!.id}.json`), "utf8")), JSON.parse(JSON.stringify(result.report)));
  } finally {
    if (parent) await chmod(parent, 0o700);
    await rm(f.root, { recursive: true, force: true });
  }
});
