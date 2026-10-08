import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AgentError, RUNTIME_PINS } from "./types.ts";
import { suspendAwareTimeout, type SpawnProcess } from "./process.ts";

export interface HostCodexRuntime {
  nodePath: string;
  codexPath: string;
  version: string;
  payloadDirectory: string;
}
export interface HostProvisionOptions {
  runtimeDirectory: string;
  signal?: AbortSignal;
  spawnProcess?: SpawnProcess;
}
interface Receipt {
  schemaVersion: 1;
  kind: "enoughfactory-host-codex";
  platform: "darwin";
  architecture: "arm64" | "x64";
  nodeVersion: string;
  codexVersion: string;
  archiveSha256: string;
  nodeSha256: string;
  wrapperSha256: string;
  nativeSha256: string;
}
const ownerFile = ".enoughfactory-owned.json", receiptFile = ".enoughfactory-host-runtime.json";
const owner = { schemaVersion: 1, kind: "enoughfactory-host-codex-cache" };
const inFlight = new Map<string, { promise: Promise<HostCodexRuntime>; controller: AbortController; waiters: number }>();

function interrupted(): AgentError { return new AgentError("Host Codex preparation was interrupted.", "INTERRUPTED", true); }
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw interrupted(); }
function architecture(): "arm64" | "x64" {
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) throw new AgentError("Host Codex requires macOS on Apple silicon or Intel.", "HOST_RUNTIME_UNSUPPORTED");
  return process.arch as "arm64" | "x64";
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function ownership(message: string): AgentError { return new AgentError(message, "HOST_RUNTIME_OWNERSHIP"); }
async function stat(path: string) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; }
}
async function plainDirectory(path: string): Promise<boolean> {
  const value = await stat(path);
  if (!value) return false;
  if (!value.isDirectory() || value.isSymbolicLink() || value.uid !== process.getuid?.()) throw ownership("A host runtime directory is not owned by this user or is a symbolic link.");
  return true;
}
/** Resolve aliases above the selected root once; all managed descendants must remain plain owned directories. */
async function rootDirectory(value: string, create: boolean): Promise<string | undefined> {
  if (!isAbsolute(value)) throw ownership("The host runtime directory must be an absolute path.");
  const root = resolve(value);
  if (await plainDirectory(root)) return await realpath(root);
  if (!create) return undefined;
  const parent = dirname(root);
  if (parent === root) throw ownership("The host runtime root could not be created safely.");
  const existing = await stat(parent);
  let canonicalParent: string;
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw ownership("A host runtime parent is not a plain directory.");
    canonicalParent = await realpath(parent);
  } else canonicalParent = (await rootDirectory(parent, true))!;
  const path = join(canonicalParent, root.slice(parent.length + 1));
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await plainDirectory(path);
  return path;
}
async function descendants(root: string, path: string): Promise<void> {
  const relative = path.slice(root.length + 1);
  if (!path.startsWith(root + "/") || relative.split("/").some(value => !value || value === "." || value === "..")) throw ownership("A host runtime path escaped its owned root.");
  let current = root;
  for (const component of relative.split("/").slice(0, -1)) {
    current = join(current, component);
    if (!await plainDirectory(current)) throw ownership("A host runtime directory is missing.");
  }
}
async function regularFile(root: string, path: string, executable = false) {
  await descendants(root, path);
  const value = await stat(path);
  if (!value?.isFile() || value.isSymbolicLink() || value.uid !== process.getuid?.() || executable && !(value.mode & 0o111)) throw ownership("A host runtime file is missing, changed or not owned by this user.");
  return value;
}
async function json<T>(root: string, path: string): Promise<T> {
  if ((await regularFile(root, path)).size > 65_536) throw ownership("Host runtime ownership metadata is too large.");
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch { throw ownership("Host runtime ownership metadata is unreadable."); }
}
async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function layout(cache: string, arch = architecture()) {
  const directory = join(cache, "node-" + RUNTIME_PINS.node + "-codex-" + RUNTIME_PINS.codex + "-darwin-" + arch);
  const nodeDirectory = join(directory, "node");
  const wrapperDirectory = join(nodeDirectory, "lib/node_modules/@openai/codex");
  const nativeDirectory = join(nodeDirectory, "lib/node_modules/@openai/codex-darwin-" + arch);
  return {
    directory, nodeDirectory, wrapperDirectory, nativeDirectory,
    nodePath: join(nodeDirectory, "bin/node"), codexPath: join(nodeDirectory, "bin/codex"),
    wrapperPath: join(wrapperDirectory, "bin/codex.js"),
    nativePath: join(nativeDirectory, "vendor/" + (arch === "arm64" ? "aarch64" : "x86_64") + "-apple-darwin/bin/codex"),
  };
}
function privateEnvironment(home: string, nodeDirectory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home, CODEX_HOME: join(home, ".codex"), TMPDIR: home,
    PATH: join(nodeDirectory, "bin") + ":/usr/bin:/bin:/usr/sbin:/sbin",
    NPM_CONFIG_USERCONFIG: join(home, ".npmrc"), NPM_CONFIG_GLOBALCONFIG: join(home, "npm-global.conf"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]) if (process.env[key]) env[key] = process.env[key];
  return env;
}
async function command(commandPath: string, args: string[], options: HostProvisionOptions, env: NodeJS.ProcessEnv, timeout = 30_000): Promise<string> {
  checkSignal(options.signal);
  const child = (options.spawnProcess ?? spawn)(commandPath, args, { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
  let output = "", errors = "";
  child.stdout?.on("data", chunk => { output = (output + chunk).slice(-1_000_000); });
  child.stderr?.on("data", chunk => { errors = (errors + chunk).slice(-8192); });
  return await new Promise<string>((accept, reject) => {
    let failure: AgentError | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { try { child.kill(signal); } catch { /* The close event reconciles termination. */ } }
    };
    const stop = (error: AgentError) => {
      if (failure) return;
      failure = error; kill("SIGTERM");
      force = setTimeout(() => kill("SIGKILL"), 2000); force.unref();
    };
    const abort = () => stop(interrupted());
    const cancelTimeout = suspendAwareTimeout(() => stop(new AgentError("Host runtime preparation timed out.", "RUNTIME_TIMEOUT", true)), timeout);
    const cleanup = () => { cancelTimeout(); if (force) clearTimeout(force); options.signal?.removeEventListener("abort", abort); };
    child.once("error", error => { cleanup(); reject(new AgentError(error.message, "HOST_RUNTIME_COMMAND_FAILED")); });
    child.once("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new AgentError(errors.trim() || "Host runtime command exited with " + code + ".", "HOST_RUNTIME_COMMAND_FAILED"));
      else accept(output.trim());
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
async function cacheDirectory(root: string, create: boolean): Promise<string | undefined> {
  const cache = join(root, "host-codex");
  let created = false;
  if (!await plainDirectory(cache)) {
    if (!create) return undefined;
    try { await mkdir(cache, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await plainDirectory(cache);
  }
  if (created) await writeFile(join(cache, ownerFile), JSON.stringify(owner) + "\n", { mode: 0o600, flag: "wx" });
  const metadata = await json<typeof owner>(root, join(cache, ownerFile));
  if (metadata.schemaVersion !== owner.schemaVersion || metadata.kind !== owner.kind) throw ownership("The host runtime cache has no matching EnoughFactory ownership receipt.");
  return cache;
}
async function verify(cache: string, options: HostProvisionOptions): Promise<HostCodexRuntime | undefined> {
  checkSignal(options.signal);
  const paths = layout(cache), arch = architecture();
  if (!await plainDirectory(paths.directory)) return undefined;
  const receipt = await json<Receipt>(cache, join(paths.directory, receiptFile));
  if (receipt.schemaVersion !== 1 || receipt.kind !== "enoughfactory-host-codex" || receipt.platform !== "darwin" || receipt.architecture !== arch || receipt.nodeVersion !== RUNTIME_PINS.node || receipt.codexVersion !== RUNTIME_PINS.codex || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256)) throw ownership("The host Codex receipt does not match the pinned runtime.");
  const wrapper = await json<{ name: string; version: string; bin?: { codex?: string } }>(cache, join(paths.wrapperDirectory, "package.json"));
  const native = await json<{ name: string; version: string }>(cache, join(paths.nativeDirectory, "package.json"));
  if (wrapper.name !== "@openai/codex" || wrapper.version !== RUNTIME_PINS.codex || wrapper.bin?.codex !== "bin/codex.js" || native.name !== "@openai/codex" || native.version !== RUNTIME_PINS.codex + "-darwin-" + arch) throw ownership("The host Codex packages do not match the pinned native architecture.");
  for (const file of [paths.nodePath, paths.wrapperPath, paths.nativePath]) await regularFile(cache, file, true);
  await descendants(cache, paths.codexPath);
  const link = await stat(paths.codexPath);
  if (!link?.isSymbolicLink() || resolve(dirname(paths.codexPath), await readlink(paths.codexPath)) !== paths.wrapperPath) throw ownership("The host Codex executable link changed after preparation.");
  const hashes = await Promise.all([paths.nodePath, paths.wrapperPath, paths.nativePath].map(digest));
  if (hashes[0] !== receipt.nodeSha256 || hashes[1] !== receipt.wrapperSha256 || hashes[2] !== receipt.nativeSha256) throw ownership("The host Codex executable content changed after preparation.");
  const home = await mkdtemp(join(cache, ".verify-"));
  try {
    await chmod(home, 0o700);
    await mkdir(join(home, ".codex"), { mode: 0o700 });
    const env = privateEnvironment(home, paths.nodeDirectory);
    if (await command(paths.nodePath, ["--version"], options, env) !== "v" + RUNTIME_PINS.node) throw new AgentError("The host Node executable did not report its pinned version.", "RUNTIME_VERSION_MISMATCH");
    const version = await command(paths.codexPath, ["--version"], options, env);
    if (version !== "codex-cli " + RUNTIME_PINS.codex) throw new AgentError("The host Codex executable did not report its pinned version.", "RUNTIME_VERSION_MISMATCH");
    return { nodePath: paths.nodePath, codexPath: paths.codexPath, version, payloadDirectory: paths.directory };
  } finally { await rm(home, { recursive: true, force: true }); }
}

/** Missing is not ready; changed or unowned payloads are reported rather than overwritten or deleted. */
export async function hostCodexAvailability(options: HostProvisionOptions): Promise<HostCodexRuntime | undefined> {
  architecture(); checkSignal(options.signal);
  const root = await rootDirectory(options.runtimeDirectory, false);
  if (!root) return undefined;
  const cache = await cacheDirectory(root, false);
  return cache ? await verify(cache, options) : undefined;
}

async function install(root: string, options: HostProvisionOptions): Promise<HostCodexRuntime> {
  const cache = (await cacheDirectory(root, true))!;
  const ready = await verify(cache, options);
  if (ready) return ready;
  const stage = await mkdtemp(join(cache, ".prepare-"));
  await chmod(stage, 0o700);
  try {
    const arch = architecture(), home = join(stage, "home"), npmCache = join(stage, "npm-cache"), nodeDirectory = join(stage, "node");
    await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(npmCache, { mode: 0o700 }), mkdir(nodeDirectory, { mode: 0o700 })]);
    const filename = "node-v" + RUNTIME_PINS.node + "-darwin-" + arch + ".tar.gz", archive = join(stage, filename), sums = join(stage, "SHASUMS256.txt");
    const env = privateEnvironment(home, nodeDirectory);
    for (const [url, target] of [["https://nodejs.org/dist/v" + RUNTIME_PINS.node + "/" + filename, archive], ["https://nodejs.org/dist/v" + RUNTIME_PINS.node + "/SHASUMS256.txt", sums]]) await command("/usr/bin/curl", ["--fail", "--location", "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--output", target!, url!], options, env, 180_000);
    if ((await regularFile(cache, sums)).size > 65_536) throw ownership("The Node checksum index is too large.");
    await regularFile(cache, archive);
    const matches = (await readFile(sums, "utf8")).split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line)).filter(match => match?.[2] === filename);
    const archiveSha256 = await digest(archive);
    if (matches.length !== 1 || matches[0]![1] !== archiveSha256) throw new AgentError("The downloaded host Node archive failed its published checksum verification.", "RUNTIME_CHECKSUM_MISMATCH");
    checkSignal(options.signal);
    const entries = await command("/usr/bin/tar", ["-tzf", archive], options, env);
    const expectedRoot = filename.slice(0, -7);
    if (!entries || entries.split("\n").some(path => !path.startsWith(expectedRoot + "/") || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === ".."))) throw new AgentError("The host Node archive contains unexpected paths.", "RUNTIME_ARCHIVE_INVALID");
    await command("/usr/bin/tar", ["-xzf", archive, "--strip-components=1", "-C", nodeDirectory], options, env, 60_000);
    const nodePath = join(nodeDirectory, "bin/node");
    await regularFile(cache, nodePath, true);
    if (await command(nodePath, ["--version"], options, env) !== "v" + RUNTIME_PINS.node) throw new AgentError("The downloaded Node executable did not report its pinned version.", "RUNTIME_VERSION_MISMATCH");
    await command(nodePath, [join(nodeDirectory, "lib/node_modules/npm/bin/npm-cli.js"), "install", "--global", "--prefix", nodeDirectory, "--cache", npmCache, "--no-audit", "--no-fund", "--omit=optional", "--ignore-scripts", "@openai/codex@" + RUNTIME_PINS.codex, "@openai/codex-darwin-" + arch + "@npm:@openai/codex@" + RUNTIME_PINS.codex + "-darwin-" + arch], options, env, 300_000);
    const wrapper = join(nodeDirectory, "lib/node_modules/@openai/codex/bin/codex.js"), native = join(nodeDirectory, "lib/node_modules/@openai/codex-darwin-" + arch + "/vendor/" + (arch === "arm64" ? "aarch64" : "x86_64") + "-apple-darwin/bin/codex");
    for (const file of [wrapper, native]) await regularFile(cache, file, true);
    const receipt: Receipt = { schemaVersion: 1, kind: "enoughfactory-host-codex", platform: "darwin", architecture: arch, nodeVersion: RUNTIME_PINS.node, codexVersion: RUNTIME_PINS.codex, archiveSha256, nodeSha256: await digest(nodePath), wrapperSha256: await digest(wrapper), nativeSha256: await digest(native) };
    const probe = join(stage, "probe"); await mkdir(probe, { mode: 0o700 });
    const probePaths = layout(probe); await mkdir(probePaths.directory, { mode: 0o700 });
    await rename(nodeDirectory, join(probePaths.directory, "node"));
    await writeFile(join(probePaths.directory, receiptFile), JSON.stringify(receipt) + "\n", { mode: 0o600, flag: "wx" });
    // Actual native execution and metadata must both pass before publication.
    if (!await verify(probe, options)) throw new AgentError("The host Codex payload was not prepared.", "RUNTIME_MISSING");
    checkSignal(options.signal);
    try { await rename(probePaths.directory, layout(cache).directory); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // A second service may have won publication. Never replace its directory.
    }
    const result = await verify(cache, options);
    if (!result) throw new AgentError("Host Codex preparation did not retain its verified payload.", "RUNTIME_MISSING");
    return result;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/** Shared pinned binaries only. Session homes, credentials and chats have separate execution ownership. */
export async function provisionHostCodex(options: HostProvisionOptions): Promise<HostCodexRuntime> {
  architecture(); checkSignal(options.signal);
  const root = (await rootDirectory(options.runtimeDirectory, true))!;
  let operation = inFlight.get(root);
  if (!operation) {
    const controller = new AbortController();
    operation = { controller, waiters: 0, promise: install(root, { ...options, signal: controller.signal }) };
    inFlight.set(root, operation);
    const current = operation;
    void operation.promise.finally(() => { if (inFlight.get(root) === current) inFlight.delete(root); }).catch(() => {});
  }
  operation.waiters++;
  const selected = operation;
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(interrupted());
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    return await Promise.race([selected.promise, aborted]);
  } finally {
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    if (--selected.waiters === 0) {
      selected.controller.abort();
      // A canceled final owner waits for process exit and staging cleanup before it reports completion.
      if (options.signal?.aborted) await selected.promise.catch(() => {});
    }
  }
}
