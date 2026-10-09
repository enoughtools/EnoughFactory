import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ArtifactStore, WorkingDirectoryManager, WorkspaceManager, type WorkingDirectorySource } from '@enoughfactory/workspaces';
import { git } from '../../../packages/workspaces/src/process.ts';
import { HostWorkspaceManager } from './host-workspaces.ts';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'enough-host-workspaces-')));
  const workspaceDataDir = path.join(root, 'owned', 'workspace-data'), project = path.join(root, 'primary');
  const library = path.join(root, 'library'), notes = path.join(root, 'notes'), reference = path.join(root, 'reference');
  for (const directory of [project, library, notes, reference]) await mkdir(directory);
  for (const directory of [project, library]) {
    await git(directory, 'init', '--quiet');
    await git(directory, 'config', 'user.name', 'Fixture');
    await git(directory, 'config', 'user.email', 'fixture@example.test');
    await writeFile(path.join(directory, 'tracked.txt'), 'original\n');
    await git(directory, 'add', '.'); await git(directory, 'commit', '--quiet', '-m', 'baseline');
  }
  await writeFile(path.join(library, 'tracked.txt'), 'dirty input captured independently\n');
  await writeFile(path.join(library, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(library, 'ignored.txt'), 'ignored baseline\n');
  await writeFile(path.join(notes, 'notes.txt'), 'folder baseline\n');
  await mkdir(path.join(notes, 'empty')); await chmod(path.join(notes, 'empty'), 0o550);
  await symlink('notes.txt', path.join(notes, 'internal-link'));
  await writeFile(path.join(reference, 'facts.txt'), 'immutable reference\n');
  await symlink('facts.txt', path.join(reference, 'internal-link'));
  const artifacts = new ArtifactStore(path.join(workspaceDataDir, 'artifacts'), 'fixture');
  const workspaces = new WorkspaceManager({ dataDir: workspaceDataDir, deviceId: 'fixture', checkExecutor: async () => assert.fail('No container or check executor is needed for host workspace operations') });
  const workspace = await workspaces.create({ projectPath: project, goalId: 'goal', taskId: 'task', attemptId: 'attempt' });
  const directoryManager = new WorkingDirectoryManager({ dataDir: workspaceDataDir, artifacts });
  const snapshots = await directoryManager.prepare({ identity: 'selected-inputs', sources: [
    { id: 'library-root', name: 'library', path: library },
    { id: 'notes-root', name: 'notes', path: notes },
    { id: 'reference-root', name: 'reference', path: reference },
  ] });
  const sources: WorkingDirectorySource[] = snapshots.map(({ path: _path, ...source }) => source);
  const options = { workspaceDataDir, artifacts, directoryManager };
  const manager = new HostWorkspaceManager(options);
  const input = { sessionId: 'session', workspace, workingDirectorySources: sources.slice(0, 2), referenceContext: sources[2]! };
  t.after(async () => { await writable(root); await rm(root, { recursive: true, force: true }); });
  return { root, workspaceDataDir, project, library, notes, reference, artifacts, workspaces, workspace, directoryManager, sources, snapshots, options, manager, input };
}

test('host workspaces recover isolated roots, retain independent output and integrate only the primary', async t => {
  const f = await fixture(t);
  const projectHead = await git(f.project, 'rev-parse', 'HEAD'), libraryHead = await git(f.library, 'rev-parse', 'HEAD');
  const prepared = await f.manager.prepare(f.input);
  assert.equal(prepared.cwd, f.workspace.path);
  assert.equal(prepared.root, path.join(f.workspaceDataDir, 'host-sessions', 'session'));
  assert.deepEqual(prepared.roots.map(({ path: _path, ...source }) => source), JSON.parse(JSON.stringify(f.sources.slice(0, 2))));
  assert(prepared.roots.every(root => root.path.startsWith(`${prepared.root}${path.sep}`)));
  assert.equal(await git(prepared.cwd, 'remote'), '', 'Private host Git must not advertise the primary checkout as a remote');
  assert.equal(await readFile(path.join(prepared.roots[0]!.path, 'ignored.txt'), 'utf8'), 'ignored baseline\n');
  assert.equal((await lstat(path.join(prepared.roots[1]!.path, 'empty'))).mode & 0o777, 0o550);
  assert.equal(await readFile(path.join(prepared.roots[1]!.path, 'internal-link'), 'utf8'), 'folder baseline\n');
  assert.equal((await lstat(path.join(prepared.referenceContext!.path, 'facts.txt'))).mode & 0o222, 0);
  assert.equal((await lstat(prepared.referenceContext!.path)).mode & 0o222, 0);

  await writeFile(path.join(f.library, 'ignored.txt'), 'new user source bytes\n');
  await writeFile(path.join(prepared.roots[0]!.path, 'ignored.txt'), 'host authored ignored output\n');
  await writeFile(path.join(prepared.roots[1]!.path, 'output.txt'), 'independent folder output\n');
  await writeFile(path.join(prepared.cwd, 'tracked.txt'), 'host primary output\n');
  const recovered = new HostWorkspaceManager(f.options);
  assert.deepEqual(await recovered.load('session'), prepared);
  assert.deepEqual(await recovered.prepare(f.input), prepared, 'Prepare after reconnect never reseeds authored files');
  assert.equal(await readFile(path.join(prepared.roots[0]!.path, 'ignored.txt'), 'utf8'), 'host authored ignored output\n');
  assert.equal(await readFile(path.join(f.snapshots[0]!.path, 'ignored.txt'), 'utf8'), 'ignored baseline\n');
  const retainedBaseline = (await f.directoryManager.sourceSnapshots('session-host-roots'))[0]!;
  assert.equal(await readFile(path.join(retainedBaseline.path, 'ignored.txt'), 'utf8'), 'ignored baseline\n', 'Author writes must leave the imported host baseline intact');
  await f.artifacts.path(retainedBaseline.sourceArtifact);
  assert.equal(await readFile(path.join(f.project, 'tracked.txt'), 'utf8'), 'original\n');

  // Capture rebuilds Git from the verified bundle, never trusting the author's config/hooks.
  await writeFile(path.join(prepared.roots[0]!.path, '.git', 'config'), 'untrusted invalid agent Git metadata\n');
  const captures = await recovered.capture(prepared);
  assert.equal(captures.length, 2);
  assert(captures.every(capture => capture.id !== prepared.referenceContext!.id));
  assert.deepEqual(await recovered.capture(prepared), captures, 'A retained capture is reused after reconnect');
  for (const capture of captures) {
    const imported = path.join(f.workspaceDataDir, 'retained-inspection', capture.id);
    await f.directoryManager.importCapture(capture, imported);
    assert.equal(await git(imported, 'rev-parse', 'HEAD'), capture.commit);
  }
  assert.equal(await readFile(path.join(f.workspaceDataDir, 'retained-inspection', 'library-root', 'ignored.txt'), 'utf8'), 'host authored ignored output\n');
  await git(prepared.cwd, 'add', '.'); await git(prepared.cwd, 'commit', '--quiet', '-m', 'host primary work');
  const candidate = await f.workspaces.capture({ workspaceId: f.workspace.id, workingDirectories: captures });
  const result = await f.workspaces.integrate({ candidateId: candidate.id, projectPath: f.project, commands: [], isCurrent: () => true });
  assert.equal(result.status, 'integrated');
  assert.notEqual(await git(f.project, 'rev-parse', 'HEAD'), projectHead);
  assert.equal(await readFile(path.join(f.project, 'tracked.txt'), 'utf8'), 'host primary output\n');
  await assert.rejects(readFile(path.join(f.project, 'output.txt')), /ENOENT/);
  assert.equal(await git(f.library, 'rev-parse', 'HEAD'), libraryHead);
  assert.equal(await readFile(path.join(f.library, 'ignored.txt'), 'utf8'), 'new user source bytes\n');
  await assert.rejects(readFile(path.join(f.notes, 'output.txt')), /ENOENT/);

  await recovered.dispose(prepared);
  await recovered.dispose(prepared);
  await assert.rejects(recovered.load('session'), /disposed/);
  await assert.rejects(readFile(path.join(prepared.roots[0]!.path, 'ignored.txt')), /ENOENT/);
  await assert.rejects(readFile(path.join(prepared.referenceContext!.path, 'facts.txt')), /ENOENT/);
  await assert.rejects(readFile(path.join(f.workspaceDataDir, 'working-directories', 'session-host-roots', 'snapshots.json')), /ENOENT/);
  assert.equal(await readFile(path.join(prepared.cwd, 'tracked.txt'), 'utf8'), 'host primary output\n', 'Primary attempt cleanup belongs to WorkspaceManager');
  assert.equal((await f.artifacts.read(captures[0]!.diffArtifact)).includes('host authored ignored output'), true);
});

test('host preparation rejects primary exposure, unsupported providers, traversal and case collisions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.prepare({ ...f.input, sessionId: '../escape' }), /identifier/);
  await assert.rejects(f.manager.prepare({ ...f.input, workspace: { ...f.workspace, path: f.project } }), /exact private/);
  await assert.rejects(f.manager.prepare({ ...f.input, workspace: { ...f.workspace, provider: 'artifactfs' } }), /Git attempt/);
  await assert.rejects(f.manager.prepare({ ...f.input, workspace: { ...f.workspace, branch: 'different' } }), /retained workspace identity/);
  await assert.rejects(f.manager.prepare({ ...f.input, workingDirectorySources: [{ ...f.sources[0]!, name: '../escape' }] }), /names must be unique/);
  await assert.rejects(f.manager.prepare({ ...f.input, workingDirectorySources: [f.sources[0]!, { ...f.sources[1]!, name: 'LIBRARY', containerPath: '/workspaces/LIBRARY' }] }), /names must be unique/);
  await assert.rejects(f.manager.prepare({ ...f.input, referenceContext: { ...f.sources[2]!, id: 'LIBRARY-ROOT' } }), /names must be unique/);
  await assert.rejects(f.manager.prepare({ ...f.input, referenceContext: { ...f.sources[2]!, name: 'LIBRARY', containerPath: '/workspaces/LIBRARY' } }), /names must be unique/);
  await assert.rejects(readFile(path.join(f.workspaceDataDir, 'host-sessions', 'session', 'workspace.json')), /ENOENT/);
  assert.equal(await readFile(path.join(f.project, 'tracked.txt'), 'utf8'), 'original\n');
});

test('symlink roots and forged journals cannot redirect host capture or disposal', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspaceDataDir, 'host-sessions'));
  await symlink(f.project, path.join(f.workspaceDataDir, 'host-sessions', 'unsafe'));
  await assert.rejects(f.manager.load('unsafe'), /unsafe directory or symlink/);
  const prepared = await f.manager.prepare(f.input);
  await assert.rejects(f.manager.capture({ ...prepared, cwd: f.project }), /binding changed/);
  await assert.rejects(f.manager.dispose({ ...prepared, root: f.project }), /binding changed/);
  const rootPath = prepared.roots[0]!.path;
  await rm(rootPath, { recursive: true }); await symlink(f.library, rootPath);
  await assert.rejects(f.manager.load('session'), /unsafe directory or symlink/);
  await assert.rejects(f.manager.capture(prepared), /unsafe directory or symlink/);
  await assert.rejects(f.manager.dispose(prepared), /unsafe directory or symlink/);
  assert.equal(await readFile(path.join(f.library, 'tracked.txt'), 'utf8'), 'dirty input captured independently\n');
  assert.equal(await readFile(path.join(f.project, 'tracked.txt'), 'utf8'), 'original\n');
});

test('host copies reject escaping symlinks instead of exposing original repositories', async t => {
  const f = await fixture(t);
  await symlink(f.project, path.join(f.notes, 'primary-link'));
  const sources = await f.directoryManager.prepare({ identity: 'escaping-input', sources: [{ id: 'escaping', name: 'escaping', path: f.notes }] });
  await assert.rejects(f.manager.prepare({ ...f.input, workingDirectorySources: sources }), /relative internal symlinks|symlink outside its captured root/);
  await assert.rejects(readFile(path.join(f.workspaceDataDir, 'host-sessions', 'session', 'workspace.json')), /ENOENT/);
  assert.equal(await readFile(path.join(f.project, 'tracked.txt'), 'utf8'), 'original\n');
  // Absolute links into an original snapshot must not keep pointing at that copy after relocation.
  await rm(path.join(f.notes, 'primary-link')); await symlink(path.join(f.notes, 'notes.txt'), path.join(f.notes, 'absolute-link'));
  const absolute = await f.directoryManager.prepare({ identity: 'absolute-input', sources: [{ id: 'absolute', name: 'absolute', path: f.notes }] });
  await assert.rejects(f.manager.prepare({ ...f.input, sessionId: 'absolute-session', workingDirectorySources: absolute }), /relative internal symlinks|symlink outside its captured root/);
});

test('failed capture and later authored edits preserve every working root', async t => {
  const f = await fixture(t), prepared = await f.manager.prepare(f.input);
  await assert.rejects(f.manager.dispose(prepared), /Capture every authored/);
  await assert.rejects(f.manager.capture(prepared, { attemptId: 'another-attempt' }), /attempt authority/);
  await writeFile(path.join(prepared.roots[0]!.path, 'output.txt'), 'retained on failure\n');
  const capture = f.directoryManager.captureFromPath.bind(f.directoryManager);
  f.directoryManager.captureFromPath = async (snapshot, exported, context) => {
    if (snapshot.id === prepared.roots[1]!.id) throw new Error('fixture second-root artifact failure');
    return capture(snapshot, exported, context);
  };
  await assert.rejects(f.manager.capture(prepared), /second-root artifact failure/);
  await assert.rejects(readFile(path.join(f.workspaceDataDir, 'host-session-captures', 'session.json')), /ENOENT/);
  assert.equal(await readFile(path.join(prepared.roots[0]!.path, 'output.txt'), 'utf8'), 'retained on failure\n');
  await assert.rejects(f.manager.dispose(prepared), /Capture every authored/);
  f.directoryManager.captureFromPath = capture;
  await f.manager.capture(prepared);
  await writeFile(path.join(prepared.roots[0]!.path, 'output.txt'), 'new output after capture\n');
  await assert.rejects(f.manager.capture(prepared), /changed after their retained capture/);
  await assert.rejects(f.manager.dispose(prepared), /changed after their retained capture/);
  assert.equal(await readFile(path.join(prepared.roots[0]!.path, 'output.txt'), 'utf8'), 'new output after capture\n');
});

test('lost artifact is not treated as an uncaptured root that can be silently replaced', async t => {
  const f = await fixture(t), prepared = await f.manager.prepare(f.input);
  const captures = await f.manager.capture(prepared), artifactPath = await f.artifacts.path(captures[0]!.bundleArtifact);
  await rm(artifactPath);
  await assert.rejects(f.manager.capture(prepared), /ENOENT/);
  await assert.rejects(f.manager.dispose(prepared), /ENOENT/);
  assert.equal(await readFile(path.join(prepared.roots[0]!.path, 'tracked.txt'), 'utf8'), 'dirty input captured independently\n');
});

test('disposal intent resumes after restart and never presents partial roots as usable', async t => {
  const f = await fixture(t), prepared = await f.manager.prepare(f.input);
  const captures = await f.manager.capture(prepared);
  const journalPath = path.join(prepared.root, 'workspace.json'), journal = JSON.parse(await readFile(journalPath, 'utf8'));
  await writeFile(journalPath, JSON.stringify({ ...journal, disposal: 'disposing' }));
  await rm(path.join(prepared.root, 'roots'), { recursive: true });
  const recovered = new HostWorkspaceManager(f.options);
  await assert.rejects(recovered.load('session'), /being retired/);
  await recovered.dispose(prepared);
  await recovered.dispose(prepared);
  await assert.rejects(readFile(path.join(prepared.referenceContext!.path, 'facts.txt')), /ENOENT/);
  assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).disposal, 'disposed');
  await f.artifacts.path(captures[0]!.bundleArtifact);
  assert.equal(await readFile(path.join(f.project, 'tracked.txt'), 'utf8'), 'original\n');
});

test('concurrent preparation reuses one immutable binding; canceled preparation never exposes partial roots', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.manager.prepare(f.input), new HostWorkspaceManager(f.options).prepare(f.input)]);
  assert.deepEqual(second, first);
  await assert.rejects(f.manager.prepare({ ...f.input, workingDirectorySources: f.sources.slice(0, 1) }), /different captured inputs/);
  let calls = 0;
  await assert.rejects(f.manager.prepare({ ...f.input, sessionId: 'canceled', assertCurrent: () => { if (++calls > 1) throw new Error('fixture authority retired'); } }), /authority retired/);
  await assert.rejects(f.manager.load('canceled'), /ENOENT/);
  await assert.rejects(readFile(path.join(f.workspaceDataDir, 'working-directories', 'canceled-host-roots', 'snapshots.json')), /ENOENT/, 'Unpublished input copies are retired so retry reconstructs verified artifacts');
  assert.equal((await f.manager.prepare({ ...f.input, sessionId: 'canceled' })).roots.length, 2);
  assert.equal(await readFile(path.join(first.roots[0]!.path, 'tracked.txt'), 'utf8'), 'dirty input captured independently\n');
});

async function writable(root: string): Promise<void> {
  const entry = await lstat(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) return;
  await chmod(root, (entry.mode & 0o777) | 0o700);
  for (const name of await readdir(root)) await writable(path.join(root, name));
}
