#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { hashBytes, hashFile, ubuntuSourceRequirements } from '../release/marketing/source-companions.mjs';
import { verifyArchiveReceipt, verifyRuntimeJourney } from '../release/marketing/verify-receipt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const baseline = JSON.parse(await readFile(join(root, 'scripts/release-baselines/0.1.1.json'), 'utf8'));
export const repository = 'enoughtools/EnoughFactory';

export async function github(path, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
  assert.ok(path.startsWith(`/repos/${repository}/`), 'Only the EnoughFactory GitHub repository is allowed.');
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}.`);
  return response.json();
}

export async function verifyBaselineRelease() {
  const release = await github(`/repos/${repository}/releases/tags/v0.1.1`);
  assert.equal(release.id, baseline.releaseId, 'The permanent baseline release identity changed.');
  assert.equal(release.tag_name, 'v0.1.1');
  assert.equal(release.draft, false, 'The baseline must remain a public release.');
  assert.equal(release.prerelease, false);
  let object = (await github(`/repos/${repository}/git/ref/tags/v0.1.1`)).object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await github(`/repos/${repository}/git/tags/${object.sha}`)).object;
  assert.equal(object?.type, 'commit', 'The baseline tag must resolve to a commit.');
  assert.equal(object.sha, baseline.sourceCommit, 'The public baseline tag moved from its verified source.');
  return release;
}

export function verifyAssetMetadata(asset, expected) {
  assert.ok(asset && asset.state === 'uploaded', `Release asset is unavailable: ${expected.filename}.`);
  assert.equal(asset.name, expected.filename);
  assert.equal(asset.size, expected.bytes, `Release asset size changed: ${expected.filename}.`);
  assert.equal(asset.digest, `sha256:${expected.sha256}`, `Release asset digest changed: ${expected.filename}.`);
}

export async function downloadAsset(release, expected, directory) {
  const assets = release.assets.filter(asset => asset.name === expected.filename);
  assert.equal(assets.length, 1, `Exactly one selected release asset is required: ${expected.filename}.`);
  const asset = assets[0];
  verifyAssetMetadata(asset, expected);
  const publicUrl = `https://github.com/${repository}/releases/download/v0.1.1/${expected.filename}`;
  assert.equal(asset.browser_download_url, publicUrl, 'The selected source must use the permanent public baseline URL.');
  await mkdir(directory, { recursive: true });
  const file = join(directory, expected.filename);
  try {
    const metadata = await lstat(file);
    assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'A reused download must be an ordinary file.');
    assert.deepEqual(await hashFile(file), { sha256: expected.sha256, bytes: expected.bytes }, 'Existing download differs from the pinned baseline.');
    console.log(`Verified existing baseline asset: ${expected.filename}`);
    return { ...expected, path: file };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(`Downloading verified baseline asset: ${expected.filename} (${expected.bytes} bytes)`);
  const response = await fetch(publicUrl, { redirect: 'follow', signal: AbortSignal.timeout(1_200_000) });
  assert.ok(response.ok && response.body, `Baseline download failed: ${expected.filename} (${response.status}).`);
  const hash = createHash('sha256');
  let bytes = 0, nextProgress = 128 * 1024 * 1024;
  const temporary = `${file}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > expected.bytes) return done(new Error(`Baseline download exceeds its pinned size: ${expected.filename}.`));
      hash.update(chunk);
      if (bytes >= nextProgress) { console.log(`Downloaded ${bytes}/${expected.bytes} bytes: ${expected.filename}`); nextProgress += 128 * 1024 * 1024; }
      done(null, chunk);
    } }), createWriteStream(temporary, { flags: 'wx' }));
    assert.equal(bytes, expected.bytes, 'Baseline download has the wrong size.');
    assert.equal(hash.digest('hex'), expected.sha256, 'Baseline download has the wrong actual byte digest.');
    await rename(temporary, file);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  console.log(`Verified downloaded baseline asset: ${expected.filename}`);
  return { ...expected, path: file };
}

export async function downloadBaselineNative(arch, directory, release = undefined) {
  assert.ok(['arm64', 'x64'].includes(arch), 'Choose a native Linux architecture.');
  release ??= await verifyBaselineRelease();
  const selected = baseline.native[arch];
  const receiptFile = await downloadAsset(release, selected.receipt, directory);
  const receipt = JSON.parse(await readFile(receiptFile.path, 'utf8'));
  const pins = JSON.parse(await readFile(join(root, 'runtime/container/pins.json'), 'utf8'));
  verifyArchiveReceipt(receipt, { ...selected.archive, version: '0.1.1', platform: 'linux', arch, format: 'tar.gz' }, pins);
  assert.equal(receipt.sourceCommit, baseline.sourceCommit);
  verifyRuntimeJourney(receipt);
  const archive = await downloadAsset(release, selected.archive, directory);
  return [archive, receiptFile];
}

export async function downloadBaselineUbuntu(directory, release = undefined) {
  release ??= await verifyBaselineRelease();
  assert.equal(baseline.ubuntu.length, 7, 'The chosen baseline must include all seven Ubuntu assets.');
  const indexFile = baseline.ubuntu.find(asset => asset.role === 'index');
  assert.equal(indexFile.sha256, '70aae28ae71172ff64897506285cf2fd6963fe52bf648c430073ff7e7b63c81b');
  const downloadedIndex = await downloadAsset(release, indexFile, directory);
  const indexBytes = await readFile(downloadedIndex.path);
  const index = JSON.parse(indexBytes);
  assert.equal(hashBytes(indexBytes), baseline.ubuntuSourceIndexSha256);
  const pins = JSON.parse(await readFile(join(root, 'runtime/container/pins.json'), 'utf8'));
  const lockBytes = await readFile(join(root, 'runtime/container/os-source-kit/Ubuntu-sources.lock.json'));
  const required = ubuntuSourceRequirements(index, [], pins, lockBytes);
  assert.equal(required.length, 7);
  assert.deepEqual(Object.keys(index.ubuntuImages).sort(), Object.keys(pins.images).sort());
  for (const [arch, image] of Object.entries(pins.images)) {
    assert.equal(index.ubuntuImages[arch].url, image.url);
    assert.equal(index.ubuntuImages[arch].sha256, image.sha256, 'Ubuntu sources must correspond to the current bundled guest images.');
  }
  for (const expected of baseline.ubuntu) {
    const matched = required.find(asset => asset.filename === expected.filename && asset.role === expected.role);
    assert.ok(matched, 'The selected Ubuntu asset set differs from the current source closure.');
    if (matched.sha256) assert.equal(expected.sha256, matched.sha256);
    if (matched.bytes) assert.equal(expected.bytes, matched.bytes);
  }
  const files = [downloadedIndex];
  for (const expected of baseline.ubuntu.filter(asset => asset !== indexFile)) files.push(await downloadAsset(release, expected, directory));
  assert.equal(hashBytes(await readFile(join(directory, 'Ubuntu-sources.lock.json'))), hashBytes(lockBytes), 'Downloaded source lock differs from the current tracked lock.');
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === '--native' && ['arm64', 'x64'].includes(args[1]) && args[2] === '--output' && args[3] && args.length === 4) await downloadBaselineNative(args[1], resolve(args[3]));
  else if (args[0] === '--ubuntu' && args[1] === '--output' && args[2] && args.length === 3) await downloadBaselineUbuntu(resolve(args[2]));
  else throw new Error('Usage: node scripts/download-verified-baseline.mjs --native <arm64|x64> --output <directory> | --ubuntu --output <directory>');
}
