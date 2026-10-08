import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import test from 'node:test';
import { ArtifactStore, InspectionSnapshotManager, NativeTeardownError, type AppleCheckResult, type CheckExecutor } from '@enoughfactory/workspaces';
import { NativeInspectionError, type NativeAction, type NativeInspectionBackend, type NativePlatform, type NativeProduct } from '@enoughfactory/native-inspection';
import { NativeInspectionAdapter, validateNativeAppZip } from './inspection-native.ts';

interface ZipEntry {
  name: string;
  data?: string | Buffer;
  method?: 0 | 8;
  mode?: number;
  localName?: string;
  crc?: number;
  expandedSize?: number;
  flags?: number;
  compressedTail?: Buffer;
}

// Standard ZIP records are generated locally so safety tests do not depend on
// platform archive tools or an archive fixture whose provenance is opaque.
function zip(entries: ZipEntry[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), localName = Buffer.from(entry.localName ?? entry.name);
    const data = Buffer.from(entry.data ?? ''), method = entry.method ?? 0;
    const compressed = Buffer.concat([method === 8 ? deflateRawSync(data) : data, entry.compressedTail ?? Buffer.alloc(0)]);
    const crc = entry.crc ?? crc32(data), expandedSize = entry.expandedSize ?? data.length;
    const mode = entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0x800, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(expandedSize, 22); header.writeUInt16LE(localName.length, 26);
    local.push(header, localName, compressed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6); record.writeUInt16LE(entry.flags ?? 0x800, 8); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(expandedSize, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    central.push(record, name); offset += header.length + localName.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const info = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.enoughfactory.fixture</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array></dict></plist>\n';
function appEntries(): ZipEntry[] {
  return [
    { name: 'Fixture.app/' },
    { name: 'Fixture.app/Contents/' },
    { name: 'Fixture.app/Contents/MacOS/' },
    { name: 'Fixture.app/Contents/Info.plist', data: info },
    { name: 'Fixture.app/Contents/MacOS/Fixture', data: '#!/bin/sh\nexit 0\n', mode: 0o100755 },
  ];
}

test('native app ZIP validation accepts a single app with stored and deflated bytes and internal symlinks', () => {
  for (const method of [0, 8] as const) {
    const entries: ZipEntry[] = [...appEntries(),
      { name: 'Fixture.app/Contents/Resources/' },
      { name: 'Fixture.app/Contents/Resources/message.txt', data: 'A small retained resource.\n', method },
      { name: 'Fixture.app/Contents/Resources/message-link', data: 'message.txt', mode: 0o120777 },
    ];
    assert.deepEqual(validateNativeAppZip(zip(entries)), {
      appName: 'Fixture.app',
      expandedBytes: entries.reduce((total, entry) => total + Buffer.byteLength(entry.data ?? ''), 0),
      entryCount: entries.length,
    });
  }
});

test('native app ZIP validation rejects traversal and local-header path substitution', () => {
  for (const name of ['../outside', '/outside', 'Fixture.app/Contents/../outside', 'Fixture.app\\Contents\\outside']) {
    assert.throws(() => validateNativeAppZip(zip([...appEntries(), { name, data: 'outside' }])), Error, name);
  }
  assert.throws(() => validateNativeAppZip(zip([...appEntries(), {
    name: 'Fixture.app/Contents/resource.txt', localName: '../outside', data: 'same valid payload',
  }])));
});

test('native app ZIP validation rejects exact, case-insensitive and Unicode canonical collisions', () => {
  for (const names of [
    ['same.txt', 'same.txt'],
    ['Resource.txt', 'resource.txt'],
    ['caf\u00e9.txt', 'cafe\u0301.txt'],
  ]) {
    assert.throws(() => validateNativeAppZip(zip([...appEntries(), ...names.map(name => ({
      name: `Fixture.app/Contents/${name}`, data: 'resource',
    }))])), Error, names.join(' / '));
  }
});

test('native app ZIP validation rejects symlink ancestors regardless of archive ordering and escaping links', () => {
  const link: ZipEntry = { name: 'Fixture.app/Contents/alias', data: 'MacOS', mode: 0o120777 };
  const child: ZipEntry = { name: 'Fixture.app/Contents/alias/extra', data: 'must not write through a link' };
  for (const entries of [[link, child], [child, link]]) {
    assert.throws(() => validateNativeAppZip(zip([...appEntries(), ...entries])));
  }
  for (const target of ['../../../outside', '/tmp/outside', '..\\..\\..\\outside']) {
    assert.throws(() => validateNativeAppZip(zip([...appEntries(), {
      name: 'Fixture.app/Contents/escape', data: target, mode: 0o120777,
    }])), Error, target);
  }
});

test('native app ZIP validation checks payload CRC even when both headers agree on the wrong CRC', () => {
  for (const method of [0, 8] as const) {
    const data = Buffer.from('corruption must be detected');
    assert.throws(() => validateNativeAppZip(zip([...appEntries(), {
      name: 'Fixture.app/Contents/corrupt.txt', data, method, crc: (crc32(data) ^ 1) >>> 0,
    }])));
  }
});

test('native app ZIP validation bounds declared and actual decompressed bytes before extraction', () => {
  assert.throws(() => validateNativeAppZip(zip([...appEntries(), {
    name: 'Fixture.app/Contents/declared-bomb', data: 'tiny', method: 8, expandedSize: 0xffffffff,
  }])));
  // The compressed payload is only a few dozen bytes. The advertised size must
  // bound inflation rather than trusting a central-directory size after inflate.
  assert.throws(() => validateNativeAppZip(zip([...appEntries(), {
    name: 'Fixture.app/Contents/expansion-bomb', data: Buffer.alloc(64 * 1024), method: 8, expandedSize: 1,
  }])));
});

test('native app ZIP validation rejects extra bytes hidden after a complete deflate stream', () => {
  // The CRC, expanded size and both compressed-size fields remain consistent.
  // Only complete consumption of the deflate member detects these hidden tails.
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50); localHeader.writeUInt16LE(20, 4);
  const member: ZipEntry = { name: 'Fixture.app/Contents/resource.txt', data: 'valid deflated content', method: 8 };
  assert.equal(validateNativeAppZip(zip([...appEntries(), member])).entryCount, appEntries().length + 1);
  for (const compressedTail of [Buffer.from('hidden trailing bytes'), localHeader]) {
    assert.throws(() => validateNativeAppZip(zip([...appEntries(), { ...member, compressedTail }])));
  }
});

test('native app ZIP validation rejects special Unix files and multiple app roots', () => {
  for (const mode of [0o010644, 0o020644, 0o060644, 0o140644]) {
    assert.throws(() => validateNativeAppZip(zip([...appEntries(), {
      name: 'Fixture.app/Contents/special', data: '', mode,
    }])), Error, mode.toString(8));
  }
  assert.throws(() => validateNativeAppZip(zip([...appEntries(), { name: 'Other.app/Contents/Info.plist', data: info }])));
});

const authority = { goalId: 'goal-native', goalRevision: 3, taskId: 'task-native', attemptId: 'attempt-native', authorityGeneration: 2, policyRevision: 1 };
const profile = {
  id: 'fixture-macos',
  build: { tool: 'xcodebuild' as const, project: 'Fixture.xcodeproj', scheme: 'Fixture', platform: 'macos' as const, configuration: 'Debug' as const },
  launchArguments: ['--production-fixture', '{runId}'],
};

async function buildFixture(t: { after: (fn: () => Promise<void>) => void }, checkExecutor: CheckExecutor, selectedBackend?: NativeInspectionBackend) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'enough-native-adapter-')));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const source = join(directory, 'author'), dataDir = join(directory, 'owned');
  await mkdir(join(source, 'Fixture.xcodeproj'), { recursive: true });
  await writeFile(join(source, 'Fixture.xcodeproj', 'project.pbxproj'), '// Small source capture; checker is fake.\n');
  await writeFile(join(source, 'source.txt'), 'exact captured input\n');
  const artifacts = new ArtifactStore(join(dataDir, 'artifacts'), 'fixture-device');
  const receipt = await artifacts.put(JSON.stringify({
    version: 1, kind: 'native-fixture-source-audit', profileId: profile.id, build: profile.build, launchArguments: profile.launchArguments,
    roots: [{ name: 'primary', entries: [{ path: 'source.txt', sha256: createHash('sha256').update(await readFile(join(source, 'source.txt'))).digest('hex') }] }],
  }), { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId,
    name: 'fixture-source-audit.json', mime: 'application/json' });
  const boundProfile = { ...profile, receipt, fixtureEvidenceSha256: receipt.sha256 };
  const snapshots = new InspectionSnapshotManager({ dataDir, artifacts });
  const roots = [{ id: 'primary', name: 'primary', path: source }];
  const snapshot = await snapshots.create({ roots, context: authority });
  const backend = selectedBackend ?? {
    start: async () => { throw new Error('Tests must never launch a native app'); },
    discover: async () => [],
  } as unknown as NativeInspectionBackend;
  return { directory, source, dataDir, artifacts, snapshot, snapshots, roots, profile: boundProfile, backend,
    adapter: new NativeInspectionAdapter({ dataDir, artifacts, backend, checkExecutor }) };
}

function attestedChecker(artifacts: () => ArtifactStore, entries = appEntries()): CheckExecutor {
  return async context => {
    const product = await artifacts().put(zip(entries), {
      goalId: context.candidate.goalId, taskId: context.candidate.taskId, attemptId: context.candidate.attemptId,
      name: 'Fixture.app.zip', mime: 'application/zip', metadata: {
        format: 'apple-app-zip', unsigned: true, candidateId: context.candidate.id,
        candidateCommit: context.candidate.commit, commit: context.commit, platform: 'macos', scheme: 'Fixture',
      },
    });
    const original = { command: context.command, exitCode: 0, stdout: 'BUILD SUCCEEDED', stderr: '',
      startedAt: '2026-10-08T12:00:00.000Z', endedAt: '2026-10-08T12:00:01.000Z' };
    const native: Omit<AppleCheckResult['appleValidation'], 'artifact'> = {
      version: 1, candidateId: context.candidate.id, candidateCommit: context.candidate.commit, checkedCommit: context.commit,
      profile: profile.build, sandbox: 'macos-seatbelt-deny-default', developerDirectory: '/Applications/Xcode.app/Contents/Developer',
      workingDirectories: (context.workingDirectories ?? []).map(({ containerPath, commit }) => ({ containerPath, commit })), products: [product],
    };
    const evidence = await artifacts().put(JSON.stringify({ ...native, result: original }), {
      goalId: context.candidate.goalId, taskId: context.candidate.taskId, attemptId: context.candidate.attemptId,
      name: 'original-apple-evidence.json', mime: 'application/json',
    });
    return { ...original, appleValidation: { ...native, artifact: evidence } } as AppleCheckResult;
  };
}

async function preparedFixture(t: { after: (fn: () => Promise<void>) => void }, backend?: NativeInspectionBackend) {
  let checks = 0, f: Awaited<ReturnType<typeof buildFixture>>;
  const checker = attestedChecker(() => f.artifacts);
  f = await buildFixture(t, async context => { checks++; return checker(context); }, backend);
  const result = await f.adapter.build(f.snapshot, f.profile, { authority });
  assert.equal(result.status, 'passed', result.error); assert.ok(result.product);
  return { ...f, result, product: result.product, checks: () => checks };
}

test('native builds reject missing receipts, mismatched evidence hashes and arbitrary source audits before checking', async t => {
  let called = 0;
  const f = await buildFixture(t, async () => { called++; throw new Error('An unbound fixture must not reach compilation'); });
  const arbitrary = await f.artifacts.put(JSON.stringify({
    version: 1, kind: 'native-fixture-source-audit', profileId: f.profile.id, build: f.profile.build, launchArguments: f.profile.launchArguments,
    roots: [{ name: 'primary', entries: [{ path: 'source.txt', sha256: '0'.repeat(64) }] }],
  }), { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId,
    name: 'arbitrary-source-audit.json', mime: 'application/json' });
  const invalid = [
    { value: { ...f.profile, receipt: undefined }, code: 'fixture-required' },
    { value: { ...f.profile, fixtureEvidenceSha256: '0'.repeat(64) }, code: 'fixture-required' },
    { value: { ...f.profile, receipt: arbitrary, fixtureEvidenceSha256: arbitrary.sha256 }, code: 'fixture-source-changed' },
    { value: { ...f.profile, build: { ...f.profile.build, scheme: 'DifferentTarget' } }, code: 'fixture-required' },
  ];
  for (const candidateProfile of invalid) {
    await assert.rejects(f.adapter.build(f.snapshot, candidateProfile.value, { authority }),
      (error: unknown) => error instanceof NativeInspectionError && error.code === candidateProfile.code);
    assert.equal(called, 0);
  }
});

test('an original fixture audit cannot authorize a fresh valid snapshot with changed audited source', async t => {
  let called = 0;
  const f = await buildFixture(t, async () => { called++; throw new Error('Stale fixture source must not reach compilation'); });
  await writeFile(join(f.source, 'source.txt'), 'changed fixture isolation code\n');
  const snapshot = await f.snapshots.create({ roots: f.roots, context: authority });
  await f.snapshots.verify(snapshot);
  assert.notEqual(snapshot.sourceDigest, f.snapshot.sourceDigest);
  await assert.rejects(f.adapter.build(snapshot, f.profile, { authority }),
    (error: unknown) => error instanceof NativeInspectionError && error.code === 'fixture-source-changed');
  assert.equal(called, 0, 'a valid frozen snapshot does not make its stale fixture audit valid');
});

test('unchanged audited fixture source permits unrelated UI edits in a new frozen snapshot', { skip: process.platform !== 'darwin' }, async t => {
  const ui = 'let title = "An unrelated interface change"\n';
  let called = 0, f: Awaited<ReturnType<typeof buildFixture>>;
  const attested = attestedChecker(() => f.artifacts);
  f = await buildFixture(t, async context => {
    called++;
    assert.equal(await readFile(join(context.path, 'View.swift'), 'utf8'), ui);
    return attested(context);
  });
  await writeFile(join(f.source, 'View.swift'), ui);
  const snapshot = await f.snapshots.create({ roots: f.roots, context: authority });
  await f.snapshots.verify(snapshot);
  assert.notEqual(snapshot.sourceDigest, f.snapshot.sourceDigest);
  const result = await f.adapter.build(snapshot, f.profile, { authority });
  assert.equal(called, 1); assert.equal(result.status, 'passed', result.error); assert.ok(result.product);
  assert.equal(result.product.source.snapshotSha256, snapshot.sourceDigest);
  assert.deepEqual(result.fixtureReceiptArtifact, f.profile.receipt);
  assert.equal(result.fixtureProfileId, f.profile.id);
  assert.equal(result.product.fixture.evidenceSha256, f.profile.receipt.sha256);
  assert.ok(result.evidenceArtifacts.some(artifact => artifact.id === f.profile.receipt.id));
});

test('native build failure retains full check output, source identity and immutable report without a product', async t => {
  const stdout = 'build output\n' + 'o'.repeat(80 * 1024), stderr = 'compiler diagnostic\n' + 'e'.repeat(80 * 1024);
  let called = 0;
  const checker: CheckExecutor = async context => {
    called++;
    assert.equal(context.candidate.attemptId, authority.attemptId);
    assert.equal(context.candidate.commit, context.commit);
    return { command: context.command, exitCode: 65, stdout, stderr,
      startedAt: '2026-10-08T12:00:00.000Z', endedAt: '2026-10-08T12:00:01.000Z' };
  };
  const f = await buildFixture(t, checker);
  const result = await f.adapter.build(f.snapshot, f.profile, { authority });
  assert.equal(called, 1);
  assert.equal(result.status, 'failed'); assert.equal(result.product, undefined);
  assert.deepEqual(result.productArtifacts, []);
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.candidateId, result.candidate.id);
  assert.equal(result.report.commit, f.snapshot.roots[0]!.commit);
  assert.equal(result.report.commands[0]?.exitCode, 65);
  assert.equal(result.report.commands[0]?.stdout, stdout);
  assert.equal(result.report.commands[0]?.stderr, stderr);
  assert.equal(result.report.cleanupErrors, undefined);
  assert.equal(result.report.commands[0]?.cleanupErrors, undefined);
  const report = JSON.parse((await f.artifacts.read(result.reportArtifact)).toString());
  assert.equal(report.id, result.report.id); assert.equal(report.status, result.report.status);
  assert.deepEqual(report.commands, result.report.commands);
  assert.equal(report.sourceAudit.verified, true);
  assert.deepEqual(result.report.logArtifact, result.reportArtifact);
  assert.ok(result.snapshotArtifact); assert.ok(result.preparationArtifact);
  assert.deepEqual(result.fixtureReceiptArtifact, f.profile.receipt);
  assert.equal(result.fixtureProfileId, f.profile.id);
  assert.ok(result.evidenceArtifacts.some(artifact => artifact.id === f.profile.receipt.id));
  assert.equal(JSON.parse((await f.artifacts.read(result.snapshotArtifact)).toString()).sourceDigest, f.snapshot.sourceDigest);
  await assert.rejects(f.adapter.product(result.id), /no authenticated successful preview product/);
  await assert.rejects(f.adapter.start(result.id, authority.attemptId), /no authenticated successful preview product/);
  await f.snapshots.verify(f.snapshot);
});

test('unknown native teardown retains original and release failures with complete preparation and no product', async t => {
  let checks = 0, releases = 0;
  const checker: CheckExecutor = async () => {
    checks++;
    throw new NativeTeardownError('original unconfirmed group');
  };
  checker.release = async () => {
    releases++;
    throw new Error('second release failure');
  };
  const f = await buildFixture(t, checker);
  const result = await f.adapter.build(f.snapshot, f.profile, { authority });
  assert.equal(checks, 1); assert.equal(releases, 1);
  assert.equal(result.status, 'failed'); assert.equal(result.report.status, 'failed');
  assert.equal(result.product, undefined); assert.deepEqual(result.productArtifacts, []);
  assert.deepEqual(result.report.cleanupErrors, ['original unconfirmed group', 'second release failure']);
  assert.equal(result.report.commands.length, 1);
  assert.equal(result.report.commands[0]?.exitCode, 1);
  assert.equal(result.report.commands[0]?.stderr, 'original unconfirmed group');
  assert.deepEqual(result.report.commands[0]?.cleanupErrors, ['original unconfirmed group']);
  const report = JSON.parse((await f.artifacts.read(result.reportArtifact)).toString());
  assert.deepEqual(report.cleanupErrors, result.report.cleanupErrors);
  assert.deepEqual(report.commands, result.report.commands);
  assert.equal(report.sourceAudit.verified, false);
  const preparation = JSON.parse((await f.artifacts.read(result.preparationArtifact)).toString());
  assert.equal(preparation.status, 'failed');
  assert.deepEqual(preparation.report, result.report);
  assert.deepEqual(preparation.reportArtifact, result.reportArtifact);
  assert.deepEqual(preparation.snapshotArtifact, result.snapshotArtifact);
  assert.deepEqual(preparation.fixtureReceiptArtifact, f.profile.receipt);
  assert.deepEqual(preparation.evidenceArtifacts, result.evidenceArtifacts);
  assert.deepEqual(preparation.candidate, JSON.parse(JSON.stringify(result.candidate)));
  await assert.rejects(f.adapter.product(result.id), /no authenticated successful preview product/);
});

test('a checker that mutates frozen source cannot promote its successful exit into a native product', async t => {
  const checker: CheckExecutor = async context => {
    await writeFile(join(context.path, 'source.txt'), 'changed after source capture\n');
    return { command: context.command, exitCode: 0, stdout: 'BUILD SUCCEEDED with mutated input', stderr: 'retained mutation diagnostic',
      startedAt: '2026-10-08T12:00:00.000Z', endedAt: '2026-10-08T12:00:01.000Z' };
  };
  const f = await buildFixture(t, checker);
  const result = await f.adapter.build(f.snapshot, f.profile, { authority });
  assert.equal(result.status, 'failed'); assert.equal(result.product, undefined);
  assert.equal(result.report.status, 'failed');
  assert.equal(result.report.commands[0]?.exitCode, 0, 'the original command outcome remains honest');
  assert.equal(result.report.commands[0]?.stdout, 'BUILD SUCCEEDED with mutated input');
  assert.equal(result.report.commands[0]?.stderr, 'retained mutation diagnostic');
  const report = JSON.parse((await f.artifacts.read(result.reportArtifact)).toString());
  assert.deepEqual(report.commands, result.report.commands);
  assert.equal(report.sourceAudit.verified, false);
  assert.match(report.sourceAudit.error, /source changed/);
  assert.ok(result.snapshotArtifact); assert.ok(result.preparationArtifact);
});

test('an attested original archive prepares an owned product and delegates through the backend', { skip: process.platform !== 'darwin' }, async t => {
  const calls: Array<[string, ...unknown[]]> = [];
  const readiness = { status: 'ready' as const, reasons: [] };
  const observation = { sessionId: 'native-session', observationId: 'observation-1', observedAt: '2026-10-08T12:00:02.000Z', appState: 'active',
    screenshot: { path: '/unused-fake-screenshot.png', mimeType: 'image/png' as const, sha256: 'a'.repeat(64), width: 100, height: 100 }, elements: [], truncated: false };
  const outcome = { performed: true, requiresObservation: true as const };
  const backend = {
    readiness: async (platform: NativePlatform) => { calls.push(['readiness', platform]); return readiness; },
    requestMacPermissions: async () => { calls.push(['permissions']); return readiness; },
    start: async (product: NativeProduct, owner: string) => {
      calls.push(['start', product, owner]);
      return { id: 'native-session', ownerAttemptId: owner, platform: product.platform, product, startedAt: '2026-10-08T12:00:02.000Z', directory: '/unused-fake-session' };
    },
    observe: async (id: string) => { calls.push(['observe', id]); return observation; },
    act: async (id: string, action: NativeAction) => { calls.push(['act', id, action]); return outcome; },
    stop: async (id: string) => { calls.push(['stop', id]); },
    discover: async () => { calls.push(['discover']); return []; },
    closeTransport: () => { calls.push(['close']); },
  } as unknown as NativeInspectionBackend;
  let f: Awaited<ReturnType<typeof buildFixture>>;
  f = await buildFixture(t, attestedChecker(() => f.artifacts), backend);
  const result = await f.adapter.build(f.snapshot, f.profile, { authority });
  assert.equal(result.status, 'passed', result.error);
  assert.ok(result.product); assert.equal(result.product.source.kind, 'development-snapshot');
  assert.equal(result.product.source.snapshotSha256, f.snapshot.sourceDigest);
  assert.equal(result.product.source.reportSha256, result.reportArtifact.sha256);
  assert.equal(result.product.originalArtifactSha256, result.productArtifacts[0]?.sha256);
  assert.equal(result.evidenceArtifacts.length, 2); assert.equal(result.productArtifacts.length, 1);
  assert.deepEqual(result.fixtureReceiptArtifact, f.profile.receipt);
  assert.equal(result.fixtureProfileId, f.profile.id);
  assert.ok(result.evidenceArtifacts.some(artifact => artifact.id === f.profile.receipt.id));
  assert.deepEqual(result.product.launchArguments, ['--production-fixture', result.product.fixture.runId]);
  assert.equal(result.product.fixture.evidenceSha256, f.profile.fixtureEvidenceSha256);
  assert.deepEqual(await f.adapter.product(result.id), result.product);
  assert.equal(calls.length, 0, 'preparation must not launch or request native permissions');

  assert.deepEqual(await f.adapter.readiness('macos'), readiness);
  assert.deepEqual(await f.adapter.requestMacPermissions(), readiness);
  const session = await f.adapter.start(result.id, authority.attemptId);
  assert.deepEqual(session.product, result.product);
  assert.deepEqual(await f.adapter.observe(session.id), observation);
  const action: NativeAction = { kind: 'click', observationId: observation.observationId, elementId: 'button-retain' };
  assert.deepEqual(await f.adapter.act(session.id, action), outcome);
  await f.adapter.stop(session.id); assert.deepEqual(await f.adapter.discover(), []); f.adapter.closeTransport();
  assert.deepEqual(calls, [
    ['readiness', 'macos'], ['permissions'], ['start', result.product, authority.attemptId],
    ['observe', session.id], ['act', session.id, action], ['stop', session.id], ['discover'], ['close'],
  ]);

  await writeFile(join(result.product.appPath, 'Contents', 'MacOS', 'Fixture'), '#!/bin/sh\nchanged bytes\n');
  await assert.rejects(f.adapter.start(result.id, authority.attemptId), /App bytes differ/);
  assert.equal(calls.filter(([kind]) => kind === 'start').length, 1, 'changed prepared bytes never reach the backend');
});

test('native preparation preserves UTF-8 resource names when the fixed producer omits the UTF-8 flag', { skip: process.platform !== 'darwin' }, async t => {
  const marker = 'Exact unflagged Unicode resource bytes.\n';
  const entries: ZipEntry[] = [...appEntries(),
    { name: 'Fixture.app/Contents/Resources/' },
    { name: 'Fixture.app/Contents/Resources/caf\u00e9.txt', data: marker, method: 8 as const },
  ].map(entry => ({ ...entry, flags: 0 }));
  assert.equal(validateNativeAppZip(zip(entries)).entryCount, entries.length);
  let f: Awaited<ReturnType<typeof buildFixture>>;
  f = await buildFixture(t, attestedChecker(() => f.artifacts, entries));
  const result = await f.adapter.build(f.snapshot, f.profile, { authority });
  assert.equal(result.status, 'passed', result.error); assert.ok(result.product);
  assert.equal(await readFile(join(result.product.appPath, 'Contents', 'Resources', 'caf\u00e9.txt'), 'utf8'), marker);
  assert.deepEqual(await f.adapter.product(result.id), result.product);
});

test('native preparation reserves filesystem-folded resource names before writing or extracting the archive', { skip: process.platform !== 'darwin' }, async t => {
  const names = ['\u03c3.txt', '\u03c2.txt']; // Sigma and final sigma remain distinct under JS lowercase.
  const entries: ZipEntry[] = [...appEntries(), { name: 'Fixture.app/Contents/Resources/' },
    ...names.map((name, index) => ({ name: `Fixture.app/Contents/Resources/${name}`, data: `distinct original payload ${index}\n` })),
  ];
  const archive = zip(entries);
  assert.equal(validateNativeAppZip(archive).entryCount, entries.length, 'structural validation must accept both distinct archive paths');
  let f: Awaited<ReturnType<typeof buildFixture>>;
  f = await buildFixture(t, attestedChecker(() => f.artifacts, entries));
  // Case-sensitive Mac volumes can represent both names. Exercise this regression
  // only where this target filesystem actually aliases the Unicode pair.
  const probe = join(f.directory, 'filesystem-fold-probe'); await mkdir(probe);
  await writeFile(join(probe, names[0]!), '', { flag: 'wx' });
  try {
    await writeFile(join(probe, names[1]!), '', { flag: 'wx' });
    t.skip('The target filesystem does not fold sigma and final sigma'); return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }

  const result = await f.adapter.build(f.snapshot, f.profile, { authority });
  assert.equal(result.status, 'failed'); assert.equal(result.product, undefined);
  assert.match(result.error ?? '', /Archive paths collide on this filesystem/);
  assert.equal(result.report.commands[0]?.exitCode, 0, 'the original successful compilation result remains available');
  const retained = JSON.parse((await f.artifacts.read(result.reportArtifact)).toString());
  assert.equal(retained.sourceAudit.verified, true);
  assert.deepEqual(await f.artifacts.read(result.productArtifacts[0]!), archive);
  const productDirectory = join(f.dataDir, 'native-products', result.id, 'product-0');
  assert.equal((await lstat(productDirectory)).isDirectory(), true);
  for (const name of ['names', 'original.zip', 'extracted']) {
    await assert.rejects(lstat(join(productDirectory, name)), { code: 'ENOENT' });
  }
  // The extractor's destination is created immediately before the fixed ditto
  // call and is retained on failure; absence proves this stopped beforehand.
  await assert.rejects(f.adapter.product(result.id), /no authenticated successful preview product/);
});

test('a protected fixture source scope rejects new logic while permitting its explicitly allowed UI file to change', async t => {
  let called = 0;
  const changedUI = 'let title = "Allowed new UI content"\n';
  const f = await buildFixture(t, async context => {
    called++;
    assert.equal(await readFile(join(context.path, 'Sources', 'View.swift'), 'utf8'), changedUI);
    return { command: context.command, exitCode: 65, stdout: 'fixture source gate accepted the allowed UI edit', stderr: 'controlled compiler failure',
      startedAt: '2026-10-08T12:00:00.000Z', endedAt: '2026-10-08T12:00:01.000Z' };
  });
  await mkdir(join(f.source, 'Sources'));
  await writeFile(join(f.source, 'Sources', 'Isolation.swift'), 'let isolatedFixture = true\n');
  await writeFile(join(f.source, 'Sources', 'View.swift'), 'let title = "Old UI content"\n');
  const audit = JSON.parse((await f.artifacts.read(f.profile.receipt)).toString());
  audit.roots[0].entries.push({ path: 'Sources/Isolation.swift', sha256: createHash('sha256').update(await readFile(join(f.source, 'Sources', 'Isolation.swift'))).digest('hex') });
  audit.roots[0].protectedSourceDirectories = ['Sources'];
  audit.roots[0].allowedPaths = ['Sources/View.swift'];
  const receipt = await f.artifacts.put(JSON.stringify(audit), { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId,
    name: 'protected-fixture-source-audit.json', mime: 'application/json' });
  const guarded = { ...f.profile, receipt, fixtureEvidenceSha256: receipt.sha256 };
  await writeFile(join(f.source, 'Sources', 'NewLogic.swift'), 'let unauditedLogic = true\n');
  const unsafe = await f.snapshots.create({ roots: f.roots, context: authority });
  await f.snapshots.verify(unsafe);
  await assert.rejects(f.adapter.build(unsafe, guarded, { authority }),
    (error: unknown) => error instanceof NativeInspectionError && error.code === 'fixture-source-changed' && error.message.includes('Sources/NewLogic.swift'));
  assert.equal(called, 0);

  await rm(join(f.source, 'Sources', 'NewLogic.swift'));
  await writeFile(join(f.source, 'Sources', 'View.swift'), changedUI);
  const allowed = await f.snapshots.create({ roots: f.roots, context: authority });
  await f.snapshots.verify(allowed);
  const result = await f.adapter.build(allowed, guarded, { authority });
  assert.equal(called, 1);
  assert.equal(result.report.commands[0]?.stdout, 'fixture source gate accepted the allowed UI edit');
  assert.deepEqual(result.fixtureReceiptArtifact, receipt);
});

test('a symlink at the protected fixture directory itself is rejected before compilation', async t => {
  let called = 0;
  const f = await buildFixture(t, async () => { called++; throw new Error('A replaced protected directory must not reach compilation'); });
  const audit = JSON.parse((await f.artifacts.read(f.profile.receipt)).toString());
  audit.roots[0].protectedSourceDirectories = ['Sources'];
  audit.roots[0].allowedPaths = ['Sources/View.swift'];
  const receipt = await f.artifacts.put(JSON.stringify(audit), { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId,
    name: 'protected-directory-source-audit.json', mime: 'application/json' });
  await mkdir(join(f.source, 'AlternateSources')); await writeFile(join(f.source, 'AlternateSources', 'View.swift'), 'let redirected = true\n');
  await symlink('AlternateSources', join(f.source, 'Sources'));
  const snapshot = await f.snapshots.create({ roots: f.roots, context: authority });
  await f.snapshots.verify(snapshot);
  assert.ok(snapshot.manifest.roots[0]!.entries.some(entry => entry.path === 'Sources' && entry.kind === 'symlink'));
  await assert.rejects(f.adapter.build(snapshot, { ...f.profile, receipt, fixtureEvidenceSha256: receipt.sha256 }, { authority }),
    (error: unknown) => error instanceof NativeInspectionError && error.code === 'fixture-source-changed' && error.message.includes('Protected fixture directory became a file or link: Sources'));
  assert.equal(called, 0);
});

test('an unknown native session prevents retirement of its original prepared product', { skip: process.platform !== 'darwin' }, async t => {
  let uncertain: NativeProduct | undefined, launches = 0;
  const backend = {
    discover: async () => uncertain ? [{ id: 'unknown-session', ownerAttemptId: 'uncertain-attempt', platform: uncertain.platform, product: uncertain,
      status: 'unknown', startedAt: '2026-10-08T12:00:00.000Z', directory: '/unused-unknown-session' }] : [],
    start: async () => { launches++; throw new Error('Tests must never launch a native app'); },
  } as unknown as NativeInspectionBackend;
  const f = await preparedFixture(t, backend);
  uncertain = f.product;
  await assert.rejects(f.adapter.retirePreparedProduct(f.result.id, { releaseConfirmed: true }),
    (error: unknown) => error instanceof NativeInspectionError && error.code === 'native-busy');
  assert.deepEqual(await f.adapter.product(f.result.id), f.product);
  assert.equal((await lstat(f.product.appPath)).isDirectory(), true);
  assert.equal(launches, 0); assert.equal(f.checks(), 1);
});

test('retirement preserves original artifacts and restoration preserves identity without either source checkout or compilation', { skip: process.platform !== 'darwin' }, async t => {
  const f = await preparedFixture(t);
  const references = [...new Map([
    f.result.preparationArtifact, f.result.reportArtifact, f.result.snapshotArtifact, f.result.fixtureReceiptArtifact,
    ...f.result.evidenceArtifacts, ...f.result.productArtifacts, f.result.candidate.bundleArtifact, f.result.candidate.diffArtifact,
  ].map(reference => [reference.id, reference])).values()];
  const originalBytes = new Map(await Promise.all(references.map(async reference => [reference.id, await f.artifacts.read(reference)] as const)));
  const sibling = join(f.dataDir, 'native-products', 'unrelated-sibling');
  await mkdir(sibling, { mode: 0o700 }); await writeFile(join(sibling, 'sentinel'), 'preserve sibling\n');
  await f.adapter.retirePreparedProduct(f.result.id, { releaseConfirmed: true });
  await assert.rejects(lstat(join(f.dataDir, 'native-products', f.result.id)), { code: 'ENOENT' });
  assert.equal(await readFile(join(sibling, 'sentinel'), 'utf8'), 'preserve sibling\n');
  for (const reference of references) assert.deepEqual(await f.artifacts.read(reference), originalBytes.get(reference.id));

  await writeFile(join(f.source, 'source.txt'), 'the original author checkout changed after this build\n');
  await rm(f.source, { recursive: true }); await f.snapshots.remove(f.snapshot);
  await assert.rejects(lstat(f.source), { code: 'ENOENT' }); await assert.rejects(lstat(f.snapshot.path), { code: 'ENOENT' });
  let restorationChecks = 0;
  const restarted = new NativeInspectionAdapter({ dataDir: f.dataDir, artifacts: f.artifacts, backend: f.backend,
    checkExecutor: async () => { restorationChecks++; throw new Error('Restore must not compile source'); } });
  const restored = await restarted.restorePreparedProduct(f.result.id, f.result.preparationArtifact);
  assert.deepEqual(restored, f.product, 'app path, fixture RUN, arguments, inventory and all source/report/archive identities remain exact');
  assert.deepEqual(await restarted.product(f.result.id), f.product);
  assert.equal(await readFile(join(restored.appPath, 'Contents', 'MacOS', 'Fixture'), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.equal(restorationChecks, 0); assert.equal(f.checks(), 1);
  for (const reference of references) assert.deepEqual(await f.artifacts.read(reference), originalBytes.get(reference.id));
});

test('corruption of the retained original ZIP blocks restoration without rebuilding or publishing a partial product', { skip: process.platform !== 'darwin' }, async t => {
  const f = await preparedFixture(t);
  await f.adapter.retirePreparedProduct(f.result.id, { releaseConfirmed: true });
  const archive = f.result.productArtifacts[0]!;
  await writeFile(await f.artifacts.path(archive), 'corrupted retained original archive');
  await assert.rejects(f.adapter.restorePreparedProduct(f.result.id, f.result.preparationArtifact), /failed integrity verification/);
  await assert.rejects(lstat(join(f.dataDir, 'native-products', f.result.id)), { code: 'ENOENT' });
  assert.equal(f.checks(), 1);
  assert.ok((await f.artifacts.read(f.result.reportArtifact)).length > 0);
});

test('a reusable prior-attempt fixture receipt receives current ownership without changing original bytes or provenance', async t => {
  let called = 0;
  const f = await buildFixture(t, async context => {
    called++;
    return { command: context.command, exitCode: 65, stdout: 'fixture receipt accepted', stderr: 'controlled compiler failure',
      startedAt: '2026-10-08T12:00:00.000Z', endedAt: '2026-10-08T12:00:01.000Z' };
  });
  const originalBytes = await f.artifacts.read(f.profile.receipt);
  const original = await f.artifacts.put(originalBytes, { goalId: authority.goalId, taskId: authority.taskId, attemptId: 'prior-attempt',
    name: 'original-prior-attempt-fixture-audit.json', mime: 'application/json' });
  const result = await f.adapter.build(f.snapshot, { ...f.profile, receipt: original, fixtureEvidenceSha256: original.sha256 }, { authority });
  assert.equal(called, 1); assert.equal(result.report.commands[0]?.exitCode, 65);
  const current = result.fixtureReceiptArtifact;
  assert.notEqual(current.id, original.id);
  assert.equal(current.sha256, original.sha256);
  assert.equal(current.goalId, authority.goalId); assert.equal(current.taskId, authority.taskId); assert.equal(current.attemptId, authority.attemptId);
  assert.deepEqual(current.metadata?.originalReceipt, original);
  assert.deepEqual(await f.artifacts.read(current), originalBytes);
  assert.deepEqual(await f.artifacts.get(original.id), original);
  assert.deepEqual(await f.artifacts.read(original), originalBytes);
  assert.ok(result.evidenceArtifacts.some(reference => reference.id === current.id));
  const preparation = JSON.parse((await f.artifacts.read(result.preparationArtifact)).toString());
  assert.deepEqual(preparation.fixtureReceiptArtifact, current);
  assert.deepEqual(preparation.fixtureProfile.receipt, original);
});

test('a mismatched snapshot artifact fails before checking and removes only its newly created product cache', async t => {
  let called = 0;
  const f = await buildFixture(t, async () => { called++; throw new Error('A mismatched source artifact must not reach compilation'); });
  const mismatchBytes = JSON.stringify({ ...f.snapshot.manifest, id: 'a-different-snapshot' });
  const mismatch = await f.artifacts.put(mismatchBytes, { goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId,
    name: 'mismatched-source-manifest.json', mime: 'application/json' });
  const snapshot = { ...f.snapshot, manifestArtifact: mismatch };
  await f.snapshots.verify(snapshot);
  const products = join(f.dataDir, 'native-products'), sibling = join(products, 'preserved-sibling');
  await mkdir(products, { mode: 0o700 }); await mkdir(sibling, { mode: 0o700 }); await writeFile(join(sibling, 'sentinel'), 'preserve existing cache\n');
  await assert.rejects(f.adapter.build(snapshot, f.profile, { authority }),
    (error: unknown) => error instanceof NativeInspectionError && error.code === 'source-changed');
  assert.equal(called, 0);
  assert.deepEqual(await readdir(products), ['preserved-sibling']);
  assert.equal(await readFile(join(sibling, 'sentinel'), 'utf8'), 'preserve existing cache\n');
  assert.equal((await f.artifacts.read(mismatch)).toString(), mismatchBytes);
  assert.deepEqual(await f.artifacts.get(f.profile.receipt.id), f.profile.receipt);
  await f.snapshots.verify(f.snapshot);
});
