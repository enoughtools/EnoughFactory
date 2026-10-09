import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import type { HostOperatorRebootTermination, HostProcessState, HostSupervisedTermination } from '@enoughfactory/agents';
import type { AttemptInspection, Chat, ExecutionTargetAdvertisement, FactoryTask, Goal, InspectionAuthority, InspectionSourceIdentity, InspectionVerificationAcceptance, InspectionVerificationRun, Project, Session, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { AttemptDetail } from '@enoughfactory/factory';
import { ArtifactStore, InspectionSnapshotManager, importInspectionSnapshot, type InspectionSnapshot, type InspectionSnapshotTransfer } from '@enoughfactory/workspaces';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext, ChatController, RunOptions } from './chats.ts';
import { InspectionVerifier, INSPECTION_VERIFIER_RUNS, inspectionQualityPolicySha256, inspectionVerificationKey, type InspectionVerifierOptions, type VerificationInput, type VerificationPreparation } from './inspection-verifier.ts';
import { SessionController } from './sessions.ts';
import { Store } from './store.ts';
import type { DelegatedNativeInspectionReadiness } from './inspection-delegation.ts';

const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 12, taskId: 'task', attemptId: 'author-attempt', authorityGeneration: 3, policyRevision: 12 };
const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'close-draft', platform: 'macos' }], referenceIds: ['enough-ui'] };
const frozenAcceptanceTask: NonNullable<AttemptInspection['contract']> = {
  title: 'Preserve complete draft content', description: 'Reopen a saved draft without losing its content.\nRestore the exact original recipient, subject and multiline body after cancellation.',
  kind: 'feature', acceptanceCriteria: ['Reopening restores the exact original recipient, subject and body.', 'Canceling changes restores every original draft field.'],
  expectedOutputs: ['A working native draft editor', 'Original UI workflow and restoration evidence'], estimatedMinutes: 40,
  writePaths: ['apps/mail/DraftEditor.swift'], resources: { cpus: 2, memoryGiB: 3 }, execution: { target: 'host-macos', requiredCapabilities: ['mac-shell'] },
  quality, dependsOn: ['account-storage'], checks: ['sh scripts/check-draft-restoration.sh'], planRevision: 12,
};
const ready: ExecutionTargetAdvertisement[] = [{
  id: 'mac-host', kind: 'host-macos', protocolVersion: 1, readiness: 'ready', runtimes: ['codex'], capacity: 1,
  capabilities: [
    { kind: 'mac-shell', readiness: 'ready' }, { kind: 'apple-compilation', readiness: 'ready' },
    { kind: 'macos-app-inspection', readiness: 'ready' }, { kind: 'ios-simulator-inspection', readiness: 'ready' },
  ],
}];
type ProviderCall = { chatId: string; prompt: string; options: RunOptions };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}
async function eventually(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for verifier ownership transition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Real multi-root source/artifact transfer and SQLite ownership, with provider/OS effects injected. */
async function fixture(t: TestContext, extraFileMode = 0o644) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-independent-verifier-')));
  const dataDir = path.join(directory, 'device'), main = path.join(directory, 'author-main'), design = path.join(directory, 'author-design');
  await mkdir(main); await mkdir(path.join(design, 'empty'), { recursive: true });
  await writeFile(path.join(main, 'Main.swift'), 'let heading = "Baseline"\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=', '-C', main, ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0' },
  }).trim();
  git('init', '--quiet'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Original author baseline');
  const originalCommit = git('rev-parse', 'HEAD');
  await writeFile(path.join(main, 'Main.swift'), 'let heading = "Exact dirty source"\r\n', { mode: 0o640 });
  await chmod(path.join(main, 'Main.swift'), 0o640);
  await writeFile(path.join(main, 'Untracked.swift'), 'let draft = "Untracked captured source"\n');
  await writeFile(path.join(design, 'Tokens.swift'), 'let spacing = 12\n', { mode: extraFileMode });
  await chmod(path.join(design, 'Tokens.swift'), extraFileMode);
  await chmod(path.join(design, 'empty'), 0o750);
  await symlink('Tokens.swift', path.join(design, 'token-link'));
  const store = new Store(dataDir), artifacts = new ArtifactStore(path.join(dataDir, 'workspace-data', 'artifacts'), 'mac');
  const snapshotManager = new InspectionSnapshotManager({ dataDir: path.join(directory, 'checked'), artifacts });
  const snapshot = await snapshotManager.create({ roots: [
    { id: 'primary', name: 'primary', path: main, sourceCommit: originalCommit, kind: 'git', originalPath: '/workspaces/mail', manifestSha256: 'a'.repeat(64) },
    { id: 'enough-ui', name: 'enough-ui', path: design, kind: 'folder', originalPath: '/workspaces/enough-ui', manifestSha256: 'b'.repeat(64) },
  ], context: authority });
  const source: InspectionSourceIdentity = {
    snapshotId: snapshot.id, sha256: snapshot.sourceDigest, candidateId: 'candidate-C', candidateCommit: 'c'.repeat(40), checkedCommit: 'c'.repeat(40),
    roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })),
  };
  const project: Project = { id: 'mail-project', name: 'EnoughMail', path: main, deviceId: 'mac', createdAt: new Date().toISOString(), runtime: 'codex', approvalMode: 'approve-all', rules: [] };
  const goal: Goal = { id: authority.goalId, projectId: project.id, coordinatorId: 'mac', title: 'Build EnoughMail', objective: 'Build the complete EnoughMail client.\nPreserve exact saved draft state.',
    criteria: ['The native client runs and every original draft field survives reopening.'], status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex',
    createdAt: project.createdAt, updatedAt: project.createdAt, revision: authority.goalRevision, concurrency: 1 };
  const detail: AttemptDetail = { id: authority.attemptId, goalId: authority.goalId, goalRevision: authority.goalRevision, assignmentGoalRevision: authority.goalRevision,
    contract: structuredClone(frozenAcceptanceTask), phase: 'checking', cancellation: 'none' };
  store.set('goals', goal); store.set('factory-attempt-details', detail);
  const sessions = new Map<string, Session>(), calls: ProviderCall[] = [], preparations: VerificationPreparation[] = [], stopped: string[] = [], interrupted: string[] = [];
  const preparedSources = new Map<string, InspectionSnapshot>();
  const retiredHostSessions: Array<{ sessionId: string; cwd: string }> = [];
  let current = true, providerMode: 'success' | 'hold' | 'unknown' = 'success', passed = false, available = true;
  let providerPending: ReturnType<typeof deferred<{ text: string }>> | undefined;
  let stopFails = false, checks = 0;
  let hostProcesses: Array<Pick<HostProcessState, 'sessionId' | 'state'> & Partial<HostProcessState>> = [];
  let preparationHook: ((input: VerificationPreparation) => Promise<void>) | undefined;
  const app = {
    dataDir, device: { id: 'mac' }, store, emit() {}, changed() {},
    sessions: {
      record: (id: string) => { const session = store.get<Session>('sessions', id) ?? sessions.get(id); assert.ok(session); return session; },
      owns: (id: string) => sessions.has(id) && store.get<Session>('sessions', id)?.deviceId === 'mac',
      waitExecutionReady: async (id: string) => {
        assert.ok(sessions.has(id));
        assert.equal(store.get<Session>('sessions', id)?.status, 'ready', 'The runtime only dispatches from the current ready session record');
        return { kind: 'host-macos', targetId: 'mac-host', workdir: preparedSources.get(id)!.roots[0]!.path };
      },
      execution: (id: string) => {
        assert.ok(sessions.has(id));
        return { kind: 'host-macos', targetId: 'mac-host', workdir: preparedSources.get(id)!.roots[0]!.path };
      },
      retainedHostExecution: (id: string) => {
        assert.ok(sessions.has(id));
        return { kind: 'host-macos', targetId: 'mac-host', workdir: preparedSources.get(id)!.roots[0]!.path, workspaceId: store.get<Session>('sessions',id)!.verificationRunId };
      },
      stop: async (id: string) => {
        stopped.push(id);
        if (stopFails) throw new Error('Owned verifier process termination could not be confirmed');
        const session = store.get<Session>('sessions', id)!;
        store.set('sessions', { ...session, status: 'stopped' });
      },
      restart: async (id: string) => {
        assert.equal(store.get<Session>('sessions', id)?.status, 'stopped');
        store.set('sessions', { ...store.get<Session>('sessions', id)!, status: 'ready' });
      },
    },
  } as unknown as DeviceApp;
  const chats = {
    isRunning: (chatId: string) => store.get<Chat>('chats', chatId)?.status === 'running',
    manager: {
      hostProcesses: async () => hostProcesses,
      retireHostSession: async (sessionId: string, cwd: string) => { retiredHostSessions.push({ sessionId, cwd }); },
    },
    create: (input: { sessionId: string; verificationRunId?: string; title?: string }) => {
      const at = new Date().toISOString();
      const chat: Chat = { id: 'verifier-chat-' + (store.list<Chat>('chats').length + 1), sessionId: input.sessionId, deviceId: 'mac', runtime: 'codex', approvalMode: 'approve-all', status: 'idle', title: input.title ?? 'Verify', createdAt: at, updatedAt: at, verificationRunId: input.verificationRunId };
      store.set('chats', chat); return chat;
    },
    run: async (chatId: string, prompt: string, options: RunOptions = {}) => {
      calls.push({ chatId, prompt, options });
      const chat = store.get<Chat>('chats', chatId)!; store.set('chats', { ...chat, status: 'running' });
      if (providerMode === 'unknown') throw Object.assign(new Error('Transport disappeared after verifier dispatch'), { agentStarted: true, executionEnded: false });
      try {
        if (providerMode === 'hold') { providerPending = deferred<{ text: string }>(); return await providerPending.promise; }
        return { text: 'Everything looks perfect and every workflow passed.' };
      } finally { store.set('chats', { ...chat, status: 'idle' }); }
    },
    interrupt: async (chatId: string) => {
      interrupted.push(chatId);
      providerPending?.reject(Object.assign(new Error('Verifier transport interrupted after dispatch'), { agentStarted: true, executionEnded: false }));
    },
  } as unknown as ChatController;
  const options: InspectionVerifierOptions = {
    app, chats, authorityCurrent: selected => current && JSON.stringify(selected) === JSON.stringify(authority),
    readiness: async () => available ? ready : [{ ...ready[0]!, readiness: 'setup-required', capabilities: ready[0]!.capabilities.map(item => ({ ...item, readiness: 'setup-required' })) }],
    quality: {
      context: async () => 'Original reference and screenshot evidence context.',
      check: async input => {
        checks++;
        return { command: 'enoughfactory:ui-quality', candidateCommit: input.candidateCommit, checkedCommit: input.checkedCommit, passed, exitCode: passed ? 0 : 1,
          output: passed ? 'Original workflow and image receipts verified.' : 'Current-source screenshot/workflow assertion receipts are missing.',
          ...(!passed ? { recovery: { condition: 'inspection-evidence' as const, reason: 'Missing actual inspection receipts' } } : {}) };
      },
    },
    timeoutMs: 30_000,
    prepareExecution: async input => {
      preparations.push(input); input.assertCurrent();
      const at = new Date().toISOString();
      const session: Session = { id: 'verifier-session-' + (sessions.size + 1), projectId: project.id, deviceId: 'mac', name: 'verification-' + sessions.size,
        status: 'ready', executionTargetKind: input.run.executionTargetKind, executionTargetId: input.run.executionTargetId,
        createdAt: at, updatedAt: at, services: [], workingDirectories: input.snapshot.roots.slice(1).map(root => ({ id: root.id, name: root.name, path: root.path, kind: root.kind, baseCommit: root.commit, status: 'ready' })) };
      sessions.set(session.id, session); preparedSources.set(session.id, input.snapshot); input.onSession(session);
      await preparationHook?.(input);
      return session;
    },
  };
  const verifiers: InspectionVerifier[] = [];
  const verifier = new InspectionVerifier(options); verifiers.push(verifier);
  t.after(async () => { for (const service of verifiers) await service.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const input: VerificationInput = { authority, source, snapshot, quality, project, acceptanceContract: { version: 1, task: structuredClone(detail.contract!) } };
  return {
    directory, dataDir, main, design, store, artifacts, snapshotManager, snapshot, source, originalCommit, input, verifier, options, goal, detail,
    calls, preparations, stopped, interrupted, retiredHostSessions, sessions, checks: () => checks,
    setCurrent: (value: boolean) => { current = value; }, setPassed: (value: boolean) => { passed = value; },
    setAvailable: (value: boolean) => { available = value; }, setProvider: (value: typeof providerMode) => { providerMode = value; },
    setStopFails: (value: boolean) => { stopFails = value; }, setPreparationHook: (hook: typeof preparationHook) => { preparationHook = hook; },
    setHostProcesses: (value: typeof hostProcesses) => { hostProcesses = value; },
    finishProvider: () => { assert.ok(providerPending); providerPending.resolve({ text: 'Provider finished.' }); },
    anotherVerifier: (overrides: Partial<InspectionVerifierOptions> = {}) => { const service = new InspectionVerifier({ ...options, ...overrides }); verifiers.push(service); return service; },
    context(run: InspectionVerificationRun): AgentToolBridgeContext {
      return { chat: store.get<Chat>('chats', run.chatId!)!, session: store.get<Session>('sessions', run.sessionId!)!,
        execution: { kind: run.executionTargetKind, targetId: run.executionTargetId, workdir: preparations.find(item => item.run.id === run.id)!.snapshot.roots[0]!.path },
        attemptId: authority.attemptId, verificationRunId: run.id, signal: new AbortController().signal };
    },
  };
}

/** A different planned quality policy receives an honest corresponding author contract. */
function withFrozenQuality(f: { store: Store; input: VerificationInput }, selected: TaskQualityRequirements): VerificationInput {
  const detail = f.store.get<AttemptDetail>('factory-attempt-details', authority.attemptId)!;
  const contract = { ...detail.contract!, quality: structuredClone(selected) };
  f.store.set('factory-attempt-details', { ...detail, contract });
  return { ...f.input, quality: selected, acceptanceContract: { version: 1, task: contract } };
}

/** Publish the original fixture provider's positive teardown; no OS process is started. */
function settledFixtureProvider(f: Awaited<ReturnType<typeof fixture>>, run: InspectionVerificationRun): void {
  assert.ok(run.startedAt && run.sessionId && run.chatId);
  assert.equal(f.store.get<Chat>('chats', run.chatId)!.status, 'idle');
  assert.equal(f.store.get<Session>('sessions', run.sessionId)!.status, 'stopped');
  const cwd = f.preparations.find(item => item.run.id === run.id)!.snapshot.roots[0]!.path;
  const observedAt = new Date().toISOString(), processKey = `provider-${run.id}`, recordPath = `/owned/${processKey}.json`;
  const proof: HostSupervisedTermination = { schemaVersion: 2, kind: 'supervised-termination', evidence: 'complete-owned-teardown', observedAt,
    currentBoot: { schemaVersion: 1, platform: 'darwin', machineId: 'a'.repeat(64), bootId: '11111111-1111-4111-8111-111111111111', startedAt: observedAt, observedAt, uptimeMs: 1000 },
    previousStatus: 'exited', previousUpdatedAt: observedAt, priorRecordSha256: 'b'.repeat(64), processKey, sessionId: run.sessionId, cwd, inventoryComplete: true,
    supervisor: { pid: 1337, path: recordPath.replace(/\.json$/, '.cjs'), identity: `Original supervisor ${recordPath.replace(/\.json$/, '.cjs')} ${processKey}` },
    children: [], exitCode: null, exitSignal: 'SIGKILL' };
  f.setHostProcesses([{ processKey, recordPath, sessionId: run.sessionId, pid: 1337, cwd, createdAt: run.startedAt, state: 'exited', termination: proof }]);
  // These provider-only fixtures contain no native/browser inspection jobs.
  f.options.reconcileInspection = async original => original.id === run.id;
}

/** Real native ownership/capture/disposal without starting any provider, GUI or Docker process. */
async function nativeFixture(t: TestContext) {
  const f = await fixture(t, 0o640), forbiddenCalls: string[] = [];
  const sessions = new SessionController(f.store, 'mac', () => {}, () => {}, {
    endpoint: { host: 'unix:///unused-verifier-fixture.sock', configDirectory: path.join(f.directory, 'runtime', 'docker'), cliPath: '/must-not-run-docker' },
    ensureReady: async () => { forbiddenCalls.push('container runtime'); throw new Error('Native verification must not start a container'); },
    bridgeHostAddress: () => undefined,
  }, path.join(f.dataDir, 'workspace-data'));
  Object.defineProperty(sessions, 'engine', { value: new Proxy({}, {
    get(_target, method) { return () => { forbiddenCalls.push(`envmux.${String(method)}`); throw new Error('Native verification must not use envmux'); }; },
  }) });
  f.store.set('projects', f.input.project);
  const verifier = f.anotherVerifier({ app: { ...f.options.app, sessions } as DeviceApp, prepareExecution: undefined });
  t.after(() => { sessions.close(); assert.deepEqual(forbiddenCalls, []); });
  return { ...f, sessions, verifier, forbiddenCalls };
}

/** Guard-only container fixture. Real CAS/frozen roots replace the Docker exporter,
 * whose byte transfer is covered separately; provider and archive lifecycle are fake. */
async function legacyContainerFixture(t: TestContext, seed: 'waiting' | 'unknown', state: 'ready' | 'stopped' = 'stopped') {
  const f = await fixture(t), restarted: string[] = [];
  const quality: TaskQualityRequirements = { platforms: ['web'], workflows: [{ id: 'open-inbox', platform: 'web' }], referenceIds: ['enough-mail-web'] };
  const input: VerificationInput = withFrozenQuality(f, quality);
  const target: ExecutionTargetAdvertisement = { id: 'private-container', kind: 'container', protocolVersion: 1, readiness: 'ready', runtimes: ['codex'], capabilities: [{ kind: 'linux-shell', readiness: 'ready' }, { kind: 'chromium-inspection', readiness: 'ready' }] };
  let lease = false, sourceChecks = 0;
  const fakeSessions = {
    ...f.options.app.sessions,
    execution: (_id: string) => ({ kind: 'container' as const, targetId: target.id, containerId: 'legacy-container', workdir: '/workspaces/primary' }),
    waitExecutionReady: async (id: string) => {
      assert.equal(f.store.get<Session>('sessions', id)?.status, 'ready', 'A stopped container record cannot execute work');
      return { kind: 'container' as const, targetId: target.id, containerId: 'legacy-container', workdir: '/workspaces/primary' };
    },
    archivedEnvironment: (id: string) => f.store.get('session-container-retirement', id),
    canRetireEnvironment: (id: string) => f.options.app.sessions.owns(id) && f.store.get<Session>('sessions', id)?.status === 'stopped',
    withStoppedInputs: async <T>(id: string, operation: () => Promise<T>): Promise<T> => {
      assert.equal(lease, false); assert.equal(f.store.get<Session>('sessions', id)!.status, 'stopped');
      assert.equal(f.options.app.sessions.owns(id), true); lease = true;
      try { return await operation(); } finally { lease = false; }
    },
    restart: async (id: string) => {
      assert.equal(lease, false, 'Execution restarts after the reconciliation lease ends');
      restarted.push(id); f.store.set('sessions', { ...f.store.get<Session>('sessions', id)!, status: 'ready' });
    },
  };
  const verifier = f.anotherVerifier({
    app: { ...f.options.app, sessions: fakeSessions } as unknown as DeviceApp, readiness: async () => [target],
    reconcileInspection: async () => true,
    prepareExecution: async preparation => {
      const prepared = await f.options.prepareExecution!(preparation);
      const session = { ...prepared, status: state, executionTargetKind: undefined, containerId: 'legacy-container' } as Session;
      f.store.set('sessions', session);
      preparation.onSession(session);
      if (state === 'stopped') f.store.set('session-container-retirement', { id: session.id, containerId: 'e'.repeat(64), name: 'legacy-container', status: 'removed', receipt: { version: 2, status: 'removed', containerId: 'e'.repeat(64), identity: { sessionId: session.id, name: 'legacy-container', sessionName: session.name } }, archive: path.join(f.directory, 'retained-container.tar'), updatedAt: new Date().toISOString() });
      throw seed === 'waiting'
        ? Object.assign(new Error('Independent source export is temporarily unavailable'), { agentStarted: false, executionEnded: true })
        : Object.assign(new Error('The independent setup owner changed.'), { code: 'HOST_PROCESS_UNKNOWN' });
    },
  });
  // Explicitly narrow seam: exercise production guard/reconciliation and verify
  // the genuine retained snapshot/CAS rather than invoke an actual Docker daemon.
  (verifier as unknown as { assertExecutionSource: (sessionId: string, snapshot: InspectionSnapshot, signal: AbortSignal) => Promise<void> }).assertExecutionSource = async (sessionId, snapshot, signal) => {
    sourceChecks++;
    const session = f.store.get<Session>('sessions', sessionId)!;
    assert.equal(session.verificationRunId, inspectionVerificationKey(input));
    assert.equal(session.deviceId, 'mac'); assert.equal(session.executionTargetKind ?? 'container', 'container');
    assert.deepEqual(session.workingDirectories!.map(root => ({ id: root.id, path: root.path })), snapshot.roots.slice(1).map(root => ({ id: root.id, path: root.path })));
    await new InspectionSnapshotManager({ dataDir: path.dirname(path.dirname(snapshot.path)) }).verify(snapshot, signal);
    const saved = retained(f, f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, inspectionVerificationKey(input))!);
    for (const artifact of [saved.transfer.sourceManifest, ...saved.transfer.sourceArtifacts.map(root => root.manifest)]) await f.artifacts.path(artifact);
  };
  const run = await verifier.ensure(input);
  assert.equal(run.status, seed === 'waiting' ? 'waiting' : 'unknown'); assert.equal(f.calls.length, 0);
  return { ...f, verifier, input, run, containerSessions: fakeSessions, restarted, sourceChecks: () => sourceChecks };
}

const linuxReviewer: ExecutionTargetAdvertisement = { id: 'private-linux', kind: 'container', protocolVersion: 1, readiness: 'ready', runtimes: ['codex'], capabilities: [{ kind: 'linux-shell', readiness: 'ready' }] };
const pairedMac: DelegatedNativeInspectionReadiness = { deviceId: 'paired-mac', name: 'Paired Mac', executionTargets: ready, profiles: [{ id: 'isolated-mac-app', platform: 'macos' }] };

/** Real retained source and verifier lifecycle; no provider/OS/peer effects are started. */
async function pairedVerifierFixture(t: TestContext, quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'close-draft', platform: 'macos' }], referenceIds: ['enough-ui'] }, overrides: Partial<InspectionVerifierOptions> = {}) {
  const f = await fixture(t);
  let localTargets: ExecutionTargetAdvertisement[] = [linuxReviewer];
  let pairedTargets: DelegatedNativeInspectionReadiness[] = [structuredClone(pairedMac)];
  const projectQueries: string[] = [];
  const verifier = f.anotherVerifier({ readiness: async () => localTargets, delegatedReadiness: async projectId => { projectQueries.push(projectId); return pairedTargets; }, ...overrides });
  return { ...f, verifier, input: withFrozenQuality(f, quality), projectQueries,
    local: (targets: ExecutionTargetAdvertisement[]) => { localTargets = targets; }, paired: (targets: DelegatedNativeInspectionReadiness[]) => { pairedTargets = targets; } };
}

test('a native-only verifier can inspect retained source from Linux through a project-scoped paired native capability contract', async t => {
  const f = await pairedVerifierFixture(t);
  const run = await f.verifier.ensure(f.input);
  assert.equal(run.executionTargetKind, 'container'); assert.equal(run.executionTargetId, linuxReviewer.id);
  assert.equal(run.status, 'failed', 'Peer readiness and a provider success claim do not replace original workflow/image receipts');
  assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1);
  assert.deepEqual(f.projectQueries, [f.input.project.id]);
  assert.deepEqual(run.authority, authority); assert.deepEqual(run.source, f.source);
  assert.deepEqual(f.preparations[0]!.snapshot.roots.map(root => root.id), f.snapshot.roots.map(root => root.id));
  assert.match(f.calls[0]!.prompt, /factory_native_build/); assert.match(f.calls[0]!.prompt, /assertionEvidenceId/);
});

test('paired native verifier admission retains source and waits for an actual compatible profile and same-owner tools', async t => {
  const cases: Array<[string, (owner: DelegatedNativeInspectionReadiness) => DelegatedNativeInspectionReadiness[]]> = [
    ['offline or no authenticated peer', () => []],
    ['profile discovery unavailable', owner => [{ ...owner, profiles: [] }]],
    ['profile for the wrong platform', owner => [{ ...owner, profiles: [{ id: 'ios-only', platform: 'ios-simulator' }] }]],
    ['Mac locked', owner => [{ ...owner, executionTargets: ready.map(target => ({ ...target, capabilities: target.capabilities.map(item => item.kind === 'macos-app-inspection' ? { ...item, readiness: 'setup-required' as const, reason: 'Unlock the paired Mac.' } : item) })) }]],
    ['old native protocol', owner => [{ ...owner, executionTargets: ready.map(target => ({ ...target, protocolVersion: 0 as 1 })) }]],
    ['native target offline', owner => [{ ...owner, executionTargets: ready.map(target => ({ ...target, readiness: 'offline' as const })) }]],
    ['build and interaction split between owners', owner => [
      { ...owner, executionTargets: ready.map(target => ({ ...target, capabilities: target.capabilities.filter(item => item.kind !== 'apple-compilation') })) },
      { ...owner, deviceId: 'other-mac', executionTargets: ready.map(target => ({ ...target, capabilities: target.capabilities.filter(item => item.kind !== 'macos-app-inspection') })) },
    ]],
  ];
  for (const [name, unavailable] of cases) await t.test(name, async inner => {
    const f = await pairedVerifierFixture(inner); f.paired(unavailable(structuredClone(pairedMac)));
    const waiting = await f.verifier.ensure(f.input);
    assert.equal(waiting.status, 'waiting'); assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 0);
    assert.deepEqual(waiting.source, f.source); assert.deepEqual(waiting.authority, authority);
    const saved = retained(f, waiting);
    await f.artifacts.path(saved.transfer.sourceManifest);
    for (const root of saved.transfer.sourceArtifacts) await f.artifacts.path(root.manifest);
    f.paired([structuredClone(pairedMac)]);
    const resumed = await f.verifier.ensure(f.input);
    assert.equal(resumed.id, waiting.id); assert.equal(resumed.executionTargetKind, 'container');
    assert.equal(resumed.status, 'failed'); assert.equal(f.calls.length, 1);
    assert.deepEqual(resumed.source, waiting.source); assert.deepEqual(resumed.authority, waiting.authority);
  });
});

test('first native profile setup admits a source-only Linux verifier only through an explicit service option', async t => {
  for (const enabled of [false, true]) await t.test(`setup ${enabled ? 'enabled' : 'disabled'}`, async inner => {
    const f = await pairedVerifierFixture(inner, quality, { allowNativeProfileSetup: enabled });
    f.paired([{ ...pairedMac, profiles: [] }]);
    const run = await f.verifier.ensure(f.input);
    assert.deepEqual(run.source, f.source); assert.deepEqual(run.authority, authority);
    await f.artifacts.path(retained(f, run).transfer.sourceManifest);
    if (!enabled) {
      assert.equal(run.status, 'waiting'); assert.match(run.reason!, /isolated testing profile/);
      assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 0); assert.equal(run.chatId, undefined);
    } else {
      assert.equal(run.executionTargetKind, 'container'); assert.equal(run.executionTargetId, linuxReviewer.id);
      assert.equal(run.status, 'failed', 'Source-only setup admission cannot manufacture runtime or quality evidence');
      assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1); assert.equal(f.checks(), 1);
      assert.equal(f.calls[0]!.options.verificationRunId, run.id); assert.equal(f.calls[0]!.options.attemptId, authority.attemptId);
      assert.equal(f.store.get<Chat>('chats', run.chatId!)!.attemptId, undefined, 'The ended author is not replaced or resumed');
    }
  });
});

test('source-only native profile setup still requires real paired platform tools and a ready Codex reviewer', async t => {
  const owner = { ...pairedMac, profiles: [] };
  const targetsWithout = (capability: string) => ready.map(target => ({ ...target, capabilities: target.capabilities.filter(item => item.kind !== capability) }));
  const cases: Array<{ name: string; owners: DelegatedNativeInspectionReadiness[]; local?: ExecutionTargetAdvertisement[]; quality?: TaskQualityRequirements }> = [
    { name: 'no online authenticated owner', owners: [] },
    { name: 'Apple compilation unavailable', owners: [{ ...owner, executionTargets: targetsWithout('apple-compilation') }] },
    { name: 'Mac interaction unavailable', owners: [{ ...owner, executionTargets: targetsWithout('macos-app-inspection') }] },
    { name: 'build and interaction split between owners', owners: [{ ...owner, executionTargets: targetsWithout('apple-compilation') }, { ...owner, deviceId: 'other-mac', executionTargets: targetsWithout('macos-app-inspection') }] },
    { name: 'local reviewer has no Codex runtime', owners: [owner], local: [{ ...linuxReviewer, runtimes: ['claude'] }] },
    { name: 'local reviewer has no Linux shell', owners: [owner], local: [{ ...linuxReviewer, capabilities: [] }] },
    { name: 'mixed web workflow has no browser', owners: [owner], quality: { ...quality, platforms: ['macos', 'web'], workflows: [...quality.workflows, { id: 'open-web', platform: 'web' }] } },
    { name: 'requested Simulator capability unavailable', owners: [{ ...owner, executionTargets: targetsWithout('ios-simulator-inspection') }], quality: { ...quality, platforms: ['macos', 'ios-simulator'], workflows: [...quality.workflows, { id: 'close-ios', platform: 'ios-simulator' }] } },
  ];
  for (const { name, owners, local, quality: selectedQuality } of cases) await t.test(name, async inner => {
    const f = await pairedVerifierFixture(inner, selectedQuality ?? quality, { allowNativeProfileSetup: true });
    f.paired(owners); if (local) f.local(local);
    const waiting = await f.verifier.ensure(f.input);
    assert.equal(waiting.status, 'waiting'); assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 0);
    assert.deepEqual(waiting.source, f.source); assert.deepEqual(waiting.authority, authority);
    await f.artifacts.path(retained(f, waiting).transfer.sourceManifest);
  });
});

test('mixed web and native verification requires local browser tools plus paired profiles for every native platform', async t => {
  const mixed: TaskQualityRequirements = { platforms: ['web', 'macos', 'ios-simulator'], workflows: [{ id: 'open-web', platform: 'web' }, { id: 'close-mac', platform: 'macos' }, { id: 'close-ios', platform: 'ios-simulator' }], referenceIds: ['enough-ui'] };
  const f = await pairedVerifierFixture(t, mixed);
  f.paired([{ ...pairedMac, profiles: [...pairedMac.profiles, { id: 'isolated-ios-app', platform: 'ios-simulator' }] }]);
  const noBrowser = await f.verifier.ensure(f.input);
  assert.equal(noBrowser.status, 'waiting'); assert.equal(f.calls.length, 0);
  f.local([{ ...linuxReviewer, capabilities: [...linuxReviewer.capabilities, { kind: 'chromium-inspection', readiness: 'ready' }] }]);
  f.paired([pairedMac]);
  const noIOSProfile = await f.verifier.ensure(f.input);
  assert.equal(noIOSProfile.status, 'waiting'); assert.equal(f.calls.length, 0);
  f.paired([{ ...pairedMac, profiles: [...pairedMac.profiles, { id: 'isolated-ios-app', platform: 'ios-simulator' }] }]);
  const admitted = await f.verifier.ensure(f.input);
  assert.equal(admitted.executionTargetKind, 'container'); assert.equal(admitted.status, 'failed'); assert.equal(f.calls.length, 1);
});

test('paired tools never move a retained native verifier into a replacement container', async t => {
  const f = await pairedVerifierFixture(t); f.local(ready);
  f.setPreparationHook(async () => { throw Object.assign(new Error('Source preparation temporarily unavailable'), { agentStarted: false, executionEnded: true }); });
  const original = await f.verifier.ensure(f.input);
  assert.equal(original.status, 'waiting'); assert.equal(original.executionTargetKind, 'host-macos'); assert.ok(original.sessionId);
  f.setPreparationHook(undefined); f.local([linuxReviewer]);
  const waiting = await f.verifier.ensure(f.input);
  assert.equal(waiting.status, 'waiting'); assert.equal(waiting.executionTargetKind, 'host-macos'); assert.equal(waiting.sessionId, original.sessionId);
  assert.equal(f.preparations.length, 1); assert.equal(f.calls.length, 0);
});

async function unusedContainerChatFixture(t: TestContext) {
  const f = await legacyContainerFixture(t, 'unknown');
  const chat = f.options.chats.create({ sessionId: f.run.sessionId!, runtime: 'codex', approvalMode: 'approve-all', verificationRunId: f.run.id });
  const run = { ...f.run, chatId: chat.id, startedAt: new Date().toISOString() };
  f.store.set(INSPECTION_VERIFIER_RUNS, run); f.setPassed(true);
  return { ...f, run, chat };
}

test('a legacy synchronous admission failure reuses its unused reserved chat only after original container removal', async t => {
  const f = await unusedContainerChatFixture(t), before = structuredClone(f.run);
  assert.equal(f.store.events('chat', f.chat.id).length, 0);
  const result = await f.verifier.ensure(f.input);
  assert.equal(result.status, 'succeeded'); assert.equal(result.id, f.run.id); assert.equal(result.chatId, f.chat.id);
  assert.equal(result.sessionId, f.run.sessionId); assert.deepEqual(result.source, f.run.source); assert.equal(result.startedAt, f.run.startedAt);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.chatId, f.chat.id); assert.equal(f.store.list<Chat>('chats').length, 1);
  assert.deepEqual(f.restarted, [f.run.sessionId]);
  const audit = f.store.events<{ action: string; previous: InspectionVerificationRun; providerAdmission: string }>('inspection-verifier-reconciliation', f.run.id);
  assert.equal(audit.length, 1); assert.equal(audit[0]!.value.action, 'unused-container-verifier-chat');
  assert.equal(audit[0]!.value.providerAdmission, 'no-journaled-turn'); assert.deepEqual(audit[0]!.value.previous, before);
});

test('reserved container chat recovery rejects any durable indication of provider admission or unresolved ownership', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof unusedContainerChatFixture>>) => void]> = [
    ['durable user admission event', f => { f.store.append('chat', f.chat.id, { kind: 'message', role: 'user', text: 'Verification input' }); }],
    ['provider status event', f => { f.store.append('chat', f.chat.id, { kind: 'status', data: { status: 'running', threadId: 'provider-thread' } }); }],
    ['provider result receipt', f => { f.store.set('chat-results', { id: f.chat.id, result: { text: 'Provider finished' } }); }],
    ['provider failure receipt', f => { f.store.set('chat-turn-failures', { id: f.chat.id, agentStarted: true, executionEnded: false }); }],
    ['provider conversation identity', f => { f.store.set('chats', { ...f.chat, threadId: 'provider-thread' }); }],
    ['interrupted chat may have executed', f => { f.store.set('chats', { ...f.chat, status: 'interrupted' }); }],
    ['removed-container receipt absent', f => { f.store.delete('session-container-retirement', f.run.sessionId!); }],
    ['another chat owns this session', f => { f.store.set('chats', { ...f.chat, id: 'another-chat' }); }],
    ['source or task authority changed', f => f.setCurrent(false)],
  ];
  for (const [label, mutate] of cases) await t.test(label, async inner => {
    const f = await unusedContainerChatFixture(inner); mutate(f);
    const before = f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, f.run.id)!;
    assert.deepEqual(await f.verifier.ensure(f.input), before); assert.equal(f.calls.length, 0); assert.deepEqual(f.restarted, []);
    assert.equal(f.store.events('inspection-verifier-reconciliation', f.run.id).length, 0);
  });
});

test('a synchronous chat guard rejection is a waiting setup owner and never an unknown dispatched provider', async t => {
  const f = await fixture(t), originalRun = f.options.chats.run;
  f.options.chats.run = () => { throw Object.assign(new Error('Verifier admission guard rejected before any user event.'), { code: 'INSPECTION_VERIFICATION_STALE' }); };
  const waiting = await f.verifier.ensure(f.input);
  assert.equal(waiting.status, 'waiting'); assert.ok(waiting.chatId); assert.equal(f.calls.length, 0);
  assert.equal(f.store.events('chat', waiting.chatId!).length, 0);
  f.options.chats.run = originalRun; f.setPassed(true);
  const result = await f.verifier.ensure(f.input);
  assert.equal(result.status, 'succeeded'); assert.equal(result.chatId, waiting.chatId); assert.equal(result.sessionId, waiting.sessionId);
  assert.equal(f.calls.length, 1); assert.equal(f.store.list<Chat>('chats').length, 1);
});

type RetainedInputs = { id: string; transfer: InspectionSnapshotTransfer; snapshot?: InspectionSnapshot; retiredAt?: string; retirement?: { primarySource?: InspectionSnapshotTransfer; [key: string]: unknown } };
function retained(f: { store: Store }, run: InspectionVerificationRun): RetainedInputs {
  const inputs = f.store.get<RetainedInputs>('inspection-verifier-inputs', run.id); assert.ok(inputs); return inputs;
}
async function absent(filename: string): Promise<void> { await assert.rejects(lstat(filename), { code: 'ENOENT' }); }

test('verifier identity and quality policy hashes survive durable JSON omission of undefined optional fields', () => {
  const optionalQuality = { ...quality, optionalEvaluation: undefined, workflows: quality.workflows.map(workflow => ({ ...workflow, optionalGuidance: undefined })) };
  const input = {
    authority,
    source: { snapshotId: 'saved-snapshot', sha256: '1'.repeat(64), roots: [{ id: 'primary', sha256: '2'.repeat(64), commit: undefined }] },
    quality: optionalQuality,
  };
  const persisted = JSON.parse(JSON.stringify(input)) as typeof input;
  assert.equal(inspectionVerificationKey(input), inspectionVerificationKey(persisted));
  assert.equal(inspectionQualityPolicySha256(input.quality), inspectionQualityPolicySha256(persisted.quality));
  assert.notEqual(inspectionQualityPolicySha256(input.quality), inspectionQualityPolicySha256({ ...persisted.quality, referenceIds: ['different-required-reference'] }));
});

test('final goal verification has a distinct owner from task review and from another canonical goal revision', () => {
  const input = { authority, quality, source: { snapshotId: 'checked-source', sha256: '1'.repeat(64), roots: [{ id: 'primary', sha256: '2'.repeat(64) }] } };
  const taskKey = inspectionVerificationKey(input);
  assert.equal(inspectionVerificationKey({ ...input, purpose: 'task' }), taskKey);
  const finalKey = inspectionVerificationKey({ ...input, purpose: 'goal-final', goalRevision: 41 });
  assert.notEqual(finalKey, taskKey);
  assert.notEqual(inspectionVerificationKey({ ...input, purpose: 'goal-final', goalRevision: 42 }), finalKey);
  assert.equal(inspectionVerificationKey(JSON.parse(JSON.stringify({ ...input, purpose: 'goal-final', goalRevision: 41 }))), finalKey);
});

test('final verification requires a valid canonical goal revision before retaining or dispatching any owner', async t => {
  const f = await fixture(t);
  for (const goalRevision of [undefined, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => f.verifier.ensure({ ...f.input, purpose: 'goal-final', goalRevision }), /current canonical goal revision/);
  }
  assert.throws(() => f.verifier.ensure({ ...f.input, purpose: 'task', goalRevision: 41 }), /frozen author assignment revision/);
  assert.deepEqual(f.store.list(INSPECTION_VERIFIER_RUNS), []);
  assert.deepEqual(f.store.list('inspection-verifier-inputs'), []);
  assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 0);
});

function promptedAcceptance(prompt: string): InspectionVerificationAcceptance {
  const projection = prompt.split('Frozen authoritative acceptance contract (complete):')[1];
  assert.ok(projection, 'The independent verifier must receive the full frozen acceptance contract');
  return JSON.parse(projection.split('\n\n')[0]!.trim()) as InspectionVerificationAcceptance;
}

test('independent acceptance retains the full frozen author contract instead of a weaker mutable task', async t => {
  const f = await fixture(t); f.setPassed(true);
  const mutableTask: FactoryTask = { id: authority.taskId, goalId: authority.goalId, title: 'Just launch the app', description: 'Open one screen', dependsOn: [],
    acceptanceCriteria: ['One screenshot exists'], expectedOutputs: ['A screenshot'], quality: { ...quality, workflows: [] }, status: 'review', currentAttemptId: authority.attemptId,
    createdAt: f.goal.createdAt, updatedAt: f.goal.updatedAt };
  f.store.set('tasks', mutableTask);
  const run = await f.verifier.ensure({ ...f.input, acceptanceContract: undefined });
  assert.equal(run.status, 'succeeded'); assert.deepEqual(run.acceptanceContract, f.input.acceptanceContract);
  assert.deepEqual(promptedAcceptance(f.calls[0]!.prompt), f.input.acceptanceContract);
  assert.deepEqual(run.acceptanceContract!.task, f.detail.contract);
  assert.equal(run.acceptanceContract!.task.description, frozenAcceptanceTask.description, 'Multiline restoration requirements cannot be shortened into workflow names');
  assert.deepEqual(run.acceptanceContract!.task.acceptanceCriteria, frozenAcceptanceTask.acceptanceCriteria);
  assert.deepEqual(run.acceptanceContract!.task.expectedOutputs, frozenAcceptanceTask.expectedOutputs);
  assert.match(f.calls[0]!.prompt, /valueEquals/, 'Exact draft restoration requires an exact observed value assertion');
  assert.deepEqual(f.store.get<AttemptDetail>('factory-attempt-details', authority.attemptId), f.detail);
  assert.deepEqual(f.store.get<FactoryTask>('tasks', authority.taskId), mutableTask);
});

test('acceptance verification rejects missing or stale frozen contracts and caller substitutions before retaining an owner', async t => {
  for (const change of ['missing-detail', 'missing-contract', 'missing-quality', 'wrong-goal', 'wrong-assignment', 'substituted-projection', 'forged-quality'] as const) await t.test(change, async inner => {
    const f = await fixture(inner);
    let input = f.input;
    if (change === 'missing-detail') f.store.delete('factory-attempt-details', authority.attemptId);
    else if (change === 'missing-contract') f.store.set('factory-attempt-details', { ...f.detail, contract: undefined });
    else if (change === 'missing-quality') {
      const contract = { ...f.detail.contract!, quality: undefined };
      f.store.set('factory-attempt-details', { ...f.detail, contract });
      input = { ...f.input, acceptanceContract: { version: 1, task: contract } };
    }
    else if (change === 'wrong-goal') f.store.set('factory-attempt-details', { ...f.detail, goalId: 'another-goal' });
    else if (change === 'wrong-assignment') f.store.set('factory-attempt-details', { ...f.detail, assignmentGoalRevision: authority.goalRevision + 1 });
    else if (change === 'forged-quality') input = { ...f.input, quality: { ...quality, workflows: [] } };
    else input = { ...f.input, acceptanceContract: { version: 1, task: { ...f.detail.contract!, acceptanceCriteria: ['A screenshot exists'], description: 'Only launch the app' } } };
    assert.throws(() => f.verifier.ensure(input), /frozen|contract|assignment|authority|acceptance/i);
    assert.deepEqual(f.store.list(INSPECTION_VERIFIER_RUNS), []); assert.deepEqual(f.store.list('inspection-verifier-inputs'), []);
    assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 0);
  });
});

test('final acceptance derives the complete current goal objective and criteria separately from frozen author revision', async t => {
  const f = await fixture(t); f.setPassed(true);
  const goal = { ...f.goal, revision: 41, objective: 'Build the entire current EnoughMail client.\nDeliver native compose, reply and draft restoration.',
    criteria: ['Every current mail feature has a working native equivalent.', 'Canceling an edited draft restores the exact original recipient, subject and multiline body.'] };
  f.store.set('goals', goal);
  const aggregateQuality: TaskQualityRequirements = { ...quality, referenceIds: [...quality.referenceIds, 'enough-mail-web'], workflows: [...quality.workflows, { id: 'reply-reopen-current-delivery', platform: 'macos' }] };
  const run = await f.verifier.ensure({ ...f.input, purpose: 'goal-final', goalRevision: goal.revision, quality: aggregateQuality, acceptanceContract: undefined });
  const expected: InspectionVerificationAcceptance = { version: 1, task: f.detail.contract!, goal: { revision: goal.revision, objective: goal.objective, criteria: goal.criteria, taskContracts: [] } };
  assert.equal(run.status, 'succeeded'); assert.equal(run.authority.goalRevision, 12); assert.equal(run.goalRevision, 41);
  assert.deepEqual(run.acceptanceContract, expected); assert.deepEqual(promptedAcceptance(f.calls[0]!.prompt), expected);
  assert.deepEqual(run.quality, aggregateQuality); assert.deepEqual(run.acceptanceContract!.task.quality, quality, 'Final aggregate quality remains distinct from the original author contract');
  assert.deepEqual(f.store.get<AttemptDetail>('factory-attempt-details', authority.attemptId), f.detail);
});

test('changing frozen acceptance during asynchronous verifier preparation fences provider admission', async t => {
  const f = await fixture(t); f.setPassed(true);
  const entered = deferred<void>(), release = deferred<void>();
  f.setPreparationHook(async () => { entered.resolve(); await release.promise; });
  const result = f.verifier.ensure(f.input); await entered.promise;
  const strengthened = { ...f.detail, contract: { ...f.detail.contract!, acceptanceCriteria: [...f.detail.contract!.acceptanceCriteria!, 'Draft restoration also preserves every attachment.'] } };
  f.store.set('factory-attempt-details', strengthened); release.resolve();
  const run = await result;
  assert.equal(run.status, 'waiting'); assert.match(run.reason!, /acceptance|contract|retired|changed/i);
  assert.equal(f.calls.length, 0); assert.equal(f.checks(), 0);
  assert.deepEqual(run.acceptanceContract, f.input.acceptanceContract, 'The old verifier record keeps the requirements it actually owned');
  assert.deepEqual(f.store.get<AttemptDetail>('factory-attempt-details', authority.attemptId), strengthened);
});

test('changing current final goal criteria fences an admitted verifier without rewriting its original acceptance', async t => {
  const f = await fixture(t); f.setProvider('hold'); f.setPassed(true);
  const goal = { ...f.goal, revision: 41, criteria: ['All original native acceptance criteria pass'] }; f.store.set('goals', goal);
  const input = { ...f.input, purpose: 'goal-final' as const, goalRevision: goal.revision, acceptanceContract: undefined };
  const result = f.verifier.ensure(input); await eventually(() => f.calls.length === 1);
  const running = f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)[0]!;
  assert.ok(await f.verifier.verificationSource(f.context(running)));
  f.store.set('goals', { ...goal, criteria: [...goal.criteria, 'Every reopened draft retains original attachments'] });
  await assert.rejects(f.verifier.verificationSource(f.context(running)), /acceptance|contract|changed|retired/i);
  f.finishProvider(); const fenced = await result;
  assert.equal(fenced.status, 'failed'); assert.equal(f.checks(), 0);
  assert.deepEqual(fenced.acceptanceContract!.goal!.criteria, goal.criteria);
});

test('acceptance-bound identity preserves the old unbound key and never promotes a legacy completed review', async t => {
  const f = await fixture(t); f.setPassed(true);
  const legacyInput = { ...f.input, acceptanceContract: undefined }, legacyKey = inspectionVerificationKey(legacyInput);
  // The production key canonicalizes object keys; removing the optional projection
  // must reproduce the original identifier rather than silently reclassify history.
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
    ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
  const originalKey = 'verify-' + createHash('sha256').update(canonical({ version: 1, authority, source: { sha256: f.source.sha256,
    roots: (f.source.roots ?? []).map(({ id, sha256 }) => ({ id, sha256 })).sort((a, b) => a.id.localeCompare(b.id)) }, quality })).digest('hex');
  assert.equal(legacyKey, originalKey);
  const boundKey = inspectionVerificationKey(f.input); assert.notEqual(boundKey, legacyKey);
  const at = new Date().toISOString(), legacy: InspectionVerificationRun = { id: legacyKey, authority, source: f.source, quality, policySha256: inspectionQualityPolicySha256(quality),
    ownerDeviceId: 'mac', executionTargetKind: 'host-macos', executionTargetId: 'mac-host', status: 'succeeded', createdAt: at, updatedAt: at, completedAt: at, deadlineAt: at };
  f.store.set(INSPECTION_VERIFIER_RUNS, legacy);
  const run = await f.verifier.ensure(legacyInput);
  assert.equal(run.id, boundKey); assert.equal(run.status, 'succeeded'); assert.equal(f.calls.length, 1);
  assert.deepEqual(f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, legacyKey), legacy);
  assert.deepEqual(run.acceptanceContract, f.input.acceptanceContract);
  assert.notEqual(inspectionVerificationKey({ ...f.input, acceptanceContract: { ...f.input.acceptanceContract!, task: { ...f.detail.contract!, description: 'Different original requirements' } } }), boundKey);
});

test('acceptance migration waits for the exact legacy provider and positively reconciles it before allocating a bound reviewer', async t => {
  for (const settled of [false, true]) await t.test(settled ? 'original teardown and inspection reconciliation proven' : 'original provider remains unknown', async inner => {
    const f = await fixture(inner); f.setProvider('unknown');
    f.store.set('goals', { ...f.goal, concurrency: 2 });
    const original = await f.verifier.ensure(f.input);
    assert.equal(original.status, 'unknown'); assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1);
    const legacyKey = inspectionVerificationKey({ ...f.input, acceptanceContract: undefined });
    f.store.set('chats', { ...f.store.get<Chat>('chats', original.chatId!)!, status: 'idle' });
    f.store.set('sessions', { ...f.store.get<Session>('sessions', original.sessionId!)!, status: 'stopped' });
    if (settled) {
      settledFixtureProvider(f, original);
    }
    const { acceptanceContract: _acceptance, ...unbound } = original;
    const legacy: InspectionVerificationRun = { ...unbound, id: legacyKey };
    const inputs = retained(f, original);
    f.store.delete(INSPECTION_VERIFIER_RUNS, original.id); f.store.set(INSPECTION_VERIFIER_RUNS, legacy);
    f.store.delete('inspection-verifier-inputs', original.id); f.store.set('inspection-verifier-inputs', { ...inputs, id: legacyKey });
    f.store.set('chats', { ...f.store.get<Chat>('chats', legacy.chatId!)!, verificationRunId: legacyKey });
    f.store.set('sessions', { ...f.store.get<Session>('sessions', legacy.sessionId!)!, verificationRunId: legacyKey });
    const oldChat = f.store.get<Chat>('chats', legacy.chatId!)!, oldSession = f.store.get<Session>('sessions', legacy.sessionId!)!;
    let reconciliations = 0;
    f.options.reconcileInspection = async prior => { reconciliations++; assert.deepEqual(prior, legacy); return settled; };
    f.setProvider('success');
    const bound = await f.verifier.ensure(f.input);
    assert.equal(bound.id, inspectionVerificationKey(f.input)); assert.notEqual(bound.id, legacyKey);
    if (settled) {
      assert.equal(bound.status, 'failed', `An ended old provider permits a fresh review but cannot establish genuine passing UI receipts: ${bound.reason}`);
      assert.equal(f.calls.length, 2); assert.equal(f.preparations.length, 2); assert.equal(reconciliations, 1);
    } else {
      assert.equal(bound.status, 'waiting'); assert.match(bound.reason!, /earlier verification owner.*reconciliation/i);
      assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1); assert.equal(reconciliations, 0);
      assert.equal(bound.chatId, undefined); assert.equal(bound.sessionId, undefined);
    }
    assert.deepEqual(f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, legacyKey), legacy);
    assert.deepEqual(f.store.get<Chat>('chats', legacy.chatId!), oldChat); assert.deepEqual(f.store.get<Session>('sessions', legacy.sessionId!), oldSession);
  });
});

test('acceptance migration retains its exact source before an old-owner wait and resumes after temporary input removal', async t => {
  const f = await fixture(t); f.setProvider('unknown'); f.store.set('goals', { ...f.goal, concurrency: 2 });
  const original = await f.verifier.ensure(f.input);
  assert.equal(original.status, 'unknown');
  const { acceptanceContract: _acceptance, ...unbound } = original;
  const legacy: InspectionVerificationRun = { ...unbound, id: inspectionVerificationKey({ ...f.input, acceptanceContract: undefined }) };
  const originalInputs = retained(f, original);
  f.store.delete(INSPECTION_VERIFIER_RUNS, original.id); f.store.set(INSPECTION_VERIFIER_RUNS, legacy);
  f.store.delete('inspection-verifier-inputs', original.id); f.store.set('inspection-verifier-inputs', { ...originalInputs, id: legacy.id });
  f.store.set('chats', { ...f.store.get<Chat>('chats', legacy.chatId!)!, status: 'idle', verificationRunId: legacy.id });
  f.store.set('sessions', { ...f.store.get<Session>('sessions', legacy.sessionId!)!, status: 'stopped', verificationRunId: legacy.id });
  f.options.reconcileInspection = async () => false;
  const waiting = await f.verifier.ensure(f.input);
  assert.equal(waiting.status, 'waiting'); assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1);
  const saved = retained(f, waiting);
  assert.equal(saved.transfer.snapshotId, f.snapshot.id); assert.equal(saved.transfer.sourceDigest, f.source.sha256);
  assert.ok(saved.snapshot);
  for (const artifact of [saved.transfer.sourceManifest, ...saved.transfer.sourceArtifacts.map(root => root.manifest)]) await f.artifacts.path(artifact);
  await f.snapshotManager.remove(f.snapshot); await absent(f.snapshot.path);
  const fresh = await f.snapshotManager.create({ roots: [
    { id: 'primary', name: 'primary', path: f.main, sourceCommit: f.originalCommit, kind: 'git', originalPath: '/workspaces/mail', manifestSha256: 'a'.repeat(64) },
    { id: 'enough-ui', name: 'enough-ui', path: f.design, kind: 'folder', originalPath: '/workspaces/enough-ui', manifestSha256: 'b'.repeat(64) },
  ], context: authority });
  assert.notEqual(fresh.id, f.snapshot.id); assert.equal(fresh.sourceDigest, f.source.sha256);
  const freshSource: InspectionSourceIdentity = { ...f.source, snapshotId: fresh.id, roots: fresh.roots.map(root => ({ id: root.id, sha256: root.sourceDigest,
    ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })) };
  assert.equal(inspectionVerificationKey({ ...f.input, source: freshSource }), waiting.id);
  settledFixtureProvider(f, original);
  let reconciliations = 0;
  f.options.reconcileInspection = async prior => { reconciliations++; assert.deepEqual(prior, legacy); return true; };
  f.setProvider('success');
  const resumed = await f.verifier.ensure({ ...f.input, snapshot: fresh, source: freshSource });
  assert.equal(resumed.id, waiting.id); assert.deepEqual(resumed.source, waiting.source);
  assert.equal(resumed.status, 'failed', 'Durable source and settled prior execution still require original UI receipts');
  assert.equal(reconciliations, 1); assert.equal(f.calls.length, 2); assert.equal(f.preparations.length, 2);
  const executionSnapshot = f.preparations.at(-1)!.snapshot;
  assert.equal(executionSnapshot.id, f.snapshot.id); assert.equal(executionSnapshot.sourceDigest, f.source.sha256);
  assert.equal(await readFile(path.join(executionSnapshot.roots[0]!.path, 'Main.swift'), 'utf8'), 'let heading = "Exact dirty source"\r\n');
  assert.equal(await readFile(path.join(executionSnapshot.roots[1]!.path, 'Tokens.swift'), 'utf8'), 'let spacing = 12\n');
  assert.equal(retained(f, resumed).transfer.snapshotId, saved.transfer.snapshotId);
  assert.deepEqual(f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, legacy.id), legacy);
});

test('a known setup failure waits and retries the same independent owner without rerunning its author', async t => {
  const f = await fixture(t), originalSource = structuredClone(f.source);
  let setupUnavailable = true;
  f.setPreparationHook(async () => {
    if (setupUnavailable) throw Object.assign(new Error('Independent source export transport is temporarily unavailable'), { agentStarted: false, executionEnded: true });
  });
  const waiting = await f.verifier.ensure(f.input);
  assert.equal(waiting.status, 'waiting'); assert.match(waiting.reason!, /export transport/);
  assert.equal(f.calls.length, 0); assert.equal(waiting.chatId, undefined);
  assert.equal(f.preparations.length, 1); assert.equal(f.stopped.length, 0);
  const session = f.store.get<Session>('sessions', waiting.sessionId!)!;
  assert.equal(session.status, 'ready'); assert.equal(session.verificationRunId, waiting.id);
  setupUnavailable = false;
  const retried = await f.verifier.ensure(f.input);
  assert.equal(retried.id, waiting.id); assert.equal(retried.sessionId, waiting.sessionId);
  assert.equal(f.preparations.length, 1, 'Retry reuses its recorded private owner instead of allocating another environment');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0]!.options.verificationRunId, waiting.id);
  assert.equal(retried.status, 'failed', 'A dispatched verifier still requires genuine passing receipts');
  assert.deepEqual(retried.source, originalSource); assert.deepEqual(f.source, originalSource);
  assert.equal(f.store.get<Chat>('chats', retried.chatId!)!.attemptId, undefined);
  assert.equal(f.stopped.length, 1);
});

test('publishing a stale starting session after preparation cannot overwrite the current ready runtime state', async t => {
  const f = await fixture(t); f.setProvider('hold');
  const advancedAt = '2099-01-01T00:00:00.000Z';
  let stale!: Session;
  const verifier = f.anotherVerifier({ prepareExecution: async preparation => {
    await f.options.prepareExecution!({ ...preparation, onSession: session => {
      stale = { ...session, status: 'starting', services: [], updatedAt: '2000-01-01T00:00:00.000Z' };
      f.store.set('sessions', stale); preparation.onSession(stale);
      f.store.set('sessions', { ...f.store.get<Session>('sessions', session.id)!, status: 'ready', phase: 'Runtime ready', enginePid: 421,
        services: [{ name: 'native-inspection', status: 'ready' }], updatedAt: advancedAt });
    } });
    return stale;
  } });
  const result = verifier.ensure(f.input);
  await eventually(() => f.calls.length === 1);
  const run = f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, inspectionVerificationKey(f.input))!;
  const current = f.store.get<Session>('sessions', run.sessionId!)!;
  assert.equal(stale.status, 'starting'); assert.equal(current.status, 'ready');
  assert.equal(current.phase, 'Runtime ready'); assert.equal(current.enginePid, 421); assert.equal(current.updatedAt, advancedAt);
  assert.deepEqual(current.services, [{ name: 'native-inspection', status: 'ready' }]); assert.equal(current.verificationRunId, run.id);
  assert.equal(f.preparations.length, 1); assert.equal(f.sessions.size, 1); assert.equal(f.store.list('chats').length, 1);
  assert.deepEqual(run.source, f.source);
  f.finishProvider(); assert.equal((await result).status, 'failed', 'A real quality receipt is still required after dispatch');
  assert.equal(f.calls.length, 1);
});

test('restarting a stopped verifier keeps the current ready runtime record when its captured session is republished', async t => {
  const f = await legacyContainerFixture(t, 'waiting', 'stopped'); f.setProvider('hold');
  const stopped = f.store.get<Session>('sessions', f.run.sessionId!)!;
  assert.equal(stopped.status, 'stopped');
  const advancedAt = '2099-02-01T00:00:00.000Z', originalRestart = f.containerSessions.restart;
  f.containerSessions.restart = async id => {
    await originalRestart(id);
    f.store.set('sessions', { ...f.store.get<Session>('sessions', id)!, phase: 'Restored and ready', enginePid: 842,
      services: [{ name: 'browser-inspection', status: 'ready', port: 9222 }], updatedAt: advancedAt });
  };
  const result = f.verifier.ensure(f.input);
  await eventually(() => f.calls.length === 1);
  const current = f.store.get<Session>('sessions', stopped.id)!;
  assert.equal(stopped.status, 'stopped'); assert.equal(current.status, 'ready');
  assert.equal(current.phase, 'Restored and ready'); assert.equal(current.enginePid, 842); assert.equal(current.updatedAt, advancedAt);
  assert.deepEqual(current.services, [{ name: 'browser-inspection', status: 'ready', port: 9222 }]);
  assert.equal(current.verificationRunId, f.run.id); assert.deepEqual(f.restarted, [stopped.id]);
  assert.equal(f.preparations.length, 1); assert.equal(f.sessions.size, 1); assert.equal(f.sourceChecks(), 1);
  assert.equal(f.store.list('chats').length, 1); assert.deepEqual(f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, f.run.id)!.source, f.source);
  f.finishProvider(); assert.equal((await result).status, 'failed'); assert.equal(f.calls.length, 1);
});

test('legacy container metadata reuses ready and stopped independent owners while explicit native mismatches stay unknown', async t => {
  for (const state of ['ready', 'stopped'] as const) {
    await t.test(`ordinary legacy container ${state}`, async inner => {
      const f = await legacyContainerFixture(inner, 'waiting', state);
      const retried = await f.verifier.ensure(f.input);
      assert.equal(retried.status, 'failed', 'The provider ran, but genuine receipts are still required');
      assert.equal(retried.id, f.run.id); assert.equal(retried.sessionId, f.run.sessionId);
      assert.equal(f.preparations.length, 1); assert.equal(f.calls.length, 1); assert.equal(f.sourceChecks(), 1);
      assert.equal(f.store.get<Session>('sessions', retried.sessionId!)!.executionTargetKind, undefined, 'Legacy metadata does not need a database rewrite');
      assert.deepEqual(f.restarted, state === 'stopped' ? [f.run.sessionId] : []);
      assert.deepEqual(retried.source, f.run.source);
    });
  }
  await t.test('explicit native session cannot be reused as a container', async inner => {
    const f = await legacyContainerFixture(inner, 'waiting', 'ready');
    f.store.set('sessions', { ...f.store.get<Session>('sessions', f.run.sessionId!)!, executionTargetKind: 'host-macos' });
    const unknown = await f.verifier.ensure(f.input);
    assert.equal(unknown.status, 'unknown'); assert.match(unknown.reason!, /setup owner changed/);
    assert.equal(f.calls.length, 0); assert.equal(f.sourceChecks(), 0); assert.deepEqual(f.restarted, []);
  });
});

test('confirmed removed container setup is reconciled once from retained source independent of error text or legacy target metadata', async t => {
  for (const executionTargetKind of [undefined, 'container'] as const) {
    for (const reason of ['The independent setup owner changed.', 'The source export connection disappeared.']) {
      await t.test(`${executionTargetKind ?? 'legacy container'}: ${reason}`, async inner => {
        const f = await legacyContainerFixture(inner, 'unknown');
        const original = { ...f.run, reason }, originalSource = structuredClone(f.run.source);
        f.store.set(INSPECTION_VERIFIER_RUNS, original);
        f.store.set('sessions', { ...f.store.get<Session>('sessions', f.run.sessionId!)!, executionTargetKind });
        const [retried, concurrent] = await Promise.all([f.verifier.ensure(f.input), f.verifier.ensure(f.input)]);
        assert.deepEqual(concurrent, retried);
        assert.equal(retried.id, original.id); assert.equal(retried.sessionId, original.sessionId);
        assert.equal(retried.status, 'failed', 'Reconciliation dispatches a verifier, never synthesizes passing evidence');
        assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1); assert.equal(f.sourceChecks(), 1);
        assert.deepEqual(f.restarted, [original.sessionId]); assert.deepEqual(retried.source, originalSource);
        assert.equal(f.calls[0]!.options.verificationRunId, original.id);
        assert.equal(f.store.get<Chat>('chats', retried.chatId!)!.attemptId, undefined);
        const audit = f.store.events<{ action: string; previous: InspectionVerificationRun; source: InspectionSourceIdentity }>('inspection-verifier-reconciliation', original.id);
        assert.equal(audit.length, 1); assert.equal(audit[0]!.value.action, 'stopped-container-setup');
        assert.deepEqual(audit[0]!.value.previous, original); assert.deepEqual(audit[0]!.value.source, originalSource);
        assert.equal(f.store.get<Session>('sessions', original.sessionId!)!.executionTargetKind, executionTargetKind, 'Reconciliation does not rewrite execution target metadata');
        assert.equal((await f.verifier.ensure(f.input)).id, retried.id); assert.equal(f.calls.length, 1);
        assert.equal(f.store.events('inspection-verifier-reconciliation', original.id).length, 1);
        await f.snapshotManager.verify(f.snapshot);
      });
    }
  }
});

test('stopped setup reconciliation never revives dispatched execution, stale authority, changed ownership or unverifiable source', async t => {
  const f = await legacyContainerFixture(t, 'unknown');
  const session = f.store.get<Session>('sessions', f.run.sessionId!)!, inputs = retained(f, f.run);
  const archive = f.store.get<{ id: string; status: string; receipt: { version: number; status: string; containerId: string; identity: { sessionId: string; name: string; sessionName: string } } }>('session-container-retirement', session.id)!;
  const blocked = async () => {
    const before = f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, f.run.id)!;
    const result = await f.verifier.ensure(f.input);
    assert.deepEqual(result, before); assert.equal(result.status, 'unknown');
    assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 1); assert.equal(f.sourceChecks(), 0);
    assert.deepEqual(f.restarted, []); assert.equal(f.store.events('inspection-verifier-reconciliation', f.run.id).length, 0);
  };
  for (const [name, fields] of [
    ['provider already started', { startedAt: new Date().toISOString() }],
    ['recorded chat owner', { chatId: 'possible-provider-chat' }],
    ['recorded completed outcome', { completedAt: new Date().toISOString() }],
    ['malformed empty chat owner', { chatId: '' }],
    ['malformed null dispatch timestamp', { startedAt: null }],
    ['malformed empty outcome timestamp', { completedAt: '' }],
    ['foreign run device', { ownerDeviceId: 'another-mac' }],
    ['changed original candidate', { source: { ...f.run.source, candidateCommit: 'd'.repeat(40) } }],
    ['changed policy hash', { policySha256: '0'.repeat(64) }],
  ] as const) {
    await t.test(name, async () => { f.store.set(INSPECTION_VERIFIER_RUNS, { ...f.run, ...fields }); try { await blocked(); } finally { f.store.set(INSPECTION_VERIFIER_RUNS, f.run); } });
  }
  for (const [name, fields] of [
    ['session not confirmed stopped', { status: 'ready' as const }],
    ['session itself unknown', { status: 'unknown' as const }],
    ['explicit native target', { executionTargetKind: 'host-macos' as const }],
    ['malformed null session target', { executionTargetKind: null }],
    ['malformed unrecognized session target', { executionTargetKind: 'unrecognized-runtime' }],
    ['another session verification owner', { verificationRunId: 'another-run' }],
    ['foreign session device', { deviceId: 'another-mac' }],
    ['another container identity', { containerId: 'another-container' }],
    ['another archived session name', { name: 'another-session' }],
  ] as const) {
    await t.test(name, async () => { f.store.set('sessions', { ...session, ...fields }); try { await blocked(); } finally { f.store.set('sessions', session); } });
  }
  await t.test('current authority retired', async () => { f.setCurrent(false); try { await blocked(); } finally { f.setCurrent(true); } });
  await t.test('existing session chat indicates possible provider history', async () => {
    const chat: Chat = { id: 'possible-session-history', sessionId: session.id, deviceId: 'mac', runtime: 'codex', approvalMode: 'approve-all', title: 'Possible verifier', status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    f.store.set('chats', chat); try { await blocked(); } finally { f.store.delete('chats', chat.id); }
  });
  await t.test('archive not confirmed removed', async () => { f.store.set('session-container-retirement', { ...archive, status: 'archiving' }); try { await blocked(); } finally { f.store.set('session-container-retirement', archive); } });
  await t.test('archive missing', async () => { f.store.delete('session-container-retirement', session.id); try { await blocked(); } finally { f.store.set('session-container-retirement', archive); } });
  await t.test('archive removal receipt missing', async () => { f.store.set('session-container-retirement', { ...archive, receipt: undefined }); try { await blocked(); } finally { f.store.set('session-container-retirement', archive); } });
  await t.test('archive belongs to another session', async () => { f.store.set('session-container-retirement', { ...archive, receipt: { ...archive.receipt, identity: { ...archive.receipt.identity, sessionId: 'another-session' } } }); try { await blocked(); } finally { f.store.set('session-container-retirement', archive); } });
  await t.test('archive receipt has a different container name', async () => { f.store.set('session-container-retirement', { ...archive, receipt: { ...archive.receipt, identity: { ...archive.receipt.identity, name: 'another-container' } } }); try { await blocked(); } finally { f.store.set('session-container-retirement', archive); } });
  await t.test('environment still has a runtime owner', async () => {
    const original = f.containerSessions.canRetireEnvironment; f.containerSessions.canRetireEnvironment = () => false;
    try { await blocked(); } finally { f.containerSessions.canRetireEnvironment = original; }
  });
  await t.test('ownership changes inside the stopped-input lease', async () => {
    const original = f.containerSessions.withStoppedInputs;
    f.containerSessions.withStoppedInputs = async (id, operation) => original(id, async () => {
      f.store.set('sessions', { ...session, verificationRunId: 'new-verification-owner' });
      return operation();
    });
    try { await blocked(); } finally { f.containerSessions.withStoppedInputs = original; f.store.set('sessions', session); }
  });
  await t.test('forged durable source descriptor', async () => {
    f.store.set('inspection-verifier-inputs', { ...inputs, transfer: { ...inputs.transfer, sourceManifest: { ...inputs.transfer.sourceManifest, name: 'forged-source.json' } } });
    try { await blocked(); } finally { f.store.set('inspection-verifier-inputs', inputs); }
  });
  await t.test('missing durable source bytes', async () => {
    const filename = await f.artifacts.path(inputs.transfer.sourceArtifacts[0]!.manifest), bytes = await readFile(filename); await rm(filename);
    try { await blocked(); } finally { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
  });
  await t.test('run points at another session', async () => {
    const other = { ...session, id: 'another-session' }; f.store.set('sessions', other); f.store.set(INSPECTION_VERIFIER_RUNS, { ...f.run, sessionId: other.id });
    try { await blocked(); } finally { f.store.set(INSPECTION_VERIFIER_RUNS, f.run); f.store.delete('sessions', other.id); }
  });
});

test('an unconfirmed setup process remains unknown and cannot allocate or dispatch a replacement', async t => {
  for (const code of ['HOST_PROCESS_UNKNOWN', 'PROCESS_TEARDOWN_UNCONFIRMED']) {
    await t.test(code, async inner => {
      const f = await fixture(inner);
      f.setPreparationHook(async () => { throw Object.assign(new Error('Independent source copier termination was not confirmed'), { code, executionEnded: false }); });
      const unknown = await f.verifier.ensure(f.input);
      assert.equal(unknown.status, 'unknown'); assert.equal(unknown.completedAt, undefined);
      assert.equal(unknown.chatId, undefined); assert.equal(f.calls.length, 0); assert.equal(f.stopped.length, 0);
      assert.equal(f.store.get<Session>('sessions', unknown.sessionId!)!.status, 'ready');
      assert.ok(retained(f, unknown).snapshot);
      assert.equal((await f.verifier.ensure(f.input)).id, unknown.id);
      assert.equal(f.preparations.length, 1); assert.equal(f.calls.length, 0);
    });
  }
});

test('changing the current goal revision fences a running final verifier while preserving frozen author authority', async t => {
  const f = await fixture(t); f.setProvider('hold'); f.setPassed(true);
  const goal: Goal = { ...f.goal, revision: 41, objective: 'Deliver the complete current EnoughMail client', criteria: ['Every current mail workflow works', 'Draft restoration preserves all fields'] };
  f.store.set('goals', goal);
  const input: VerificationInput = { ...f.input, purpose: 'goal-final', goalRevision: goal.revision,
    acceptanceContract: { ...f.input.acceptanceContract!, goal: { revision: goal.revision, objective: goal.objective, criteria: goal.criteria, taskContracts: [] } } };
  const result = f.verifier.ensure(input); await eventually(() => f.calls.length === 1);
  const running = f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)[0]!;
  assert.equal(running.purpose, 'goal-final'); assert.equal(running.goalRevision, 41);
  assert.equal(running.authority.goalRevision, 12, 'Canonical goal revision must not rewrite the author assignment');
  assert.ok(await f.verifier.verificationSource(f.context(running)));
  f.store.set('goals', { ...goal, revision: 42 });
  await assert.rejects(f.verifier.verificationSource(f.context(running)), /goal revision was retired/);
  f.finishProvider();
  const retired = await result;
  assert.equal(retired.status, 'canceled'); assert.match(retired.reason!, /goal revision was retired/);
  assert.equal(f.checks(), 0, 'An older final owner cannot publish a passing quality result');
  assert.equal(f.stopped.length, 1);
  assert.throws(() => f.verifier.ensure(input), /current canonical goal revision/);
  assert.deepEqual(f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, retired.id), retired); assert.equal(f.calls.length, 1);
  settledFixtureProvider(f, retired);
  f.setProvider('success');
  const current = await f.verifier.ensure({ ...input, goalRevision: 42,
    acceptanceContract: { ...input.acceptanceContract!, goal: { ...input.acceptanceContract!.goal!, revision: 42 } } });
  assert.notEqual(current.id, retired.id); assert.equal(current.status, 'succeeded');
  assert.equal(current.goalRevision, 42); assert.equal(current.authority.goalRevision, 12);
});

test('independent verifier clones all frozen roots without replacing original commit provenance or reopening the author', async t => {
  const f = await fixture(t); f.setProvider('hold');
  const result = f.verifier.ensure(f.input);
  await eventually(() => f.calls.length === 1);
  const run = f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)[0]!, context = f.context(run);
  const binding = await f.verifier.verificationSource(context); assert.ok(binding);
  assert.notEqual(binding.snapshot.path, f.snapshot.path);
  assert.deepEqual(binding.snapshot.manifest, JSON.parse(JSON.stringify(f.snapshot.manifest)));
  assert.equal(binding.snapshot.id, f.snapshot.id); assert.equal(binding.snapshot.sourceDigest, f.snapshot.sourceDigest);
  assert.deepEqual(binding.snapshot.roots.map(root => ({ id: root.id, name: root.name, commit: root.commit, sourceCommit: root.sourceCommit, originalPath: root.originalPath, manifestSha256: root.manifestSha256 })), f.snapshot.roots.map(root => ({ id: root.id, name: root.name, commit: root.commit, sourceCommit: root.sourceCommit, originalPath: root.originalPath, manifestSha256: root.manifestSha256 })));
  assert.equal(binding.snapshot.roots[0]!.sourceCommit, f.originalCommit);
  assert.notEqual(binding.snapshot.roots[0]!.commit, f.originalCommit);
  await writeFile(path.join(f.main, 'Main.swift'), 'Changed after author capture\n');
  await writeFile(path.join(f.design, 'Tokens.swift'), 'let spacing = 999\n');
  assert.equal(await readFile(path.join(binding.snapshot.roots[0]!.path, 'Main.swift'), 'utf8'), 'let heading = "Exact dirty source"\r\n');
  assert.equal(await readFile(path.join(binding.snapshot.roots[0]!.path, 'Untracked.swift'), 'utf8'), 'let draft = "Untracked captured source"\n');
  assert.equal((await lstat(path.join(binding.snapshot.roots[0]!.path, 'Main.swift'))).mode & 0o777, 0o640);
  assert.equal((await lstat(path.join(binding.snapshot.roots[1]!.path, 'empty'))).mode & 0o777, 0o750);
  assert.equal(await readlink(path.join(binding.snapshot.roots[1]!.path, 'token-link')), 'Tokens.swift');
  assert.equal(await readFile(path.join(binding.snapshot.roots[1]!.path, 'Tokens.swift'), 'utf8'), 'let spacing = 12\n');
  assert.equal(context.chat.attemptId, undefined, 'Verifier chat is a new owner, not an author continuation');
  assert.equal(f.calls[0]!.options.verificationRunId, run.id);
  assert.match(f.calls[0]!.prompt, /must not resume, repair, commit or integrate/);
  f.finishProvider(); await result;
  await f.snapshotManager.verify(f.snapshot);
});

test('default Mac preparation privately materializes the exact multi-root snapshot and binds its own session', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t); f.setProvider('hold');
  const { sessions, verifier, forbiddenCalls } = f;
  try {
    const result = verifier.ensure(f.input);
    await eventually(() => f.calls.length === 1 || f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS).some(run => ['failed', 'unknown'].includes(run.status)));
    const run = f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)[0]!;
    if (run.status !== 'running' && run.sessionId) {
      const diagnosticSession = sessions.record(run.sessionId), diagnosticExecution = sessions.execution(run.sessionId);
      const diagnosticManager = new InspectionSnapshotManager({ dataDir: path.join(f.directory, 'diagnostic-execution') });
      const paths = [diagnosticExecution.workdir, ...(diagnosticSession.workingDirectories ?? []).map(root => root.path)];
      assert.equal((await lstat(path.join(paths[1]!, 'empty'))).mode & 0o777, 0o750, 'Physical additional-root directory survives materialization');
      const diagnostic = await diagnosticManager.create({ roots: f.snapshot.roots.map((root, index) => ({ id: root.id, name: root.name, path: paths[index]!, originalPath: root.originalPath, manifestSha256: root.manifestSha256 })) });
      assert.deepEqual(diagnostic.manifest.roots.map(root => root.entries), f.snapshot.manifest.roots.map(root => root.entries), run.reason);
    }
    assert.equal(run.status, 'running', run.reason);
    assert.equal(f.preparations.length, 0, 'The injected preparation seam was not used');
    const session = sessions.record(run.sessionId!), execution = await sessions.waitExecutionReady(session.id, 1000);
    assert.equal(session.verificationRunId, run.id);
    assert.equal(session.executionTargetKind, 'host-macos');
    assert.equal(session.executionTargetId, 'mac-host');
    assert.equal(sessions.owns(session.id), true);
    assert.notEqual(execution.workdir, f.main);
    assert.equal(execution.workdir, path.join(f.dataDir, 'workspace-data', 'workspaces', run.id, 'repository'));
    const chat = f.store.get<Chat>('chats', run.chatId!)!;
    assert.equal(chat.sessionId, session.id); assert.equal(chat.attemptId, undefined);
    const context: AgentToolBridgeContext = { chat, session, execution, attemptId: authority.attemptId, verificationRunId: run.id, signal: new AbortController().signal };
    const binding = await verifier.verificationSource(context); assert.ok(binding);
    assert.equal(binding.snapshot.roots[0]!.sourceCommit, f.originalCommit);
    assert.equal(binding.snapshot.id, f.snapshot.id);
    assert.notEqual(execution.workdir, binding.snapshot.roots[0]!.path);
    assert.equal(await readFile(path.join(execution.workdir, 'Main.swift'), 'utf8'), 'let heading = "Exact dirty source"\r\n');
    assert.equal(await readFile(path.join(execution.workdir, 'Untracked.swift'), 'utf8'), 'let draft = "Untracked captured source"\n');
    assert.equal((await lstat(path.join(execution.workdir, 'Main.swift'))).mode & 0o777, 0o640);
    const extra = session.workingDirectories!.find(root => root.id === 'enough-ui')!;
    assert.ok(extra.path.startsWith(path.join(f.dataDir, 'workspace-data', 'host-sessions', session.id, 'roots')));
    assert.notEqual(extra.path, f.design); assert.notEqual(extra.path, binding.snapshot.roots[1]!.path);
    assert.equal(await readFile(path.join(extra.path, 'Tokens.swift'), 'utf8'), 'let spacing = 12\n');
    assert.equal((await lstat(path.join(extra.path, 'Tokens.swift'))).mode & 0o777, 0o640);
    assert.equal((await lstat(path.join(extra.path, 'empty'))).mode & 0o777, 0o750);
    assert.equal(await readlink(path.join(extra.path, 'token-link')), 'Tokens.swift');
    const manager = new InspectionSnapshotManager({ dataDir: path.join(f.directory, 'actual-execution') });
    const actual = await manager.create({ roots: [
      { id: 'primary', name: 'primary', path: execution.workdir, originalPath: f.snapshot.roots[0]!.originalPath, manifestSha256: f.snapshot.roots[0]!.manifestSha256 },
      { id: extra.id, name: extra.name, path: extra.path, originalPath: f.snapshot.roots[1]!.originalPath, manifestSha256: f.snapshot.roots[1]!.manifestSha256 },
    ] });
    assert.equal(actual.sourceDigest, f.snapshot.sourceDigest, 'The real session source must equal every pinned root, beyond its Git tree');
    assert.deepEqual(actual.roots.map(root => root.sourceDigest), f.snapshot.roots.map(root => root.sourceDigest));
    await manager.remove(actual);
    await writeFile(path.join(f.main, 'Main.swift'), 'Later author edit\n');
    await writeFile(path.join(f.design, 'Tokens.swift'), 'let spacing = 999\n');
    assert.equal(await readFile(path.join(execution.workdir, 'Main.swift'), 'utf8'), 'let heading = "Exact dirty source"\r\n');
    assert.equal(await readFile(path.join(extra.path, 'Tokens.swift'), 'utf8'), 'let spacing = 12\n');
    f.finishProvider();
    assert.equal((await result).status, 'failed', 'A real prepared session still cannot pass missing quality receipts');
    assert.equal(sessions.record(session.id).status, 'stopped');
    assert.deepEqual(forbiddenCalls, []);
  } finally { await verifier.close(); sessions.close(); }
});

test('completed verifier sweeper retains durable CAS, chats and source identity while retiring only owned stopped copies', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t); f.setPassed(true);
  const run = await f.verifier.ensure(f.input), inputs = retained(f, run);
  const session = f.sessions.record(run.sessionId!), frozenPath = inputs.snapshot!.path;
  const workspaceRoot = path.join(f.dataDir, 'workspace-data', 'workspaces', run.id);
  const cacheRoot = path.join(f.dataDir, 'workspace-data', 'working-directories', `${run.id}-inputs`);
  const sourceArtifacts = [inputs.transfer.sourceManifest, ...inputs.transfer.sourceArtifacts.map(root => root.manifest)];
  const originalArtifacts = await Promise.all(sourceArtifacts.map(artifact => f.artifacts.read(artifact)));
  assert.equal(session.status, 'stopped');
  f.setHostProcesses([{ sessionId: 'unrelated-live-session', state: 'active' }, { sessionId: `${session.id}-decision-1`, state: 'exited' }]);
  await writeFile(path.join(workspaceRoot, 'repository', '.gitignore'), 'generated/\n');
  await mkdir(path.join(workspaceRoot, 'repository', 'generated', 'empty'), { recursive: true });
  await chmod(path.join(workspaceRoot, 'repository', 'generated', 'empty'), 0o710);
  await writeFile(path.join(workspaceRoot, 'repository', 'generated', 'useful-proof.txt'), 'Retain verifier-created ignored source\n', { mode: 0o640 });
  const first = f.verifier.sweepCompleted(() => true), second = f.verifier.sweepCompleted(() => true);
  assert.equal(first, second, 'Concurrent sweepers share one owned cleanup');
  assert.deepEqual(await first, { retiredRunIds: [run.id], errors: [] });
  await absent(frozenPath); await absent(workspaceRoot); await absent(cacheRoot);
  await absent(session.workingDirectories![0]!.path);
  const retired = retained(f, run);
  assert.ok(retired.retiredAt); assert.equal(retired.snapshot, undefined);
  assert.deepEqual(retired.transfer, inputs.transfer, 'The exact reconstruction manifest remains durable');
  assert.ok(retired.retirement?.primarySource, 'Verifier-created primary files also receive durable reconstruction artifacts');
  const primarySource = retired.retirement.primarySource;
  const recoveryDirectory = path.join(f.directory, 'retired-primary-recovery');
  const recovered = await importInspectionSnapshot({ dataDir: recoveryDirectory, artifacts: f.artifacts, sourceManifest: primarySource.sourceManifest, sourceArtifacts: primarySource.sourceArtifacts, expectedSource: { snapshotId: primarySource.snapshotId, sourceDigest: primarySource.sourceDigest }, context: authority });
  assert.equal(await readFile(path.join(recovered.roots[0]!.path, 'generated', 'useful-proof.txt'), 'utf8'), 'Retain verifier-created ignored source\n');
  assert.equal((await lstat(path.join(recovered.roots[0]!.path, 'generated', 'useful-proof.txt'))).mode & 0o777, 0o640);
  assert.equal((await lstat(path.join(recovered.roots[0]!.path, 'generated', 'empty'))).mode & 0o777, 0o710);
  await new InspectionSnapshotManager({ dataDir: recoveryDirectory }).remove(recovered);
  assert.deepEqual(f.store.get(INSPECTION_VERIFIER_RUNS, run.id), run);
  assert.equal(f.store.get<Chat>('chats', run.chatId!)!.sessionId, session.id);
  assert.equal(f.sessions.record(session.id).status, 'stopped', 'Cleanup never deletes its session history');
  assert.deepEqual(f.retiredHostSessions, [session.id, `${session.id}-decision-1`].map(sessionId => ({ sessionId, cwd: path.join(workspaceRoot, 'repository') })), 'Only this verifier and its ended decision owner retire; unrelated live owners remain untouched');
  assert.deepEqual(await Promise.all(sourceArtifacts.map(artifact => f.artifacts.read(artifact))), originalArtifacts);
  assert.equal(await readFile(path.join(f.main, 'Main.swift'), 'utf8'), 'let heading = "Exact dirty source"\r\n');
  await f.snapshotManager.verify(f.snapshot);
  assert.deepEqual(await f.verifier.sweepCompleted(() => true), { retiredRunIds: [], errors: [] });
});

test('verifier sweeper fences active, unknown, foreign and caller-protected owners without deleting live sessions', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t); f.setPassed(true);
  const run = await f.verifier.ensure(f.input), originalSession = f.sessions.record(run.sessionId!), inputs = retained(f, run);
  const intact = async () => {
    assert.ok(await lstat(inputs.snapshot!.path)); assert.ok(await lstat(path.join(f.dataDir, 'workspace-data', 'workspaces', run.id, 'repository')));
    assert.ok(await lstat(originalSession.workingDirectories![0]!.path)); assert.equal(retained(f, run).retiredAt, undefined);
    assert.deepEqual(f.retiredHostSessions, []);
  };
  await t.test('inspection caller refuses retirement', async () => { assert.deepEqual(await f.verifier.sweepCompleted(() => false), { retiredRunIds: [], errors: [] }); await intact(); });
  for (const fields of [{ status: 'unknown' as const }, { status: 'running' as const }, { ownerDeviceId: 'another-mac' }, { authority: { ...run.authority, goalRevision: run.authority.goalRevision + 1 } }]) {
    await t.test(`run fence ${JSON.stringify(fields)}`, async () => {
      f.store.set(INSPECTION_VERIFIER_RUNS, { ...run, ...fields });
      assert.deepEqual(await f.verifier.sweepCompleted(() => true), { retiredRunIds: [], errors: [] }); await intact();
      f.store.set(INSPECTION_VERIFIER_RUNS, run);
    });
  }
  for (const fields of [{ verificationRunId: 'another-verifier' }, { deviceId: 'another-mac' }, { status: 'ready' as const }, { status: 'unknown' as const }]) {
    await t.test(`session fence ${JSON.stringify(fields)}`, async () => {
      f.store.set('sessions', { ...originalSession, ...fields });
      assert.deepEqual(await f.verifier.sweepCompleted(() => true), { retiredRunIds: [], errors: [] }); await intact();
      f.store.set('sessions', originalSession);
    });
  }
  await t.test('live chat remains protected', async () => {
    const chat = f.store.get<Chat>('chats', run.chatId!)!; f.store.set('chats', { ...chat, status: 'running' });
    assert.deepEqual(await f.verifier.sweepCompleted(() => true), { retiredRunIds: [], errors: [] }); await intact();
    f.store.set('chats', chat);
  });
  for (const owner of [{ sessionId: originalSession.id, state: 'unknown' as const }, { sessionId: `${originalSession.id}-decision-1`, state: 'active' as const }]) {
    await t.test(`host owner remains ${owner.state}`, async () => {
      f.setHostProcesses([owner]);
      const result = await f.verifier.sweepCompleted(() => true);
      assert.deepEqual(result.retiredRunIds, []); assert.match(result.errors[0]!.reason, /active or unknown ownership/); await intact();
      f.setHostProcesses([]);
    });
  }
  await t.test('caller withdraws permission inside the owned lease', async () => {
    let predicateCalls = 0;
    const result = await f.verifier.sweepCompleted(() => ++predicateCalls === 1);
    assert.deepEqual(result.retiredRunIds, []); assert.match(result.errors[0]!.reason, /lost its confirmed terminal owner/); await intact();
  });
});

test('an in-memory verifier owner stays protected even if its persisted status is incorrectly terminal', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t); f.setProvider('hold');
  const result = f.verifier.ensure(f.input); await eventually(() => f.calls.length === 1);
  const running = f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)[0]!, inputs = retained(f, running);
  f.store.set(INSPECTION_VERIFIER_RUNS, { ...running, status: 'succeeded' });
  assert.deepEqual(await f.verifier.sweepCompleted(() => true), { retiredRunIds: [], errors: [] });
  assert.ok(await lstat(inputs.snapshot!.path));
  assert.equal(f.sessions.record(running.sessionId!).status, 'ready');
  assert.equal(f.calls.length, 1);
  f.store.set(INSPECTION_VERIFIER_RUNS, running); f.finishProvider(); await result;
});

test('verifier sweeper requires authentic reconstructible CAS and an owned workspace marker before deletion', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t); const run = await f.verifier.ensure(f.input), inputs = retained(f, run);
  const workspaceRoot = path.join(f.dataDir, 'workspace-data', 'workspaces', run.id), marker = path.join(workspaceRoot, 'workspace.json');
  const protectedCopies = async () => { assert.ok(await lstat(inputs.snapshot!.path)); assert.ok(await lstat(path.join(workspaceRoot, 'repository'))); assert.equal(retained(f, run).retiredAt, undefined); };
  await t.test('forged source manifest', async () => {
    f.store.set('inspection-verifier-inputs', { ...inputs, transfer: { ...inputs.transfer, sourceManifest: { ...inputs.transfer.sourceManifest, mime: 'application/forged' } } });
    const result = await f.verifier.sweepCompleted(() => true);
    assert.deepEqual(result.retiredRunIds, []); assert.match(result.errors[0]!.reason, /manifest changed/); await protectedCopies();
    f.store.set('inspection-verifier-inputs', inputs);
  });
  await t.test('missing durable object', async () => {
    const artifact = inputs.transfer.sourceArtifacts[0]!.manifest, filename = await f.artifacts.path(artifact), bytes = await readFile(filename);
    await rm(filename);
    try { const result = await f.verifier.sweepCompleted(() => true); assert.deepEqual(result.retiredRunIds, []); assert.equal(result.errors.length, 1); await protectedCopies(); }
    finally { await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
  });
  await t.test('forged workspace authority', async () => {
    const original = await readFile(marker, 'utf8'); await writeFile(marker, JSON.stringify({ ...JSON.parse(original), attemptId: 'author-attempt' }));
    try { const result = await f.verifier.sweepCompleted(() => true); assert.deepEqual(result.retiredRunIds, []); assert.equal(result.errors.length, 1); await protectedCopies(); }
    finally { await writeFile(marker, original); }
  });
  await t.test('missing workspace marker with remaining files has no retirement authority', async () => {
    const original = await readFile(marker); await rm(marker);
    try { const result = await f.verifier.sweepCompleted(() => true); assert.deepEqual(result.retiredRunIds, []); assert.equal(result.errors.length, 1); await protectedCopies(); }
    finally { await writeFile(marker, original); }
  });
});

test('verifier sweeper resumes a durable scoped deletion after partial filesystem cleanup', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t), run = await f.verifier.ensure(f.input), originalSet = f.store.set.bind(f.store);
  let interrupt = true;
  f.store.set = ((bucket: string, record: { id: string; retirement?: unknown }) => {
    originalSet(bucket, record);
    if (interrupt && bucket === 'inspection-verifier-inputs' && record.id === run.id && record.retirement) { interrupt = false; throw new Error('Service stopped after durable retirement intent'); }
  }) as Store['set'];
  try {
    const first = await f.verifier.sweepCompleted(() => true);
    assert.deepEqual(first.retiredRunIds, []); assert.match(first.errors[0]!.reason, /durable retirement intent/);
    assert.ok(retained(f, run).retirement);
    const workspaceRoot = path.join(f.dataDir, 'workspace-data', 'workspaces', run.id);
    // Reproduce the sweeper's completed host-disposal phase before an interrupted
    // recursive primary removal loses its marker but leaves source behind.
    await f.sessions.withStoppedInputs(run.sessionId!, () => f.sessions.disposeHostWorkspace(run.sessionId!));
    await rm(path.join(workspaceRoot, 'workspace.json')); await rm(path.join(workspaceRoot, 'repository', 'Main.swift'));
    const resumed = await f.verifier.sweepCompleted(() => true);
    assert.deepEqual(resumed, { retiredRunIds: [run.id], errors: [] }); await absent(workspaceRoot);
    assert.ok(retained(f, run).retiredAt); assert.equal(f.sessions.record(run.sessionId!).status, 'stopped');
    await f.artifacts.path(retained(f, run).transfer.sourceManifest);
  } finally { f.store.set = originalSet; }
});

test('verifier sweeper reconciles a crash after copy removal before publishing retiredAt', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t), run = await f.verifier.ensure(f.input), originalSet = f.store.set.bind(f.store);
  let interrupt = true;
  f.store.set = ((bucket: string, record: { id: string; retiredAt?: string }) => {
    if (interrupt && bucket === 'inspection-verifier-inputs' && record.id === run.id && record.retiredAt) { interrupt = false; throw new Error('Service stopped before retirement publication'); }
    originalSet(bucket, record);
  }) as Store['set'];
  try {
    const first = await f.verifier.sweepCompleted(() => true);
    assert.deepEqual(first.retiredRunIds, []); assert.match(first.errors[0]!.reason, /retirement publication/);
    assert.equal(retained(f, run).retiredAt, undefined);
    await absent(path.join(f.dataDir, 'workspace-data', 'workspaces', run.id));
    assert.deepEqual(await f.verifier.sweepCompleted(() => true), { retiredRunIds: [run.id], errors: [] });
    assert.ok(retained(f, run).retiredAt); assert.ok(f.store.get('chats', run.chatId!));
  } finally { f.store.set = originalSet; }
});

test('a recreated workspace path cannot inherit a durable verifier deletion intent', { skip: process.platform !== 'darwin' }, async t => {
  const f = await nativeFixture(t), run = await f.verifier.ensure(f.input), originalSet = f.store.set.bind(f.store);
  let interrupt = true;
  f.store.set = ((bucket: string, record: { id: string; retirement?: unknown }) => {
    originalSet(bucket, record);
    if (interrupt && bucket === 'inspection-verifier-inputs' && record.id === run.id && record.retirement) { interrupt = false; throw new Error('Pause after owned deletion intent'); }
  }) as Store['set'];
  const workspaceRoot = path.join(f.dataDir, 'workspace-data', 'workspaces', run.id), displaced = path.join(f.directory, 'displaced-owned-workspace');
  try {
    const first = await f.verifier.sweepCompleted(() => true);
    assert.deepEqual(first.retiredRunIds, []); assert.match(first.errors[0]!.reason, /owned deletion intent/);
    const original = await lstat(workspaceRoot, { bigint: true });
    await rename(workspaceRoot, displaced);
    await cp(displaced, workspaceRoot, { recursive: true, dereference: false, verbatimSymlinks: true, force: false, errorOnExist: true });
    assert.notEqual((await lstat(workspaceRoot, { bigint: true })).ino, original.ino);
    const result = await f.verifier.sweepCompleted(() => true);
    assert.deepEqual(result.retiredRunIds, []); assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.reason, /identity|replaced|ownership/);
    assert.ok(await lstat(path.join(workspaceRoot, 'repository', 'Main.swift')));
    assert.ok(await lstat(path.join(displaced, 'repository', 'Main.swift')));
    assert.equal(retained(f, run).retiredAt, undefined); assert.deepEqual(f.retiredHostSessions, []);
    assert.equal(f.sessions.record(run.sessionId!).status, 'stopped');
  } finally { f.store.set = originalSet; }
});

test('concurrent requests and byte-equivalent candidate/integration commits share one bounded verifier', async t => {
  const f = await fixture(t); f.setProvider('hold'); f.setPassed(true);
  const merged = { ...f.input, source: { ...f.source, checkedCommit: 'd'.repeat(40) } };
  assert.equal(inspectionVerificationKey(f.input), inspectionVerificationKey(merged));
  const first = f.verifier.ensure(f.input), second = f.verifier.ensure(merged);
  assert.equal(first, second);
  await eventually(() => f.calls.length === 1);
  f.finishProvider();
  const run = await first;
  assert.equal(run.status, 'succeeded');
  assert.equal(f.preparations.length, 1); assert.equal(f.checks(), 1);
  assert.deepEqual(run.source, f.source, 'Original tested C identity is retained; M is content equivalence, not a renamed commit');
  assert.equal((await f.verifier.ensure(merged)).id, run.id);
  assert.equal(f.calls.length, 1, 'A terminal verifier never silently starts another provider turn');
});

test('changed quality policy or secondary-root content receives a distinct verifier owner', async t => {
  const f = await fixture(t);
  const first = await f.verifier.ensure(f.input);
  settledFixtureProvider(f, first);
  const policy = { ...quality, referenceIds: ['enough-ui', 'enough-mail-web'] };
  const second = await f.verifier.ensure(withFrozenQuality(f, policy));
  assert.notEqual(first.id, second.id);
  withFrozenQuality(f, quality);
  await writeFile(path.join(f.design, 'Tokens.swift'), 'let spacing = 16\n');
  const snapshot = await f.snapshotManager.create({ roots: [
    { id: 'primary', name: 'primary', path: f.main }, { id: 'enough-ui', name: 'enough-ui', path: f.design },
  ], context: authority });
  const source = { ...f.source, snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) };
  const third = await f.verifier.ensure({ ...f.input, snapshot, source });
  assert.notEqual(third.id, first.id); assert.notEqual(third.source.sha256, first.source.sha256);
  assert.equal(f.calls.length, 3);
});

test('a model success claim cannot pass verification without original inspection receipts', async t => {
  const f = await fixture(t);
  const run = await f.verifier.ensure(f.input);
  assert.equal(run.status, 'failed');
  assert.match(run.reason!, /receipts are missing/);
  assert.equal(f.checks(), 1);
  assert.equal((await f.verifier.ensure(f.input)).status, 'failed');
  assert.equal(f.calls.length, 1);
});

test('service-owned pending native setup yields the provider slot and continues the same verifier for exact C', async t => {
  for (const status of ['pending', 'unknown'] as const) await t.test(status, async inner => {
    const f = await fixture(inner), originalSource = structuredClone(f.source);
    let setup: ReturnType<NonNullable<InspectionVerifierOptions['pendingNativeSetup']>> = { status, reason: 'The original independent fixture audit has not finished.' };
    const observedThreads: Array<string | undefined> = [];
    const originalRun = f.options.chats.run;
    f.options.chats.run = async (chatId, prompt, options) => {
      const chat = f.store.get<Chat>('chats', chatId)!;
      observedThreads.push(chat.threadId);
      const result = await originalRun.call(f.options.chats, chatId, prompt, options);
      f.store.set('chats', { ...f.store.get<Chat>('chats', chatId)!, threadId: chat.threadId ?? 'original-native-review-thread' });
      return result;
    };
    const verifier = f.anotherVerifier({ pendingNativeSetup: (selectedAuthority, selectedSource) => {
      assert.deepEqual(selectedAuthority, authority);
      assert.deepEqual(selectedSource, originalSource, 'Setup belongs to the exact candidate and all captured roots');
      assert.ok(f.calls.length > 0);
      assert.equal(f.options.chats.isRunning(f.calls.at(-1)!.chatId), false, 'Only an ended provider turn may yield for setup');
      return setup;
    } });
    const waiting = await verifier.ensure(f.input), inputs = retained(f, waiting);
    assert.equal(waiting.status, 'waiting'); assert.match(waiting.reason!, new RegExp(`setup is ${status}`));
    assert.equal(waiting.completedAt, undefined); assert.equal(f.calls.length, 1); assert.equal(f.checks(), 1);
    assert.equal(f.options.chats.isRunning(waiting.chatId!), false, 'The ended verifier does not occupy an agent slot while the audit runs');
    assert.equal(f.store.get<Session>('sessions', waiting.sessionId!)!.status, 'ready');
    assert.equal(f.store.get<Chat>('chats', waiting.chatId!)!.threadId, 'original-native-review-thread');
    assert.equal(f.store.get<Chat>('chats', waiting.chatId!)!.attemptId, undefined, 'No author conversation is dispatched');
    assert.equal(f.preparations.length, 1); assert.deepEqual(f.stopped, []);
    assert.deepEqual(waiting.source, originalSource); assert.deepEqual(waiting.authority, authority);
    assert.equal(inputs.snapshot!.sourceDigest, originalSource.sha256);

    setup = undefined; f.setPassed(true);
    const resumed = await verifier.ensure(f.input);
    assert.equal(resumed.status, 'succeeded'); assert.equal(resumed.id, waiting.id);
    assert.equal(resumed.chatId, waiting.chatId); assert.equal(resumed.sessionId, waiting.sessionId);
    assert.equal(resumed.startedAt, waiting.startedAt); assert.deepEqual(resumed.source, originalSource);
    assert.deepEqual(resumed.authority, authority); assert.equal(f.preparations.length, 1);
    assert.equal(f.calls.length, 2); assert.deepEqual(f.calls.map(call => call.chatId), [waiting.chatId, waiting.chatId]);
    assert.deepEqual(observedThreads, [undefined, 'original-native-review-thread']);
    assert.deepEqual(retained(f, resumed).transfer, inputs.transfer, 'Continuation retains the original source manifests');
    assert.deepEqual(f.stopped, [waiting.sessionId]); assert.equal(f.options.chats.isRunning(resumed.chatId!), false);
    assert.deepEqual(f.source, originalSource); await f.snapshotManager.verify(f.snapshot);
    assert.equal(await readFile(path.join(f.main, 'Main.swift'), 'utf8'), 'let heading = "Exact dirty source"\r\n');
  });
});

test('a rejected native audit or missing setup recovery keeps verification failed instead of hiding repair work', async t => {
  await t.test('rejected original audit', async inner => {
    const f = await fixture(inner);
    const verifier = f.anotherVerifier({ pendingNativeSetup: () => ({ status: 'rejected', reason: 'Fixture startup still constructs the production provider.' }) });
    const failed = await verifier.ensure(f.input);
    assert.equal(failed.status, 'failed'); assert.ok(failed.completedAt);
    assert.match(failed.reason!, /receipts are missing/); assert.deepEqual(f.stopped, [failed.sessionId]);
    assert.deepEqual(failed.source, f.source); assert.equal(f.calls.length, 1);
    assert.equal((await verifier.ensure(f.input)).status, 'failed'); assert.equal(f.calls.length, 1);
  });
  await t.test('quality failure has no setup recovery', async inner => {
    const f = await fixture(inner); let setupQueries = 0;
    const verifier = f.anotherVerifier({
      pendingNativeSetup: () => { setupQueries++; return { status: 'pending', reason: 'Unrelated fixture audit is still running.' }; },
      quality: { ...f.options.quality, check: async input => ({ command: 'enoughfactory:ui-quality', candidateCommit: input.candidateCommit, checkedCommit: input.checkedCommit, passed: false, exitCode: 1, output: 'The tested workflow failed its original assertion.' }) },
    });
    const failed = await verifier.ensure(f.input);
    assert.equal(failed.status, 'failed'); assert.ok(failed.completedAt); assert.equal(setupQueries, 0);
    assert.match(failed.reason!, /original assertion/); assert.deepEqual(f.stopped, [failed.sessionId]); assert.equal(f.calls.length, 1);
  });
});

test('waiting for capability setup retains exact source but dispatches no author or verifier turn', async t => {
  const f = await fixture(t); f.setAvailable(false);
  const waiting = await f.verifier.ensure(f.input);
  assert.equal(waiting.status, 'waiting'); assert.equal(f.calls.length, 0); assert.equal(f.preparations.length, 0);
  const retained = f.store.get<{ snapshot?: InspectionSnapshot }>('inspection-verifier-inputs', waiting.id);
  assert.equal(retained?.snapshot?.sourceDigest, f.snapshot.sourceDigest);
  await f.snapshotManager.remove(f.snapshot);
  f.setAvailable(true);
  const resumed = await f.verifier.ensure(f.input);
  assert.equal(resumed.id, waiting.id); assert.equal(f.calls.length, 1);
});

test('verifier source bindings reject another chat/session, stale authority and edited private source', async t => {
  const f = await fixture(t); f.setProvider('hold');
  const result = f.verifier.ensure(f.input); await eventually(() => f.calls.length === 1);
  const run = f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)[0]!, context = f.context(run);
  assert.equal(await f.verifier.verificationSource({ ...context, chat: { ...context.chat, verificationRunId: undefined } }), undefined);
  await assert.rejects(f.verifier.verificationSource({ ...context, chat: { ...context.chat, id: 'author-chat' } }), /does not own/);
  await assert.rejects(f.verifier.verificationSource({ ...context, session: { ...context.session, id: 'author-session' } }), /does not own/);
  await assert.rejects(f.verifier.verificationSource({ ...context, verificationRunId: 'another-run' }), /does not own/);
  await assert.rejects(f.verifier.verificationSource({ ...context, attemptId: 'another-attempt' }), /does not own/);
  const bound = await f.verifier.verificationSource(context); assert.ok(bound);
  await writeFile(path.join(bound.snapshot.roots[0]!.path, 'Main.swift'), 'Verifier altered source\n');
  await assert.rejects(f.verifier.verificationSource(context), /source changed/);
  f.finishProvider(); assert.equal((await result).status, 'failed'); assert.equal(f.checks(), 0);
});

test('retired authority cannot publish a successful result after provider completion', async t => {
  const f = await fixture(t); f.setProvider('hold'); f.setPassed(true);
  const result = f.verifier.ensure(f.input); await eventually(() => f.calls.length === 1);
  const run = f.store.list<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS)[0]!;
  f.setCurrent(false);
  await assert.rejects(f.verifier.verificationSource(f.context(run)), /retired|stale/);
  f.finishProvider();
  assert.equal((await result).status, 'canceled');
  assert.equal(f.checks(), 0, 'Retired authority never validates or publishes a passing quality gate');
  assert.equal(f.stopped.length, 1);
});

test('canceling preparation stops the published independent session without dispatching a provider', async t => {
  const f = await fixture(t), abort = new AbortController();
  f.setPreparationHook(async () => { abort.abort(new Error('Canceled before verifier dispatch')); });
  const run = await f.verifier.ensure({ ...f.input, signal: abort.signal });
  assert.equal(run.status, 'canceled'); assert.equal(f.calls.length, 0);
  assert.ok(run.sessionId); assert.deepEqual(f.stopped, [run.sessionId]);
});

test('interrupted or restarted unknown verifier owners stay fenced and keep their source', async t => {
  await t.test('transport lost after dispatch', async t => {
    const f = await fixture(t); f.setProvider('unknown');
    const run = await f.verifier.ensure(f.input);
    assert.equal(run.status, 'unknown'); assert.equal(f.stopped.length, 0);
    const resumed = await f.anotherVerifier().ensure(f.input);
    assert.equal(resumed.status, 'unknown'); assert.equal(f.calls.length, 1);
    assert.ok(f.store.get<{ snapshot?: InspectionSnapshot }>('inspection-verifier-inputs', run.id)?.snapshot);
  });
  await t.test('service restart during a recorded run', async t => {
    const f = await fixture(t), prior = await f.verifier.ensure(f.input);
    f.store.set(INSPECTION_VERIFIER_RUNS, { ...prior, status: 'running' });
    const recovered = f.anotherVerifier(); recovered.recover();
    assert.equal(f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, prior.id)!.status, 'unknown');
    assert.equal((await recovered.ensure(f.input)).status, 'unknown');
    assert.equal(f.calls.length, 1);
  });
  await t.test('service close interrupts active verifier and preserves unknown outcome', async t => {
    const f = await fixture(t); f.setProvider('hold');
    const result = f.verifier.ensure(f.input); await eventually(() => f.calls.length === 1);
    await f.verifier.close();
    const run = await result;
    assert.equal(run.status, 'unknown'); assert.equal(f.interrupted.length, 1);
    assert.equal(f.stopped.length, 0);
    assert.equal((await f.anotherVerifier().ensure(f.input)).status, 'unknown'); assert.equal(f.calls.length, 1);
  });
});

async function rebootedVerifierFixture(t: TestContext) {
  const f = await fixture(t); f.setProvider('unknown');
  const interrupted = await f.verifier.ensure(f.input);
  assert.equal(interrupted.status, 'unknown'); assert.ok(interrupted.startedAt);
  const run: InspectionVerificationRun = { ...interrupted, deadlineAt: '2000-01-01T00:00:00.000Z' };
  f.store.set(INSPECTION_VERIFIER_RUNS, run);
  const chat = f.store.get<Chat>('chats', run.chatId!)!;
  f.store.set('chats', { ...chat, status: 'interrupted' });
  f.store.append('chat', chat.id, { kind: 'status', text: 'Agent running', data: { status: 'running', threadId: 'original-rebooted-provider-thread' } });
  const process: HostProcessState = {
    processKey: 'original-owned-provider', sessionId: run.sessionId!, createdAt: run.startedAt,
    cwd: f.preparations[0]!.snapshot.roots[0]!.path, state: 'exited', recordPath: '/owned/original-process.json',
    termination: {
      schemaVersion: 2, kind: 'host-reboot', evidence: 'boot-identity-change', observedAt: new Date().toISOString(),
      currentBoot: { schemaVersion: 1, platform: 'darwin', machineId: 'fixture-machine', bootId: 'current-boot', startedAt: new Date().toISOString(), observedAt: new Date().toISOString(), uptimeMs: 1000 },
      previousBoot: { schemaVersion: 1, platform: 'darwin', machineId: 'fixture-machine', bootId: 'previous-boot', startedAt: '2026-10-08T00:00:00Z', observedAt: '2026-10-08T00:00:01Z', uptimeMs: 1000 },
      previousStatus: 'outcome-unknown', previousUpdatedAt: run.startedAt!, priorRecordSha256: 'a'.repeat(64),
    },
  };
  f.setHostProcesses([process]); f.setProvider('success'); f.setPassed(true);
  let reconciliations = 0, allowInspection = true;
  const recovered = f.anotherVerifier({ reconcileInspection: async selected => {
    reconciliations++; assert.equal(selected.id, run.id); return allowInspection;
  } });
  return { ...f, run, chat, process, recovered, reconciliations: () => reconciliations, setInspectionSafe: (value: boolean) => { allowInspection = value; } };
}

test('confirmed host reboot continues the original independent verifier chat and candidate with a fresh deadline', async t => {
  const f = await rebootedVerifierFixture(t);
  const unknownAction = { id: 'original-uncertain-action', status: 'unknown', observationId: 'stale-original-observation', requestId: 'original-request', source: f.run.source };
  f.store.set('inspection-actions', unknownAction);
  const result = await f.recovered.ensure(f.input);
  assert.equal(result.status, 'succeeded'); assert.equal(result.id, f.run.id);
  assert.equal(result.sessionId, f.run.sessionId); assert.equal(result.chatId, f.run.chatId);
  assert.equal(result.startedAt, f.run.startedAt); assert.deepEqual(result.authority, f.run.authority); assert.deepEqual(result.source, f.run.source);
  assert.ok(Date.parse(result.deadlineAt) > Date.now());
  assert.equal(f.calls.length, 2); assert.equal(f.preparations.length, 1); assert.equal(f.reconciliations(), 1);
  assert.equal(f.calls[1]!.chatId, f.calls[0]!.chatId); assert.equal(f.calls[1]!.options.attemptId, authority.attemptId);
  assert.match(f.calls[1]!.prompt, /never repeat their old request IDs/);
  assert.equal(f.store.get<Chat>('chats', f.run.chatId!)!.threadId, 'original-rebooted-provider-thread');
  assert.equal(f.store.list<Chat>('chats').length, 1, 'No new verifier chat or author exists');
  assert.deepEqual(f.store.get('inspection-actions', unknownAction.id), unknownAction, 'Prior unknown action is never relabeled or replayed');
  const audit = f.store.events<{ action: string; previous: InspectionVerificationRun; threadId: string }>('inspection-verifier-reconciliation', result.id);
  assert.equal(audit.length, 1); assert.equal(audit[0]!.value.action, 'host-reboot-continuation');
  assert.deepEqual(audit[0]!.value.previous, f.run); assert.equal(audit[0]!.value.previous.status, 'unknown');
  assert.equal(audit[0]!.value.previous.deadlineAt, '2000-01-01T00:00:00.000Z');
  assert.equal((await f.recovered.ensure(f.input)).status, 'succeeded'); assert.equal(f.calls.length, 2);
});

test('reboot continuation refuses absent ownership, same-boot uncertainty, stale authority and unresolved inspections', async t => {
  const cases: Array<[string, (f: Awaited<ReturnType<typeof rebootedVerifierFixture>>) => void | Promise<void>]> = [
    ['missing process inventory', f => f.setHostProcesses([])],
    ['ordinary exited process without reboot proof', f => f.setHostProcesses([{ ...f.process, termination: undefined }])],
    ['obsolete timestamp-only reboot proof', f => f.setHostProcesses([{ ...f.process, termination: { ...f.process.termination!, schemaVersion: 1 } as unknown as HostProcessState['termination'] }])],
    ['same boot identity cannot prove a reboot', f => f.setHostProcesses([{ ...f.process, termination: { ...f.process.termination!, previousBoot: f.process.termination!.currentBoot } as HostProcessState['termination'] }])],
    ['same-boot missing provider remains unknown', f => f.setHostProcesses([{ ...f.process, state: 'unknown', termination: undefined }])],
    ['another working directory', f => f.setHostProcesses([{ ...f.process, cwd: '/other/source' }])],
    ['process predates this verifier turn', f => f.setHostProcesses([{ ...f.process, createdAt: '2000-01-01T00:00:00Z' }])],
    ['unknown autonomous decision process', f => f.setHostProcesses([f.process, { ...f.process, sessionId: `${f.run.sessionId}-decision-unknown`, state: 'unknown' }])],
    ['no original thread identity', f => { f.store.delete('chats', f.chat.id); }],
    ['ambiguous provider thread', f => { f.store.append('chat', f.chat.id, { kind: 'status', data: { status: 'running', threadId: 'different-thread' } }); }],
    ['changed task authority', f => f.setCurrent(false)],
    ['changed quality policy digest', f => { f.store.set(INSPECTION_VERIFIER_RUNS, { ...f.run, policySha256: 'b'.repeat(64) }); }],
    ['unresolved original inspection backend', f => f.setInspectionSafe(false)],
    ['another active chat in the original session', f => { f.store.set('chats', { ...f.chat, id: 'another-active-chat', status: 'running' }); }],
    ['changed private checked source bytes', async f => { const filename = path.join(f.preparations[0]!.snapshot.roots[0]!.path, 'Main.swift'); await chmod(filename, 0o640); await writeFile(filename, 'Changed source after reboot'); }],
  ];
  for (const [label, mutate] of cases) await t.test(label, async inner => {
    const f = await rebootedVerifierFixture(inner); await mutate(f);
    const before = f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, f.run.id)!;
    const result = await f.recovered.ensure(f.input);
    assert.deepEqual(result, before); assert.equal(result.status, 'unknown'); assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1);
    assert.equal(f.store.events('inspection-verifier-reconciliation', f.run.id).length, 0);
  });
});

test('reboot continuation rechecks authority after stop-only inspection reconciliation', async t => {
  const f = await rebootedVerifierFixture(t);
  const raced = f.anotherVerifier({ reconcileInspection: async () => { f.setCurrent(false); return true; } });
  assert.equal((await raced.ensure(f.input)).status, 'unknown');
  assert.equal(f.calls.length, 1); assert.equal(f.stopped.length, 0); assert.equal(f.store.events('inspection-verifier-reconciliation', f.run.id).length, 0);
});

function operatorRebootProof(f: Awaited<ReturnType<typeof rebootedVerifierFixture>>): HostOperatorRebootTermination {
  const before = JSON.stringify({ phase: 'before', runId: f.run.id, chatId: f.run.chatId, originalRecordSha256: 'a'.repeat(64) });
  const after = JSON.stringify({ phase: 'after', runId: f.run.id, chatId: f.run.chatId, originalRecordSha256: 'a'.repeat(64), currentBootId: 'current-boot' });
  const witness = (content: string, name: string) => ({ content, path: path.join(f.directory, name), sha256: createHash('sha256').update(content).digest('hex') });
  return {
    schemaVersion: 2, kind: 'operator-attested-reboot', evidence: 'operator-observed-os-restart', actor: 'authorized-device-operator',
    verificationRunId: f.run.id, chatId: f.run.chatId!, sessionId: f.run.sessionId!, cwd: f.process.cwd!, processKey: f.process.processKey,
    observedAt: new Date().toISOString(), currentBoot: f.process.termination!.currentBoot, previousStatus: 'outcome-unknown', previousUpdatedAt: f.run.startedAt!, priorRecordSha256: 'a'.repeat(64),
    beforeWitness: witness(before, 'before.json'), afterWitness: witness(after, 'after.json'),
  };
}

test('a separately attested legacy reboot resumes only its exact original verifier conversation and retains the attestation audit', async t => {
  const f = await rebootedVerifierFixture(t), proof = operatorRebootProof(f);
  f.setHostProcesses([{ ...f.process, termination: proof }]);
  const result = await f.recovered.ensure(f.input);
  assert.equal(result.status, 'succeeded'); assert.equal(result.chatId, f.run.chatId); assert.equal(result.sessionId, f.run.sessionId); assert.deepEqual(result.source, f.run.source);
  assert.equal(f.calls.length, 2); assert.equal(f.preparations.length, 1);
  const audit = f.store.events<{ previous: InspectionVerificationRun; processes: HostProcessState[] }>('inspection-verifier-reconciliation', result.id)[0]!.value;
  assert.deepEqual(audit.previous, f.run); assert.deepEqual(audit.processes[0]!.termination, proof);
});

test('legacy operator attestation cannot authorize another run, chat, process, workspace or changed witness', async t => {
  const cases: Array<[string, (proof: HostOperatorRebootTermination) => HostOperatorRebootTermination]> = [
    ['different verifier run', proof => ({ ...proof, verificationRunId: 'different-verifier' })],
    ['different verifier chat', proof => ({ ...proof, chatId: 'different-chat' })],
    ['different original session', proof => ({ ...proof, sessionId: 'different-session' })],
    ['different provider process', proof => ({ ...proof, processKey: 'different-provider' })],
    ['different retained workspace', proof => ({ ...proof, cwd: '/different/source' })],
    ['missing operator identity', proof => ({ ...proof, actor: ' ' })],
    ['changed retained before witness', proof => ({ ...proof, beforeWitness: { ...proof.beforeWitness, content: 'changed manifest' } })],
    ['changed retained after witness', proof => ({ ...proof, afterWitness: { ...proof.afterWitness, content: 'changed manifest' } })],
    ['same witness cannot stand for before and after', proof => ({ ...proof, afterWitness: proof.beforeWitness })],
  ];
  for (const [label, mutate] of cases) await t.test(label, async inner => {
    const f = await rebootedVerifierFixture(inner);
    f.setHostProcesses([{ ...f.process, termination: mutate(operatorRebootProof(f)) }]);
    assert.deepEqual(await f.recovered.ensure(f.input), f.run); assert.equal(f.calls.length, 1); assert.equal(f.reconciliations(), 0);
    assert.equal(f.store.events('inspection-verifier-reconciliation', f.run.id).length, 0);
  });
});

function supervisedTerminationProof(f: Awaited<ReturnType<typeof rebootedVerifierFixture>>): HostSupervisedTermination {
  const supervisorPath = f.process.recordPath.replace(/\.json$/, '.cjs');
  return {
    schemaVersion: 2, kind: 'supervised-termination', evidence: 'complete-owned-teardown', observedAt: new Date().toISOString(),
    currentBoot: f.process.termination!.currentBoot, previousStatus: 'exited', previousUpdatedAt: new Date().toISOString(), priorRecordSha256: 'a'.repeat(64),
    processKey: f.process.processKey, sessionId: f.run.sessionId!, cwd: f.process.cwd!, inventoryComplete: true,
    supervisor: { pid: 1337, path: supervisorPath, identity: `Original supervisor ${supervisorPath} ${f.process.processKey}` },
    children: [{ pid: 7331, identity: 'Original owned verifier tool' }], exitCode: null, exitSignal: 'SIGKILL',
  };
}

test('a complete supervised provider stop resumes only the same retained verifier without claiming a reboot or success', async t => {
  const f = await rebootedVerifierFixture(t), proof = supervisedTerminationProof(f);
  f.setHostProcesses([{ ...f.process, pid: proof.supervisor.pid, termination: proof }]);
  const unknownAction = { id: 'original-unknown-action', status: 'unknown', requestId: 'never-replay-original-request', source: f.run.source };
  f.store.set('inspection-actions', unknownAction);
  const result = await f.recovered.ensure(f.input);
  assert.equal(result.status, 'succeeded'); assert.equal(result.id, f.run.id); assert.equal(result.sessionId, f.run.sessionId); assert.equal(result.chatId, f.run.chatId);
  assert.equal(result.startedAt, f.run.startedAt); assert.deepEqual(result.authority, f.run.authority); assert.deepEqual(result.source, f.run.source);
  assert.equal(f.calls.length, 2); assert.equal(f.preparations.length, 1); assert.equal(f.reconciliations(), 1);
  assert.equal(f.calls[1]!.chatId, f.calls[0]!.chatId); assert.equal(f.store.get<Chat>('chats', f.run.chatId!)!.threadId, 'original-rebooted-provider-thread');
  assert.deepEqual(f.store.get('inspection-actions', unknownAction.id), unknownAction);
  assert.match(f.calls[1]!.prompt, /never repeat their old request IDs/);
  const audit = f.store.events<{ action: string; previous: InspectionVerificationRun; processes: HostProcessState[] }>('inspection-verifier-reconciliation', result.id)[0]!.value;
  assert.equal(audit.action, 'host-supervised-continuation'); assert.deepEqual(audit.previous, f.run); assert.equal(audit.previous.status, 'unknown');
  assert.deepEqual(audit.processes[0]!.termination, proof);
});

test('supervised continuation refuses incomplete teardown, mismatched ownership and unresolved dependent processes', async t => {
  const cases: Array<[string, (proof: HostSupervisedTermination) => HostSupervisedTermination]> = [
    ['incomplete inventory', proof => ({ ...proof, inventoryComplete: false } as unknown as HostSupervisedTermination)],
    ['EOF without owned teardown', proof => ({ ...proof, exitCode: 0, exitSignal: null } as unknown as HostSupervisedTermination)],
    ['different process', proof => ({ ...proof, processKey: 'another-process' })],
    ['different session', proof => ({ ...proof, sessionId: 'another-session' })],
    ['different source directory', proof => ({ ...proof, cwd: '/another/source' })],
    ['missing original receipt hash', proof => ({ ...proof, priorRecordSha256: '' })],
    ['another supervisor PID', proof => ({ ...proof, supervisor: { ...proof.supervisor, pid: 9999 } })],
    ['unowned supervisor path', proof => ({ ...proof, supervisor: { ...proof.supervisor, path: '/another/owner.cjs' } })],
    ['unowned supervisor identity', proof => ({ ...proof, supervisor: { ...proof.supervisor, identity: 'unrelated replacement' } })],
    ['missing owned child inventory', proof => ({ ...proof, children: undefined } as unknown as HostSupervisedTermination)],
    ['invalid owned child identity', proof => ({ ...proof, children: [{ pid: 7331, identity: '' }] })],
    ['teardown predates verifier', proof => ({ ...proof, observedAt: '2000-01-01T00:00:00.000Z' })],
  ];
  for (const [label, mutate] of cases) await t.test(label, async inner => {
    const f = await rebootedVerifierFixture(inner), proof = mutate(supervisedTerminationProof(f));
    f.setHostProcesses([{ ...f.process, pid: 1337, termination: proof }]);
    assert.deepEqual(await f.recovered.ensure(f.input), f.run); assert.equal(f.calls.length, 1); assert.equal(f.reconciliations(), 0);
    assert.equal(f.store.events('inspection-verifier-reconciliation', f.run.id).length, 0);
  });
  await t.test('unknown autonomous decision owner', async inner => {
    const f = await rebootedVerifierFixture(inner), proof = supervisedTerminationProof(f);
    f.setHostProcesses([{ ...f.process, pid: 1337, termination: proof }, { ...f.process, processKey: 'decision-owner', sessionId: `${f.run.sessionId}-decision-original`, state: 'unknown' }]);
    assert.deepEqual(await f.recovered.ensure(f.input), f.run); assert.equal(f.calls.length, 1); assert.equal(f.reconciliations(), 0);
  });
});

test('retained provider eligibility is read-only and requires positive termination rather than idle chat state', async t => {
  const f = await rebootedVerifierFixture(t), proof = supervisedTerminationProof(f);
  f.setHostProcesses([{ ...f.process, pid: proof.supervisor.pid, termination: proof }]);
  let readOnlyProbe = false;
  f.options.chats.manager.hostProcesses = async options => { readOnlyProbe = options?.readOnly === true; return [{ ...f.process, pid: proof.supervisor.pid, termination: proof }]; };
  const before = f.store.get(INSPECTION_VERIFIER_RUNS, f.run.id), events = f.store.events('inspection-verifier-reconciliation', f.run.id);
  assert.deepEqual(await f.recovered.providerSettled(f.run), { ready: true });
  assert.equal(readOnlyProbe, true); assert.deepEqual(f.store.get(INSPECTION_VERIFIER_RUNS, f.run.id), before);
  assert.deepEqual(f.store.events('inspection-verifier-reconciliation', f.run.id), events);
  assert.equal(f.calls.length, 1); assert.equal(f.preparations.length, 1); assert.equal(f.stopped.length, 0); assert.equal(f.reconciliations(), 0);
  f.options.chats.manager.hostProcesses = async () => [{ ...f.process, pid: 1337, termination: undefined }];
  assert.equal((await f.recovered.providerSettled(f.run)).ready, false);
  f.options.chats.manager.hostProcesses = async () => [];
  f.store.set('chat-turn-failures', { id: f.chat.id, attemptId: f.run.authority.attemptId, agentStarted: false, executionEnded: true });
  assert.equal((await f.recovered.providerSettled(f.run)).ready, false, 'A contradictory not-started failure cannot erase the original running-provider event');
  f.store.set('chats', { ...f.store.get<Chat>('chats', f.chat.id)!, status: 'running' });
  assert.equal((await f.recovered.providerSettled(f.run)).ready, false);
});

test('retained provider eligibility rejects changed live ownership after awaiting host process receipts', async t => {
  const f = await rebootedVerifierFixture(t), proof = supervisedTerminationProof(f);
  const receipt = { ...f.process, pid: proof.supervisor.pid, termination: proof };
  f.options.chats.manager.hostProcesses = async () => {
    f.store.set('chats', { ...f.store.get<Chat>('chats', f.chat.id)!, status: 'running' });return [receipt];
  };
  assert.equal((await f.recovered.providerSettled(f.run)).ready, false);
  f.store.set('chats', { ...f.store.get<Chat>('chats', f.chat.id)!, status: 'interrupted' });
  f.options.chats.manager.hostProcesses = async () => {
    f.store.set(INSPECTION_VERIFIER_RUNS, { ...f.run, status: 'running' });return [receipt];
  };
  assert.equal((await f.recovered.providerSettled(f.run)).ready, false);
  assert.equal(f.calls.length,1);assert.equal(f.preparations.length,1);
});

test('retained provider eligibility survives native workspace retirement before a later shell check fails', { skip: process.platform !== 'darwin' }, async t => {
  const f=await nativeFixture(t);f.setPassed(true);
  const run=await f.verifier.ensure(f.input),session=f.sessions.record(run.sessionId!),cwd=f.sessions.execution(session.id).workdir;
  const now=new Date().toISOString(),processKey='original-completed-provider',recordPath='/owned/original-completed-provider.json';
  const proof:HostSupervisedTermination={schemaVersion:2,kind:'supervised-termination',evidence:'complete-owned-teardown',observedAt:now,currentBoot:{schemaVersion:1,platform:'darwin',machineId:'a'.repeat(64),bootId:'11111111-1111-4111-8111-111111111111',startedAt:now,observedAt:now,uptimeMs:1000},previousStatus:'exited',previousUpdatedAt:now,priorRecordSha256:'b'.repeat(64),processKey,sessionId:session.id,cwd,inventoryComplete:true,supervisor:{pid:1337,path:recordPath.replace(/\.json$/,'.cjs'),identity:`Original supervisor ${recordPath.replace(/\.json$/,'.cjs')} ${processKey}`},children:[],exitCode:null,exitSignal:'SIGKILL'};
  const process:HostProcessState={processKey,recordPath,sessionId:session.id,pid:1337,cwd,createdAt:run.startedAt,state:'exited',termination:proof};
  f.setHostProcesses([process]);
  assert.deepEqual(await f.verifier.providerSettled(run),{ready:true});
  assert.deepEqual(await f.verifier.sweepCompleted(()=>true),{retiredRunIds:[run.id],errors:[]});
  assert.throws(()=>f.sessions.execution(session.id),/workspace is unavailable/);
  assert.ok(f.sessions.retainedHostExecution(session.id).releasedAt);await absent(cwd);
  f.setCurrent(false); // The author is failed after a subsequent shell check; its tools remain retired.
  const before=retained(f,run),originalRun=f.store.get(INSPECTION_VERIFIER_RUNS,run.id);
  assert.deepEqual(await f.verifier.providerSettled(run),{ready:true});
  assert.deepEqual(retained(f,run),before);assert.deepEqual(f.store.get(INSPECTION_VERIFIER_RUNS,run.id),originalRun);
  f.setHostProcesses([{...process,state:'unknown',termination:undefined}]);
  assert.equal((await f.verifier.providerSettled(run)).ready,false,'Retirement never substitutes for positive provider termination');
});

test('an unconfirmed execution stop overrides a passing gate with unknown ownership', async t => {
  const f = await fixture(t); f.setPassed(true); f.setStopFails(true);
  const run = await f.verifier.ensure(f.input);
  assert.equal(run.status, 'unknown');
  assert.match(run.reason!, /termination is unconfirmed/);
  assert.equal(f.store.get<InspectionVerificationRun>(INSPECTION_VERIFIER_RUNS, run.id)!.status, 'unknown');
  assert.equal((await f.verifier.ensure(f.input)).status, 'unknown'); assert.equal(f.calls.length, 1);
});

test('a verifier deadline interrupts its provider once and cannot start a replacement for the same source', async t => {
  const f = await fixture(t); f.setProvider('hold');
  const verifier = f.anotherVerifier({ timeoutMs: 1000 });
  const run = await verifier.ensure(f.input);
  assert.equal(run.status, 'unknown');
  assert.equal(f.calls.length, 1); assert.equal(f.interrupted.length, 1);
  assert.equal((await verifier.ensure(f.input)).status, 'unknown');
  assert.equal(f.calls.length, 1);
  assert.equal(f.stopped.length, 0, 'Uncertain effects retain their owner for reconciliation');
});
