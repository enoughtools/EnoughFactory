import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineSourceRequirements, hashBytes, ubuntuSourceRequirements } from './source-companions.mjs';
import { verifyArchiveReceipt, verifyRuntimeJourney } from './verify-receipt.mjs';
import { verifyInstalledProofs, verifyPackagedServiceProof } from './verify-installed-proofs.mjs';

const usage = 'Usage: node release/marketing/assemble-specification.mjs <release-directory> <specification.json> [--ubuntu-sources <directory>]';
const [directory, output, flag, ubuntuArgument] = process.argv.slice(2);
if (!directory || !output || (flag !== undefined && (flag !== '--ubuntu-sources' || !ubuntuArgument)) || process.argv.length > 6) throw new Error(usage);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releaseDirectory = resolve(directory);
const outputPath = resolve(output);
const outputDirectory = dirname(outputPath);
const ubuntuDirectory = resolve(ubuntuArgument ?? releaseDirectory);
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const pins = JSON.parse(await readFile(resolve(root, 'runtime/container/pins.json'), 'utf8'));
const sourceUrl = 'https://github.com/enoughtools/EnoughFactory';
const releaseBaseUrl = `${sourceUrl}/releases/download/v${version}`;
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(`^EnoughFactory-${escapedVersion}-(mac|linux)-(arm64|x64)\\.(dmg|zip|AppImage|tar\\.gz)$`);
const artifacts = [];
const receipts = [];
const sourceFiles = new Map();
const verificationFiles = new Map();
const inputPaths = new Set();

async function ordinaryFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error(`A required release input is not a nonempty file: ${path}.`);
  inputPaths.add(path);
  return info;
}

for (const filename of (await readdir(releaseDirectory)).filter(name => pattern.test(name)).sort()) {
  const [, host, arch, format] = filename.match(pattern);
  const platform = host === 'mac' ? 'darwin' : 'linux';
  const path = resolve(releaseDirectory, filename);
  const info = await ordinaryFile(path);
  const verificationPath = `${path}.verification.json`;
  const receipt = JSON.parse(await readFile(verificationPath, 'utf8'));
  verifyArchiveReceipt(receipt, { version, filename, platform, arch, format, bytes: info.size, sha256: receipt.artifact?.sha256 }, pins);
  verifyRuntimeJourney(receipt);
  const servicePath = resolve(releaseDirectory, `${platform}-${arch}.service.verification.json`);
  const guiPath = resolve(releaseDirectory, `${platform}-${arch}.gui.verification.json`);
  const screenshotPath = `${guiPath}.png`;
  const [serviceBytes, guiBytes, screenshotBytes] = await Promise.all([readFile(servicePath), readFile(guiPath), readFile(screenshotPath)]);
  verifyInstalledProofs(receipt, JSON.parse(serviceBytes), JSON.parse(guiBytes), hashBytes(screenshotBytes));
  for (const [verificationPath, bytes] of [[servicePath, serviceBytes], [guiPath, guiBytes], [screenshotPath, screenshotBytes]]) {
    inputPaths.add(verificationPath);
    const filename = relative(releaseDirectory, verificationPath);
    verificationFiles.set(filename, { path: relative(outputDirectory, verificationPath), url: `${releaseBaseUrl}/${filename}`, sha256: hashBytes(bytes), bytes: bytes.length });
  }
  let smokePath;
  if (receipt.componentQualification || platform === 'darwin') {
    const apiPath = resolve(releaseDirectory, `${platform}-${arch}.${receipt.componentQualification ? 'packaged-service-smoke' : 'packaged-service-runtime'}.verification.json`);
    if (receipt.componentQualification) smokePath = apiPath;
    const apiBytes = await readFile(apiPath);
    verifyPackagedServiceProof(receipt, JSON.parse(apiBytes));
    inputPaths.add(apiPath);
    const apiFilename = relative(releaseDirectory, apiPath);
    verificationFiles.set(apiFilename, { path: relative(outputDirectory, apiPath), url: `${releaseBaseUrl}/${apiFilename}`, sha256: hashBytes(apiBytes), bytes: apiBytes.length });
  }
  receipts.push(receipt);
  artifacts.push({ path: relative(outputDirectory, path), platform, arch, format, signing: 'unsigned', verificationPath: relative(outputDirectory, verificationPath), verificationReceiptPaths: { service: relative(outputDirectory, servicePath), gui: relative(outputDirectory, guiPath), ...(smokePath ? { smoke: relative(outputDirectory, smokePath) } : {}) }, url: `${releaseBaseUrl}/${filename}` });
  inputPaths.add(verificationPath);
  for (const source of engineSourceRequirements(receipt)) {
    const sourcePath = resolve(releaseDirectory, source.filename);
    await ordinaryFile(sourcePath);
    sourceFiles.set(source.filename, { path: relative(outputDirectory, sourcePath), url: `${releaseBaseUrl}/${source.filename}` });
  }
}
for (const target of ['darwin-arm64', 'linux-x64', 'linux-arm64']) if (!artifacts.some(artifact => `${artifact.platform}-${artifact.arch}` === target)) throw new Error(`Release inputs are missing ${target} and its passed archive/runtime receipt.`);
if (new Set(receipts.map(receipt => receipt.sourceCommit)).size !== 1) throw new Error('Release packages must match one exact source commit.');
const index = JSON.parse(await readFile(resolve(ubuntuDirectory, 'Ubuntu-source-companion.json'), 'utf8'));
const lockBytes = await readFile(resolve(root, 'runtime/container/os-source-kit/Ubuntu-sources.lock.json'));
for (const source of ubuntuSourceRequirements(index, receipts, pins, lockBytes)) await ordinaryFile(resolve(ubuntuDirectory, source.filename));

const spec = { product: 'EnoughFactory', version, status: 'published', sourceUrl, sourceCommit: receipts[0].sourceCommit, releaseBaseUrl, artifacts, sourceArtifacts: [...sourceFiles.values()], additionalVerificationArtifacts: [...verificationFiles.values()], ubuntuSourceDirectory: relative(outputDirectory, ubuntuDirectory) || '.' };
if (inputPaths.has(outputPath)) throw new Error('Write the specification separately from package, source and verification inputs.');
await mkdir(outputDirectory, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
console.log(`Assembled ${version} specification from ${artifacts.length} packages with passed native receipts, ${sourceFiles.size} engine source assets and the complete Ubuntu companion.`);
console.log('Run prepare-release.mjs only after the matching public GitHub release is ready; it verifies actual archive/source bytes and URLs before updating the catalog.');
