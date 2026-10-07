import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerCheckExecutor } from "../src/checks.ts";
import { WorkspaceManager } from "../src/manager.ts";
import { git, run } from "../src/process.ts";
import { discoverSwiftBuildCaches, prepareSwiftBuildMountpoint, removeSwiftBuildMountpoints } from "../src/swift-check-cache.ts";
import type { Candidate, CheckContext } from "../src/types.ts";

async function repository(path: string, nested = false) {
  await mkdir(path, { recursive: true });
  assert.equal((await run("git", ["init", "-b", "main", path])).exitCode, 0);
  await git(path, "config", "user.name", "Cache Boundary");
  await git(path, "config", "user.email", "cache@example.com");
  await writeFile(join(path, "Package.swift"), "// swift-tools-version: 6.0\n");
  await writeFile(join(path, "source.txt"), "saved source\n");
  if (nested) {
    await mkdir(join(path, "Packages", "With spaces"), { recursive: true });
    await writeFile(join(path, "Packages", "With spaces", "Package.swift"), "// swift-tools-version: 6.0\n");
  }
  await git(path, "add", ".");
  await git(path, "commit", "-m", "Saved source");
  return git(path, "rev-parse", "HEAD");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "enough-swift-check-cache-"));
  const path = join(root, "report");
  const commit = await repository(path, true);
  const extra = join(`${path}-working-directories`, "reference");
  const extraCommit = await repository(extra);
  const calls = join(root, "docker-calls.jsonl");
  const resources = join(root, "resources.json");
  const cliPath = join(root, "owned-docker");
  // This is a CLI boundary fixture, not a Docker/Swift execution substitute. Real Git and
  // host copies exercise source attestation; a saved-candidate container check is separate.
  await writeFile(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).slice(4);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const state = fs.existsSync(${JSON.stringify(resources)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(resources)}, 'utf8')) : {volumes:[],containers:[]};
const save = () => fs.writeFileSync(${JSON.stringify(resources)}, JSON.stringify(state));
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1]; state.containers.push(name);
  const mounts = args.filter((arg, index) => args[index - 1] === '--mount').map(value => Object.fromEntries(value.split(',').map(part => part.split('='))));
  for (const mount of mounts) if (mount.type === 'volume' && !state.volumes.includes(mount.source)) state.volumes.push(mount.source);
  save();
  const command = args.at(-1);
  if (command === 'source-mutation') fs.writeFileSync(mounts.find(mount => mount.type === 'bind' && mount.target === '/work').source + '/source.txt', 'changed by check\\n');
  if (command === 'fail') { process.stderr.write('deliberate check failure'); process.exitCode = 7; }
  if (command === 'timeout') { process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000); }
} else if (args[0] === 'rm') {
  state.containers = state.containers.filter(name => name !== args.at(-1)); save();
} else if (args[0] === 'volume' && args[1] === 'rm') {
  const name = args.at(-1);
  if (!state.volumes.includes(name)) { process.stderr.write('Error: No such volume: ' + name); process.exitCode = 1; }
  else { state.volumes = state.volumes.filter(value => value !== name); save(); }
}
`);
  await chmod(cliPath, 0o700);
  const endpoint = { cliPath, host: `unix://${join(root, "owned.sock")}`, configDirectory: join(root, "docker-config") };
  const candidate = { commit, bundleArtifact: {}, diffArtifact: {} } as Candidate;
  const context: CheckContext = { path, commit, candidate, command: "success", timeoutMs: 3_000, workingDirectories: [{ path: extra, commit: extraCommit, containerPath: "/workspaces/reference" }] };
  return {
    root, path, extra, commit, context, endpoint,
    calls: async (): Promise<string[][]> => (await readFile(calls, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)),
    resources: async (): Promise<{ volumes: string[]; containers: string[] }> => JSON.parse(await readFile(resources, "utf8")),
  };
}

function cacheMounts(args: string[]) {
  return args.filter((arg, index) => args[index - 1] === "--mount" && arg.startsWith("type=volume,source=enough-check-swift-"));
}

test("Swift cache discovery uses exact checked trees and refuses mounts over immutable source", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.path, "untracked"));
    await writeFile(join(f.path, "untracked", "Package.swift"), "not saved");
    const roots = [{ path: f.path, commit: f.commit, containerPath: "/work" }, ...f.context.workingDirectories!];
    const caches = await discoverSwiftBuildCaches(roots);
    assert.deepEqual(caches.map(cache => cache.containerPath), ["/work/.build", "/work/Packages/With spaces/.build", "/workspaces/reference/.build"]);
    await mkdir(join(f.path, ".build"));
    await writeFile(join(f.path, ".build", "saved-input"), "must not hide");
    await git(f.path, "add", ".build");
    await git(f.path, "commit", "-m", "Tracked build input");
    assert.equal((await discoverSwiftBuildCaches(roots)).length, 3); // HEAD moved; checked commit did not.
    await assert.rejects(discoverSwiftBuildCaches([{ ...roots[0], commit: await git(f.path, "rev-parse", "HEAD") }]), /Cannot hide tracked Swift build inputs/);
    await git(f.path, "reset", "--hard", f.commit);
    await rm(join(f.path, "Package.swift"));
    await symlink("source.txt", join(f.path, "Package.swift"));
    await git(f.path, "add", "Package.swift"); await git(f.path, "commit", "-m", "Linked manifest");
    await assert.rejects(discoverSwiftBuildCaches([{ ...roots[0], commit: await git(f.path, "rev-parse", "HEAD") }]), /manifest must be a regular file/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("mountpoint preparation and cleanup preserve existing inputs, modes and external symlink targets", async () => {
  const f = await fixture();
  try {
    const [cache, nested, extra] = await discoverSwiftBuildCaches([{ path: f.path, commit: f.commit, containerPath: "/work" }, ...f.context.workingDirectories!]);
    const created = new Map<string, string>();
    await prepareSwiftBuildMountpoint(cache, created, true);
    await removeSwiftBuildMountpoints(created);
    await assert.rejects(lstat(cache.path), /ENOENT/);
    await mkdir(cache.path, { mode: 0o711 });
    await prepareSwiftBuildMountpoint(cache, created, true);
    await removeSwiftBuildMountpoints(created);
    assert.equal((await stat(cache.path)).mode & 0o777, 0o711);
    await writeFile(join(cache.path, "input"), "keep");
    await assert.rejects(prepareSwiftBuildMountpoint(cache, created, true), /Cannot hide existing/);
    await mkdir(extra.path, { mode: 0o711 });
    await assert.rejects(prepareSwiftBuildMountpoint(extra, created, false), /Cannot hide a captured/);
    assert.equal((await stat(extra.path)).mode & 0o777, 0o711);
    await rm(cache.path, { recursive: true });
    const outside = join(f.root, "outside"); await mkdir(outside); await mkdir(join(outside, ".build"));
    await symlink(outside, cache.path);
    await assert.rejects(prepareSwiftBuildMountpoint(cache, created, true), /Cannot hide existing/);
    await rm(cache.path);
    await prepareSwiftBuildMountpoint(nested, created, true);
    const packagePath = join(f.path, "Packages", "With spaces");
    await rename(packagePath, `${packagePath}-moved`); await symlink(outside, packagePath);
    await assert.rejects(removeSwiftBuildMountpoints(created), /real directory/);
    assert.ok((await lstat(join(outside, ".build"))).isDirectory());
    assert.ok((await lstat(join(`${packagePath}-moved`, ".build"))).isDirectory());
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("all check commands reuse distinct per-package Linux volumes without changing scratch arguments or host inventories", async () => {
  const f = await fixture();
  const execute = dockerCheckExecutor({ dockerRuntime: f.endpoint });
  try {
    const command = "swift test --package-path Packages/With\\ spaces --scratch-path /tmp/explicit-build";
    for (const text of [command, "second check"]) {
      assert.equal((await execute({ ...f.context, command: text })).exitCode, 0);
      await assert.rejects(lstat(join(f.path, ".build")), /ENOENT/);
      await assert.rejects(lstat(join(f.extra, ".build")), /ENOENT/);
      assert.equal(await git(f.extra, "status", "--porcelain", "--untracked-files=all"), "");
    }
    const runs = (await f.calls()).filter(args => args[0] === "run");
    assert.equal(runs.length, 2); assert.equal(runs[0].at(-1), command);
    const mounts = cacheMounts(runs[0]); assert.equal(mounts.length, 3);
    assert.equal(new Set(mounts.map(value => value.split(",")[1])).size, 3);
    assert.deepEqual(cacheMounts(runs[1]), mounts);
    for (const mount of mounts) assert.match(mount, /,target=\/work(?:spaces\/reference|\/Packages\/With spaces)?\/\.build,volume-nocopy$/);
    assert.equal(runs.some(args => args.some(value => /SWIFTPM_BUILD_DIR|CLANG_MODULE_CACHE_PATH/.test(value))), false);
    assert.equal((await f.resources()).volumes.length, 5); // Three caches plus two private Git roots.
    await execute.release!(f.path);
    assert.deepEqual(await f.resources(), { volumes: [], containers: [] });
  } finally { await execute.release!(f.path); await rm(f.root, { recursive: true, force: true }); }
});

test("setup failure, failed commands and timeouts release caches without retrying commands", async () => {
  for (const failure of ["setup", "fail", "timeout"]) {
    const f = await fixture();
    const execute = dockerCheckExecutor({ dockerRuntime: f.endpoint });
    try {
      if (failure === "setup") {
        await symlink(join(f.root, "external"), join(f.extra, ".build"));
        await assert.rejects(execute(f.context), /Cannot hide a captured/);
      } else {
        const result = await execute({ ...f.context, command: failure, timeoutMs: failure === "timeout" ? 300 : 3_000 });
        if (failure === "timeout") assert.equal(result.timedOut, true);
        else { assert.equal(result.exitCode, 7); assert.equal(result.stderr, "deliberate check failure"); }
      }
      await assert.rejects(lstat(join(f.path, ".build")), /ENOENT/);
      await assert.rejects(lstat(join(f.path, "Packages", "With spaces", ".build")), /ENOENT/);
      const calls = await f.calls();
      assert.equal(calls.filter(args => args[0] === "run").length, failure === "setup" ? 0 : 1);
      assert.equal(calls.filter(args => args[0] === "volume" && args[1] === "rm" && args.at(-1)!.startsWith("enough-check-swift-")).length, 3);
      if (failure !== "setup") assert.deepEqual(await f.resources(), { volumes: [], containers: [] });
      else assert.ok((await lstat(join(f.extra, ".build"))).isSymbolicLink());
    } finally { await execute.release!(f.path); await rm(f.root, { recursive: true, force: true }); }
  }
});

test("Linux cache overlays keep tracked source mutations visible to candidate attestation", async () => {
  const f = await fixture();
  const manager = new WorkspaceManager({ dataDir: join(f.root, "manager"), deviceId: "cache-test", checkExecutor: dockerCheckExecutor({ dockerRuntime: f.endpoint }) });
  try {
    const workspace = await manager.create({ projectPath: f.path, goalId: "goal", taskId: "task", attemptId: "attempt" });
    const candidate = await manager.capture({ workspaceId: workspace.id });
    const report = await manager.verify({ candidateId: candidate.id, commands: ["source-mutation"] });
    assert.equal(report.commands[0].exitCode, 0);
    assert.equal(report.status, "failed");
    const evidence = JSON.parse((await manager.artifacts.read(report.logArtifact)).toString());
    assert.match(evidence.dirty, /source.txt/); assert.equal(evidence.actualHead, candidate.commit);
    assert.equal(await readFile(join(f.path, "source.txt"), "utf8"), "saved source\n");
    assert.deepEqual(await f.resources(), { volumes: [], containers: [] });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
