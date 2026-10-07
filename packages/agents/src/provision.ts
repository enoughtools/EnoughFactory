import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeCapability, RuntimeKind } from "@enoughfactory/contracts";
import type { DockerRuntimeEndpoint } from "@enoughfactory/runtime";
import { AgentError, RUNTIME_PINS, type ProvisionOptions } from "./types.ts";
import { containerCommand, quote, type SpawnProcess } from "./process.ts";

export interface RuntimeOptions { dockerEndpoint?: DockerRuntimeEndpoint; spawnProcess?: SpawnProcess; runtimeAssetsDir?: string; signal?: AbortSignal; }
const assetsDirectory = fileURLToPath(new URL("../../../runtime/agents/", import.meta.url));
const paths = `export PATH=/opt/enoughfactory/node/bin:/root/.local/bin:$PATH; export HOME=/root;`;
export async function availability(containerId: string, options: RuntimeOptions = {}): Promise<RuntimeCapability[]> {
  const query = `${paths}
for runtime in codex claude agy; do
  runtime_version=''
  if command -v "$runtime" >/dev/null 2>&1; then runtime_version=$("$runtime" --version 2>/dev/null | head -1); fi
  printf '%s\\t%s\\n' "$runtime" "$runtime_version"
done
if [ -x /opt/enoughfactory/antigravity/bin/python ]; then printf 'sdk\\t'; /opt/enoughfactory/antigravity/bin/python -c 'import importlib.metadata; print(importlib.metadata.version("google-antigravity"))'; else printf 'sdk\\t\\n'; fi`;
  const output = await containerCommand(containerId, ["sh", "-c", query], { ...options, timeout: 30_000 });
  const values = new Map(output.split("\n").map((line) => { const [key, ...parts] = line.split("\t"); return [key, parts.join("\t")] as const; }));
  return [
    { kind: "codex", available: !!values.get("codex"), version: values.get("codex") || undefined, fullAccess: true, interactiveApprovals: !!values.get("codex")?.includes(RUNTIME_PINS.codex), resume: true, details: "App-server typed requests when raised; full access does not intercept every effect." },
    { kind: "antigravity", available: !!values.get("sdk") || !!values.get("agy"), version: values.get("sdk") ? `SDK ${values.get("sdk")}` : values.get("agy") || undefined, fullAccess: true, interactiveApprovals: values.get("sdk") === RUNTIME_PINS.antigravitySdk, resume: !!values.get("sdk") || !!values.get("agy"), details: values.get("sdk") ? "Tool policy callbacks; effects inside an allowed command are not separate callbacks." : "CLI supports approve all. Provision the SDK for rules/manual policy." },
    { kind: "claude", available: !!values.get("claude"), version: values.get("claude") || undefined, fullAccess: true, interactiveApprovals: false, resume: true, details: "Headless skip-permissions compatibility; selective approvals are unsupported." },
  ];
}

function installScript(runtime: RuntimeKind): string {
  const common = `set -eu
${paths}
if ! command -v setsid >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then echo 'Runtime provisioning requires setsid (util-linux).' >&2; exit 1; fi
  apt-get update -qq; apt-get install -y -qq util-linux
fi
mkdir -p /opt/enoughfactory/agents
`;
  if (runtime === "antigravity") return `${common}
if ! command -v python3 >/dev/null 2>&1 || ! python3 -m venv --help >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then echo 'Antigravity needs Python 3.10+ and venv.' >&2; exit 1; fi
  apt-get update -qq; apt-get install -y -qq python3 python3-venv ca-certificates
fi
if [ ! -x /opt/enoughfactory/antigravity/bin/python ]; then python3 -m venv /opt/enoughfactory/antigravity; fi
/opt/enoughfactory/antigravity/bin/python -m pip install --disable-pip-version-check --quiet 'google-antigravity==${RUNTIME_PINS.antigravitySdk}'
`;
  return `${common}
node_stage=''
npm_cache=''
receipt_stage=''
cleanup_provisioning() {
  cleanup_status=$?
  trap - EXIT
  if [ -n "$node_stage" ]; then rm -rf -- "$node_stage" || cleanup_status=1; fi
  if [ -n "$npm_cache" ]; then rm -rf -- "$npm_cache" || cleanup_status=1; fi
  if [ -n "$receipt_stage" ]; then rm -f -- "$receipt_stage" || cleanup_status=1; fi
  exit "$cleanup_status"
}
trap cleanup_provisioning EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ ! -x /opt/enoughfactory/node/bin/node ]; then
  if ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
    if ! command -v apt-get >/dev/null 2>&1; then echo 'Node provisioning needs curl, xz and glibc.' >&2; exit 1; fi
    apt-get update -qq; apt-get install -y -qq curl ca-certificates xz-utils
  fi
  case "$(uname -m)" in x86_64) architecture=x64;; aarch64|arm64) architecture=arm64;; *) echo 'Unsupported Linux runtime architecture.' >&2; exit 1;; esac
  filename="node-v${RUNTIME_PINS.node}-linux-$architecture.tar.xz"
  node_stage=$(mktemp -d)
  curl -fLsS "https://nodejs.org/dist/v${RUNTIME_PINS.node}/$filename" -o "$node_stage/$filename"
  curl -fLsS "https://nodejs.org/dist/v${RUNTIME_PINS.node}/SHASUMS256.txt" -o "$node_stage/SHASUMS256.txt"
  (cd "$node_stage"; awk -v file="$filename" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/enoughfactory/node
  tar -xJf "$node_stage/$filename" --strip-components=1 -C /opt/enoughfactory/node
fi
${runtime === "codex" ? `case "$(uname -m)" in
  x86_64) native_platform=x64;;
  aarch64|arm64) native_platform=arm64;;
  *) echo 'Unsupported Linux Codex architecture; expected x86_64, aarch64 or arm64.' >&2; exit 1;;
esac
native_alias="@openai/codex-linux-$native_platform"
native_version="${RUNTIME_PINS.codex}-linux-$native_platform"
native_package="$native_alias@npm:@openai/codex@$native_version"` : ""}
npm_cache=$(mktemp -d "\${TMPDIR:-/tmp}/enoughfactory-npm.XXXXXXXX")
npm install --global --prefix /opt/enoughfactory/node --cache "$npm_cache" --no-audit --no-fund${runtime === "codex" ? " --omit=optional" : ""} '${runtime === "codex" ? `@openai/codex@${RUNTIME_PINS.codex}` : `@anthropic-ai/claude-code@${RUNTIME_PINS.claude}`}'${runtime === "codex" ? ' "$native_package"' : ""}
${runtime === "codex" ? `receipt_stage=$(mktemp /opt/enoughfactory/agents/.codex-install.XXXXXXXX)
printf '{"schemaVersion":1,"runtime":"codex","wrapperVersion":"${RUNTIME_PINS.codex}","nativeAlias":"%s","nativeVersion":"%s"}\\n' "$native_alias" "$native_version" > "$receipt_stage"
chmod 600 "$receipt_stage"
mv -f -- "$receipt_stage" /opt/enoughfactory/agents/codex-install.json
receipt_stage=''` : ""}
`;
}

export interface CodexPayloadRelease { status: "released" | "deferred"; reason?: string; }

/** Discard only app-provisioned payload locations with matching metadata; retain provider state. */
export async function releaseCodexPayload(containerId: string, options: RuntimeOptions = {}): Promise<CodexPayloadRelease> {
  const script = `
const fs = require('node:fs'), path = require('node:path');
const prefix = '/opt/enoughfactory/node';
const receiptPath = '/opt/enoughfactory/agents/codex-install.json';
const wrapper = prefix + '/lib/node_modules/@openai/codex';
const link = prefix + '/bin/codex';
function defer(reason) { console.log(JSON.stringify({ status: 'deferred', reason })); process.exit(0); }
function stat(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function directory(filename) {
  const value = stat(filename);
  if (value && (!value.isDirectory() || value.isSymbolicLink())) defer('A runtime path is no longer a plain directory.');
  return !!value;
}
function ancestors(filename) {
  const parts = path.dirname(filename).split('/').filter(Boolean);
  let current = '';
  for (const part of parts) { current += '/' + part; directory(current); }
}
function json(filename, limit = 65536) {
  const value = stat(filename);
  if (!value || !value.isFile() || value.isSymbolicLink() || value.size > limit) defer('Runtime ownership metadata is missing or changed.');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { defer('Runtime ownership metadata is unreadable.'); }
}
let native;
try {
  ancestors(receiptPath);
  if (!stat(receiptPath)) defer('This Codex installation has no app ownership receipt.');
  const receipt = json(receiptPath, 4096);
  const platform = receipt.nativeAlias === '@openai/codex-linux-arm64' ? 'arm64' : receipt.nativeAlias === '@openai/codex-linux-x64' ? 'x64' : undefined;
  if (receipt.schemaVersion !== 1 || receipt.runtime !== 'codex' || receipt.wrapperVersion !== '${RUNTIME_PINS.codex}' || !platform || receipt.nativeVersion !== '${RUNTIME_PINS.codex}-linux-' + platform) defer('The Codex ownership receipt does not match the pinned runtime.');
  native = prefix + '/lib/node_modules/' + receipt.nativeAlias;
  for (const filename of [wrapper, native, link]) ancestors(filename);
  if (directory(wrapper)) {
    const metadata = json(wrapper + '/package.json');
    if (metadata.name !== '@openai/codex' || metadata.version !== receipt.wrapperVersion || metadata.bin?.codex !== 'bin/codex.js') defer('The Codex wrapper has changed since provisioning.');
    ancestors(wrapper + '/bin/codex.js');
    const entry = stat(wrapper + '/bin/codex.js');
    if (!entry?.isFile() || entry.isSymbolicLink()) defer('The Codex wrapper entry point has changed.');
  }
  if (directory(native)) {
    const metadata = json(native + '/package.json');
    if (metadata.name !== '@openai/codex' || metadata.version !== receipt.nativeVersion) defer('The Codex native package has changed since provisioning.');
  }
  const entry = stat(link);
  if (entry && (!entry.isSymbolicLink() || path.resolve(path.dirname(link), fs.readlinkSync(link)) !== wrapper + '/bin/codex.js')) defer('The Codex executable link has changed since provisioning.');
  const processes = fs.readdirSync('/proc').filter(value => /^[0-9]+$/.test(value));
  if (processes.length > 4096) defer('Container process state is too large to verify safely.');
  const payloadPath = value => [wrapper, native, link].some(root => value === root || value.startsWith(root + '/'));
  for (const pid of processes) {
    if (pid === String(process.pid)) continue;
    try {
      let executable = '';
      try { executable = fs.readlinkSync('/proc/' + pid + '/exe').replace(/ \\(deleted\\)$/, ''); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      if (payloadPath(executable)) defer('A Codex process is still using this payload.');
      const descriptor = fs.openSync('/proc/' + pid + '/cmdline', 'r');
      const bytes = Buffer.alloc(65536);
      let count;
      try { count = fs.readSync(descriptor, bytes, 0, bytes.length, 0); } finally { fs.closeSync(descriptor); }
      if (count === bytes.length) defer('A container command line could not be fully inspected.');
      const arguments_ = bytes.subarray(0, count).toString('utf8').split('\\0');
      if (arguments_.some(value => payloadPath(value) || ['codex', 'codex.js'].includes(path.basename(value)))) defer('A Codex wrapper or native process is still active.');
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') defer('Container process state could not be verified.');
    }
  }
} catch { defer('Codex payload ownership or container process state could not be verified.'); }
// Validate every target before deleting any. Keep the tiny receipt for retry and inspection.
if (stat(link)) fs.unlinkSync(link);
fs.rmSync(wrapper, { recursive: true, force: true });
fs.rmSync(native, { recursive: true, force: true });
console.log(JSON.stringify({ status: 'released' }));
`;
  const output = await containerCommand(containerId, ["/opt/enoughfactory/node/bin/node", "--input-type=commonjs", "-e", script], { ...options, timeout: 30_000 });
  const result = JSON.parse(output) as CodexPayloadRelease;
  if (result.status !== "released" && result.status !== "deferred") throw new AgentError("Codex payload cleanup did not confirm its outcome.", "RUNTIME_CLEANUP_UNKNOWN");
  return result;
}

function hasPinnedVersion(capability: RuntimeCapability, desired: string): boolean {
  return !!capability.version && new RegExp(`(?:^|\\s)${desired.replaceAll(".", "\\.")}(?=$|\\s|\\()`).test(capability.version);
}

export async function writePrivateFile(containerId: string, path: string, content: string | Buffer, options: RuntimeOptions = {}): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  await containerCommand(containerId, ["sh", "-c", `umask 077; mkdir -p ${quote(parent)}; cat > ${quote(path)}; chmod 600 ${quote(path)}`], { ...options, input: content });
}

/** Host credentials are copied only after explicit selection; no transcripts, config or keychain dump. */
export async function copyMinimalAuth(containerId: string, runtime: RuntimeKind, provision: ProvisionOptions, options: RuntimeOptions = {}): Promise<{ copied: string[] }> {
  const hostDirectory = provision.hostAuthDir ?? homedir();
  const entries: [string, string][] = runtime === "codex" ? [[".codex/auth.json", "/root/.codex/auth.json"]]
    : runtime === "claude" ? [[".claude/.credentials.json", "/root/.claude/.credentials.json"]]
    : [[".config/gcloud/application_default_credentials.json", "/root/.config/gcloud/application_default_credentials.json"]];
  const copied: string[] = [];
  for (const [source, destination] of entries) {
    const file = resolve(hostDirectory, source);
    try { await access(file); } catch { continue; }
    await writePrivateFile(containerId, destination, await readFile(file), options);
    copied.push(source);
  }
  return { copied };
}

export async function provisionRuntime(containerId: string, runtime: RuntimeKind, provision: ProvisionOptions = {}, options: RuntimeOptions = {}): Promise<RuntimeCapability> {
  const before = (await availability(containerId, options)).find((entry) => entry.kind === runtime)!;
  const desired = runtime === "codex" ? RUNTIME_PINS.codex : runtime === "claude" ? RUNTIME_PINS.claude : RUNTIME_PINS.antigravitySdk;
  if (!before.available || !hasPinnedVersion(before, desired) || runtime === "antigravity" && !before.interactiveApprovals) {
    await containerCommand(containerId, ["sh", "-s"], { ...options, input: installScript(runtime), timeout: 300_000 });
  }
  if (runtime === "antigravity") {
    const script = await readFile(resolve(options.runtimeAssetsDir ?? assetsDirectory, "antigravity_bridge.py"));
    await writePrivateFile(containerId, "/opt/enoughfactory/agents/antigravity_bridge.py", script, options);
  }
  let result = (await availability(containerId, options)).find((entry) => entry.kind === runtime)!;
  if (runtime === "codex") {
    // npm can succeed with only the JavaScript wrapper. Probe the real executable
    // without a pipeline masking its status, before forwarding any credentials.
    let version: string;
    try { version = await containerCommand(containerId, ["sh", "-c", `${paths} exec codex --version`], { ...options, timeout: 30_000 }); }
    catch (error) {
      if (!(error instanceof AgentError) || error.code !== "CONTAINER_COMMAND_FAILED") throw error;
      const detail = error.message.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").slice(-2048);
      throw new AgentError(`Codex ${desired} native executable verification failed: ${detail}`, "RUNTIME_MISSING");
    }
    result = { ...result, available: !!version, version: version || undefined, interactiveApprovals: hasPinnedVersion({ ...result, version }, desired) };
  }
  if (!result.available) throw new AgentError(`The ${runtime} runtime was not installed successfully.`, "RUNTIME_MISSING");
  if (!hasPinnedVersion(result, desired) || runtime === "antigravity" && !result.interactiveApprovals) throw new AgentError(`The ${runtime} runtime did not report the required version ${desired}.`, "RUNTIME_VERSION_MISMATCH");
  if (provision.copyHostAuth) await copyMinimalAuth(containerId, runtime, provision, options);
  return result;
}
