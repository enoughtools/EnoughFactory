import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager } from "./index.ts";
import { provisionRuntime, releaseCodexPayload } from "./provision.ts";
import type { SpawnProcess } from "./process.ts";
import { RUNTIME_PINS, type TurnInput } from "./types.ts";

const dockerEndpoint = { cliPath: "/owned/docker", host: "unix:///owned/docker.sock", configDirectory: "/owned/config" };

/** Run the real cleanup program against tiny disposable files, never a container. */
async function fixture(platform = "arm64") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "enough-codex-cleanup-")));
  const prefix = path.join(root, "node"), agents = path.join(root, "agents"), proc = path.join(root, "proc"), home = path.join(root, "home");
  const wrapper = path.join(prefix, "lib/node_modules/@openai/codex"), native = path.join(prefix, `lib/node_modules/@openai/codex-linux-${platform}`);
  const link = path.join(prefix, "bin/codex"), receipt = path.join(agents, "codex-install.json");
  for (const directory of [path.join(wrapper, "bin"), native, path.join(prefix, "bin"), agents, proc, path.join(home, ".codex"), path.join(home, ".npm"), path.join(prefix, "lib/node_modules/npm"), path.join(prefix, "lib/node_modules/@anthropic-ai/claude-code"), path.join(root, "antigravity")]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(wrapper, "package.json"), JSON.stringify({ name: "@openai/codex", version: RUNTIME_PINS.codex, bin: { codex: "bin/codex.js" } }));
  await writeFile(path.join(wrapper, "bin/codex.js"), `#!/usr/bin/env node\nconsole.log('codex-cli ${RUNTIME_PINS.codex}');\n`);
  await chmod(path.join(wrapper, "bin/codex.js"), 0o755);
  await writeFile(path.join(native, "package.json"), JSON.stringify({ name: "@openai/codex", version: `${RUNTIME_PINS.codex}-linux-${platform}` }));
  await writeFile(path.join(native, "payload"), "native payload");
  await symlink("../lib/node_modules/@openai/codex/bin/codex.js", link);
  await symlink(process.execPath, path.join(prefix, "bin/node"));
  const kept = [path.join(home, ".codex/auth.json"), path.join(home, ".codex/session.jsonl"), path.join(home, ".npm/cache"), path.join(prefix, "lib/node_modules/npm/package.json"), path.join(prefix, "lib/node_modules/@anthropic-ai/claude-code/package.json"), path.join(root, "antigravity/state")];
  for (const filename of kept) await writeFile(filename, "must survive");
  const owned = { schemaVersion: 1, runtime: "codex", wrapperVersion: RUNTIME_PINS.codex, nativeAlias: `@openai/codex-linux-${platform}`, nativeVersion: `${RUNTIME_PINS.codex}-linux-${platform}` };
  await writeFile(receipt, JSON.stringify(owned));
  let calls = 0;
  const translate = (text: string) => text.replaceAll("/opt/enoughfactory/node", prefix).replaceAll("/opt/enoughfactory/agents", agents).replaceAll("/proc", proc).replaceAll("/root", home);
  const spawnProcess = ((command: string, args: readonly string[]) => {
    calls++;
    assert.equal(command, dockerEndpoint.cliPath);
    assert.deepEqual(args.slice(0, 4), ["--host", dockerEndpoint.host, "--config", dockerEndpoint.configDirectory]);
    const index = args.indexOf("fixture-container");
    assert.ok(index > 4);
    const invocation = args.slice(index + 1).map(translate);
    if (invocation[0] === "sh" && invocation[1] === "-s") {
      // Translate the installer stdin without executing any real provider or npm.
      const child = spawn("/bin/sh", ["-s"], { stdio: "pipe", env: { PATH: `${prefix}/bin:/usr/bin:/bin`, HOME: home, FIXTURE_PREFIX: prefix, TMPDIR: root } });
      const stdin = child.stdin;
      const originalEnd = stdin.end.bind(stdin);
      stdin.end = ((value: string, ...rest: unknown[]) => originalEnd(translate(value), ...rest as [])) as typeof stdin.end;
      return child;
    }
    return spawn(invocation[0]!, invocation.slice(1), { stdio: "pipe", env: { PATH: `${prefix}/bin:/usr/bin:/bin`, HOME: home } });
  }) as SpawnProcess;
  return {
    root, prefix, agents, proc, wrapper, native, link, receipt, owned, options: { dockerEndpoint, spawnProcess }, calls: () => calls,
    async executable(name: string, body: string) { const filename = path.join(prefix, "bin", name); await writeFile(filename, `#!/bin/sh\n${body}\n`); await chmod(filename, 0o755); },
    async preserved() { for (const filename of kept) assert.equal(await readFile(filename, "utf8"), "must survive"); assert.equal((await lstat(path.join(prefix, "bin/node"))).isSymbolicLink(), true); },
    async payloadPresent() { await Promise.all([access(wrapper), access(native), lstat(link)]); },
    async close() { await rm(root, { recursive: true, force: true }); },
  };
}

test("idle owned Codex payload release preserves provider state, Node/npm and other runtimes", async t => {
  for (const platform of ["arm64", "x64"]) await t.test(platform, async () => {
    const f = await fixture(platform);
    try {
      assert.deepEqual(await releaseCodexPayload("fixture-container", f.options), { status: "released" });
      for (const filename of [f.wrapper, f.native, f.link]) await assert.rejects(lstat(filename), { code: "ENOENT" });
      assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), f.owned);
      await f.preserved();
      assert.deepEqual(await releaseCodexPayload("fixture-container", f.options), { status: "released" }, "Release is idempotent with its tiny ownership receipt");
    } finally { await f.close(); }
  });
});

test("unreceipted, changed or redirected payloads are retained before any deletion", async t => {
  const cases = {
    unreceipted: async (f: Awaited<ReturnType<typeof fixture>>) => rm(f.receipt),
    "receipt pin": async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(f.receipt, JSON.stringify({ ...f.owned, wrapperVersion: "other" })),
    "wrapper pin": async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(path.join(f.wrapper, "package.json"), JSON.stringify({ name: "@openai/codex", version: "other", bin: { codex: "bin/codex.js" } })),
    "native pin": async (f: Awaited<ReturnType<typeof fixture>>) => writeFile(path.join(f.native, "package.json"), JSON.stringify({ name: "@openai/codex", version: "other" })),
    "executable link": async (f: Awaited<ReturnType<typeof fixture>>) => { await rm(f.link); await symlink("node", f.link); },
    "metadata symlink": async (f: Awaited<ReturnType<typeof fixture>>) => { const filename = path.join(f.native, "package.json"); const copy = path.join(f.root, "native-metadata"); await writeFile(copy, await readFile(filename)); await rm(filename); await symlink(copy, filename); },
    "ancestor symlink": async (f: Awaited<ReturnType<typeof fixture>>) => { const bin = path.join(f.prefix, "bin"), redirected = path.join(f.root, "redirected-bin"); await mkdir(redirected); await symlink(process.execPath, path.join(redirected, "node")); await symlink("../node/lib/node_modules/@openai/codex/bin/codex.js", path.join(redirected, "codex")); await rm(bin, { recursive: true }); await symlink(redirected, bin); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = await fixture();
    try { await change(f); assert.equal((await releaseCodexPayload("fixture-container", f.options)).status, "deferred"); await f.payloadPresent(); await f.preserved(); }
    finally { await f.close(); }
  });
});

test("residual Codex native or wrapper processes defer cleanup without interruption", async t => {
  for (const route of ["native", "wrapper"]) await t.test(route, async () => {
    const f = await fixture();
    try {
      const processDirectory = path.join(f.proc, "999999"); await mkdir(processDirectory);
      await symlink(route === "native" ? path.join(f.native, "vendor/codex/codex") : process.execPath, path.join(processDirectory, "exe"));
      await writeFile(path.join(processDirectory, "cmdline"), route === "wrapper" ? `node\0${f.link}\0app-server\0` : "codex\0app-server\0");
      assert.equal((await releaseCodexPayload("fixture-container", f.options)).status, "deferred");
      await f.payloadPresent(); await f.preserved();
      await access(processDirectory);
    } finally { await f.close(); }
  });
});

test("only our successful installer creates and recreates the ownership receipt", async () => {
  const f = await fixture();
  try {
    await rm(f.receipt);
    await provisionRuntime("fixture-container", "codex", {}, f.options);
    await assert.rejects(access(f.receipt), { code: "ENOENT" }, "A reused healthy runtime is not claimed");
    await f.executable("setsid", "exit 0");
    await f.executable("uname", "printf 'aarch64\\n'");
    await f.executable("npm", `mkdir -p "$FIXTURE_PREFIX/lib/node_modules/@openai/codex/bin" "$FIXTURE_PREFIX/lib/node_modules/@openai/codex-linux-arm64"
printf '%s' '{"name":"@openai/codex","version":"${RUNTIME_PINS.codex}","bin":{"codex":"bin/codex.js"}}' > "$FIXTURE_PREFIX/lib/node_modules/@openai/codex/package.json"
printf '%s' '{"name":"@openai/codex","version":"${RUNTIME_PINS.codex}-linux-arm64"}' > "$FIXTURE_PREFIX/lib/node_modules/@openai/codex-linux-arm64/package.json"
printf '#!/bin/sh\\nprintf "codex-cli ${RUNTIME_PINS.codex}\\\\n"\\n' > "$FIXTURE_PREFIX/lib/node_modules/@openai/codex/bin/codex.js"
chmod 755 "$FIXTURE_PREFIX/lib/node_modules/@openai/codex/bin/codex.js"
ln -sf ../lib/node_modules/@openai/codex/bin/codex.js "$FIXTURE_PREFIX/bin/codex"`);
    await rm(f.wrapper, { recursive: true }); await rm(f.native, { recursive: true }); await rm(f.link);
    await provisionRuntime("fixture-container", "codex", {}, f.options);
    assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), f.owned);
    assert.equal((await releaseCodexPayload("fixture-container", f.options)).status, "released");
    await provisionRuntime("fixture-container", "codex", {}, f.options);
    assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), f.owned);
    await f.payloadPresent(); await f.preserved();
  } finally { await f.close(); }
});

function pendingProcess() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  return child;
}
const input: TurnInput = { chatId: "chat-a", sessionId: "session-a", containerId: "container-a", runtime: "codex", approvalMode: "approve-all", rules: [], prompt: "Work", cwd: "/work", codexTransport: "exec" };

test("manager release defers for live turns and pending provisioning or credentials", async t => {
  for (const route of ["turn", "provision", "credentials"] as const) await t.test(route, async () => {
    const child = pendingProcess(); let calls = 0;
    const manager = new AgentManager({ autoProvision: false, dockerEndpoint, spawnProcess: ((_command: string, _args: readonly string[], options: { stdio?: string }) => {
      calls++;
      if (options.stdio === "ignore") { const cleanup = pendingProcess(); queueMicrotask(() => cleanup.emit("close", 0)); return cleanup; }
      return child;
    }) as unknown as SpawnProcess });
    const job = route === "turn" ? manager.runTurn(input, { onEvent() {}, onApproval: async () => true }) : route === "provision" ? manager.provision("container-a", "codex") : manager.connectApiKey("container-a", "claude", "fixture-key");
    const settled = job.catch(() => {});
    const before = calls;
    assert.equal((await manager.releaseCodexPayload("container-a")).status, "deferred");
    assert.equal(calls, before, "Cleanup cannot launch or interrupt a process while this container is busy");
    child.emit("close", 1);
    await settled;
  });
});

test("manager fences new turns, provisioning and credential writes during release", async () => {
  const child = pendingProcess(); let calls = 0;
  const manager = new AgentManager({ autoProvision: false, dockerEndpoint, spawnProcess: (() => { calls++; return child; }) as unknown as SpawnProcess });
  const releasing = manager.releaseCodexPayload("container-a");
  const failure = { code: "RUNTIME_CLEANUP_ACTIVE", agentStarted: false, executionEnded: true };
  await assert.rejects(manager.runTurn(input, { onEvent() {}, onApproval: async () => true }), failure);
  await assert.rejects(manager.provision("container-a", "codex"), failure);
  await assert.rejects(manager.connectApiKey("container-a", "claude", "fixture-key"), failure);
  assert.equal((await manager.releaseCodexPayload("container-a")).status, "deferred");
  assert.equal(calls, 1);
  child.stdout.write('{"status":"released"}\n'); child.emit("close", 0);
  assert.deepEqual(await releasing, { status: "released" });
  const after = manager.connectApiKey("container-a", "claude", "fixture-key");
  child.emit("close", 0); await after;
  assert.equal(calls, 2, "The fence releases after cleanup completes");
});
