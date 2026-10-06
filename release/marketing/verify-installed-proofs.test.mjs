import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyInstalledProofs, verifyServiceDataBoundary } from './verify-installed-proofs.mjs';

// Contract fixtures are kept in memory and never become public proof records.
function fixture(version = '0.1.2') {
  const hash = 'a'.repeat(64);
  const retainedHash = '05e7b797d3631820402dcabd6d0191e48b88c029f854b6bf9dfb13908a31252a';
  const identity = { formatVersion: 1, product: 'EnoughFactory', platform: 'linux', arch: 'arm64', sourceCommit: 'b'.repeat(40) };
  const files = ['runtime/node', 'device/service.cjs', 'install/install-device-service.mjs', 'install/uninstall-device-service.mjs'];
  const manifest = Object.fromEntries(files.map(file => [file, hash]));
  const archive = { ...identity, version, artifact: { filename: `EnoughFactory-${version}-linux-arm64.tar.gz` }, resources: { bundleProvenanceSha256: hash, manifest } };
  const snapshot = highWater => ({ status: 'passed', schemaVersion: 1, retainedRecordCount: 1, retainedEventCount: 1, eventCursor: 41, persistentCursorHighWaterMark: highWater, retainedDataSha256: retainedHash });
  const negative = name => ({ status: 'passed', fixture: name, exitCode: 1, listenerObserved: false, connectionRecordCreated: false, databaseSha256Before: hash, databaseSha256After: hash, databaseBytesPreserved: true });
  const service = {
    ...identity, version, verificationScope: 'installed-user-service', verifiedAt: '2026-10-05T00:00:00Z',
    resources: { bundleProvenanceSha256: hash, copiedBundleProvenanceSha256: hash, verifiedFiles: { ...manifest }, copiedVerifiedFiles: { ...manifest } },
    service: { manager: 'systemd-user', startup: 'registered-and-started', health: 'authenticated', version, unauthenticatedStateStatus: 401, privateRuntimeStartupState: 'stopped', runtimeStarted: false, uninstall: 'authenticated-owned-runtime-stop-and-service-shutdown', startupRegistrationRemoved: true, connectionClosed: true, installedResourcesRemoved: true, deviceStatePreserved: true },
    dataBoundary: {
      formatVersion: 1, status: 'passed', sourceCommit: identity.sourceCommit, bundleProvenanceSha256: hash, installedServiceSha256: hash, nodeSha256: hash, fixtureBucket: 'migration-fixture',
      legacyAdoption: snapshot(41), version1Reopen: snapshot(42), uninstallRetention: snapshot(43),
      updateRetention: { status: 'passed', sameStateDirectory: true, accessIdentityPreserved: true, deviceIdentityPreserved: true, restartedService: true, privateRuntimeState: 'stopped', retainedDataSha256: retainedHash },
      rejectedStartup: { futureVersion: negative('newer-schema-version-2'), malformedBaseline: negative('malformed-events-baseline') },
    },
  };
  const gui = { ...identity, suite: 'desktop-gui', status: 'passed', bundleProvenanceSha256: hash, rendererSandbox: { enabled: true, seccomp: 2, noNewPrivileges: true }, screenshotSha256: hash, checks: ['packaged Electron starts with Chromium sandbox enabled', 'shared workbench mounts in the isolated native renderer', 'isolated native workbench renders a visible frame', 'bundled independent device service answers authenticated health', 'device service remains healthy after native desktop exits'] };
  return { archive, service, gui, hash };
}

test('new release assembly requires a matching data-boundary proof while historical receipts remain valid', () => {
  const { archive, service, gui, hash } = fixture();
  assert.doesNotThrow(() => verifyInstalledProofs(archive, service, gui, hash));
  assert.equal(verifyServiceDataBoundary(archive, service), service.dataBoundary);
  delete service.dataBoundary;
  assert.throws(() => verifyInstalledProofs(archive, service, gui, hash), /data-boundary/);
  const old = fixture('0.1.1');
  delete old.service.dataBoundary;
  assert.doesNotThrow(() => verifyInstalledProofs(old.archive, old.service, old.gui, old.hash));
});

test('unbound binaries, lost state, cursor resets and reachable or mutating rejected startups cannot pass', () => {
  const corruptions = [
    proof => { proof.sourceCommit = 'd'.repeat(40); },
    proof => { proof.bundleProvenanceSha256 = 'd'.repeat(64); },
    proof => { proof.installedServiceSha256 = 'd'.repeat(64); },
    proof => { proof.nodeSha256 = 'd'.repeat(64); },
    proof => { proof.version1Reopen.retainedDataSha256 = 'd'.repeat(64); },
    proof => { proof.uninstallRetention.persistentCursorHighWaterMark = 41; },
    proof => { proof.updateRetention.deviceIdentityPreserved = false; },
    proof => { proof.rejectedStartup.futureVersion.exitCode = null; },
    proof => { proof.rejectedStartup.futureVersion.exitCode = 0; },
    proof => { proof.rejectedStartup.futureVersion.listenerObserved = true; },
    proof => { proof.rejectedStartup.malformedBaseline.connectionRecordCreated = true; },
    proof => { proof.rejectedStartup.malformedBaseline.databaseSha256After = 'd'.repeat(64); },
  ];
  for (const corrupt of corruptions) {
    const { archive, service } = fixture();
    corrupt(service.dataBoundary);
    assert.throws(() => verifyServiceDataBoundary(archive, service), /data-boundary/);
  }
});
