import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import type { InspectionAuthority } from '@enoughfactory/contracts';
import type { NativeAction, NativeProduct, NativeSession } from '@enoughfactory/native-inspection';
import {
  ArtifactStore, exportInspectionSnapshot, InspectionSnapshotManager,
  type InspectionSnapshot,
} from '@enoughfactory/workspaces';
import { NativeDelegationOwner, type NativeDelegationOwnerOptions } from './inspection-delegation-owner.ts';
import type { InspectionJournalEvent as JournalEvent, InspectionJournalPage as JournalPage } from './inspection-delegation-journal.ts';
import { NativeBuildUnknownError, type NativeBuildOwner, type NativeBuildRecovery } from './inspection-build-runner.ts';
import { InspectionJobs } from './inspection-jobs.ts';
import type { NativeInspectionBuild, NativeFixtureProfile } from './inspection-native.ts';
import type { RemoteInspectionAssignment, RemoteInspectionOperation } from './inspection-remote.ts';
import { Store } from './store.ts';

const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 9, taskId: 'task', attemptId: 'attempt-4', authorityGeneration: 4, policyRevision: 2 };
const profile: NativeFixtureProfile = {
  id: 'fixture-macos',
  build: { tool: 'xcodebuild', project: 'Fixture.xcodeproj', scheme: 'Fixture', platform: 'macos', configuration: 'Debug' },
  launchArguments: ['--production-fixture', '{runId}'],
  fixtureEvidenceSha256: 'f'.repeat(64),
};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Real immutable source/artifact transfer; only the operating-system adapter is replaced. */
async function fixture(t: { after(fn: () => Promise<void>): void }, options: { gitSources?: boolean } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'enough-delegated-native-owner-')));
  const dataDir = join(directory, 'owner'), store = new Store(dataDir);
  const authorArtifacts = new ArtifactStore(join(directory, 'author-artifacts'), 'author');
  const artifacts = new ArtifactStore(join(dataDir, 'artifacts'), 'mac-owner');
  const main = join(directory, 'author-main'), design = join(directory, 'author-design');
  await mkdir(join(main, 'Fixture.xcodeproj'), { recursive: true });
  await mkdir(design, { recursive: true });
  await writeFile(join(main, 'Fixture.xcodeproj', 'project.pbxproj'), '// Fixture project source.\n');
  await writeFile(join(main, 'Main.swift'), 'let title = "Captured dirty source"\n');
  await writeFile(join(design, 'Tokens.swift'), 'let spacing = 12\n');
  if (options.gitSources) {
    await writeFile(join(main, 'Main.swift'), 'let title = "Original saved source"\n');
    await writeFile(join(design, 'Tokens.swift'), 'let spacing = 8\n');
    for (const root of [main, design]) for (const args of [['init', '--quiet'], ['add', '--all'], ['commit', '--quiet', '-m', 'Original saved source']]) {
      await promisify(execFile)('/usr/bin/git', ['-c', 'user.name=Inspection fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-C', root, ...args]);
    }
    await writeFile(join(main, 'Main.swift'), 'let title = "Captured dirty source"\n');
    await writeFile(join(design, 'Tokens.swift'), 'let spacing = 12\n');
  }
  const snapshot = await new InspectionSnapshotManager({ dataDir: join(directory, 'author'), artifacts: authorArtifacts }).create({
    roots: [{ id: 'main', name: 'mail', path: main }, { id: 'enough-ui', name: 'design', path: design }], context: authority,
  });
  const transfer = await exportInspectionSnapshot({ snapshot, artifacts: authorArtifacts, context: authority });
  for (const artifact of [transfer.sourceManifest, ...transfer.sourceArtifacts.map(source => source.manifest)]) {
    await artifacts.importFile(await authorArtifacts.path(artifact), artifact);
  }
  const sources = await Promise.all(transfer.sourceArtifacts.map(async source => ({ ...source, path: await artifacts.path(source.manifest) })));
  const assignment: RemoteInspectionAssignment = {
    id: randomUUID(), authority, coordinatorId: 'coordinator', authorDeviceId: 'author', ownerDeviceId: 'mac-owner',
    executionTargetId: 'mac-owner:host', capability: 'macos-app-inspection',
    source: { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })) },
    profile: { projectId: 'mail-project', profileId: profile.id },
    sourceArtifacts: transfer.sourceArtifacts, sourceManifest: transfer.sourceManifest,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), digest: 'a'.repeat(64),
  };
  const jobs = new InspectionJobs(store, { deviceId: 'mac-owner', authorityCurrent: value => JSON.stringify(value) === JSON.stringify(authority) });
  const builds: Array<{ snapshot: InspectionSnapshot; profile: NativeFixtureProfile }> = [];
  const sessions = new Map<string, NativeSession>();
  const observations = new Map<string, string>();
  const actions: Array<{ sessionId: string; action: NativeAction }> = [];
  const restarts: Array<{ sessionId: string; observationId: string; previousPid?: number; pid: number }> = [];
  const stops: string[] = [], starts: string[] = [];
  const buildSignals: AbortSignal[] = [];
  const pendingRelease: Array<() => void> = [];
  const products = new Map<string, NativeProduct>();
  const values = new Map<string, string>();
  let startGate: { returned: ReturnType<typeof deferred<NativeSession>>; release: ReturnType<typeof deferred<void>> } | undefined;
  let buildGate: { entered: ReturnType<typeof deferred<AbortSignal>>; release: ReturnType<typeof deferred<void>>; cleanupConfirmed: boolean } | undefined;
  let stopFails = false;
  let startFailure: { create(sessionId: string): Error; afterLaunch: boolean } | undefined;
  const requestedStarts: string[] = [];
  let loseNextBuildReply = false, loseNextBuildBeforeCompiler = false, maskBuildReceipts = false;
  const runnerCalls = { build: [] as string[], recover: [] as string[], cancel: [] as string[] };
  const recoveryOverrides = new Map<string, NativeBuildRecovery>(), cancelOverrides = new Map<string, NativeBuildRecovery>();
  let loseNextAction = false, loseNextRestart = false, refreshingFails = false, denyBuildPublication = false, buildCleanupUnconfirmed = false, observationSequence = 0, serviceOperations = 0;
  const native: NativeDelegationOwnerOptions['native'] = {
    build: async (input, selectedProfile, context) => {
      builds.push({ snapshot: structuredClone(input), profile: structuredClone(selectedProfile) });
      assert.ok(context.signal); buildSignals.push(context.signal);
      const wait = buildGate; buildGate = undefined;
      if (wait) {
        wait.entered.resolve(context.signal);
        await Promise.race([wait.release.promise, new Promise<void>(resolve => {
          if (context.signal!.aborted) resolve();
          else context.signal!.addEventListener('abort', () => resolve(), { once: true });
        })]);
      }
      const canceled = context.signal.aborted;
      const buildId = randomUUID(), now = new Date().toISOString();
      const reportArtifact = await artifacts.put('Whole build report from the operating-system adapter.', { ...context.authority, name: 'build-report.json', mime: 'application/json' });
      const productArtifact = await artifacts.put('The fake adapter product bytes.', { ...context.authority, name: 'Fixture.app.zip', mime: 'application/zip' });
      const preparationArtifact = await artifacts.put(JSON.stringify({ sourceDigest: input.sourceDigest }), { ...context.authority, name: 'preparation.json', mime: 'application/json' });
      const snapshotArtifact = await artifacts.put(JSON.stringify(input.manifest), { ...context.authority, name: 'snapshot.json', mime: 'application/json' });
      const fixtureReceiptArtifact = await artifacts.put(JSON.stringify({ fixtureProfileId: selectedProfile.id, sourceDigest: input.sourceDigest, runId: buildId, scope: 'mock-native-adapter' }), { ...context.authority, name: 'fixture-receipt.json', mime: 'application/json' });
      const product: NativeProduct = {
        platform: 'macos', appPath: join(dataDir, 'products', buildId, 'Fixture.app'), bundleIdentifier: 'dev.enoughfactory.fixture',
        inventorySha256: 'b'.repeat(64), originalArtifactSha256: productArtifact.sha256,
        source: { kind: 'development-snapshot', snapshotSha256: input.sourceDigest },
        launchArguments: ['--production-fixture', buildId], fixture: { kind: 'verified-isolated', runId: buildId, evidenceSha256: selectedProfile.fixtureEvidenceSha256 },
      };
      products.set(buildId, product);
      const candidate = {
        id: randomUUID(), workspaceId: randomUUID(), ...context.authority, deviceId: 'mac-owner', baseCommit: input.roots[0]!.commit,
        commit: input.roots[0]!.commit, branch: 'inspection', bundleArtifact: transfer.sourceArtifacts[0]!.manifest, diffArtifact: reportArtifact, createdAt: now,
        workingDirectories: input.roots.slice(1).map(root => ({ id: root.id, name: root.name, kind: root.kind, containerPath: root.containerPath, baseCommit: root.commit, commit: root.commit,
          bundleArtifact: transfer.sourceArtifacts.find(artifact => artifact.rootId === root.id)!.manifest, diffArtifact: reportArtifact })),
      };
      const built: NativeInspectionBuild = {
        id: buildId, status: canceled ? 'canceled' : 'passed', product: canceled ? undefined : product, candidate,
        report: {
          id: randomUUID(), candidateId: candidate.id, commit: candidate.commit, status: canceled ? 'canceled' : 'passed',
          commands: [{ command: `enoughfactory:apple-build ${JSON.stringify(selectedProfile.build)}`, exitCode: canceled ? 130 : 0, stdout: canceled ? 'Partial compiler output retained before cancellation.' : 'Mock native compiler completed.', stderr: '', startedAt: now, endedAt: now }],
          logArtifact: reportArtifact, createdAt: now, ...(buildCleanupUnconfirmed || wait?.cleanupConfirmed === false ? { cleanupErrors: ['Compiler termination has not been confirmed'] } : {}),
        },
        reportArtifact, evidenceArtifacts: [fixtureReceiptArtifact], productArtifacts: canceled ? [] : [productArtifact], snapshotArtifact,
        fixtureReceiptArtifact, fixtureProfileId: selectedProfile.id, preparationArtifact,
      };
      if (denyBuildPublication) refreshingFails = true;
      return built;
    },
    product: async id => { const product = products.get(id); assert.ok(product); return product; },
    readiness: async () => ({ status: 'ready', reasons: [] }),
    start: async (id, ownerAttemptId, requestedSessionId) => {
      starts.push(id);
      assert.ok(requestedSessionId, 'the owner must reserve the backend identity before dispatching native launch');
      requestedStarts.push(requestedSessionId);
      const failure = startFailure; startFailure = undefined;
      if (failure && !failure.afterLaunch) throw failure.create(requestedSessionId);
      const product = products.get(id); assert.ok(product, 'launch must reference a completed owned build');
      const session: NativeSession = { id: requestedSessionId, platform: 'macos', product, ownerAttemptId, pid: 124, startedAt: new Date().toISOString(), directory: join(dataDir, 'sessions', id) };
      sessions.set(session.id, session); values.set(session.id, 'Original body');
      if (failure) throw failure.create(requestedSessionId);
      const wait = startGate; startGate = undefined;
      if (wait) { wait.returned.resolve(session); await wait.release.promise; }
      return session;
    },
    observe: async sessionId => {
      assert.ok(sessions.has(sessionId));
      const observationId = `backend-observation-${++observationSequence}`, path = join(dataDir, `${observationId}.png`);
      await writeFile(path, png); observations.set(sessionId, observationId);
      return {
        sessionId, observationId, observedAt: new Date().toISOString(), appState: 'running', truncated: false,
        screenshot: { path, mimeType: 'image/png', sha256: sha(png), width: 1, height: 1 },
        elements: [
          { id: 'body', type: 'text-field', label: 'Message body', value: values.get(sessionId), enabled: true, frame: { x: 0, y: 0, w: 1, h: 1 } },
          { id: 'save', type: 'button', label: 'Save draft', enabled: true, frame: { x: 0, y: 0, w: 1, h: 1 } },
        ],
      };
    },
    act: async (sessionId, action) => {
      assert.equal(action.observationId, observations.get(sessionId), 'only the exact observed backend identity may authorize input');
      actions.push({ sessionId, action });
      if (action.kind === 'type') values.set(sessionId, action.text);
      if (loseNextAction) { loseNextAction = false; throw new Error('Native helper socket closed after input dispatch'); }
      return { performed: true, requiresObservation: true };
    },
    restart: async (sessionId, observationId) => {
      const session = sessions.get(sessionId); assert.ok(session);
      assert.ok(observationId);
      assert.equal(observationId, observations.get(sessionId), 'restart uses the original owner-local observation');
      const inspectionSession = jobs.listJobs().flatMap(job => jobs.sessions(job.id)).find(item => item.processIdentity?.pid === session.pid);
      assert.ok(inspectionSession);
      assert.ok(jobs.actions(inspectionSession.id).some(action => action.kind === 'restart' && action.status === 'running'), 'restart intent is durably journaled before the native effect');
      const previousPid = session.pid, pid = (previousPid ?? 124) + 1;
      restarts.push({ sessionId, observationId, previousPid, pid });
      observations.delete(sessionId);
      sessions.set(sessionId, { ...session, pid });
      if (loseNextRestart) { loseNextRestart = false; throw new Error('Native helper disconnected after restarting the owned process'); }
      return { performed: true, requiresObservation: true, previousProcessExited: true, previousPid, pid };
    },
    stop: async id => { stops.push(id); if (stopFails) throw new Error('Owned native process termination is unconfirmed'); sessions.delete(id); },
    discover: async () => [...sessions.values()].map(session => ({ ...session, status: 'running' })),
  };
  const receipt = (jobId: string): NativeBuildRecovery => {
    const original = store.get<{ id: string; outcome: NativeBuildRecovery }>('test-native-build-receipts', jobId)?.outcome;
    if (!maskBuildReceipts && original) return structuredClone(original);
    const registration = store.get<{ id: string; record: NativeBuildOwner }>('test-native-build-registrations', jobId)?.record;
    return { status: 'unknown', reason: 'The original native worker has no matching teardown receipt.', ...(registration ? { record: { ...registration, pid: undefined, identity: undefined, startAuthorized: undefined, status: 'registered' as const } } : {}) };
  };
  const buildRunner: NativeDelegationOwnerOptions['builds'] = {
    build: async (input, selectedProfile, context) => {
      const job = jobs.getJob(context.jobId); assert.ok(job, 'the compiler is registered against its original durable owner job');
      assert.equal(job.capability, 'apple-compilation');
      assert.deepEqual(context.authority, job.authority);
      assert.equal(input.sourceDigest, job.source.sha256);
      assert.deepEqual(input.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })), job.source.roots?.map(root => ({ id: root.id, sha256: root.sha256 })));
      assert.equal(runnerCalls.build.includes(context.jobId), false, 'the runner never substitutes a new compiler for an existing original job');
      runnerCalls.build.push(context.jobId);
      const at = new Date().toISOString(), key = randomUUID();
      const record: NativeBuildOwner = { version: 1, key, jobId: context.jobId, requestSha256: sha(JSON.stringify({ snapshot: input.manifest, profile: selectedProfile, authority: context.authority, jobId: context.jobId })),
        workerPath: join(dataDir, 'mock-native-build-worker.cjs'), workerArgs: [context.jobId, key], status: 'running', createdAt: at, updatedAt: at,
        pid: 214, identity: `mock-owned-worker-${key}`, startAuthorized: true };
      store.set('test-native-build-registrations', { id: context.jobId, record });
      if (loseNextBuildBeforeCompiler) { loseNextBuildBeforeCompiler = false; throw new NativeBuildUnknownError('The original worker transport closed before its preparation outcome was known.'); }
      const built = await native.build(input, selectedProfile, context);
      store.set('test-native-build-private-results', { id: context.jobId, build: built });
      const outcome: NativeBuildRecovery = built.report.cleanupErrors?.length || built.report.commands.some(command => command.cleanupErrors?.length)
        ? { status: 'unknown', reason: 'Original compiler teardown remains unconfirmed.', record }
        : { status: 'completed', build: built, canceled: built.status === 'canceled', record: { ...record, status: 'completed' } };
      store.set('test-native-build-receipts', { id: context.jobId, outcome });
      if (outcome.status === 'unknown') throw new NativeBuildUnknownError(outcome.reason);
      if (loseNextBuildReply) { loseNextBuildReply = false; throw new Error('Original native build transport ended before its reply was delivered'); }
      return built;
    },
    recover: async jobId => { runnerCalls.recover.push(jobId); return structuredClone(recoveryOverrides.get(jobId) ?? receipt(jobId)); },
    cancel: async jobId => { runnerCalls.cancel.push(jobId); return cancelOverrides.has(jobId) ? structuredClone(cancelOverrides.get(jobId)!) : buildRunner.recover(jobId); },
  };
  const ownerOptions: NativeDelegationOwnerOptions = {
    app: { dataDir, device: { id: 'mac-owner' }, store, changed() {}, async withServiceOperation(operation) { serviceOperations++; return operation(new AbortController().signal); } },
    jobs, native, builds: buildRunner, artifacts, profiles: projectId => projectId === 'mail-project' ? [profile] : [],
    refreshAuthority: async () => { if (refreshingFails) throw new Error('Paired coordinator authority unavailable'); },
  };
  let owner = new NativeDelegationOwner(ownerOptions);
  t.after(async () => { for (const release of pendingRelease) release(); await owner.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const execute = (operation: RemoteInspectionOperation, requestId: string = randomUUID(), assigned = assignment) => owner.execute(assigned, operation, sources, requestId);
  const status = (jobId: string, assigned = assignment) => execute({ name: 'status', arguments: { jobId } }, randomUUID(), assigned);
  const build = async (assigned = assignment) => {
    const submitted = await execute({ name: 'build', arguments: { profileId: profile.id } }, randomUUID(), assigned);
    const jobId = String(submitted.value!.jobId);
    await eventually(() => jobs.getJob(jobId)?.status === 'succeeded'); return jobId;
  };
  const start = async (buildJobId: string, assigned = assignment) => {
    const submitted = await execute({ name: 'start', arguments: { buildJobId } }, randomUUID(), assigned);
    const jobId = String(submitted.value!.jobId);
    await eventually(() => { const job = jobs.getJob(jobId); return !!job?.sessionId && jobs.getSession(job.sessionId)?.status === 'ready'; });
    return { jobId, sessionId: jobs.getJob(jobId)!.sessionId! };
  };
  return {
    directory, dataDir, store, get owner() { return owner; }, artifacts, authorArtifacts, jobs, assignment, sources, snapshot, main, design,
    builds, sessions, actions, restarts, stops, starts, requestedStarts, buildSignals, values, execute, status, build, start,
    loseAction: () => { loseNextAction = true; }, denyRefresh: () => { refreshingFails = true; }, allowRefresh: () => { refreshingFails = false; },
    loseRestart: () => { loseNextRestart = true; },
    denyPublicationAfterBuild: () => { denyBuildPublication = true; },
    leaveBuildCleanupUnconfirmed: () => { buildCleanupUnconfirmed = true; },
    failStop: () => { stopFails = true; },
    failNextStart: (create: (sessionId: string) => Error, afterLaunch = false) => { startFailure = { create, afterLaunch }; },
    runnerCalls,
    receipt,
    originalReceipt: (jobId: string) => store.get<{ id: string; outcome: NativeBuildRecovery }>('test-native-build-receipts', jobId)?.outcome,
    originalBuild: (jobId: string) => store.get<{ id: string; build: NativeInspectionBuild }>('test-native-build-private-results', jobId)?.build,
    registration: (jobId: string) => store.get<{ id: string; record: NativeBuildOwner }>('test-native-build-registrations', jobId)?.record,
    recoveryOverride: (jobId: string, outcome: NativeBuildRecovery) => { recoveryOverrides.set(jobId, outcome); },
    cancelOverride: (jobId: string, outcome: NativeBuildRecovery) => { cancelOverrides.set(jobId, outcome); },
    loseBuildReplyAndHideReceipt: () => { loseNextBuildReply = true; maskBuildReceipts = true; },
    loseWorkerBeforeCompilerAndHideReceipt: () => { loseNextBuildBeforeCompiler = true; maskBuildReceipts = true; },
    revealBuildReceipts: () => { maskBuildReceipts = false; },
    restartOwner: async () => { await owner.close(); jobs.recoverAfterRestart(); owner = new NativeDelegationOwner(ownerOptions); },
    holdNextStart: () => {
      const gate = { returned: deferred<NativeSession>(), release: deferred<void>() }; startGate = gate;
      const release = () => gate.release.resolve(); pendingRelease.push(release);
      return { returned: gate.returned.promise, release };
    },
    holdNextBuildUntilAbort: (cleanupConfirmed = true) => {
      const gate = { entered: deferred<AbortSignal>(), release: deferred<void>(), cleanupConfirmed }; buildGate = gate;
      const release = () => gate.release.resolve(); pendingRelease.push(release);
      return { entered: gate.entered.promise, release };
    },
    get serviceOperations() { return serviceOperations; },
  };
}

async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'Timed out waiting for the durable native job transition'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

async function lostBuild(f: Awaited<ReturnType<typeof fixture>>, options: { beforeCompiler?: boolean; assignment?: RemoteInspectionAssignment } = {}): Promise<string> {
  if (options.beforeCompiler) f.loseWorkerBeforeCompilerAndHideReceipt();
  else f.loseBuildReplyAndHideReceipt();
  const submitted = await f.execute({ name: 'build', arguments: {} }, randomUUID(), options.assignment ?? f.assignment);
  const jobId = String(submitted.value!.jobId);
  await eventually(() => f.jobs.getJob(jobId)?.status === 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.jobs.evidence(jobId).length, 0);
  return jobId;
}

test('delegated native owner rejects unconfigured profiles and caller-controlled build or launch paths before any effect', async t => {
  const f = await fixture(t);
  for (const selected of [
    { projectId: 'unknown-project', profileId: profile.id },
    { projectId: 'mail-project', profileId: 'unconfigured' },
    { projectId: 'mail-project', profileId: profile.id, appPath: '/Applications/Personal.app' },
    { projectId: 'mail-project', profileId: profile.id, build: { project: '/tmp/attacker.xcodeproj' } },
    { projectId: 'mail-project', profileId: profile.id, launchArguments: ['--personal-profile'] },
  ]) await assert.rejects(f.owner.verifySourceIdentity({ ...f.assignment, profile: selected }, f.sources), /configured|raw build or launch/);
  await assert.rejects(f.owner.verifySourceIdentity({ ...f.assignment, ownerDeviceId: 'another-mac' }, f.sources), /different owner/);
  await f.owner.verifySourceIdentity(f.assignment, f.sources);
  await assert.rejects(f.execute({ name: 'build', arguments: { profileId: 'caller-profile' } }), /trusted coordinator/);
  assert.equal(f.jobs.listJobs().length, 0);
  assert.equal(f.builds.length, 0); assert.equal(f.sessions.size, 0);
});

test('owner imports and verifies every frozen source root while subsequent author edits do not alter the native build', async t => {
  const f = await fixture(t);
  await f.owner.verifySourceIdentity(f.assignment, f.sources);
  await writeFile(join(f.main, 'Main.swift'), 'Changed after capture\n');
  await writeFile(join(f.design, 'Tokens.swift'), 'let spacing = 999\n');
  const jobId = await f.build();
  const imported = f.builds[0]!.snapshot;
  assert.equal(imported.sourceDigest, f.assignment.source.sha256);
  assert.deepEqual(imported.roots.map(root => root.id), ['main', 'enough-ui']);
  assert.equal(await readFile(join(imported.roots[0]!.path, 'Main.swift'), 'utf8'), 'let title = "Captured dirty source"\n');
  assert.equal(await readFile(join(imported.roots[1]!.path, 'Tokens.swift'), 'utf8'), 'let spacing = 12\n');
  assert.equal(imported.path.startsWith(join(f.dataDir, 'inspection', 'inspection-snapshots')), true);
  await new InspectionSnapshotManager({ dataDir: join(f.dataDir, 'inspection'), artifacts: f.artifacts }).verify(imported);
  assert.deepEqual(f.builds[0]!.profile, profile);
  assert.ok(f.serviceOperations > 0, 'native compilation is admitted through the independent host service');
  assert.ok(f.jobs.evidence(jobId).some(item => item.kind === 'build-product'));
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  await assert.rejects(f.owner.verifySourceIdentity({ ...f.assignment, source: { ...f.assignment.source, roots: [{ id: 'main', sha256: 'c'.repeat(64) }, f.assignment.source.roots![1]!] } }, f.sources), /assigned identities/);
  await assert.rejects(f.owner.verifySourceIdentity(f.assignment, f.sources.slice(0, 1)), /source set differs/);
});

test('corruption of an independently transferred secondary root is rejected before a native build can start', async t => {
  const f = await fixture(t);
  const secondary = f.sources[1]!;
  await writeFile(secondary.path, 'Replaced bundle contents');
  await assert.rejects(f.owner.verifySourceIdentity(f.assignment, f.sources), /integrity verification/);
  assert.equal(f.jobs.listJobs().length, 0); assert.equal(f.builds.length, 0);
});

test('queued build and launch return image observations, apply an edit to the same owned session and reject stale input', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const observed = await f.execute({ name: 'observe', arguments: { sessionId } }, 'observe-first');
  const observationId = String(observed.value!.observationId);
  const image = observed.content!.find(item => item.type === 'image'); assert.ok(image && image.type === 'image');
  const screenshot = observed.artifacts!.find(artifact => artifact.id === image.artifactId)!;
  assert.deepEqual(await f.artifacts.read(screenshot), png, 'actual bytes remain retrievable through the content-addressed artifact lane');
  assert.equal(screenshot.attemptId, authority.attemptId);
  assert.equal(f.jobs.evidence(jobId).find(item => item.artifact.id === screenshot.id)?.source.sha256, f.assignment.source.sha256);
  assert.equal(observed.value!.sourceDigest, f.assignment.source.sha256);
  const operation: RemoteInspectionOperation = { name: 'type', arguments: { sessionId, observationId, elementId: 'body', text: 'A draft written through the factory', mode: 'replace' } };
  await f.execute(operation, 'edit-body');
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0]!.action.observationId, 'backend-observation-1', 'public observation handles translate to their original owner-local observation');
  await assert.rejects(f.execute({ name: 'click', arguments: { sessionId, observationId, elementId: 'save' } }), /Stale/);
  assert.equal(f.actions.length, 1, 'stale input never reaches the operating system');
  const fresh = await f.execute({ name: 'observe', arguments: { sessionId } }, 'observe-after-edit');
  const freshText = fresh.content!.find(item => item.type === 'text'); assert.ok(freshText && freshText.type === 'text');
  const elements = JSON.parse(freshText.text).elements as Array<{ id: string; value?: string }>;
  assert.equal(elements.find(element => element.id === 'body')?.value, 'A draft written through the factory');
  const assertions = await f.execute({ name: 'run-tests', arguments: { sessionId, observationId: fresh.value!.observationId, assertions: [{ labelIncludes: 'Message body', valueIncludes: 'A draft written through the factory' }] } });
  assert.equal(assertions.value!.passed, true);
  assert.equal(f.sessions.size, 1, 'observation and input reuse the launched product rather than silently replacing it');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  await f.execute({ name: 'stop', arguments: { sessionId } });
  assert.equal(f.jobs.getJob(jobId)!.status, 'succeeded');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
});

test('lost native action replies retain unknown effects and leases; reconciliation never repeats the edit', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const observed = await f.execute({ name: 'observe', arguments: { sessionId } });
  const operation: RemoteInspectionOperation = { name: 'type', arguments: { sessionId, observationId: observed.value!.observationId, elementId: 'body', text: 'Possibly applied before disconnect' } };
  f.loseAction();
  await assert.rejects(f.execute(operation, 'lost-edit'), /socket closed/);
  assert.equal(f.actions.length, 1);
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  assert.equal(f.jobs.getSession(sessionId)!.status, 'unknown');
  assert.equal(f.jobs.actions(sessionId).find(action => action.kind === 'type')!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  const reconciled = await f.owner.reconcile(f.assignment, operation, 'lost-edit');
  assert.equal(reconciled?.value?.outcomeUnknown, true);
  assert.equal(reconciled?.isError, true);
  assert.equal(f.actions.length, 1);
  await assert.rejects(f.execute(operation, 'lost-edit'), /reconciliation/);
  assert.equal(f.actions.length, 1, 'the durable effect journal never replays an uncertain input');
  const other = { ...f.assignment, id: randomUUID() };
  const otherBuild = await f.build(other);
  const queued = await f.execute({ name: 'start', arguments: { buildJobId: otherBuild } }, 'competing-launch', other);
  assert.equal(f.jobs.getJob(String(queued.value!.jobId))!.status, 'queued');
  assert.equal(f.sessions.size, 1, 'uncertain native ownership still reserves the single desktop');
  const stopped = await f.execute({ name: 'stop', arguments: { sessionId } });
  assert.equal(stopped.value!.priorActionOutcome, 'unknown');
  assert.equal(f.jobs.getJob(jobId)!.status, 'canceled');
  assert.equal(f.jobs.actions(sessionId).find(action => action.kind === 'type')!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'), 'only a positive backend stop releases the uncertain session');
  const queuedJobId = String(queued.value!.jobId);
  await eventually(() => { const admitted = f.jobs.getJob(queuedJobId); return !!admitted?.sessionId && f.jobs.getSession(admitted.sessionId)?.status === 'ready'; });
  await f.execute({ name: 'stop', arguments: { sessionId: f.jobs.getJob(queuedJobId)!.sessionId } }, 'stop-competing-session', other);
});

test('owned restart confirms the prior process exit, retains fixture data and requires a fresh observation for further input', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const initial = await f.execute({ name: 'observe', arguments: { sessionId } });
  await f.execute({ name: 'type', arguments: { sessionId, observationId: initial.value!.observationId, elementId: 'body', text: 'A saved draft must survive an app restart', mode: 'replace' } });
  const beforeRestart = await f.execute({ name: 'observe', arguments: { sessionId } });
  const backendBefore = [...f.sessions.values()][0]!;
  const ownedBefore = structuredClone(f.jobs.getSession(sessionId)!);
  const leaseIds = f.jobs.leases(jobId).map(lease => lease.id);
  const operation: RemoteInspectionOperation = { name: 'restart', arguments: { sessionId, observationId: beforeRestart.value!.observationId } };
  const restarted = await f.execute(operation, 'restart-owned-fixture');
  assert.equal(restarted.value!.previousProcessExited, true);
  assert.equal(restarted.value!.previousPid, 124); assert.equal(restarted.value!.pid, 125);
  assert.equal(restarted.value!.requiresObservation, true);
  assert.equal(restarted.value!.sessionId, sessionId);
  assert.equal(restarted.value!.sourceDigest, f.assignment.source.sha256);
  assert.equal(f.restarts.length, 1);
  assert.equal(f.restarts[0]!.observationId, 'backend-observation-2');
  const backendAfter = [...f.sessions.values()][0]!;
  assert.equal(backendAfter.id, backendBefore.id);
  assert.deepEqual(backendAfter.product, backendBefore.product, 'restart keeps the exact product, private fixture and original source');
  assert.equal(backendAfter.ownerAttemptId, backendBefore.ownerAttemptId);
  assert.equal(f.jobs.getSession(sessionId)!.processIdentity!.pid, 125);
  assert.equal(f.jobs.getSession(sessionId)!.id, ownedBefore.id);
  assert.equal(f.jobs.getSession(sessionId)!.latestObservationId, undefined);
  assert.deepEqual(f.jobs.leases(jobId).map(lease => lease.id), leaseIds);
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  await assert.rejects(f.execute({ name: 'click', arguments: { sessionId, observationId: beforeRestart.value!.observationId, elementId: 'save' } }), /Stale/);
  await assert.rejects(f.execute(operation, 'second-restart-with-stale-observation'), /Stale/);
  assert.equal(f.restarts.length, 1);
  const duplicate = await f.execute(operation, 'restart-owned-fixture');
  assert.equal(duplicate.value!.pid, 125); assert.equal(f.restarts.length, 1, 'an identical restart request returns its saved result without restarting again');
  const observed = await f.execute({ name: 'observe', arguments: { sessionId } });
  const content = observed.content!.find(item => item.type === 'text'); assert.ok(content && content.type === 'text');
  const elements = JSON.parse(content.text).elements as Array<{ id: string; value?: string }>;
  assert.equal(elements.find(element => element.id === 'body')?.value, 'A saved draft must survive an app restart');
  assert.notEqual(observed.value!.observationId, beforeRestart.value!.observationId);
  await f.execute({ name: 'click', arguments: { sessionId, observationId: observed.value!.observationId, elementId: 'save' } });
  assert.equal(f.actions.length, 2, 'new input is allowed only after observing the restarted process');
  await f.execute({ name: 'stop', arguments: { sessionId } });
});

test('a lost restart response remains unknown and reserved rather than replaying the process replacement', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const observed = await f.execute({ name: 'observe', arguments: { sessionId } });
  const operation: RemoteInspectionOperation = { name: 'restart', arguments: { sessionId, observationId: observed.value!.observationId } };
  f.loseRestart();
  await assert.rejects(f.execute(operation, 'lost-restart'), /disconnected after restarting/);
  assert.equal(f.restarts.length, 1);
  assert.equal([...f.sessions.values()][0]!.pid, 125, 'the lost reply can follow an actual process replacement');
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  assert.equal(f.jobs.getSession(sessionId)!.status, 'unknown');
  assert.equal(f.jobs.actions(sessionId).find(action => action.kind === 'restart')!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  const reconciled = await f.owner.reconcile(f.assignment, operation, 'lost-restart');
  assert.equal(reconciled!.value!.outcomeUnknown, true);
  await assert.rejects(f.execute(operation, 'lost-restart'), /reconciliation/);
  assert.equal(f.restarts.length, 1);
  await f.execute({ name: 'stop', arguments: { sessionId } });
  assert.equal(f.jobs.getJob(jobId)!.status, 'canceled');
  assert.equal(f.jobs.actions(sessionId).find(action => action.kind === 'restart')!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
});

test('separate assignment IDs cannot read each other jobs or supply another assignment build or session', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const other = { ...f.assignment, id: randomUUID() };
  await f.owner.verifySourceIdentity(other, f.sources);
  await assert.rejects(f.status(jobId, other), /different assignment/);
  await assert.rejects(f.execute({ name: 'start', arguments: { buildJobId } }, 'foreign-build', other), /different assignment/);
  await assert.rejects(f.execute({ name: 'observe', arguments: { sessionId } }, 'foreign-session', other), /different assignment/);
  assert.equal(f.sessions.size, 1); assert.equal(f.actions.length, 0);
  const before = f.jobs.listJobs().length;
  await assert.rejects(f.owner.verifySourceIdentity({ ...f.assignment, source: { ...f.assignment.source, candidateCommit: 'd'.repeat(40) } }, f.sources), /immutable source or ownership/);
  assert.equal(f.jobs.listJobs().length, before);
  await f.execute({ name: 'stop', arguments: { sessionId } });
});

test('fresh coordinator authority is required before submitting any native effect', async t => {
  const f = await fixture(t);
  await f.owner.verifySourceIdentity(f.assignment, f.sources);
  f.denyRefresh();
  await assert.rejects(f.execute({ name: 'build', arguments: {} }), /authority unavailable/);
  assert.equal(f.jobs.listJobs().length, 0); assert.equal(f.builds.length, 0);
});

test('authority loss after native compilation saves the private result without publishing it as current evidence', async t => {
  const f = await fixture(t);
  f.denyPublicationAfterBuild();
  const submitted = await f.execute({ name: 'build', arguments: {} });
  const jobId = String(submitted.value!.jobId);
  await eventually(() => f.jobs.getJob(jobId)?.status === 'failed');
  assert.equal(f.builds.length, 1);
  assert.equal(f.jobs.evidence(jobId).length, 0, 'old author authority cannot publish completed compiler output as usable evidence');
  assert.ok(f.store.get('inspection-delegation-owner-builds', jobId), 'the whole backend result survives a stale-publication fence');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'), 'confirmed compiler termination releases CPUs despite publication authority becoming unavailable');
  assert.equal(f.sessions.size, 0);
});

test('unconfirmed native compiler cleanup preserves ownership when the publication authority is unavailable', async t => {
  const f = await fixture(t);
  f.denyPublicationAfterBuild(); f.leaveBuildCleanupUnconfirmed();
  const submitted = await f.execute({ name: 'build', arguments: {} });
  const jobId = String(submitted.value!.jobId);
  await eventually(() => f.jobs.getJob(jobId)?.status === 'unknown');
  assert.equal(f.jobs.evidence(jobId).length, 0);
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'), 'an unconfirmed compiler outcome never releases resources based on a returned payload alone');
  assert.equal(f.builds.length, 1); assert.equal(f.sessions.size, 0);
});

test('remote journal paginates original owner chronology with public records and retrievable screenshot artifacts', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const first = await f.execute({ name: 'observe', arguments: { sessionId } });
  await f.execute({ name: 'type', arguments: { sessionId, observationId: first.value!.observationId, elementId: 'body', text: 'Retained observed draft. '.repeat(256), mode: 'replace' } });
  for (let index = 0; index < 25; index++) await f.execute({ name: 'observe', arguments: { sessionId } }, `journal-observation-${index}`);
  await f.execute({ name: 'stop', arguments: { sessionId } });
  const allActions = f.jobs.actions(sessionId), allEvidence = f.jobs.evidence(jobId);
  const observationIds = f.store.list<{ id: string; sessionId: string }>('inspection-observations').filter(item => item.sessionId === sessionId).map(item => item.id);
  const entities = new Set([jobId, sessionId, ...allActions.map(action => action.id), ...allEvidence.map(evidence => evidence.id), ...observationIds]);
  const expected = [...entities].flatMap(entity => f.store.events<JournalEvent['value']>('inspection-journal', entity).map(event => ({ ...event, entity }))).sort((a, b) => a.seq - b.seq);
  const before = { builds: f.builds.length, actions: f.actions.length, restarts: f.restarts.length, serviceOperations: f.serviceOperations, events: expected.length };
  const receiver = new ArtifactStore(join(f.directory, 'journal-receiver'), 'author');
  const delivered = new Map<string, JournalEvent>(), screenshotIds = new Set<string>();
  const job = f.jobs.getJob(jobId)!;
  let after = 0, pageCount = 0;
  for (;;) {
    const result = await f.execute({ name: 'journal', arguments: { jobId, after } });
    const page = result.value as unknown as JournalPage;
    assert.deepEqual(page.job, job);
    assert.equal(page.sessions.length, 1); assert.equal(page.sessions[0]!.id, sessionId);
    assert.ok(Buffer.byteLength(JSON.stringify({ value: page, artifacts: result.artifacts })) <= 50_000, 'a journal page bounds the complete typed metadata and artifact reference payload');
    assert.ok((result.artifacts?.length ?? 0) <= 16, 'artifact references have an independent per-page bound');
    assert.ok(page.events.every(event => event.seq > after));
    assert.deepEqual(page.events.map(event => event.seq), page.events.map(event => event.seq).sort((a, b) => a - b));
    assert.ok(page.after >= after);
    if (page.hasMore) assert.ok(page.after > after, 'a bounded page must make cursor progress');
    for (const event of page.events) {
      assert.equal(delivered.has(String(event.seq)), false, 'pagination does not repeat already-delivered event identities');
      assert.ok(entities.has(event.entity), 'a journal page only includes this assignment job entities');
      const original = expected.find(item => item.seq === event.seq)!;
      assert.ok(original); assert.equal(event.entity, original.entity); assert.deepEqual(event.value, original.value);
      if (event.record) {
        assert.equal(event.record.value.id, event.entity);
        assert.ok(['inspection-actions', 'inspection-observations', 'inspection-evidence'].includes(event.record.bucket));
        if (event.record.bucket === 'inspection-actions') assert.deepEqual(event.record.value, allActions.find(action => action.id === event.entity));
        if (event.record.bucket === 'inspection-observations') assert.deepEqual(event.record.value, f.jobs.observation(event.entity));
        if (event.record.bucket === 'inspection-evidence') {
          const evidence = allEvidence.find(item => item.id === event.entity)!;
          assert.deepEqual(event.record.value, evidence);
          assert.ok(result.artifacts?.some(artifact => artifact.id === evidence.artifact.id), 'an evidence record includes its original transferable artifact manifest');
          screenshotIds.add(evidence.artifact.id);
        }
      }
      delivered.set(String(event.seq), event);
    }
    const serialized = JSON.stringify(result);
    for (const privateField of ['grantId', 'requestKey', 'requestHash', 'tokenHash', 'queueSequence']) assert.equal(serialized.includes(`"${privateField}"`), false, `${privateField} remains private to the owner`);
    assert.equal(serialized.includes('base64'), false, 'journal metadata never embeds screenshot bytes');
    for (const artifact of result.artifacts ?? []) {
      await receiver.importFile(await f.artifacts.path(artifact), artifact);
      assert.deepEqual(await receiver.read(artifact), png);
    }
    after = page.after; pageCount++;
    assert.ok(pageCount < 100, 'cursor pagination terminates');
    if (!page.hasMore) break;
  }
  assert.ok(pageCount > 1, 'large real UI observations require multiple bounded pages');
  assert.deepEqual([...delivered.values()].map(event => ({ seq: event.seq, entity: event.entity, value: event.value })), expected);
  assert.equal(screenshotIds.size, allEvidence.length, 'every screenshot evidence identity survives pagination and transfer');
  const end = await f.execute({ name: 'journal', arguments: { jobId, after } });
  const endPage = end.value as unknown as JournalPage;
  assert.deepEqual(endPage.events, []); assert.equal(endPage.hasMore, false); assert.equal(endPage.after, after);
  assert.deepEqual({ builds: f.builds.length, actions: f.actions.length, restarts: f.restarts.length, serviceOperations: f.serviceOperations, events: [...entities].reduce((sum, entity) => sum + f.store.events('inspection-journal', entity).length, 0) }, before, 'journal reads neither dispatch backend effects nor create misleading lifecycle events');
});

test('remote journal validates cursors and cannot bypass assignment source or current coordinator authority', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  await f.execute({ name: 'observe', arguments: { sessionId } });
  const initial = await f.execute({ name: 'journal', arguments: { jobId } });
  const page = initial.value as unknown as JournalPage;
  assert.equal(page.hasMore, false);
  for (const after of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '1', page.after + 1]) {
    await assert.rejects(f.execute({ name: 'journal', arguments: { jobId, after } }), /cursor|sequence|after/i);
  }
  const other = { ...f.assignment, id: randomUUID() };
  await f.owner.verifySourceIdentity(other, f.sources);
  await assert.rejects(f.execute({ name: 'journal', arguments: { jobId } }, 'journal-other-assignment', other), /different assignment/);
  await assert.rejects(f.execute({ name: 'journal', arguments: { jobId } }, 'journal-different-source', { ...f.assignment, source: { ...f.assignment.source, candidateCommit: 'c'.repeat(40) } }), /matching authenticated preparation/);
  const before = { builds: f.builds.length, actions: f.actions.length, sessions: f.sessions.size, serviceOperations: f.serviceOperations };
  f.denyRefresh();
  await assert.rejects(f.execute({ name: 'journal', arguments: { jobId } }), /authority unavailable/);
  assert.deepEqual({ builds: f.builds.length, actions: f.actions.length, sessions: f.sessions.size, serviceOperations: f.serviceOperations }, before);
});

test('an individual oversized public action record travels losslessly as an immutable journal artifact', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const observed = await f.execute({ name: 'observe', arguments: { sessionId } });
  const body = 'Large offline draft text. '.repeat(2200);
  await f.execute({ name: 'type', arguments: { sessionId, observationId: observed.value!.observationId, elementId: 'body', text: body, mode: 'replace' } }, 'oversized-draft');
  const originalAction = f.jobs.actions(sessionId).find(action => action.kind === 'type')!;
  assert.ok(Buffer.byteLength(JSON.stringify(originalAction)) > 48_000);
  await f.execute({ name: 'stop', arguments: { sessionId } });
  const actionEvents = f.store.events<JournalEvent['value']>('inspection-journal', originalAction.id);
  const supplied = new Set<string>();
  let after = 0, delivered = 0;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const result = await f.execute({ name: 'journal', arguments: { jobId, after } });
    const page = result.value as unknown as JournalPage;
    assert.ok(Buffer.byteLength(JSON.stringify({ value: page, artifacts: result.artifacts })) <= 50_000);
    for (const event of page.events.filter(event => event.entity === originalAction.id)) {
      assert.equal(event.record, undefined, 'an oversized legal record is not squeezed or truncated into the metadata page');
      assert.ok(event.recordArtifact);
      const artifact = event.recordArtifact;
      assert.equal(artifact.mime, 'application/json');
      assert.equal(artifact.metadata?.purpose, 'inspection-public-journal-record');
      assert.equal(artifact.metadata?.sourceDigest, f.assignment.source.sha256);
      assert.ok(result.artifacts?.some(reference => reference.id === artifact.id));
      const content = await f.artifacts.read(artifact);
      assert.equal(artifact.metadata?.sha256, sha(content));
      assert.deepEqual(JSON.parse(content.toString('utf8')), { bucket: 'inspection-actions', value: originalAction });
      for (const privateField of ['requestKey', 'requestHash', 'grantId', 'tokenHash']) assert.equal(content.includes(`"${privateField}"`), false);
      supplied.add(artifact.id); delivered++;
    }
    after = page.after;
    if (!page.hasMore) break;
    assert.ok(pageIndex < 19, 'the oversized record does not stall pagination');
  }
  assert.equal(delivered, actionEvents.length, 'all original lifecycle events retain their complete public action identity');
  assert.equal(supplied.size, 1, 'repeated events reuse the same retained record artifact');
});

test('trusted stale assignment retirement stops its original native session without blessing an unknown earlier edit', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const backendSession = [...f.sessions.values()][0]!;
  const observation = await f.execute({ name: 'observe', arguments: { sessionId } });
  f.loseAction();
  await assert.rejects(f.execute({ name: 'type', arguments: { sessionId, observationId: observation.value!.observationId, elementId: 'body', text: 'Possibly saved before retirement' } }), /socket closed/);
  const unknown = f.jobs.actions(sessionId).find(action => action.kind === 'type')!;
  assert.equal(unknown.status, 'unknown');
  f.denyRefresh();
  await f.owner.retireAssignment(f.assignment.id, 'The coordinator retired this author attempt.');
  assert.deepEqual(f.stops, [backendSession.id], 'trusted retirement cleans up the exact backend without requiring a fresh author grant');
  assert.equal(f.sessions.size, 0);
  assert.equal(f.jobs.getJob(jobId)!.status, 'canceled');
  assert.equal(f.jobs.getSession(sessionId)!.status, 'stopped');
  assert.equal(f.jobs.actions(sessionId).find(action => action.id === unknown.id)!.status, 'unknown', 'termination does not prove whether the previously dispatched edit happened');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.actions.length, 1); assert.equal(f.starts.length, 1);
  await f.owner.retireAssignment(f.assignment.id, 'Repeat the same retirement notification.');
  assert.deepEqual(f.stops, [backendSession.id], 'repeated retirement is idempotent after confirmed cleanup');
  f.allowRefresh();
  await assert.rejects(f.execute({ name: 'build', arguments: {} }), /retired this native assignment/, 'fresh transport availability cannot resurrect a coordinator-retired assignment');
  assert.equal(f.builds.length, 1);
});

test('retirement with unconfirmed native termination retains unknown session ownership and its lease', async t => {
  const f = await fixture(t), buildJobId = await f.build(), { jobId, sessionId } = await f.start(buildJobId);
  const backendSession = [...f.sessions.values()][0]!;
  f.failStop(); f.denyRefresh();
  await f.owner.retireAssignment(f.assignment.id, 'The author attempt is no longer current.');
  assert.deepEqual(f.stops, [backendSession.id]);
  assert.equal(f.sessions.size, 1, 'a stop exception may leave the original application alive');
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  assert.equal(f.jobs.getSession(sessionId)!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.starts.length, 1, 'cleanup uncertainty never launches a replacement');
});

test('retiring a queued competing native assignment cancels it before backend effects and preserves the active owner', async t => {
  const f = await fixture(t), buildJobId = await f.build(), first = await f.start(buildJobId);
  const other = { ...f.assignment, id: randomUUID() }, otherBuild = await f.build(other);
  const submitted = await f.execute({ name: 'start', arguments: { buildJobId: otherBuild } }, 'queued-retired-launch', other);
  const queuedJobId = String(submitted.value!.jobId);
  assert.equal(f.jobs.getJob(queuedJobId)!.status, 'queued');
  await f.owner.retireAssignment(other.id, 'The coordinator superseded this queued author assignment.');
  assert.equal(f.jobs.getJob(queuedJobId)!.status, 'canceled');
  assert.equal(f.jobs.leases(queuedJobId).length, 0);
  assert.equal(f.jobs.sessions(queuedJobId).length, 0);
  assert.equal(f.starts.length, 1); assert.equal(f.stops.length, 0);
  await assert.rejects(f.execute({ name: 'start', arguments: { buildJobId: otherBuild } }, 'retry-retired-queued-launch', other), /retired this native assignment/);
  assert.equal(f.jobs.getJob(first.jobId)!.status, 'running');
  assert.ok(f.jobs.leases(first.jobId).every(lease => lease.status === 'held'));
  await f.execute({ name: 'stop', arguments: { sessionId: first.sessionId } });
  assert.equal(f.starts.length, 1, 'released capacity cannot revive a retired queued launch');
});

test('a native start identity arriving after retirement is stopped without publishing the session as ready', async t => {
  const f = await fixture(t), buildJobId = await f.build(), gate = f.holdNextStart();
  const submitted = await f.execute({ name: 'start', arguments: { buildJobId } });
  const jobId = String(submitted.value!.jobId), backend = await gate.returned;
  const sessionId = f.jobs.getJob(jobId)!.sessionId!;
  assert.equal(f.jobs.getSession(sessionId)!.status, 'starting');
  assert.equal(f.stops.length, 0);
  const retiring = f.owner.retireAssignment(f.assignment.id, 'The author was superseded while native launch was in flight.');
  await eventually(() => ['cancellation-requested', 'unknown', 'canceled'].includes(f.jobs.getJob(jobId)!.status));
  gate.release();
  await retiring;
  await eventually(() => f.jobs.getJob(jobId)?.status === 'canceled');
  assert.deepEqual(f.stops, [backend.id]);
  assert.equal(f.sessions.size, 0);
  assert.equal(f.jobs.getSession(sessionId)!.status, 'stopped');
  assert.equal(f.jobs.getSession(sessionId)!.latestObservationId, undefined);
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.jobs.evidence(jobId).length, 0);
  assert.equal(f.store.events<{ kind: string }>('inspection-journal', sessionId).some(event => event.value.kind === 'session-ready'), false, 'late backend acknowledgement never makes retired author work usable');
  assert.notEqual(f.jobs.actions(sessionId).find(action => action.kind === 'start')!.status, 'succeeded');
});

test('retirement aborts an active compiler, keeps its whole private canceled result and releases only confirmed cleanup', async t => {
  const f = await fixture(t), gate = f.holdNextBuildUntilAbort();
  const submitted = await f.execute({ name: 'build', arguments: {} });
  const jobId = String(submitted.value!.jobId), signal = await gate.entered;
  assert.equal(signal.aborted, false);
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  const retiring = f.owner.retireAssignment(f.assignment.id, 'The coordinator retired an in-flight native build.');
  await eventually(() => signal.aborted);
  await retiring;
  await eventually(() => f.jobs.getJob(jobId)?.status === 'canceled');
  const retained = f.store.get<{ id: string; build: NativeInspectionBuild }>('inspection-delegation-owner-builds', jobId)!;
  assert.ok(retained);
  assert.equal(retained.build.status, 'canceled'); assert.equal(retained.build.report.status, 'canceled');
  assert.equal(retained.build.report.commands[0]!.stdout, 'Partial compiler output retained before cancellation.');
  assert.equal(retained.build.report.commands[0]!.exitCode, 130);
  assert.equal((await f.artifacts.read(retained.build.reportArtifact)).toString('utf8'), 'Whole build report from the operating-system adapter.');
  assert.equal(retained.build.snapshotArtifact.attemptId, authority.attemptId);
  assert.equal(f.jobs.evidence(jobId).length, 0, 'retired compilation never publishes successful current-author evidence');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.sessions.size, 0); assert.equal(f.starts.length, 0);
});

test('an aborted compiler with unconfirmed cleanup remains unknown and reserved after assignment retirement', async t => {
  const f = await fixture(t), gate = f.holdNextBuildUntilAbort(false);
  const submitted = await f.execute({ name: 'build', arguments: {} });
  const jobId = String(submitted.value!.jobId), signal = await gate.entered;
  const retiring = f.owner.retireAssignment(f.assignment.id, 'The coordinator retired native compilation with uncertain termination.');
  await eventually(() => signal.aborted); await retiring;
  await eventually(() => f.jobs.getJob(jobId)?.status === 'unknown' && !!f.originalBuild(jobId));
  const retained = f.originalBuild(jobId)!;
  assert.ok(retained); assert.equal(retained.status, 'canceled');
  assert.equal(retained.report.cleanupErrors?.length, 1);
  assert.equal(f.store.get('inspection-delegation-owner-builds', jobId), undefined, 'an unconfirmed worker result never becomes an accepted owner completion');
  assert.equal((await f.artifacts.read(retained.reportArtifact)).toString('utf8'), 'Whole build report from the operating-system adapter.');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.starts.length, 0);
});

test('service restart recovers the original whole supervised build and every dirty root identity without rerunning compilation', async t => {
  const f = await fixture(t, { gitSources: true });
  const source = structuredClone(f.assignment.source), jobId = await lostBuild(f);
  const original = f.originalBuild(jobId)!;
  assert.ok(original);
  for (const root of f.snapshot.roots) {
    assert.ok(root.sourceCommit, 'the original saved root identity is a real Git commit');
    assert.notEqual(root.commit, root.sourceCommit, 'the dirty immutable preview has a distinct synthetic checked commit');
  }
  assert.deepEqual(original.candidate.workingDirectories?.map(root => ({ id: root.id, commit: root.commit })), f.snapshot.roots.slice(1).map(root => ({ id: root.id, commit: root.commit })));
  assert.equal(f.store.get('inspection-delegation-owner-builds', jobId), undefined, 'the owner never received the original interrupted reply');
  assert.equal(f.builds.length, 1); assert.deepEqual(f.runnerCalls.build, [jobId]);
  await f.restartOwner();
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  f.revealBuildReceipts();
  await f.owner.reconcileBuilds();
  assert.equal(f.jobs.getJob(jobId)!.status, 'succeeded');
  assert.deepEqual(f.jobs.getJob(jobId)!.source, source);
  assert.deepEqual(f.store.get<{ id: string; build: NativeInspectionBuild }>('inspection-delegation-owner-builds', jobId)!.build, original, 'the exact original candidate, whole report and all artifact identities are recovered');
  const frozen = JSON.parse((await f.artifacts.read(original.snapshotArtifact)).toString('utf8')) as InspectionSnapshot['manifest'];
  assert.deepEqual(frozen.roots.map(root => ({ id: root.id, original: root.sourceCommit, checked: root.commit, sourceDigest: root.sourceDigest })), f.snapshot.manifest.roots.map(root => ({ id: root.id, original: root.sourceCommit, checked: root.commit, sourceDigest: root.sourceDigest })));
  const expectedArtifacts = new Set([original.reportArtifact, original.preparationArtifact, original.snapshotArtifact, ...original.evidenceArtifacts, ...original.productArtifacts].map(artifact => artifact.id));
  assert.deepEqual(new Set(f.jobs.evidence(jobId).map(evidence => evidence.artifact.id)), expectedArtifacts);
  for (const evidence of f.jobs.evidence(jobId)) { assert.deepEqual(evidence.source, source); await f.artifacts.path(evidence.artifact); }
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.builds.length, 1); assert.deepEqual(f.runnerCalls.build, [jobId]);
  assert.ok(f.runnerCalls.cancel.includes(jobId), 'recovery confirms original worker teardown before publishing or releasing');
  assert.ok(f.runnerCalls.recover.includes(jobId));
  const count = f.jobs.evidence(jobId).length;
  await f.owner.reconcileBuilds(); await f.status(jobId);
  assert.equal(f.jobs.evidence(jobId).length, count); assert.equal(f.builds.length, 1, 'repeated recovery only resumes bookkeeping once');
});

test('missing PID and absent teardown receipt remain unknown across service restart without an automatic compiler replacement', async t => {
  const f = await fixture(t), jobId = await lostBuild(f, { beforeCompiler: true });
  const record = f.receipt(jobId); assert.equal(record.status, 'unknown');
  assert.equal(record.record?.pid, undefined); assert.equal(record.record?.identity, undefined);
  await f.restartOwner();
  await f.owner.reconcileBuilds(); await f.status(jobId); await f.owner.reconcileBuilds();
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.store.get('inspection-delegation-owner-builds', jobId), undefined);
  assert.equal(f.builds.length, 0); assert.deepEqual(f.runnerCalls.build, [jobId]);
  assert.ok(f.runnerCalls.cancel.filter(id => id === jobId).length >= 2, 'discovery retries the original owner receipt, never its compilation');
});

test('a confirmed cancellation receipt without a build report ends the original unknown job as canceled', async t => {
  const f = await fixture(t), jobId = await lostBuild(f, { beforeCompiler: true });
  const record = f.registration(jobId)!; assert.ok(record);
  f.cancelOverride(jobId, { status: 'completed', canceled: true, error: 'The original worker confirmed cancellation before preparation.', record: { ...record, status: 'completed' } });
  await f.restartOwner(); await f.owner.reconcileBuilds();
  assert.equal(f.jobs.getJob(jobId)!.status, 'canceled');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.store.get('inspection-delegation-owner-builds', jobId), undefined);
  assert.equal(f.builds.length, 0); assert.deepEqual(f.runnerCalls.build, [jobId]);
});

test('a known worker whose cancellation outcome is still unknown retains its reservation after recovery', async t => {
  const f = await fixture(t), jobId = await lostBuild(f, { beforeCompiler: true });
  const record = f.registration(jobId)!; assert.ok(record.pid && record.identity);
  f.cancelOverride(jobId, { status: 'unknown', reason: 'The original worker received cancellation but its compiler children have not confirmed termination.', record: { ...record, status: 'cancel-requested' } });
  await f.restartOwner(); await f.owner.reconcileBuilds();
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  assert.match(f.jobs.getJob(jobId)!.reason!, /children have not confirmed/);
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.builds.length, 0); assert.deepEqual(f.runnerCalls.build, [jobId]);
});

test('a terminal preparation error receipt releases the original build lease without publishing success evidence', async t => {
  const f = await fixture(t), jobId = await lostBuild(f, { beforeCompiler: true });
  const record = f.registration(jobId)!;
  f.recoveryOverride(jobId, { status: 'completed', canceled: false, error: 'The original fixed fixture preparation failed before any application product was created.', record: { ...record, status: 'completed' } });
  await f.restartOwner(); await f.owner.reconcileBuilds();
  assert.equal(f.jobs.getJob(jobId)!.status, 'failed');
  assert.match(f.jobs.getJob(jobId)!.reason!, /fixture preparation failed/);
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.builds.length, 0); assert.deepEqual(f.runnerCalls.build, [jobId]);
  const cancellations = f.runnerCalls.cancel.length;
  await f.status(jobId);
  assert.equal(f.runnerCalls.cancel.length, cancellations, 'a terminal original outcome is not reinterpreted as retryable work');
});

test('a completed supervisor receipt from another job cannot release or publish the original job', async t => {
  const f = await fixture(t), jobId = await lostBuild(f);
  const original = f.originalReceipt(jobId)!; assert.equal(original.status, 'completed');
  f.cancelOverride(jobId, { ...original, record: { ...original.record, jobId: randomUUID() } });
  await f.restartOwner();
  await assert.rejects(f.status(jobId), /another job/);
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.builds.length, 1);
});

test('a mismatched original candidate source in a completion receipt cannot become recovered evidence', async t => {
  const f = await fixture(t), jobId = await lostBuild(f);
  const original = f.originalReceipt(jobId)!; assert.equal(original.status, 'completed');
  assert.ok(original.build);
  const wrong = structuredClone(original.build);
  wrong.candidate.commit = 'c'.repeat(40); wrong.report.commit = wrong.candidate.commit;
  f.cancelOverride(jobId, { ...original, build: wrong });
  await f.restartOwner();
  await assert.rejects(f.status(jobId), /differs from its original owner, source or profile/);
  assert.equal(f.jobs.getJob(jobId)!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.builds.length, 1);
});

test('corrupt retained artifacts fail delivery after confirmed original compiler teardown', async t => {
  const f = await fixture(t), jobId = await lostBuild(f);
  const original = f.originalBuild(jobId)!;
  const reportPath = await f.artifacts.path(original.reportArtifact);
  await writeFile(reportPath, 'Replaced original report bytes');
  f.revealBuildReceipts(); await f.restartOwner();
  await f.status(jobId);
  assert.equal(f.jobs.getJob(jobId)!.status, 'failed');
  assert.match(f.jobs.getJob(jobId)!.reason!, /integrity verification/);
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'), 'confirmed original compiler teardown frees CPUs even when delivery artifacts are unusable');
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.builds.length, 1);
});

test('closing the owner aborts the active supervised compiler and waits for its private result before returning', async t => {
  const f = await fixture(t), gate = f.holdNextBuildUntilAbort();
  const submitted = await f.execute({ name: 'build', arguments: {} });
  const jobId = String(submitted.value!.jobId), signal = await gate.entered;
  assert.equal(signal.aborted, false);
  await f.owner.close();
  assert.equal(signal.aborted, true);
  assert.ok(f.runnerCalls.cancel.includes(jobId), 'service shutdown asks the supervisor to stop the original compiler');
  const completed = f.originalReceipt(jobId)!;
  assert.equal(completed.status, 'completed');
  assert.ok(completed.status === 'completed' && completed.canceled && completed.build?.status === 'canceled', 'shutdown awaits the original worker result rather than merely sending cancellation');
  assert.equal(f.jobs.getJob(jobId)!.status, 'canceled');
  assert.ok(f.store.get('inspection-delegation-owner-builds', jobId), 'all callback bookkeeping has settled before the service may close SQLite');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.jobs.evidence(jobId).length, 0); assert.equal(f.builds.length, 1); assert.equal(f.starts.length, 0);
});

test('exact no-allocation proof ends the reserved launch without calling stop on an unallocated native session', async t => {
  const f = await fixture(t), buildJobId = await f.build();
  f.failNextStart(sessionId => Object.assign(new Error('The requested native session was never allocated.'), { code: 'session-not-allocated', allocationOutcome: 'not-allocated', sessionId }));
  const submitted = await f.execute({ name: 'start', arguments: { buildJobId } });
  const jobId = String(submitted.value!.jobId);
  await eventually(() => f.jobs.getJob(jobId)?.status === 'failed');
  const sessionId = f.jobs.getJob(jobId)!.sessionId!;
  assert.deepEqual(f.requestedStarts, [sessionId]);
  assert.equal(f.jobs.getSession(sessionId)!.status, 'stopped');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'released'));
  assert.equal(f.jobs.actions(sessionId).find(action => action.kind === 'start')!.status, 'failed');
  assert.equal(f.stops.length, 0, 'positive no-allocation proof is sufficient without asking the backend to stop a nonexistent or unrelated session');
  assert.equal(f.sessions.size, 0); assert.equal(f.jobs.evidence(jobId).length, 0);
  assert.ok(f.store.events<{ kind: string }>('inspection-journal', sessionId).some(event => event.value.kind === 'session-stopped'));
});

test('no-allocation proof for another native session cannot release the requested owner lease', async t => {
  const f = await fixture(t), buildJobId = await f.build(), foreign = randomUUID();
  f.failNextStart(() => Object.assign(new Error('Another session was not allocated.'), { code: 'session-not-allocated', allocationOutcome: 'not-allocated', sessionId: foreign }));
  const submitted = await f.execute({ name: 'start', arguments: { buildJobId } });
  const jobId = String(submitted.value!.jobId);
  await eventually(() => f.jobs.getJob(jobId)?.status === 'unknown');
  const sessionId = f.jobs.getJob(jobId)!.sessionId!;
  assert.notEqual(sessionId, foreign); assert.deepEqual(f.requestedStarts, [sessionId]);
  assert.equal(f.jobs.getSession(sessionId)!.status, 'unknown');
  assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'));
  assert.equal(f.jobs.actions(sessionId).find(action => action.kind === 'start')!.status, 'unknown');
  assert.equal(f.stops.length, 0); assert.equal(f.jobs.evidence(jobId).length, 0);
});

test('busy or existing native sessions and generic post-launch failures retain the original reserved identity honestly', async t => {
  for (const scenario of [
    { code: 'native-busy', afterLaunch: false },
    { code: 'session-exists', afterLaunch: false },
    { code: 'EEXIST', afterLaunch: false },
    { code: undefined, afterLaunch: true },
  ]) {
    const f = await fixture(t), buildJobId = await f.build();
    f.failNextStart(() => Object.assign(new Error(`Native launch response is uncertain: ${scenario.code ?? 'socket closed after launch'}`), scenario.code ? { code: scenario.code } : {}), scenario.afterLaunch);
    const submitted = await f.execute({ name: 'start', arguments: { buildJobId } });
    const jobId = String(submitted.value!.jobId);
    await eventually(() => f.jobs.getJob(jobId)?.status === 'unknown');
    const sessionId = f.jobs.getJob(jobId)!.sessionId!;
    assert.deepEqual(f.requestedStarts, [sessionId]);
    assert.equal(f.jobs.getSession(sessionId)!.status, 'unknown');
    assert.ok(f.jobs.leases(jobId).every(lease => lease.status === 'held'), `${scenario.code ?? 'post-launch failure'} does not prove that the original process or allocation ended`);
    assert.equal(f.jobs.actions(sessionId).find(action => action.kind === 'start')!.status, 'unknown');
    assert.equal(f.stops.length, 0); assert.equal(f.jobs.evidence(jobId).length, 0);
    if (scenario.afterLaunch) assert.ok(f.sessions.has(sessionId), 'the reserved ID still identifies an application that actually launched before the reply failed');
    assert.equal(f.store.get<{ backendSessionId?: string }>('inspection-delegation-owner-jobs', jobId)?.backendSessionId, sessionId, 'the expected backend session identity survives an uncertain launch result');
  }
});
