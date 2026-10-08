import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager } from "./index.ts";
import { HostProcess } from "./host-process.ts";
import { prepareHostSession } from "./host-state.ts";
import type { TurnInput } from "./types.ts";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "ef-host-provider-retirement-")));
  const runtimeDirectory = path.join(root, "runtime"), workspaceRoot = path.join(root, "workspaces"), cwd = path.join(workspaceRoot, "verifier");
  await mkdir(runtimeDirectory); await mkdir(cwd, { recursive: true });
  const input: TurnInput = { chatId: "independent-verifier-chat", sessionId: "independent-verifier-session", executionTarget: "host-macos", cwd, runtime: "codex", approvalMode: "approve-all", rules: [], prompt: "Verify exact checked source" };
  const runtime = { nodePath: process.execPath, codexPath: process.execPath, version: "0.160.0", payloadDirectory: runtimeDirectory };
  const options = { runtimeDirectory, workspaceRoots: [workspaceRoot] };
  const state = await prepareHostSession(input, runtime, options);
  await writeFile(path.join(state.codexHome, "saved-image-rollout.json"), '{"retainedPixels":"provider duplicate"}');
  await writeFile(path.join(state.homeDirectory, "tmp", "screenshot.png"), "provider scratch");
  const manager = new AgentManager({ hostRuntimeDir: runtimeDirectory, hostWorkspaceRoots: [workspaceRoot] });
  return { root, runtimeDirectory, cwd, input, runtime, options, state, manager };
}

test("terminal verifier provider retirement removes duplicate rollouts and fences resume while retaining its owner", async () => {
  const f = await fixture();
  try {
    const processOwner = new HostProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.cwd, environment: f.state.environment, processDirectory: f.state.processDirectory, sessionId: f.input.sessionId });
    await processOwner.ready; await processOwner.stop();
    assert.equal(await f.manager.retireHostSession(f.input.sessionId, f.cwd), true);
    await assert.rejects(lstat(f.state.codexHome), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(f.state.homeDirectory, "tmp")), { code: "ENOENT" });
    assert.equal((await f.manager.hostProcesses())[0]!.state, "exited");
    assert.equal(JSON.parse(await readFile(path.join(f.state.homeDirectory, "session.json"), "utf8")).sessionId, f.input.sessionId);
    assert.ok(JSON.parse(await readFile(path.join(f.state.homeDirectory, "session.json"), "utf8")).retiredAt);
    assert.equal(await f.manager.retireHostSession(f.input.sessionId, f.cwd), true, "Retirement can resume after interruption");
    await assert.rejects(prepareHostSession(f.input, f.runtime, f.options), { code: "HOST_SESSION_RETIRED" });
  } finally { await f.manager.shutdown(); await rm(f.root, { recursive: true, force: true }); }
});

test("active and unknown host provider ownership protects its transcript and never signals a recycled PID", async () => {
  const f = await fixture(); let processOwner: HostProcess | undefined;
  try {
    processOwner = new HostProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.cwd, environment: f.state.environment, processDirectory: f.state.processDirectory, sessionId: f.input.sessionId });
    await processOwner.ready;
    await assert.rejects(f.manager.retireHostSession(f.input.sessionId, f.cwd), { code: "HOST_PROCESS_UNKNOWN" });
    assert.ok(await readFile(path.join(f.state.codexHome, "saved-image-rollout.json"), "utf8"));
    await processOwner.stop();
    const key = "11111111-1111-4111-8111-111111111111";
    await writeFile(path.join(f.state.processDirectory, `${key}.json`), JSON.stringify({ schemaVersion: 1, processKey: key, sessionId: f.input.sessionId, pid: process.pid, identity: "a recycled unrelated identity", supervisorPath: path.join(f.state.processDirectory, `${key}.cjs`), status: "running" }));
    await assert.rejects(f.manager.retireHostSession(f.input.sessionId, f.cwd), { code: "HOST_PROCESS_UNKNOWN" });
    assert.equal(process.kill(process.pid, 0), true);
    assert.ok(await readFile(path.join(f.state.codexHome, "saved-image-rollout.json"), "utf8"));
  } finally { await processOwner?.stop(); await rm(f.root, { recursive: true, force: true }); }
});

test("provider retirement rejects changed session/workspace receipts and linked provider homes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.retireHostSession(f.input.sessionId, path.join(f.cwd, "different")), { code: "HOST_STORAGE_UNSAFE" });
    const receiptPath = path.join(f.state.homeDirectory, "session.json"), original = await readFile(receiptPath, "utf8");
    await writeFile(receiptPath, JSON.stringify({ ...JSON.parse(original), sessionId: "other-owner" }));
    await assert.rejects(f.manager.retireHostSession(f.input.sessionId, f.cwd), { code: "HOST_STORAGE_UNSAFE" });
    await writeFile(receiptPath, original);
    const replacement = f.state.homeDirectory + "-retained";
    await (await import("node:fs/promises")).rename(f.state.homeDirectory, replacement);
    await symlink(replacement, f.state.homeDirectory);
    await assert.rejects(f.manager.retireHostSession(f.input.sessionId, f.cwd), { code: "HOST_STORAGE_UNSAFE" });
    assert.ok(await readFile(path.join(replacement, ".codex", "saved-image-rollout.json"), "utf8"));
    const absentId = "never-started-session";
    assert.notEqual(createHash("sha256").update(absentId).digest("hex"), path.basename(f.state.homeDirectory));
    assert.equal(await f.manager.retireHostSession(absentId, f.cwd), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
