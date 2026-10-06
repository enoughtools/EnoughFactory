#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentAssetPaths, componentQualificationRequirements, qualificationDependencyInputs, qualificationSourceInput, qualificationSourcePaths, verifyComponentQualification } from '../release/marketing/verify-component-qualification.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
if (process.argv.includes('--help')) { console.log('Usage: node scripts/qualify-desktop-components.mjs --resources <fresh installed resources> --baseline-directory <original 0.1.2 receipts> --receipt <new qualification.json> --source-commit <frozen commit>'); process.exit(0); }
if (!value('--resources') || !value('--baseline-directory') || !value('--receipt') || !/^[a-f0-9]{40}$/.test(value('--source-commit') ?? '')) throw new Error('Pass the fresh resources, original component baseline directory, qualification output and frozen source commit.');
const resources = resolve(value('--resources')), baselineDirectory = resolve(value('--baseline-directory')), output = resolve(value('--receipt'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await readFile(join(resources, 'bundle-provenance.json'));
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.product, 'EnoughFactory'); assert.equal(manifest.version, '0.1.3'); assert.equal(manifest.sourceCommit, value('--source-commit'));
const requirements = componentQualificationRequirements(manifest.platform, manifest.arch);
const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).toString().split('\0').filter(Boolean);
const selected = qualificationSourcePaths(paths);
assert.deepEqual(selected, Object.keys(requirements.sources).sort(), 'The mandatory component source input set changed.');
const sources = {};
for (const path of selected) {
  const file = join(root, path), metadata = await lstat(file);
  assert.ok(metadata.isFile() || metadata.isSymbolicLink(), `Unsupported component input: ${path}`);
  const bytes = metadata.isSymbolicLink() ? Buffer.from(await readlink(file)) : await readFile(file);
  sources[path] = qualificationSourceInput(path, bytes);
  assert.equal(sources[path], requirements.sources[path], `Unchanged component source differs: ${path}`);
}
const dependencies = qualificationDependencyInputs(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'));
const container = JSON.parse(await readFile(join(resources, 'runtime/container/provenance.json')));
const engine = JSON.parse(await readFile(join(resources, 'runtime/container/engine-provenance.json')));
assert.equal(digest(await readFile(join(resources, 'runtime/container/engine-provenance.json'))), container.engineSourceBuild.sha256);
const currentReceipt = { version: manifest.version, sourceCommit: manifest.sourceCommit, platform: manifest.platform, arch: manifest.arch,
  resources: { bundleProvenanceSha256: digest(manifestBytes), manifest: manifest.files },
  containerRuntime: { dockerVersion: container.dockerVersion, limaVersion: container.limaVersion, archivePins: container.archives, engineSourceBuild: { components: engine.components, sourceCompanion: container.sourceCompanion } } };
const assets = {};
for (const [key, path] of Object.entries(componentAssetPaths(currentReceipt))) {
  const file = join(resources, path); assert.ok((await lstat(file)).isFile(), `Component asset must be an ordinary file: ${path}`);
  const hash = createHash('sha256'); for await (const bytes of createReadStream(file)) hash.update(bytes);
  assets[key] = hash.digest('hex'); assert.equal(assets[key], manifest.files[path], `Actual component bytes differ from the new manifest: ${path}`);
}
const baseline = { version: requirements.version, sourceCommit: requirements.sourceCommit };
for (const name of ['archive', 'runtime', ...(requirements.baseline.api ? ['api'] : [])]) {
  const pin = requirements.baseline[name];
  const filename = name === 'archive' ? `${pin.filename}.verification.json` : pin.filename;
  const bytes = await readFile(join(baselineDirectory, filename));
  const sha256 = name === 'archive' ? pin.receiptSha256 : pin.sha256;
  assert.equal(digest(bytes), sha256, `The original historical ${name} receipt changed.`);
  baseline[name] = { url: name === 'archive' ? pin.receiptUrl : pin.url, sha256, receipt: JSON.parse(bytes) };
}
const proof = { formatVersion: 1, product: 'EnoughFactory', kind: 'unchanged-runtime-components', status: 'qualified', qualifiedAt: new Date().toISOString(), scope: requirements.scope,
  current: { version: manifest.version, sourceCommit: manifest.sourceCommit, platform: manifest.platform, arch: manifest.arch, bundleProvenanceSha256: digest(manifestBytes) }, baseline,
  unchanged: { sources, dependencies, assets } };
verifyComponentQualification(currentReceipt, proof);
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.tmp-${process.pid}`;
try { await writeFile(temporary, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, output); }
finally { await rm(temporary, { force: true }); }
console.log(JSON.stringify({ receipt: output, scope: proof.scope, baselineVersion: requirements.version, currentSourceCommit: manifest.sourceCommit, sources: Object.keys(sources).length, dependencies: Object.keys(dependencies).length, assets: Object.keys(assets).length, runtimeJourney: 'original 0.1.2 evidence; no new Docker or model run' }));
