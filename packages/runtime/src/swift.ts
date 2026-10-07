import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerInvocation } from './docker.ts';
import type { DockerRuntimeEndpoint } from './types.ts';

export type ToolchainProfileId = 'swift-6.0.3';
export interface PreparedToolchain {
  id: ToolchainProfileId;
  recipeSha256: string;
  /** An immutable image ID on this particular owned Docker runtime. */
  image: string;
  baseImage: string;
  platform: 'linux/arm64' | 'linux/amd64';
  swiftVersion: string;
  nodeVersion: string;
}
export interface ToolchainPreparationOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

const baseImage = 'swift:6.0.3-noble@sha256:fc2fe3b78e138702f0d69fcf1420372eb044194450c8eb6ba778ab1c87ff7b1b';
const nodeArchives = {
  arm64: '25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be',
  x64: 'c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744',
};

// Derived from the pinned MIT-licensed envmux images/golden/envmux-init. Host
// keys stay on the private session volume, never in this clean toolchain image.
const init = [
  '#!/bin/sh', 'set -u', 'keys=${ENVMUX_HOST_KEYS:-/home/.envmux/ssh}',
  'if [ "${ENVMUX_SSHD:-1}" != "0" ] && [ "$(id -u)" = "0" ]; then',
  '  mkdir -p "$keys" /run/sshd /var/log/envmux',
  '  chmod 0755 "$(dirname "$keys")"; chmod 0700 "$keys"',
  '  for type in ed25519 rsa; do',
  '    [ -s "$keys/ssh_host_${type}_key" ] || ssh-keygen -q -t "$type" -N "" -C envmux -f "$keys/ssh_host_${type}_key"',
  '  done',
  '  /usr/sbin/sshd -h "$keys/ssh_host_ed25519_key" -h "$keys/ssh_host_rsa_key" -E /var/log/envmux/sshd.log',
  'fi',
  "trap 'exit 0' TERM INT", 'while :; do sleep 86400 & wait $!; done', '',
].join('\n');

const dockerfile = `FROM ${baseImage}
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eu; apt-get update -qq; apt-get install -y -qq --no-install-recommends tmux openssh-server ca-certificates curl git sudo less rsync procps util-linux bash socat; apt-get clean; rm -rf /var/lib/apt/lists/*; rm -f /etc/ssh/ssh_host_*; mkdir -p /var/log/envmux; chmod 1777 /var/log/envmux
RUN set -eu; case "$(uname -m)" in aarch64|arm64) arch=arm64; checksum=${nodeArchives.arm64};; x86_64) arch=x64; checksum=${nodeArchives.x64};; *) echo 'Unsupported Swift toolchain architecture' >&2; exit 1;; esac; stage=$(mktemp -d); filename="node-v22.22.0-linux-$arch.tar.gz"; curl -fLsS "https://nodejs.org/dist/v22.22.0/$filename" -o "$stage/node.tar.gz"; printf '%s  %s\\n' "$checksum" "$stage/node.tar.gz" | sha256sum -c -; mkdir -p /opt/enoughfactory/node; tar -xzf "$stage/node.tar.gz" --strip-components=1 -C /opt/enoughfactory/node; for tool in node npm npx; do ln -s /opt/enoughfactory/node/bin/$tool /usr/local/bin/$tool; done; rm -rf "$stage"
RUN printf '%s\\n' 'export PATH=/opt/enoughfactory/node/bin:/usr/local/swift/usr/bin:/usr/local/bin:/usr/bin:$PATH' > /etc/profile.d/enoughfactory-toolchains.sh
COPY envmux-init /usr/local/bin/envmux-init
RUN chmod 0755 /usr/local/bin/envmux-init; node --version; swift --version
CMD ["/usr/local/bin/envmux-init"]
`;

const recipeSha256 = createHash('sha256').update(JSON.stringify({ formatVersion: 1, id: 'swift-6.0.3', baseImage, nodeArchives, dockerfile, init })).digest('hex');
export const SWIFT_TOOLCHAIN = Object.freeze({ id: 'swift-6.0.3' as const, label: 'Swift 6.0.3 and Node 22.22.0', recipeSha256, baseImage, swiftVersion: '6.0.3', nodeVersion: '22.22.0', platforms: ['linux/arm64', 'linux/amd64'] as const });
export const TOOLCHAIN_IMAGE_LABELS = Object.freeze({ id: 'enoughfactory.toolchain.id', recipe: 'enoughfactory.toolchain.recipe', managed: 'enoughfactory.managed' });

/** Source metadata can select this fixed recipe, never an arbitrary image or host hook. */
export function validatePreparedToolchain(value: unknown): PreparedToolchain {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A resolved Swift toolchain is required.');
  const item = value as Record<string, unknown>;
  if (item.id !== SWIFT_TOOLCHAIN.id || item.recipeSha256 !== recipeSha256 || item.baseImage !== baseImage || item.swiftVersion !== SWIFT_TOOLCHAIN.swiftVersion || item.nodeVersion !== SWIFT_TOOLCHAIN.nodeVersion || !SWIFT_TOOLCHAIN.platforms.some(platform => platform === item.platform) || typeof item.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item.image)) throw new Error('The saved Swift toolchain does not match EnoughFactory’s pinned recipe, platform and immutable image.');
  return { id: SWIFT_TOOLCHAIN.id, recipeSha256, baseImage, image: item.image, platform: item.platform as PreparedToolchain['platform'], swiftVersion: SWIFT_TOOLCHAIN.swiftVersion, nodeVersion: SWIFT_TOOLCHAIN.nodeVersion };
}

interface Result { code: number; stdout: string; stderr: string; }
interface RunOptions { cwd?: string; signal?: AbortSignal; timeoutMs?: number; onOutput?: (output: string) => void; }
export type ToolchainDockerRunner = (endpoint: DockerRuntimeEndpoint, args: readonly string[], options: RunOptions) => Promise<Result>;
interface Image { Id: string; Architecture: string; Os: string; Config?: { Labels?: Record<string, string> }; }

function platform(architecture: string): PreparedToolchain['platform'] {
  if (['arm64', 'aarch64'].includes(architecture)) return 'linux/arm64';
  if (['amd64', 'x86_64'].includes(architecture)) return 'linux/amd64';
  throw new Error(`EnoughFactory’s Swift toolchain does not support runtime architecture ${architecture}.`);
}
function imageMetadata(image: Image, expectedPlatform: PreparedToolchain['platform']): PreparedToolchain {
  const labels = image.Config?.Labels;
  if (image.Os !== 'linux' || platform(image.Architecture) !== expectedPlatform || labels?.[TOOLCHAIN_IMAGE_LABELS.managed] !== 'true' || labels[TOOLCHAIN_IMAGE_LABELS.id] !== SWIFT_TOOLCHAIN.id || labels[TOOLCHAIN_IMAGE_LABELS.recipe] !== recipeSha256) throw new Error('The owned Docker image does not match the selected Swift toolchain recipe and architecture.');
  return validatePreparedToolchain({ ...SWIFT_TOOLCHAIN, image: image.Id, platform: expectedPlatform });
}
async function inspect(endpoint: DockerRuntimeEndpoint, image: string, run: ToolchainDockerRunner, options: ToolchainPreparationOptions): Promise<Image | undefined> {
  const result = await run(endpoint, ['image', 'inspect', image], { signal: options.signal, timeoutMs: 30_000 });
  if (result.code) {
    if (/no such image|image .* not found/i.test(result.stderr)) return undefined;
    throw new Error(result.stderr.trim() || 'The owned Docker image could not be inspected.');
  }
  const images: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(images) || images.length !== 1) throw new Error('Docker returned an ambiguous toolchain image.');
  return images[0] as Image;
}

/** Revalidate retained metadata on the receiving runtime; never builds or launches. */
export async function verifyPreparedToolchain(endpoint: DockerRuntimeEndpoint, value: unknown, options: ToolchainPreparationOptions = {}): Promise<PreparedToolchain> {
  return verifyWith(endpoint, value, options, runDocker);
}
async function verifyWith(endpoint: DockerRuntimeEndpoint, value: unknown, options: ToolchainPreparationOptions, run: ToolchainDockerRunner): Promise<PreparedToolchain> {
  const expected = validatePreparedToolchain(value);
  const image = await inspect(endpoint, expected.image, run, options);
  if (!image) throw new Error('The saved Swift toolchain image is missing from this owned runtime. Prepare the toolchain before running its checks.');
  const actual = imageMetadata(image, expected.platform);
  if (actual.image !== expected.image) throw new Error('Docker returned a different image from the saved Swift toolchain.');
  return actual;
}

const preparations = new Map<string, Promise<PreparedToolchain>>();
const verified = new Set<string>();
/** A fixed, clean image shared by author sessions and fresh captured-source checks. */
export async function prepareToolchain(endpoint: DockerRuntimeEndpoint, id: ToolchainProfileId, options: ToolchainPreparationOptions = {}): Promise<PreparedToolchain> {
  return prepareToolchainWith(endpoint, id, options, runDocker);
}

/** Explicit runner seam for focused boundary tests; production always uses the bundled CLI. */
export async function prepareToolchainWith(endpoint: DockerRuntimeEndpoint, id: ToolchainProfileId, options: ToolchainPreparationOptions, run: ToolchainDockerRunner): Promise<PreparedToolchain> {
  dockerInvocation(endpoint, []);
  if (id !== SWIFT_TOOLCHAIN.id) throw new Error('Unsupported EnoughFactory toolchain.');
  options.signal?.throwIfAborted();
  const key = `${endpoint.host}\0${recipeSha256}`;
  const existing = preparations.get(key);
  if (existing) { const prepared = await existing; options.signal?.throwIfAborted(); return prepared; }
  const operation = prepareOwned(endpoint, options, run);
  preparations.set(key, operation);
  try { const prepared = await operation; options.signal?.throwIfAborted(); return prepared; } finally { preparations.delete(key); }
}

async function prepareOwned(endpoint: DockerRuntimeEndpoint, options: ToolchainPreparationOptions, run: ToolchainDockerRunner): Promise<PreparedToolchain> {
  options.onProgress?.('Checking the private Swift and Node toolchain');
  const info = await run(endpoint, ['info', '--format', '{{json .}}'], { signal: options.signal, timeoutMs: 30_000 });
  if (info.code) throw new Error(info.stderr.trim() || 'The owned Docker runtime is unavailable.');
  const daemon = JSON.parse(info.stdout) as { Architecture: string; OSType: string };
  if (daemon.OSType !== 'linux') throw new Error('The Swift toolchain requires EnoughFactory’s Linux container runtime.');
  const selectedPlatform = platform(daemon.Architecture);
  const tag = `enoughfactory-toolchain:swift-6.0.3-${recipeSha256.slice(0, 20)}-${selectedPlatform.slice(6)}`;
  let image = await inspect(endpoint, tag, run, options);
  if (!image) {
    const context = await mkdtemp(join(tmpdir(), 'enoughfactory-swift-'));
    try {
      await writeFile(join(context, 'Dockerfile'), dockerfile, { mode: 0o600 });
      await writeFile(join(context, 'envmux-init'), init, { mode: 0o600 });
      options.onProgress?.('Preparing Swift 6.0.3 and Node 22.22.0; this image is cached for later work');
      const result = await run(endpoint, ['build', '--pull=false', '--platform', selectedPlatform, '--tag', tag, '--label', `${TOOLCHAIN_IMAGE_LABELS.managed}=true`, '--label', `${TOOLCHAIN_IMAGE_LABELS.id}=${SWIFT_TOOLCHAIN.id}`, '--label', `${TOOLCHAIN_IMAGE_LABELS.recipe}=${recipeSha256}`, context], { signal: options.signal, timeoutMs: 30 * 60_000 });
      if (result.code) throw new Error(result.stderr.trim() || result.stdout.trim() || 'The private Swift toolchain image could not be prepared.');
    } finally { await rm(context, { recursive: true, force: true }); }
    image = await inspect(endpoint, tag, run, options);
  }
  if (!image) throw new Error('Docker did not retain the prepared Swift toolchain image.');
  const metadata = imageMetadata(image, selectedPlatform);
  const validationKey = `${endpoint.host}\0${metadata.image}`;
  if (!verified.has(validationKey)) {
    const name = `enough-toolchain-probe-${randomUUID()}`;
    const script = `const c=require('node:child_process');const s=c.execFileSync('swift',['--version'],{encoding:'utf8'}).trim();if(process.version!=='v22.22.0'||!/^Swift version 6\\.0\\.3\\b/.test(s))throw Error('Toolchain version mismatch');for(const t of ['tmux','sshd'])c.execFileSync('sh',['-c','command -v '+t]);console.log(JSON.stringify({nodeVersion:process.version.slice(1),swiftVersion:'6.0.3'}));`;
    const command = `set -eu; test -x /usr/local/bin/envmux-init; node -e '${script.replaceAll("'", `'"'"'`)}'`;
    try {
      options.onProgress?.('Confirming Swift and Node in a fresh login shell');
      const result = await run(endpoint, ['run', '--name', name, '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', '/bin/bash', metadata.image, '-lc', command], { signal: options.signal, timeoutMs: 60_000 });
      if (result.code) throw new Error(result.stderr.trim() || result.stdout.trim() || 'The Swift toolchain login shell could not be verified.');
      const versions = JSON.parse(result.stdout.trim());
      if (versions.swiftVersion !== metadata.swiftVersion || versions.nodeVersion !== metadata.nodeVersion) throw new Error('The Swift toolchain returned unexpected version evidence.');
    } finally {
      // Aborting the CLI alone cannot confirm a container has stopped.
      const removed = await run(endpoint, ['rm', '--force', name], { timeoutMs: 30_000 });
      if (removed.code && !/no such container/i.test(removed.stderr)) throw new Error('The private toolchain probe could not be confirmed stopped.');
    }
    verified.add(validationKey);
  }
  options.onProgress?.('Swift 6.0.3 and Node 22.22.0 are ready');
  return metadata;
}

async function runDocker(endpoint: DockerRuntimeEndpoint, args: readonly string[], options: RunOptions): Promise<Result> {
  const invocation = dockerInvocation(endpoint, args);
  options.signal?.throwIfAborted();
  return await new Promise((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure: Error | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const terminate = (error: Error) => {
      if (failure) return;
      failure = error; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 2_000); force.unref();
    };
    const abort = () => terminate(new Error('Swift toolchain preparation was canceled.'));
    const timer = setTimeout(() => terminate(new Error('Swift toolchain preparation exceeded its deadline.')), options.timeoutMs ?? 30_000);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', chunk => { const output = chunk.toString(); stdout = (stdout + output).slice(-200_000); options.onOutput?.(output); });
    child.stderr.on('data', chunk => { const output = chunk.toString(); stderr = (stderr + output).slice(-20_000); options.onOutput?.(output); });
    const clean = () => { clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', abort); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', code => { clean(); if (failure) reject(failure); else accept({ code: code ?? 1, stdout, stderr }); });
  });
}
