import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArchiveReceipt, verifyPublishedCatalog, verifyRuntimeJourney } from './verify-receipt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const specification = process.argv[2];
if (!specification) throw new Error('Usage: node release/marketing/prepare-release.mjs <release-specification.json>');
const specPath = resolve(specification);
const spec = JSON.parse(await readFile(specPath, 'utf8'));
if (spec.product !== 'EnoughFactory' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(spec.version) || !Array.isArray(spec.artifacts) || !spec.artifacts.length) throw new Error('Provide an EnoughFactory version and actual artifact files.');
if (!/^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/?$/.test(spec.sourceUrl)) throw new Error('Provide the actual public source repository URL.');
if (spec.status !== 'published' && spec.status !== 'preparing') throw new Error('Status must be published or preparing.');
const downloadRoot = resolve(root, 'apps/marketing/public/downloads');
const pins = JSON.parse(await readFile(resolve(root, 'runtime/container/pins.json'), 'utf8'));
const artifacts = [];
const receipts = [];
for (const artifact of spec.artifacts) {
  if (!['darwin', 'linux'].includes(artifact.platform) || !['x64', 'arm64'].includes(artifact.arch) || !['signed', 'unsigned'].includes(artifact.signing)) throw new Error('Each artifact needs its platform, architecture and accurate signing status.');
  const path = resolve(dirname(specPath), artifact.path);
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`Artifact is not a nonempty file: ${artifact.path}`);
  const filename = basename(path);
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error('Artifact filenames may contain letters, numbers, periods, underscores and hyphens.');
  if (!filename.includes(spec.version)) throw new Error(`Artifact filename must include the release version: ${filename}`);
  const format = filename.match(/\.(tar\.gz|AppImage|dmg|zip)$/i)?.[1];
  const targetFormats = artifact.platform === 'darwin' ? ['dmg', 'zip'] : ['appimage', 'tar.gz'];
  if (!format || !targetFormats.includes(format.toLowerCase()) || (artifact.format !== undefined && (typeof artifact.format !== 'string' || artifact.format.toLowerCase() !== format.toLowerCase()))) throw new Error(`Artifact format must match its actual desktop archive and target: ${filename}`);
  if (artifact.signing !== 'unsigned') throw new Error('Native signing verification is not implemented; this release catalog must describe the actual unsigned packages.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (artifact.sha256 && artifact.sha256 !== sha256) throw new Error(`Checksum does not match ${filename}`);
  let verificationUrl;
  if (spec.status === 'published' && !artifact.verificationPath) throw new Error(`Published package requires an actual extracted archive verification receipt: ${filename}`);
  if (artifact.verificationPath) {
    const receipt = verifyArchiveReceipt(JSON.parse(await readFile(resolve(dirname(specPath), artifact.verificationPath), 'utf8')), { version: spec.version, filename, sha256, bytes: info.size, platform: artifact.platform, arch: artifact.arch, format }, pins);
    if (spec.status === 'published') verifyRuntimeJourney(receipt);
    receipts.push(receipt);
    await mkdir(resolve(downloadRoot, spec.version), { recursive: true });
    const publicReceipt = { ...receipt, ...(receipt.runtimeJourney ? { runtimeJourney: { ...receipt.runtimeJourney, proofDirectory: undefined } } : {}) };
    await writeFile(resolve(downloadRoot, spec.version, `${filename}.verification.json`), `${JSON.stringify(publicReceipt, null, 2)}\n`);
    verificationUrl = `/downloads/${spec.version}/${filename}.verification.json`;
  }
  let url = artifact.url;
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('External artifact URLs must be HTTPS without embedded credentials.');
    if (spec.status === 'published') {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`Published artifact is unavailable: ${filename} (${response.status})`);
      const remoteSize = Number(response.headers.get('content-length'));
      if (remoteSize > 0 && remoteSize !== info.size) throw new Error(`Published artifact size differs: ${filename}`);
      if (!response.body) throw new Error(`Published artifact has no content: ${filename}`);
      const remoteHash = createHash('sha256');
      let transferred = 0;
      for await (const chunk of response.body) { remoteHash.update(chunk); transferred += chunk.byteLength; }
      if (transferred !== info.size || remoteHash.digest('hex') !== sha256) throw new Error(`Published artifact content differs: ${filename}`);
    }
  } else {
    if (info.size > 25 * 1024 * 1024) throw new Error(`Host ${filename} on the actual release repository and supply its HTTPS URL; it exceeds the Workers asset limit.`);
    await mkdir(resolve(downloadRoot, spec.version), { recursive: true });
    await copyFile(path, resolve(downloadRoot, spec.version, filename));
    url = `/downloads/${spec.version}/${filename}`;
  }
  artifacts.push({ platform: artifact.platform, arch: artifact.arch, format, filename, url, sha256, bytes: info.size, signing: artifact.signing, ...(verificationUrl ? { verificationUrl } : {}) });
}
if (new Set(artifacts.map(a => a.filename)).size !== artifacts.length) throw new Error('Artifact filenames must be unique.');
if (spec.status === 'published') {
  if (new Set(receipts.map(receipt => receipt.sourceCommit)).size !== 1 || (spec.sourceCommit && receipts.some(receipt => receipt.sourceCommit !== spec.sourceCommit))) throw new Error('Every published archive must match the same release source commit.');
  for (const target of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
    if (!artifacts.some(a => `${a.platform}-${a.arch}` === target)) throw new Error(`Release is missing the required ${target} package.`);
  }
  const response = await fetch(spec.sourceUrl, { method: 'HEAD' });
  if (!response.ok) throw new Error('The source repository is not publicly available.');
  const sourceResponse = await fetch(`${spec.sourceUrl.replace(/\/$/, '')}/commit/${receipts[0].sourceCommit}`, { method: 'HEAD' });
  if (!sourceResponse.ok) throw new Error('The verified package source commit is not publicly available.');
}
const manifest = { schemaVersion: 1, product: 'EnoughFactory', version: spec.version, status: spec.status, publishedAt: spec.status === 'published' ? new Date().toISOString() : null, sourceUrl: spec.sourceUrl, ...(receipts[0] ? { sourceCommit: receipts[0].sourceCommit } : {}), artifacts };
if (manifest.status === 'published') verifyPublishedCatalog(manifest);
await mkdir(downloadRoot, { recursive: true });
await writeFile(resolve(downloadRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const checksums = artifacts.map(a => `${a.sha256}  ${a.filename}`).join('\n');
await writeFile(resolve(downloadRoot, 'SHA256SUMS.txt'), `${checksums}\n`);
console.log(`Prepared ${manifest.status} release ${manifest.version} with ${artifacts.length} verified local artifacts.`);
