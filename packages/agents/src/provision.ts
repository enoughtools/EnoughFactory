import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeCapability, RuntimeKind } from "@enoughfactory/contracts";
import type { DockerRuntimeEndpoint } from "@enoughfactory/runtime";
import { AgentError, RUNTIME_PINS, type ProvisionOptions } from "./types.ts";
import { containerCommand, quote, type SpawnProcess } from "./process.ts";

export interface RuntimeOptions { dockerEndpoint?: DockerRuntimeEndpoint; spawnProcess?: SpawnProcess; runtimeAssetsDir?: string; }
const assetsDirectory = fileURLToPath(new URL("../../../runtime/agents/", import.meta.url));
const paths = `export PATH=/opt/enoughfactory/node/bin:/root/.local/bin:$PATH; export HOME=/root;`;
export async function availability(containerId: string, options: RuntimeOptions = {}): Promise<RuntimeCapability[]> {
  const query = `${paths}
for runtime in codex claude agy; do
  if command -v "$runtime" >/dev/null 2>&1; then printf '%s\\t' "$runtime"; "$runtime" --version 2>/dev/null | head -1; else printf '%s\\t\\n' "$runtime"; fi
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
if [ ! -x /opt/enoughfactory/node/bin/node ]; then
  if ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then
    if ! command -v apt-get >/dev/null 2>&1; then echo 'Node provisioning needs curl, xz and glibc.' >&2; exit 1; fi
    apt-get update -qq; apt-get install -y -qq curl ca-certificates xz-utils
  fi
  case "$(uname -m)" in x86_64) architecture=x64;; aarch64|arm64) architecture=arm64;; *) echo 'Unsupported Linux runtime architecture.' >&2; exit 1;; esac
  filename="node-v${RUNTIME_PINS.node}-linux-$architecture.tar.xz"
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  curl -fLsS "https://nodejs.org/dist/v${RUNTIME_PINS.node}/$filename" -o "$stage/$filename"
  curl -fLsS "https://nodejs.org/dist/v${RUNTIME_PINS.node}/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
  (cd "$stage"; awk -v file="$filename" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/enoughfactory/node
  tar -xJf "$stage/$filename" --strip-components=1 -C /opt/enoughfactory/node
fi
npm install --global --prefix /opt/enoughfactory/node --no-audit --no-fund '${runtime === "codex" ? `@openai/codex@${RUNTIME_PINS.codex}` : `@anthropic-ai/claude-code@${RUNTIME_PINS.claude}`}'
`;
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
  if (!before.available || !before.version?.includes(desired) || runtime === "antigravity" && !before.interactiveApprovals) {
    await containerCommand(containerId, ["sh", "-s"], { ...options, input: installScript(runtime), timeout: 300_000 });
  }
  if (runtime === "antigravity") {
    const script = await readFile(resolve(options.runtimeAssetsDir ?? assetsDirectory, "antigravity_bridge.py"));
    await writePrivateFile(containerId, "/opt/enoughfactory/agents/antigravity_bridge.py", script, options);
  }
  if (provision.copyHostAuth) await copyMinimalAuth(containerId, runtime, provision, options);
  const result = (await availability(containerId, options)).find((entry) => entry.kind === runtime)!;
  if (!result.available) throw new AgentError(`The ${runtime} runtime was not installed successfully.`, "RUNTIME_MISSING");
  return result;
}
