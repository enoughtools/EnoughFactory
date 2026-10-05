import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { verifyArchiveReceipt, verifyPublishedCatalog, verifyRuntimeJourney } from './verify-receipt.mjs';

const pins = JSON.parse(await readFile(new URL('../../runtime/container/pins.json', import.meta.url), 'utf8'));
const hash = 'a'.repeat(64);
const sourceCommit = 'b'.repeat(40);
const requiredChecks = ['installed resource hashes match bundle provenance', 'private socket, labeled daemon and data root', 'rootless Engine 29.8.2', 'container uid0 and root filesystem writes', 'container reaches the device service host loopback bridge', 'container HTTP port forwarding', 'service reconnect adopts the existing owned engine', 'native envmux workbench readiness', 'native envmux full root execution', 'native envmux stop returns exact source commit', 'private engine stop and restart retain named volume contents', 'inherited user Docker context and TLS settings ignored', 'user Docker configuration unchanged'];

// Contract fixtures stay in this test; they are never public verification records.
function fixture() {
  const artifact = { version: '0.1.0', platform: 'linux', arch: 'x64', format: 'tar.gz', filename: 'EnoughFactory-0.1.0-linux-x64.tar.gz', bytes: 1000, sha256: hash };
  const paths = ['runtime/node', 'device/service.cjs', 'envmux/envmux', 'web/index.html', 'notices/LICENSE', 'notices/THIRD_PARTY_NOTICES.md', 'runtime/container/provenance.json', 'runtime/container/pins.json', 'runtime/container/docker/bin/docker', 'runtime/container/docker/bin/dockerd', 'runtime/container/docker/bin/dockerd-rootless.sh', 'runtime/container/docker/bin/rootlesskit', 'runtime/container/docker/bin/containerd', 'runtime/container/docker/bin/runc', ...Array.from({ length: 7 }, (_, index) => `web/assets/fixture-${index}.js`)];
  const receipt = {
    formatVersion: 1, product: 'EnoughFactory', version: artifact.version, platform: artifact.platform, arch: artifact.arch, sourceCommit, verifiedAt: '2026-10-05T10:00:00Z', verificationScope: 'desktop-archive',
    artifact: { filename: artifact.filename, bytes: artifact.bytes, sha256: artifact.sha256 }, extraction: { format: artifact.format },
    resources: { bundleProvenanceSha256: hash, fileCount: paths.length, hashesVerified: true, manifest: Object.fromEntries(paths.map(path => [path, hash])) },
    native: { node: { platform: artifact.platform, arch: artifact.arch, version: 'v22.22.0' }, webRtc: 'loaded-from-installed-tree', envmux: 'native-executable', service: 'authenticated-health-and-catalog', unauthenticatedStateStatus: 401 },
    containerRuntime: { dockerVersion: pins.dockerVersion, archivePins: ['docker-linux-x64', 'rootless-linux-x64'].map(component => ({ component, ...pins.archives[component] })), assetsVerified: true, dedicatedSocket: 'inside-isolated-device-state' },
    runtimeJourney: { formatVersion: 1, product: 'EnoughFactory', suite: 'private-linux-runtime', status: 'passed', platform: artifact.platform, arch: artifact.arch, startedAt: '2026-10-05T09:00:00Z', completedAt: '2026-10-05T09:10:00Z', bundle: { manifestSha256: hash, sourceCommit, version: artifact.version, platform: artifact.platform, arch: artifact.arch }, runtimeProvenanceSha256: hash, envmuxSha256: hash, dockerVersion: pins.dockerVersion, checks: requiredChecks }
  };
  return { artifact, receipt };
}

test('archive and runtime evidence must bind to the same exact package and resource provenance', () => {
  const { artifact, receipt } = fixture();
  assert.equal(verifyArchiveReceipt(receipt, artifact, pins), receipt);
  assert.equal(verifyRuntimeJourney(receipt), receipt.runtimeJourney);
  assert.throws(() => verifyArchiveReceipt(receipt, { ...artifact, sha256: 'c'.repeat(64) }, pins), /digest/);
  assert.throws(() => verifyArchiveReceipt(receipt, { ...artifact, arch: 'arm64' }, pins), /identity/);
  receipt.runtimeJourney.bundle.manifestSha256 = 'd'.repeat(64);
  assert.throws(() => verifyRuntimeJourney(receipt), /does not match/);
});

test('source folder proofs, missing engines and mislabeled formats do not establish an installed release', () => {
  const { artifact, receipt } = fixture();
  assert.throws(() => verifyArchiveReceipt({ ...receipt, verificationScope: 'installed-desktop-resources' }, artifact, pins), /identity/);
  assert.throws(() => verifyArchiveReceipt(receipt, { ...artifact, format: 'AppImage' }, pins), /format/);
  delete receipt.resources.manifest['runtime/container/docker/bin/dockerd'];
  receipt.resources.fileCount--;
  assert.throws(() => verifyArchiveReceipt(receipt, artifact, pins), /missing owned runtime/);
});

test('runtime success needs workbench, full container execution and isolation coverage', () => {
  const { receipt } = fixture();
  receipt.runtimeJourney.checks = requiredChecks.filter(check => check !== 'native envmux full root execution');
  assert.throws(() => verifyRuntimeJourney(receipt), /required native workbench/);
  receipt.runtimeJourney.checks = requiredChecks;
  receipt.runtimeJourney.status = 'failed';
  assert.throws(() => verifyRuntimeJourney(receipt), /missing or does not match/);
});

test('published catalog cannot substitute readiness, a missing target or an unsupported signing claim', () => {
  const makeArtifact = (platform, arch) => ({ platform, arch, format: platform === 'darwin' ? 'zip' : 'tar.gz', filename: `EnoughFactory-0.1.0-${platform}-${arch}.${platform === 'darwin' ? 'zip' : 'tar.gz'}`, sha256: hash, bytes: 1000, signing: 'unsigned' });
  const artifacts = [['darwin', 'arm64'], ['linux', 'x64'], ['linux', 'arm64']].map(([platform, arch]) => { const artifact = makeArtifact(platform, arch); return { ...artifact, url: `/downloads/0.1.0/${artifact.filename}`, verificationUrl: `/downloads/0.1.0/${artifact.filename}.verification.json` }; });
  const manifest = { schemaVersion: 1, product: 'EnoughFactory', version: '0.1.0', status: 'published', publishedAt: '2026-10-05T10:00:00Z', sourceUrl: 'https://github.com/enoughtools/EnoughFactory', sourceCommit, artifacts };
  assert.equal(verifyPublishedCatalog(manifest), manifest);
  assert.throws(() => verifyPublishedCatalog({ ...manifest, status: 'preparing' }), /Prepare the verified/);
  assert.throws(() => verifyPublishedCatalog({ ...manifest, artifacts: artifacts.slice(1) }), /darwin-arm64/);
  assert.throws(() => verifyPublishedCatalog({ ...manifest, artifacts: [{ ...artifacts[0], signing: 'signed' }, ...artifacts.slice(1)] }), /invalid verification record/);
});
