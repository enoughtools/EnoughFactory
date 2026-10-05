#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args[index + 1];
}
const build = resolve(option('--build-output', join(here, 'output')));
const artifact = resolve(option('--output', 'EnoughFactory-container-sources.tar.gz'));
const cache = resolve(option('--cache', join(here, '.cache')));
const staging = resolve(option('--staging', `${artifact}.staging`));
const root = join(staging, 'EnoughFactory-container-source');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const goManifest = JSON.parse(await readFile(join(build, 'go-engine-provenance.json'), 'utf8'));
const nativeManifest = JSON.parse(await readFile(join(build, 'native-build-manifest.json'), 'utf8'));
const nativePins = JSON.parse(await readFile(join(here, 'native-pins.json'), 'utf8'));
const dependencies = JSON.parse(await readFile(join(here, 'dependency-sources.json'), 'utf8'));
await mkdir(cache, { recursive: true });
await mkdir(root, { recursive: true });
await cp(join(resolve(here, '../../..'), 'LICENSE'), join(root, 'LICENSE'));
const retained = [];
async function source(url, digest, local, fileName, subdirectory = 'sources') {
  let bytes;
  if (local) {
    try { bytes = await readFile(local); } catch { /* Fetch the pinned archive below. */ }
  }
  const downloaded = join(cache, fileName);
  if (!bytes) {
    try { bytes = await readFile(downloaded); } catch {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Source download returned ${response.status}: ${url}`);
      bytes = Buffer.from(await response.arrayBuffer());
    }
  }
  if (hash(bytes) !== digest) throw new Error(`Source digest mismatch: ${url}`);
  await writeFile(downloaded, bytes);
  const destination = join(root, subdirectory, fileName); await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  retained.push({ url, sha256: digest, file: `${subdirectory}/${fileName}`, bytes: bytes.length });
}
await source(goManifest.source.url, goManifest.source.sha256, goManifest.sourceArchive, `moby-${goManifest.source.revision}.tgz`);
for (const [name, input] of Object.entries(nativeManifest.inputs)) {
  // The manifest identifies the exact release archive used by the actual build.
  await source(input.url, input.sha256, input.archive, `${name}-${input.version}.tar.gz`);
}
await source(nativePins.zig.source.tarball, nativePins.zig.source.shasum, undefined, `zig-${nativePins.zig.version}-source.tar.xz`);
for (const input of dependencies.modules) await source(input.url, input.sha256, undefined, input.fileName, 'third-party-sources');
await mkdir(join(root, 'relink-kit'), { recursive: true });
for (const entry of await readdir(here, { withFileTypes: true })) {
  if (entry.isFile() && /\.(mjs|py|json|md|sh)$/.test(entry.name)) await cp(join(here, entry.name), join(root, 'relink-kit', entry.name));
}
await mkdir(join(root, 'provenance'), { recursive: true });
await cp(join(build, 'go-engine-provenance.json'), join(root, 'provenance', 'go-engine-provenance.json'));
await cp(join(build, 'native-build-manifest.json'), join(root, 'provenance', 'native-build-manifest.json'));
await mkdir(join(root, 'notices'), { recursive: true });
for (const [component, names] of Object.entries({ runc: ['LICENSE', 'NOTICE'], libseccomp: ['LICENSE'], tini: ['LICENSE'] })) {
  for (const name of names) {
    const file = join(nativeManifest.sourceDirectories[component], name);
    try { await cp(file, join(root, 'notices', `${component}-${name}`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await cp(join(nativeManifest.toolchains.zig.directory, 'LICENSE'), join(root, 'notices', 'Zig-LICENSE'));
await cp(join(nativeManifest.toolchains.zig.directory, 'lib', 'libc', 'musl', 'COPYRIGHT'), join(root, 'notices', 'musl-COPYRIGHT'));
for (const name of ['native-verification.json', 'docker-engine-verification.json']) {
  try { await cp(join(build, name), join(root, 'provenance', name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const artifacts = [];
for (const row of goManifest.artifacts) {
  if (hash(await readFile(row.file)) !== row.sha256) throw new Error(`Go artifact changed after its build: ${row.file}`);
  artifacts.push({ name: row.name, platform: row.platform, sha256: row.sha256 });
}
for (const row of nativeManifest.builds) {
  const architecture = row.architecture ?? row.arch;
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('Native manifest architecture is missing');
  await cp(join(build, architecture, 'relink'), join(root, 'relink', architecture), { recursive: true });
  for (const name of ['runc', 'docker-init']) {
    const file = join(build, architecture, name);
    const digest = hash(await readFile(file));
    if (row.binaries?.[name]?.sha256 !== digest) throw new Error(`Native artifact changed after its build: ${file}`);
    artifacts.push({ name, platform: `linux-${architecture}`, sha256: digest });
  }
}
const receipt = { formatVersion: 1, product: 'EnoughFactory', sourceInputs: retained, artifacts, scope: 'Exact source archives, pinned build recipes, native library objects and application relink objects for the bundled source-built engine components; unmodified MPL module source archives for the remaining runtime components.' };
await writeFile(join(root, 'SOURCE-RECEIPT.json'), `${JSON.stringify(receipt, null, 2)}\n`);
await mkdir(dirname(artifact), { recursive: true });
await new Promise((resolveTar, reject) => {
  const child = spawn('tar', ['-czf', artifact, '-C', staging, 'EnoughFactory-container-source'], { stdio: 'inherit' });
  child.on('error', reject); child.on('close', code => code === 0 ? resolveTar() : reject(new Error(`tar exited ${code}`)));
});
const artifactReceipt = { ...receipt, archiveFile: artifact, archiveSha256: hash(await readFile(artifact)) };
await writeFile(`${artifact}.json`, `${JSON.stringify(artifactReceipt, null, 2)}\n`);
if (!args.includes('--keep-staging')) await rm(staging, { recursive: true });
console.log(`Corresponding sources and relink objects: ${artifact}`);
