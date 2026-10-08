import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostProcess, reconcileHostProcesses, cancelHostProcess } from "./host-process.ts";
import { prepareHostSession } from "./host-state.ts";
import { AgentManager } from "./index.ts";
import type { TurnInput } from "./types.ts";

const input: TurnInput = { chatId: "host-chat", sessionId: "host-session", executionTarget: "host-macos", runtime: "codex", approvalMode: "approve-all", rules: [], prompt: "Do work" };
async function fixture() {
  const directory = await mkdtemp(path.join(await import("node:fs/promises").then(fs => fs.realpath(tmpdir())), "enoughfactory-host-test-"));
  const runtimeDirectory = path.join(directory, "runtime"), workspaceRoot = path.join(directory, "workspaces"), cwd = path.join(workspaceRoot, "worker");
  await Promise.all([mkdir(runtimeDirectory), mkdir(cwd, { recursive: true })]);
  return { directory, runtimeDirectory, workspaceRoot, cwd };
}

test("host cancellation terminates owned tools and journals an exit independently of Docker", async () => {
  const f = await fixture();
  let author: HostProcess | undefined;
  try {
    const childFile = path.join(f.directory, "child.pid");
    const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',detached:true}); fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid)); console.log('ready');setInterval(()=>{},1000)`;
    author = new HostProcess(process.execPath, ["-e", code], { cwd: f.cwd, environment: { PATH: process.env.PATH }, processDirectory: path.join(f.runtimeDirectory, "processes"), sessionId: input.sessionId });
    await new Promise<void>((resolve, reject) => { author!.lines(line => { if (line === "ready") resolve(); }); void author!.exit.then(() => reject(new Error("Author ended before ready"))); });
    const toolPid = Number(await readFile(childFile, "utf8"));
    assert.equal(reconcileHostProcesses(path.join(f.runtimeDirectory, "processes"))[0]?.state, "active");
    const firstCancellation = author.stop();
    await author.stop(); // Concurrent interruption/finally callers both wait for the same confirmed exit.
    assert.equal(reconcileHostProcesses(path.join(f.runtimeDirectory, "processes"))[0]?.state, "exited");
    await firstCancellation; await author.exit;
    assert.equal(reconcileHostProcesses(path.join(f.runtimeDirectory, "processes"))[0]?.state, "exited");
    // A terminated child can briefly remain a zombie until launchd/init reaps it.
    let alive = false;
    try { process.kill(toolPid, 0); alive = true; } catch {}
    if (alive) {
      const { execFileSync } = await import("node:child_process");
      assert.match(execFileSync("/bin/ps", ["-p", String(toolPid), "-o", "stat="], { encoding: "utf8" }), /Z/);
    }
  } finally {
    if (author) {
      await author.stop().catch(async () => { await cancelHostProcess(path.join(f.runtimeDirectory, "processes"), author!.processKey); await author!.exit; });
    }
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("recovery rejects a recycled PID and never signals its replacement", async () => {
  const f = await fixture(), processDirectory = path.join(f.runtimeDirectory, "processes"); await mkdir(processDirectory);
  try {
    const key = "11111111-1111-4111-8111-111111111111";
    await writeFile(path.join(processDirectory, `${key}.json`), JSON.stringify({ schemaVersion: 1, processKey: key, sessionId: input.sessionId, pid: process.pid, identity: "unrelated old process", supervisorPath: path.join(processDirectory, `${key}.cjs`), status: "running" }));
    assert.equal(reconcileHostProcesses(processDirectory)[0]?.state, "unknown");
    await assert.rejects(cancelHostProcess(processDirectory, key), { code: "HOST_PROCESS_UNKNOWN" });
    assert.equal(process.kill(process.pid, 0), true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("spontaneous supervisor loss keeps a detached tool reserved and fences resume", async () => {
  const f = await fixture(); let author: HostProcess | undefined;
  try {
    const runtime = { nodePath: process.execPath, codexPath: process.execPath, version: "0.160.0", payloadDirectory: f.runtimeDirectory };
    const state = await prepareHostSession({ ...input, cwd: f.cwd }, runtime, { runtimeDirectory: f.runtimeDirectory, workspaceRoots: [f.workspaceRoot] });
    const childFile = path.join(f.directory, "orphan.pid");
    const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid));setTimeout(()=>process.exit(0),2200)`;
    author = new HostProcess(process.execPath, ["-e", code], { cwd: state.cwd, environment: state.environment, processDirectory: state.processDirectory, sessionId: input.sessionId });
    await author.ready; await author.exit;
    assert.equal(reconcileHostProcesses(state.processDirectory)[0]?.state, "unknown");
    await assert.rejects(prepareHostSession({ ...input, cwd: f.cwd, threadId: "same-thread" }, runtime, { runtimeDirectory: f.runtimeDirectory, workspaceRoots: [f.workspaceRoot] }), { code: "HOST_PROCESS_UNKNOWN" });
    await assert.rejects(cancelHostProcess(state.processDirectory, author.processKey), { code: "HOST_PROCESS_UNKNOWN" });
    const childPid = Number(await readFile(childFile, "utf8"));
    let live = true;
    for (let index = 0; index < 50 && live; index++) {
      try { process.kill(childPid, 0); await new Promise(resolve => setTimeout(resolve, 10)); } catch { live = false; }
    }
    assert.equal(live, false, "Recovery retires the verified detached tool without pretending the lost author outcome is known");
    assert.equal(reconcileHostProcesses(state.processDirectory)[0]?.state, "unknown");
  } finally {
    if (author) await cancelHostProcess(path.join(f.runtimeDirectory, "sessions", (await import("node:crypto")).createHash("sha256").update(input.sessionId).digest("hex"), "processes"), author.processKey).catch(() => {});
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("host session isolates auth/config and keeps only its owned workspace", async () => {
  const f = await fixture(), auth = path.join(f.directory, "account");
  try {
    await mkdir(path.join(auth, ".codex"), { recursive: true });
    await writeFile(path.join(auth, ".codex", "auth.json"), '{"API_KEY":"test"}');
    await writeFile(path.join(auth, ".codex", "config.toml"), '[mcp_servers.personal]\ncommand="do-not-copy"');
    const runtime = { nodePath: process.execPath, codexPath: process.execPath, version: "0.160.0", payloadDirectory: f.runtimeDirectory };
    const state = await prepareHostSession({ ...input, cwd: f.cwd, toolEnvironment: { FACTORY_ATTEMPT_TOKEN: "scoped" }, mcpServers: { factory: { command: process.execPath, args: ["bridge.mjs"] } } }, runtime, { runtimeDirectory: f.runtimeDirectory, workspaceRoots: [f.workspaceRoot], copyHostAuth: true, hostAuthDir: auth });
    assert.equal(state.environment.HOME, state.homeDirectory); assert.equal(state.environment.CODEX_HOME, state.codexHome);
    assert.equal(state.environment.FACTORY_ATTEMPT_TOKEN, "scoped"); assert.equal(state.environment.OPENAI_API_KEY, undefined);
    assert.equal(await readFile(path.join(state.codexHome, "auth.json"), "utf8"), '{"API_KEY":"test"}');
    assert.doesNotMatch(await readFile(path.join(state.codexHome, "config.toml"), "utf8"), /personal|do-not-copy/);
    assert.doesNotMatch(await readFile(path.join(state.codexHome, "config.toml"), "utf8"), /mcp_servers.factory|scoped/);
    await prepareHostSession({ ...input, cwd: f.cwd, threadId: "thread-id" }, runtime, { runtimeDirectory: f.runtimeDirectory, workspaceRoots: [f.workspaceRoot] });
    await assert.rejects(prepareHostSession({ ...input, cwd: f.directory }, runtime, { runtimeDirectory: f.runtimeDirectory, workspaceRoots: [f.workspaceRoot] }), { code: "HOST_WORKSPACE_REQUIRED" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("host authoring cannot silently fall back to containers or other providers", async () => {
  const manager = new AgentManager(), callbacks = { onEvent: () => {}, onApproval: async () => true };
  await assert.rejects(manager.runTurn(input, callbacks), { code: "HOST_EXECUTION_UNCONFIGURED" });
  await assert.rejects(manager.runTurn({ ...input, runtime: "claude" }, callbacks), { code: "UNSUPPORTED_HOST_RUNTIME" });
  await assert.rejects(manager.runTurn({ ...input, containerId: "container" }, callbacks), { code: "INVALID_EXECUTION_TARGET" });
  await assert.rejects(manager.runTurn({ ...input, executionTarget: undefined }, callbacks), { code: "CONTAINER_REQUIRED" });
});
