import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const specification = process.argv[2];
if (!specification) throw new Error('Usage: node release/marketing/prepare-release.mjs <release-specification.json>');
const specPath = resolve(specification);
const spec = JSON.parse(await readFile(specPath, 'utf8'));
if (spec.product !== 'EnoughFactory' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(spec.version) || !Array.isArray(spec.artifacts) || !spec.artifacts.length) throw new Error('Provide an EnoughFactory version and actual artifact files.');
if (!/^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\/?$/.test(spec.sourceUrl)) throw new Error('Provide the actual public source repository URL.');
if (spec.status !== 'published' && spec.status !== 'preparing') throw new Error('Status must be published or preparing.');
const downloadRoot = resolve(root, 'apps/marketing/public/downloads');
const artifacts = [];
for (const artifact of spec.artifacts) {
  if (!['darwin', 'linux'].includes(artifact.platform) || !['x64', 'arm64'].includes(artifact.arch) || !['signed', 'unsigned'].includes(artifact.signing)) throw new Error('Each artifact needs its platform, architecture and accurate signing status.');
  const path = resolve(dirname(specPath), artifact.path);
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`Artifact is not a nonempty file: ${artifact.path}`);
  const filename = basename(path);
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) throw new Error('Artifact filenames may contain letters, numbers, periods, underscores and hyphens.');
  if (!filename.includes(spec.version)) throw new Error(`Artifact filename must include the release version: ${filename}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  if (artifact.sha256 && artifact.sha256 !== sha256) throw new Error(`Checksum does not match ${filename}`);
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
  const format = artifact.format ?? filename.match(/\.(tar\.gz|AppImage|dmg|zip|deb|rpm)$/i)?.[1];
  if (typeof format !== 'string' || !format.length) throw new Error(`Artifact needs a package format: ${filename}`);
  artifacts.push({ platform: artifact.platform, arch: artifact.arch, format, filename, url, sha256, bytes: info.size, signing: artifact.signing });
}
if (new Set(artifacts.map(a => a.filename)).size !== artifacts.length) throw new Error('Artifact filenames must be unique.');
if (spec.status === 'published') {
  for (const target of ['darwin-arm64', 'linux-x64', 'linux-arm64']) {
    if (!artifacts.some(a => `${a.platform}-${a.arch}` === target)) throw new Error(`Release is missing the required ${target} package.`);
  }
  const response = await fetch(spec.sourceUrl, { method: 'HEAD' });
  if (!response.ok) throw new Error('The source repository is not publicly available.');
}
const manifest = { schemaVersion: 1, product: 'EnoughFactory', version: spec.version, status: spec.status, publishedAt: spec.status === 'published' ? new Date().toISOString() : null, sourceUrl: spec.sourceUrl, artifacts };
await mkdir(downloadRoot, { recursive: true });
await writeFile(resolve(downloadRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const checksums = artifacts.map(a => `${a.sha256}  ${a.filename}`).join('\n');
await writeFile(resolve(downloadRoot, 'SHA256SUMS.txt'), `${checksums}\n`);
console.log(`Prepared ${manifest.status} release ${manifest.version} with ${artifacts.length} verified local artifacts.`);
