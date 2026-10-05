import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeFilename = value => typeof value === 'string' && /^[a-zA-Z0-9._-]+$/.test(value);
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');

export async function hashFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`Source asset is not a nonempty ordinary file: ${basename(path)}.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { sha256: hash.digest('hex'), bytes: info.size };
}

export function releaseAssetUrl(base, filename, sourceUrl) {
  if (!safeFilename(filename) || typeof base !== 'string' || !base.startsWith(`${sourceUrl.replace(/\/$/, '')}/releases/download/`) || !/^[a-zA-Z0-9._-]+$/.test(base.split('/').at(-1))) throw new Error('Runtime sources must use the actual public GitHub release URL.');
  return `${base}/${filename}`;
}

export function engineSourceRequirements(receipt) {
  const proof = receipt.containerRuntime?.engineSourceBuild;
  const manifest = receipt.resources?.manifest;
  const filename = `EnoughFactory-${receipt.version}-${receipt.platform}-${receipt.arch}-container-sources.tar.gz`;
  const companion = proof?.sourceCompanion;
  const components = ['dockerd', 'docker-proxy', 'runc', 'docker-init'];
  if (!manifest || !digest(proof?.provenanceSha256) || proof.provenanceSha256 !== manifest['runtime/container/engine-provenance.json'] || companion?.file !== `sources/${filename}` || companion.receiptFile !== `${companion.file}.json` || !digest(companion.sha256) || companion.sha256 !== manifest[`runtime/container/${companion.file}`] || !digest(manifest[`runtime/container/${companion.receiptFile}`]) || !Array.isArray(proof.components) || proof.components.length !== components.length || new Set(proof.components.map(component => component.name)).size !== components.length || components.some(name => !proof.components.some(component => component.name === name && digest(component.sha256) && typeof component.source === 'string' && component.source.length && typeof component.buildMode === 'string' && component.buildMode.length && (receipt.platform !== 'linux' || component.sha256 === manifest[`runtime/container/docker/bin/${name}`])))) throw new Error(`The archive lacks matching source-built engine and relink evidence: ${receipt.artifact.filename}.`);
  return [
    { kind: 'container-engine', role: 'archive', platform: receipt.platform, arch: receipt.arch, filename, sha256: companion.sha256 },
    { kind: 'container-engine', role: 'receipt', platform: receipt.platform, arch: receipt.arch, filename: `${filename}.json`, sha256: manifest[`runtime/container/${companion.receiptFile}`] }
  ];
}

export function ubuntuSourceRequirements(index, receipts, pins, lockBytes) {
  const lock = JSON.parse(lockBytes);
  if (index?.formatVersion !== 1 || !Array.isArray(index.parts) || index.parts.length < 1 || index.lockSha256 !== hashBytes(lockBytes) || !index.evidence || !Array.isArray(lock.packages)) throw new Error('The Ubuntu source index does not match the audited source lock.');
  const expectedPackages = new Set(lock.packages.map(pkg => `${pkg.name}\0${pkg.version}`));
  const actualPackages = index.parts.flatMap(part => Array.isArray(part.packages) ? part.packages.map(pkg => `${pkg.name}\0${pkg.version}`) : []);
  if (index.sourcePackages !== expectedPackages.size || actualPackages.length !== expectedPackages.size || new Set(actualPackages).size !== expectedPackages.size || actualPackages.some(pkg => !expectedPackages.has(pkg)) || index.sourceFiles !== new Set(lock.packages.flatMap(pkg => pkg.files.map(file => file.filename))).size) throw new Error('The Ubuntu source parts do not cover every locked package and source member.');
  for (const receipt of receipts.filter(receipt => receipt.platform === 'darwin')) {
    const image = index.ubuntuImages?.[receipt.arch];
    if (image?.sha256 !== pins.images[receipt.arch].sha256 || image.url !== pins.images[receipt.arch].url || image.sha256 !== receipt.resources.manifest['runtime/container/images/guest.img']) throw new Error('The Ubuntu source companion belongs to another bundled guest image.');
  }
  const described = [...index.parts.map(part => ({ ...part, role: 'part' })), { ...index.evidence, role: 'evidence' }];
  if (described.some(asset => !safeFilename(asset.filename) || !digest(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0) || new Set(described.map(asset => asset.filename)).size !== described.length) throw new Error('The Ubuntu source index has invalid or duplicated source assets.');
  return [
    ...described.map(asset => ({ kind: 'ubuntu', role: asset.role, filename: asset.filename, sha256: asset.sha256, bytes: asset.size })),
    { kind: 'ubuntu', role: 'lock', filename: 'Ubuntu-sources.lock.json', sha256: index.lockSha256 },
    { kind: 'ubuntu', role: 'index', filename: 'Ubuntu-source-companion.json' },
    { kind: 'ubuntu', role: 'checksums', filename: 'Ubuntu-source-companion-SHA256SUMS' },
    { kind: 'ubuntu', role: 'readme', filename: 'Ubuntu-source-companion-README.md' }
  ];
}

export function verifySourceCatalog(manifest, receipts, pins, indexBytes, lockBytes) {
  const index = JSON.parse(indexBytes);
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) throw new Error('Public runtime source downloads are missing from the release catalog.');
  const required = new Map();
  for (const entry of [...receipts.flatMap(engineSourceRequirements), ...ubuntuSourceRequirements(index, receipts, pins, lockBytes)]) {
    const previous = required.get(entry.filename);
    if (previous && previous.sha256 !== entry.sha256) throw new Error('Archives for one target contain different source companions.');
    required.set(entry.filename, entry);
  }
  if (new Set(manifest.sources.map(source => source.filename)).size !== manifest.sources.length || manifest.sources.length !== required.size) throw new Error('Runtime source assets are missing, duplicated or unrelated to the release.');
  for (const source of manifest.sources) {
    const expected = required.get(source.filename);
    if (!expected || source.kind !== expected.kind || source.role !== expected.role || source.platform !== expected.platform || source.arch !== expected.arch || !digest(source.sha256) || (expected.sha256 && source.sha256 !== expected.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0 || (expected.bytes && source.bytes !== expected.bytes) || source.url !== releaseAssetUrl(manifest.releaseBaseUrl, source.filename, manifest.sourceUrl)) throw new Error(`Public runtime source does not match its bundle metadata: ${source.filename}.`);
  }
  const indexAsset = manifest.sources.find(source => source.role === 'index' && source.kind === 'ubuntu');
  if (indexAsset.sha256 !== hashBytes(indexBytes) || manifest.ubuntuSourceIndexSha256 !== indexAsset.sha256) throw new Error('The public Ubuntu index lacks its exact content binding.');
  return manifest.sources;
}

export async function verifyPublicAsset(asset) {
  const response = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(900_000) });
  if (!response.ok || !response.body) throw new Error(`Public runtime source is unavailable: ${asset.filename} (${response.status}).`);
  const declared = Number(response.headers.get('content-length'));
  if (!response.headers.get('content-encoding') && declared > 0 && declared !== asset.bytes) throw new Error(`Public runtime source size differs: ${asset.filename}.`);
  const hash = createHash('sha256'); let transferred = 0;
  for await (const chunk of response.body) {
    transferred += chunk.byteLength;
    if (transferred > asset.bytes) throw new Error(`Public runtime source exceeds its verified size: ${asset.filename}.`);
    hash.update(chunk);
  }
  if (transferred !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new Error(`Public runtime source content differs: ${asset.filename}.`);
}
