import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Session, ChatEvent } from '@enoughfactory/contracts';
import type { FactoryStore } from '@enoughfactory/factory';
import { ArtifactStore, WorkingDirectoryManager, type WorkingDirectorySource } from '@enoughfactory/workspaces';
import { controllerError } from './factory-controller-error.ts';
import { releaseControllerInputs } from './factory-controller-inputs.ts';
import { releaseFactoryCodexPayload } from './factory-codex-cleanup.ts';
import { SessionController } from './sessions.ts';
import type { Store } from './store.ts';
import type { EnvmuxSession } from '@enoughfactory/envmux';

test('controller recovery requires both known preparation and a transient failure', () => {
  const cases = [
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (56) OpenSSL unexpected EOF', agentStarted: false, recovery: 'retry' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (56) OpenSSL unexpected EOF', agentStarted: true, recovery: 'controller-retry-required' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (56) OpenSSL unexpected EOF', recovery: 'controller-retry-required' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'curl: (60) Certificate validation failed', agentStarted: false, recovery: 'controller-retry-required' },
    { code: 'CONTAINER_COMMAND_FAILED', message: 'Required file is missing', agentStarted: false, recovery: 'controller-retry-required' },
    { code: 'RUNTIME_TIMEOUT', message: 'Container command timed out', agentStarted: false, recovery: 'retry' },
    { code: 'RUNTIME_TIMEOUT', message: 'Provider acknowledgement timed out', agentStarted: true, recovery: 'controller-retry-required' },
    { code: 'RUNTIME_PAUSED', message: 'Start the runtime to continue', recovery: 'runtime-available' },
    { code: 'RUNTIME_MISSING', message: 'Provider runtime is not installed', agentStarted: false, recovery: 'runtime-configured' },
    { code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue', recovery: 'credentials-changed' },
    { code: 'QUOTA_EXCEEDED', message: 'Provider quota exceeded', recovery: 'provider-available' },
    { code: 'AGENT_TURN_FAILED', message: 'Sign in to continue', recovery: 'controller-retry-required' },
  ];
  for (const entry of cases) {
    const error = Object.assign(new Error(entry.message), { code: entry.code, ...('agentStarted' in entry ? { agentStarted: entry.agentStarted } : {}) });
    const result = controllerError(error, { providerInvoked: true, runtimeReady: true });
    assert.equal(result.recovery, entry.recovery, `${entry.code}: ${entry.message}; started=${entry.agentStarted}`);
    assert.equal(result.message, entry.message);
    assert.equal(result.cause, error);
  }
  assert.equal(controllerError(Object.assign(new Error('Connection reset before the provider'), { code: 'ECONNRESET' }), { providerInvoked: false, runtimeReady: true }).recovery, 'retry');
  assert.equal(controllerError(new Error('The owned VM could not start'), { providerInvoked: false, runtimeReady: false }).recovery, 'runtime-available');
  assert.equal(controllerError(new Error('Unknown provider outcome'), { providerInvoked: true, runtimeReady: false }).recovery, 'controller-retry-required');
});

async function controllerInputFixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'enough-controller-cleanup-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const operation = randomUUID(), sessionId = `session-${randomUUID()}`;
  const tables = new Map<string, Map<string, unknown>>();
  const store: FactoryStore = {
    list: <T>(table: string) => [...(tables.get(table)?.values() ?? [])] as T[],
    get: <T>(table: string, id: string) => tables.get(table)?.get(id) as T | undefined,
    set: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(value.id, value); },
    delete: (table, id) => { tables.get(table)?.delete(id); }, transaction: fn => fn(),
  };
  const workspaceData = path.join(dataDir, 'workspace-data');
  const artifacts = new ArtifactStore(path.join(workspaceData, 'artifacts'), 'device');
  const directoryManager = new WorkingDirectoryManager({ dataDir: workspaceData, artifacts });
  const source = path.join(dataDir, 'authored-reference');
  await mkdir(source); await writeFile(path.join(source, 'README.md'), 'Retained immutable input\n');
  const snapshots = await directoryManager.prepare({ identity: `${operation}-project-context`, sources: [{ id: 'reference', name: 'reference', path: source }] });
  const transferred: WorkingDirectorySource[] = snapshots.map(({ path: _, ...snapshot }) => snapshot);
  await directoryManager.prepare({ identity: `${operation}-evidence-context`, transferred });
  await directoryManager.prepare({ identity: sessionId, transferred });
  store.set('sessions', { id: sessionId, projectId: `workspace-${operation}`, status: 'ready' });
  store.set('session-launch', { id: sessionId, workingDirectorySources: transferred });
  store.set('factory-controller-inputs', { id: operation, goalId: 'goal', role: 'planner', status: 'prepared' });
  const sessions: Parameters<typeof releaseControllerInputs>[0]['sessions'] = {
    record: id => store.get<Session>('sessions', id)!, owns: () => true,
    needsTermination: id => store.get<Session>('sessions', id)?.status !== 'stopped',
    stop: async id => { store.set('sessions', { ...store.get<Session>('sessions', id)!, status: 'stopped' }); },
    waitStopped: async id => { const session = store.get<Session>('sessions', id)!; assert.equal(session.status, 'stopped'); return session; },
    assertCanArchive: id => assert.equal(store.get<Session>('sessions', id)?.status, 'stopped'),
  };
  const primary = path.join(workspaceData, 'workspaces', operation, 'repository', 'controller-output.md');
  await mkdir(path.dirname(primary), { recursive: true }); await writeFile(primary, 'Unexpected controller edits survive\n');
  const unknown = path.join(workspaceData, 'working-directories', 'unknown-worker', 'output.txt');
  await mkdir(path.dirname(unknown), { recursive: true }); await writeFile(unknown, 'Authored worker output\n');
  return { operation, sessionId, dataDir, store, sessions, directoryManager, artifacts, source, transferred, primary, unknown, workspaceData };
}

test('controller input cleanup confirms stop, archives evidence and permits a normal source restart', async t => {
  const f = await controllerInputFixture(t);
  await releaseControllerInputs({ ...f, sessionId: undefined });
  assert.equal(f.sessions.record(f.sessionId).status, 'stopped');
  for (const identity of [`${f.operation}-project-context`, `${f.operation}-evidence-context`, f.sessionId]) {
    await assert.rejects(readFile(path.join(f.workspaceData, 'working-directories', identity, 'snapshots.json')), /ENOENT/);
    const receipt = JSON.parse(await readFile(path.join(f.workspaceData, 'controller-input-receipts', f.operation, `${identity}.json`), 'utf8'));
    assert.equal(receipt.journal.identity, identity); assert.equal(receipt.journal.snapshots[0].sourceArtifact.id, f.transferred[0]!.sourceArtifact.id);
  }
  assert.equal(f.store.get<{ status: string }>('factory-controller-inputs', f.operation)?.status, 'released');
  assert.equal(await readFile(f.primary, 'utf8'), 'Unexpected controller edits survive\n');
  assert.equal(await readFile(f.unknown, 'utf8'), 'Authored worker output\n');
  assert.equal(await readFile(path.join(f.source, 'README.md'), 'utf8'), 'Retained immutable input\n');
  const launch = f.store.get<{ workingDirectorySources: WorkingDirectorySource[] }>('session-launch', f.sessionId)!;
  assert.deepEqual(await f.directoryManager.sourceSnapshots(f.sessionId), []);
  const restored = await f.directoryManager.prepare({ identity: f.sessionId, transferred: launch.workingDirectorySources });
  assert.equal(await readFile(path.join(restored[0]!.path, 'README.md'), 'utf8'), 'Retained immutable input\n');
  await f.artifacts.path(await f.artifacts.get(f.transferred[0]!.sourceArtifact.id));
});

test('controller input cleanup preserves unknown execution even when needsTermination is false', async t => {
  const f = await controllerInputFixture(t);
  f.store.set('sessions', { ...f.sessions.record(f.sessionId), status: 'unknown' });
  f.sessions.needsTermination = () => false;
  f.sessions.stop = async () => { throw new Error('Owner has not confirmed termination'); };
  await assert.rejects(releaseControllerInputs(f), /not confirmed termination/);
  assert.equal((await f.directoryManager.sourceSnapshots(f.sessionId)).length, 1);
  assert.equal((await f.directoryManager.sourceSnapshots(`${f.operation}-project-context`)).length, 1);
});

test('controller preparation failure releases completed generated inputs without an environment', async t => {
  const f = await controllerInputFixture(t);
  f.store.delete('sessions', f.sessionId);
  await releaseControllerInputs({ ...f, sessionId: undefined });
  assert.deepEqual(await f.directoryManager.sourceSnapshots(`${f.operation}-project-context`), []);
  assert.deepEqual(await f.directoryManager.sourceSnapshots(`${f.operation}-evidence-context`), []);
  assert.equal((await f.directoryManager.sourceSnapshots(f.sessionId)).length, 1, 'An unowned identity is not swept');
});

test('controller input cleanup requires durable launch sources and receipts before deleting copies', async t => {
  const f = await controllerInputFixture(t);
  f.store.set('session-launch', { id: f.sessionId });
  await assert.rejects(releaseControllerInputs(f), /restart sources are not retained/);
  assert.equal((await f.directoryManager.sourceSnapshots(f.sessionId)).length, 1);
  f.store.set('session-launch', { id: f.sessionId, workingDirectorySources: f.transferred });
  const set = f.store.set;
  f.store.set = (table, value) => { if (table === 'factory-controller-inputs') throw new Error('Cleanup journal is full'); set(table, value); };
  await assert.rejects(releaseControllerInputs(f), /Cleanup journal is full/);
  assert.equal((await f.directoryManager.sourceSnapshots(`${f.operation}-project-context`)).length, 1);
  assert.equal((await f.directoryManager.sourceSnapshots(`${f.operation}-evidence-context`)).length, 1);
  assert.equal((await f.directoryManager.sourceSnapshots(f.sessionId)).length, 1);
});

function payloadCleanupFixture(kind: 'controller' | 'worker' | 'ordinary' = 'controller') {
  const tables = new Map<string, Map<string, unknown>>();
  const store: FactoryStore = {
    list: <T>(table: string) => [...(tables.get(table)?.values() ?? [])] as T[],
    get: <T>(table: string, id: string) => tables.get(table)?.get(id) as T | undefined,
    set: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(value.id, value); },
    delete: (table, id) => { tables.get(table)?.delete(id); }, transaction: fn => fn(),
  };
  const sessionId = 'session', chatId = 'chat', operation = 'operation';
  store.set('sessions', { id: sessionId, projectId: `workspace-${operation}`, containerId: 'owned-container', status: 'stopping' });
  store.set('chats', { id: chatId, sessionId, runtime: 'codex', status: 'idle' });
  store.set('chat-results', { id: chatId, result: { text: 'Durable completed result' }, ...(kind === 'worker' ? { attemptId: operation } : {}) });
  if (kind === 'controller') store.set('factory-controller-runs', { id: operation, sessionId, chatId, status: 'completed' });
  if (kind === 'worker') store.set('factory-workers', { id: operation, sessionId, chatId, status: 'succeeded', workspace: { id: operation, provider: 'git' } });
  let calls = 0;
  const messages: string[] = [];
  const input: Parameters<typeof releaseFactoryCodexPayload>[0] = {
    store,
    sessions: { record: id => store.get<Session>('sessions', id)!, owns: () => true, get: () => ({ ready: { instance: 'owned-container' } }) as EnvmuxSession },
    chats: { isRunning: () => false, event: (_id, event) => { messages.push(event.text ?? ''); return {} as ChatEvent; } },
    manager: { releaseCodexPayload: async containerId => { assert.equal(containerId, 'owned-container'); calls++; return { status: 'released' }; } },
  };
  return { input, sessionId, store, messages, calls: () => calls };
}

test('factory Codex cleanup requires retained completed results and exact source ownership', async () => {
  const controller = payloadCleanupFixture();
  await releaseFactoryCodexPayload(controller.input, controller.sessionId);
  assert.equal(controller.calls(), 1);
  assert.equal(controller.store.get<{ status: string }>('session-runtime-cleanup', controller.sessionId)?.status, 'released');
  const worker = payloadCleanupFixture('worker');
  await releaseFactoryCodexPayload(worker.input, worker.sessionId);
  assert.equal(worker.calls(), 0, 'Unconfirmed source capture retains the installation');
  assert.match(worker.messages[0]!, /source capture has not been confirmed/);
  worker.store.set('factory-capture-input', { id: 'operation', commit: 'a'.repeat(40) });
  await releaseFactoryCodexPayload(worker.input, worker.sessionId);
  assert.equal(worker.calls(), 1);
  assert(worker.store.get('chat-results', 'chat'), 'Cleanup preserves durable chat evidence');
  const ordinary = payloadCleanupFixture('ordinary');
  await releaseFactoryCodexPayload(ordinary.input, ordinary.sessionId); assert.equal(ordinary.calls(), 0);
  const active = payloadCleanupFixture(); active.input.chats.isRunning = () => true;
  await releaseFactoryCodexPayload(active.input, active.sessionId); assert.equal(active.calls(), 0);
  assert.match(active.messages[0]!, /still active/);
  active.store.delete('chat-results', 'chat'); active.input.chats.isRunning = () => false;
  await releaseFactoryCodexPayload(active.input, active.sessionId); assert.equal(active.calls(), 0);
  const unknown = payloadCleanupFixture(); unknown.store.set('factory-controller-runs', { id: 'operation', sessionId: 'session', chatId: 'chat', status: 'interrupted' });
  await releaseFactoryCodexPayload(unknown.input, unknown.sessionId); assert.equal(unknown.calls(), 0);
});

test('post-capture runtime cleanup preserves payload on failed capture and runs before engine stop', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'enough-post-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = payloadCleanupFixture();
  const endpoint = { host: 'unix:///unused/private.sock', cliPath: '/unused/docker', configDirectory: path.join(root, 'config') };
  const sessions = new SessionController(f.store as Store, 'device', () => {}, () => {}, { endpoint, ensureReady: async () => assert.fail('No runtime start'), bridgeHostAddress: () => undefined }, root);
  t.after(() => sessions.close());
  const order: string[] = [];
  let captureFails = true;
  const engine = { stop: async () => { order.push('engine-stop'); } } as EnvmuxSession;
  (sessions as unknown as { live: Map<string, EnvmuxSession> }).live.set(f.sessionId, engine);
  sessions.captureWorkingDirectories = async () => { order.push('capture'); if (captureFails) throw new Error('Capture failed'); return []; };
  sessions.afterCaptureBeforeStop.push(async () => { order.push('release-payload'); });
  await assert.rejects(sessions.stop(f.sessionId), /Capture failed/);
  assert.deepEqual(order, ['capture']);
  captureFails = false;
  await sessions.stop(f.sessionId);
  assert.deepEqual(order, ['capture', 'capture', 'release-payload', 'engine-stop']);
});
