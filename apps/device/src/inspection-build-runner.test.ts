import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { ArtifactStore, InspectionSnapshotManager } from '@enoughfactory/workspaces';
import { NativeBuildRunner, type NativeBuildOwner, type NativeBuildRequest } from './inspection-build-runner.ts';

const authority = { goalId: 'goal-build-supervision', goalRevision: 3, taskId: 'task-build-supervision', attemptId: 'attempt-build-supervision', authorityGeneration: 2, policyRevision: 1 };
const profile = {
  id: 'test-build-profile',
  build: { tool: 'xcodebuild' as const, project: 'Fixture.xcodeproj', scheme: 'Fixture', platform: 'macos' as const, configuration: 'Debug' as const },
  launchArguments: ['--fixture', '{runId}'],
  fixtureEvidenceSha256: 'a'.repeat(64),
};

const execute = promisify(execFile);
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, message: string, timeout = 5000): Promise<T> {
  const end = Date.now() + timeout;
  let last: T | undefined;
  let lastError: unknown;
  do {
    try { last = await read(); if (accept(last)) return last; }
    catch (error) { lastError = error; }
    await delay(25);
  } while (Date.now() < end);
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : `: ${JSON.stringify(last)}`}`);
}

async function exists(path: string): Promise<boolean> {
  try { await readFile(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function running(pid: number): Promise<boolean> {
  const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'stat='], { timeout: 1000 }).catch(error => {
    if ((error as { code?: number }).code === 1) return { stdout: '' };
    throw error;
  });
  return result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z');
}

async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'enough-native-build-supervision-')));
  const owned = join(directory, 'owned');
  await mkdir(owned, { mode: 0o700 });
  const source = join(directory, 'source');
  await mkdir(source);
  await writeFile(join(source, 'source.txt'), 'immutable authored source\n');
  const artifacts = new ArtifactStore(join(directory, 'artifacts'), 'build-owner-device');
  const snapshots = new InspectionSnapshotManager({ dataDir: owned, artifacts });
  const snapshot = await snapshots.create({ roots: [{ id: 'primary', name: 'primary', path: source }], context: authority });
  const children = new Set<ChildProcess>();
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
    }
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, owned, children, cleanups, source, artifacts, snapshots, snapshot };
}

async function protocolWorker(directory: string): Promise<string> {
  const file = join(directory, 'protocol-worker.cjs');
  await writeFile(file, String.raw`
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {createInterface} = require('node:readline');
const [mode, directory, key] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
const write = (name, value) => fs.writeFileSync(path.join(directory, name), JSON.stringify(value), {mode:0o600});
const request = read('request.json'), registered = read('owner.json');
write('registration-observed.json', registered);
if (registered.status !== 'registered' || registered.key !== key || registered.jobId !== request.jobId) throw new Error('The worker started without a durable owner registration');
const identity = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart=', '-o', 'command='], {encoding: 'utf8'}).trim();
write('ready.json', {version: 1, key, jobId: request.jobId, pid: process.pid, identity, readyAt: new Date().toISOString()});
process.stdout.write(JSON.stringify({ready: key, pid: process.pid}) + '\n');
const input = createInterface({input: process.stdin});
input.on('line', line => {
  const message = JSON.parse(line);
  if (message.key !== key || message.type !== 'START') return;
  const owner = read('owner.json');
  if (owner.status !== 'running' || owner.startAuthorized !== true || owner.pid !== process.pid || owner.identity !== identity || message.requestSha256 !== registered.requestSha256) throw new Error('Start preceded durable process authorization');
  write('effect-started.json', {pid: process.pid, startedAt: new Date().toISOString()});
  // Deliberately violate the trusted worker protocol: process exit alone must
  // never be upgraded to a known preparation/teardown outcome.
  if (mode === 'missing-completion') process.exit(0);
});
`);
  return file;
}

async function supervisedWorker(directory: string): Promise<string> {
  const file = join(directory, 'supervised-worker.mts');
  const workerModule = new URL('./inspection-build-worker.ts', import.meta.url).href;
  const groupModule = new URL('../../../packages/workspaces/src/apple-checks.ts', import.meta.url).href;
  await writeFile(file, `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runNativeBuildWorker } from ${JSON.stringify(workerModule)};
import { runNativeGroup, NativeTeardownError } from ${JSON.stringify(groupModule)};
const [mode, directory] = process.argv.slice(2);
const initialOwner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
await writeFile(join(directory, 'registration-observed.json'), JSON.stringify(initialOwner), {mode:0o600});
if (initialOwner.status !== 'registered') throw new Error('The fixed worker started before durable registration');
await runNativeBuildWorker({build: async (request, signal) => {
  const owner = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
  await writeFile(join(directory, 'authorization-observed.json'), JSON.stringify(owner), {mode:0o600});
  if (owner.status !== 'running' || owner.startAuthorized !== true || owner.pid !== process.pid) throw new Error('The fixed build effect preceded durable exact process authorization');
  await writeFile(join(directory, 'effect-started.json'), JSON.stringify({pid: process.pid}), {mode:0o600});
  if (mode === 'throw-error') throw new Error('Original fixed-worker failure');
  if (mode === 'throw-teardown') throw new NativeTeardownError('Owned compiler teardown could not be confirmed');
  const childCode = "const fs=require('node:fs');fs.writeFileSync(" + JSON.stringify(join(directory, 'child.json')) + ",JSON.stringify({pid:process.pid}));process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(" + JSON.stringify(join(directory, 'child-heartbeat')) + ",'x'),15)";
  const result = await runNativeGroup(process.execPath, ['-e', childCode], {cwd:request.snapshot.roots[0].path,env:{PATH:'/usr/bin:/bin'},timeoutMs:30_000,signal});
  await writeFile(join(directory, 'child-result.json'), JSON.stringify(result), {mode:0o600});
  throw new Error(signal.aborted ? 'Owned build canceled after child teardown' : 'Unexpected heartbeat child exit');
}});
`);
  return file;
}

function fixedWorkerCommand(file: string, mode: string) {
  return { file: process.execPath, args: ['--import', fileURLToPath(import.meta.resolve('tsx')), file, mode] };
}

test('the production worker retains its whole failed check and verifies original artifacts during recovery', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  const receipt = await f.artifacts.put(JSON.stringify({
    version: 1, kind: 'native-fixture-source-audit', profileId: profile.id, build: profile.build, launchArguments: profile.launchArguments,
    roots: f.snapshot.manifest.roots.map(root => ({ name: root.name,
      entries: root.entries.flatMap(entry => entry.kind === 'file' ? [{ path: entry.path, sha256: entry.sha256 }] : []) })),
  }), { ...authority, name: 'fixed-native-fixture-audit.json', mime: 'application/json' });
  const auditedProfile = { ...profile, receipt, fixtureEvidenceSha256: receipt.sha256 };
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, startupTimeoutMs: 5000 });
  const jobId = 'original-failed-build-report';
  const build = await runner.build(f.snapshot, auditedProfile, { authority, jobId });
  assert.equal(build.status, 'failed', 'The intentionally absent Xcode project must fail honestly');
  assert.equal(build.product, undefined);
  assert.equal(build.report.commands.length, 1);
  assert.equal(build.report.commands[0]!.exitCode, 1);
  assert.equal(build.candidate.commit, f.snapshot.roots[0]!.commit);
  assert.equal(build.fixtureReceiptArtifact.sha256, receipt.sha256);
  const whole = JSON.parse((await f.artifacts.read(build.reportArtifact)).toString());
  assert.deepEqual(whole.commands, build.report.commands);
  assert.equal(whole.sourceIdentity.sha256, f.snapshot.sourceDigest);
  assert.equal(whole.originalCommandCount, 1);
  const recovered = await new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts }).recover(jobId);
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
  if (recovered.status === 'completed') assert.deepEqual(recovered.build, build);
  await rm(await f.artifacts.path(build.reportArtifact));
  assert.equal((await runner.recover(jobId)).status, 'unknown', 'Missing original check bytes must prevent a recovered completion claim');
});

test('external verifier copies require a fixed private root and exact trusted registration before the production worker starts', { timeout: 15_000 }, async t => {
  const f = await fixture(t), verifierRoot = join(f.directory, 'verifier-copies');
  await mkdir(verifierRoot, { mode: 0o700 });
  const verifierSnapshots = new InspectionSnapshotManager({ dataDir: verifierRoot, artifacts: f.artifacts });
  const snapshot = await verifierSnapshots.create({ roots: [{ id: 'primary', name: 'primary', path: f.source }], context: authority });
  let verified = 0;
  const verifySnapshot = async (selected: typeof snapshot, signal?: AbortSignal) => {
    assert.equal(selected.path, snapshot.path);
    verified++;
    await verifierSnapshots.verify(selected, signal);
  };
  const receipt = await f.artifacts.put(JSON.stringify({
    version: 1, kind: 'native-fixture-source-audit', profileId: profile.id, build: profile.build, launchArguments: profile.launchArguments,
    roots: snapshot.manifest.roots.map(root => ({ name: root.name,
      entries: root.entries.flatMap(entry => entry.kind === 'file' ? [{ path: entry.path, sha256: entry.sha256 }] : []) })),
  }), { ...authority, name: 'external-verifier-fixture-audit.json', mime: 'application/json' });
  const auditedProfile = { ...profile, receipt, fixtureEvidenceSha256: receipt.sha256 };
  for (const [index, registration] of [{}, { verifySnapshot }, { verifierCopiesRoot: verifierRoot }].entries()) {
    const rejectedRunner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, ...registration });
    const jobId = `unregistered-verifier-${index}`;
    await assert.rejects(rejectedRunner.build(snapshot, auditedProfile, { authority, jobId }), /exact trusted service registration/);
    assert.equal(await exists(join(rejectedRunner.root, jobId, 'request.json')), false, 'An unregistered copy cannot reach worker launch');
  }
  verified = 0;
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, verifySnapshot, verifierCopiesRoot: verifierRoot, startupTimeoutMs: 5000 });
  const jobId = 'registered-verifier-build';
  const build = await runner.build(snapshot, auditedProfile, { authority, jobId });
  assert.equal(verified, 1, 'The trusted verifier must validate the exact external copy before registration');
  assert.equal(build.status, 'failed', 'Missing Xcode project remains an ordinary original failed build');
  const request = JSON.parse(await readFile(join(runner.root, jobId, 'request.json'), 'utf8')) as NativeBuildRequest;
  assert.deepEqual(request.verifierOwnedSnapshot, { root: verifierRoot, path: snapshot.path,
    manifestSha256: createHash('sha256').update(JSON.stringify(snapshot.manifest)).digest('hex') });
  assert.equal(request.snapshot.id, snapshot.id);
  assert.equal(build.candidate.commit, snapshot.roots[0]!.commit);
  const recovered = await new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts }).recover(jobId);
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
  if (recovered.status === 'completed') assert.deepEqual(recovered.build, build);
});

test('a typed compiler teardown failure retains an unknown outcome and cannot be replaced', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await supervisedWorker(f.directory);
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, workerCommand: fixedWorkerCommand(worker, 'throw-teardown'), startupTimeoutMs: 5000 });
  const jobId = 'unconfirmed-compiler-teardown';
  await assert.rejects(runner.build(f.snapshot, profile, { authority, jobId }), /outcome is unknown/);
  const receipt = JSON.parse(await readFile(join(runner.root, jobId, 'completion.json'), 'utf8')) as { teardownConfirmed: boolean; error: string };
  assert.equal(receipt.teardownConfirmed, false);
  assert.equal(receipt.error, 'Owned compiler teardown could not be confirmed');
  assert.equal((await runner.recover(jobId)).status, 'unknown');
  await assert.rejects(runner.build(f.snapshot, profile, { authority, jobId }));
  assert.equal(await readFile(join(f.snapshot.roots[0]!.path, 'source.txt'), 'utf8'), 'immutable authored source\n');
});

test('native build effects start only after a durable registration and exact worker authorization', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await supervisedWorker(f.directory);
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, workerCommand: fixedWorkerCommand(worker, 'throw-error'), startupTimeoutMs: 5000, cancelTimeoutMs: 3000 });
  const jobId = 'journal-gated-build';
  await assert.rejects(runner.build(f.snapshot, profile, { authority, jobId }), /Original fixed-worker failure/);
  const directory = join(runner.root, jobId);
  const registration = JSON.parse(await readFile(join(directory, 'registration-observed.json'), 'utf8')) as NativeBuildOwner;
  const authorized = JSON.parse(await readFile(join(directory, 'authorization-observed.json'), 'utf8')) as NativeBuildOwner;
  assert.equal(registration.status, 'registered');
  assert.equal(registration.pid, undefined);
  assert.equal(authorized.status, 'running');
  assert.equal(authorized.startAuthorized, true);
  assert.ok(authorized.identity?.includes(authorized.key));
  assert.equal(JSON.parse(await readFile(join(directory, 'effect-started.json'), 'utf8')).pid, authorized.pid);
  const recovered = await new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts }).recover(jobId);
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
  if (recovered.status === 'completed') {
    assert.equal(recovered.canceled, false);
    assert.equal(recovered.error, 'Original fixed-worker failure');
  }
});

test('a dead worker without an original completion receipt remains unknown and fences replacement', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await protocolWorker(f.directory);
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, workerCommand: { file: process.execPath, args: [worker, 'missing-completion'] }, startupTimeoutMs: 5000, cancelTimeoutMs: 500 });
  const jobId = 'missing-build-receipt';
  await assert.rejects(runner.build(f.snapshot, profile, { authority, jobId }), /outcome is unknown/);
  const directory = join(runner.root, jobId), before = await readFile(join(directory, 'effect-started.json'), 'utf8');
  assert.equal(await exists(join(directory, 'completion.json')), false);
  const recovered = await new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts }).recover(jobId);
  assert.equal(recovered.status, 'unknown');
  await assert.rejects(runner.build(f.snapshot, profile, { authority, jobId }));
  assert.equal(await readFile(join(directory, 'effect-started.json'), 'utf8'), before);
  assert.equal(await readFile(join(f.source, 'source.txt'), 'utf8'), 'immutable authored source\n');
});

test('native build cancellation awaits real compiler child teardown before recording a completed outcome', { timeout: 15_000 }, async t => {
  const f = await fixture(t), worker = await supervisedWorker(f.directory);
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, workerCommand: fixedWorkerCommand(worker, 'wait'), startupTimeoutMs: 5000, cancelTimeoutMs: 5000 });
  const signal = new AbortController(), jobId = 'cancel-owned-build', directory = join(runner.root, jobId);
  f.cleanups.push(() => runner.cancel(jobId));
  const building = runner.build(f.snapshot, profile, { authority, jobId, signal: signal.signal });
  const rejected = assert.rejects(building, /canceled|cancelled/);
  const child = await eventually(async () => JSON.parse(await readFile(join(directory, 'child.json'), 'utf8')) as { pid: number }, value => Number.isSafeInteger(value.pid), 'Compiler child did not start');
  await eventually(() => readFile(join(directory, 'child-heartbeat'), 'utf8'), value => value.length > 0, 'Compiler child did not write its heartbeat');
  const started = Date.now(); signal.abort();
  await rejected;
  assert.ok(Date.now() - started < 6000, 'Cancellation must have a bounded confirmation time');
  const recovered = await runner.recover(jobId);
  assert.equal(recovered.status, 'completed', JSON.stringify(recovered));
  if (recovered.status === 'completed') assert.equal(recovered.canceled, true);
  assert.equal(await running(child.pid), false, 'A completion receipt cannot precede owned compiler teardown');
  const heartbeat = await readFile(join(directory, 'child-heartbeat'), 'utf8');
  await delay(75);
  assert.equal(await readFile(join(directory, 'child-heartbeat'), 'utf8'), heartbeat);
});

test('losing the parent service closes its private transport and the fixed worker awaits child teardown', { timeout: 15_000 }, async t => {
  const f = await fixture(t), worker = await supervisedWorker(f.directory), jobId = 'lost-parent-build';
  const specFile = join(f.directory, 'parent-spec.json'), parentFile = join(f.directory, 'service-parent.mts');
  await writeFile(specFile, JSON.stringify({ dataDir: f.owned, artifactsRoot: f.artifacts.root, deviceId: f.artifacts.deviceId,
    snapshot: f.snapshot, profile, authority, jobId, workerCommand: fixedWorkerCommand(worker, 'wait') }), { mode: 0o600 });
  await writeFile(parentFile, `
import { readFile } from 'node:fs/promises';
import { NativeBuildRunner } from ${JSON.stringify(new URL('./inspection-build-runner.ts', import.meta.url).href)};
import { ArtifactStore } from ${JSON.stringify(new URL('../../../packages/workspaces/src/artifacts.ts', import.meta.url).href)};
const spec=JSON.parse(await readFile(process.argv[2],'utf8'));
const runner=new NativeBuildRunner({dataDir:spec.dataDir,artifacts:new ArtifactStore(spec.artifactsRoot,spec.deviceId),workerCommand:spec.workerCommand,startupTimeoutMs:5000,cancelTimeoutMs:5000});
await runner.build(spec.snapshot,spec.profile,{authority:spec.authority,jobId:spec.jobId}).catch(()=>{});
`);
  const parent = spawn(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), parentFile, specFile], { stdio: 'pipe' });
  f.children.add(parent);
  const parentExit = new Promise<void>(resolve => parent.once('exit', () => resolve()));
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts });
  f.cleanups.push(() => new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, cancelTimeoutMs: 1000 }).cancel(jobId));
  const directory = join(runner.root, jobId);
  const child = await eventually(async () => JSON.parse(await readFile(join(directory, 'child.json'), 'utf8')) as { pid: number }, value => Number.isSafeInteger(value.pid), 'Owned compiler child did not start');
  await eventually(() => readFile(join(directory, 'child-heartbeat'), 'utf8'), value => value.length > 0, 'Compiler child did not begin writing');
  parent.kill('SIGKILL');
  await parentExit;
  const recovered = await eventually(() => runner.recover(jobId), result => result.status === 'completed', 'Orphaned worker did not confirm its original teardown', 7000);
  assert.equal(recovered.status, 'completed');
  if (recovered.status === 'completed') assert.equal(recovered.canceled, true);
  const completion = JSON.parse(await readFile(join(directory, 'completion.json'), 'utf8')) as { teardownConfirmed: boolean; started: boolean };
  assert.equal(completion.teardownConfirmed, true);
  assert.equal(completion.started, true);
  assert.equal(await running(child.pid), false);
});

test('recovery never signals a live replacement whose PID birth identity differs from the journal', { timeout: 10_000 }, async t => {
  const f = await fixture(t), worker = await protocolWorker(f.directory), jobId = 'recycled-worker-pid';
  const runner = new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, workerCommand: { file: process.execPath, args: [worker, 'missing-completion'] }, startupTimeoutMs: 5000, cancelTimeoutMs: 100 });
  await assert.rejects(runner.build(f.snapshot, profile, { authority, jobId }), /outcome is unknown/);
  const signalMarker = join(f.directory, 'foreign-process-signaled');
  const foreign = spawn(process.execPath, ['-e', `const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(signalMarker)},'wrong process'));process.stdout.write('ready\\n');setInterval(()=>{},1000);`], { stdio: 'pipe' });
  f.children.add(foreign);
  await new Promise<void>((resolve, reject) => {
    foreign.stdout.once('data', () => resolve());
    foreign.once('error', reject);
    foreign.once('exit', () => reject(new Error('Replacement process exited before readiness')));
  });
  assert.ok(foreign.pid);
  const ownerPath = join(runner.root, jobId, 'owner.json');
  const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as NativeBuildOwner;
  await writeFile(ownerPath, JSON.stringify({ ...owner, pid: foreign.pid, identity: `different birth identity ${owner.key}` }), { mode: 0o600 });
  const recovered = await new NativeBuildRunner({ dataDir: f.owned, artifacts: f.artifacts, cancelTimeoutMs: 100 }).cancel(jobId);
  assert.equal(recovered.status, 'unknown');
  assert.equal(await running(foreign.pid), true, 'A reused PID must never be killed based on its number');
  assert.equal(await exists(signalMarker), false);
});
