import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { FactoryStore } from '@enoughfactory/factory';
import { ArtifactStore, WorkingDirectoryManager, type Candidate, type CheckReport, type WorkingDirectorySource } from '@enoughfactory/workspaces';
import { releaseCoordinatorWorkerInputs, releaseGoalCheckInputs, releaseWorkerInputs } from './factory-worker-inputs.ts';
import { SessionController } from './sessions.ts';
import type { Store } from './store.ts';
import { exec } from './util.ts';

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'enough-worker-inputs-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const tables = new Map<string, Map<string, unknown>>();
  const store: FactoryStore = {
    list: <T>(table: string) => structuredClone([...(tables.get(table)?.values() ?? [])]) as T[],
    get: <T>(table: string, id: string) => structuredClone(tables.get(table)?.get(id)) as T | undefined,
    set: (table, record) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(record.id, JSON.parse(JSON.stringify(record))); },
    delete: (table, id) => { tables.get(table)?.delete(id); }, transaction: operation => operation(),
  };
  const attemptId = randomUUID(), sessionId = `session-${randomUUID()}`, workspaceData = path.join(dataDir, 'workspace-data');
  const artifacts = new ArtifactStore(path.join(workspaceData, 'artifacts'), 'device');
  const directoryManager = new WorkingDirectoryManager({ dataDir: workspaceData, artifacts });
  const source = path.join(dataDir, 'user-source');
  await mkdir(source); await writeFile(path.join(source, 'README.md'), 'Original selected folder\n');
  const snapshots = await directoryManager.prepare({ identity: attemptId, sources: [{ id: 'reference', name: 'reference', path: source }] });
  const sources: WorkingDirectorySource[] = snapshots.map(({ path: _, ...value }) => value);
  const sessionSnapshots = await directoryManager.prepare({ identity: sessionId, transferred: sources });
  const output = path.join(workspaceData, 'owned-export');
  await mkdir(output); await writeFile(path.join(output, 'README.md'), 'Agent-authored retained output\n');
  const capture = await directoryManager.captureFromPath(sessionSnapshots[0]!, output, { goalId: 'goal', taskId: 'task', attemptId });
  const candidate: Candidate = { id: randomUUID(), workspaceId: attemptId, attemptId, goalId: 'goal', taskId: 'task', deviceId: 'device',
    baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), branch: 'refs/enoughfactory/retained', createdAt: new Date().toISOString(),
    bundleArtifact: await artifacts.put('Retained primary bundle', { name: 'primary.bundle', mime: 'application/x-git-bundle' }),
    diffArtifact: await artifacts.put('Retained primary diff', { name: 'primary.patch', mime: 'text/x-diff' }), workingDirectories: [capture] };
  await mkdir(path.join(workspaceData, 'candidates'));
  await writeFile(path.join(workspaceData, 'candidates', `${candidate.id}.json`), JSON.stringify(candidate));
  const workspaces = { candidate: async (id: string) => JSON.parse(await readFile(path.join(workspaceData, 'candidates', `${id}.json`), 'utf8')) as Candidate };
  const endpoint = { host: 'unix:///unused/enoughfactory-private.sock', cliPath: '/unused/docker', configDirectory: path.join(dataDir, 'config') };
  const sessions = new SessionController(store as Store, 'device', () => {}, () => {}, { endpoint, ensureReady: async () => assert.fail('Cleanup cannot start the runtime'), bridgeHostAddress: () => undefined }, workspaceData);
  t.after(() => sessions.close());
  store.set('sessions', { id: sessionId, projectId: `workspace-${attemptId}`, status: 'stopped' });
  store.set('session-launch', { id: sessionId, dockerHost: endpoint.host, generation: 1, workingDirectorySources: sources });
  store.set('session-working-directory-captures', { id: sessionId, roots: candidate.workingDirectories });
  store.set('factory-workers', { id: attemptId, status: 'succeeded', goal: { id: 'goal' }, task: { id: 'task' }, sessionId,
    workspace: { id: attemptId, sessionId, provider: 'git', baseCommit: candidate.baseCommit }, candidate, workingDirectorySources: sources });
  let disposed = false;
  const input = { attemptId, dataDir, store, sessions, directoryManager, artifacts, workspaces, disposeWorkspace: async () => { disposed = true; } };
  const exists = (id: string) => lstat(path.join(workspaceData, 'working-directories', id));
  return { ...input, input, sessionId, source, sources, snapshots, sessionSnapshots, candidate, workspaceData, exists, disposed: () => disposed };
}

test('accepted worker input release retains exact outputs and restart sources, and fences a concurrent restart', async t => {
  const f = await fixture(t);
  let verificationEntered!: () => void, finishVerification!: () => void;
  const entered = new Promise<void>(resolve => { verificationEntered = resolve; });
  const waiting = new Promise<void>(resolve => { finishVerification = resolve; });
  const verify = f.artifacts.path.bind(f.artifacts);
  let first = true;
  f.artifacts.path = async artifact => { if (first) { first = false; verificationEntered(); await waiting; } return verify(artifact); };
  const release = releaseWorkerInputs(f.input);
  await entered;
  await assert.rejects(f.sessions.restart(f.sessionId), /input copies/);
  assert.equal(f.sessions.record(f.sessionId).status, 'stopped');
  finishVerification(); await release;
  assert.equal(f.disposed(), true);
  for (const id of [f.attemptId, f.sessionId]) {
    await assert.rejects(f.exists(id), /ENOENT/);
    const receipt = JSON.parse(await readFile(path.join(f.workspaceData, 'worker-input-receipts', f.attemptId, `${id}.json`), 'utf8'));
    assert.equal(receipt.journal.identity, id); assert.equal(receipt.candidateId, f.candidate.id);
  }
  assert.equal(await readFile(path.join(f.source, 'README.md'), 'utf8'), 'Original selected folder\n');
  const launch = f.store.get<{ workingDirectorySources: WorkingDirectorySource[] }>('session-launch', f.sessionId)!;
  assert.deepEqual(await f.directoryManager.sourceSnapshots(f.sessionId), []);
  const restored = await f.directoryManager.prepare({ identity: f.sessionId, transferred: launch.workingDirectorySources });
  assert.equal(await readFile(path.join(restored[0]!.path, 'README.md'), 'utf8'), 'Original selected folder\n');
  const returned = path.join(f.workspaceData, 'reconstructed-output');
  await f.directoryManager.importCapture(f.candidate.workingDirectories![0]!, returned);
  assert.equal(await readFile(path.join(returned, 'README.md'), 'utf8'), 'Agent-authored retained output\n');
  for (const artifact of [f.candidate.bundleArtifact, f.candidate.diffArtifact, f.sources[0]!.sourceArtifact]) await f.artifacts.path(await f.artifacts.get(artifact.id));
});

test('worker release fails closed for failed or unknown work, missing captures and undurable sources', async t => {
  const f = await fixture(t), worker = f.store.get<{ id: string; [key: string]: unknown }>('factory-workers', f.attemptId)!;
  const launch = f.store.get<{ id: string }>('session-launch', f.sessionId)!, session = f.sessions.record(f.sessionId);
  const rejected = async (pattern: RegExp) => {
    await assert.rejects(releaseWorkerInputs(f.input), pattern);
    await f.exists(f.attemptId); await f.exists(f.sessionId); assert.equal(f.disposed(), false);
  };
  f.store.delete('factory-workers', f.attemptId); await rejected(/successfully captured/);
  f.store.set('factory-workers', worker);
  for (const status of ['failed', 'unknown', 'running', 'prepared']) {
    f.store.set('factory-workers', { ...worker, status }); await rejected(/successfully captured/);
  }
  f.store.set('factory-workers', worker);
  f.store.set('sessions', { ...session, status: 'unknown' }); await rejected(/confirm|Stop this environment/i);
  f.store.set('sessions', session);
  f.store.set('session-launch', { ...launch, workingDirectorySources: undefined }); await rejected(/restart sources/);
  f.store.set('session-launch', { ...launch, dockerHost: 'unix:///unrelated/docker.sock' }); await rejected(/owned environment/);
  f.store.set('session-launch', launch);
  const roots = f.store.get<{ id: string }>('session-working-directory-captures', f.sessionId)!;
  f.store.set('session-working-directory-captures', { id: f.sessionId, roots: [] }); await rejected(/capture is not durably retained/);
  f.store.set('session-working-directory-captures', roots);
  const bundlePath = await f.artifacts.path(f.candidate.bundleArtifact), bytes = await readFile(bundlePath);
  await writeFile(bundlePath, 'Corrupted evidence'); await rejected(/integrity verification/); await writeFile(bundlePath, bytes);
  const set = f.store.set;
  f.store.set = (table, record) => { if (table === 'factory-worker-inputs') throw new Error('Receipt store unavailable'); set(table, record); };
  await rejected(/Receipt store unavailable/);
});

test('worker release preserves edited copies, unrecognized contents and substituted paths', async t => {
  const f = await fixture(t), selected = f.sessionSnapshots[0]!.path;
  await exec('git', ['-C', selected, 'update-index', '--skip-worktree', '--', 'README.md']);
  await writeFile(path.join(selected, 'README.md'), 'Edits hidden from ordinary Git status\n');
  await assert.rejects(releaseWorkerInputs(f.input), /nonordinary Git index flags/);
  assert.equal(await readFile(path.join(selected, 'README.md'), 'utf8'), 'Edits hidden from ordinary Git status\n');
  await exec('git', ['-C', selected, 'update-index', '--no-skip-worktree', '--', 'README.md']);
  await writeFile(path.join(selected, 'README.md'), 'Unexpected local edits\n');
  await assert.rejects(releaseWorkerInputs(f.input), /local edits/);
  await writeFile(path.join(selected, 'README.md'), 'Original selected folder\n');
  const extra = path.join(f.workspaceData, 'working-directories', f.attemptId, 'unrecorded-evidence.txt');
  await writeFile(extra, 'Keep this unrecognized evidence\n');
  await assert.rejects(releaseWorkerInputs(f.input), /unrecognized files/);
  assert.equal(await readFile(extra, 'utf8'), 'Keep this unrecognized evidence\n'); await unlink(extra);
  const original = path.join(f.workspaceData, 'working-directories', f.attemptId), moved = `${original}-preserved`;
  await rename(original, moved); await symlink(moved, original);
  await assert.rejects(releaseWorkerInputs(f.input), /symlink parents/);
  assert.equal((await lstat(moved)).isDirectory(), true);
  await unlink(original); await rename(moved, original);
  const receipts = path.join(f.workspaceData, 'worker-input-receipts', f.attemptId);
  await mkdir(receipts, { recursive: true });
  const unrecognized = path.join(receipts, `${f.attemptId}.json`);
  await writeFile(unrecognized, 'Keep existing evidence\n');
  await assert.rejects(releaseWorkerInputs(f.input), /JSON|unrecognized evidence/);
  assert.equal(await readFile(unrecognized, 'utf8'), 'Keep existing evidence\n');
  await f.exists(f.attemptId); await f.exists(f.sessionId); assert.equal(f.disposed(), false);
});

test('goal check input copies release only with an exact report and confirmed runtime cleanup', async t => {
  const f = await fixture(t);
  const candidate = { ...f.candidate, taskId: 'goal-check' };
  await writeFile(path.join(f.workspaceData, 'candidates', `${candidate.id}.json`), JSON.stringify(candidate));
  const report: CheckReport = { id: randomUUID(), candidateId: candidate.id, commit: candidate.commit, status: 'passed', commands: [], createdAt: new Date().toISOString(),
    logArtifact: await f.artifacts.put('Completed goal check', { name: 'checks.json', mime: 'application/json' }) };
  await mkdir(path.join(f.workspaceData, 'reports'));
  const reportPath = path.join(f.workspaceData, 'reports', `${report.id}.json`);
  const failed = { ...report, cleanupErrors: ['Check container termination was not confirmed'] };
  await writeFile(reportPath, JSON.stringify(failed));
  await assert.rejects(releaseGoalCheckInputs({ ...f.input, operation: f.attemptId, candidate, report: failed }), /resource release is unconfirmed/);
  await f.exists(f.attemptId);
  await writeFile(reportPath, JSON.stringify(report));
  await releaseGoalCheckInputs({ ...f.input, operation: f.attemptId, candidate, report });
  await assert.rejects(f.exists(f.attemptId), /ENOENT/); await f.exists(f.sessionId);
  await f.artifacts.path(report.logArtifact);
});

test('coordinator releases only the remote attempt copies after integration, retaining unrelated session inputs', async t => {
  const f = await fixture(t);
  f.store.set('factory-attempt-details', { id: f.attemptId, phase: 'done', candidate: f.candidate });
  f.store.set('attempts', { id: f.attemptId, taskId: 'task', status: 'succeeded' });
  f.store.set('tasks', { id: 'task', status: 'review' });
  await assert.rejects(releaseCoordinatorWorkerInputs(f.input), /no longer terminal/); await f.exists(f.attemptId);
  f.store.set('tasks', { id: 'task', status: 'completed' });
  await releaseCoordinatorWorkerInputs(f.input);
  await assert.rejects(f.exists(f.attemptId), /ENOENT/); await f.exists(f.sessionId);
  assert.equal(f.disposed(), false);
});
