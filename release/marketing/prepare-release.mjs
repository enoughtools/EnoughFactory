import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyArchiveReceipt, verifyPublishedCatalog, verifyRuntimeJourney } from './verify-receipt.mjs';
import { verifyInstalledProofs, verifyPackagedServiceSmoke } from './verify-installed-proofs.mjs';
import { engineSourceRequirements, hashBytes, hashFile, releaseAssetUrl, ubuntuSourceRequirements, verifyPublicAsset, verifySourceCatalog } from './source-companions.mjs';

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
const sources = [];
let ubuntuSourceIndexSha256;
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
  let verificationReceiptUrls;
  if (spec.status === 'published' && !artifact.verificationPath) throw new Error(`Published package requires an actual extracted archive verification receipt: ${filename}`);
  if (artifact.verificationPath) {
    const receipt = verifyArchiveReceipt(JSON.parse(await readFile(resolve(dirname(specPath), artifact.verificationPath), 'utf8')), { version: spec.version, filename, sha256, bytes: info.size, platform: artifact.platform, arch: artifact.arch, format }, pins);
    if (spec.status === 'published') verifyRuntimeJourney(receipt);
    if (receipt.componentQualification) {
      const proofs = {};
      verificationReceiptUrls = {};
      for (const [name, suite] of [['service', 'service'], ['gui', 'gui'], ['smoke', 'packaged-service-smoke']]) {
        const input = artifact.verificationReceiptPaths?.[name];
        const expected = `${artifact.platform}-${artifact.arch}.${suite}.verification.json`;
        if (typeof input !== 'string' || basename(input) !== expected) throw new Error(`Qualified delivery requires the current ${name} proof: ${filename}.`);
        const bytes = await readFile(resolve(dirname(specPath), input));
        proofs[name] = JSON.parse(bytes);
        verificationReceiptUrls[name] = `/downloads/${spec.version}/${expected}`;
        await mkdir(resolve(downloadRoot, spec.version), { recursive: true });
        await writeFile(resolve(downloadRoot, spec.version, expected), bytes);
        if (spec.status === 'published') await verifyPublicAsset({ filename: expected, url: releaseAssetUrl(spec.releaseBaseUrl, expected, spec.sourceUrl), sha256: hashBytes(bytes), bytes: bytes.length });
      }
      const screenshotPath = `${resolve(dirname(specPath), artifact.verificationReceiptPaths.gui)}.png`;
      const screenshot = await readFile(screenshotPath);
      verifyInstalledProofs(receipt, proofs.service, proofs.gui, hashBytes(screenshot));
      verifyPackagedServiceSmoke(receipt, proofs.smoke);
      const screenshotFilename = basename(screenshotPath);
      await writeFile(resolve(downloadRoot, spec.version, screenshotFilename), screenshot);
      if (spec.status === 'published') await verifyPublicAsset({ filename: screenshotFilename, url: releaseAssetUrl(spec.releaseBaseUrl, screenshotFilename, spec.sourceUrl), sha256: hashBytes(screenshot), bytes: screenshot.length });
    }
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
  artifacts.push({ platform: artifact.platform, arch: artifact.arch, format, filename, url, sha256, bytes: info.size, signing: artifact.signing, ...(verificationUrl ? { verificationUrl } : {}), ...(verificationReceiptUrls ? { verificationReceiptUrls } : {}) });
}
if (new Set(artifacts.map(a => a.filename)).size !== artifacts.length) throw new Error('Artifact filenames must be unique.');
if (spec.status === 'published') {
  if (new Set(receipts.map(receipt => receipt.sourceCommit)).size !== 1 || (spec.sourceCommit && receipts.some(receipt => receipt.sourceCommit !== spec.sourceCommit))) throw new Error('Every published archive must match the same release source commit.');
  for (const target of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
    if (!artifacts.some(a => `${a.platform}-${a.arch}` === target)) throw new Error(`Release is missing the required ${target} package.`);
  }
  if (!Array.isArray(spec.sourceArtifacts)) throw new Error('Provide the actual per-target engine source archives and JSON receipts as sourceArtifacts.');
  const ubuntuDirectory = spec.ubuntuSourceDirectory ? resolve(dirname(specPath), spec.ubuntuSourceDirectory) : resolve(root, 'dist/ubuntu-source-companion');
  const indexBytes = await readFile(resolve(ubuntuDirectory, 'Ubuntu-source-companion.json'));
  const lockBytes = await readFile(resolve(root, 'runtime/container/os-source-kit/Ubuntu-sources.lock.json'));
  const required = new Map();
  for (const entry of [...receipts.flatMap(engineSourceRequirements), ...ubuntuSourceRequirements(JSON.parse(indexBytes), receipts, pins, lockBytes)]) {
    const previous = required.get(entry.filename);
    if (previous && previous.sha256 !== entry.sha256) throw new Error('Archives for one target contain different source companions.');
    required.set(entry.filename, entry);
  }
  for (const requirement of required.values()) {
    const supplied = spec.sourceArtifacts.find(source => typeof source.path === 'string' && basename(source.path) === requirement.filename);
    const path = requirement.kind === 'ubuntu' ? resolve(ubuntuDirectory, requirement.filename) : supplied ? resolve(dirname(specPath), supplied.path) : undefined;
    if (!path) throw new Error(`Provide the actual embedded source companion file: ${requirement.filename}.`);
    const content = await hashFile(path);
    if ((requirement.sha256 && content.sha256 !== requirement.sha256) || (requirement.bytes && content.bytes !== requirement.bytes)) throw new Error(`Runtime source asset does not match the verified bundle or Ubuntu index: ${requirement.filename}.`);
    const url = releaseAssetUrl(spec.releaseBaseUrl, requirement.filename, spec.sourceUrl);
    if (supplied?.url && supplied.url !== url) throw new Error('Runtime source assets must be on the same actual public GitHub release.');
    const source = { ...requirement, ...content, url };
    console.log(`Verifying public runtime source: ${source.filename}`);
    await verifyPublicAsset(source);
    sources.push(source);
  }
  ubuntuSourceIndexSha256 = hashBytes(indexBytes);
  await mkdir(resolve(downloadRoot, spec.version), { recursive: true });
  await writeFile(resolve(downloadRoot, spec.version, 'Ubuntu-source-companion.json'), indexBytes);
  verifySourceCatalog({ ...spec, sources, ubuntuSourceIndexSha256 }, receipts, pins, indexBytes, lockBytes);
  const response = await fetch(spec.sourceUrl, { method: 'HEAD' });
  if (!response.ok) throw new Error('The source repository is not publicly available.');
  const sourceResponse = await fetch(`${spec.sourceUrl.replace(/\/$/, '')}/commit/${receipts[0].sourceCommit}`, { method: 'HEAD' });
  if (!sourceResponse.ok) throw new Error('The verified package source commit is not publicly available.');
}
const manifest = { schemaVersion: 1, product: 'EnoughFactory', version: spec.version, status: spec.status, publishedAt: spec.status === 'published' ? new Date().toISOString() : null, sourceUrl: spec.sourceUrl, ...(receipts[0] ? { sourceCommit: receipts[0].sourceCommit } : {}), artifacts, ...(sources.length ? { releaseBaseUrl: spec.releaseBaseUrl, ubuntuSourceIndexSha256, sources } : {}) };
if (manifest.status === 'published') verifyPublishedCatalog(manifest);
await mkdir(downloadRoot, { recursive: true });
await writeFile(resolve(downloadRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const checksums = [...artifacts, ...sources].map(a => `${a.sha256}  ${a.filename}`).join('\n');
await writeFile(resolve(downloadRoot, 'SHA256SUMS.txt'), `${checksums}\n`);
console.log(`Prepared ${manifest.status} release ${manifest.version} with ${artifacts.length} verified local artifacts.`);
