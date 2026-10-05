#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access, writeFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, relative } from 'node:path';
import { once } from 'node:events';

const resourceOption = process.argv.indexOf('--resources');
if (resourceOption < 0 || !process.argv[resourceOption + 1]) throw new Error('Usage: node scripts/check-desktop-bundle.mjs --resources <native installed resources>');
const resources = resolve(process.argv[resourceOption + 1]);
const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const receiptPath = value('--receipt');
const requestedCommit = value('--source-commit');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of ['runtime/node', 'runtime/container/provenance.json', 'runtime/container/engine-provenance.json', 'runtime/container/pins.json', 'runtime/container/docker/bin/docker', 'device/service.cjs', 'envmux/envmux', 'web/index.html', 'workspaces/source.json', 'agents/antigravity_bridge.py', 'bundle-provenance.json', 'notices/LICENSE', 'notices/THIRD_PARTY_NOTICES.md']) await access(join(resources, file));
const provenanceBytes = await readFile(join(resources, 'bundle-provenance.json'));
const provenance = JSON.parse(provenanceBytes);
if (provenance.formatVersion !== 1 || provenance.product !== 'EnoughFactory' || provenance.platform !== process.platform || provenance.arch !== process.arch || !/^[a-f0-9]{40}$/.test(provenance.sourceCommit ?? '') || (requestedCommit && requestedCommit !== provenance.sourceCommit)) throw new Error('Installed bundle provenance does not match this native release/source commit.');
if (!provenance.files || Object.keys(provenance.files).length < 20) throw new Error('The bundle has no complete resource manifest.');
const resourceFolders = ['runtime', 'device', 'envmux', 'web', 'workspaces', 'agents', 'install', 'notices'];
for (const [path, expected] of Object.entries(provenance.files)) {
  if (path.startsWith('/') || path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid resource manifest entry: ${path}`);
  const file = join(resources, path);
  if (!(await lstat(file)).isFile() || digest(await readFile(file)) !== expected) throw new Error(`Installed resource hash mismatch: ${path}`);
}
async function verifyTree(folder) {
  for (const entry of await readdir(join(resources, folder), { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) await verifyTree(path);
    else if (!entry.isFile() || !provenance.files[path]) throw new Error(`Unexpected installed runtime resource: ${path}`);
  }
}
for (const folder of resourceFolders) await verifyTree(folder);
const container = join(resources, 'runtime/container');
const pins = JSON.parse(await readFile(join(container, 'pins.json'), 'utf8'));
const containerProof = JSON.parse(await readFile(join(container, 'provenance.json'), 'utf8'));
const expectedArchives = [`docker-${process.platform}-${process.arch}`, ...(process.platform === 'darwin' ? [`lima-darwin-${process.arch}`, `docker-linux-${process.arch}`] : [`rootless-linux-${process.arch}`])];
if (pins.dockerVersion !== '29.8.2' || pins.limaVersion !== '2.2.1' || containerProof.platform !== process.platform || containerProof.arch !== process.arch || containerProof.dockerVersion !== pins.dockerVersion || JSON.stringify(provenance.containerRuntime) !== JSON.stringify(containerProof)) throw new Error('Installed private runtime version/provenance mismatch.');
if (containerProof.archives?.length !== expectedArchives.length || expectedArchives.some(component => !containerProof.archives.some(archive => archive.component === component && archive.url === pins.archives[component].url && archive.sha256 === pins.archives[component].sha256))) throw new Error('Installed private runtime archives differ from their pinned sources.');
const engineBytes = await readFile(join(container, 'engine-provenance.json'));
const engineProof = JSON.parse(engineBytes);
if (containerProof.engineSourceBuild?.file !== 'engine-provenance.json' || containerProof.engineSourceBuild?.sha256 !== digest(engineBytes) || engineProof.formatVersion !== 1 || engineProof.architecture !== process.arch || engineProof.version !== '29.8.2') throw new Error('Installed engine lacks its verified source-build provenance.');
const sourcePins = { moby: '3df781c47d14636d6268a13e27e1150598875c3b23ab8dbae361c372d453f492', runc: 'b5af44864a830c7032cf4a72efa0c6d44f701873d9507b127be31ad4d1d42ff3', libseccomp: '83b6085232d1588c379dc9b9cae47bb37407cf262e6e74993c61ba72d2a784dc', tini: '0fd35a7030052acd9f58948d1d900fe1e432ee37103c5561554408bdac6bbf0d' };
for (const [name, sha256] of Object.entries(sourcePins)) if (engineProof.sources?.[name]?.sha256 !== sha256) throw new Error(`Engine source pin mismatch: ${name}`);
const companion = containerProof.sourceCompanion;
if (!companion || companion.file !== `sources/EnoughFactory-${provenance.version}-${process.platform}-${process.arch}-container-sources.tar.gz` || companion.receiptFile !== `${companion.file}.json` || !/^[a-f0-9]{64}$/.test(companion.sha256) || JSON.stringify(companion) !== JSON.stringify(engineProof.sourceCompanion) || provenance.files[`runtime/container/${companion.file}`] !== companion.sha256) throw new Error('Installed engine is missing its matching source/relink companion.');
const companionReceipt = JSON.parse(await readFile(join(container, companion.receiptFile), 'utf8'));
if (companionReceipt.formatVersion !== 1 || companionReceipt.product !== 'EnoughFactory' || companionReceipt.archiveSha256 !== companion.sha256 || !companionReceipt.sourceInputs?.length) throw new Error('Source/relink companion receipt does not match its archive.');
const componentNames = ['dockerd', 'docker-proxy', 'runc', 'docker-init'];
if (engineProof.components?.length !== componentNames.length || new Set(engineProof.components.map(component => component.name)).size !== componentNames.length) throw new Error('Source-built engine components are missing or duplicated.');
if (process.platform === 'darwin' && (containerProof.engineArchive?.file !== 'docker/guest-engine.tgz' || containerProof.engineArchive?.sha256 !== provenance.files['runtime/container/docker/guest-engine.tgz'])) throw new Error('Mac guest engine archive lacks its exact source-build binding.');
for (const name of componentNames) {
  const component = engineProof.components.find(component => component.name === name);
  if (!component || !/^[a-f0-9]{64}$/.test(component.sha256) || !component.source || !component.buildMode || !companionReceipt.artifacts?.some(artifact => artifact.name === name && artifact.platform === `linux-${process.arch}` && artifact.sha256 === component.sha256)) throw new Error(`Source companion does not bind engine component: ${name}`);
  const actual = process.platform === 'linux' ? provenance.files[`runtime/container/docker/bin/${name}`]
    : digest(execFileSync('tar', ['-xOzf', join(container, 'docker/guest-engine.tgz'), `docker/${name}`], { maxBuffer: 256 * 1024 * 1024, timeout: 30_000 }));
  if (actual !== component.sha256) throw new Error(`Installed engine component differs from the source/relink kit: ${name}`);
}
const cleanDockerEnv = { ...process.env };
for (const name of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'DOCKER_API_VERSION']) delete cleanDockerEnv[name];
const dockerVersion = execFileSync(join(container, 'docker/bin/docker'), ['--version'], { encoding: 'utf8', env: cleanDockerEnv, timeout: 20_000 }).trim();
if (!dockerVersion.startsWith('Docker version 29.8.2,')) throw new Error(`Wrong bundled private Docker CLI: ${dockerVersion}`);
let limaVersion;
if (process.platform === 'darwin') {
  await access(join(container, 'docker/guest-engine.tgz'));
  await access(join(container, 'images/guest.img'));
  await access(join(container, `lima/share/lima/lima-guestagent.Linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.gz`));
  limaVersion = execFileSync(join(container, 'lima/bin/limactl'), ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  if (!limaVersion.includes('2.2.1')) throw new Error(`Wrong bundled private Lima CLI: ${limaVersion}`);
  if (containerProof.guestImage?.url !== pins.images[process.arch].url || containerProof.guestImage?.sha256 !== pins.images[process.arch].sha256 || containerProof.guestImage?.bundled !== true || containerProof.guestImage?.path !== 'images/guest.img' || provenance.files['runtime/container/images/guest.img'] !== pins.images[process.arch].sha256) throw new Error('The bundled guest image does not match its pinned checksum.');
} else {
  for (const file of ['dockerd', 'dockerd-rootless.sh', 'rootlesskit', 'containerd', 'runc']) await access(join(container, 'docker/bin', file));
  const daemonVersion = execFileSync(join(container, 'docker/bin/dockerd'), ['--version'], { encoding: 'utf8', timeout: 20_000 }).trim();
  if (!daemonVersion.startsWith('Docker version 29.8.2,')) throw new Error(`Wrong bundled private daemon: ${daemonVersion}`);
}
const node = join(resources, 'runtime/node');
const native = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'], { encoding: 'utf8' }));
if (native.platform !== process.platform || native.arch !== process.arch || native.version !== 'v22.22.0') throw new Error(`Bundled Node does not match the release worker: ${JSON.stringify(native)}`);
execFileSync(join(resources, 'envmux/envmux'), ['--version'], { stdio: 'pipe', timeout: 20_000 });
// This verifies native dependency resolution from the installed tree, without
// relying on repository node_modules or development SDKs.
execFileSync(node, ['-e', 'const r=require("node:module").createRequire(process.argv[1]);const rtc=r("node-datachannel");rtc.cleanup();console.log("WebRTC native runtime loaded")', join(resources, 'device/service.cjs')], { stdio: 'inherit', timeout: 20_000 });
const address = createServer();
address.listen(0, '127.0.0.1');
await once(address, 'listening');
const port = address.address().port;
address.close();
await once(address, 'close');
// Lima's Unix sockets have a shorter path limit than the usual Mac temp root.
const state = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ef-bundle-'));
const child = spawn(node, [join(resources, 'device/service.cjs')], {
  cwd: state,
  env: {
    ...process.env, ENOUGHFACTORY_HOME: state, ENOUGHFACTORY_PORT: String(port),
    ENOUGHFACTORY_RESOURCES: resources, ENOUGHFACTORY_WEB_PATH: join(resources, 'web'),
    ENOUGHFACTORY_REPO: undefined, ENOUGHFACTORY_CONTAINER_ASSETS: container,
    ENOUGHFACTORY_ENVMUX_PATH: join(resources, 'envmux/envmux'),
    DOCKER_CONTEXT: 'enoughfactory-bundle-must-ignore-this', DOCKER_HOST: 'unix:///var/run/docker.sock',
    DOCKER_CONFIG: join(state, 'unrelated-docker-config'), DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/enoughfactory-do-not-use-user-certificates',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
let launchError;
child.on('error', error => { launchError = error; });
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', value => { log = (log + value).slice(-16_000); });
try {
  const deadline = Date.now() + 30_000;
  let connection;
  let ready = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Bundled device service exited with ${child.exitCode}.\n${log}`);
    try {
      connection = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8'));
      const response = await fetch(`${connection.url}/api/health`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1_000) });
      const health = await response.json();
      if (response.ok && health.ok && health.product === 'EnoughFactory') { ready = true; break; }
    } catch { connection = undefined; }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  if (!ready || !connection) throw new Error(`Bundled device service did not become ready.\n${log}`);
  const denied = await fetch(`${connection.url}/api/state`, { signal: AbortSignal.timeout(5_000) });
  if (denied.status !== 401) throw new Error(`The bundled service accepted an unauthenticated state request (${denied.status}).`);
  const response = await fetch(`${connection.url}/api/state`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(5_000) });
  const factory = await response.json();
  if (!response.ok || factory.product !== 'EnoughFactory' || factory.device.platform !== process.platform || factory.device.arch !== process.arch) throw new Error('The installed device catalog did not match this release worker.');
  const runtimeResponse = await fetch(`${connection.url}/api/runtime`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(20_000) });
  const runtime = await runtimeResponse.json();
  if (!runtimeResponse.ok || runtime.stateDirectory !== state || !runtime.socketPath || relative(state, runtime.socketPath).startsWith('..') || runtime.socketPath === '/var/run/docker.sock' || runtime.kind !== (process.platform === 'darwin' ? 'lima' : 'rootless')) throw new Error(`The installed service did not select its own private runtime: ${JSON.stringify(runtime)}`);
  const receipt = {
    formatVersion: 1, product: 'EnoughFactory', version: provenance.version, platform: process.platform, arch: process.arch,
    sourceCommit: provenance.sourceCommit, verifiedAt: new Date().toISOString(), verificationScope: 'installed-desktop-resources',
    resources: { bundleProvenanceSha256: digest(provenanceBytes), fileCount: Object.keys(provenance.files).length, hashesVerified: true, manifest: provenance.files },
    native: { node: native, webRtc: 'loaded-from-installed-tree', envmux: 'native-executable', service: 'authenticated-health-and-catalog', unauthenticatedStateStatus: denied.status },
    containerRuntime: { dockerVersion: containerProof.dockerVersion, ...(limaVersion ? { limaVersion: containerProof.limaVersion } : {}), archivePins: containerProof.archives, assetsVerified: true, dedicatedSocket: 'inside-isolated-device-state', startupState: runtime.state,
      engineSourceBuild: { provenanceSha256: digest(engineBytes), components: engineProof.components, sourceCompanion: companion } },
  };
  if (receiptPath) await writeFile(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`EnoughFactory installed resources verified on ${process.platform}/${process.arch}: ${receipt.resources.fileCount} exact hashes, private runtime tools/socket, authenticated service, native WebRTC and envmux.`);
} finally {
  if (child.exitCode === null && !launchError) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timeout);
  }
  await rm(state, { recursive: true, force: true });
}
