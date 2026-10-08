import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Chat, Project, Session } from '@enoughfactory/contracts';
import { ArtifactStore, WorkspaceManager, type WorkingDirectoryCapture } from '@enoughfactory/workspaces';
import { git } from '../../../packages/workspaces/src/process.ts';
import { SessionController, type HostLaunchOptions } from './sessions.ts';
import type { HostWorkspacePrepared } from './host-workspaces.ts';
import { Store } from './store.ts';

const nativeMac = { skip: process.platform !== 'darwin' };

async function fixture(t: TestContext, extras = true) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'enough-host-sessions-')));
  const workspaceDataDir = path.join(directory, 'owned', 'workspace-data');
  const primary = path.join(directory, 'primary'), library = path.join(directory, 'library');
  for (const cwd of [primary, library]) {
    await mkdir(cwd);
    await git(cwd, 'init', '--quiet');
    await git(cwd, 'config', 'user.name', 'Fixture');
    await git(cwd, 'config', 'user.email', 'fixture@example.test');
    await writeFile(path.join(cwd, 'source.txt'), 'user source\n');
    await git(cwd, 'add', '.');
    await git(cwd, 'commit', '--quiet', '-m', 'baseline');
  }
  const project: Project = {
    id: 'project', name: 'Native fixture', path: primary, deviceId: 'fixture',
    createdAt: new Date().toISOString(), runtime: 'codex', approvalMode: 'approve-all', rules: [],
    workingDirectories: extras ? [{ id: 'library', name: 'library', path: library }] : [],
  };
  const endpoint = { host: 'unix:///unused-host-only-fixture.sock', configDirectory: path.join(directory, 'runtime', 'docker'), cliPath: '/must-not-run-docker' };
  const stores = new Set<Store>(), controllers: SessionController[] = [];
  const forbiddenCalls: string[] = [];
  const makeController = (store: Store, deviceId = 'fixture') => {
    const sessions = new SessionController(store, deviceId, () => {}, () => {}, {
      endpoint,
      ensureReady: async () => { forbiddenCalls.push('ensureReady'); throw new Error('A host session must not start the container runtime'); },
      bridgeHostAddress: () => undefined,
    }, workspaceDataDir);
    Object.defineProperty(sessions, 'engine', { value: new Proxy({}, {
      get(_target, method) { return () => { forbiddenCalls.push(String(method)); throw new Error(`A host session must not call envmux.${String(method)}`); }; },
    }) });
    controllers.push(sessions);
    return sessions;
  };
  const store = new Store(path.join(directory, 'state')); stores.add(store); store.set('projects', project);
  const sessions = makeController(store);
  const workspaces = new WorkspaceManager({ dataDir: workspaceDataDir, deviceId: 'fixture', checkExecutor: async () => assert.fail('Host session lifecycle does not need a check runtime') });
  const workspace = await workspaces.create({ projectPath: primary, goalId: 'goal', taskId: 'task', attemptId: 'attempt', executionTargetKind: 'host-macos' });
  const sources = await sessions.workingDirectorySources('selected-inputs', project);
  const options = { workspace, workingDirectorySources: sources, executionTargetId: 'fixture:configured-mac' };
  const create = (overrides: Partial<HostLaunchOptions> = {}) => sessions.createHost(project, 'native-work', { ...options, ...overrides });
  const reopen = () => {
    sessions.close(); store.close(); stores.delete(store);
    const reopenedStore = new Store(path.join(directory, 'state')); stores.add(reopenedStore);
    return { store: reopenedStore, sessions: makeController(reopenedStore) };
  };
  const artifacts = new ArtifactStore(path.join(workspaceDataDir, 'artifacts'), 'fixture');
  t.after(async () => {
    for (const controller of controllers) controller.close();
    for (const openStore of stores) openStore.close();
    await writable(directory); await rm(directory, { recursive: true, force: true });
    assert.deepEqual(forbiddenCalls, [], 'Every host lifecycle operation must remain Docker and envmux independent');
  });
  return { directory, workspaceDataDir, primary, library, project, store, sessions, workspaces, workspace, sources, options, artifacts, create, reopen, makeController };
}

function chat(sessionId: string, status: Chat['status']): Chat {
  return { id: 'chat', sessionId, deviceId: 'fixture', title: 'Native work', runtime: 'codex', approvalMode: 'approve-all', status, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

test('native sessions retain private multi-root work across stop, SQLite reopen and restart without a container', nativeMac, async t => {
  const f = await fixture(t), session = await f.create();
  const execution = await f.sessions.waitExecutionReady(session.id, 1000);
  assert.equal(session.status, 'ready');
  assert.equal(session.executionTargetKind, 'host-macos');
  assert.equal(session.executionTargetId, f.options.executionTargetId);
  assert.equal(session.containerId, undefined);
  assert.equal(session.enginePid, undefined);
  assert.equal(execution.kind, 'host-macos');
  assert.equal(execution.workdir, f.workspace.path);
  assert.equal(execution.containerId, undefined);
  assert.notEqual(execution.workdir, f.primary);
  assert.equal(f.sessions.owns(session.id), true);
  assert.equal(f.sessions.needsTermination(session.id), true);
  assert.equal(f.sessions.canRetireEnvironment(session.id), false);
  assert.throws(() => f.sessions.get(session.id), /has no container/);
  assert.throws(() => f.sessions.retirementContainerName(session.id), /has no container/);
  assert.equal(f.store.get('session-private', session.id), undefined);
  assert.deepEqual(f.store.list('session-container-owner'), []);
  const launch = f.store.get<Record<string, unknown>>('session-launch', session.id)!;
  assert.equal(launch.executionTargetId, f.options.executionTargetId);
  assert.equal(launch.dockerHost, undefined);
  const root = session.workingDirectories![0]!;
  assert(root.path.startsWith(path.join(f.workspaceDataDir, 'host-sessions', session.id, 'roots')));
  assert.notEqual(root.path, f.library);
  await writeFile(path.join(execution.workdir, 'source.txt'), 'native primary edits\n');
  await writeFile(path.join(root.path, 'source.txt'), 'native library edits\n');
  assert.match((await f.sessions.changes(session.id, 'source.txt')).diff, /native primary edits/);
  assert.match((await f.sessions.changes(session.id, 'source.txt', root.id)).diff, /native library edits/);
  assert.equal(await readFile(path.join(f.primary, 'source.txt'), 'utf8'), 'user source\n');
  assert.equal(await readFile(path.join(f.library, 'source.txt'), 'utf8'), 'user source\n');
  const stoppedBy: string[] = [];
  f.sessions.beforeStop.push(async id => { stoppedBy.push(id); assert.equal(f.sessions.record(id).status, 'stopping'); });
  f.sessions.afterCaptureBeforeStop.push(async () => assert.fail('Container worktree handoff is not part of a host stop'));
  await f.sessions.stop(session.id);
  assert.deepEqual(stoppedBy, [session.id]);
  assert.equal((await f.sessions.waitStopped(session.id, 1000)).status, 'stopped');
  assert.equal(f.sessions.needsTermination(session.id), false);
  const captures = await f.sessions.captureWorkingDirectories(session.id);
  assert.equal(captures.length, 1);
  assert.equal(f.sessions.record(session.id).workingDirectories![0]!.status, 'captured');
  for (const artifact of [captures[0]!.bundleArtifact, captures[0]!.diffArtifact]) {
    assert.deepEqual(f.store.get('artifacts', artifact.id), artifact);
    await f.artifacts.path(artifact);
  }
  const inspection = path.join(f.workspaceDataDir, 'retained-library');
  await f.sessions.directoryManager.importCapture(captures[0]!, inspection);
  assert.equal(await readFile(path.join(inspection, 'source.txt'), 'utf8'), 'native library edits\n');
  const reopened = f.reopen();
  await reopened.sessions.recover();
  assert.equal(reopened.sessions.record(session.id).status, 'stopped');
  await reopened.sessions.restart(session.id);
  assert.equal(reopened.sessions.record(session.id).status, 'ready');
  assert.deepEqual(await reopened.sessions.waitExecutionReady(session.id, 1000), execution);
  assert.equal(reopened.sessions.record(session.id).executionTargetId, f.options.executionTargetId);
  assert.equal(await readFile(path.join(root.path, 'source.txt'), 'utf8'), 'native library edits\n');
  assert.equal(await readFile(path.join(execution.workdir, 'source.txt'), 'utf8'), 'native primary edits\n');
  await writeFile(path.join(root.path, 'source.txt'), 'continued native library edits\n');
  await reopened.sessions.stop(session.id);
  const continued = await reopened.sessions.captureWorkingDirectories(session.id);
  assert.notEqual(continued[0]!.commit, captures[0]!.commit);
  const continuedInspection = path.join(f.workspaceDataDir, 'continued-library');
  await reopened.sessions.directoryManager.importCapture(continued[0]!, continuedInspection);
  assert.equal(await readFile(path.join(continuedInspection, 'source.txt'), 'utf8'), 'continued native library edits\n');
  assert.equal(await readFile(path.join(inspection, 'source.txt'), 'utf8'), 'native library edits\n');
  for (const artifact of [captures[0]!.bundleArtifact, captures[0]!.diffArtifact]) await f.artifacts.path(artifact);
});

test('unconfirmed native stop and active chat retain files and require reconciliation before release', nativeMac, async t => {
  const f = await fixture(t), session = await f.create(), root = session.workingDirectories![0]!;
  await writeFile(path.join(root.path, 'source.txt'), 'unfinished native work\n');
  f.sessions.beforeStop.push(async () => { throw new Error('Native provider process identity is still unknown'); });
  await assert.rejects(f.sessions.stop(session.id), /process identity is still unknown/);
  assert.equal(f.sessions.record(session.id).status, 'unknown');
  assert.equal(f.sessions.needsTermination(session.id), true);
  assert.equal(f.store.get('session-working-directory-captures', session.id), undefined);
  await assert.rejects(f.sessions.disposeHostWorkspace(session.id), /Stop this environment/);
  assert.equal(await readFile(path.join(root.path, 'source.txt'), 'utf8'), 'unfinished native work\n');
  f.sessions.beforeStop.length = 0;
  f.store.set('chats', chat(session.id, 'running'));
  await assert.rejects(f.sessions.restart(session.id), /native agent has stopped/);
  await assert.rejects(f.sessions.stop(session.id), /active agent/);
  assert.equal(f.sessions.record(session.id).status, 'unknown');
  f.store.set('chats', chat(session.id, 'interrupted'));
  await f.sessions.stop(session.id);
  assert.equal(f.sessions.record(session.id).status, 'stopped');
  assert.equal((await f.sessions.captureWorkingDirectories(session.id)).length, 1);
});

test('native recovery preserves uncertainty for interrupted preparation and missing owner bindings', nativeMac, async t => {
  const f = await fixture(t), session = await f.create();
  await writeFile(path.join(f.workspace.path, 'recovery.txt'), 'retain on restart\n');
  f.store.set('sessions', { ...session, status: 'starting' });
  const recovered = f.makeController(f.store);
  await recovered.recover();
  assert.equal(recovered.record(session.id).status, 'unknown');
  assert.match(recovered.record(session.id).phase!, /restarted during native workspace preparation/);
  await recovered.restart(session.id);
  assert.equal(recovered.record(session.id).status, 'ready');
  assert.equal(await readFile(path.join(recovered.execution(session.id).workdir, 'recovery.txt'), 'utf8'), 'retain on restart\n');
  const unbound: Session = { ...session, id: 'unbound-ready', name: 'unbound-ready', status: 'ready' };
  f.store.set('sessions', unbound);
  await recovered.recover();
  assert.equal(recovered.record(unbound.id).status, 'unknown');
  assert.throws(() => recovered.execution(unbound.id), /workspace is unavailable/);
  await assert.rejects(recovered.restart(unbound.id), /owner is unavailable/);
});

test('changed native workspace ownership or private binding cannot authorize restart', nativeMac, async t => {
  const f = await fixture(t), session = await f.create();
  const saved = f.store.get<{ id: string; deviceId: string; prepared: HostWorkspacePrepared }>('session-host', session.id)!;
  f.store.set('session-host', { ...saved, deviceId: 'other-device' });
  assert.equal(f.sessions.owns(session.id), false);
  await f.sessions.recover();
  assert.equal(f.sessions.record(session.id).status, 'unknown');
  await assert.rejects(f.sessions.restart(session.id), /owner is unavailable/);
  f.store.set('session-host', saved);
  f.store.set('sessions', { ...session, deviceId: 'other-device' });
  assert.equal(f.sessions.owns(session.id), false);
  await assert.rejects(f.sessions.restart(session.id), /owner|ownership/);
  f.store.set('sessions', session);
  f.store.set('session-host', { ...saved, prepared: { ...saved.prepared, roots: saved.prepared.roots.map(root => ({ ...root, path: f.library })) } });
  await assert.rejects(f.sessions.restart(session.id), /identity changed/);
  f.store.set('session-host', { ...saved, prepared: { ...saved.prepared, cwd: f.primary } });
  await assert.rejects(f.sessions.restart(session.id), /identity changed/);
  assert.equal(await readFile(path.join(f.primary, 'source.txt'), 'utf8'), 'user source\n');
});

test('cancel after native preparation retains the binding and captures every prepared root', nativeMac, async t => {
  const f = await fixture(t);
  let prepared!: () => void, release!: () => void;
  const preparedSignal = new Promise<void>(resolve => { prepared = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let created: Session | undefined;
  const prepare = f.sessions.hostWorkspaces.prepare.bind(f.sessions.hostWorkspaces);
  f.sessions.hostWorkspaces.prepare = async input => {
    assert.equal(created?.id, input.sessionId, 'The factory can durably bind the session before preparation returns');
    const result = await prepare(input);
    await writeFile(path.join(result.roots[0]!.path, 'during-preparation.txt'), 'work survives canceled admission\n');
    prepared(); await released; return result;
  };
  const creating = f.create({ onCreated: session => {
    created = session;
    assert.equal(session.status, 'starting');
    assert.deepEqual(f.store.get('sessions', session.id), session);
    assert.equal(f.store.get<{ executionTargetId: string }>('session-launch', session.id)?.executionTargetId, f.options.executionTargetId);
    assert.equal(f.store.get('session-host', session.id), undefined);
  } });
  // Attach rejection handling before cancellation can settle the create request.
  const canceled = assert.rejects(creating, /newer environment connection|canceled/);
  await preparedSignal;
  const session = f.store.list<Session>('sessions')[0]!;
  const stopping = f.sessions.stop(session.id);
  release(); await canceled; await stopping;
  assert.equal(f.sessions.record(session.id).status, 'stopped');
  assert.equal(f.sessions.owns(session.id), true);
  assert.equal(f.sessions.record(session.id).workingDirectories?.length, 1);
  const captures = await f.sessions.captureWorkingDirectories(session.id);
  assert.equal(captures.length, 1);
  const destination = path.join(f.workspaceDataDir, 'canceled-root');
  await f.sessions.directoryManager.importCapture(captures[0]!, destination);
  assert.equal(await readFile(path.join(destination, 'during-preparation.txt'), 'utf8'), 'work survives canceled admission\n');
  await f.sessions.restart(session.id);
  assert.equal(f.sessions.execution(session.id).workdir, f.workspace.path);
});

test('retained native inputs cannot restart during release and disposal leaves source and captures durable', nativeMac, async t => {
  const f = await fixture(t), session = await f.create();
  await writeFile(path.join(session.workingDirectories![0]!.path, 'output.txt'), 'retained output\n');
  await f.sessions.stop(session.id);
  const captures = await f.sessions.captureWorkingDirectories(session.id);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const releasing = f.sessions.withStoppedInputs(session.id, async () => { entered(); await held; await f.sessions.disposeHostWorkspace(session.id); });
  await started;
  try { await assert.rejects(f.sessions.restart(session.id), /retained input copies.*releasing/); }
  finally { release(); }
  await releasing;
  assert.throws(() => f.sessions.execution(session.id), /workspace is unavailable/);
  await assert.rejects(f.sessions.restart(session.id), /owner is unavailable/);
  await assert.rejects(readFile(path.join(session.workingDirectories![0]!.path, 'output.txt')), /ENOENT/);
  assert.equal(await readFile(path.join(f.workspace.path, 'source.txt'), 'utf8'), 'user source\n');
  assert.equal(await readFile(path.join(f.primary, 'source.txt'), 'utf8'), 'user source\n');
  const retained = f.store.get<{ roots: WorkingDirectoryCapture[] }>('session-working-directory-captures', session.id)!;
  assert.deepEqual(retained.roots, captures);
  for (const artifact of [captures[0]!.bundleArtifact, captures[0]!.diffArtifact]) await f.artifacts.path(artifact);
});

test('unexpected edits after a confirmed native stop cannot silently replace retained captures on restart', nativeMac, async t => {
  const f = await fixture(t), session = await f.create();
  await f.sessions.stop(session.id);
  const captures = await f.sessions.captureWorkingDirectories(session.id);
  const root = session.workingDirectories![0]!;
  await writeFile(path.join(root.path, 'source.txt'), 'unreconciled post-stop edits\n');
  await assert.rejects(f.sessions.restart(session.id), /changed after.*capture/);
  assert.equal(f.sessions.record(session.id).status, 'stopped');
  await assert.rejects(f.sessions.captureWorkingDirectories(session.id), /changed after.*capture/);
  assert.deepEqual(f.store.get<{ roots: WorkingDirectoryCapture[] }>('session-working-directory-captures', session.id)?.roots, captures);
  await assert.rejects(f.sessions.disposeHostWorkspace(session.id), /changed after.*capture/);
  assert.equal(await readFile(path.join(root.path, 'source.txt'), 'utf8'), 'unreconciled post-stop edits\n');
  for (const artifact of [captures[0]!.bundleArtifact, captures[0]!.diffArtifact]) await f.artifacts.path(artifact);
});

async function writable(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => {});
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await writable(target);
    else if (!entry.isSymbolicLink()) await chmod(target, 0o600).catch(() => {});
  }
}
