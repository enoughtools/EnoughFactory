const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
import { verifyComponentQualification } from './verify-component-qualification.mjs';
// Exact record/event fixture retained by scripts/installed-service-data-boundary.mjs.
const retainedFixtureSha256 = '05e7b797d3631820402dcabd6d0191e48b88c029f854b6bf9dfb13908a31252a';

function requiresDataBoundary(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)?.slice(1).map(Number);
  return !parts || parts[0] > 0 || parts[1] > 1 || (parts[1] === 1 && parts[2] >= 2);
}

export function verifyServiceDataBoundary(archive, service) {
  const proof = service?.dataBoundary;
  const fail = () => { throw new Error(`The installed-service data-boundary proof does not establish safe migration, retained state and rejected startup for the matching package: ${archive.artifact.filename}.`); };
  if (proof?.formatVersion !== 1 || proof.status !== 'passed' || proof.sourceCommit !== archive.sourceCommit || proof.bundleProvenanceSha256 !== archive.resources.bundleProvenanceSha256 || proof.fixtureBucket !== 'migration-fixture') fail();
  for (const [field, file] of [['installedServiceSha256', 'device/service.cjs'], ['nodeSha256', 'runtime/node']]) {
    const expected = archive.resources.manifest[file];
    if (!digest(expected) || proof[field] !== expected || service.resources?.verifiedFiles?.[file] !== expected || service.resources.copiedVerifiedFiles?.[file] !== expected) fail();
  }
  const snapshots = [proof.legacyAdoption, proof.version1Reopen, proof.uninstallRetention];
  for (const snapshot of snapshots) {
    if (snapshot?.status !== 'passed' || snapshot.schemaVersion !== 1 || snapshot.retainedRecordCount !== 1 || snapshot.retainedEventCount !== 1 || snapshot.eventCursor !== 41 || !Number.isSafeInteger(snapshot.persistentCursorHighWaterMark) || snapshot.persistentCursorHighWaterMark < 41 || snapshot.retainedDataSha256 !== retainedFixtureSha256) fail();
  }
  if (snapshots.some(snapshot => snapshot.retainedDataSha256 !== snapshots[0].retainedDataSha256) || snapshots[1].persistentCursorHighWaterMark < snapshots[0].persistentCursorHighWaterMark || snapshots[2].persistentCursorHighWaterMark < snapshots[1].persistentCursorHighWaterMark) fail();
  const update = proof.updateRetention;
  if (update?.status !== 'passed' || ['sameStateDirectory', 'accessIdentityPreserved', 'deviceIdentityPreserved', 'restartedService'].some(field => update[field] !== true) || update.privateRuntimeState !== 'stopped' || update.retainedDataSha256 !== snapshots[1].retainedDataSha256) fail();
  for (const [field, fixture] of [['futureVersion', 'newer-schema-version-2'], ['malformedBaseline', 'malformed-events-baseline']]) {
    const rejected = proof.rejectedStartup?.[field];
    if (rejected?.status !== 'passed' || rejected.fixture !== fixture || !Number.isInteger(rejected.exitCode) || rejected.exitCode <= 0 || rejected.listenerObserved !== false || rejected.connectionRecordCreated !== false || rejected.databaseBytesPreserved !== true || !digest(rejected.databaseSha256Before) || rejected.databaseSha256After !== rejected.databaseSha256Before) fail();
  }
  return proof;
}

export function verifyInstalledProofs(archive, service, gui, screenshotSha256) {
  const identity = proof => proof?.formatVersion === 1 && proof.product === 'EnoughFactory' && proof.platform === archive.platform && proof.arch === archive.arch && proof.sourceCommit === archive.sourceCommit;
  const requiredFiles = ['runtime/node', 'device/service.cjs', 'install/install-device-service.mjs', 'install/uninstall-device-service.mjs'];
  const lifecycle = service?.service;
  if (!identity(service) || service.version !== archive.version || service.verificationScope !== 'installed-user-service' || !Number.isFinite(Date.parse(service.verifiedAt)) || service.resources?.bundleProvenanceSha256 !== archive.resources.bundleProvenanceSha256 || service.resources.copiedBundleProvenanceSha256 !== archive.resources.bundleProvenanceSha256 || requiredFiles.some(file => !digest(archive.resources.manifest[file]) || service.resources.verifiedFiles?.[file] !== archive.resources.manifest[file] || service.resources.copiedVerifiedFiles?.[file] !== archive.resources.manifest[file]) || lifecycle?.manager !== (archive.platform === 'darwin' ? 'launchd' : 'systemd-user') || lifecycle.startup !== 'registered-and-started' || lifecycle.health !== 'authenticated' || lifecycle.version !== archive.version || lifecycle.unauthenticatedStateStatus !== 401 || lifecycle.privateRuntimeStartupState !== 'stopped' || lifecycle.runtimeStarted !== false || lifecycle.uninstall !== 'authenticated-owned-runtime-stop-and-service-shutdown' || ['startupRegistrationRemoved', 'connectionClosed', 'installedResourcesRemoved', 'deviceStatePreserved'].some(field => lifecycle[field] !== true)) throw new Error(`The installed-service proof does not establish the matching package lifecycle: ${archive.artifact.filename}.`);
  if (requiresDataBoundary(archive.version)) verifyServiceDataBoundary(archive, service);
  const requiredChecks = ['packaged Electron starts with Chromium sandbox enabled', 'shared workbench mounts in the isolated native renderer', 'isolated native workbench renders a visible frame', 'bundled independent device service answers authenticated health', 'device service remains healthy after native desktop exits'];
  if (!identity(gui) || gui.suite !== 'desktop-gui' || gui.status !== 'passed' || gui.bundleProvenanceSha256 !== archive.resources.bundleProvenanceSha256 || gui.rendererSandbox?.enabled !== true || (archive.platform === 'linux' && (gui.rendererSandbox.seccomp !== 2 || gui.rendererSandbox.noNewPrivileges !== true)) || !digest(gui.screenshotSha256) || gui.screenshotSha256 !== screenshotSha256 || !Array.isArray(gui.checks) || requiredChecks.some(check => !gui.checks.includes(check))) throw new Error(`The native desktop proof does not match the package, sandboxed frame and surviving device service: ${archive.artifact.filename}.`);
}

export function verifyPackagedServiceProof(archive, proof) {
  if (proof?.suite === 'packaged-service-smoke') return verifyPackagedServiceSmoke(archive, proof);
  const bundle = proof?.bundle;
  const requiredChecks = ['installed resource hashes and bundled Node match bundle provenance', 'installed device service authenticated health and unauthenticated rejection', 'installed service runtime start reaches its private Docker endpoint', 'installed service session reaches native envmux readiness', 'installed service restart preserves session identity and prior returned commit', 'installed runtime stop refuses unconfirmed active environments', 'installed service session permits full root writes', 'installed service session stop returns exact source commit', 'installed service authenticated runtime stop completes', 'installed service authenticated shutdown completes', 'inherited user Docker context and TLS settings ignored', 'user Docker configuration unchanged'];
  if (proof?.formatVersion !== 1 || proof.product !== 'EnoughFactory' || proof.suite !== 'packaged-service-runtime' || proof.status !== 'passed' || proof.platform !== archive.platform || proof.arch !== archive.arch || bundle?.sourceCommit !== archive.sourceCommit || bundle.version !== archive.version || bundle.platform !== archive.platform || bundle.arch !== archive.arch || bundle.manifestSha256 !== archive.resources.bundleProvenanceSha256 || proof.nodeVersion !== archive.native.node.version || proof.dockerVersion !== archive.containerRuntime.dockerVersion || proof.serviceSha256 !== archive.resources.manifest['device/service.cjs'] || proof.runtimeProvenanceSha256 !== archive.resources.manifest['runtime/container/provenance.json'] || proof.envmuxSha256 !== archive.resources.manifest['envmux/envmux'] || !Number.isFinite(Date.parse(proof.startedAt)) || !Number.isFinite(Date.parse(proof.completedAt)) || Date.parse(proof.completedAt) < Date.parse(proof.startedAt) || !Array.isArray(proof.checks) || requiredChecks.some(check => !proof.checks.includes(check))) throw new Error(`Packaged service/runtime API evidence does not match the final archive: ${archive.artifact.filename}.`);
}

export const packagedServiceSmokeChecks = Object.freeze([
  'current bundled Node and service match the installed manifest',
  'authenticated local health reports the current release',
  'inspection endpoints reject unauthenticated requests',
  'paused goal projects typed tasks and recovered controllers',
  'task inspection preserves kind, criteria and expected outputs',
  'attempt inspection exposes retained candidate and check receipts',
  'legacy task inspection preserves absent optional fields',
  'inspection hides private paths and leaves records unchanged',
  'artifact content matches its immutable manifest',
  'owned private runtime remains stopped',
  'authenticated shutdown exits and closes the service',
]);

export function verifyPackagedServiceSmoke(archive, proof) {
  verifyComponentQualification(archive);
  const fail = () => { throw new Error(`The fresh packaged-service smoke does not establish the changed local service boundary: ${archive.artifact?.filename ?? 'installed resources'}.`); };
  const bundle = proof?.bundle;
  if (proof?.formatVersion !== 1 || proof.product !== 'EnoughFactory' || proof.suite !== 'packaged-service-smoke' || proof.status !== 'passed' || proof.version !== archive.version || proof.sourceCommit !== archive.sourceCommit || proof.platform !== archive.platform || proof.arch !== archive.arch || bundle?.sourceCommit !== archive.sourceCommit || bundle.version !== archive.version || bundle.platform !== archive.platform || bundle.arch !== archive.arch || bundle.manifestSha256 !== archive.resources.bundleProvenanceSha256 || proof.serviceSha256 !== archive.resources.manifest['device/service.cjs'] || proof.nodeSha256 !== archive.resources.manifest['runtime/node'] || !Number.isFinite(Date.parse(proof.startedAt)) || !Number.isFinite(Date.parse(proof.completedAt)) || Date.parse(proof.completedAt) < Date.parse(proof.startedAt) || !Array.isArray(proof.checks) || proof.checks.length !== packagedServiceSmokeChecks.length || new Set(proof.checks).size !== proof.checks.length || packagedServiceSmokeChecks.some(check => !proof.checks.includes(check))) fail();
  const scope = proof.scope;
  if (scope?.transport !== 'authenticated-local-http' || scope.pairedTransportTested !== false || scope.containerEngineStarted !== false || scope.agentOrModelStarted !== false) fail();
  const inspection = proof.inspection;
  if (inspection?.typedTaskKind !== 'feature' || inspection.controllerRecovery !== 'interrupted' || ['criteriaAndOutputsPreserved', 'retainedAttemptReceipts', 'legacyOptionalFieldsPreserved', 'privatePathsRedacted', 'readOnlyRecordsPreserved'].some(field => inspection[field] !== true)) fail();
  if (proof.authentication?.unauthenticatedStatus !== 401 || proof.runtime?.kind !== (archive.platform === 'darwin' ? 'lima' : 'rootless') || proof.runtime.state !== 'stopped' || proof.runtime.ownedStateDirectory !== true || proof.runtime.ownedSocket !== true || ['authenticated', 'exitedCleanly', 'connectionClosed'].some(field => proof.shutdown?.[field] !== true) || proof.artifact?.sha256 !== 'bec1f1272275fe6ab67a2d69a50caa4cd5944e77fe4ea13e91ab965afdbbb55d' || proof.artifact.size !== 47 || proof.artifact.contentVerified !== true) fail();
  return proof;
}
