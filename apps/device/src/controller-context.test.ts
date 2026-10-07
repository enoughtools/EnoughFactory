import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import type { Attempt, FactoryTask, Project } from '@enoughfactory/contracts';
import type { AttemptDetail, CandidateRef, FactoryStore, GoalCheckRecord } from '@enoughfactory/factory';
import { WorkingDirectoryManager, WorkspaceManager } from '@enoughfactory/workspaces';
import { controllerCandidates, prepareControllerContext } from './controller-context.ts';

const execute = promisify(execFile);
const git = async (directory: string, ...args: string[]) => (await execute('git', ['-C', directory, ...args])).stdout.trim();

function memoryStore(): FactoryStore {
  const tables = new Map<string, Map<string, unknown>>();
  return {
    list: <T>(table: string) => [...(tables.get(table)?.values() ?? [])] as T[],
    get: <T>(table: string, id: string) => tables.get(table)?.get(id) as T | undefined,
    set: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(value.id, value); },
    delete: (table, id) => { tables.get(table)?.delete(id); }, transaction: fn => fn(),
  };
}
function task(id: string, status: FactoryTask['status'] = 'canceled'): FactoryTask {
  return { id, goalId: 'goal', title: id, description: 'Preserve delivery context', status, dependsOn: [], createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:00Z' };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'enough-controller-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, 'project'), extra = path.join(root, 'reference'), dataDir = path.join(root, 'owned');
  await mkdir(primary); await mkdir(extra);
  await git(primary, 'init', '--quiet'); await git(primary, 'config', 'user.name', 'Fixture'); await git(primary, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(primary, 'README.md'), 'Current integrated project\n');
  await git(primary, 'add', '.'); await git(primary, 'commit', '-m', 'Initial source');
  await writeFile(path.join(extra, 'reference.txt'), 'Current attached folder\n');
  await mkdir(path.join(extra, 'empty')); await symlink('/unavailable/reference', path.join(extra, 'link'));
  const workspaces = new WorkspaceManager({ dataDir: path.join(dataDir, 'workspace-data'), deviceId: 'device' });
  const directoryManager = new WorkingDirectoryManager({ dataDir: path.join(dataDir, 'workspace-data'), artifacts: workspaces.artifacts });
  const project: Project = { id: 'project', name: 'Client', path: primary, deviceId: 'device', runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: '2026-10-06T00:00:00Z', workingDirectories: [{ id: 'reference', name: 'factory-context', path: extra }] };
  const store = memoryStore();
  const workspace = await workspaces.create({ projectPath: primary, goalId: 'goal', taskId: 'architecture', attemptId: 'attempt' });
  await writeFile(path.join(workspace.path, 'ARCHITECTURE.md'), 'Retained architecture deliverable\n');
  await git(workspace.path, 'add', '.'); await git(workspace.path, 'commit', '-m', 'Architecture candidate');
  const extraSnapshot = (await directoryManager.prepare({ identity: 'author', sources: project.workingDirectories }))[0]!;
  await writeFile(path.join(extraSnapshot.path, 'reference.txt'), 'Retained attached-folder output\n');
  const capture = await directoryManager.captureFromPath(extraSnapshot, extraSnapshot.path);
  const candidate = await workspaces.capture({ workspaceId: workspace.id, workingDirectories: [capture] });
  store.set('tasks', task('architecture'));
  store.set('factory-task-details', { id: 'architecture', lastCandidate: candidate });
  store.set('factory-control', { id: 'goal', stage: 'plan', replanTaskIds: ['architecture'], diagnosisTaskId: 'architecture' });
  return { root, dataDir, primary, extra, workspaces, directoryManager, project, store, candidate, workspace };
}

test('controller context preserves exact candidate and attached inputs separately without changing integrated source', async t => {
  const f = await fixture(t), originalHead = await git(f.primary, 'rev-parse', 'HEAD');
  const context = await prepareControllerContext({ ...f, operation: 'planning', goalId: 'goal', role: 'planner' });
  assert.equal(context.workingDirectorySources.length, 2);
  assert.deepEqual(context.workingDirectorySources.map(root => root.containerPath), ['/workspaces/factory-context', '/workspaces/factory-context-2']);
  assert.ok(context.workingDirectorySources.every(root => !('path' in root)), 'Private host paths must not enter transferred source contracts');
  const transferred = await f.directoryManager.prepare({ identity: 'controller-session', transferred: context.workingDirectorySources });
  const reference = transferred[0]!, evidence = transferred[1]!;
  const manifest = JSON.parse(await readFile(path.join(evidence.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.candidates[0].id, f.candidate.id); assert.equal(manifest.candidates[0].commit, f.candidate.commit);
  assert.equal(manifest.candidates[0].bundleSha256, f.candidate.bundleArtifact.sha256);
  assert.deepEqual(manifest.candidates[0].workingDirectories[0].emptyDirectories, f.candidate.workingDirectories![0]!.bundleArtifact.metadata!.emptyDirectories);
  assert.equal(manifest.candidates[0].workingDirectories[0].emptyDirectoriesSha256, f.candidate.workingDirectories![0]!.bundleArtifact.metadata!.emptyDirectoriesSha256);
  const candidatePath = path.join(evidence.path, 'candidates', f.candidate.id);
  assert.deepEqual(await readFile(path.join(candidatePath, 'source.bundle')), await readFile(await f.workspaces.artifacts.path(f.candidate.bundleArtifact)));
  assert.equal(await readFile(path.join(candidatePath, 'repository', 'ARCHITECTURE.md'), 'utf8'), 'Retained architecture deliverable\n');
  await assert.rejects(readFile(path.join(candidatePath, 'repository', '.git', 'config')), /ENOENT/);
  assert.equal(await readFile(path.join(candidatePath, 'working-directories', 'reference', 'reference.txt'), 'utf8'), 'Retained attached-folder output\n');
  assert.equal(await readFile(path.join(reference.path, 'reference.txt'), 'utf8'), 'Current attached folder\n');
  assert.equal(await readlink(path.join(reference.path, 'link')), '/unavailable/reference');
  assert.deepEqual(await readdir(path.join(reference.path, 'empty')), []);
  await writeFile(path.join(f.extra, 'reference.txt'), 'Later original edit\n');
  assert.equal(await readFile(path.join(reference.path, 'reference.txt'), 'utf8'), 'Current attached folder\n');
  assert.equal(await git(f.primary, 'rev-parse', 'HEAD'), originalHead);
  assert.equal(await git(f.primary, 'status', '--porcelain'), '');
  await assert.rejects(readFile(path.join(f.primary, 'ARCHITECTURE.md')), /ENOENT/);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'workspace-data', 'controller-context')), []);
  assert.match(context.instructions, /not the current integrated repository/);
});

test('controller candidate selection follows diagnosis, replan scope and accepted current attempts', () => {
  const store = memoryStore(), candidate = (id: string): CandidateRef => ({ id, commit: id, baseCommit: 'base' });
  for (const id of ['affected', 'unrelated', 'integrated']) {
    store.set('tasks', { ...task(id, id === 'integrated' ? 'completed' : 'canceled'), currentAttemptId: `${id}-attempt` });
    store.set('factory-task-details', { id, lastCandidate: candidate(`${id}-retained`) });
    store.set('factory-attempt-details', { id: `${id}-attempt`, candidate: candidate(`${id}-accepted`) });
  }
  store.set('tasks', { ...task('foreign'), goalId: 'other' });
  store.set('factory-task-details', { id: 'foreign', lastCandidate: candidate('foreign') });
  store.set('factory-control', { id: 'goal', diagnosisTaskId: 'affected', replanTaskIds: ['affected'] });
  assert.deepEqual(controllerCandidates(store, 'goal', 'planner').map(item => item.candidate.id), ['affected-retained']);
  assert.deepEqual(controllerCandidates(store, 'goal', 'diagnosis').map(item => item.candidate.id), ['affected-retained']);
  assert.deepEqual(controllerCandidates(store, 'goal', 'evaluator').map(item => item.candidate.id), ['integrated-accepted']);
});

test('controllers receive complete isolated same-goal execution/check JSON even without retained source candidates', async t => {
  const f = await fixture(t), store = memoryStore(), project = { ...f.project, workingDirectories: [] };
  const head = await git(f.primary, 'rev-parse', 'HEAD'), secret = 'SETTINGS_AND_PROVIDER_TOKEN_MUST_NOT_BE_EXPORTED';
  store.set('goals', { id: 'goal', revision: 13, status: 'planning' });
  store.set('settings', { id: 'settings', token: secret });
  const output = `Complete stored evidence\n${'\u0000\\"\n'.repeat(20_000)}\nFinal concrete failure`;
  store.set('factory-control', { id: 'goal', stage: 'plan', steering: ['Keep the original criteria'], replanReason: output,
    replanInstructions: 'Use retained evidence', token: secret });
  const details: AttemptDetail[] = [];
  for (const [id, status, revision] of [['accepted', 'completed', 12], ['repair', 'failed', 13]] as const) {
    const owner = { ...task(id, status), currentAttemptId: `${id}-attempt` };
    store.set('tasks', owner);
    const attempt: Attempt = { id: owner.currentAttemptId, taskId: owner.id, generation: 2, deviceId: 'device', status: status === 'completed' ? 'succeeded' : 'failed', startedAt: owner.createdAt, error: output };
    store.set('attempts', { ...attempt, token: secret });
    const candidate = { id: `${id}-candidate`, goalId: 'goal', taskId: owner.id, commit: `${id}-source`, baseCommit: 'base',
      bundleArtifact: { id: `${id}-bundle`, sha256: 'a'.repeat(64), size: 7, metadata: { token: secret } } };
    const checks = [{ command: `check-${id}`, passed: status === 'completed', output, exitCode: status === 'completed' ? 0 : 1, candidateCommit: candidate.commit, checkedCommit: `${id}-checked` }];
    const detail: AttemptDetail = { id: attempt.id, goalId: 'goal', goalRevision: revision, assignmentGoalRevision: revision, phase: 'done', cancellation: 'none',
      contract: { title: owner.title, description: owner.description, dependsOn: [], checks: [checks[0]!.command], planRevision: revision },
      candidate: status === 'completed' ? candidate : undefined, result: { status: status === 'completed' ? 'succeeded' : 'failed', text: output, error: output }, checks,
      workspace: { id: `${id}-workspace`, path: '/private/live-worker', provider: 'git', baseCommit: 'base', providerState: { token: secret } },
      integration: { commit: `${id}-integrated`, previousHead: 'base', candidateCommit: candidate.commit, checks } };
    details.push(detail); store.set('factory-attempt-details', { ...detail, settings: { token: secret } });
    store.set('factory-task-details', { id: owner.id, key: id, planRevision: revision, checks: [checks[0]!.command],
      lastError: output, lastCandidate: detail.candidate, repairInstructions: 'Keep useful work', token: secret });
  }
  store.set('tasks', { ...task('foreign'), goalId: 'other' });
  store.set('attempts', { id: 'foreign-attempt', taskId: 'foreign', generation: 1, startedAt: '', token: secret });
  store.set('factory-attempt-details', { id: 'foreign-attempt', goalId: 'other', result: { text: secret } });
  store.set('attempts', { id: 'mismatched-goal-attempt', taskId: 'repair', generation: 1, startedAt: '' });
  store.set('factory-attempt-details', { id: 'mismatched-goal-attempt', goalId: 'other', result: { text: secret } });
  const receipt: GoalCheckRecord = { id: 'current-checks', goalId: 'goal', revision: 13, at: '2026-10-07T00:00:00Z', commands: ['check-final'],
    repository: { head, branch: 'main', status: '', fingerprint: 'exact-final-tree', diff: output },
    checks: [{ command: 'check-final', passed: false, output, exitCode: 1, candidateCommit: head, checkedCommit: head }] };
  store.set('factory-goal-checks', receipt);
  store.set('factory-goal-checks', { ...receipt, id: 'older-checks', revision: 12, repository: { ...receipt.repository, head: 'older-checked-head' } });
  store.set('factory-goal-checks', { ...receipt, id: 'foreign-checks', goalId: 'other', checks: [{ ...receipt.checks[0]!, output: secret }] });

  assert.deepEqual(controllerCandidates(store, 'goal', 'planner'), [], 'Accepted/current stored evidence needs no reconstructable source candidate');
  const before = JSON.stringify(details), retainedBefore = JSON.stringify(store.list('factory-attempt-details'));
  const context = await prepareControllerContext({ ...f, store, project, operation: 'records-only', goalId: 'goal', role: 'planner' });
  assert.equal(context.workingDirectorySources.length, 1);
  assert.match(context.instructions, /Full stored execution\/check evidence is available/);
  assert.match(context.instructions, /external report\/log artifact bodies were not copied/);
  const [snapshot] = await f.directoryManager.prepare({ identity: 'records-session', transferred: context.workingDirectorySources });
  const manifest = JSON.parse(await readFile(path.join(snapshot!.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.goalRevision, 13); assert.deepEqual(manifest.candidates, []); assert.equal(manifest.records.length, 9);
  assert.ok(!JSON.stringify(manifest).includes(secret));
  const files = new Map<string, { filename: string; value: AttemptDetail | GoalCheckRecord }>();
  for (const record of manifest.records) {
    const filename = path.join(snapshot!.path, path.relative(context.workingDirectorySources[0]!.containerPath, record.path));
    const bytes = await readFile(filename);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256); assert.equal(bytes.length, record.size);
    assert.ok(!bytes.includes(Buffer.from(secret))); assert.ok(!bytes.includes(Buffer.from('/private/live-worker')));
    files.set(record.record, { filename, value: JSON.parse(bytes.toString()) });
    for (const check of record.checks) {
      assert.equal(check.outputSha256, createHash('sha256').update(output).digest('hex')); assert.equal(check.outputSize, Buffer.byteLength(output));
      assert.ok(check.record.startsWith(`${record.record}.`));
    }
  }
  for (const detail of details) {
    const entry = files.get(`factory-attempt-details/${detail.id}`)!.value as AttemptDetail;
    assert.equal(entry.result!.text, output); assert.equal(entry.result!.error, output);
    assert.equal(entry.checks![0]!.output, output); assert.equal(entry.integration!.checks[0]!.output, output);
    if (detail.candidate) assert.deepEqual(entry.candidate!.bundleArtifact, { id: `${detail.id.split('-')[0]}-bundle`, sha256: 'a'.repeat(64), size: 7 });
    const mapping = manifest.records.find((record: { record: string }) => record.record === `factory-attempt-details/${detail.id}`);
    assert.equal(mapping.attemptId, detail.id); assert.equal(mapping.generation, 2); assert.equal(mapping.candidate?.commit, detail.candidate?.commit);
  }
  assert.equal((files.get('factory-goal-checks/current-checks')!.value as GoalCheckRecord).checks[0]!.output, output);
  const older = manifest.records.find((record: { record: string }) => record.record === 'factory-goal-checks/older-checks');
  assert.equal(older.goalRevision, 12); assert.equal(older.matchesGoalRevision, false); assert.equal(older.repositoryHead, 'older-checked-head');
  assert.equal((files.get('factory-control/goal')!.value as unknown as { replanReason: string }).replanReason, output);
  assert.equal((files.get('factory-task-details/repair')!.value as unknown as { lastError: string }).lastError, output);
  assert.equal(JSON.stringify(store.list('factory-attempt-details')), retainedBefore, 'Export preserves durable execution records');
  store.set('factory-attempt-details', { ...details[0]!, result: { status: 'succeeded', text: 'Later journal change' } });
  const acceptedFile = files.get('factory-attempt-details/accepted-attempt')!;
  assert.equal(JSON.parse(await readFile(acceptedFile.filename, 'utf8')).result.text, output, 'Later journal writes cannot change the delivered snapshot');
  await writeFile(acceptedFile.filename, 'Private controller copy edit');
  const [fresh] = await f.directoryManager.prepare({ identity: 'fresh-records-session', transferred: context.workingDirectorySources });
  assert.equal(JSON.parse(await readFile(path.join(fresh!.path, path.relative(snapshot!.path, acceptedFile.filename)), 'utf8')).result.text, output, 'Private edits cannot change immutable retained artifact bytes');
  assert.equal(JSON.stringify(details), before); assert.equal(await git(f.primary, 'rev-parse', 'HEAD'), head); assert.equal(await git(f.primary, 'status', '--porcelain'), '');
  assert.deepEqual(await readdir(path.join(f.dataDir, 'workspace-data', 'controller-context')), []);
});

test('stale controller authority discards its own newly prepared evidence snapshot', async t => {
  const f = await fixture(t), original = f.directoryManager.prepare.bind(f.directoryManager);
  f.store.set('goals', { id: 'goal', revision: 13, status: 'planning' });
  t.mock.method(f.directoryManager, 'prepare', async (input: Parameters<WorkingDirectoryManager['prepare']>[0]) => {
    const snapshots = await original(input);
    if (input.identity === 'stale-records-evidence-context') f.store.set('goals', { id: 'goal', revision: 14, status: 'planning' });
    return snapshots;
  });
  await assert.rejects(prepareControllerContext({ ...f, project: { ...f.project, workingDirectories: [] }, operation: 'stale-records', goalId: 'goal', role: 'planner' }), /authority changed/);
  await assert.rejects(readFile(path.join(f.dataDir, 'workspace-data', 'working-directories', 'stale-records-evidence-context', 'snapshots.json')), /ENOENT/);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'workspace-data', 'controller-context')), []);
  assert.equal(await git(f.primary, 'status', '--porcelain'), '');
});

test('candidate ownership and commit mismatches reject the context before exposing source', async t => {
  const f = await fixture(t);
  for (const [operation, replacement] of [['wrong-commit', { ...f.candidate, commit: 'f'.repeat(40) }], ['wrong-task', { ...f.candidate, taskId: 'unrelated' }], ['wrong-id', { ...f.candidate, id: 'other-candidate' }]] as const) {
    const workspaces = Object.create(f.workspaces) as WorkspaceManager;
    workspaces.candidate = async () => replacement;
    await assert.rejects(prepareControllerContext({ ...f, workspaces, operation, goalId: 'goal', role: 'planner' }), /identity does not match/);
  }
  assert.deepEqual(await readdir(path.join(f.dataDir, 'workspace-data', 'controller-context')), []);
});

test('missing candidate bytes stay explicit in decision instructions while corrupt bytes reject preparation', async t => {
  const f = await fixture(t), bundle = await f.workspaces.artifacts.path(f.candidate.bundleArtifact);
  const bytes = await readFile(bundle);
  await rm(bundle);
  const context = await prepareControllerContext({ ...f, operation: 'missing-bytes', goalId: 'goal', role: 'diagnosis' });
  assert.match(context.instructions, /Unavailable retained source:/);
  assert.ok(context.instructions.includes(f.candidate.id));
  const sources = await f.directoryManager.prepare({ identity: 'missing-bytes-session', transferred: context.workingDirectorySources });
  const evidence = sources.find(source => source.name === 'factory-context-2')!;
  const manifest = JSON.parse(await readFile(path.join(evidence.path, 'manifest.json'), 'utf8'));
  assert.match(manifest.candidates[0].unavailable, /not available/);
  assert.equal(manifest.candidates[0].repository, undefined);
  await writeFile(bundle, Buffer.concat([bytes, Buffer.from('corrupted')]));
  await assert.rejects(prepareControllerContext({ ...f, operation: 'corrupt-bytes', goalId: 'goal', role: 'diagnosis' }), /integrity|hash|size/i);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'workspace-data', 'controller-context')), []);
});

test('eight project folders plus retained evidence fit the existing source limit with explicit mapped locations', async t => {
  const f = await fixture(t);
  f.project.workingDirectories = [];
  for (let index = 0; index < 8; index++) {
    const directory = path.join(f.root, `extra-${index}`); await mkdir(directory); await writeFile(path.join(directory, 'input.txt'), `${index}\n`);
    f.project.workingDirectories.push({ id: `extra-${index}`, name: `extra-${index}`, path: directory });
  }
  const context = await prepareControllerContext({ ...f, operation: 'eight-folders', goalId: 'goal', role: 'planner' });
  assert.equal(context.workingDirectorySources.length, 1);
  const [snapshot] = await f.directoryManager.prepare({ identity: 'eight-folder-session', transferred: context.workingDirectorySources });
  const manifest = JSON.parse(await readFile(path.join(snapshot!.path, 'manifest.json'), 'utf8'));
  assert.equal(manifest.projectDirectories.length, 8);
  for (let index = 0; index < 8; index++) {
    assert.equal(manifest.projectDirectories[index].path, `/workspaces/factory-context/project-directories/extra-${index}`);
    assert.equal(await readFile(path.join(snapshot!.path, 'project-directories', `extra-${index}`, 'input.txt'), 'utf8'), `${index}\n`);
  }
});

test('case-colliding Git objects transfer as an exact bundle without a misleading native tree', async t => {
  const f = await fixture(t);
  const upperFile = path.join(f.root, 'upper-source'), lowerFile = path.join(f.root, 'lower-source');
  await writeFile(upperFile, 'Uppercase contract\n'); await writeFile(lowerFile, 'Lowercase contract\n');
  const upper = await git(f.workspace.path, 'hash-object', '-w', upperFile), lower = await git(f.workspace.path, 'hash-object', '-w', lowerFile);
  // Build both paths in Git's index so the fixture works on a case-insensitive Mac too.
  await git(f.workspace.path, 'update-index', '--add', '--cacheinfo', `100644,${upper},Contracts/Protocol.md`);
  await git(f.workspace.path, 'update-index', '--add', '--cacheinfo', `100644,${lower},contracts/Protocol.md`);
  await git(f.workspace.path, 'commit', '-m', 'Retain both case-sensitive contract paths');
  const candidate = await f.workspaces.capture({ workspaceId: f.workspace.id });
  f.store.set('factory-task-details', { id: 'architecture', lastCandidate: candidate });
  const context = await prepareControllerContext({ ...f, operation: 'case-collisions', goalId: 'goal', role: 'planner' });
  const sources = await f.directoryManager.prepare({ identity: 'case-collision-session', transferred: context.workingDirectorySources });
  const evidence = sources.find(source => source.name === 'factory-context-2')!;
  const manifest = JSON.parse(await readFile(path.join(evidence.path, 'manifest.json'), 'utf8'));
  const entry = manifest.candidates[0];
  assert.equal(entry.commit, candidate.commit); assert.equal(entry.repository, undefined);
  assert.ok(entry.caseCollisions.some((group: string[]) => group.includes('Contracts/Protocol.md') && group.includes('contracts/Protocol.md')));
  assert.match(context.instructions, /Native tree reconstruction was skipped/);
  assert.match(context.instructions, /Linux container for faithful inspection/);
  const bundle = path.join(evidence.path, 'candidates', candidate.id, 'source.bundle');
  assert.deepEqual(await readFile(bundle), await readFile(await f.workspaces.artifacts.path(candidate.bundleArtifact)));
  const objects = path.join(f.root, 'inspect-exact.git');
  await execute('git', ['init', '--bare', '--quiet', objects]);
  await git(objects, 'fetch', '--no-tags', bundle, entry.bundleRef);
  assert.equal(await git(objects, 'show', `${candidate.commit}:Contracts/Protocol.md`), 'Uppercase contract');
  assert.equal(await git(objects, 'show', `${candidate.commit}:contracts/Protocol.md`), 'Lowercase contract');
  await assert.rejects(readFile(path.join(evidence.path, 'candidates', candidate.id, 'repository', 'Contracts', 'Protocol.md')), /ENOENT/);
  assert.deepEqual(await readdir(path.join(f.dataDir, 'workspace-data', 'controller-context')), []);
});
