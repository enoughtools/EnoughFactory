import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import type { Approval, Attempt, Chat, ExecutionTargetAdvertisement, Goal, InspectionAuthority, InspectionSourceIdentity, Project, Session } from '@enoughfactory/contracts';
import { ArtifactStore, InspectionSnapshotManager, type ArtifactManifest, type InspectionSnapshot } from '@enoughfactory/workspaces';
import type { DeviceApp } from './app.ts';
import { ChatController, type AgentToolBridge, type AgentToolBridgeContext, type RunOptions } from './chats.ts';
import type { NativeFixtureProfile } from './inspection-native.ts';
import { NativeProfileSetup, PROFILE_AUDITS, validateNativeProfileProposal, type NativeProfileAudit, type NativeProfileProposal } from './inspection-profile-setup.ts';
import { SessionController } from './sessions.ts';
import { Store } from './store.ts';

const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 3, taskId: 'task', attemptId: 'author', authorityGeneration: 2, policyRevision: 3 };
const purposes = ['entry', 'storage', 'credentials', 'providers', 'preferences', 'notifications', 'build'] as const;
interface ToolResult { content: Array<{ type: string; text?: string }>; }
interface SourceRead { readId: string; rootId: string; path: string; offset: number; byteLength: number; fileSize: number; nextOffset?: number; content: string; }
const value = <T>(result: ToolResult): T => JSON.parse(result.content.find(item => item.type === 'text')!.text!) as T;

/** Actual provider stdio transport and source handler, with model judgment injected separately. */
function sourceClient(bridge: AgentToolBridge) {
  const server = bridge.mcpServers!.factory_profile_audit!;
  assert('command' in server);
  const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: 'pipe' });
  child.stdin.on('error', () => {});
  const pending = new Map<number, { resolve(value: ToolResult): void; reject(error: Error): void }>();
  const lines = createInterface({ input: child.stdout });
  let nextId = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  lines.on('line', line => {
    const packet = JSON.parse(line) as { id: number; result: ToolResult; error?: { message: string } };
    const waiting = pending.get(packet.id); if (!waiting) return;
    pending.delete(packet.id);
    if (packet.error) waiting.reject(new Error(packet.error.message)); else waiting.resolve(packet.result);
  });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  return {
    call: (args: Record<string, unknown>): Promise<ToolResult> => {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Audit source request timed out: ${stderr}`)); }, 30000);
        pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'factory_profile_source', arguments: args } })}\n`);
      });
    },
    close: async () => { child.stdin.end(); child.kill('SIGTERM'); await exited; lines.close(); },
  };
}

/** Real immutable all-root capture/artifacts and SQLite; only provider and OS allocation are seams. */
async function fixture(t: TestContext, effects: { retire?: boolean; target?: 'host-macos' | 'container' } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-native-profile-setup-')));
  const dataDir = path.join(directory, 'service'), primary = path.join(directory, 'app'), design = path.join(directory, 'design');
  await mkdir(path.join(primary, 'Demo.xcodeproj'), { recursive: true }); await mkdir(design);
  const appBytes = `// Fixture constructors precede production constructors.\n${'let fixtureOnly = true // original source\n'.repeat(1800)}`;
  await writeFile(path.join(primary, 'App.swift'), appBytes);
  await writeFile(path.join(primary, 'Demo.xcodeproj', 'project.pbxproj'), '// Original fixed native build recipe.\n');
  await writeFile(path.join(design, 'Tokens.swift'), '// Original pinned fixture preferences.\n');
  const store = new Store(dataDir), artifacts = new ArtifactStore(path.join(dataDir, 'artifacts'), 'mac');
  const snapshots = new InspectionSnapshotManager({ dataDir: path.join(dataDir, 'inspection'), artifacts });
  const authorSnapshots = new InspectionSnapshotManager({ dataDir: path.join(directory, 'author-capture'), artifacts });
  const roots = [{ id: 'primary', name: 'primary', path: primary }, { id: 'design', name: 'design', path: design }];
  const capture = async (): Promise<InspectionSnapshot> => authorSnapshots.create({ roots, context: authority });
  const identity = (snapshot: InspectionSnapshot): InspectionSourceIdentity => ({ snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) });
  const snapshot = await capture(), source = identity(snapshot);
  const proposal: NativeProfileProposal = {
    profile: { id: 'isolated-demo', build: { tool: 'xcodebuild', project: 'Demo.xcodeproj', scheme: 'Demo', platform: 'macos', configuration: 'Debug' }, launchArguments: ['--factory-fixture', '{runId}'], fixtureExpectedDataRoot: '/tmp/enoughfactory-fixtures/{runId}', bundleIdentifier: 'tools.enough.demo' },
    auditPaths: [{ rootId: 'primary', path: 'App.swift', purposes: [...purposes].filter(purpose => purpose !== 'build') }, { rootId: 'primary', path: 'Demo.xcodeproj/project.pbxproj', purposes: ['build'] }, { rootId: 'design', path: 'Tokens.swift', purposes: ['preferences'] }],
  };
  const project = { id: 'project', deviceId: 'mac', path: primary, runtime: 'codex', approvalMode: 'approve-all' } as Project;
  store.set('projects', project);
  const at = new Date().toISOString();
  const goal: Goal = { id: authority.goalId, projectId: project.id, coordinatorId: 'mac', title: 'Fixture setup', objective: 'Build an isolated native fixture', criteria: ['Review original source'], revision: 3, status: 'running', approvalMode: 'approve-all', autonomy: 'autonomous', runtime: 'codex', concurrency: 2, createdAt: at, updatedAt: at };
  store.set('goals', goal);
  store.set('sessions', { id: 'author-session', projectId: project.id, deviceId: 'mac', status: 'ready' } as Session);
  store.set('tasks', { id: authority.taskId, goalId: authority.goalId, currentAttemptId: authority.attemptId, status: 'running' });
  store.set('attempts', { id: authority.attemptId, taskId: authority.taskId, generation: authority.authorityGeneration, sessionId: 'author-session', status: 'succeeded' });
  store.set('factory-attempt-details', { id: authority.attemptId, assignmentGoalRevision: authority.goalRevision });
  let current = true, available = false, setup!: NativeProfileSetup;
  let reads: 'none' | 'partial' | 'all' = 'all';
  let responseApproved = true, providerError: Error | undefined, preparationError: Error | undefined, retirementError: Error | undefined;
  let afterReads: (() => Promise<void>) | undefined;
  let providerGate: Promise<void> | undefined;
  let markAdmitted!: () => void;
  const admitted = new Promise<void>(resolve => { markAdmitted = resolve; });
  let processes: Array<{ sessionId: string; state: string; createdAt: string }> = [];
  const configured: Array<{ projectId: string; profile: NativeFixtureProfile }> = [], calls: Array<{ chatId: string; options: RunOptions }> = [], stopped: string[] = [];
  const app = {
    dataDir, device: { id: 'mac' }, store, emit() {}, changed() {}, withServiceOperation: async <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal),
    sessions: {
      record: (id: string) => { const session = store.get<Session>('sessions', id); assert(session); return session; },
      createHost: async (selected: Project, _name: string, options: { onCreated(session: Session): void; assertCurrent(): void }) => {
        options.assertCurrent();
        if (preparationError) { const error = preparationError; preparationError = undefined; throw error; }
        const session = { id: `audit-session-${store.list<Session>('sessions').length}`, projectId: selected.id, deviceId: 'mac', status: 'ready', executionTargetKind: 'host-macos', executionTargetId: 'mac-host' } as Session;
        store.set('sessions', session); options.onCreated(session); return session;
      },
      waitExecutionReady: async (id: string) => { assert.equal(store.get<Session>('sessions', id)?.status, 'ready'); },
      restart: async (id: string) => { store.set('sessions', { ...store.get<Session>('sessions', id)!, status: 'ready' }); },
      stop: async (id: string) => { stopped.push(id); store.set('sessions', { ...store.get<Session>('sessions', id)!, status: 'stopped' }); },
    },
  } as unknown as DeviceApp;
  const serviceApprovals = new Map<string, (approval: Approval, allowed: boolean) => void>();
  const chats = {
    app, serviceApprovals, approvals: new Map(), registerServiceApproval: ChatController.prototype.registerServiceApproval, decide: ChatController.prototype.decide,
    get: (id: string) => { const chat = store.get<Chat>('chats', id); assert(chat); return chat; },
    isRunning: (id: string) => store.get<Chat>('chats', id)?.status === 'running',
    manager: { hostProcesses: async () => processes },
    create: (input: { sessionId: string; verificationRunId: string }) => {
      const chat = { id: `audit-chat-${store.list<Chat>('chats').length}`, sessionId: input.sessionId, verificationRunId: input.verificationRunId, deviceId: 'mac', runtime: 'codex', approvalMode: 'approve-all', status: 'idle' } as Chat;
      store.set('chats', chat); return chat;
    },
    interrupt: async () => {},
    run: async (chatId: string, _prompt: string, options: RunOptions) => {
      calls.push({ chatId, options });
      markAdmitted();
      if (providerGate) {
        if (calls.length > 1) throw Object.assign(new Error('A second reviewer was admitted while the only slot was held'), { agentStarted: false });
        await providerGate;
      }
      if (providerError) throw providerError;
      const chat = store.get<Chat>('chats', chatId)!;
      const run = setup.get(chat.verificationRunId!);
      const context = { chat, session: store.get<Session>('sessions', chat.sessionId), execution: { kind: 'host-macos', targetId: 'mac-host', workdir: path.join(dataDir, 'workspace-data', 'workspaces', run.id, 'repository') }, attemptId: authority.attemptId, verificationRunId: run.id, signal: new AbortController().signal } as AgentToolBridgeContext;
      const bridge = await setup.bridge(context); assert(bridge);
      const provider = sourceClient(bridge);
      try {
        if (reads !== 'none') {
          const inventory = value<{ roots: Array<{ id: string }> }>(await provider.call({}));
          assert.deepEqual(inventory.roots.map(root => root.id), ['primary', 'design']);
          for (const hint of run.proposal.auditPaths) {
            const manifest = value<{ entries: Array<{ path: string }> }>(await provider.call({ rootId: hint.rootId }));
            assert(manifest.entries.some(entry => entry.path === hint.path));
            let offset = 0;
            do {
              const part = value<SourceRead>(await provider.call({ rootId: hint.rootId, path: hint.path, offset }));
              assert.equal(part.offset, offset);
              assert.equal(Buffer.byteLength(part.content), part.byteLength);
              offset = part.nextOffset ?? part.fileSize;
              if (reads === 'partial' || part.nextOffset === undefined) break;
            } while (true);
          }
        }
        await afterReads?.();
        return { text: JSON.stringify({ approved: responseApproved, findings: purposes.map(purpose => ({ purpose, reasoning: `Observed original ${purpose} fixture control flow with explicit isolated constructors and no production fallback in the captured source.`, files: [{ rootId: purpose === 'preferences' ? 'design' : 'primary', path: purpose === 'preferences' ? 'Tokens.swift' : purpose === 'build' ? 'Demo.xcodeproj/project.pbxproj' : 'App.swift' }] })), blockedReasons: responseApproved ? [] : ['The original fixture entry falls through to production.'] }) };
      } finally { await bridge.release?.(); await provider.close(); }
    },
  } as unknown as ChatController;
  const options = {
    app, chats, artifacts, snapshots, authorityCurrent: () => current,
    verifySnapshot: (snapshot: InspectionSnapshot, signal?: AbortSignal) => snapshot.path.startsWith(path.join(dataDir, 'inspection') + path.sep) ? snapshots.verify(snapshot, signal) : authorSnapshots.verify(snapshot, signal),
    sourceCurrent: async () => identity(await capture()),
    readiness: async (): Promise<ExecutionTargetAdvertisement[]> => available ? [{ id: effects.target === 'container' ? 'owned-container' : 'mac-host', protocolVersion: 1, kind: effects.target ?? 'host-macos', readiness: 'ready', runtimes: ['codex'], capabilities: [{ kind: effects.target === 'container' ? 'linux-shell' : 'mac-shell', readiness: 'ready' }] }] : [],
    configure: (projectId: string, profile: NativeFixtureProfile) => { assert(store.list<NativeProfileAudit>(PROFILE_AUDITS).some(run => run.verdict)); configured.push({ projectId, profile }); },
    ...(effects.retire ? { retireReviewer: async (run: NativeProfileAudit) => { if (retirementError) throw retirementError; if (run.sessionId) await app.sessions.stop(run.sessionId); } } : {}),
  };
  setup = new NativeProfileSetup(options);
  t.after(async () => { await setup.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const settle = async (id: string) => {
    await setup.status(id, authority);
    // Await the actual operation, rather than coupling these I/O tests to public polling timeouts.
    await (setup as unknown as { active: Map<string, Promise<NativeProfileAudit>> }).active.get(id);
    return setup.get(id);
  };
  const propose = async (overrides: Partial<Parameters<NativeProfileSetup['propose']>[0]> = {}) => {
    const run = await setup.propose({ requestId: 'setup-once', proposal, authority, source, snapshot, projectId: project.id, sourceSessionId: 'author-session', ...overrides });
    return settle(run.id);
  };
  const execute = async (run: NativeProfileAudit) => { available = true; return settle(run.id); };
  return { app, directory, primary, design, store, artifacts, snapshots, snapshot, source, proposal, configured, calls, stopped, propose, execute, settle, admitted,
    get setup() { return setup; }, setReads: (mode: typeof reads) => { reads = mode; }, setCurrent: (value: boolean) => { current = value; }, setApproved: (value: boolean) => { responseApproved = value; },
    setAfterReads: (callback: typeof afterReads) => { afterReads = callback; }, setProviderError: (error?: Error) => { providerError = error; }, setProcesses: (value: typeof processes) => { processes = value; },
    setPreparationError: (error: Error) => { preparationError = error; }, setRetirementError: (error?: Error) => { retirementError = error; },
    setProviderGate: (gate?: Promise<void>) => { providerGate = gate; }, setAvailable: (value: boolean) => { available = value; },
    decide: (id: string, allowed: boolean) => chats.decide(id, allowed), serviceApprovals,
    restart: () => { serviceApprovals.clear(); setup = new NativeProfileSetup(options); setup.recover(); return setup; },
  };
}

test('native setup rejects absent roots, escaped build paths and reusable fixture namespaces', async t => {
  const f = await fixture(t);
  const invalid: Array<(proposal: NativeProfileProposal) => void> = [
    proposal => { proposal.auditPaths[0]!.rootId = 'outside'; },
    proposal => { proposal.auditPaths[0]!.path = '../App.swift'; },
    proposal => { if (proposal.profile.build.tool === 'xcodebuild') proposal.profile.build.project = '../Demo.xcodeproj'; },
    proposal => { if (proposal.profile.build.tool === 'xcodebuild') proposal.profile.build.project = 'Absent.xcodeproj'; },
    proposal => { proposal.profile.launchArguments = ['--factory-fixture', 'reused-global']; },
    proposal => { proposal.profile.fixtureExpectedDataRoot = '/tmp/enoughfactory-fixtures/shared'; },
    proposal => { proposal.profile.fixtureExpectedDataRoot = '/tmp/enoughfactory-fixtures/{runId}/../../production'; },
    proposal => { proposal.profile.fixtureExpectedDataRoot = '/tmp/enoughfactory-fixtures/{runId}/./storage'; },
    proposal => { (proposal.profile as unknown as Record<string, unknown>).receipt = { sha256: 'f'.repeat(64) }; },
  ];
  for (const mutate of invalid) { const proposal = structuredClone(f.proposal); mutate(proposal); assert.throws(() => validateNativeProfileProposal(proposal, f.snapshot)); }
  assert.equal(f.configured.length, 0);
});

test('native profile validator accepts the original recipe and explains misplaced platform with exact profile fields', async t => {
  const f = await fixture(t);
  const accepted = validateNativeProfileProposal(f.proposal, f.snapshot);
  assert.equal(accepted.profile.id, f.proposal.profile.id); assert.deepEqual(accepted.profile.build, f.proposal.profile.build);
  assert.deepEqual(accepted.profile.launchArguments, f.proposal.profile.launchArguments); assert.deepEqual(accepted.auditPaths, f.proposal.auditPaths);
  const misplaced = { ...f.proposal, profile: { ...f.proposal.profile, platform: 'macos' } };
  assert.throws(() => validateNativeProfileProposal(misplaced, f.snapshot), (error: unknown) => {
    assert(error instanceof Error); assert(!(error instanceof TypeError));
    assert.match(error.message, /Unknown profile fields: platform\./);
    assert.match(error.message, /Profile accepts only id, build, launchArguments, fixtureExpectedDataRoot and bundleIdentifier\./);
    assert.match(error.message, /Put platform inside build\.platform/); return true;
  });
  assert.equal(f.store.list(PROFILE_AUDITS).length, 0); assert.equal(f.calls.length, 0); assert.equal(f.configured.length, 0);
});

test('native profile validator rejects malformed profile values with a clean object-shape instruction', async t => {
  const f = await fixture(t);
  for (const profile of [null, 'macos', [], ['macos']]) {
    assert.throws(() => validateNativeProfileProposal({ ...f.proposal, profile }, f.snapshot), (error: unknown) => {
      assert(error instanceof Error); assert(!(error instanceof TypeError));
      assert.match(error.message, /Supply profile as an object with id, build and launchArguments, plus explicit auditPaths\./); return true;
    });
  }
  assert.equal(f.store.list(PROFILE_AUDITS).length, 0); assert.equal(f.calls.length, 0); assert.equal(f.configured.length, 0);
});

test('native setup cannot bind another project or source session to an author authority', async t => {
  const f = await fixture(t);
  f.store.set('projects', { id: 'foreign-project', deviceId: 'mac', path: f.design });
  f.store.set('sessions', { id: 'foreign-session', projectId: 'foreign-project', deviceId: 'mac', status: 'ready' });
  await assert.rejects(f.propose({ projectId: 'foreign-project' }), /project|authority|source/i);
  await assert.rejects(f.propose({ sourceSessionId: 'foreign-session' }), /project|authority|source/i);
  assert.equal(f.store.list(PROFILE_AUDITS).length, 0);
});

test('setup request identity binds the exact all-root source and cannot be reused after an edit', async t => {
  const f = await fixture(t), first = await f.propose(), same = await f.propose();
  assert.equal(first.id, same.id); assert.equal(f.store.list(PROFILE_AUDITS).length, 1);
  await writeFile(path.join(f.design, 'Tokens.swift'), '// Changed secondary source root.\n');
  const snapshot = await f.snapshots.create({ roots: [{ id: 'primary', name: 'primary', path: f.primary }, { id: 'design', name: 'design', path: f.design }], context: authority });
  const source: InspectionSourceIdentity = { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) };
  await assert.rejects(f.propose({ snapshot, source }), /request identity.*different proposal or source/i);
  assert.equal(f.store.list(PROFILE_AUDITS).length, 1); assert.equal(f.configured.length, 0);
  await assert.rejects(f.propose({ requestId: 'counterfeit-all-root', source: { ...f.source, roots: f.source.roots!.slice(0, 1) } }), /captured all-root source/i);
});

test('manual fixture setup uses its exact registered service approval before the real source audit', { timeout: 60000 }, async t => {
  const f = await fixture(t), goal = f.store.get<Goal>('goals', authority.goalId)!;
  f.store.set('goals', { ...goal, approvalMode: 'manual' });
  f.store.set('chats', { id: 'original-author', sessionId: 'author-session', deviceId: 'mac', runtime: 'codex', approvalMode: 'manual', status: 'idle' } as Chat);
  let run = await f.execute(await f.propose({ sourceChatId: 'original-author' }));
  assert(f.serviceApprovals.has('native-fixture-setup'));
  assert.equal(run.status, 'waiting'); assert.equal(f.calls.length, 0); assert(run.approvalId);
  const approval = f.store.get<Approval>('approvals', run.approvalId)!;
  assert.equal(approval.action, 'native-fixture-setup'); assert.equal(approval.status, 'pending'); assert.equal(approval.chatId, 'original-author'); assert.equal(approval.attemptId, authority.attemptId);
  assert.deepEqual(approval.arguments, { auditId: run.id, proposalSha256: run.proposalSha256, source: f.source });
  f.decide(approval.id, true);
  assert.equal(f.store.get<Approval>('approvals', approval.id)?.status, 'allowed'); assert(f.setup.approved(f.setup.get(run.id)));
  run = await f.execute(f.setup.get(run.id));
  assert.equal(run.status, 'configured'); assert.equal(f.calls.length, 1); assert.equal(f.configured.length, 1); assert(run.verdict && run.receipt);
  assert.throws(() => f.decide(approval.id, true), /no longer pending/i);
});

test('native setup approval refuses altered original source arguments or a changed policy revision', { timeout: 60000 }, async t => {
  const f = await fixture(t), goal = f.store.get<Goal>('goals', authority.goalId)!;
  f.store.set('goals', { ...goal, approvalMode: 'manual' });
  f.store.set('chats', { id: 'original-author', sessionId: 'author-session', deviceId: 'mac', runtime: 'codex', approvalMode: 'manual', status: 'idle' } as Chat);
  const foreignChats = [
    { id: 'foreign-source-session', sessionId: 'another-session', deviceId: 'mac' },
    { id: 'foreign-device', sessionId: 'author-session', deviceId: 'another-device' },
    { id: 'foreign-attempt', sessionId: 'author-session', deviceId: 'mac', attemptId: 'another-author' },
  ];
  for (const chat of foreignChats) {
    f.store.set('chats', { ...chat, runtime: 'codex', approvalMode: 'manual', status: 'idle' } as Chat);
    await assert.rejects(f.propose({ requestId: chat.id, sourceChatId: chat.id }), /original.*conversation|original.*author|source.*chat/i);
  }
  assert.equal(f.store.list(PROFILE_AUDITS).length, 0);
  const run = await f.propose({ sourceChatId: 'original-author' }), approval = f.store.get<Approval>('approvals', run.approvalId!)!;
  f.store.set('approvals', { ...approval, arguments: { auditId: run.id, proposalSha256: run.proposalSha256, source: { ...f.source, sha256: 'f'.repeat(64) } } });
  assert.throws(() => f.decide(approval.id, true), /no longer binds/i);
  assert.equal(f.store.get<Approval>('approvals', approval.id)?.status, 'pending');
  f.store.set('approvals', approval); f.store.set('goals', { ...goal, approvalMode: 'manual', revision: goal.revision + 1 });
  assert.throws(() => f.decide(approval.id, true), /no longer binds/i);
  assert.equal(f.calls.length, 0); assert.equal(f.configured.length, 0);
});

for (const decision of ['allow', 'deny'] as const) test(`native fixture setup honors the exact ${decision} rule and retains its typed approval`, { timeout: 60000 }, async t => {
  const f = await fixture(t), goal = f.store.get<Goal>('goals', authority.goalId)!, project = f.store.get<Project>('projects', 'project')!;
  f.store.set('goals', { ...goal, approvalMode: 'rules' });
  f.store.set('projects', { ...project, approvalMode: 'rules', rules: [{ id: 'native-setup-rule', tool: 'native-fixture-setup', decision }] });
  f.store.set('chats', { id: 'original-author', sessionId: 'author-session', deviceId: 'mac', runtime: 'codex', approvalMode: 'rules', status: 'idle' } as Chat);
  const run = await f.execute(await f.propose({ sourceChatId: 'original-author' })), approval = f.store.get<Approval>('approvals', run.approvalId!)!;
  assert.equal(approval.action, 'native-fixture-setup'); assert.equal(approval.status, decision === 'allow' ? 'allowed' : 'denied');
  assert.deepEqual(approval.arguments, { auditId: run.id, proposalSha256: run.proposalSha256, source: f.source });
  assert.equal(run.status, decision === 'allow' ? 'configured' : 'rejected'); assert.equal(f.calls.length, decision === 'allow' ? 1 : 0); assert.equal(f.configured.length, decision === 'allow' ? 1 : 0);
});

test('the independent source audit waits for a slot inside the goal agent limit', { timeout: 60000 }, async t => {
  const f = await fixture(t), goal = f.store.get<Goal>('goals', authority.goalId)!;
  f.store.set('goals', { ...goal, concurrency: 1 });
  const author = { id: 'source-author-chat', sessionId: 'author-session', deviceId: 'mac', runtime: 'codex', approvalMode: 'approve-all', status: 'running' } as Chat;
  f.store.set('chats', author);
  const attempt = f.store.get<Attempt>('attempts', authority.attemptId)!;
  f.store.set('attempts', { ...attempt, status: 'running', chatId: author.id });
  let run = await f.execute(await f.propose());
  assert.equal(run.status, 'waiting'); assert.match(run.reason!, /agent limit.*occupied/i); assert.equal(f.calls.length, 0);
  f.store.set('chats', { ...author, status: 'idle' });
  run = await f.execute(run);
  assert.equal(run.status, 'waiting', 'An idle chat does not settle the author execution reservation.'); assert.equal(f.calls.length, 0);
  f.store.set('attempts', { ...attempt, status: 'succeeded', chatId: author.id });
  run = await f.execute(run);
  assert.equal(run.status, 'configured'); assert.equal(f.calls.length, 1); assert.equal(f.configured.length, 1);
});

test('an existing preparing author without a chat already holds the single goal agent slot', { timeout: 60000 }, async t => {
  const f = await fixture(t), goal = f.store.get<Goal>('goals', authority.goalId)!;
  f.store.set('goals', { ...goal, concurrency: 1 });
  f.store.set('factory-workers', { id: 'other-preparing-worker', goal, status: 'preparing', task: { id: 'other-task' }, attempt: { id: 'other-attempt', generation: 1 } });
  let run = await f.execute(await f.propose());
  assert.equal(run.status, 'waiting'); assert.match(run.reason!, /agent limit.*occupied/i); assert.equal(f.calls.length, 0);
  f.store.delete('factory-workers', 'other-preparing-worker'); run = await f.execute(run);
  assert.equal(run.status, 'configured'); assert.equal(f.calls.length, 1);
});

test('concurrent queued fixture audits reserve the single goal slot before provider admission', { timeout: 60000 }, async t => {
  const f = await fixture(t), goal = f.store.get<Goal>('goals', authority.goalId)!;
  f.store.set('goals', { ...goal, concurrency: 1 });
  const first = await f.propose(), second = await f.propose({ requestId: 'second-independent-audit' });
  let release!: () => void;
  f.setProviderGate(new Promise<void>(resolve => { release = resolve; })); f.setAvailable(true);
  const statusRequests = [f.setup.status(first.id, authority), f.setup.status(second.id, authority)];
  const active = (f.setup as unknown as { active: Map<string, Promise<NativeProfileAudit>> }).active;
  const operations = [active.get(first.id), active.get(second.id)].filter((operation): operation is Promise<NativeProfileAudit> => Boolean(operation));
  await Promise.all(statusRequests);
  try {
    await Promise.race(operations);
    await f.admitted;
    assert.equal(f.calls.length, 1, 'Only one reviewer may be admitted while the one configured agent slot is held.');
    assert([f.setup.get(first.id), f.setup.get(second.id)].some(run => run.status === 'waiting' && /agent limit|occupied|slot/i.test(run.reason ?? '')));
  } finally { release(); await Promise.all(operations); f.setProviderGate(); }
  assert.equal(f.configured.length, 1);
});

for (const mode of ['none', 'partial'] as const) test(`an approving model response cannot configure native setup with ${mode} original source reads`, { timeout: 60000 }, async t => {
  const f = await fixture(t); f.setReads(mode);
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /read.*complet/i);
  assert.equal(f.configured.length, 0); assert.equal(run.verdict, undefined); assert.equal(run.receipt, undefined);
  assert.equal(f.calls.length, 1);
});

test('native setup retains the independent original-read verdict before installing an all-root v2 receipt', { timeout: 60000 }, async t => {
  const f = await fixture(t), run = await f.execute(await f.propose());
  assert.equal(run.status, 'configured'); assert.equal(f.configured.length, 1); assert.equal(f.calls.length, 1);
  assert.notEqual(run.snapshot.path, f.snapshot.path, 'Independent review owns a separately retained original source copy.');
  await f.snapshots.verify(run.snapshot);
  assert(run.verdict && run.receipt);
  const verdict = JSON.parse((await f.artifacts.read(run.verdict)).toString()) as { judgment: string; source: InspectionSourceIdentity; readIds: string[]; verdict: { approved: boolean } };
  assert.equal(verdict.judgment, 'source-review-not-runtime-proof'); assert.equal(verdict.verdict.approved, true); assert.deepEqual(verdict.source, f.source);
  assert(verdict.readIds.length > f.proposal.auditPaths.length, 'Large original source must be delivered in multiple retained chunks.');
  const receipt = JSON.parse((await f.artifacts.read(run.receipt)).toString()) as { version: number; sourceSha256: string; roots: Array<{ name: string; sourceDigest: string; entries: Array<{ path: string; sha256: string }> }>; independentReview: { runId: string; chatId: string; verdict: { id: string }; reads: unknown[]; judgment: string }; exceptions?: unknown };
  assert.equal(receipt.version, 2); assert.equal(receipt.sourceSha256, f.snapshot.sourceDigest);
  assert.deepEqual(receipt.roots, f.snapshot.manifest.roots.map(root => ({ name: root.name, sourceDigest: root.sourceDigest, entries: [] })));
  assert.equal(receipt.exceptions, undefined); assert.equal(receipt.independentReview.verdict.id, run.verdict.id); assert.equal(receipt.independentReview.reads.length, verdict.readIds.length);
  assert.equal(receipt.independentReview.runId, run.id); assert.equal(receipt.independentReview.chatId, run.chatId);
  assert.equal(f.configured[0]!.projectId, 'project'); assert.equal(f.configured[0]!.profile.fixtureEvidenceSha256, run.receipt.sha256);
  assert.deepEqual(f.stopped, [run.sessionId]);
});

test('source edits during independent review prevent configuration even after complete original reads', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.setAfterReads(async () => { await writeFile(path.join(f.design, 'Tokens.swift'), '// Changed source after the independent source read.\n'); });
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /source changed/i); assert.equal(f.configured.length, 0); assert.equal(run.receipt, undefined);
});

test('a stale source-read identity cannot be laundered through an approving independent judgment', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.setAfterReads(async () => {
    const read = f.store.list<{ id: string; fileSha256: string }>('inspection-profile-audit-reads')[0]!;
    f.store.set('inspection-profile-audit-reads', { ...read, fileSha256: '0'.repeat(64) });
  });
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /source read.*differs|source read.*missing/i); assert.equal(f.configured.length, 0); assert.equal(run.verdict, undefined);
});

test('original read receipts from another conversation cannot satisfy independent audit coverage', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.setAfterReads(async () => {
    for (const read of f.store.list<{ id: string; chatId: string }>('inspection-profile-audit-reads')) f.store.set('inspection-profile-audit-reads', { ...read, chatId: 'another-reviewer-chat' });
  });
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /read.*complet/i); assert.equal(f.configured.length, 0);
});

test('self-consistent source-read manifests still need the current audit authority owner', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.setAfterReads(async () => {
    const read = f.store.list<{ id: string; artifact: ArtifactManifest }>('inspection-profile-audit-reads')[0]!;
    const artifact = { ...read.artifact, attemptId: 'another-attempt' };
    await writeFile(path.join(f.artifacts.root, 'manifests', `${artifact.id}.json`), JSON.stringify(artifact));
    f.store.set('inspection-profile-audit-reads', { ...read, artifact });
  });
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /authority|owner|manifest/i); assert.equal(f.configured.length, 0);
});

test('the audit session must still be owned when an independent judgment is installed', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.setAfterReads(async () => {
    const run = f.store.list<NativeProfileAudit>(PROFILE_AUDITS)[0]!;
    f.store.set('sessions', { ...f.store.get<Session>('sessions', run.sessionId!)!, deviceId: 'another-device' });
  });
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /owner|owns|conversation/i); assert.equal(f.configured.length, 0);
});

test('retired author authority during receipt retention cannot install the reviewed native profile', { timeout: 60000 }, async t => {
  const f = await fixture(t), put = f.artifacts.put.bind(f.artifacts);
  f.artifacts.put = async (...args: Parameters<ArtifactStore['put']>) => {
    const artifact = await put(...args);
    if (args[1].name?.startsWith('fixture-source-audit-')) f.setCurrent(false);
    return artifact;
  };
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'canceled'); assert.match(run.reason!, /authority|source changed/i); assert(run.verdict); assert.equal(f.configured.length, 0);
});

test('an author source edit after the review receipt is retained still prevents configuration', { timeout: 60000 }, async t => {
  const f = await fixture(t), put = f.artifacts.put.bind(f.artifacts);
  f.artifacts.put = async (...args: Parameters<ArtifactStore['put']>) => {
    const artifact = await put(...args);
    if (args[1].name?.startsWith('fixture-source-audit-')) await writeFile(path.join(f.primary, 'App.swift'), '// Edited after reviewed receipt retention.\n');
    return artifact;
  };
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /source changed/i); assert(run.verdict); assert.equal(f.configured.length, 0);
});

test('a retained independent rejection remains review evidence and never becomes a configured profile', { timeout: 60000 }, async t => {
  const f = await fixture(t); f.setApproved(false);
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'rejected'); assert.match(run.reason!, /falls through to production/); assert(run.verdict); assert.equal(run.receipt, undefined); assert.equal(f.configured.length, 0);
});

test('restart before reviewer admission resumes only the exact recorded scratch preparation', { timeout: 60000 }, async t => {
  const f = await fixture(t); f.setPreparationError(new Error('Service stopped before reviewer admission'));
  let run = await f.execute(await f.propose());
  assert.equal(run.status, 'waiting'); assert.equal(run.chatId, undefined); assert.equal(f.calls.length, 0);
  const scratch = path.join(f.directory, 'service', 'workspace-data', 'workspaces', run.id);
  await writeFile(path.join(scratch, 'repository', 'Retained.txt'), 'Preserved pre-admission audit scratch.\n');
  f.store.set(PROFILE_AUDITS, { ...run, status: 'preparing' }); f.restart();
  assert.equal(f.setup.get(run.id).status, 'waiting', 'No provider was admitted; there is no unknown provider to replay.');
  run = await f.execute(f.setup.get(run.id));
  assert.equal(run.status, 'configured'); assert.equal(f.calls.length, 1);
  assert.equal(await readFile(path.join(scratch, 'repository', 'Retained.txt'), 'utf8'), 'Preserved pre-admission audit scratch.\n');
});

test('container audit creation publishes its exact session before launch and recovers it after a creation crash', { timeout: 60000 }, async t => {
  const f = await fixture(t, { target: 'container' });
  const endpoint = { host: 'unix:///unused-owned-profile-audit.sock', configDirectory: path.join(f.directory, 'owned-docker'), cliPath: '/must-not-run-docker' };
  const sessions = new SessionController(f.store, 'mac', () => {}, () => {}, {
    endpoint, ensureReady: async () => assert.fail('The creation boundary test must not start Docker'), bridgeHostAddress: () => undefined,
  }, path.join(f.directory, 'service', 'workspace-data'));
  t.after(() => sessions.close());
  let published!: NativeProfileAudit, savedSession!: Session, creates = 0, launchCalls = 0;
  const launch = sessions as unknown as { launch(session: Session): void };
  t.mock.method(launch, 'launch', (session: Session) => {
    launchCalls++;
    published = f.store.list<NativeProfileAudit>(PROFILE_AUDITS)[0]!;
    savedSession = f.store.get<Session>('sessions', session.id)!;
    assert.equal(published.status, 'preparing'); assert.equal(published.sessionId, session.id);
    assert.equal(savedSession.status, 'starting'); assert.equal(savedSession.verificationRunId, published.id);
    throw new Error('Simulated service interruption after session persistence and before create returns');
  });
  Object.assign(f.app.sessions, { create: (...args: Parameters<SessionController['create']>) => { creates++; return sessions.create(...args); } });
  let run = await f.execute(await f.propose());
  assert.equal(run.status, 'waiting'); assert.match(run.reason!, /Simulated service interruption/);
  assert.equal(run.sessionId, savedSession.id); assert.equal(run.chatId, undefined); assert.equal(creates, 1); assert.equal(launchCalls, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.configured.length, 0);

  // Restore the exact journal observed before the caller's catch ran, as after a service crash.
  f.store.set(PROFILE_AUDITS, published); f.restart();
  assert.equal(f.setup.get(run.id).status, 'waiting'); assert.equal(f.setup.get(run.id).sessionId, savedSession.id);
  const recoveredSessions: string[] = [];
  t.mock.method(f.app.sessions, 'waitExecutionReady', async (sessionId: string) => {
    recoveredSessions.push(sessionId);
    assert.equal(sessionId, savedSession.id); assert.equal(f.store.get<Session>('sessions', sessionId)!.verificationRunId, run.id);
    throw new Error('The original saved container is still starting');
  });
  run = await f.execute(f.setup.get(run.id));
  assert.equal(run.status, 'waiting'); assert.match(run.reason!, /original saved container is still starting/);
  assert.deepEqual(recoveredSessions, [savedSession.id]); assert.equal(run.sessionId, savedSession.id); assert.equal(run.chatId, undefined);
  assert.equal(creates, 1, 'Recovery must not create a second environment with the deterministic audit name.'); assert.equal(launchCalls, 1);
  assert.equal(f.store.list<Session>('sessions').filter(session => session.verificationRunId === run.id).length, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.configured.length, 0);
});

for (const target of ['container', 'host-macos'] as const) test(`${target} audit owner binding rollback publishes no session or launch after its callback throws`, { timeout: 60000, skip: target === 'host-macos' && process.platform !== 'darwin' }, async t => {
  const f = await fixture(t, { target });
  const endpoint = { host: 'unix:///unused-owned-profile-rollback.sock', configDirectory: path.join(f.directory, 'owned-docker'), cliPath: '/must-not-run-docker' };
  let changed = 0, launchCalls = 0, nativePreparations = 0, callbacks = 0;
  const sessions = new SessionController(f.store, 'mac', () => { changed++; }, () => {}, {
    endpoint, ensureReady: async () => assert.fail('Owner rollback must not start Docker'), bridgeHostAddress: () => undefined,
  }, path.join(f.directory, 'service', 'workspace-data'));
  t.after(() => sessions.close());
  t.mock.method(sessions as unknown as { launch(session: Session): void }, 'launch', () => { launchCalls++; assert.fail('Owner rollback must precede container launch'); });
  t.mock.method(sessions.hostWorkspaces, 'prepare', async () => { nativePreparations++; assert.fail('Owner rollback must precede native preparation'); });
  let allocatedSession!: string;
  const failBinding = (bind: ((session: Session) => void) | undefined) => (session: Session) => {
    bind?.(session); callbacks++; allocatedSession = session.id;
    const audit = f.store.list<NativeProfileAudit>(PROFILE_AUDITS)[0]!;
    assert.equal(audit.sessionId, session.id); assert.equal(f.store.get<Session>('sessions', session.id)!.verificationRunId, audit.id);
    if (target === 'host-macos') assert.equal(f.store.get<{ executionTargetKind: string }>('session-launch', session.id)!.executionTargetKind, target);
    throw new Error('Owner binding could not be committed');
  };
  Object.assign(f.app.sessions, target === 'container' ? {
    create: (project: Project, name: string, options: Parameters<SessionController['create']>[2]) => sessions.create(project, name, { ...options, onCreated: failBinding(options?.onCreated) }),
  } : {
    createHost: (project: Project, name: string, options: Parameters<SessionController['createHost']>[2]) => sessions.createHost(project, name, { ...options, onCreated: failBinding(options.onCreated) }),
  });
  const originalSessions = f.store.list<Session>('sessions');
  const run = await f.execute(await f.propose());
  assert.equal(run.status, 'waiting'); assert.match(run.reason!, /Owner binding could not be committed/); assert.equal(callbacks, 1);
  assert.equal(run.sessionId, undefined); assert.equal(run.chatId, undefined);
  assert.equal(f.store.get('sessions', allocatedSession), undefined); assert.equal(f.store.get('session-launch', allocatedSession), undefined);
  assert.deepEqual(f.store.list('sessions'), originalSessions); assert.equal(f.store.list('session-launch').length, 0);
  assert.deepEqual(sessions.serviceActivity(), { starting: 0, stopping: 0 }); assert.equal(changed, 0); assert.equal(launchCalls, 0); assert.equal(nativePreparations, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.configured.length, 0);
});

test('unpublished scratch with changed ownership is retained without reviewer admission', { timeout: 60000 }, async t => {
  const f = await fixture(t); f.setPreparationError(new Error('Service stopped before reviewer admission'));
  let run = await f.execute(await f.propose());
  const scratch = path.join(f.directory, 'service', 'workspace-data', 'workspaces', run.id), owner = path.join(scratch, 'audit-owner.json');
  await writeFile(owner, JSON.stringify({ ...JSON.parse(await readFile(owner, 'utf8')), deviceId: 'another-device' }));
  f.store.set(PROFILE_AUDITS, { ...run, status: 'preparing' }); f.restart(); run = await f.execute(f.setup.get(run.id));
  assert.equal(run.status, 'waiting'); assert.match(run.reason!, /scratch ownership.*unresolved/i); assert.equal(f.calls.length, 0); assert.equal(f.configured.length, 0);
  assert.equal(JSON.parse(await readFile(owner, 'utf8')).deviceId, 'another-device');
});

test('cleanup retries preserve the installed receipt and never replay a completed source reviewer', { timeout: 60000 }, async t => {
  const f = await fixture(t, { retire: true }); f.setRetirementError(new Error('Owned reviewer cleanup could not be confirmed'));
  let run = await f.execute(await f.propose());
  assert.equal(run.status, 'configured'); assert.equal(run.retirementStatus, 'configured'); assert.equal(run.providerUnresolved, false); assert.equal(f.setup.activeAgents(authority.goalId), 0);
  assert(run.verdict && run.receipt); const verdictId = run.verdict.id, receiptId = run.receipt.id;
  assert.equal(f.calls.length, 1); assert.equal(f.configured.length, 1);
  f.setRetirementError(); run = await f.settle(run.id);
  assert.equal(run.status, 'configured'); assert.equal(run.retirementStatus, undefined); assert.equal(run.verdict?.id, verdictId); assert.equal(run.receipt?.id, receiptId);
  assert.equal(f.calls.length, 1, 'Cleanup continuation cannot launch another independent reviewer.'); assert.equal(f.configured.length, 1, 'The original profile receipt remains installed once.');
});

test('unresolved provider ownership survives policy and budget waits and keeps the goal slot occupied', { timeout: 60000 }, async t => {
  const f = await fixture(t), goal = f.store.get<Goal>('goals', authority.goalId)!;
  f.store.set('goals', { ...goal, concurrency: 1 });
  f.setProviderError(Object.assign(new Error('Lost original reviewer transport'), { agentStarted: true, executionEnded: false }));
  let run = await f.execute(await f.propose());
  assert.equal(run.status, 'unknown'); assert.equal(run.providerUnresolved, true); assert.equal(f.setup.activeAgents(goal.id), 1);
  f.store.set('goals', { ...goal, concurrency: 1, approvalMode: 'manual' }); run = await f.settle(run.id);
  assert.equal(run.status, 'unknown'); assert.equal(run.providerUnresolved, true); assert.match(run.reason!, /Approvals/i); assert.equal(f.calls.length, 1);
  f.store.set('goals', { ...goal, concurrency: 1 });
  f.store.set('factory-control', { id: goal.id, startedAt: new Date(Date.now() - 10_000).toISOString(), maxDurationMs: 1 }); run = await f.settle(run.id);
  assert.equal(run.status, 'unknown'); assert.equal(run.providerUnresolved, true); assert.match(run.reason!, /time budget/i); assert.equal(f.calls.length, 1);
  f.store.delete('factory-control', goal.id);
  const other = await f.execute(await f.propose({ requestId: 'another-audit-after-lost-transport' }));
  assert.equal(other.status, 'waiting'); assert.match(other.reason!, /agent limit.*occupied/i); assert.equal(f.setup.activeAgents(goal.id), 1); assert.equal(f.calls.length, 1);
});

test('restart with unknown reviewer effects does not replay until original provider termination is positive', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.setProviderError(Object.assign(new Error('Lost transport after provider dispatch'), { agentStarted: true, executionEnded: false }));
  let run = await f.execute(await f.propose());
  assert.equal(run.status, 'unknown'); assert.equal(f.calls.length, 1); assert(run.chatId && run.sessionId);
  f.restart();
  await f.settle(run.id);
  assert.equal(f.setup.get(run.id).status, 'unknown'); assert.equal(f.calls.length, 1, 'No host-process witness is not a termination witness.');
  f.store.set('chat-results', { id: run.chatId, completedAt: new Date(Date.parse(run.startedAt!) - 1000).toISOString(), result: { text: '{"approved":true,"findings":[]}' } });
  await f.settle(run.id);
  assert.equal(f.calls.length, 1, 'A result from before the interrupted audit turn does not prove that turn ended.');
  f.store.delete('chat-results', run.chatId);
  f.store.set('chat-turn-failures', { id: run.chatId, attemptId: 'another-author', executionEnded: true, completedAt: new Date().toISOString() });
  await f.settle(run.id);
  assert.equal(f.calls.length, 1, 'A termination receipt owned by another author cannot authorize replay.');
  assert.equal(f.setup.get(run.id).status, 'unknown');
  f.store.delete('chat-turn-failures', run.chatId);
  f.setProcesses([{ sessionId: run.sessionId, state: 'running', createdAt: run.startedAt! }]);
  await f.settle(run.id);
  assert.equal(f.calls.length, 1, 'A live original provider cannot be replayed.');
  f.setProcesses([{ sessionId: run.sessionId, state: 'exited', createdAt: run.startedAt! }]); f.setProviderError();
  run = await f.settle(run.id);
  assert.equal(run.status, 'configured'); assert.equal(f.calls.length, 2); assert.equal(f.calls[0]!.chatId, f.calls[1]!.chatId, 'Positive termination resumes the same retained independent conversation.');
  assert.equal(f.configured.length, 1);
});
