#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyRuntimeSourceClosure } from './verify-runtime-source-closure.mjs';
import { verifyArchiveReceipt, verifyRuntimeJourney } from '../release/marketing/verify-receipt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = '5252bd83a9082d7711e7e3dcbf426daef0abc165';
// Exact previously verified inputs. The seed is an input to a fresh release, not a new runtime proof.
const verified = {
  'darwin-arm64': { filename: 'EnoughFactory-0.1.1-mac-arm64.zip', sha256: '64e3031f8eb6700bda257cb2d2ed0aa867711e020dbdbcf775f712968697cbc0', bytes: 1024519191, receiptSha256: '1079557b1ad3b882b0ac8c17f30555cdf1e6d8af6cced4f288cd9cef9cba336b', manifestSha256: 'c56cf3a915c553dc145bd3e172cdfb69a6c95ed80d438b4e6ed1dc73ecdad3e5' },
  'linux-x64': { filename: 'EnoughFactory-0.1.1-linux-x64.tar.gz', sha256: '34ad2f3c21840907eef090909de55732e8cc3709e3eae085dc55d6b53f7e9ac5', bytes: 359570994, receiptSha256: 'cad208ac770592166af7869db93ca363ad8c2544b4603de89628c0d47804c4f1', manifestSha256: '9075e9556e496d20a37e54e1f791b923e480ae43d5b1b764962749bd3577b2bb' },
  'linux-arm64': { filename: 'EnoughFactory-0.1.1-linux-arm64.tar.gz', sha256: 'be571a4d31c4e17646ab397cb28e41e6eacb41fa3bf0ce7a100104cdfe71857d', bytes: 349309826, receiptSha256: '7c3f02df86cb765881e6e5d835bd6e571e0ff0a7088e4107a7b5d30263d52bb1', manifestSha256: '22e896406fe51c3abb362a25c270c2a4c5864b869aebe086c08714f0c7ff81ae' },
};
const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
if (process.argv.includes('--help')) { console.log('Usage: node scripts/seed-native-release-assets.mjs --archive <verified prior archive> --receipt <prior receipt> --source-commit <baseline> --platform darwin|linux --arch arm64|x64 --output <new seed directory> [--activate-envmux]'); process.exit(0); }
const platform = value('--platform'), arch = value('--arch'), expected = verified[`${platform}-${arch}`];
if (!expected || value('--source-commit') !== baseline || !value('--archive') || !value('--receipt') || !value('--output')) throw new Error('Use the exact verified baseline archive, receipt and supported target to seed native assets.');
const archive = resolve(value('--archive')), receiptFile = resolve(value('--receipt')), output = resolve(value('--output'));
if (basename(archive) !== expected.filename) throw new Error('The prior archive filename does not match the selected target.');
try { await lstat(output); throw new Error('The native seed destination already exists; choose a new directory.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fingerprint(file) { const hash = createHash('sha256'); let bytes = 0; for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; } return { sha256: hash.digest('hex'), bytes }; }
const sourceClosure = await verifyRuntimeSourceClosure('native-assets', baseline);
const receiptBytes = await readFile(receiptFile);
if (digest(receiptBytes) !== expected.receiptSha256) throw new Error('The historical native receipt differs from its selected immutable identity.');
const receipt = JSON.parse(receiptBytes);
const actual = await fingerprint(archive);
if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes || receipt.sourceCommit !== baseline || receipt.resources?.bundleProvenanceSha256 !== expected.manifestSha256) throw new Error('The historical native archive differs from its selected immutable identity.');
const pins = JSON.parse(await readFile(join(root, 'runtime/container/pins.json'), 'utf8'));
verifyArchiveReceipt(receipt, { version: '0.1.1', platform, arch, filename: expected.filename, ...actual, format: platform === 'darwin' ? 'zip' : 'tar.gz' }, pins);
verifyRuntimeJourney(receipt);
const work = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'ef-native-seed-'));
await mkdir(dirname(output), { recursive: true });
const staging = await mkdtemp(`${output}.tmp-`);
let published = false;
try {
  // Its exact bytes already passed archive path/link preflight in the selected receipt.
  if (platform === 'darwin') execFileSync('ditto', ['-x', '-k', '--noqtn', archive, work], { timeout: 120_000 });
  else execFileSync('tar', ['-xzf', archive, '-C', work, '--no-same-owner'], { timeout: 120_000 });
  const roots = [];
  async function discover(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(entry => entry.isFile() && entry.name === 'bundle-provenance.json')) roots.push(directory);
    for (const entry of entries) if (entry.isDirectory()) await discover(join(directory, entry.name));
  }
  await discover(work);
  if (roots.length !== 1) throw new Error('The historical archive must contain exactly one prepared resource tree.');
  const resources = roots[0], manifestBytes = await readFile(join(resources, 'bundle-provenance.json'));
  if (digest(manifestBytes) !== expected.manifestSha256) throw new Error('The historical resource manifest changed.');
  const manifest = JSON.parse(manifestBytes);
  if (JSON.stringify(manifest.files) !== JSON.stringify(receipt.resources.manifest)) throw new Error('Historical prepared resources and archive receipt disagree.');
  for (const [path, sha256] of Object.entries(manifest.files)) {
    const file = join(resources, path);
    if (!(await lstat(file)).isFile() || digest(await readFile(file)) !== sha256) throw new Error(`Historical resource hash mismatch: ${path}`);
  }
  for (const folder of ['runtime', 'device', 'envmux', 'web', 'workspaces', 'agents', 'install', 'notices']) {
    async function verifyTree(relative) {
      for (const entry of await readdir(join(resources, relative), { withFileTypes: true })) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await verifyTree(path);
        else if (!entry.isFile() || !manifest.files[path]) throw new Error(`Unexpected historical resource: ${path}`);
      }
    }
    await verifyTree(folder);
  }
  const container = join(resources, 'runtime/container'), containerProof = JSON.parse(await readFile(join(container, 'provenance.json'), 'utf8'));
  const companion = join(container, containerProof.sourceCompanion.file);
  if (digest(await readFile(companion)) !== containerProof.sourceCompanion.sha256) throw new Error('The historical source companion changed.');
  await mkdir(join(staging, 'engine-build', arch), { recursive: true });
  for (const name of ['go-engine-provenance.json', 'native-build-manifest.json']) {
    const bytes = execFileSync('tar', ['-xOzf', companion, `EnoughFactory-container-source/provenance/${name}`], { maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
    JSON.parse(bytes.toString('utf8'));
    await writeFile(join(staging, 'engine-build', name), bytes);
  }
  const components = receipt.containerRuntime.engineSourceBuild.components;
  for (const component of components) {
    const bytes = platform === 'linux' ? await readFile(join(container, 'docker/bin', component.name)) : execFileSync('tar', ['-xOzf', join(container, 'docker/guest-engine.tgz'), `docker/${component.name}`], { maxBuffer: 256 * 1024 * 1024, timeout: 30_000 });
    if (digest(bytes) !== component.sha256) throw new Error(`Historical compiled component changed: ${component.name}`);
    await writeFile(join(staging, 'engine-build', arch, component.name), bytes, { mode: 0o755 });
  }
  await copyFile(companion, join(staging, 'container-sources.tar.gz'));
  await copyFile(`${companion}.json`, join(staging, 'container-sources.tar.gz.json'));
  await mkdir(join(staging, 'envmux'));
  await copyFile(join(resources, 'envmux/envmux'), join(staging, 'envmux/envmux'));
  await chmod(join(staging, 'envmux/envmux'), 0o755);
  const seed = { formatVersion: 1, product: 'EnoughFactory', scope: 'verified-native-release-seed', verifiedAt: new Date().toISOString(), target: { platform, arch }, baseline: { sourceCommit: baseline, artifact: receipt.artifact, receiptSha256: expected.receiptSha256, bundleProvenanceSha256: expected.manifestSha256 }, sourceClosure, components, sourceCompanionSha256: containerProof.sourceCompanion.sha256, envmuxSha256: manifest.files['envmux/envmux'] };
  await writeFile(join(staging, 'seed-provenance.json'), `${JSON.stringify(seed, null, 2)}\n`);
  await rename(staging, output); published = true;
  if (process.argv.includes('--activate-envmux')) {
    const target = join(root, 'artifacts/envmux', `${platform === 'darwin' ? 'osx' : platform}-${arch}`);
    await mkdir(target, { recursive: true });
    await copyFile(join(output, 'envmux/envmux'), join(target, 'envmux'));
    await chmod(join(target, 'envmux'), 0o755);
  }
  console.log(JSON.stringify({ output, sourceCommit: baseline, sourceCompanionSha256: seed.sourceCompanionSha256, components: components.map(component => ({ name: component.name, sha256: component.sha256 })) }));
} finally {
  await rm(work, { recursive: true, force: true });
  if (!published) await rm(staging, { recursive: true, force: true });
}
