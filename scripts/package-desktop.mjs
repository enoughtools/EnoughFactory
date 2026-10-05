#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile, chmod, mkdtemp, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeVersion = '22.22.0';
// Official release checksums. Check both these pins and the HTTPS release manifest.
const pins = {
  'darwin-arm64': '5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640',
  'darwin-x64': '5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce',
  'linux-arm64': '25ba95dfb96871fa2ef977f11f95ea90818c8fa15c0f2110771db08d4ba423be',
  'linux-x64': 'c33c39ed9c80deddde77c960d00119918b9e352426fd604ba41638d6526a4744',
};
const rtcVersion = '0.33.4';
const registryPins = {
  'node-datachannel@0.33.4': 'sha512-qiUrdh8vY9XhglEnx91HK0N2JEAAu8qTZl0fcR3yQd0fFrdO39NwDeJD/KpG+WKUb9/o4p2UwnP+/HftA/xMbQ==',
  'detect-libc@2.1.2': 'sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==',
  '@node-datachannel/darwin-arm64@0.33.4': 'sha512-bkIA+IbModz/NUmbVYTSWj8dZvkiab+cU4zOa6rhfKsNcW3EkdD2/DDoJjUrRrw+LbEZ40V7NuAKUlMNFDXFsw==',
  '@node-datachannel/darwin-x64@0.33.4': 'sha512-+dLnwiwC3GdWqW0OQShZcSFYrx3hRx0+7U85swoiP3iiRqtDUARME6AIAmW3glpP0vmus1jv5KhPCy/Q+jAvqw==',
  '@node-datachannel/linux-x64-gnu@0.33.4': 'sha512-xN0x3lcQ87qwOAmf1dBLVWrYY40LQ7pM4Y9wuNjP+EtN4IwiXqrhPdgupzGAElxna+n2NgBG0gT60dZpgoYU2Q==',
  '@node-datachannel/linux-arm64-gnu@0.33.4': 'sha512-rR4yjwxpI1miLSrruLGcfR9yfw0Qebw+Twt+u+lKsL9SwmXxTm5pJhUAa9RU+c35oZ98IyAxGFjRwwq85BTbog==',
};

function options(args) {
  const result = { platform: process.platform, arch: process.arch, build: true, prepareOnly: false, dir: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--platform') result.platform = args[++i];
    else if (arg === '--arch') result.arch = args[++i];
    else if (arg === '--skip-build') result.build = false;
    else if (arg === '--prepare-only') result.prepareOnly = true;
    else if (arg === '--dir') result.dir = true;
    else if (arg === '--help') {
      console.log('Usage: node scripts/package-desktop.mjs [--platform darwin|linux] [--arch arm64|x64] [--skip-build] [--prepare-only] [--dir]');
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!pins[`${result.platform}-${result.arch}`]) throw new Error('Supported targets are darwin/linux with arm64/x64.');
  return result;
}

async function required(path, label) {
  try { await access(path, constants.R_OK); }
  catch { throw new Error(`${label} is missing: ${path}`); }
}

async function download(url, maximumBytes = 150 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: 'error' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new Error(`Download exceeded its size limit: ${url}`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function prepareRuntime(platform, arch, resources) {
  const filename = `node-v${nodeVersion}-${platform}-${arch}.tar.gz`;
  const release = `https://nodejs.org/dist/v${nodeVersion}`;
  const manifest = (await download(`${release}/SHASUMS256.txt`, 100_000)).toString('utf8');
  const expected = pins[`${platform}-${arch}`];
  const published = manifest.split('\n').find(line => line.endsWith(`  ${filename}`))?.split(/\s+/)[0];
  if (published !== expected) throw new Error(`Official Node checksum changed or is missing for ${filename}. Review the pinned release before packaging.`);
  const cache = join(root, '.cache', 'desktop-runtime');
  await mkdir(cache, { recursive: true });
  const archive = join(cache, filename);
  let data;
  try { data = await readFile(archive); } catch { data = await download(`${release}/${filename}`); }
  if (createHash('sha256').update(data).digest('hex') !== expected) {
    await rm(archive, { force: true });
    throw new Error(`Checksum mismatch for ${filename}; cached file removed. Run packaging again to fetch a clean archive.`);
  }
  await writeFile(archive, data);
  const unpack = await mkdtemp(join(tmpdir(), 'enoughfactory-node-'));
  try {
    execFileSync('tar', ['-xzf', archive, '-C', unpack], { stdio: 'inherit' });
    const extracted = join(unpack, `node-v${nodeVersion}-${platform}-${arch}`);
    const runtime = join(resources, 'runtime');
    await mkdir(runtime, { recursive: true });
    await cp(join(extracted, 'bin', 'node'), join(runtime, 'node'));
    await chmod(join(runtime, 'node'), 0o755);
    await cp(join(extracted, 'LICENSE'), join(runtime, 'LICENSE'));
    await writeFile(join(runtime, 'provenance.json'), `${JSON.stringify({ version: nodeVersion, platform, arch, url: `${release}/${filename}`, sha256: expected }, null, 2)}\n`);
  } finally { await rm(unpack, { recursive: true, force: true }); }
}

async function prepareNative(platform, arch, resources) {
  const addon = `@node-datachannel/${platform}-${arch}${platform === 'linux' ? '-gnu' : ''}`;
  const modules = [['node-datachannel', rtcVersion], ['detect-libc', '2.1.2'], [addon, rtcVersion]];
  const cache = join(root, '.cache', 'desktop-runtime');
  const provenance = [];
  await rm(join(resources, 'device', 'node_modules'), { recursive: true, force: true });
  for (const [name, version] of modules) {
    const pinned = registryPins[`${name}@${version}`];
    const metadata = JSON.parse((await download(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, 1_000_000)).toString('utf8'));
    if (!pinned || metadata.name !== name || metadata.version !== version || metadata.dist?.integrity !== pinned) throw new Error(`Registry metadata does not match the pinned ${name}@${version}.`);
    const url = new URL(metadata.dist.tarball);
    if (url.origin !== 'https://registry.npmjs.org') throw new Error(`Unexpected registry archive origin for ${name}.`);
    const archive = join(cache, `${name.replaceAll('/', '-').replaceAll('@', '')}-${version}.tgz`);
    let data;
    try { data = await readFile(archive); } catch { data = await download(url.toString()); }
    if (`sha512-${createHash('sha512').update(data).digest('base64')}` !== pinned) {
      await rm(archive, { force: true });
      throw new Error(`Integrity mismatch for ${name}@${version}; cached file removed.`);
    }
    await writeFile(archive, data);
    const unpack = await mkdtemp(join(tmpdir(), 'enoughfactory-native-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', unpack], { stdio: 'inherit' });
      const packageDir = join(unpack, 'package');
      const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
      if (manifest.name !== name || manifest.version !== version) throw new Error(`Extracted native dependency does not match ${name}@${version}.`);
      const destination = join(resources, 'device', 'node_modules', name);
      await mkdir(dirname(destination), { recursive: true });
      await cp(packageDir, destination, { recursive: true });
    } finally { await rm(unpack, { recursive: true, force: true }); }
    provenance.push({ name, version, url: url.toString(), integrity: pinned });
  }
  await required(join(resources, 'device', 'node_modules', addon, 'node_datachannel.node'), 'Target-specific WebRTC native addon');
  await cp(join(resources, 'device', 'node_modules', 'node-datachannel', 'LICENSE'), join(resources, 'notices', 'node-datachannel-LICENSE'));
  await cp(join(resources, 'device', 'node_modules', 'detect-libc', 'LICENSE'), join(resources, 'notices', 'detect-libc-LICENSE'));
  await writeFile(join(resources, 'device', 'native-provenance.json'), `${JSON.stringify({ platform, arch, libc: platform === 'linux' ? 'glibc' : null, modules: provenance }, null, 2)}\n`);
  if (platform === process.platform && arch === process.arch) {
    execFileSync(join(resources, 'runtime', 'node'), ['-e', 'const r=require("node:module").createRequire(process.argv[1]);const rtc=r("node-datachannel");const peer=new rtc.PeerConnection("EnoughFactory packaging check",{iceServers:[]});peer.close();rtc.cleanup();console.log("Bundled WebRTC native module loaded.");', join(resources, 'device', 'service.cjs')], { cwd: tmpdir(), stdio: 'inherit', timeout: 15_000 });
  } else {
    console.log(`Prepared ${platform}/${arch} native WebRTC assets; load verification must run on that release target.`);
  }
}

async function writeBundleProvenance(platform, arch, resources) {
  const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
  const files = {};
  async function walk(directory, prefix = '') {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === 'bundle-provenance.json') continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative);
      else if (entry.isFile()) files[relative] = await sha256(join(directory, entry.name));
      else throw new Error(`Unexpected resource file type: ${relative}`);
    }
  }
  await walk(resources);
  const desktop = JSON.parse(await readFile(join(root, 'apps', 'desktop', 'package.json'), 'utf8'));
  const manifest = {
    formatVersion: 1, product: 'EnoughFactory', version: desktop.version, platform, arch,
    nodeVersion,
    engineSha256: files['envmux/envmux'], serviceSha256: files['device/service.cjs'], webIndexSha256: files['web/index.html'],
    nativeModules: JSON.parse(await readFile(join(resources, 'device', 'native-provenance.json'), 'utf8')).modules,
    files,
  };
  await writeFile(join(resources, 'bundle-provenance.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const opt = options(process.argv.slice(2));
const resources = join(root, 'apps', 'desktop', 'resources');
const target = `${opt.platform === 'darwin' ? 'osx' : 'linux'}-${opt.arch}`;
const envmux = join(root, 'artifacts', 'envmux', target, 'envmux');
await required(envmux, 'Published native envmux engine');
if (opt.build) {
  execFileSync('pnpm', ['--filter', '@enoughfactory/web', '--filter', '@enoughfactory/device', '--filter', '@enoughfactory/desktop', 'run', 'build'], { cwd: root, stdio: 'inherit' });
}
const deviceDist = join(root, 'apps', 'device', 'dist');
await required(join(deviceDist, 'service.cjs'), 'Bundled device service');
await required(join(root, 'apps', 'web', 'dist', 'index.html'), 'Built web client');
await required(join(root, 'runtime', 'workspaces', 'Dockerfile'), 'Workspace runtime environment');
await required(join(root, 'runtime', 'agents', 'antigravity_bridge.py'), 'Antigravity agent bridge');
await mkdir(resources, { recursive: true });
await cp(join(root, 'apps', 'desktop', 'assets', 'icon.png'), join(resources, 'icon.png'));
for (const folder of ['runtime', 'device', 'web', 'envmux', 'workspaces', 'agents', 'install', 'notices']) await rm(join(resources, folder), { recursive: true, force: true });
await cp(deviceDist, join(resources, 'device'), { recursive: true });
await cp(join(root, 'apps', 'web', 'dist'), join(resources, 'web'), { recursive: true });
await cp(join(root, 'runtime', 'workspaces'), join(resources, 'workspaces'), { recursive: true });
await cp(join(root, 'runtime', 'agents'), join(resources, 'agents'), { recursive: true });
await mkdir(join(resources, 'envmux'), { recursive: true });
await cp(envmux, join(resources, 'envmux', 'envmux'));
await chmod(join(resources, 'envmux', 'envmux'), 0o755);
await cp(join(root, 'vendor', 'envmux', 'LICENSE'), join(resources, 'envmux', 'LICENSE'));
await mkdir(join(resources, 'install'), { recursive: true });
for (const script of ['install-device-service.mjs', 'uninstall-device-service.mjs']) await cp(join(root, 'scripts', script), join(resources, 'install', script));
await mkdir(join(resources, 'notices'), { recursive: true });
await cp(join(root, 'apps', 'desktop', 'assets', 'LICENSE'), join(resources, 'notices', 'Enough-brand-LICENSE'));
await cp(join(root, 'vendor', 'enough-ui', 'LICENSE'), join(resources, 'notices', 'EnoughUI-LICENSE'));
await cp(join(root, 'vendor', 'enough-ui', 'THIRD_PARTY_NOTICES.md'), join(resources, 'notices', 'EnoughUI-THIRD_PARTY_NOTICES.md'));
const desktopRequire = createRequire(join(root, 'apps', 'desktop', 'package.json'));
const electronDist = join(dirname(desktopRequire.resolve('electron/package.json')), 'dist');
await cp(join(electronDist, 'LICENSE'), join(resources, 'notices', 'Electron-LICENSE'));
await cp(join(electronDist, 'LICENSES.chromium.html'), join(resources, 'notices', 'LICENSES.chromium.html'));
for (const notice of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  await required(join(root, notice), 'Distribution license notice');
  await cp(join(root, notice), join(resources, 'notices', notice));
}
await prepareRuntime(opt.platform, opt.arch, resources);
await prepareNative(opt.platform, opt.arch, resources);
await writeBundleProvenance(opt.platform, opt.arch, resources);
console.log(`Prepared EnoughFactory resources for ${opt.platform}/${opt.arch} with verified Node ${nodeVersion}.`);
if (!opt.prepareOnly) {
  if (opt.platform === 'darwin' && process.platform !== 'darwin') throw new Error('Build Mac bundles on a Mac release worker.');
  const args = ['--filter', '@enoughfactory/desktop', 'exec', 'electron-builder', '--config', 'electron-builder.mjs', opt.platform === 'darwin' ? '--mac' : '--linux', `--${opt.arch}`, '--publish', 'never'];
  if (opt.dir) args.push('--dir');
  execFileSync('pnpm', args, { cwd: root, stdio: 'inherit' });
}
