import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArtifactFsWorkspaceProvider, ARTIFACTFS_IMAGE } from "../../packages/workspaces/src/artifactfs.ts";
import { managedDockerInvocation, resolveDockerRuntime } from "../../packages/workspaces/src/docker.ts";
import type { WorkspaceRecord } from "../../packages/workspaces/src/types.ts";

// Opt-in real filesystem journey: EnoughFactory's private Linux engine and the
// pinned image are required. Never discover or use a contributor's daemon.
const dockerRuntime = resolveDockerRuntime();
const docker = (...args: string[]) => {
  const invocation = managedDockerInvocation(dockerRuntime, args);
  return execFileSync(invocation.command, invocation.args, { encoding: "utf8", env: invocation.env });
};
const workspaceRoot = process.env.ENOUGHFACTORY_WORKSPACE_ROOT;
if (!workspaceRoot) throw new Error("ENOUGHFACTORY_WORKSPACE_ROOT must name EnoughFactory's managed workspace directory");
await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(join(workspaceRoot, "artifactfs-proof-"));
const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
git("init", "--initial-branch=main");
git("config", "user.name", "EnoughFactory proof");
git("config", "user.email", "proof@example.com");
await writeFile(join(directory, "source.txt"), "before\n");
git("add", "."); git("commit", "-m", "Exact source");
const record: WorkspaceRecord = {
  id: randomUUID(), goalId: "proof", taskId: "proof", attemptId: randomUUID(), deviceId: "local",
  projectPath: directory, path: directory, provider: "artifactfs", baseCommit: git("rev-parse", "HEAD"),
  branch: "envmux/factory-proof", createdAt: new Date().toISOString(),
};
const provider = new ArtifactFsWorkspaceProvider({ rootDirectory: join(directory, "records"), buildImage: false, dockerRuntime });
try {
  const mount = await provider.prepare(record);
  record.providerState = mount;
  const agent = (script: string) => docker("run", "--rm", "--user", "1001",
    "--mount", `type=bind,src=${mount.bindSource},dst=/workspace,bind-propagation=rslave`,
    "--mount", `type=bind,src=${mount.bindSource},dst=/mount/repo,bind-propagation=rslave`,
    "--mount", `type=volume,src=${mount.stateVolume},dst=/var/lib/artifact-fs`,
    "--entrypoint", "sh", ARTIFACTFS_IMAGE, "-ec", script);
  assert.equal(agent("git -c safe.directory='*' -C /workspace rev-parse HEAD").trim(), record.baseCommit);
  agent("printf 'after\\n' >/workspace/source.txt; printf 'added\\n' >/workspace/new.txt; git -c safe.directory='*' -C /workspace add --all; git -c safe.directory='*' -C /workspace -c user.name=Proof -c user.email=proof@example.com commit -m 'Agent writes real FUSE workspace'");
  const candidate = await provider.capture(record);
  git("fetch", candidate.bundlePath, candidate.reference);
  assert.equal(git("show", `${candidate.commit}:source.txt`), "after");
  assert.equal(git("show", `${candidate.commit}:new.txt`), "added");
  agent("printf 'dirty retained\\n' >/workspace/uncommitted.txt");
  await provider.dispose(record);
  const retained = await provider.readMountRecord(record.attemptId);
  assert.ok(retained);
  await provider.recover(retained);
  assert.equal(agent("git -c safe.directory='*' -C /workspace rev-parse HEAD").trim(), candidate.commit);
  assert.equal(agent("cat /workspace/uncommitted.txt").trim(), "dirty retained");
  const recovered = await provider.capture(record);
  git("fetch", recovered.bundlePath, recovered.reference);
  assert.equal(git("show", `${recovered.commit}:uncommitted.txt`), "dirty retained");
  await writeFile(join(directory, "source.txt"), "parallel change\n");
  git("add", "source.txt"); git("commit", "-m", "New integration base");
  const repairRecord: WorkspaceRecord = { ...record, id: randomUUID(), attemptId: randomUUID(),
    baseCommit: git("rev-parse", "HEAD"), branch: "envmux/repair-proof", providerState: undefined };
  try {
    repairRecord.providerState = await provider.prepare(repairRecord);
    const repair = await provider.promotePreviousCandidate(repairRecord, recovered, recovered.bundlePath);
    assert.deepEqual(repair.conflicts, ["source.txt"]);
    const retainedRepair = await provider.capture(repairRecord);
    git("fetch", retainedRepair.bundlePath, retainedRepair.reference);
    assert.match(git("show", `${retainedRepair.commit}:source.txt`), /<<<<<<< HEAD/);
    assert.equal(git("show", `${retainedRepair.commit}:uncommitted.txt`), "dirty retained");
  } finally {
    if (await provider.readMountRecord(repairRecord.attemptId)) await provider.remove(repairRecord.attemptId);
  }
  console.log("ArtifactFS journey passed: exact input, agent writes, immutable candidate, committed/dirty recovery and explicit repair conflicts.");
} finally {
  try { if (await provider.readMountRecord(record.attemptId)) await provider.remove(record.attemptId); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
