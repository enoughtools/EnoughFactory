#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { componentQualificationRequirements } from '../release/marketing/verify-component-qualification.mjs';
import { github } from './download-verified-baseline.mjs';

const repository = 'enoughtools/EnoughFactory';
const commit = 'c71a3a91861c3dd3bd11ab90b9edbc740aa0f12e';
async function hashFile(file) { const hash = createHash('sha256'); let bytes = 0; for await (const chunk of createReadStream(file)) { bytes += chunk.length; hash.update(chunk); } return { sha256: hash.digest('hex'), bytes }; }

/** Preserve the original published proofs; none are rebadged as a new run. */
export async function downloadComponentBaseline(platform, arch, output, guestEngineFrom) {
  const requirements = componentQualificationRequirements(platform, arch);
  const release = await github(`/repos/${repository}/releases/tags/v0.1.2`);
  assert.equal(release.tag_name, 'v0.1.2'); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  let object = (await github(`/repos/${repository}/git/ref/tags/v0.1.2`)).object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await github(`/repos/${repository}/git/tags/${object.sha}`)).object;
  assert.equal(object?.type, 'commit'); assert.equal(object.sha, commit, 'The component baseline tag moved.');
  await mkdir(output, { recursive: true });
  const records = [
    { filename: `${requirements.baseline.archive.filename}.verification.json`, sha256: requirements.baseline.archive.receiptSha256, url: requirements.baseline.archive.receiptUrl },
    requirements.baseline.runtime,
    ...(requirements.baseline.api ? [requirements.baseline.api] : []),
  ];
  await Promise.all(records.map(record => download(record)));
  if (platform === 'darwin' && guestEngineFrom !== undefined) {
    const expected = requirements.assets['runtime/container/docker/guest-engine.tgz'];
    assert.match(expected, /^[a-f0-9]{64}$/);
    const target = join(output, 'guest-engine.tgz');
    if (guestEngineFrom) {
      assert.equal((await lstat(guestEngineFrom)).isFile(), true);
      assert.equal((await hashFile(guestEngineFrom)).sha256, expected, 'The supplied historical guest engine bytes changed.');
      await copyFile(guestEngineFrom, target);
    } else {
      assert.equal(arch, 'arm64');
      const archive = await download({ filename: 'EnoughFactory-0.1.2-mac-arm64.zip', url: `https://github.com/${repository}/releases/download/v0.1.2/EnoughFactory-0.1.2-mac-arm64.zip`, sha256: 'ab62304268dbb9eed0814bae53fe874036650a496152ec2c028a508b91f2fc02', bytes: 1024522382 });
      // The complete ZIP identity is pinned; extract only its exact ordinary member.
      execFileSync('python3', ['-c', 'import zipfile,shutil,sys,stat\nwith zipfile.ZipFile(sys.argv[1]) as z:\n i=z.getinfo("EnoughFactory.app/Contents/Resources/runtime/container/docker/guest-engine.tgz")\n assert i.file_size>0 and i.file_size<200*1024*1024 and not stat.S_ISLNK(i.external_attr>>16)\n with z.open(i) as source, open(sys.argv[2],"wb") as target: shutil.copyfileobj(source,target)\n', archive, target], { timeout: 120_000 });
    }
    assert.equal((await hashFile(target)).sha256, expected, 'Historical guest engine member differs from the component baseline.');
  }
  console.log(JSON.stringify({ directory: resolve(output), baselineVersion: '0.1.2', baselineSourceCommit: commit, platform, arch }));
  return output;

  async function download(record) {
    const url = `https://github.com/${repository}/releases/download/v0.1.2/${record.filename}`;
    assert.equal(record.url, url);
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
    const assets = release.assets.filter(asset => asset.name === record.filename);
    assert.equal(assets.length, 1, `A unique baseline asset is required: ${record.filename}`);
    const asset = assets[0];
    assert.equal(asset.state, 'uploaded'); assert.equal(asset.digest, `sha256:${record.sha256}`); assert.equal(asset.browser_download_url, url);
    if (record.bytes !== undefined) assert.equal(asset.size, record.bytes);
    assert.ok(asset.size > 0 && asset.size <= (record.filename.endsWith('.zip') ? 2_000_000_000 : 4_000_000));
    const file = join(output, record.filename);
    try { const metadata = await lstat(file); assert.ok(metadata.isFile() && !metadata.isSymbolicLink()); assert.deepEqual(await hashFile(file), { sha256: record.sha256, bytes: asset.size }); return file; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(1_200_000) });
    assert.ok(response.ok && response.body, `Baseline download failed: ${record.filename}`);
    const temporary = `${file}.download`; const hash = createHash('sha256'); let bytes = 0;
    try {
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; if (bytes > asset.size) return done(new Error('Baseline download exceeds its pinned size.')); hash.update(chunk); done(null, chunk); } }), createWriteStream(temporary, { flags: 'wx' }));
      assert.equal(bytes, asset.size); assert.equal(hash.digest('hex'), record.sha256); await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    return file;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
  if (process.argv.includes('--help')) { console.log('Usage: node scripts/download-component-baseline.mjs --platform darwin|linux --arch arm64|x64 --output <directory> [--guest-engine [--guest-engine-from <prior guest-engine.tgz>]]'); process.exit(0); }
  if (!value('--platform') || !value('--arch') || !value('--output')) throw new Error('Pass the native platform, architecture and baseline output directory.');
  await downloadComponentBaseline(value('--platform'), value('--arch'), resolve(value('--output')), process.argv.includes('--guest-engine') ? value('--guest-engine-from') ?? '' : undefined);
}
