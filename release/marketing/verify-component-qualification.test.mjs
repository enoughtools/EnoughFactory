import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { componentQualificationRequirements, verifyComponentQualification } from './verify-component-qualification.mjs';
import { verifyArchiveReceipt, verifyRuntimeJourney } from './verify-receipt.mjs';
import { packagedServiceSmokeChecks, verifyPackagedServiceProof, verifyPackagedServiceSmoke } from './verify-installed-proofs.mjs';

const baseline = JSON.parse(readFileSync(new URL('./component-baseline-0.1.2.json', import.meta.url), 'utf8'));
const targets = Object.keys(baseline.targets);
const changedHash = 'a'.repeat(64);

// These in-memory contract fixtures never create or publish verification evidence.
function fixture(target = 'darwin-arm64') {
  const original = baseline.targets[target];
  const receipt = structuredClone(original.evidence.archive);
  const required = componentQualificationRequirements(receipt.platform, receipt.arch);
  receipt.version = '0.1.3';
  receipt.sourceCommit = 'f'.repeat(40);
  receipt.resources.bundleProvenanceSha256 = 'b'.repeat(64);
  receipt.resources.manifest['device/service.cjs'] = changedHash;
  receipt.artifact.filename = receipt.artifact.filename.replace('0.1.2', '0.1.3');
  receipt.artifact.sha256 = 'c'.repeat(64);
  delete receipt.runtimeJourney;
  const companion = receipt.containerRuntime.engineSourceBuild.sourceCompanion;
  for (const field of ['file', 'receiptFile']) {
    const previous = companion[field];
    companion[field] = previous.replace('0.1.2', '0.1.3');
    const previousPath = `runtime/container/${previous}`;
    receipt.resources.manifest[`runtime/container/${companion[field]}`] = receipt.resources.manifest[previousPath];
    delete receipt.resources.manifest[previousPath];
  }
  const evidence = Object.fromEntries(Object.entries(original.evidence).map(([name, value]) => {
    const pin = required.baseline[name];
    return [name, {
      url: name === 'archive' ? pin.receiptUrl : pin.url,
      sha256: name === 'archive' ? pin.receiptSha256 : pin.sha256,
      receipt: structuredClone(value),
    }];
  }));
  receipt.componentQualification = {
    formatVersion: 1,
    product: 'EnoughFactory',
    kind: 'unchanged-runtime-components',
    status: 'qualified',
    scope: required.scope,
    qualifiedAt: '2026-10-07T00:00:00Z',
    current: {
      version: receipt.version,
      sourceCommit: receipt.sourceCommit,
      platform: receipt.platform,
      arch: receipt.arch,
      bundleProvenanceSha256: receipt.resources.bundleProvenanceSha256,
    },
    baseline: { version: required.version, sourceCommit: required.sourceCommit, ...evidence },
    unchanged: { sources: required.sources, dependencies: required.dependencies, assets: required.assets },
  };
  return receipt;
}

for (const target of targets) {
  test(`${target}: unchanged components qualify a new package while retaining original proof identities`, () => {
    const receipt = fixture(target);
    const proof = receipt.componentQualification;
    assert.equal(verifyComponentQualification(receipt), proof);
    assert.equal(verifyRuntimeJourney(receipt), proof);
    assert.equal(proof.baseline.archive.receipt.version, '0.1.2');
    assert.equal(proof.baseline.runtime.receipt.bundle.sourceCommit, baseline.sourceCommit);
    assert.equal(proof.baseline.runtime.receipt.completedAt, baseline.targets[target].evidence.runtime.completedAt);
    assert.equal(proof.current.version, '0.1.3');
    assert.notEqual(proof.current.sourceCommit, proof.baseline.sourceCommit);
    assert.equal(receipt.runtimeJourney, undefined);
    const artifact = { ...receipt.artifact, version: receipt.version, platform: receipt.platform, arch: receipt.arch, format: receipt.extraction.format };
    assert.equal(verifyArchiveReceipt(receipt, artifact, baseline.pins), receipt);
  });

  test(`${target}: original fresh runtime evidence remains valid`, () => {
    const original = structuredClone(baseline.targets[target].evidence.archive);
    assert.equal(verifyRuntimeJourney(original), original.runtimeJourney);
    if (target === 'darwin-arm64') assert.doesNotThrow(() => verifyPackagedServiceProof(original, baseline.targets[target].evidence.api));
  });
}

for (const group of ['sources', 'dependencies', 'assets']) {
  test(`mandatory ${group} cannot change, disappear or gain caller-selected inputs`, () => {
    const mutations = [
      map => { map[Object.keys(map)[0]] = changedHash; },
      map => { delete map[Object.keys(map)[0]]; },
      map => { map['unreviewed-extra-input'] = changedHash; },
    ];
    for (const mutate of mutations) {
      const receipt = fixture();
      mutate(receipt.componentQualification.unchanged[group]);
      const label = group === 'sources' ? 'source' : group === 'dependencies' ? 'dependency' : 'asset';
      assert.throws(() => verifyComponentQualification(receipt), new RegExp(`mandatory ${label} input`));
    }
  });
}

test('unchanged asset declarations cannot conceal different, missing or additional packaged runtime assets', () => {
  const mutations = [
    manifest => { manifest['runtime/node'] = changedHash; },
    manifest => { delete manifest['runtime/container/docker/bin/docker']; },
    manifest => { manifest['runtime/container/docker/bin/unreviewed-helper'] = changedHash; },
  ];
  for (const target of targets) for (const mutate of mutations) {
    const receipt = fixture(target);
    mutate(receipt.resources.manifest);
    receipt.resources.fileCount = Object.keys(receipt.resources.manifest).length;
    assert.throws(() => verifyComponentQualification(receipt), /mandatory packaged asset input/);
  }
});

test('qualification is limited to the reviewed release, scope and current bundle identity', () => {
  const mutations = [
    receipt => { receipt.version = receipt.componentQualification.current.version = '0.1.4'; },
    receipt => { receipt.componentQualification.formatVersion = 2; },
    receipt => { receipt.componentQualification.scope.push('current-packaged-service-runtime'); },
    receipt => { receipt.componentQualification.scope.pop(); },
    receipt => { receipt.componentQualification.status = 'passed'; },
    receipt => { receipt.componentQualification.current.sourceCommit = 'e'.repeat(40); },
    receipt => { receipt.componentQualification.current.bundleProvenanceSha256 = changedHash; },
    receipt => { receipt.componentQualification.baseline.sourceCommit = 'e'.repeat(40); },
  ];
  for (const mutate of mutations) {
    const receipt = fixture();
    mutate(receipt);
    assert.throws(() => verifyComponentQualification(receipt), /unsupported scope, identity/);
  }
  assert.throws(() => verifyComponentQualification({ ...fixture(), platform: 'win32' }), /No reviewed component baseline/);
});

test('original archive, runtime and API evidence must retain their pinned bytes and public identity', () => {
  for (const name of ['archive', 'runtime', 'api']) {
    const mutations = [
      evidence => { evidence.receipt.product = 'Rewritten history'; },
      evidence => { evidence.url = evidence.url.replace('/v0.1.2/', '/v0.1.3/'); },
      evidence => { evidence.sha256 = changedHash; },
    ];
    for (const mutate of mutations) {
      const receipt = fixture();
      mutate(receipt.componentQualification.baseline[name]);
      assert.throws(() => verifyComponentQualification(receipt), new RegExp(`original ${name} evidence.*pinned baseline receipt bytes`));
    }
  }
  const linux = fixture('linux-x64');
  linux.componentQualification.baseline.api = fixture().componentQualification.baseline.api;
  assert.throws(() => verifyComponentQualification(linux), /Unsupported historical API evidence/);
});

test('a qualification cannot coexist with a claimed fresh runtime journey', () => {
  const receipt = fixture();
  receipt.runtimeJourney = structuredClone(baseline.targets['darwin-arm64'].evidence.runtime);
  assert.throws(() => verifyComponentQualification(receipt), /fresh-runtime claims/);
  assert.throws(() => verifyRuntimeJourney(receipt));
});

test('unchanged bytes do not excuse changed runtime behavior configuration', () => {
  const mutations = [
    receipt => { receipt.containerRuntime.dockerVersion = '30.0.0'; },
    receipt => { receipt.containerRuntime.limaVersion = '3.0.0'; },
    receipt => { receipt.containerRuntime.archivePins[0].sha256 = changedHash; },
  ];
  for (const mutate of mutations) {
    const receipt = fixture();
    mutate(receipt);
    assert.throws(() => verifyComponentQualification(receipt), /runtime behavior configuration/);
  }
});

function smokeFixture(archive) {
  return {
    formatVersion: 1,
    product: 'EnoughFactory',
    suite: 'packaged-service-smoke',
    status: 'passed',
    version: archive.version,
    sourceCommit: archive.sourceCommit,
    platform: archive.platform,
    arch: archive.arch,
    startedAt: '2026-10-07T00:01:00Z',
    completedAt: '2026-10-07T00:02:00Z',
    bundle: {
      version: archive.version,
      sourceCommit: archive.sourceCommit,
      platform: archive.platform,
      arch: archive.arch,
      manifestSha256: archive.resources.bundleProvenanceSha256,
    },
    serviceSha256: archive.resources.manifest['device/service.cjs'],
    nodeSha256: archive.resources.manifest['runtime/node'],
    checks: [...packagedServiceSmokeChecks],
    scope: {
      transport: 'authenticated-local-http',
      pairedTransportTested: false,
      containerEngineStarted: false,
      agentOrModelStarted: false,
    },
    inspection: {
      typedTaskKind: 'feature',
      controllerRecovery: 'interrupted',
      criteriaAndOutputsPreserved: true,
      retainedAttemptReceipts: true,
      legacyOptionalFieldsPreserved: true,
      privatePathsRedacted: true,
      readOnlyRecordsPreserved: true,
    },
    authentication: { unauthenticatedStatus: 401 },
    runtime: {
      kind: archive.platform === 'darwin' ? 'lima' : 'rootless',
      state: 'stopped',
      ownedStateDirectory: true,
      ownedSocket: true,
    },
    shutdown: { authenticated: true, exitedCleanly: true, connectionClosed: true },
    artifact: {
      sha256: 'bec1f1272275fe6ab67a2d69a50caa4cd5944e77fe4ea13e91ab965afdbbb55d',
      size: 47,
      contentVerified: true,
    },
  };
}

for (const target of targets) {
  test(`${target}: current local service smoke complements qualified historical components`, () => {
    const archive = fixture(target);
    const smoke = smokeFixture(archive);
    assert.equal(verifyPackagedServiceSmoke(archive, smoke), smoke);
    assert.equal(verifyPackagedServiceProof(archive, smoke), smoke);
  });
}

test('local smoke cannot substitute for missing component qualification', () => {
  const archive = fixture();
  const smoke = smokeFixture(archive);
  delete archive.componentQualification;
  assert.throws(() => verifyPackagedServiceSmoke(archive, smoke), /Component qualification/);
  assert.throws(() => verifyPackagedServiceProof(archive, smoke), /Component qualification/);
});

test('fresh service smoke rejects stale release, bundle and executable identity', () => {
  const mutations = [
    smoke => { smoke.version = '0.1.2'; },
    smoke => { smoke.sourceCommit = baseline.sourceCommit; },
    smoke => { smoke.bundle.version = '0.1.2'; },
    smoke => { smoke.bundle.sourceCommit = baseline.sourceCommit; },
    smoke => { smoke.bundle.manifestSha256 = 'd'.repeat(64); },
    smoke => { smoke.serviceSha256 = baseline.targets['darwin-arm64'].evidence.archive.resources.manifest['device/service.cjs']; },
    smoke => { smoke.nodeSha256 = changedHash; },
  ];
  for (const mutate of mutations) {
    const archive = fixture();
    const smoke = smokeFixture(archive);
    mutate(smoke);
    assert.throws(() => verifyPackagedServiceSmoke(archive, smoke), /changed local service boundary/);
  }
});

test('local smoke cannot claim paired transport, engine startup or model execution', () => {
  const mutations = [
    smoke => { smoke.scope.transport = 'authenticated-webrtc'; },
    smoke => { smoke.scope.pairedTransportTested = true; },
    smoke => { smoke.scope.containerEngineStarted = true; },
    smoke => { smoke.scope.agentOrModelStarted = true; },
    smoke => { smoke.runtime.state = 'ready'; },
    smoke => { smoke.runtime.kind = 'rootless'; },
    smoke => { smoke.runtime.ownedStateDirectory = false; },
    smoke => { smoke.runtime.ownedSocket = false; },
  ];
  for (const mutate of mutations) {
    const archive = fixture();
    const smoke = smokeFixture(archive);
    mutate(smoke);
    assert.throws(() => verifyPackagedServiceSmoke(archive, smoke), /changed local service boundary/);
  }
});

test('inspection evidence must preserve typed and legacy records, recovered controllers and private paths', () => {
  const mutations = [
    smoke => { smoke.inspection.typedTaskKind = 'chore'; },
    smoke => { smoke.inspection.controllerRecovery = 'running'; },
    ...['criteriaAndOutputsPreserved', 'retainedAttemptReceipts', 'legacyOptionalFieldsPreserved', 'privatePathsRedacted', 'readOnlyRecordsPreserved'].map(field => smoke => { smoke.inspection[field] = false; }),
  ];
  for (const mutate of mutations) {
    const archive = fixture();
    const smoke = smokeFixture(archive);
    mutate(smoke);
    assert.throws(() => verifyPackagedServiceSmoke(archive, smoke), /changed local service boundary/);
  }
});

test('fresh service smoke requires rejection, complete checks, verified artifact content and clean shutdown', () => {
  const mutations = [
    smoke => { smoke.authentication.unauthenticatedStatus = 200; },
    smoke => { smoke.checks.pop(); },
    smoke => { smoke.checks.push(smoke.checks[0]); },
    ...['authenticated', 'exitedCleanly', 'connectionClosed'].map(field => smoke => { smoke.shutdown[field] = false; }),
    smoke => { smoke.artifact.sha256 = changedHash; },
    smoke => { smoke.artifact.size = 48; },
    smoke => { smoke.artifact.contentVerified = false; },
  ];
  for (const mutate of mutations) {
    const archive = fixture();
    const smoke = smokeFixture(archive);
    mutate(smoke);
    assert.throws(() => verifyPackagedServiceSmoke(archive, smoke), /changed local service boundary/);
  }
});
