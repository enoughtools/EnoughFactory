import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import type { Chat, InspectionAuthority, InspectionSourceIdentity, InspectionVerificationRun, Session, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { NativeAction, NativeProduct, NativeSession } from '@enoughfactory/native-inspection';
import { ArtifactStore, InspectionSnapshotManager, type ArtifactManifest, type InspectionSnapshot } from '@enoughfactory/workspaces';
import type { DeviceApp, Extension } from './app.ts';
import type { AgentToolBridgeContext } from './chats.ts';
import type { QualityEvidenceReport } from './factory-quality.ts';
import { InspectionDelegation } from './inspection-delegation.ts';
import type { InspectionJournalPage } from './inspection-delegation-journal.ts';
import type { NativeDelegationOwnerOptions } from './inspection-delegation-owner.ts';
import type { NativeBuildRecovery, NativeBuildRunner } from './inspection-build-runner.ts';
import { InspectionJobs } from './inspection-jobs.ts';
import type { NativeFixtureProfile, NativeInspectionAdapter, NativeInspectionBuild } from './inspection-native.ts';
import { InspectionQualityService, type InspectionImageDelivery, type InspectionReferenceView } from './inspection-quality.ts';
import { Store } from './store.ts';
import { HttpError } from './util.ts';
import { INSPECTION_VERIFIER_RUNS, inspectionQualityPolicySha256 } from './inspection-verifier.ts';

const run = promisify(execFile);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 6, taskId: 'task', attemptId: 'author-attempt', authorityGeneration: 2, policyRevision: 1 };
const profile: NativeFixtureProfile = {
  id: 'mail-macos', build: { tool: 'xcodebuild', project: 'Mail.xcodeproj', scheme: 'Mail', platform: 'macos', configuration: 'Debug' },
  launchArguments: ['--isolated-fixture', '{runId}'], fixtureEvidenceSha256: 'f'.repeat(64),
};
type ToolReply = { content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>; isError?: boolean };
type AppState = {
  app: DeviceApp; store: Store; artifacts: ArtifactStore; jobs: InspectionJobs; plugin: InspectionDelegation;
};
const decoded = (reply: ToolReply): Array<Record<string, unknown>> => reply.content.flatMap(item => item.type === 'text' ? [JSON.parse(item.text) as Record<string, unknown>] : []);
const value = (reply: ToolReply, key: string): unknown => decoded(reply).find(item => item[key] !== undefined)?.[key];

/** Actual paired extension routes, SQLite journals and multi-root source transfers; only the OS adapter is replaced. */
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'enough-native-paired-route-')));
  const devices = new Map<string, AppState>();
  const control: Array<{ sender: string; recipient: string; body: unknown }> = [];
  const transfers: Array<{ sender: string; recipient: string; manifest: ArtifactManifest }> = [];
  const compiled: InspectionSnapshot[] = [], actions: NativeAction[] = [], sessions = new Map<string, NativeSession>();
  const supervised: Array<{ jobId: string; sourceDigest: string; authority: InspectionAuthority }> = [];
  const products = new Map<string, NativeProduct>(), values = new Map<string, string>(), observed = new Map<string, string>();
  let current = true, authorCurrent = true, coordinatorCurrent = true, configured = true, nextLostReply: string | undefined, corruptTransfer = false, observationNumber = 0;
  let coordinatorUnavailable: 'network' | 'service' | undefined;
  let nativeInputDisconnect = false;
  let trackJournals = false, activeJournals = 0, maxConcurrentJournals = 0;
  let nextJournalTamper: ((page: InspectionJournalPage) => void) | undefined;
  let protectedCaptureOverrides: Partial<InspectionSourceIdentity> | undefined;
  let retainedVerifierSource: { snapshot: InspectionSnapshot; source: InspectionSourceIdentity } | undefined;
  let launches = 0, restarts = 0, stops = 0, captures = 0, serviceOperations = 0, runtimeOperations = 0;
  const source = join(directory, 'source'), design = join(directory, 'enough-ui');
  await mkdir(join(source, 'Mail.xcodeproj'), { recursive: true }); await mkdir(design, { recursive: true });
  await writeFile(join(source, 'Main.swift'), 'let title = "Committed mail"\n');
  await writeFile(join(source, 'Mail.xcodeproj', 'project.pbxproj'), '// Native source fixture\n');
  await run('git', ['init', '-q', source]);
  await run('git', ['-C', source, 'add', '.']);
  await run('git', ['-C', source, '-c', 'user.name=Inspection', '-c', 'user.email=inspection@example.invalid', 'commit', '-qm', 'Initial fixture']);
  const head = (await run('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(join(source, 'Main.swift'), 'let title = "Dirty native mail"\n');
  await writeFile(join(source, 'Untracked.swift'), 'let previewBody = "Untracked body"\n');
  await writeFile(join(design, 'Tokens.swift'), 'let spacing = 12\n');
  const catalog = ['coordinator', 'linux-author', 'mac-owner'].map(id => ({
    id, name: id, platform: id === 'mac-owner' ? 'mac' : 'linux', online: true,
    executionTargets: id === 'mac-owner' ? [{ id: 'mac-owner:host', kind: 'host-macos', protocolVersion: 1,
      capabilities: [{ kind: 'apple-compilation', readiness: 'ready' }, { kind: 'macos-app-inspection', readiness: 'ready' }] }] : [],
  }));
  for (const deviceId of ['coordinator', 'linux-author', 'mac-owner']) {
    const dataDir = join(directory, deviceId), store = new Store(dataDir), artifacts = new ArtifactStore(join(dataDir, 'artifacts'), deviceId);
    const extensions: Extension[] = [], serviceActivityHooks: Array<() => string[]> = [];
    const localCurrent = (candidate: InspectionAuthority) => deviceId !== 'mac-owner' && current && (deviceId !== 'coordinator' || coordinatorCurrent) && (deviceId !== 'linux-author' || authorCurrent) && JSON.stringify(candidate) === JSON.stringify(authority);
    const app = {
      dataDir, store, device: { id: deviceId }, devices: catalog.map(device => ({ ...device, local: device.id === deviceId })), extensions, serviceActivityHooks,
      changed() {}, emit() {},
      sessions: { owns: (id: string) => store.get<Session>('sessions', id)?.deviceId === deviceId },
      async withServiceOperation<T>(operation: (signal: AbortSignal) => Promise<T>) { serviceOperations++; return operation(new AbortController().signal); },
      async withRuntimeOperation() { runtimeOperations++; throw new Error('Native work must not require a container runtime.'); },
    } as unknown as DeviceApp;
    let plugin!: InspectionDelegation;
    const jobs = new InspectionJobs(store, { deviceId, authorityCurrent: candidate => localCurrent(candidate) || Boolean(plugin?.acceptedAuthorityCurrent(candidate)) });
    const native: NativeDelegationOwnerOptions['native'] & Pick<NativeInspectionAdapter, 'build'> = {
      async build(snapshot, selected, context) {
        assert.equal(deviceId, 'mac-owner'); compiled.push(structuredClone(snapshot));
        const id = randomUUID(), at = new Date().toISOString();
        const reportArtifact = await artifacts.put('Original compiler output', { ...authority, name: 'build-report.json', mime: 'application/json' });
        const productArtifact = await artifacts.put('Native product fixture bytes', { ...authority, name: 'Mail.app.zip', mime: 'application/zip' });
        const snapshotArtifact = await artifacts.put(JSON.stringify(snapshot.manifest), { ...authority, name: 'snapshot.json', mime: 'application/json' });
        const preparationArtifact = await artifacts.put(JSON.stringify({ sourceDigest: snapshot.sourceDigest }), { ...authority, name: 'preparation.json', mime: 'application/json' });
        const fixtureReceiptArtifact = await artifacts.put(JSON.stringify({ fixtureProfileId: selected.id, sourceDigest: snapshot.sourceDigest, runId: id, scope: 'mock-native-adapter' }), { ...authority, name: 'fixture-receipt.json', mime: 'application/json' });
        const product: NativeProduct = {
          platform: 'macos', appPath: join(dataDir, 'products', id, 'Mail.app'), bundleIdentifier: 'dev.enoughfactory.mail-fixture',
          inventorySha256: 'b'.repeat(64), originalArtifactSha256: productArtifact.sha256,
          source: { kind: 'development-snapshot', snapshotSha256: snapshot.sourceDigest }, launchArguments: ['--isolated-fixture', id],
          fixture: { kind: 'verified-isolated', runId: id, evidenceSha256: selected.fixtureEvidenceSha256 },
        };
        products.set(id, product);
        const candidate = { id: randomUUID(), workspaceId: randomUUID(), ...context.authority, deviceId, baseCommit: snapshot.roots[0]!.commit,
          commit: snapshot.roots[0]!.commit, branch: 'inspection', bundleArtifact: snapshotArtifact, diffArtifact: reportArtifact, createdAt: at };
        return { id, status: 'passed', candidate, product, reportArtifact, preparationArtifact, snapshotArtifact, fixtureReceiptArtifact, fixtureProfileId: selected.id, evidenceArtifacts: [fixtureReceiptArtifact], productArtifacts: [productArtifact],
          report: { id: randomUUID(), candidateId: candidate.id, commit: candidate.commit, status: 'passed', commands: [{ command: 'native-build-fixture', exitCode: 0, stdout: 'Compiler complete', stderr: '', startedAt: at, endedAt: at }], logArtifact: reportArtifact, createdAt: at } } as NativeInspectionBuild;
      },
      async product(id) { const result = products.get(id); assert.ok(result); return result; },
      async readiness() { return { status: 'ready', reasons: [] }; },
      async start(id, ownerAttemptId, sessionId) {
        const product = products.get(id); assert.ok(product); assert.ok(sessionId, 'launch receives the original durable owned session identity'); launches++;
        const session: NativeSession = { id: sessionId, platform: 'macos', product, ownerAttemptId, pid: 100, startedAt: new Date().toISOString(), directory: join(dataDir, 'native-sessions', sessionId) };
        sessions.set(session.id, session); values.set(session.id, 'Original body'); return session;
      },
      async observe(id) {
        assert.ok(sessions.has(id)); const observationId = `native-observation-${++observationNumber}`, path = join(dataDir, `${observationId}.png`);
        await writeFile(path, png); observed.set(id, observationId);
        return { sessionId: id, observationId, observedAt: new Date().toISOString(), appState: 'running', truncated: false,
          screenshot: { path, mimeType: 'image/png', sha256: sha(png), width: 1, height: 1 },
          elements: [{ id: 'body', type: 'text-field', label: 'Message body', value: values.get(id), enabled: true, frame: { x: 0, y: 0, w: 1, h: 1 } },
            { id: 'save', type: 'button', label: 'Save draft', enabled: true, frame: { x: 0, y: 0, w: 1, h: 1 } }] };
      },
      async act(id, action) {
        assert.equal(action.observationId, observed.get(id), 'the original owner-local observation authorizes the native action'); actions.push(action);
        if (action.kind === 'type') values.set(id, action.text);
        if (nativeInputDisconnect) { nativeInputDisconnect = false; throw new Error('Native helper disconnected after input dispatch.'); }
        return { performed: true, requiresObservation: true };
      },
      async restart(id, observationId) {
        const session = sessions.get(id); assert.ok(session); assert.equal(observationId, observed.get(id)); restarts++;
        const previousPid = session.pid, pid = (previousPid ?? 100) + 1; sessions.set(id, { ...session, pid }); observed.delete(id);
        return { performed: true, requiresObservation: true, previousProcessExited: true, previousPid, pid };
      },
      async stop(id) { assert.ok(sessions.has(id)); sessions.delete(id); stops++; },
      async discover() { return [...sessions.values()].map(session => ({ ...session, status: 'running' })); },
    };
    const completedBuilds = new Map<string, NativeBuildRecovery>();
    const builds: Pick<NativeBuildRunner, 'build' | 'cancel' | 'recover'> = {
      async build(snapshot, selected, input) {
        assert.ok(input.jobId, 'supervision receives the original durable compiler job identity');
        const job = jobs.getJob(input.jobId); assert.ok(job); assert.equal(job.capability, 'apple-compilation'); assert.equal(job.ownerDeviceId, 'mac-owner');
        assert.equal(job.source.sha256, snapshot.sourceDigest); assert.deepEqual(job.authority, input.authority);
        supervised.push({ jobId: input.jobId, sourceDigest: snapshot.sourceDigest, authority: structuredClone(input.authority) });
        const build = await native.build(snapshot, selected, input), at = new Date().toISOString();
        completedBuilds.set(input.jobId, { status: 'completed', build, canceled: false, record: {
          version: 1, key: `mock-supervisor-${input.jobId}`, jobId: input.jobId, requestSha256: sha(JSON.stringify([input.jobId, snapshot.sourceDigest])),
          workerPath: join(directory, 'mock-native-build-worker'), workerArgs: [], status: 'completed', createdAt: at, updatedAt: at,
        } });
        return build;
      },
      async recover(jobId) { return completedBuilds.get(jobId) ?? { status: 'unknown', reason: 'The mock supervisor has no confirmed completion for this job.' }; },
      async cancel(jobId) { return completedBuilds.get(jobId) ?? { status: 'unknown', reason: 'The mock supervisor has no confirmed worker teardown for this job.' }; },
    };
    plugin = new InspectionDelegation({ app, jobs, artifacts, native: native as NativeInspectionAdapter, builds, platform: deviceId === 'mac-owner' ? 'darwin' : 'linux',
      profiles: id => deviceId === 'mac-owner' && configured && id === 'mail-project' ? [profile] : [], localAuthorityCurrent: localCurrent,
      async capture() {
        captures++;
        if (deviceId === 'coordinator' && retainedVerifierSource) return retainedVerifierSource;
        const snapshot = await new InspectionSnapshotManager({ dataDir: join(dataDir, 'inspection'), artifacts }).create({ roots: [{ id: 'primary', name: 'Mail', path: source }, { id: 'enough-ui', name: 'EnoughUI', path: design }], context: authority });
        if (!protectedCaptureOverrides) return snapshot;
        return { snapshot, source: { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })), candidateId: 'protected-candidate', candidateCommit: 'c'.repeat(40), checkedCommit: 'd'.repeat(40), ...protectedCaptureOverrides } };
      },
      peers: {
        async request(recipient, request) {
          const target = devices.get(recipient); assert.ok(target); control.push({ sender: deviceId, recipient, body: request.body });
          if (recipient === 'coordinator' && (request.body as { op?: string }).op === 'validate') {
            if (coordinatorUnavailable === 'network') throw new Error('The paired coordinator is offline.');
            if (coordinatorUnavailable === 'service') return { v: 1, id: randomUUID(), status: 503, body: { error: 'Coordinator service unavailable.' } };
          }
          const isTrackedJournal = trackJournals && recipient === 'mac-owner' && (request.body as { operation?: { name?: string } }).operation?.name === 'journal';
          if (isTrackedJournal) { activeJournals++; maxConcurrentJournals = Math.max(maxConcurrentJournals, activeJournals); }
          try {
            if (isTrackedJournal) await new Promise(resolve => setTimeout(resolve, 20));
            let body: unknown;
            for (const extension of target.app.extensions) { body = await extension({ method: request.method, url: new URL(request.path, 'http://paired.invalid'), body: request.body as Record<string, unknown>, peerId: deviceId }); if (body !== undefined) break; }
            assert.notEqual(body, undefined, 'the production paired extension handles the native route');
            const operation = request.body as { op?: string; operation?: { name?: string } };
            if (nextJournalTamper && operation.op === 'invoke' && operation.operation?.name === 'journal') {
              const altered = structuredClone(body) as { value: InspectionJournalPage }, tamper = nextJournalTamper; nextJournalTamper = undefined;
              tamper(altered.value); body = altered;
            }
            if (nextLostReply && operation.op === 'invoke' && operation.operation?.name === nextLostReply) { nextLostReply = undefined; throw new Error('Paired transport lost the response after the original operation.'); }
            return { v: 1, id: randomUUID(), status: 200, body };
          } catch (error) { if (!(error instanceof HttpError)) throw error; return { v: 1, id: randomUUID(), status: error.status, body: { error: error.message, code: error.code } }; }
          finally { if (isTrackedJournal) activeJournals--; }
        },
        async uploadArtifact(recipient, path, peerManifest) {
          const manifest = peerManifest as unknown as ArtifactManifest, target = devices.get(recipient); assert.ok(target);
          const transfer = join(directory, recipient, 'transfers', manifest.id); await mkdir(join(directory, recipient, 'transfers'), { recursive: true }); await copyFile(path, transfer);
          if (corruptTransfer) { corruptTransfer = false; await writeFile(transfer, 'Corrupted source bytes'); }
          target.store.set('peer-artifacts', { id: manifest.id, peerId: deviceId, manifest, path: transfer }); transfers.push({ sender: deviceId, recipient, manifest });
        },
      },
    });
    devices.set(deviceId, { app, store, artifacts, jobs, plugin });
    store.set('projects', { id: 'mail-project' });
    store.set('goals', { id: authority.goalId, coordinatorId: 'coordinator' });
    store.set('tasks', { id: authority.taskId, currentAttemptId: authority.attemptId });
    store.set('attempts', { id: authority.attemptId, deviceId: 'linux-author' });
    plugin.initialize();
  }
  const author = devices.get('linux-author')!, owner = devices.get('mac-owner')!, coordinator = devices.get('coordinator')!;
  const token = author.jobs.issueAuthority(authority, { capabilities: ['apple-compilation', 'macos-app-inspection'], executionTargetIds: ['linux-author:container'] }).token;
  const context = { session: { projectId: 'mail-project' }, signal: new AbortController().signal } as AgentToolBridgeContext;
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await author.plugin.dispatch(context, token, name, args); assert.ok(reply); return reply as ToolReply;
  };
  const poll = async (jobId: string, predicate: (job: NonNullable<ReturnType<InspectionJobs['getJob']>>) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (true) {
      await call('factory_job_status', { jobId }); const job = author.plugin.taskInspection(authority.taskId).jobs.find(job => job.id === jobId);
      if (job && predicate(job)) return job;
      assert.ok(Date.now() < deadline, `Timed out waiting for paired native job ${jobId}`); await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const build = async () => {
    const result = await call('factory_native_build', { requestId: 'build-mail', profileId: profile.id }), jobId = String(value(result, 'jobId'));
    await poll(jobId, job => job.status === 'succeeded'); return jobId;
  };
  const start = async (buildJobId: string) => {
    const result = await call('factory_native_start', { requestId: 'start-mail', buildJobId }), jobId = String(value(result, 'jobId'));
    const job = await poll(jobId, job => Boolean(job.sessionId && owner.jobs.getSession(job.sessionId)?.status === 'ready'));
    assert.ok(job.sessionId); return { jobId, sessionId: job.sessionId };
  };
  t.after(async () => { for (const state of devices.values()) await state.plugin.close(); for (const state of devices.values()) state.store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, source, design, head, devices, author, owner, coordinator, token, context, call, poll, build, start, compiled, supervised, control, transfers, actions, sessions,
    retire() { current = false; }, retireAuthor() { authorCurrent = false; }, retireCoordinator() { coordinatorCurrent = false; }, coordinatorOffline(mode: 'network' | 'service') { coordinatorUnavailable = mode; }, loseNativeInput() { nativeInputDisconnect = true; }, noProfiles() { configured = false; }, corruptSourceTransfer() { corruptTransfer = true; }, loseReply(name: string) { nextLostReply = name; },
    trackJournalConcurrency() { trackJournals = true; activeJournals = 0; maxConcurrentJournals = 0; }, get maxConcurrentJournals() { return maxConcurrentJournals; },
    tamperNextJournal(tamper: (page: InspectionJournalPage) => void) { nextJournalTamper = tamper; },
    protectCapture(overrides: Partial<InspectionSourceIdentity> = {}) { protectedCaptureOverrides = overrides; },
    verificationSource(snapshot: InspectionSnapshot, source: InspectionSourceIdentity) { retainedVerifierSource = { snapshot, source }; },
    get captures() { return captures; }, get launches() { return launches; }, get restarts() { return restarts; }, get stops() { return stops; }, get serviceOperations() { return serviceOperations; }, get runtimeOperations() { return runtimeOperations; } };
}

/** A separate coordinator verifier owns a frozen source; its author remains on linux-author. */
async function coordinatorVerifierFixture(t: TestContext) {
  const f = await fixture(t), state = f.coordinator;
  const snapshot = await new InspectionSnapshotManager({ dataDir: join(state.app.dataDir, 'verification'), artifacts: state.artifacts }).create({ roots: [{ id: 'primary', name: 'Mail', path: f.source }, { id: 'enough-ui', name: 'EnoughUI', path: f.design }], context: authority });
  const source: InspectionSourceIdentity = { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, candidateId: 'checked-candidate', candidateCommit: snapshot.roots[0]!.commit, checkedCommit: snapshot.roots[0]!.commit, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })) };
  f.verificationSource(snapshot, source);
  const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'edit-draft', platform: 'macos' }], referenceIds: ['enough-ui'] };
  const at = new Date().toISOString();
  const verifier: InspectionVerificationRun = { id: 'coordinator-verifier', authority, source, quality, policySha256: inspectionQualityPolicySha256(quality), ownerDeviceId: 'coordinator', executionTargetKind: 'container', executionTargetId: 'coordinator:container', status: 'running', sessionId: 'verifier-session', chatId: 'verifier-chat', startedAt: at, createdAt: at, updatedAt: at, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  const session: Session = { id: verifier.sessionId!, projectId: 'mail-project', deviceId: 'coordinator', name: 'independent-verification', status: 'ready', executionTargetKind: 'container', executionTargetId: verifier.executionTargetId, verificationRunId: verifier.id, services: [], createdAt: at, updatedAt: at };
  const chat: Chat = { id: verifier.chatId!, sessionId: session.id, deviceId: 'coordinator', runtime: 'codex', approvalMode: 'approve-all', status: 'running', title: 'Independent verification', verificationRunId: verifier.id, createdAt: at, updatedAt: at };
  state.store.set(INSPECTION_VERIFIER_RUNS, verifier); state.store.set('sessions', session); state.store.set('chats', chat);
  const token = state.jobs.issueAuthority(authority, { capabilities: ['apple-compilation', 'macos-app-inspection'], executionTargetIds: ['coordinator:container'] }).token;
  const context = { session, chat, attemptId: authority.attemptId, verificationRunId: verifier.id, signal: new AbortController().signal } as AgentToolBridgeContext;
  const call = async (name: string, args: Record<string, unknown>) => { const reply = await state.plugin.dispatch(context, token, name, args); assert.ok(reply); return reply as ToolReply; };
  const poll = async (jobId: string, predicate: (job: NonNullable<ReturnType<InspectionJobs['getJob']>>) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (true) {
      await call('factory_job_status', { jobId }); const job = state.plugin.taskInspection(authority.taskId).jobs.find(job => job.id === jobId);
      if (job && predicate(job)) return job;
      assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  return { ...f, state, verifier, verifierSession: session, verifierChat: chat, source, snapshot, quality, call, poll,
    get launches() { return f.launches; }, get stops() { return f.stops; } };
}

function imageDelivery(store: Store, reply: ToolReply, eventId: string, chatId = 'author-chat') {
  const image = reply.content.find(item => item.type === 'image'); assert.ok(image && image.type === 'image');
  const bytes = Buffer.from(image.data, 'base64'); assert.deepEqual(bytes, png); assert.equal(image.mimeType, 'image/png');
  // Mirrors the provider delivery callback only after the original image content has been returned.
  store.set<InspectionImageDelivery>('provider-image-deliveries', { id: eventId, chatId, eventId, artifactSha256: sha(bytes), authority, route: 'tool-image' });
}

test('Linux author builds, inspects, edits, asserts, restarts and stops a native app through paired Mac routes', async t => {
  const f = await fixture(t), buildJobId = await f.build(), started = await f.start(buildJobId);
  assert.equal(f.captures, 1); assert.equal(f.compiled.length, 1); assert.equal(f.launches, 1);
  assert.deepEqual(f.supervised, [{ jobId: buildJobId, sourceDigest: f.compiled[0]!.sourceDigest, authority }], 'paired compilation uses the injected supervisor for the exact original job and source');
  const snapshot = f.compiled[0]!;
  assert.deepEqual(snapshot.roots.map(root => root.id), ['primary', 'enough-ui']);
  assert.equal(await readFile(join(snapshot.roots[0]!.path, 'Main.swift'), 'utf8'), 'let title = "Dirty native mail"\n');
  assert.equal(await readFile(join(snapshot.roots[0]!.path, 'Untracked.swift'), 'utf8'), 'let previewBody = "Untracked body"\n');
  assert.equal(await readFile(join(snapshot.roots[1]!.path, 'Tokens.swift'), 'utf8'), 'let spacing = 12\n');
  assert.equal((await run('git', ['-C', f.source, 'rev-parse', 'HEAD'])).stdout.trim(), f.head, 'capturing dirty source never commits the author checkout');
  assert.match((await run('git', ['-C', f.source, 'status', '--porcelain'])).stdout, /M Main.swift/);
  assert.ok(f.transfers.filter(item => item.sender === 'linux-author' && item.recipient === 'mac-owner').length >= 3);
  assert.ok(f.control.some(item => item.sender === 'mac-owner' && item.recipient === 'coordinator' && (item.body as { op: string }).op === 'validate'));

  const before = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-before' }); imageDelivery(f.author.store, before, 'before-image');
  const beforeObservation = String(value(before, 'observationId')), beforeEvidence = String(value(before, 'screenshotEvidenceId'));
  assert.equal(f.author.plugin.evidenceForAuthority(authority).find(item => item.id === beforeEvidence)?.artifact.deviceId, 'mac-owner', 'the projection retains the actual screenshot owner immediately');
  const edit = await f.call('factory_native_action', { sessionId: started.sessionId, requestId: 'write-body', observationId: beforeObservation, action: { kind: 'type', elementId: 'body', text: 'Draft edited from Linux', mode: 'replace' } });
  const editActionId = String(value(edit, 'actionId')); assert.equal(f.actions.length, 1); assert.equal(f.actions[0]!.observationId, 'native-observation-1');
  const repeated = await f.call('factory_native_action', { sessionId: started.sessionId, requestId: 'write-body', observationId: beforeObservation, action: { kind: 'type', elementId: 'body', text: 'Draft edited from Linux', mode: 'replace' } });
  assert.equal(value(repeated, 'actionId'), editActionId); assert.equal(f.actions.length, 1, 'the same request is never applied twice');
  const after = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-after' }); imageDelivery(f.author.store, after, 'after-image');
  let afterObservation = String(value(after, 'observationId')), afterEvidence = String(value(after, 'screenshotEvidenceId'));
  const elements = value(after, 'elements') as Array<{ id: string; value?: string }>;
  assert.equal(elements.find(item => item.id === 'body')?.value, 'Draft edited from Linux');
  for (const [requestId, valueEquals] of [['reject-prefix', 'Draft edited'], ['reject-suffix', 'edited from Linux']] as const) {
    const partial = await f.call('factory_assert', { sessionId: started.sessionId, requestId, observationId: afterObservation, labelIncludes: 'Message body', valueEquals });
    assert.equal(value(partial, 'passed'), false, 'A delegated exact assertion cannot silently degrade into label presence or substring matching');
    const evidence = f.author.plugin.evidenceForAuthority(authority).find(item => item.id === value(partial, 'evidenceId'))!;
    assert.equal(evidence.metadata?.passed, false); assert.equal(evidence.metadata?.observationId, afterObservation);
    const fresh = await f.call('factory_observe', { sessionId: started.sessionId, requestId: `observe-${requestId}` }); imageDelivery(f.author.store, fresh, `image-${requestId}`);
    afterObservation = String(value(fresh, 'observationId')); afterEvidence = String(value(fresh, 'screenshotEvidenceId'));
  }
  for (const [requestId, labelEquals] of [['reject-label-prefix', 'Message'], ['reject-label-suffix', 'body']] as const) {
    const condition = { labelIncludes: 'Message', labelEquals, valueEquals: 'Draft edited from Linux' };
    const partial = await f.call('factory_assert', { sessionId: started.sessionId, requestId, observationId: afterObservation, ...condition });
    assert.equal(value(partial, 'passed'), false, 'A delegated exact label cannot silently degrade into the required label selector');
    const evidence = f.author.plugin.evidenceForAuthority(authority).find(item => item.id === value(partial, 'evidenceId'))!;
    assert.deepEqual(evidence.source, f.author.plugin.taskInspection(authority.taskId).jobs.find(item => item.id === started.jobId)!.source);
    assert.equal(evidence.metadata?.passed, false); assert.equal(evidence.metadata?.observationId, afterObservation);
    const original = JSON.parse((await f.author.artifacts.read(evidence.artifact)).toString('utf8')) as { observationId: string; results: Array<{ condition: unknown; passed: boolean }> };
    assert.equal(original.observationId, afterObservation); assert.deepEqual(original.results, [{ condition, passed: false }]);
    const fresh = await f.call('factory_observe', { sessionId: started.sessionId, requestId: `observe-${requestId}` }); imageDelivery(f.author.store, fresh, `image-${requestId}`);
    afterObservation = String(value(fresh, 'observationId')); afterEvidence = String(value(fresh, 'screenshotEvidenceId'));
  }
  const exactCondition = { labelIncludes: 'Message', labelEquals: 'Message body', valueEquals: 'Draft edited from Linux' };
  const asserted = await f.call('factory_assert', { sessionId: started.sessionId, requestId: 'assert-body', observationId: afterObservation, ...exactCondition });
  assert.equal(value(asserted, 'passed'), true);
  const assertedEvidence = f.author.plugin.evidenceForAuthority(authority).find(item => item.id === value(asserted, 'evidenceId'))!;
  const originalAssertion = JSON.parse((await f.author.artifacts.read(assertedEvidence.artifact)).toString('utf8')) as { observationId: string; results: Array<{ condition: unknown; passed: boolean }> };
  assert.equal(originalAssertion.observationId, afterObservation); assert.deepEqual(originalAssertion.results, [{ condition: exactCondition, passed: true }]);

  // The acceptance service consumes the original transferred journal, rather than invented receipt objects.
  const source = f.author.plugin.taskInspection(authority.taskId).jobs.find(item => item.id === started.jobId)!.source;
  assert.deepEqual(assertedEvidence.source, source);
  const referenceArtifact = await f.author.artifacts.put(await readFile(join(snapshot.roots[1]!.path, 'Tokens.swift')), { ...authority, name: 'Tokens.swift', mime: 'text/plain' });
  assert.match((await f.author.artifacts.read(referenceArtifact)).toString('utf8'), /spacing = 12/);
  f.author.store.set<InspectionReferenceView>('inspection-reference-views', { id: 'tokens-view', referenceId: 'enough-ui', authority, source, artifacts: [referenceArtifact], inspectedAt: new Date().toISOString() });
  const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'edit-draft', platform: 'macos' }], referenceIds: ['enough-ui'] };
  const report: QualityEvidenceReport = { version: 1, source,
    workflows: [{ id: 'edit-draft', platform: 'macos', before: beforeEvidence, action: editActionId, after: afterEvidence, outcome: 'passed', assertion: 'The broker observed the exact edited draft body.', assertionEvidenceId: String(value(asserted, 'evidenceId')) }],
    reviews: [{ platform: 'macos', observations: [beforeEvidence, afterEvidence], references: [{ id: 'enough-ui', comparison: 'The fixture source exposes its supplied spacing token.' }],
      dimensions: { hierarchy: 'Fixture pipeline coverage.', spacing: 'Fixture pipeline coverage.', clipping: 'Fixture pipeline coverage.', typography: 'Fixture pipeline coverage.', controls: 'Fixture pipeline coverage.', states: 'Fixture pipeline coverage.' }, defects: [] }] };
  const qualityService = new InspectionQualityService({ store: f.author.store, artifacts: f.author.artifacts, authorityCurrent: () => true });
  const submitted = await qualityService.submit({ authority, quality, report });
  assert.deepEqual(submitted.gate.issues, []); assert.equal(submitted.gate.status, 'ready-for-review', 'actual remote screenshot/action/assertion provenance is accepted');
  const checked = await qualityService.check({ authority, quality, source: { ...source, candidateCommit: 'c'.repeat(40) }, candidateCommit: 'c'.repeat(40) }); assert.equal(checked.passed, true);

  const leases = f.owner.jobs.leases(started.jobId).map(item => item.id);
  const beforeRestart = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-before-restart' });
  const restartArgs = { sessionId: started.sessionId, requestId: 'restart-mail', observationId: value(beforeRestart, 'observationId') };
  const restartedOnce = await f.call('factory_native_restart', restartArgs); assert.equal(value(restartedOnce, 'performed'), true);
  await f.call('factory_native_restart', restartArgs);
  assert.equal(f.restarts, 1); assert.deepEqual(f.owner.jobs.leases(started.jobId).map(item => item.id), leases, 'restart preserves the owned native reservation');
  assert.equal(f.owner.jobs.getSession(started.sessionId)?.processIdentity?.pid, 101);
  const restarted = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-restarted' }); imageDelivery(f.author.store, restarted, 'restart-image');
  assert.notEqual(value(restarted, 'observationId'), afterObservation);
  await f.call('factory_stop', { sessionId: started.sessionId, requestId: 'stop-mail' }); await f.poll(started.jobId, job => job.status === 'succeeded');
  assert.equal(f.stops, 1); assert.equal(f.sessions.size, 0); assert.ok(f.owner.jobs.leases(started.jobId).every(item => item.status === 'released'));
  assert.ok(f.serviceOperations > 0); assert.equal(f.runtimeOperations, 0, 'native service admission works independently of Docker');
  assert.equal(JSON.stringify(f.control).includes(png.toString('base64')), false, 'actual pixels use the bulk artifact lane');
});

test('an independent coordinator verifier receives original paired native images and assertion evidence without impersonating its ended author', async t => {
  const f = await coordinatorVerifierFixture(t);
  const built = await f.call('factory_native_build', { requestId: 'verifier-build', profileId: profile.id }), buildJobId = String(value(built, 'jobId'));
  await f.poll(buildJobId, job => job.status === 'succeeded');
  const started = await f.call('factory_native_start', { requestId: 'verifier-start', buildJobId }), jobId = String(value(started, 'jobId'));
  const job = await f.poll(jobId, job => Boolean(job.sessionId && f.owner.jobs.getSession(job.sessionId)?.status === 'ready'));
  assert.ok(job.sessionId); assert.deepEqual(job.source, f.source);
  assert.deepEqual(f.compiled[0]!.roots.map(root => root.sourceDigest), f.snapshot.roots.map(root => root.sourceDigest));
  const before = await f.call('factory_observe', { sessionId: job.sessionId, requestId: 'verifier-before' }); imageDelivery(f.state.store, before, 'verifier-before-image', f.verifierChat.id);
  const changed = await f.call('factory_native_action', { sessionId: job.sessionId, requestId: 'verifier-write', observationId: value(before, 'observationId'), action: { kind: 'type', elementId: 'body', text: 'Independent verified body', mode: 'replace' } });
  const after = await f.call('factory_observe', { sessionId: job.sessionId, requestId: 'verifier-after' }); imageDelivery(f.state.store, after, 'verifier-after-image', f.verifierChat.id);
  const assertion = await f.call('factory_assert', { sessionId: job.sessionId, observationId: value(after, 'observationId'), labelIncludes: 'Message body', valueIncludes: 'Independent verified body' });
  assert.equal(value(assertion, 'passed'), true);
  const references = await f.state.artifacts.put(await readFile(join(f.snapshot.roots[1]!.path, 'Tokens.swift')), { ...authority, name: 'Tokens.swift', mime: 'text/plain' });
  f.state.store.set<InspectionReferenceView>('inspection-reference-views', { id: 'verifier-reference', referenceId: 'enough-ui', authority, source: f.source, artifacts: [references], inspectedAt: new Date().toISOString() });
  const beforeId = String(value(before, 'screenshotEvidenceId')), afterId = String(value(after, 'screenshotEvidenceId'));
  const report: QualityEvidenceReport = { version: 1, source: f.source,
    workflows: [{ id: 'edit-draft', platform: 'macos', before: beforeId, action: String(value(changed, 'actionId')), after: afterId, outcome: 'passed', assertion: 'The paired broker observed the independent verifier text.', assertionEvidenceId: String(value(assertion, 'evidenceId')) }],
    reviews: [{ platform: 'macos', observations: [beforeId, afterId], references: [{ id: 'enough-ui', comparison: 'The original supplied fixture token is 12.' }], dimensions: { hierarchy: 'OS adapter fixture pipeline coverage.', spacing: 'OS adapter fixture pipeline coverage.', clipping: 'OS adapter fixture pipeline coverage.', typography: 'OS adapter fixture pipeline coverage.', controls: 'OS adapter fixture pipeline coverage.', states: 'OS adapter fixture pipeline coverage.' }, defects: [] }] };
  const qualityService = new InspectionQualityService({ store: f.state.store, artifacts: f.state.artifacts, authorityCurrent: () => true });
  const submitted = await qualityService.submit({ authority, quality: f.quality, report });
  assert.deepEqual(submitted.gate.issues, []); assert.equal(submitted.gate.status, 'ready-for-review');
  await f.call('factory_stop', { sessionId: job.sessionId, requestId: 'verifier-stop' });
  await f.poll(jobId, job => job.status === 'succeeded');
  assert.equal(f.launches, 1); assert.equal(f.stops, 1);
  assert.equal(f.coordinator.store.get<{ id: string; deviceId: string }>('attempts', authority.attemptId)!.deviceId, 'linux-author');
  assert.equal(f.author.plugin.taskInspection(authority.taskId).jobs.length, 0, 'Original author history and tool ownership remain separate');
  assert.equal(f.transfers.some(item => item.sender === 'mac-owner' && item.recipient === 'coordinator' && item.manifest.mime === 'image/png'), true);
});

test('coordinator native delegation rejects stale, foreign, mismatched-source and unbound verifier owners before compilation', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof coordinatorVerifierFixture>>) => void]> = [
    ['retired verifier', f => f.state.store.set(INSPECTION_VERIFIER_RUNS, { ...f.verifier, status: 'succeeded' })],
    ['wrong source', f => f.state.store.set(INSPECTION_VERIFIER_RUNS, { ...f.verifier, source: { ...f.source, sha256: 'e'.repeat(64) } })],
    ['wrong candidate', f => f.state.store.set(INSPECTION_VERIFIER_RUNS, { ...f.verifier, source: { ...f.source, candidateCommit: 'e'.repeat(40) } })],
    ['wrong generation', f => f.state.store.set(INSPECTION_VERIFIER_RUNS, { ...f.verifier, authority: { ...authority, authorityGeneration: 7 } })],
    ['changed quality policy', f => f.state.store.set(INSPECTION_VERIFIER_RUNS, { ...f.verifier, policySha256: 'e'.repeat(64) })],
    ['foreign owner device', f => f.state.store.set(INSPECTION_VERIFIER_RUNS, { ...f.verifier, ownerDeviceId: 'linux-author' })],
    ['wrong running chat', f => f.state.store.set('chats', { ...f.verifierChat, verificationRunId: 'other-run' })],
    ['idle chat', f => f.state.store.set('chats', { ...f.verifierChat, status: 'idle' })],
    ['wrong session', f => f.state.store.set('sessions', { ...f.verifierSession, verificationRunId: 'other-run' })],
    ['unowned session', f => f.state.store.set('sessions', { ...f.verifierSession, deviceId: 'linux-author' })],
    ['unknown session', f => f.state.store.set('sessions', { ...f.verifierSession, status: 'unknown' })],
    ['changed final revision', f => { f.state.store.set(INSPECTION_VERIFIER_RUNS, { ...f.verifier, purpose: 'goal-final', goalRevision: 6 }); f.state.store.set('goals', { id: authority.goalId, coordinatorId: 'coordinator', revision: 7 }); }],
    ['coordinator authority retired', f => f.retireCoordinator()],
  ];
  for (const [name, change] of cases) await t.test(name, async inner => {
    const f = await coordinatorVerifierFixture(inner); change(f);
    await assert.rejects(f.call('factory_native_build', { requestId: 'rejected-verifier-build', profileId: profile.id }), /authoriz|current|retired|authority/);
    assert.equal(f.compiled.length, 0); assert.equal(f.launches, 0);
  });
});

test('a lost paired response is recovered by its original operation without repeating native input', async t => {
  const f = await fixture(t), started = await f.start(await f.build());
  const before = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-before' });
  f.loseReply('type');
  const lost = await f.call('factory_native_action', { sessionId: started.sessionId, requestId: 'write-once', observationId: value(before, 'observationId'), action: { kind: 'type', elementId: 'body', text: 'Exactly once', mode: 'replace' } });
  assert.equal(value(lost, 'status'), 'unknown'); assert.equal(f.actions.length, 1);
  const recovered = await f.call('factory_job_status', { jobId: value(lost, 'jobId') });
  assert.ok(value(recovered, 'actionId')); assert.equal(f.actions.length, 1);
  const fresh = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-recovered' });
  assert.equal((value(fresh, 'elements') as Array<{ id: string; value?: string }>).find(item => item.id === 'body')?.value, 'Exactly once');
  await f.call('factory_stop', { sessionId: started.sessionId, requestId: 'stop-recovered' });
});

test('native delegation requires configured paired owners and blocks stale or unauthenticated effects', async t => {
  const f = await fixture(t); f.noProfiles();
  const waiting = await f.call('factory_native_build', { requestId: 'no-profile', profileId: profile.id });
  assert.equal(value(waiting, 'status'), 'waiting'); assert.match(String(value(waiting, 'setupAction')), /Pair a Mac/); assert.equal(f.compiled.length, 0); assert.equal(f.captures, 0);
  const extension = f.owner.app.extensions[0]!;
  await assert.rejects(extension({ method: 'POST', url: new URL('http://paired.invalid/api/inspection/delegated'), body: { op: 'profiles', projectId: 'mail-project' } }), /paired execution/);
  await assert.rejects(extension({ method: 'POST', url: new URL('http://paired.invalid/api/inspection/delegated'), body: { op: 'profiles', projectId: 'mail-project' }, peerId: 'unpaired-device' }), /paired execution/);
  const other = await fixture(t), started = await other.start(await other.build()), observed = await other.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-before' });
  other.retire();
  await assert.rejects(other.call('factory_native_action', { sessionId: started.sessionId, requestId: 'stale-edit', observationId: value(observed, 'observationId'), action: { kind: 'type', elementId: 'body', text: 'Unauthorized', mode: 'replace' } }), /authority|authorized/);
  assert.equal(other.actions.length, 0); assert.equal(other.compiled.length, 1);
});

test('corrupted source transfer is rejected before any paired native build is admitted', async t => {
  const f = await fixture(t); f.corruptSourceTransfer();
  await assert.rejects(f.call('factory_native_build', { requestId: 'corrupt-source', profileId: profile.id }), /hash or size|integrity/);
  assert.equal(f.compiled.length, 0); assert.equal(f.owner.jobs.listJobs().length, 0); assert.equal(f.serviceOperations, 0);
});

test('the Mac revalidates coordinator authority before effects even while the author still considers its attempt current', async t => {
  const f = await fixture(t), started = await f.start(await f.build());
  const observed = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-coordinator' });
  f.retireCoordinator();
  assert.equal(f.author.jobs.authorize(f.token).authority.attemptId, authority.attemptId, 'the author has not yet learned that the coordinator retired the assignment');
  await assert.rejects(f.call('factory_native_action', { sessionId: started.sessionId, requestId: 'retired-coordinator-edit', observationId: value(observed, 'observationId'), action: { kind: 'type', elementId: 'body', text: 'Do not apply', mode: 'replace' } }), /authority|owns|authorized|current/);
  assert.equal(f.actions.length, 0); assert.equal(f.owner.plugin.acceptedAuthorityCurrent(authority), false);
  assert.equal(f.stops, 1); assert.equal(f.sessions.size, 0);
  assert.equal(f.owner.jobs.getJob(started.jobId)?.status, 'canceled'); assert.equal(f.owner.jobs.getSession(started.sessionId)?.status, 'stopped');
  assert.ok(f.owner.jobs.leases(started.jobId).every(item => item.status === 'released'), 'positive coordinator retirement releases resources only after the original backend confirms termination');
  assert.equal(f.owner.jobs.actions(started.sessionId).filter(item => item.kind === 'type').length, 0, 'retired author input never reaches the effect journal or backend');
});

test('unavailable coordinator authority remains unknown and does not retire or release the owned native process', async t => {
  for (const mode of ['network', 'service'] as const) {
    const f = await fixture(t), started = await f.start(await f.build());
    f.coordinatorOffline(mode);
    await f.owner.plugin.reconcileOwnerAuthority();
    assert.equal(f.owner.plugin.acceptedAuthorityCurrent(authority), false);
    assert.equal(f.stops, 0); assert.equal(f.sessions.size, 1);
    assert.equal(f.owner.jobs.getJob(started.jobId)?.status, 'running'); assert.equal(f.owner.jobs.getSession(started.sessionId)?.status, 'ready');
    assert.ok(f.owner.jobs.leases(started.jobId).some(item => item.status === 'held'), `${mode} failure cannot establish positive retirement or native termination`);
  }
});

test('author-local retirement alone cannot retire a native assignment still current at the coordinator', async t => {
  const f = await fixture(t), started = await f.start(await f.build());
  f.retireAuthor();
  assert.throws(() => f.author.jobs.authorize(f.token), /authority/);
  await f.owner.plugin.reconcileOwnerAuthority();
  assert.equal(f.owner.plugin.acceptedAuthorityCurrent(authority), true);
  assert.equal(f.stops, 0); assert.equal(f.sessions.size, 1);
  assert.equal(f.owner.jobs.getSession(started.sessionId)?.status, 'ready');
  assert.ok(f.owner.jobs.leases(started.jobId).some(item => item.status === 'held'));
});

test('positive coordinator retirement stops the original uncertain process without blessing its unknown input outcome', async t => {
  const f = await fixture(t), started = await f.start(await f.build());
  const observed = await f.call('factory_observe', { sessionId: started.sessionId, requestId: 'observe-uncertain' });
  f.loseNativeInput();
  const result = await f.call('factory_native_action', { sessionId: started.sessionId, requestId: 'uncertain-input', observationId: value(observed, 'observationId'), action: { kind: 'type', elementId: 'body', text: 'Outcome unknown', mode: 'replace' } });
  assert.equal(value(result, 'status'), 'unknown'); assert.equal(f.actions.length, 1);
  const originalAction = f.owner.jobs.actions(started.sessionId).find(item => item.kind === 'type'); assert.ok(originalAction); assert.equal(originalAction.status, 'unknown');
  f.retireCoordinator(); await f.owner.plugin.reconcileOwnerAuthority();
  assert.equal(f.stops, 1); assert.equal(f.sessions.size, 0); assert.equal(f.owner.jobs.getJob(started.jobId)?.status, 'canceled');
  assert.equal(f.owner.jobs.actions(started.sessionId).find(item => item.id === originalAction.id)?.status, 'unknown', 'termination proves cleanup, not whether the prior input succeeded');
  assert.equal(f.actions.length, 1); assert.ok(f.owner.jobs.leases(started.jobId).every(item => item.status === 'released'));
});

test('concurrent native status and observation serialize journal imports without regressing current session state', async t => {
  const f = await fixture(t), started = await f.start(await f.build()); f.trackJournalConcurrency();
  const [, observed] = await Promise.all([
    f.call('factory_job_status', { jobId: started.jobId }),
    f.call('factory_observe', { sessionId: started.sessionId, requestId: 'concurrent-observe' }),
  ]);
  assert.equal(f.maxConcurrentJournals, 1, 'one owner/job journal cursor advances through one serialized importer');
  const observationId = String(value(observed, 'observationId')), actionId = String(value(observed, 'actionId'));
  assert.equal(f.author.jobs.getSession(started.sessionId)?.latestObservationId, observationId);
  assert.equal(f.author.jobs.getSession(started.sessionId)?.latestObservationId, f.owner.jobs.getSession(started.sessionId)?.latestObservationId);
  assert.equal(f.author.jobs.actions(started.sessionId).find(item => item.id === actionId)?.status, 'succeeded');
  assert.equal(f.author.store.events<{ kind: string }>('inspection-journal', observationId).filter(event => event.value.kind === 'observation-recorded').length, 1);
  const imports = f.author.store.list<{ id: string; jobId: string; ownerSequence: number }>('inspection-delegation-imported-events').filter(item => item.jobId === started.jobId);
  assert.equal(new Set(imports.map(item => item.ownerSequence)).size, imports.length);
  const cursorId = sha(JSON.stringify(['mac-owner', started.jobId]));
  assert.ok(f.author.store.get<{ id: string; after: number }>('inspection-delegation-journal-cursors', cursorId)!.after >= Math.max(...imports.map(item => item.ownerSequence)));
  await f.call('factory_stop', { sessionId: started.sessionId, requestId: 'stop-concurrent' });
});

test('malformed authenticated owner pages cannot inject foreign events, mismatched records or invalid event order', async t => {
  for (const attack of ['foreign-entity', 'wrong-bucket', 'duplicate-sequence', 'decreasing-sequence'] as const) {
    const f = await fixture(t), started = await f.start(await f.build());
    const source = f.author.jobs.getJob(started.jobId)!.source;
    const unrelated = f.author.jobs.createJob(f.token, { idempotencyKey: 'unrelated-local-work', executionTargetId: 'linux-author:container', capability: 'apple-compilation', source, profile: {} });
    const originalLocalJob = f.author.jobs.getJob(unrelated.id), originalLocalEvents = f.author.store.events('inspection-journal', unrelated.id);
    const originalSession = f.author.jobs.getSession(started.sessionId), originalCursors = f.author.store.list('inspection-delegation-journal-cursors');
    f.tamperNextJournal(page => {
      assert.ok(page.events.length >= 2);
      if (attack === 'foreign-entity') {
        const event = page.events[0]!; event.entity = unrelated.id; event.value.kind = 'session-ready'; delete event.record; delete event.recordArtifact;
      } else if (attack === 'wrong-bucket') {
        const event = page.events.find(item => item.record?.bucket === 'inspection-observations'); assert.ok(event); event.value.kind = 'action-requested';
      } else if (attack === 'duplicate-sequence') page.events.splice(1, 0, structuredClone(page.events[0]!));
      else [page.events[0], page.events[1]] = [page.events[1]!, page.events[0]!];
    });
    await assert.rejects(f.call('factory_observe', { sessionId: started.sessionId, requestId: `observe-${attack}` }), /journal.*(another|matching|sequence)/);
    assert.deepEqual(f.author.jobs.getJob(unrelated.id), originalLocalJob, `${attack} cannot overwrite another local job`);
    assert.deepEqual(f.author.store.events('inspection-journal', unrelated.id), originalLocalEvents, `${attack} cannot append to another local entity's history`);
    assert.deepEqual(f.author.jobs.getSession(started.sessionId), originalSession, `${attack} cannot partially import a rejected page`);
    assert.deepEqual(f.author.store.list('inspection-delegation-journal-cursors'), originalCursors, `${attack} cannot advance the import cursor`);
    await f.call('factory_job_status', { jobId: started.jobId });
    assert.equal(f.author.jobs.getSession(started.sessionId)?.latestObservationId, f.owner.jobs.getSession(started.sessionId)?.latestObservationId, 'a subsequent original page recovers without replaying native observation');
    await f.call('factory_stop', { sessionId: started.sessionId, requestId: `stop-${attack}` });
  }
});

test('protected candidate and integration identities survive delegation while mismatched snapshot identities are rejected', async t => {
  const f = await fixture(t); f.protectCapture(); const jobId = await f.build();
  const ownerSource = f.owner.jobs.getJob(jobId)!.source;
  assert.equal(ownerSource.candidateId, 'protected-candidate'); assert.equal(ownerSource.candidateCommit, 'c'.repeat(40)); assert.equal(ownerSource.checkedCommit, 'd'.repeat(40));
  assert.equal(ownerSource.snapshotId, f.compiled[0]!.id); assert.equal(ownerSource.sha256, f.compiled[0]!.sourceDigest);
  assert.deepEqual(ownerSource.roots, f.compiled[0]!.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })));
  assert.deepEqual(f.author.jobs.getJob(jobId)!.source, ownerSource, 'author quality evidence and paired execution retain the same complete source identity');
  const invalid = await fixture(t); invalid.protectCapture({ sha256: 'e'.repeat(64) });
  await assert.rejects(invalid.call('factory_native_build', { requestId: 'invalid-protected-source', profileId: profile.id }), /protected source identity differs/);
  assert.equal(invalid.compiled.length, 0); assert.equal(invalid.owner.jobs.listJobs().length, 0); assert.equal(invalid.transfers.length, 0);
});
