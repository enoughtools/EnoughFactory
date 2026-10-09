import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HostProcess, reconcileHostProcesses, cancelHostProcess, attestLegacyHostReboot, readHostBootIdentity, type HostBootIdentity, type HostObservedRebootInput } from "./host-process.ts";
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

async function interruptedHostReceipt() {
  const f = await fixture();
  const runtime = { nodePath: process.execPath, codexPath: process.execPath, version: "0.160.0", payloadDirectory: f.runtimeDirectory };
  const state = await prepareHostSession({ ...input, cwd: f.cwd }, runtime, { runtimeDirectory: f.runtimeDirectory, workspaceRoots: [f.workspaceRoot] });
  const author = new HostProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: state.cwd, environment: state.environment, processDirectory: state.processDirectory, sessionId: input.sessionId });
  await author.ready;
  const filename = path.join(state.processDirectory, `${author.processKey}.json`);
  const running = JSON.parse(await readFile(filename, "utf8"));
  await author.stop(); await author.exit;
  const terminated = JSON.parse(await readFile(filename, "utf8"));
  // Simulate a lost service/OS transport using the original running receipt.
  // Its actual subprocess was positively stopped above, so the test leaks none.
  running.status = "outcome-unknown";
  await writeFile(filename, JSON.stringify(running));
  return { ...f, ...state, filename, running, terminated, proofPath: path.join(state.processDirectory, `${author.processKey}.reboot.json`) };
}
function laterBoot(original: HostBootIdentity): HostBootIdentity {
  const started = Date.now() + 20_000;
  return { ...original, bootId: "22222222-2222-4222-8222-222222222222", startedAt: new Date(started).toISOString(), observedAt: new Date(started + 20_000).toISOString(), uptimeMs: 20_000 };
}

test("a changed kernel boot identity proves termination while preserving unknown outcome audit", async () => {
  const f = await interruptedHostReceipt();
  try {
    const original = await readFile(f.filename, "utf8"), boot = laterBoot(f.running.boot);
    const readOnly = reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined, persistProof: false })[0]!;
    assert.equal(readOnly.termination?.kind, "host-reboot");
    await assert.rejects(readFile(f.proofPath), { code: "ENOENT" }, "A read-only preflight never persists new process evidence");
    const recovered = reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined })[0]!;
    assert.equal(recovered.state, "exited");
    assert.equal(recovered.cwd, f.cwd); assert.equal(recovered.createdAt, f.running.createdAt);
    assert.equal(recovered.termination?.kind, "host-reboot");
    assert.equal(recovered.termination?.evidence, "boot-identity-change");
    assert.equal(recovered.termination?.previousStatus, "outcome-unknown");
    assert.equal(recovered.termination?.previousUpdatedAt, f.running.updatedAt);
    assert.equal(await readFile(f.filename, "utf8"), original, "Original missing-EOF receipt stays byte-for-byte intact");
    assert.equal((await lstat(f.proofPath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(original).exitCode, undefined); assert.equal(JSON.parse(original).exitSignal, undefined);
    assert.deepEqual(reconcileHostProcesses(f.processDirectory, { readBoot: () => ({ ...boot, bootId: "33333333-3333-4333-8333-333333333333" }), processIdentity: () => undefined })[0]?.termination, recovered.termination, "A later service/OS restart reuses the same durable termination proof");
    assert.equal(await cancelHostProcess(f.processDirectory, f.running.processKey), false, "Already terminated ownership never signals a saved PID");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("missing/recycled PIDs and a service restart in the same boot remain unknown", async () => {
  const f = await interruptedHostReceipt();
  try {
    for (const identity of [undefined, "unrelated replacement process"]) {
      const recovered = reconcileHostProcesses(f.processDirectory, { readBoot: () => f.running.boot, processIdentity: () => identity })[0]!;
      assert.equal(recovered.state, "unknown"); assert.equal(recovered.termination, undefined);
    }
    assert.equal(reconcileHostProcesses(f.processDirectory, { readBoot: () => ({ ...laterBoot(f.running.boot), machineId: "f".repeat(64) }), processIdentity: () => undefined })[0]?.state, "unknown", "Copied ownership on another host is not a reboot of this host");
    assert.equal(reconcileHostProcesses(f.processDirectory, { readBoot: () => laterBoot(f.running.boot), processIdentity: () => f.running.identity })[0]?.state, "active", "A currently matching owned process fences replacement even with inconsistent boot input");
    await assert.rejects(readFile(f.proofPath), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("legacy timestamps cannot prove reboot even when birth/files/current clock all appear before boot", async () => {
  const f = await interruptedHostReceipt();
  try {
    const boot = laterBoot(f.running.boot);
    delete f.running.boot;
    // Keep the atomic receipt mtime and last observation consistent.
    f.running.updatedAt = new Date().toISOString();
    await writeFile(f.filename, JSON.stringify(f.running));
    const original = await readFile(f.filename, "utf8");
    assert.equal(reconcileHostProcesses(f.processDirectory, { readBoot: () => ({ ...boot, uptimeMs: 1 }), processIdentity: () => undefined })[0]?.state, "unknown", "Wall clock discontinuity cannot prove a legacy reboot");
    const savedIdentity = f.running.identity;
    f.running.identity = `invalid process birth ${f.running.supervisorPath} ${f.running.processKey}`;
    await writeFile(f.filename, JSON.stringify(f.running));
    assert.equal(reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined })[0]?.state, "unknown");
    f.running.identity = savedIdentity; await writeFile(f.filename, original);
    await chmod(f.filename, 0o644);
    assert.equal(reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined })[0]?.state, "unknown", "Nonprivate receipt is not trusted reboot evidence");
    await chmod(f.filename, 0o600);
    const recovered = reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined })[0]!;
    assert.equal(recovered.state, "unknown"); assert.equal(recovered.termination, undefined, "A same-boot wall clock step can also satisfy all timestamp chronology checks");
    await assert.rejects(readFile(f.proofPath), { code: "ENOENT" });
    await writeFile(f.proofPath, JSON.stringify({ schemaVersion: 1, kind: "host-reboot", evidence: "legacy-process-before-current-boot", observedAt: boot.observedAt, currentBoot: boot, previousStatus: f.running.status, previousUpdatedAt: f.running.updatedAt, priorRecordSha256: (await import("node:crypto")).createHash("sha256").update(original).digest("hex") }), { mode: 0o600 });
    assert.equal(reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined })[0]?.state, "unknown", "A legacy timestamp-only proof never migrates into a trusted boot UUID proof");
    assert.equal(await readFile(f.filename, "utf8"), original);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("terminal or absent process histories do not synchronously probe the operating system", async () => {
  const f = await fixture();
  try {
    let probes = 0;
    assert.deepEqual(reconcileHostProcesses(path.join(f.directory, "absent"), { readBoot: () => { probes++; return undefined; } }), []);
    const directory = path.join(f.directory, "processes"); await mkdir(directory, { mode: 0o700 });
    const key = "11111111-1111-4111-8111-111111111111";
    await writeFile(path.join(directory, `${key}.json`), JSON.stringify({ schemaVersion: 1, processKey: key, sessionId: input.sessionId, supervisorPath: path.join(directory, `${key}.cjs`), status: "exited" }));
    assert.equal(reconcileHostProcesses(directory, { readBoot: () => { probes++; return undefined; } })[0]?.state, "exited");
    assert.equal(probes, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("malformed boot records and changed reboot proof files cannot authorize recovery", async () => {
  const f = await interruptedHostReceipt();
  try {
    const boot = laterBoot(f.running.boot), original = await readFile(f.filename, "utf8");
    await writeFile(f.filename, JSON.stringify({ ...f.running, boot: { ...f.running.boot, bootId: "bad-id" } }));
    assert.throws(() => reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined }), { code: "HOST_STORAGE_UNSAFE" });
    await writeFile(f.filename, original);
    const recovered = reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined })[0]!;
    assert.equal(recovered.state, "exited");
    const proof = JSON.parse(await readFile(f.proofPath, "utf8"));
    await writeFile(f.proofPath, JSON.stringify({ ...proof, priorRecordSha256: "0".repeat(64) }));
    assert.equal(reconcileHostProcesses(f.processDirectory, { readBoot: () => boot, processIdentity: () => undefined })[0]?.state, "unknown");
    assert.equal(JSON.parse(await readFile(f.proofPath, "utf8")).priorRecordSha256, "0".repeat(64), "Invalid existing proof is preserved for diagnosis, never silently overwritten");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

async function operatorWitnesses(f: Awaited<ReturnType<typeof interruptedHostReceipt>>, overrides: Partial<HostObservedRebootInput> = {}): Promise<HostObservedRebootInput> {
  const { createHash } = await import("node:crypto");
  const binding = {
    actor: "authorized-device-operator", verificationRunId: "original-verifier", chatId: "original-verifier-chat",
    sessionId: input.sessionId, cwd: f.cwd, processKey: f.running.processKey,
    priorRecordSha256: createHash("sha256").update(await readFile(f.filename)).digest("hex"), currentBootId: readHostBootIdentity()!.bootId,
    ...overrides,
  };
  const references: Partial<Pick<HostObservedRebootInput, "beforeWitness" | "afterWitness">> = {};
  for (const phase of ["before", "after"] as const) {
    const filename = path.join(f.directory, `${phase}-${binding.actor}.json`);
    const content = JSON.stringify({ schemaVersion: 1, kind: `operator-observed-reboot-${phase}`, ...binding, observedAt: new Date().toISOString(), observation: phase === "before" ? "The authorized operator observed this exact provider running before the OS restart." : "The authorized operator observed the OS restart and confirmed the current kernel boot identity.", executionObserved: phase === "before" ? "running" : "os-restarted" });
    await writeFile(filename, content, { mode: 0o600 });
    references[`${phase}Witness`] = { path: filename, sha256: createHash("sha256").update(content).digest("hex") };
  }
  return { ...binding, ...references } as HostObservedRebootInput;
}

test("explicit operator-observed legacy reboot retains bound witnesses and does not manufacture provider success", async () => {
  const f = await interruptedHostReceipt();
  try {
    delete f.running.boot; await writeFile(f.filename, JSON.stringify(f.running));
    const original = await readFile(f.filename, "utf8"), request = await operatorWitnesses(f);
    assert.equal(reconcileHostProcesses(f.processDirectory)[0]?.state, "unknown", "Automatic recovery cannot create an operator attestation");
    const proof = attestLegacyHostReboot(f.processDirectory, request);
    assert.equal(proof.kind, "operator-attested-reboot"); assert.equal(proof.evidence, "operator-observed-os-restart");
    assert.equal(proof.verificationRunId, request.verificationRunId); assert.equal(proof.chatId, request.chatId);
    assert.equal(proof.sessionId, input.sessionId); assert.equal(proof.cwd, f.cwd);
    assert.equal(proof.beforeWitness.content, await readFile(request.beforeWitness.path, "utf8"));
    assert.equal(proof.afterWitness.content, await readFile(request.afterWitness.path, "utf8"));
    assert.deepEqual(attestLegacyHostReboot(f.processDirectory, request), proof, "Same explicit attestation is idempotent");
    const recovered = reconcileHostProcesses(f.processDirectory)[0]!;
    assert.equal(recovered.state, "exited"); assert.deepEqual(recovered.termination, proof);
    assert.equal(await readFile(f.filename, "utf8"), original);
    assert.equal(JSON.parse(original).status, "outcome-unknown");
    assert.equal(JSON.parse(original).exitCode, undefined); assert.equal(JSON.parse(original).exitSignal, undefined);
    const otherOperator = await operatorWitnesses(f, { actor: "different-operator" });
    assert.throws(() => attestLegacyHostReboot(f.processDirectory, otherOperator), { code: "HOST_REBOOT_ATTESTATION_INVALID" }, "Another attestation cannot overwrite the original one");
    const proofPath = path.join(f.processDirectory, `${f.running.processKey}.operator-reboot.json`);
    assert.equal((await lstat(proofPath)).mode & 0o777, 0o600);
    await writeFile(proofPath, JSON.stringify({ ...proof, beforeWitness: { ...proof.beforeWitness, content: "changed observation" } }));
    assert.equal(reconcileHostProcesses(f.processDirectory)[0]?.state, "unknown", "Changed retained witness bytes cannot authorize a retry");
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("operator reboot migration rejects wrong receipt/boot/context, unsafe ownership and live children", async () => {
  const f = await interruptedHostReceipt();
  try {
    delete f.running.boot; await writeFile(f.filename, JSON.stringify(f.running));
    const original = await readFile(f.filename, "utf8"), request = await operatorWitnesses(f);
    for (const change of [
      { priorRecordSha256: "0".repeat(64) }, { currentBootId: "44444444-4444-4444-8444-444444444444" },
      { sessionId: "other-session" }, { cwd: path.join(f.cwd, "other") }, { chatId: "another-chat" }, { verificationRunId: "another-verifier" },
      { actor: "unbound-operator" }, { beforeWitness: request.afterWitness }, { afterWitness: request.beforeWitness },
    ]) assert.throws(() => attestLegacyHostReboot(f.processDirectory, { ...request, ...change }), { code: "HOST_REBOOT_ATTESTATION_INVALID" });
    await chmod(f.filename, 0o644);
    assert.throws(() => attestLegacyHostReboot(f.processDirectory, request), { code: "HOST_REBOOT_ATTESTATION_INVALID" });
    await chmod(f.filename, 0o600);
    const supervisorContent = await readFile(f.running.supervisorPath, "utf8");
    await writeFile(f.running.supervisorPath, "changed supervisor");
    assert.throws(() => attestLegacyHostReboot(f.processDirectory, request), { code: "HOST_REBOOT_ATTESTATION_INVALID" });
    await writeFile(f.running.supervisorPath, supervisorContent);
    const { execFileSync } = await import("node:child_process");
    const currentIdentity = execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8" }).trim();
    f.running.children = [{ pid: process.pid, identity: currentIdentity }];
    await writeFile(f.filename, JSON.stringify(f.running));
    const liveChildRequest = await operatorWitnesses(f);
    assert.throws(() => attestLegacyHostReboot(f.processDirectory, liveChildRequest), { code: "HOST_PROCESS_ACTIVE" });
    assert.equal(process.kill(process.pid, 0), true, "Operator attestation never signals a matching live child");
    await writeFile(f.filename, original);
    const proofPath = path.join(f.processDirectory, `${f.running.processKey}.operator-reboot.json`);
    await assert.rejects(readFile(proofPath), { code: "ENOENT" });
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("completed supervised teardown exposes exact positive termination evidence on the same boot", async () => {
  const f = await interruptedHostReceipt();
  try {
    // The fixture retains the original running receipt. Restore the complete
    // termination journal produced by its genuine supervised stop.
    await writeFile(f.filename, JSON.stringify(f.terminated));
    const original = await readFile(f.filename, "utf8"), digest = (await import("node:crypto")).createHash("sha256").update(original).digest("hex");
    const state = reconcileHostProcesses(f.processDirectory)[0]!;
    assert.equal(state.state, "exited");
    assert.equal(state.termination?.kind, "supervised-termination");
    if (state.termination?.kind !== "supervised-termination") throw new Error("Expected complete supervised teardown proof");
    assert.equal(state.termination.evidence, "complete-owned-teardown"); assert.equal(state.termination.priorRecordSha256, digest);
    assert.equal(state.termination.processKey, f.running.processKey); assert.equal(state.termination.sessionId, input.sessionId); assert.equal(state.termination.cwd, f.cwd);
    assert.deepEqual(state.termination.supervisor, { pid: f.running.pid, identity: f.running.identity, path: f.running.supervisorPath });
    assert.deepEqual(state.termination.children, f.terminated.children); assert.equal(state.termination.inventoryComplete, true);
    assert.equal(state.termination.exitCode, null); assert.equal(state.termination.exitSignal, "SIGKILL");
    assert.equal(state.termination.currentBoot.bootId, f.running.boot.bootId, "No reboot or operator attestation is needed");
    assert.equal(await readFile(f.filename, "utf8"), original, "Recovery does not relabel or rewrite the complete teardown receipt");
    const recycled = reconcileHostProcesses(f.processDirectory, { processIdentity: () => "unrelated replacement process" })[0]!;
    assert.equal(recycled.termination?.kind, "supervised-termination"); assert.equal(process.kill(process.pid, 0), true);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("EOF, incomplete inventories, changed owners and matching live tools cannot create supervised termination proof", async () => {
  const f = await interruptedHostReceipt();
  try {
    const complete = f.terminated;
    for (const change of [
      { inventoryComplete: false }, { inventoryComplete: undefined }, { exitCode: 0, exitSignal: null },
      { children: undefined }, { identity: "unowned process" }, { boot: undefined }, { status: "outcome-unknown" },
    ]) {
      await writeFile(f.filename, JSON.stringify({ ...complete, ...change }));
      assert.equal(reconcileHostProcesses(f.processDirectory)[0]?.termination, undefined, "Only complete positive supervised teardown can admit continuation");
    }
    await writeFile(f.filename, JSON.stringify(complete));
    assert.equal(reconcileHostProcesses(f.processDirectory, { processIdentity: pid => pid === complete.pid ? complete.identity : undefined })[0]?.state, "unknown", "A matching live supervisor fences continuation");
    const child = complete.children[0]; assert.ok(child);
    assert.equal(reconcileHostProcesses(f.processDirectory, { processIdentity: pid => pid === child.pid ? child.identity : undefined })[0]?.state, "unknown", "A matching live owned child fences continuation");
    const source = await readFile(complete.supervisorPath, "utf8");
    await writeFile(complete.supervisorPath, "changed supervisor ownership");
    assert.equal(reconcileHostProcesses(f.processDirectory)[0]?.termination, undefined);
    await writeFile(complete.supervisorPath, source);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
