import assert from "node:assert/strict";
import { spawn, execFileSync, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { hostCodexAvailability, provisionHostCodex } from "./host-provision.ts";
import { type SpawnProcess } from "./process.ts";
import { RUNTIME_PINS } from "./types.ts";

const supported = process.platform === "darwin" && ["arm64", "x64"].includes(process.arch);
async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "enough-host-provision-"));
  const directory = await realpath(temporary), runtimeDirectory = join(directory, "runtime");
  const name = "node-v" + RUNTIME_PINS.node + "-darwin-" + process.arch;
  const source = join(directory, name), archive = join(directory, name + ".tar.gz");
  await mkdir(join(source, "bin"), { recursive: true });
  await mkdir(join(source, "lib/node_modules/npm/bin"), { recursive: true });
  await writeFile(join(source, "bin/node"), "fixture node executable\n", { mode: 0o755 });
  await writeFile(join(source, "lib/node_modules/npm/bin/npm-cli.js"), "fixture npm\n");
  execFileSync("/usr/bin/tar", ["-czf", archive, "-C", directory, name]);
  const sha = createHash("sha256").update(await readFile(archive)).digest("hex");
  let mode = "success", installs = 0, downloads = 0;
  const calls: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  let onInstall: (() => void) | undefined, onDownload: (() => void) | undefined;
  function script(source: string, options: SpawnOptions) {
    return spawn(process.execPath, ["--input-type=module", "-e", source], { ...options, env: options.env });
  }
  const spawnProcess = ((command: string, args: readonly string[], options: SpawnOptions) => {
    calls.push({ command, args: [...args], env: options.env! });
    assert.ok(options.env!.HOME!.startsWith(join(runtimeDirectory, "host-codex")), "Provisioning may only use its private home");
    assert.equal(options.env!.OPENAI_API_KEY, undefined);
    assert.equal(options.env!.CODEX_HOME, join(options.env!.HOME!, ".codex"));
    if (command === "/usr/bin/curl") {
      downloads++; onDownload?.();
      if (mode === "cancel-download") return script("setTimeout(()=>{}, 30000)", options);
      const target = args[args.indexOf("--output") + 1]!;
      const sourceCode = args.at(-1)!.endsWith("SHASUMS256.txt")
        ? "await fs.writeFile(" + JSON.stringify(target) + "," + JSON.stringify((mode === "checksum" ? "0".repeat(64) : sha) + "  " + name + ".tar.gz\n") + ")"
        : "await fs.copyFile(" + JSON.stringify(archive) + "," + JSON.stringify(target) + ")";
      return script("import fs from 'node:fs/promises';" + sourceCode, options);
    }
    if (command === "/usr/bin/tar") return spawn(command, args, options);
    if (basename(command) === "node" && args[0] === "--version") return script("console.log(" + JSON.stringify("v" + RUNTIME_PINS.node) + ")", options);
    if (basename(command) === "node" && args[1] === "install") {
      installs++; onInstall?.();
      const prefix = args[args.indexOf("--prefix") + 1]!, cache = args[args.indexOf("--cache") + 1]!;
      assert.ok(args.includes("--omit=optional"));
      assert.ok(args.includes("--ignore-scripts"));
      assert.ok(args.includes("@openai/codex-darwin-" + process.arch + "@npm:@openai/codex@" + RUNTIME_PINS.codex + "-darwin-" + process.arch));
      const wrapper = join(prefix, "lib/node_modules/@openai/codex");
      const native = join(prefix, "lib/node_modules/@openai/codex-darwin-" + process.arch);
      const nativeBin = join(native, "vendor/" + (process.arch === "arm64" ? "aarch64" : "x86_64") + "-apple-darwin/bin");
      const lines = [
        "import fs from 'node:fs/promises';",
        "await fs.writeFile(" + JSON.stringify(join(cache, "downloaded-package")) + ",'temporary npm cache');",
      ];
      if (mode === "failure") lines.push("console.error('simulated package transfer failure'); process.exit(31);");
      else lines.push(
        "await fs.mkdir(" + JSON.stringify(join(wrapper, "bin")) + ",{recursive:true});",
        "await fs.mkdir(" + JSON.stringify(nativeBin) + ",{recursive:true});",
        "await fs.writeFile(" + JSON.stringify(join(wrapper, "package.json")) + "," + JSON.stringify(JSON.stringify({ name: "@openai/codex", version: RUNTIME_PINS.codex, bin: { codex: "bin/codex.js" } })) + ");",
        "await fs.writeFile(" + JSON.stringify(join(native, "package.json")) + "," + JSON.stringify(JSON.stringify({ name: "@openai/codex", version: RUNTIME_PINS.codex + "-darwin-" + process.arch })) + ");",
        "await fs.writeFile(" + JSON.stringify(join(wrapper, "bin/codex.js")) + ",'fixture wrapper',{mode:0o755});",
        "await fs.writeFile(" + JSON.stringify(join(nativeBin, "codex")) + ",'fixture native executable',{mode:0o755});",
        "await fs.symlink('../lib/node_modules/@openai/codex/bin/codex.js'," + JSON.stringify(join(prefix, "bin/codex")) + ");",
      );
      return script(lines.join("\n"), options);
    }
    if (basename(command) === "codex") return script("console.log(" + JSON.stringify(mode === "wrong-version" ? "codex-cli 0.160.00" : "codex-cli " + RUNTIME_PINS.codex) + ")", options);
    assert.fail("Unexpected host provisioning command: " + command);
  }) as SpawnProcess;
  return {
    runtimeDirectory, options: { runtimeDirectory, spawnProcess }, calls,
    setMode(value: string) { mode = value; }, installs: () => installs, downloads: () => downloads,
    downloaded() { return new Promise<void>(resolve => { onDownload = resolve; }); },
    installing() { return new Promise<void>(resolve => { onInstall = resolve; }); },
    async assertNoScratch() {
      assert.deepEqual((await readdir(join(runtimeDirectory, "host-codex"))).filter(name => name.startsWith(".prepare-") || name.startsWith(".verify-")), []);
    },
    close() { return rm(directory, { recursive: true, force: true }); },
  };
}

test("host Codex availability does not create missing runtime state", { skip: !supported }, async () => {
  const context = await fixture();
  try {
    assert.equal(await hostCodexAvailability(context.options), undefined);
    await assert.rejects(access(context.runtimeDirectory), { code: "ENOENT" });
    assert.equal(context.calls.length, 0);
  } finally { await context.close(); }
});

test("host provisioning reuses verified pinned payload and preserves unrelated provider state", { skip: !supported }, async () => {
  const context = await fixture();
  try {
    await mkdir(context.runtimeDirectory);
    const personal = join(context.runtimeDirectory, "unrelated-state");
    await writeFile(personal, "retain me");
    const [first, second] = await Promise.all([provisionHostCodex(context.options), provisionHostCodex(context.options)]);
    assert.deepEqual(first, second);
    assert.equal(first.version, "codex-cli " + RUNTIME_PINS.codex);
    assert.equal(context.installs(), 1);
    assert.equal(context.downloads(), 2);
    assert.deepEqual(await hostCodexAvailability(context.options), first);
    assert.equal(await readFile(personal, "utf8"), "retain me");
    await context.assertNoScratch();
  } finally { await context.close(); }
});

test("checksum and native verification failures publish nothing and clean their own caches", { skip: !supported }, async t => {
  for (const [mode, code] of [["checksum", "RUNTIME_CHECKSUM_MISMATCH"], ["failure", "HOST_RUNTIME_COMMAND_FAILED"], ["wrong-version", "RUNTIME_VERSION_MISMATCH"]]) {
    await t.test(mode!, async () => {
      const context = await fixture();
      try {
        context.setMode(mode!);
        await assert.rejects(provisionHostCodex(context.options), { code });
        assert.equal(await hostCodexAvailability(context.options), undefined);
        await context.assertNoScratch();
        context.setMode("success");
        assert.equal((await provisionHostCodex(context.options)).version, "codex-cli " + RUNTIME_PINS.codex);
      } finally { await context.close(); }
    });
  }
});

test("changed owned binaries and redirected paths are rejected without deleting either target", { skip: !supported }, async t => {
  for (const kind of ["content", "symlink", "unowned-cache"]) {
    await t.test(kind, async () => {
      const context = await fixture();
      try {
        if (kind === "unowned-cache") {
          await mkdir(join(context.runtimeDirectory, "host-codex"), { recursive: true });
          await writeFile(join(context.runtimeDirectory, "host-codex", "important"), "preserve unowned data");
        } else {
          const runtime = await provisionHostCodex(context.options);
          if (kind === "content") await writeFile(runtime.nodePath, "changed node");
          else {
            const original = await readFile(runtime.nodePath);
            const external = join(context.runtimeDirectory, "external-node");
            await writeFile(external, original, { mode: 0o755 });
            await rm(runtime.nodePath);
            await symlink(external, runtime.nodePath);
          }
        }
        await assert.rejects(provisionHostCodex(context.options), { code: "HOST_RUNTIME_OWNERSHIP" });
        if (kind === "unowned-cache") assert.equal(await readFile(join(context.runtimeDirectory, "host-codex", "important"), "utf8"), "preserve unowned data");
        else assert.ok((await readdir(join(context.runtimeDirectory, "host-codex"))).some(name => name.startsWith("node-")));
      } finally { await context.close(); }
    });
  }
});

test("canceled final provision owner waits for child exit and owned staging cleanup", { skip: !supported }, async () => {
  const context = await fixture(), controller = new AbortController();
  try {
    context.setMode("cancel-download");
    const started = context.downloaded();
    const result = provisionHostCodex({ ...context.options, signal: controller.signal });
    await started; controller.abort();
    await assert.rejects(result, { code: "INTERRUPTED" });
    await context.assertNoScratch();
    assert.equal(await hostCodexAvailability(context.options), undefined);
  } finally { await context.close(); }
});

test("canceling one shared preparation owner does not cancel another", { skip: !supported }, async () => {
  const context = await fixture(), controller = new AbortController();
  try {
    const started = context.installing();
    const canceled = provisionHostCodex({ ...context.options, signal: controller.signal });
    const retained = provisionHostCodex(context.options);
    await started; controller.abort();
    await assert.rejects(canceled, { code: "INTERRUPTED" });
    assert.equal((await retained).version, "codex-cli " + RUNTIME_PINS.codex);
    assert.equal(context.installs(), 1);
    await context.assertNoScratch();
  } finally { await context.close(); }
});

test("host Codex rejects unsupported hosts before touching the filesystem", { skip: supported }, async () => {
  await assert.rejects(provisionHostCodex({ runtimeDirectory: "/must-not-exist/enoughfactory" }), { code: "HOST_RUNTIME_UNSUPPORTED" });
});
