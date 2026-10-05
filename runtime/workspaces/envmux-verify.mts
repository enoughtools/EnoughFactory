import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EnvmuxEngine } from "../../packages/envmux/src/index.ts";
import { ArtifactFsWorkspaceProvider } from "../../packages/workspaces/src/artifactfs.ts";
import { WorkspaceManager } from "../../packages/workspaces/src/manager.ts";
import { dockerCheckExecutor } from "../../packages/workspaces/src/checks.ts";
import { managedDockerInvocation, resolveDockerRuntime } from "../../packages/workspaces/src/docker.ts";
import type { CheckExecutor } from "../../packages/workspaces/src/types.ts";

const dockerRuntime = resolveDockerRuntime();
const docker = (...args: string[]) => {
  const invocation = managedDockerInvocation(dockerRuntime, args);
  return execFileSync(invocation.command, invocation.args, { encoding: "utf8", env: invocation.env });
};
const workspaceRoot = process.env.ENOUGHFACTORY_WORKSPACE_ROOT;
if (!workspaceRoot) throw new Error("ENOUGHFACTORY_WORKSPACE_ROOT must name EnoughFactory's managed workspace directory");
await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
const fixture = await mkdtemp(join(workspaceRoot, "artifactfs-envmux-proof-"));
const directory = join(fixture, "project"); await mkdir(directory);
const git = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
git("init", "--initial-branch=main"); git("config", "user.name", "EnoughFactory proof"); git("config", "user.email", "proof@example.com");
await writeFile(join(directory, "README.md"), "Actual ArtifactFS / envmux source-retention journey\n");
await writeFile(join(directory, ".envmux.json"), JSON.stringify({
  name: "enoughfactory-artifactfs-proof", portal: { open: false }, tools: {},
  tasks: { proof: { command: "printf 'artifactfs-engine-ready\\n'", kind: "once" } },
}));
git("add", "."); git("commit", "-m", "ArtifactFS engine fixture");
const attemptId = randomUUID(); const sessionName = `afs-${attemptId.slice(0, 8)}`;
const provider = new ArtifactFsWorkspaceProvider({ rootDirectory: join(fixture, "data"), buildImage: false, dockerRuntime });
let actualChecks: CheckExecutor | undefined;
const checks: CheckExecutor = context => {
  if (!actualChecks) throw new Error("The real engine image is not available for checks");
  return actualChecks(context);
};
checks.release = path => actualChecks?.release?.(path) ?? Promise.resolve();
const manager = new WorkspaceManager({ dataDir: join(fixture, "data"), deviceId: "local", artifactFs: provider, checkExecutor: checks });
const engine = new EnvmuxEngine({ dockerRuntime });
let instance: string | undefined;
try {
  const record = await manager.create({ projectPath: directory, goalId: "proof", taskId: "proof", attemptId,
    provider: "artifactfs", fallbackToGit: false, sessionName });
  assert.equal(record.provider, "artifactfs");
  const mount = record.providerState!;
  const session = await engine.start({ projectPath: record.path, name: sessionName,
    workspace: { bindSource: String(mount.bindSource), stateVolume: String(mount.stateVolume) },
    onEvent(event) { if (event.type === "phase") console.log(`Engine phase: ${event.phase}`); },
  });
  instance = session.ready.instance;
  const image = docker("inspect", "--format", "{{.Config.Image}}", instance).trim();
  actualChecks = dockerCheckExecutor({ image, dockerRuntime });
  try {
    const state = await session.state(); assert.equal(state.ready, true);
    const agent = (...args: string[]) => docker("exec", "-u", session.ready.user,
      "--workdir", session.ready.workdir, session.ready.instance, ...args).trim();
    assert.equal(agent("git", "rev-parse", "HEAD"), record.baseCommit);
    agent("sh", "-ec", "printf 'Returned from mounted ArtifactFS\\n' > RESULT.txt");
    assert.ok((await session.repositoryStatus()).entries.some((entry) => entry.path === "RESULT.txt"));
    assert.match((await session.repositoryDiff("RESULT.txt")).diff, /Returned from mounted ArtifactFS/);
    agent("git", "add", "RESULT.txt");
    agent("git", "-c", "user.name=EnoughFactory", "-c", "user.email=factory@enoughtools.com", "commit", "-m", "Retain real ArtifactFS engine work");
    const attached = await engine.attach({ ready: session.ready, projectPath: record.path, pid: session.process?.pid });
    assert.equal((await attached.state()).instanceName, session.ready.instance);
  } finally { await session.stop(); }
  assert.equal(execFileSync("git", ["-C", record.path, "show", `envmux/${sessionName}:RESULT.txt`], { encoding: "utf8" }).trim(), "Returned from mounted ArtifactFS");
  const candidate = await manager.capture({ workspaceId: record.id });
  const bundlePath = await manager.artifacts.path(candidate.bundleArtifact);
  assert.equal(execFileSync("git", ["-C", record.path, "bundle", "verify", bundlePath], { encoding: "utf8" }).includes("complete history"), true);
  const integrated = await manager.integrate({ candidateId: candidate.id, projectPath: directory, targetBranch: "main",
    commands: ["test \"$(cat RESULT.txt)\" = \"Returned from mounted ArtifactFS\""], isCurrent: () => true });
  assert.equal(integrated.status, "integrated", JSON.stringify(integrated));
  assert.equal(integrated.report?.status, "passed");
  assert.equal(git("show", "HEAD:RESULT.txt"), "Returned from mounted ArtifactFS");
  assert.equal((await readFile(join(directory, "RESULT.txt"), "utf8")).trim(), "Returned from mounted ArtifactFS");
  git("merge-base", "--is-ancestor", candidate.commit, "HEAD");
  console.log(`ArtifactFS factory journey passed: real mounted envmux, container-user edits, API status/diff, attach, exact harvest, candidate ${candidate.commit}, checked integration ${integrated.commit}.`);
} finally {
  try {
    if (instance) docker("rm", "--force", instance);
    if (await provider.readMountRecord(attemptId)) await provider.remove(attemptId);
  } finally { await rm(fixture, { recursive: true, force: true }); }
}
