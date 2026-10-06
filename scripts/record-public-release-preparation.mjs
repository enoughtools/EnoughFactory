#!/usr/bin/env node
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashBytes, hashFile } from '../release/marketing/source-companions.mjs';
import { validateDelivery } from './stage-verified-release.mjs';

const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
const phase = value('--phase'), directory = value('--directory') && resolve(value('--directory'));
assert.ok(['identity', 'inputs', 'prepared'].includes(phase) && directory, 'Pass --phase identity|inputs|prepared and --directory.');
const selection = validateDelivery(JSON.parse(await readFile('.github/release-delivery/0.1.3.json', 'utf8')));
const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
assert.equal(release.id, selection.releaseId);
assert.equal(release.tag_name, `v${selection.version}`);
assert.equal(release.target_commitish, selection.sourceCommit);
assert.equal(release.draft, false, 'Catalog preparation requires the selected release to be public.');
assert.equal(release.prerelease, false);
const required = [];
for (const [platform, arch, formats] of [['darwin', 'arm64', ['dmg', 'zip']], ['linux', 'arm64', ['AppImage', 'tar.gz']], ['linux', 'x64', ['AppImage', 'tar.gz']]]) {
  for (const format of formats) {
    const filename = `EnoughFactory-0.1.3-${platform === 'darwin' ? 'mac' : platform}-${arch}.${format}`;
    required.push(filename, `${filename}.verification.json`);
  }
  const source = `EnoughFactory-0.1.3-${platform}-${arch}-container-sources.tar.gz`;
  required.push(source, `${source}.json`);
  for (const suite of ['installed', 'service', 'gui', 'packaged-service-smoke']) required.push(`${platform}-${arch}.${suite}.verification.json`);
  required.push(`${platform}-${arch}.gui.verification.json.png`);
  if (platform === 'darwin') required.push(`${platform}-${arch}.component-qualification.verification.json`);
}
const baseline = JSON.parse(await readFile('scripts/release-baselines/0.1.1.json', 'utf8'));
required.push(...baseline.ubuntu.map(asset => asset.filename), 'SHA256SUMS', 'provenance.json');
assert.equal(required.length, 43);
assert.deepEqual(release.assets.map(asset => asset.name).sort(), required.sort(), 'Public release input set differs from the explicitly selected 43 files.');
const assets = release.assets.map(asset => {
  assert.equal(asset.state, 'uploaded');
  assert.match(asset.digest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(asset.size) && asset.size > 0);
  const url = `https://github.com/enoughtools/EnoughFactory/releases/download/v0.1.3/${asset.name}`;
  assert.equal(asset.browser_download_url, url);
  return { filename: asset.name, bytes: asset.size, sha256: asset.digest.slice(7), url };
}).sort((a, b) => a.filename.localeCompare(b.filename));
if (phase === 'identity') { console.log('Selected public release, frozen source and 43-file input identity verified.'); process.exit(0); }
if (phase === 'inputs') {
  for (const asset of assets) {
    const path = join(directory, 'files', asset.filename), info = await lstat(path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.deepEqual(await hashFile(path), { sha256: asset.sha256, bytes: asset.bytes }, `Downloaded input bytes differ: ${asset.filename}`);
  }
  await writeFile(join(directory, 'inputs.verification.json'), `${JSON.stringify({ formatVersion: 1, product: 'EnoughFactory', scope: 'exact-public-release-inputs', status: 'passed', version: selection.version, sourceCommit: selection.sourceCommit, releaseId: selection.releaseId, verifiedAt: new Date().toISOString(), assets }, null, 2)}\n`);
  console.log('All 43 downloaded release inputs match public server sizes and SHA-256 digests.');
  process.exit(0);
}
const inputs = JSON.parse(await readFile(join(directory, 'inputs.verification.json'), 'utf8'));
assert.equal(inputs.status, 'passed');
assert.equal(inputs.sourceCommit, selection.sourceCommit);
assert.equal(inputs.releaseId, selection.releaseId);
assert.deepEqual(inputs.assets, assets, 'Public input metadata changed during preparation.');
const downloads = resolve('apps/marketing/public/downloads');
const catalogBytes = await readFile(join(downloads, 'manifest.json'));
const catalog = JSON.parse(catalogBytes);
assert.equal(catalog.product, 'EnoughFactory');
assert.equal(catalog.version, selection.version);
assert.equal(catalog.status, 'published');
assert.equal(catalog.sourceCommit, selection.sourceCommit);
assert.equal(catalog.artifacts.length, 6);
assert.equal(catalog.sources.length, 13);
assert.equal(catalog.ubuntuSourceIndexSha256, '70aae28ae71172ff64897506285cf2fd6963fe52bf648c430073ff7e7b63c81b');
const generated = [];
for (const filename of ['manifest.json', 'SHA256SUMS.txt', ...(await readdir(join(downloads, '0.1.3'))).map(filename => `0.1.3/${filename}`)].sort()) generated.push({ path: `apps/marketing/public/downloads/${filename}`, ...await hashFile(join(downloads, filename)) });
const receipt = { formatVersion: 1, product: 'EnoughFactory', scope: 'public-release-catalog-preparation', status: 'passed', version: selection.version, sourceCommit: selection.sourceCommit, releaseId: selection.releaseId, completedAt: new Date().toISOString(), deliveryWorkflowCommit: process.env.GITHUB_SHA, inputs: inputs.assets, publicByteChecks: { implementation: 'release/marketing/prepare-release.mjs', installerCount: 6, sourceCount: 13, freshQualifiedProofsChecked: true }, catalog: { path: 'apps/marketing/public/downloads/manifest.json', sha256: hashBytes(catalogBytes), bytes: catalogBytes.length }, generatedFiles: generated };
await writeFile(join(directory, 'prepared.verification.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log('Public package/source byte checks passed; generated catalog/proof files and their exact hashes recorded.');
