import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { RuntimeKind } from '@enoughfactory/contracts';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { AGENT_RUNTIME_PATHS, runtimeInstallScript } from './provision.ts';
import { RUNTIME_PINS } from './types.ts';

export interface PreparedAgentToolchain {
  image: string;
  baseImage: string;
  runtime: RuntimeKind;
  platform: 'linux/arm64' | 'linux/amd64';
  recipeSha256: string;
  nodeVersion: string;
  providerVersion: string;
}
export interface AgentToolchainOptions { signal?: AbortSignal; onProgress?: (message: string) => void; }
interface RunOptions { signal?: AbortSignal; timeoutMs?: number; }
export type AgentToolchainRunner = (endpoint: DockerRuntimeEndpoint, args: readonly string[], options: RunOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
interface Image { Id: string; Architecture: string; Os: string; Config?: { Labels?: Record<string, string> }; }
export const AGENT_TOOLCHAIN_LABELS = Object.freeze({ managed: 'enoughfactory.managed', recipe: 'enoughfactory.agent-toolchain.recipe', base: 'enoughfactory.agent-toolchain.base', runtime: 'enoughfactory.agent-toolchain.runtime', node: 'enoughfactory.agent-toolchain.node', provider: 'enoughfactory.agent-toolchain.provider' });
const imageId = /^sha256:[a-f0-9]{64}$/;
function version(runtime: RuntimeKind): string {
  if (runtime === 'codex') return RUNTIME_PINS.codex;
  if (runtime === 'claude') return RUNTIME_PINS.claude;
  if (runtime === 'antigravity') return RUNTIME_PINS.antigravitySdk;
  throw new Error('Unsupported agent runtime.');
}
function platform(value: string): PreparedAgentToolchain['platform'] {
  if (['arm64', 'aarch64'].includes(value)) return 'linux/arm64';
  if (['amd64', 'x86_64'].includes(value)) return 'linux/amd64';
  throw new Error('The private agent toolchain requires Linux arm64 or amd64.');
}
const verificationScript = (runtime: RuntimeKind) => `${AGENT_RUNTIME_PATHS}
set -eu
[ "$(/opt/enoughfactory/node/bin/node --version)" = 'v${RUNTIME_PINS.node}' ]
verification_home=$(mktemp -d)
trap 'rm -rf -- "$verification_home"' EXIT
export HOME="$verification_home" CODEX_HOME="$verification_home/.codex" CLAUDE_CONFIG_DIR="$verification_home/.claude"
${runtime === 'antigravity' ? `/opt/enoughfactory/antigravity/bin/python -c 'import importlib.metadata; assert importlib.metadata.version("google-antigravity") == "${RUNTIME_PINS.antigravitySdk}"'` : `actual=$(${runtime} --version)
printf '%s\\n' "$actual" | grep -Eq '(^|[[:space:]])${version(runtime).replaceAll('.', '\\.')}($|[[:space:]]|\\()'`}
`;

/** Only an immutable clean image is input; session containers and auth are never committed. */
export function agentToolchainRecipe(baseImage: string, runtime: RuntimeKind, selectedPlatform: PreparedAgentToolchain['platform']) {
  if (!imageId.test(baseImage)) throw new Error('Agent toolchains require an immutable base image ID.');
  const installScript = runtimeInstallScript(runtime);
  const verifyScript = verificationScript(runtime);
  const recipeSha256 = createHash('sha256').update(JSON.stringify({ schemaVersion: 1, baseImage, runtime, platform: selectedPlatform, nodeVersion: RUNTIME_PINS.node, providerVersion: version(runtime), installScript, verifyScript })).digest('hex');
  const receipt = { schemaVersion: 1, baseImage, runtime, platform: selectedPlatform, recipeSha256, nodeVersion: RUNTIME_PINS.node, providerVersion: version(runtime) };
  const dockerfile = `FROM ${baseImage}\nCOPY install.sh verify.sh /tmp/enoughfactory-agent-image/\nRUN sh /tmp/enoughfactory-agent-image/install.sh && sh /tmp/enoughfactory-agent-image/verify.sh && rm -rf /tmp/enoughfactory-agent-image\nRUN printf '%s\\n' 'export PATH=/opt/enoughfactory/node/bin:/root/.local/bin:$PATH' > /etc/profile.d/enoughfactory-agent-tools.sh\nCOPY image-toolchain.json /opt/enoughfactory/agents/image-toolchain.json\nENV PATH=/opt/enoughfactory/node/bin:/root/.local/bin:$PATH\n`;
  return { recipeSha256, receipt, dockerfile, installScript, verifyScript };
}
async function inspect(endpoint: DockerRuntimeEndpoint, ref: string, run: AgentToolchainRunner, options: AgentToolchainOptions): Promise<Image | undefined> {
  const result = await run(endpoint, ['image', 'inspect', ref], { signal: options.signal, timeoutMs: 30_000 });
  if (result.code) {
    if (/no such image|image .* not found/i.test(result.stderr)) return undefined;
    throw new Error(result.stderr.trim() || 'The private agent image could not be inspected.');
  }
  const images: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(images) || images.length !== 1) throw new Error('Docker returned ambiguous agent image metadata.');
  return images[0] as Image;
}
function metadata(image: Image, baseImage: string, runtime: RuntimeKind, selectedPlatform: PreparedAgentToolchain['platform']): PreparedAgentToolchain {
  const recipe = agentToolchainRecipe(baseImage, runtime, selectedPlatform), labels = image.Config?.Labels;
  const expected = { [AGENT_TOOLCHAIN_LABELS.managed]: 'true', [AGENT_TOOLCHAIN_LABELS.recipe]: recipe.recipeSha256, [AGENT_TOOLCHAIN_LABELS.base]: baseImage, [AGENT_TOOLCHAIN_LABELS.runtime]: runtime, [AGENT_TOOLCHAIN_LABELS.node]: RUNTIME_PINS.node, [AGENT_TOOLCHAIN_LABELS.provider]: version(runtime) };
  if (!imageId.test(image.Id) || image.Os !== 'linux' || platform(image.Architecture) !== selectedPlatform || !Object.entries(expected).every(([key, value]) => labels?.[key] === value)) throw new Error('The cached agent image does not match its immutable base, architecture and pinned tools.');
  return { image: image.Id, baseImage, runtime, platform: selectedPlatform, recipeSha256: recipe.recipeSha256, nodeVersion: RUNTIME_PINS.node, providerVersion: version(runtime) };
}
export async function verifyPreparedAgentToolchain(endpoint: DockerRuntimeEndpoint, value: PreparedAgentToolchain, options: AgentToolchainOptions = {}): Promise<PreparedAgentToolchain> {
  if (!value || !imageId.test(value.image) || !imageId.test(value.baseImage)) throw new Error('A saved immutable agent toolchain is required.');
  const image = await inspect(endpoint, value.image, runDocker, options);
  if (!image) throw new Error('This session’s pinned agent image is missing. Its source and history were retained.');
  const actual = metadata(image, value.baseImage, value.runtime, value.platform);
  if (actual.image !== value.image || actual.recipeSha256 !== value.recipeSha256 || actual.nodeVersion !== value.nodeVersion || actual.providerVersion !== value.providerVersion) throw new Error('The saved agent toolchain does not match the pinned runtime recipe.');
  return actual;
}
const preparations = new Map<string, Promise<PreparedAgentToolchain>>();
const verified = new Set<string>();
export async function prepareAgentToolchain(endpoint: DockerRuntimeEndpoint, baseImage: string, runtime: RuntimeKind, options: AgentToolchainOptions = {}): Promise<PreparedAgentToolchain> {
  return prepareAgentToolchainWith(endpoint, baseImage, runtime, options, runDocker);
}
/** A small runner seam keeps cache, ownership and cancellation checks independent of Docker. */
export async function prepareAgentToolchainWith(endpoint: DockerRuntimeEndpoint, baseImage: string, runtime: RuntimeKind, options: AgentToolchainOptions, run: AgentToolchainRunner): Promise<PreparedAgentToolchain> {
  dockerInvocation(endpoint, []); if (!imageId.test(baseImage)) throw new Error('Agent toolchains require an immutable base image ID.'); options.signal?.throwIfAborted();
  const key = `${endpoint.host}\0${baseImage}\0${runtime}\0${RUNTIME_PINS.node}\0${version(runtime)}`;
  const active = preparations.get(key); if (active) { const image = await active; options.signal?.throwIfAborted(); return image; }
  const operation = prepareOwned(endpoint, baseImage, runtime, options, run); preparations.set(key, operation);
  try { const image = await operation; options.signal?.throwIfAborted(); return image; } finally { preparations.delete(key); }
}
async function prepareOwned(endpoint: DockerRuntimeEndpoint, baseImage: string, runtime: RuntimeKind, options: AgentToolchainOptions, run: AgentToolchainRunner): Promise<PreparedAgentToolchain> {
  options.onProgress?.('Checking reusable agent tools');
  const infoResult = await run(endpoint, ['info', '--format', '{{json .}}'], { signal: options.signal, timeoutMs: 30_000 });
  if (infoResult.code) throw new Error(infoResult.stderr.trim() || 'The private container engine is unavailable.');
  const info = JSON.parse(infoResult.stdout) as { OSType: string; Architecture: string; Labels?: string[] };
  const owner = createHash('sha256').update(resolve(dirname(dirname(endpoint.configDirectory)))).digest('hex').slice(0, 24);
  if (info.OSType !== 'linux' || !info.Labels?.includes('enoughfactory.managed=true') || !info.Labels.includes(`enoughfactory.owner=${owner}`)) throw new Error('Agent images require this EnoughFactory installation’s private container engine.');
  const selectedPlatform = platform(info.Architecture), base = await inspect(endpoint, baseImage, run, options);
  if (!base || base.Id !== baseImage || base.Os !== 'linux' || platform(base.Architecture) !== selectedPlatform) throw new Error('The selected clean base image is missing or has a different architecture.');
  const recipe = agentToolchainRecipe(baseImage, runtime, selectedPlatform), tag = `enoughfactory-agent-tools:${runtime}-${recipe.recipeSha256.slice(0, 32)}`;
  let image = await inspect(endpoint, tag, run, options);
  if (!image) {
    const context = await mkdtemp(join(tmpdir(), 'enoughfactory-agent-image-'));
    try {
      await Promise.all([writeFile(join(context, 'Dockerfile'), recipe.dockerfile, { mode: 0o600 }), writeFile(join(context, 'install.sh'), recipe.installScript, { mode: 0o600 }), writeFile(join(context, 'verify.sh'), recipe.verifyScript, { mode: 0o600 }), writeFile(join(context, 'image-toolchain.json'), JSON.stringify(recipe.receipt)+'\n', { mode: 0o600 })]);
      options.onProgress?.(`Preparing shared Node and ${runtime} tools; later environments reuse this image`);
      const labels = { [AGENT_TOOLCHAIN_LABELS.managed]: 'true', [AGENT_TOOLCHAIN_LABELS.recipe]: recipe.recipeSha256, [AGENT_TOOLCHAIN_LABELS.base]: baseImage, [AGENT_TOOLCHAIN_LABELS.runtime]: runtime, [AGENT_TOOLCHAIN_LABELS.node]: RUNTIME_PINS.node, [AGENT_TOOLCHAIN_LABELS.provider]: version(runtime) };
      const args = ['build', '--pull=false', '--platform', selectedPlatform, '--tag', tag, ...Object.entries(labels).flatMap(([key,value]) => ['--label', `${key}=${value}`]), context];
      const result = await run(endpoint, args, { signal: options.signal, timeoutMs: 15 * 60_000 });
      if (result.code) throw new Error(result.stderr.trim() || result.stdout.trim() || 'The reusable agent image could not be prepared.');
    } finally { await rm(context, { recursive: true, force: true }); }
    image = await inspect(endpoint, tag, run, options);
  }
  if (!image) throw new Error('Docker did not retain the reusable agent image.');
  const result = metadata(image, baseImage, runtime, selectedPlatform), key = `${endpoint.host}\0${result.image}`;
  if (!verified.has(key)) {
    options.onProgress?.('Verifying pinned agent tools without network or credentials');
    const name = `enough-agent-tools-probe-${randomUUID()}`;
    try {
      const probe = await run(endpoint, ['run', '--rm', '--name', name, '--network', 'none', '--user', '0:0', '--entrypoint', '/bin/bash', result.image, '-lc', verificationScript(runtime)], { signal: options.signal, timeoutMs: 60_000 });
      if (probe.code) throw new Error(probe.stderr.trim() || probe.stdout.trim() || 'The cached agent tools did not pass their pinned version check.');
    } finally {
      const cleanup = await run(endpoint, ['rm', '--force', name], { timeoutMs: 30_000 });
      if (cleanup.code && !/no such container/i.test(cleanup.stderr)) throw new Error('The disposable agent image probe could not be confirmed stopped.');
    }
    verified.add(key);
  }
  options.onProgress?.('Shared agent tools are ready'); return result;
}
async function runDocker(endpoint: DockerRuntimeEndpoint, args: readonly string[], options: RunOptions) {
  const invocation = dockerInvocation(endpoint, args); options.signal?.throwIfAborted();
  return await new Promise<{ code: number; stdout: string; stderr: string }>((accept,reject) => {
    const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ['ignore','pipe','pipe'] }); let stdout='',stderr='',failure:Error|undefined,force:ReturnType<typeof setTimeout>|undefined;
    const stop=(error:Error)=>{if(failure)return;failure=error;child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),2000);force.unref();};const abort=()=>stop(new Error('Agent image preparation was canceled.'));const timer=setTimeout(()=>stop(new Error('Agent image preparation exceeded its deadline.')),options.timeoutMs??30_000);options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    child.stdout.on('data',chunk=>{stdout=(stdout+chunk).slice(-200_000);});child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-20_000);});const clean=()=>{clearTimeout(timer);if(force)clearTimeout(force);options.signal?.removeEventListener('abort',abort);};child.once('error',error=>{clean();reject(error);});child.once('close',code=>{clean();if(failure)reject(failure);else accept({code:code??1,stdout,stderr});});
  });
}
