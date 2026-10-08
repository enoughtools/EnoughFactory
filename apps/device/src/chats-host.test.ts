import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { AgentError, RUNTIME_PINS, type AgentManager, type HostProcessState, type TurnCallbacks, type TurnInput, type TurnResult } from '@enoughfactory/agents';
import type { Chat, Project, RuntimeCapability, Session } from '@enoughfactory/contracts';
import type { DeviceApp } from './app.ts';
import { ChatController, type AgentToolBridge } from './chats.ts';
import { SessionController, type SessionExecutionContext } from './sessions.ts';
import type { Store } from './store.ts';

class MemoryStore {
  private records = new Map<string, unknown>();
  private journal: { seq: number; topic: string; entity: string; value: unknown }[] = [];
  list<T>(bucket: string): T[] { return [...this.records.entries()].filter(([key]) => key.startsWith(`${bucket}:`)).map(([, value]) => structuredClone(value) as T); }
  get<T>(bucket: string, id: string): T | undefined { return structuredClone(this.records.get(`${bucket}:${id}`)) as T | undefined; }
  set<T extends { id: string }>(bucket: string, record: T): void { this.records.set(`${bucket}:${record.id}`, structuredClone(record)); }
  delete(bucket: string, id: string): void { this.records.delete(`${bucket}:${id}`); }
  append<T>(topic: string, entity: string, value: T): number { const seq = this.journal.length + 1; this.journal.push({ seq, topic, entity, value: structuredClone(value) }); return seq; }
  events<T>(topic: string, entity: string, cursor = 0): { seq: number; value: T }[] { return this.journal.filter(event => event.topic === topic && event.entity === entity && event.seq > cursor).map(({ seq, value }) => ({ seq, value: structuredClone(value) as T })); }
}

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

type FakeManager = Pick<AgentManager, 'provisionHost' | 'provision' | 'runTurn' | 'interrupt' | 'hostProcesses' | 'cancelHostSession' | 'shutdown'>;
const capability: RuntimeCapability = { kind: 'codex', available: true, version: RUNTIME_PINS.codex, fullAccess: true, interactiveApprovals: true, resume: true };
const endpoint = { host: 'unix:///tmp/enough-chat-host-fixture/docker.sock', cliPath: '/tmp/enough-chat-host-fixture/docker', configDirectory: '/tmp/enough-chat-host-fixture/config' };

function fixture(t: TestContext) {
  const store = new MemoryStore(), order: string[] = [], processes: HostProcessState[] = [];
  const runtime = { suspended: true }, counts = { ensure: 0, service: 0, container: 0, serviceAssertions: 0, runtimeAssertions: 0 };
  const interrupted: string[] = [], canceledSessions: string[] = [], turns: { input: TurnInput; callbacks: TurnCallbacks }[] = [];
  const pending = new Map<string, ReturnType<typeof deferred<TurnResult>>>();
  const project: Project = { id: 'project', name: 'Native project', path: '/user/primary', deviceId: 'device', createdAt: '2026-10-08T00:00:00Z', runtime: 'codex', approvalMode: 'approve-all', rules: [] };
  store.set('projects', project);
  const sessions = new SessionController(store as unknown as Store, 'device', () => {}, () => {}, {
    endpoint, ensureReady: async () => { counts.ensure++; assert.fail('Host chats must not prepare or start Docker'); }, bridgeHostAddress: () => undefined,
  }, '/tmp/enough-chat-host-fixture/workspace-data');
  const contexts = new Map<string, SessionExecutionContext>();
  const addSession = (id: string, kind: 'host-macos' | 'container' = 'host-macos') => {
    const session: Session = { id, name: id, projectId: project.id, deviceId: 'device', status: 'ready', executionTargetKind: kind, executionTargetId: kind === 'host-macos' ? 'mac-host' : 'private-container', createdAt: project.createdAt, updatedAt: project.createdAt, services: [], workingDirectories: [{ id: 'reference-repo', name: 'ui-reference', kind: 'git', path: kind === 'host-macos' ? `/tmp/enough-chat-host-fixture/workspace-data/host-sessions/${id}/roots/ui-reference/repository` : '/workspaces/ui-reference', baseCommit: 'a'.repeat(40), status: 'ready' }] };
    store.set('sessions', session);
    contexts.set(id, kind === 'host-macos'
      ? { kind, targetId: 'mac-host', workdir: `/tmp/enough-chat-host-fixture/workspace-data/workspaces/${id}/repository`, referencePath: `/tmp/enough-chat-host-fixture/workspace-data/host-sessions/${id}/reference-context/evidence/repository`, referenceContainerPath: '/workspaces/retained-evidence' }
      : { kind, targetId: 'private-container', containerId: `owned-${id}`, workdir: '/work' });
    return session;
  };
  sessions.execution = sessionId => { const context = contexts.get(sessionId); assert(context); return context; };
  sessions.assertCanStartWork = sessionId => { assert.equal(sessions.record(sessionId).status, 'ready'); };
  sessions.assertHostExecutionCurrent = async sessionId => { assert.equal(contexts.get(sessionId)?.kind, 'host-macos'); order.push(`current:${sessionId}`); };
  sessions.captureWorkingDirectories = async sessionId => { order.push(`capture:${sessionId}`); return []; };
  const manager: FakeManager = {
    provisionHost: async signal => { assert.equal(signal?.aborted, false); order.push('host-provision'); return capability; },
    provision: async () => { assert.fail('The host chat must not provision inside a container'); },
    runTurn: async (input, callbacks) => { order.push(`run:${input.chatId}`); turns.push({ input, callbacks }); return { text: 'completed native work', threadId: 'native-thread' }; },
    interrupt: async chatId => { interrupted.push(chatId); order.push(`interrupt:${chatId}`); pending.get(chatId)?.reject(new AgentError('Agent turn interrupted.', 'INTERRUPTED', true)); return pending.has(chatId); },
    hostProcesses: async () => { order.push('reconcile-host-processes'); return structuredClone(processes); },
    cancelHostSession: async sessionId => {
      canceledSessions.push(sessionId); order.push(`cancel:${sessionId}`);
      if (processes.some(process => process.sessionId === sessionId && process.state === 'unknown')) throw new AgentError('Native process ownership is unknown; retained workspace cannot stop.', 'HOST_PROCESS_OWNERSHIP_UNKNOWN');
      for (const process of processes) if (process.sessionId === sessionId) process.state = 'exited';
    },
    shutdown: async () => { for (const chatId of pending.keys()) await manager.interrupt(chatId); },
  };
  const serviceSignals: AbortSignal[] = [];
  const app = {
    store, sessions, dataDir: '/tmp/enough-chat-host-fixture', repositoryRoot: '/tmp/enough-chat-host-fixture/repository', device: { id: 'device' },
    runtime: { endpoint, ensureReady: async () => { counts.ensure++; assert.fail('Host chats must not prepare Docker'); } },
    extensions: [], closers: [], runtimeStopHooks: [], diagnostics: {}, changed: () => {}, emit: () => {},
    assertServiceAvailable: () => { counts.serviceAssertions++; },
    assertRuntimeCanRun: () => { counts.runtimeAssertions++; assert.equal(runtime.suspended, false, 'Container admission is suspended'); },
    withServiceOperation: async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => { counts.service++; const controller = new AbortController(); serviceSignals.push(controller.signal); return Promise.resolve().then(() => operation(controller.signal)); },
    withRuntimeOperation: async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => { counts.container++; assert.equal(runtime.suspended, false, 'Container admission is suspended'); return Promise.resolve().then(() => operation(new AbortController().signal)); },
  } as unknown as DeviceApp;
  const controller = new ChatController(app, manager as AgentManager);
  const host = addSession('native-session');
  t.after(async () => { sessions.close(); await manager.shutdown(); });
  const createChat = (sessionId = host.id) => controller.create({ sessionId });
  const holdTurn = (input: TurnInput, callbacks: TurnCallbacks) => { order.push(`run:${input.chatId}`); turns.push({ input, callbacks }); const turn = deferred<TurnResult>(); pending.set(input.chatId, turn); return turn.promise.finally(() => pending.delete(input.chatId)); };
  let nextProcess = 0;
  const process = (sessionId: string, state: HostProcessState['state']): HostProcessState => ({ processKey: `process-${++nextProcess}`, sessionId, state, pid: 12345 + nextProcess, recordPath: `/private/owned/${sessionId}/process.json` });
  return { store, order, processes, runtime, counts, interrupted, canceledSessions, turns, pending, sessions, contexts, manager, app, controller, host, addSession, createChat, holdTurn, process, serviceSignals };
}

test('native chat uses service admission and actual private roots while Docker is suspended', { timeout: 10_000 }, async t => {
  const f = fixture(t), chat = f.createChat(), context = f.contexts.get(f.host.id)!;
  const result = await f.controller.run(chat.id, 'Repair the native client', { systemInstructions: 'Keep all criteria.' });
  assert.equal(result.threadId, 'native-thread');
  assert.equal(f.counts.service, 1);
  assert.equal(f.counts.container, 0); assert.equal(f.counts.runtimeAssertions, 0); assert.equal(f.counts.ensure, 0);
  assert.equal(f.counts.serviceAssertions, 1);
  const input = f.turns[0]!.input;
  assert.equal(input.executionTarget, 'host-macos'); assert.equal(input.containerId, undefined);
  assert.equal(input.cwd, context.workdir); assert.notEqual(input.cwd, '/user/primary');
  assert.match(input.systemInstructions!, /factory automatically integrates only the primary repository/i);
  assert(input.systemInstructions!.includes(context.referencePath!));
  assert(input.systemInstructions!.includes(f.host.workingDirectories![0]!.path));
  assert(f.order.indexOf('host-provision') < f.order.indexOf(`run:${chat.id}`));
  assert.equal(f.controller.get(chat.id).status, 'idle');
  assert.equal(f.store.get<{ result: TurnResult }>('chat-results', chat.id)?.result.text, 'completed native work');
});

test('pinned preparation precedes scoped bridge configuration and image callback; failure still releases bridge', { timeout: 10_000 }, async t => {
  const f = fixture(t), chat = f.createChat();
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47]), imageReference = { artifactId: 'image-artifact', sha256: 'b'.repeat(64), mimeType: 'image/png', byteLength: image.length };
  let released = 0, receivedImage = 0;
  const onToolImage: NonNullable<AgentToolBridge['onToolImage']> = async (input, signal) => { assert.deepEqual(input.bytes, image); assert.equal(signal.aborted, false); receivedImage++; return imageReference; };
  const mcpServers: NonNullable<AgentToolBridge['mcpServers']> = { enough_native: { url: 'http://127.0.0.1:49999/attempt-scoped-mcp', bearerTokenEnvVar: 'ENOUGH_ATTEMPT_TOOL_TOKEN', enabledTools: ['native_observe', 'native_action'] } };
  const toolEnvironment = { ENOUGH_ATTEMPT_TOOL_TOKEN: 'fixture-attempt-credential' };
  f.controller.setToolBridge(async context => {
    assert(f.order.includes('host-provision')); assert.equal(context.chat.id, chat.id); assert.equal(context.execution.kind, 'host-macos'); assert.equal(context.signal.aborted, false);
    f.order.push('tool-bridge');
    return { mcpServers, toolEnvironment, onToolImage, systemInstructions: 'Use the owned native inspection session.', release: async () => { released++; f.order.push('bridge-release'); } };
  });
  f.manager.runTurn = async (input, callbacks) => {
    assert(f.order.includes('tool-bridge')); assert.equal(input.mcpServers, mcpServers); assert.equal(input.toolEnvironment, toolEnvironment); assert.equal(callbacks.onToolImage, onToolImage);
    assert.match(input.systemInstructions!, /owned native inspection session/);
    assert.deepEqual(await callbacks.onToolImage!({ bytes: image, mimeType: 'image/png', itemId: 'native-tool' }, new AbortController().signal), imageReference);
    throw Object.assign(new AgentError('Fixture provider failed after native observation.', 'AGENT_TURN_FAILED', true), { agentStarted: true });
  };
  await assert.rejects(f.controller.run(chat.id, 'Inspect and repair'), /provider failed/);
  assert.equal(receivedImage, 1); assert.equal(released, 1);
  assert.equal(f.controller.get(chat.id).status, 'failed');
  assert.equal(f.store.get<{ executionEnded: boolean }>('chat-turn-failures', chat.id)?.executionEnded, true);
  assert.equal(JSON.stringify(f.controller.events(chat.id)).includes(toolEnvironment.ENOUGH_ATTEMPT_TOOL_TOKEN), false, 'Scoped tool credentials are not conversation events');
  assert.equal(f.counts.container, 0); assert.equal(f.counts.ensure, 0);
});

test('interrupting delayed native preparation fences a late provider start', { timeout: 10_000 }, async t => {
  for (const stage of ['provision', 'bridge'] as const) await t.test(stage, async t => {
    const f = fixture(t), chat = f.createChat(), entered = deferred<AbortSignal>(), release = deferred<void>();
    let bridgeCalls = 0, bridgeReleases = 0;
    if (stage === 'provision') f.manager.provisionHost = async signal => { assert(signal); entered.resolve(signal); await release.promise; return capability; };
    f.controller.setToolBridge(async context => { bridgeCalls++; if (stage === 'bridge') { entered.resolve(context.signal); await release.promise; } return { release: () => { bridgeReleases++; } }; });
    const run = f.controller.run(chat.id, 'Native task');
    const failure = assert.rejects(run, /preparation was canceled/);
    const signal = await entered.promise;
    await f.controller.interrupt(chat.id);
    assert.equal(signal.aborted, true);
    release.resolve(); await failure;
    assert.equal(f.turns.length, 0); assert.equal(f.controller.isRunning(chat.id), false);
    assert.equal(f.controller.get(chat.id).status, 'interrupted');
    assert.equal(bridgeCalls, stage === 'bridge' ? 1 : 0);
    assert.equal(bridgeReleases, stage === 'bridge' ? 1 : 0, 'An allocated bridge is released even when interruption wins its setup race');
    assert(f.canceledSessions.includes(f.host.id));
    assert.equal(f.counts.container, 0); assert.equal(f.counts.ensure, 0);
  });
});

test('autonomous host decisions retain private cwd and service admission with distinct durable session ownership', { timeout: 10_000 }, async t => {
  const f = fixture(t), chat = f.createChat();
  f.manager.runTurn = async (input, callbacks) => {
    f.turns.push({ input, callbacks });
    if (input.chatId !== chat.id) return { text: '{"choice":{"answers":["preserve existing behavior"]}}' };
    const answers = await callbacks.onQuestion!({ id: 'question', chatId: chat.id, questions: [{ id: 'choice', question: 'Choose behavior' }] }, new AbortController().signal);
    assert.deepEqual(answers, { choice: { answers: ['preserve existing behavior'] } });
    return { text: 'decision applied' };
  };
  await f.controller.run(chat.id, 'Continue the native goal', { autonomous: true });
  const decision = f.turns[1]!.input;
  assert.equal(decision.executionTarget, 'host-macos'); assert.equal(decision.cwd, f.turns[0]!.input.cwd);
  assert(decision.sessionId.startsWith(`${f.host.id}-decision-`)); assert.notEqual(decision.sessionId, f.host.id);
  assert.equal(decision.approvalMode, 'approve-all'); assert.equal(decision.mcpServers, undefined);
  assert.equal(f.counts.service, 2); assert.equal(f.counts.container, 0); assert.equal(f.counts.ensure, 0);
});

test('session stop cancels retained main and decision processes before capture; unknown ownership preserves the session', { timeout: 10_000 }, async t => {
  for (const state of ['active', 'unknown-main', 'unknown-decision'] as const) await t.test(state, async t => {
    const f = fixture(t), chat = f.createChat();
    f.store.set('chats', { ...chat, status: 'interrupted' as const });
    const derived = `${f.host.id}-decision-answer_retained`;
    f.processes.push(f.process(f.host.id, state === 'unknown-main' ? 'unknown' : 'active'), f.process(derived, state === 'unknown-decision' ? 'unknown' : 'active'), f.process(`${f.host.id}-decision-old`, 'exited'), f.process('native-session-other-decision-unrelated', 'active'));
    assert.equal(f.controller.isRunning(chat.id), false, 'Durable process cancellation must not depend on an in-memory turn');
    if (state !== 'active') {
      await assert.rejects(f.sessions.stop(f.host.id), /ownership is unknown/);
      assert.equal(f.sessions.record(f.host.id).status, 'unknown');
      assert.equal(f.order.includes(`capture:${f.host.id}`), false);
      assert.equal(f.processes.find(process => process.sessionId === (state === 'unknown-main' ? f.host.id : derived))?.state, 'unknown');
    } else {
      await f.sessions.stop(f.host.id);
      assert.equal(f.sessions.record(f.host.id).status, 'stopped');
      assert(f.order.indexOf(`cancel:${f.host.id}`) < f.order.indexOf(`capture:${f.host.id}`));
      assert(f.order.indexOf(`cancel:${derived}`) < f.order.indexOf(`capture:${f.host.id}`));
      assert.equal(f.processes.find(process => process.sessionId === derived)?.state, 'exited');
    }
    assert.deepEqual(f.canceledSessions, state === 'unknown-main' ? [f.host.id] : [f.host.id, derived]);
    assert.equal(f.processes.at(-1)?.state, 'active', 'A session with only a similar prefix is not owned by this chat');
    assert.equal(f.counts.ensure, 0); assert.equal(f.counts.container, 0);
  });
});

test('stopping Docker interrupts container turns while native authoring remains active', { timeout: 10_000 }, async t => {
  const f = fixture(t), nativeChat = f.createChat(), container = f.addSession('container-session', 'container'), containerChat = f.createChat(container.id);
  f.manager.runTurn = f.holdTurn;
  f.runtime.suspended = false;
  const nativeRun = f.controller.run(nativeChat.id, 'Continue native authoring');
  const containerRun = f.controller.run(containerChat.id, 'Continue container authoring');
  const interruptedContainer = assert.rejects(containerRun, /interrupted/);
  while (f.turns.length < 2) await new Promise<void>(resolve => setImmediate(resolve));
  f.runtime.suspended = true;
  for (const hook of f.app.runtimeStopHooks) await hook();
  await interruptedContainer;
  assert.equal(f.controller.get(containerChat.id).status, 'interrupted');
  assert.equal(f.controller.isRunning(nativeChat.id), true); assert.equal(f.controller.get(nativeChat.id).status, 'running');
  assert.equal(f.interrupted.includes(nativeChat.id), false); assert.equal(f.canceledSessions.includes(f.host.id), false);
  assert.equal(f.serviceSignals.every(signal => !signal.aborted), true);
  f.pending.get(nativeChat.id)!.resolve({ text: 'Native work survived Docker stop.' });
  assert.equal((await nativeRun).text, 'Native work survived Docker stop.');
  assert.equal(f.counts.ensure, 0);
});
