import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerCheckExecutor } from "../src/checks.ts";
import { WorkspaceManager } from "../src/manager.ts";
import { git, run } from "../src/process.ts";
import type { Candidate, CheckContext } from "../src/types.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "enough-check-modes-")), path = join(root, "source");
  const extra = join(`${path}-working-directories`, "reference"), outside = join(root, "outside");
  for (const directory of [path, extra]) {
    await mkdir(join(directory, "scripts"), { recursive: true });
    assert.equal((await run("git", ["init", "-b", "main", directory])).exitCode, 0);
    await git(directory, "config", "user.name", "Mode Test");
    await git(directory, "config", "user.email", "mode@example.com");
    await writeFile(join(directory, "source.txt"), "retained source\n");
    await writeFile(join(directory, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
    await chmod(join(directory, "source.txt"), 0o640);
    await chmod(join(directory, "scripts", "check.sh"), 0o750);
    await chmod(join(directory, "scripts"), 0o710);
    await git(directory, "add", "."); await git(directory, "commit", "-m", "Saved source");
  }
  await mkdir(outside); await writeFile(join(outside, "sentinel"), "external\n");
  await chmod(outside, 0o500); await chmod(join(outside, "sentinel"), 0o400);
  await symlink(outside, join(path, "external-link"));
  const cliPath = join(root, "owned-docker"), calls = join(root, "calls.jsonl");
  // Execute the actual generated shell wrapper against real private host copies. Only the
  // Docker namespace/mount boundary is simulated; permission effects are real filesystem IO.
  await writeFile(cliPath, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2).slice(4);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if(args[0]==='run'){
  const mounts=args.filter((a,i)=>args[i-1]==='--mount'&&a.startsWith('type=bind,')).map(a=>Object.fromEntries(a.split(',').map(p=>p.split('=')))).filter(m=>m.target==='/work'||m.target.startsWith('/workspaces/')).sort((a,b)=>b.target.length-a.target.length);
  const translate=s=>mounts.reduce((s,m)=>s.replaceAll(m.target,m.source),s);
  const wrapper=args[args.indexOf('-c')+1],command=args.at(-1);
  const result=cp.spawnSync('sh',['-c',translate(wrapper),'enoughfactory-check',translate(command)],{cwd:mounts.find(m=>m.target==='/work').source,encoding:'utf8'});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exitCode=result.status??1;
}
`);
  await chmod(cliPath, 0o700);
  const commit = await git(path, "rev-parse", "HEAD");
  const candidate = { commit, bundleArtifact: {}, diffArtifact: {} } as Candidate;
  const context: CheckContext = { path, commit, candidate, command: "true", timeoutMs: 5_000, workingDirectories: [{ path: extra, containerPath: "/workspaces/reference", commit: await git(extra, "rev-parse", "HEAD") }] };
  const executor = dockerCheckExecutor({ dockerRuntime: { cliPath, host: `unix://${join(root, "owned.sock")}`, configDirectory: join(root, "config") } });
  return { root, path, extra, outside, executor, context, calls: async (): Promise<string[][]> => (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line)) };
}

test("actual check wrapper preserves complete source modes on every root and leaves symlink targets untouched", async () => {
  const f = await fixture();
  try {
    const result = await f.executor(f.context);
    assert.equal(result.exitCode, 0, result.stderr);
    for (const root of [f.path, f.extra]) {
      assert.equal((await lstat(join(root, "source.txt"))).mode & 0o777, 0o640);
      assert.equal((await lstat(join(root, "scripts", "check.sh"))).mode & 0o777, 0o750);
      assert.equal((await lstat(join(root, "scripts"))).mode & 0o777, 0o710);
    }
    assert.equal((await lstat(f.outside)).mode & 0o777, 0o500);
    assert.equal((await lstat(join(f.outside, "sentinel"))).mode & 0o777, 0o400);
    assert.equal((await f.calls()).filter(args => args[0] === "rm").length, 1, "the exact check container must be confirmed stopped before mode attestation");
  } finally { await f.executor.release!(f.path); await chmod(f.outside, 0o700); await rm(f.root, { recursive: true, force: true }); }
});

test("real check mode edits fail with original and observed evidence and are never restored", async () => {
  const f = await fixture();
  try {
    const result = await f.executor({ ...f.context, command: "chmod 600 source.txt; chmod 700 /workspaces/reference/scripts" });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /\/work\/source.txt: expected file mode 640, observed file mode 600/);
    assert.match(result.stderr, /\/workspaces\/reference\/scripts: expected directory mode 710, observed directory mode 700/);
    assert.equal((await lstat(join(f.path, "source.txt"))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(f.extra, "scripts"))).mode & 0o777, 0o700);
    assert.equal(await readFile(join(f.path, "source.txt"), "utf8"), "retained source\n");
  } finally { await f.executor.release!(f.path); await chmod(f.outside, 0o700); await rm(f.root, { recursive: true, force: true }); }
});

test("unreadable check mode edits retain the untouched failing snapshot and durable command evidence", { skip: process.getuid?.() === 0 }, async () => {
  const f = await fixture();
  let retained = "";
  try {
    const dataDir = join(f.root, "data");
    const manager = new WorkspaceManager({ dataDir, deviceId: "mode-test", checkExecutor: f.executor });
    const workspace = await manager.create({ projectPath: f.path, goalId: "goal", taskId: "task", attemptId: "unreadable-attempt" });
    const candidate = await manager.capture({ workspaceId: workspace.id });
    const report = await manager.verify({ candidateId: candidate.id, commands: ["printf 'original command evidence'; chmod 000 .", "must not run"] });
    assert.equal(report.status, "failed"); assert.equal(report.commands.length, 1);
    assert.equal(report.commands[0]!.stdout, "original command evidence");
    assert.match(report.cleanupErrors!.join("\n"), /\/work\/ \(observed mode 0, expected 755\)/);
    const evidence = JSON.parse((await manager.artifacts.read(report.logArtifact)).toString());
    retained = evidence.retainedCheckPath;
    assert.match(evidence.sourceAuditSkipped, /attestation failed/);
    assert.equal((await lstat(retained)).mode & 0o777, 0o000, "failure handling must not restore or retire the inaccessible source");
    assert.deepEqual(evidence.commands, JSON.parse(JSON.stringify(report.commands)));
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, "reports", `${report.id}.json`), "utf8")), JSON.parse(JSON.stringify(report)));
  } finally { if (retained) await chmod(retained, 0o700); await f.executor.release!(f.path); await chmod(f.outside, 0o700); await rm(f.root, { recursive: true, force: true }); }
});
