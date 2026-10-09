import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ControllerRun, Goal, InspectionAuthority, InspectionSourceIdentity, Project } from '@enoughfactory/contracts';
import { WorkingDirectoryManager, WorkspaceManager, type InspectionSnapshot } from '@enoughfactory/workspaces';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext, ChatController } from './chats.ts';
import { prepareControllerContext } from './controller-context.ts';
import { InspectionService } from './inspection-service.ts';
import { INSPECTION_SOURCE_MAX_BYTES } from './inspection-source-policy.ts';
import { Store } from './store.ts';

interface CaptureSeam {
  captureActual(context: AgentToolBridgeContext, authority?: InspectionAuthority, retain?: boolean): Promise<{ snapshot: InspectionSnapshot; source: InspectionSourceIdentity }>;
  canonicalSource(goal: Goal): Promise<{ snapshot: InspectionSnapshot; source: InspectionSourceIdentity }>;
}

async function fixture(t: TestContext, role: ControllerRun['role'] = 'planner') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-source-capture-')));
  const primary = path.join(directory, 'app'); await mkdir(primary);
  const git = (...args: string[]) => execFileSync('git', ['-C', primary, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(primary, 'App.swift'), 'let title = "Mail"\n'); git('add', '.'); git('commit', '--quiet', '-m', 'Original app');
  await writeFile(path.join(primary, 'App.swift'), 'let title = "EnoughMail"\n');
  await writeFile(path.join(primary, 'Untracked.swift'), 'let draft = "Preserve authored source"\n');
  const ids = ['enough-ui-reference', 'mail-web-reference', 'independent-verification-inputs', 'controller-context-user-reference'];
  const names = ['enough-ui', 'mail-web', 'verification-inputs', 'factory-context'];
  const roots = await Promise.all(ids.map(async (id, index) => {
    const source = path.join(directory, id); await mkdir(source);
    await writeFile(path.join(source, 'original.json'), JSON.stringify({ id, purpose: 'Supplied source and historical verification evidence' }));
    return { id, name: names[index]!, path: source };
  }));
  const store = new Store(path.join(directory, 'service'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const goal = { id: 'goal', projectId: 'mail-project', revision: 36, status: 'running' } as Goal;
  const project = { id: goal.projectId, path: primary, workingDirectories: roots } as Project;
  const run: ControllerRun = { id: 'owned-planning-run', goalId: goal.id, role, sessionId: 'owned-session', chatId: 'owned-chat', status: 'running', updatedAt: new Date().toISOString() };
  store.set('goals', goal); store.set('projects', project); store.set('factory-controller-runs', run);
  const workspaces = new WorkspaceManager({ dataDir: path.join(directory, 'workspace-data'), deviceId: 'mac' });
  const directoryManager = new WorkingDirectoryManager({ dataDir: path.join(directory, 'workspace-data'), artifacts: workspaces.artifacts });
  const prepared = await prepareControllerContext({ operation: run.id, goalId: goal.id, role, project, store, workspaces, directoryManager, dataDir: directory, selected: [] });
  const materialized = await directoryManager.prepare({ identity: run.sessionId, transferred: prepared.workingDirectorySources });
  store.set('session-launch', { id: run.sessionId, workingDirectorySources: prepared.workingDirectorySources });
  store.set('session-host', { id: run.sessionId, deviceId: 'mac', prepared: { sessionId: run.sessionId, roots: materialized } });
  const context = { chat: { id: run.chatId, sessionId: run.sessionId, runtime: 'codex' }, session: { id: run.sessionId, projectId: project.id, workingDirectories: materialized.map(({ id, name, path, kind, baseCommit, sourceCommit }) => ({ id, name, path, kind, baseCommit, sourceCommit, status: 'ready' })) }, execution: { kind: 'host-macos', targetId: 'mac-host', workdir: primary }, signal: new AbortController().signal } as AgentToolBridgeContext;
  const app = { dataDir: path.join(directory, 'service'), device: { id: 'mac' }, store, runtime: { endpoint: { host: 'unix:///not-used', cliPath: '/usr/bin/false', configDirectory: path.join(directory, 'docker') } }, changed() {}, emit() {}, sessions: {} } as unknown as DeviceApp;
  const service = new InspectionService(app, {} as ChatController), seam = service as unknown as CaptureSeam;
  return { directory, primary, git, roots, store, goal, run, prepared, context, service, seam };
}

test('planner captures all declared roots and authored Git changes while excluding its frozen generated planning archive', async t => {
  const f = await fixture(t);
  const archive = f.context.session.workingDirectories!.find(root => root.id === `controller-context-${f.run.id}`)!;
  // A sparse generated archive reproduces the offending size without allocating
  // a giant buffer or copying it into the source snapshot.
  const file = await open(path.join(archive.path, 'retained-candidates.bundle'), 'wx');
  try { await file.truncate(325_004_015); } finally { await file.close(); }
  const status = f.git('status', '--porcelain=v1', '--untracked-files=all'), head = f.git('rev-parse', 'HEAD');
  const create = f.service.snapshots.create.bind(f.service.snapshots), budgets: number[] = [];
  f.service.snapshots.create = async input => {
    assert.equal(input.maxBytes, INSPECTION_SOURCE_MAX_BYTES);
    // These are the measured legitimate bytes from the original incident. The
    // real small source fixture below exercises selection/hash/copy correctness.
    assert(input.maxBytes! >= 281_462_331); assert(281_462_331 > 256 * 1024 * 1024);
    budgets.push(input.maxBytes!); return create(input);
  };
  const actual = await f.seam.captureActual(f.context), canonical = await f.seam.canonicalSource(f.goal);
  assert.equal(actual.source.sha256, canonical.source.sha256);
  assert.deepEqual(actual.snapshot.roots.map(root => [root.id, root.name]), [['primary', 'primary'], ...f.roots.map(root => [root.id, root.name])]);
  assert.deepEqual(actual.source.roots!.map(root => root.id), ['primary', ...f.roots.map(root => root.id)]);
  assert.equal(actual.snapshot.manifest.roots.length, 5);
  for (const root of actual.snapshot.roots.slice(1)) assert.deepEqual(JSON.parse(await readFile(path.join(root.path, 'original.json'), 'utf8')), { id: root.id, purpose: 'Supplied source and historical verification evidence' });
  assert.equal(await readFile(path.join(actual.snapshot.roots[0]!.path, 'Untracked.swift'), 'utf8'), 'let draft = "Preserve authored source"\n');
  f.service.quality.check = async input => {
    assert.equal(input.source.sha256, actual.source.sha256);
    return { command: 'ui-quality', candidateCommit: input.candidateCommit, checkedCommit: input.checkedCommit, passed: false, exitCode: 1, output: 'The real source was captured; this fixture makes no UI acceptance claim.' };
  };
  await f.service.qualityCheck({ goal: f.goal, task: { id: 'task' }, attempt: { id: 'attempt', generation: 1 }, candidate: { id: 'candidate', commit: head, workingDirectories: f.roots.map(root => ({ ...root, containerPath: `/workspaces/${root.name}` })) }, quality: {}, path: f.primary, workingDirectories: f.roots.map(root => ({ path: root.path, containerPath: `/workspaces/${root.name}` })), checkedCommit: head, signal: f.context.signal } as unknown as Parameters<typeof f.service.qualityCheck>[0]);
  assert.equal(f.git('status', '--porcelain=v1', '--untracked-files=all'), status); assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.deepEqual(budgets, [INSPECTION_SOURCE_MAX_BYTES, INSPECTION_SOURCE_MAX_BYTES, INSPECTION_SOURCE_MAX_BYTES]);
});

test('controller capture refuses unknown folders and unfrozen or mismatched generated evidence ownership', async t => {
  const f = await fixture(t, 'evaluator');
  const attachment = f.context.session.workingDirectories!.find(root => root.id === `controller-context-${f.run.id}`)!;
  const extra = { ...f.context, session: { ...f.context.session, workingDirectories: [...f.context.session.workingDirectories!, { ...attachment, id: 'another-user-folder', name: 'another-user-folder' }] } };
  await assert.rejects(f.seam.captureActual(extra), /undeclared folder/);
  const launch = f.store.get<{ id: string; workingDirectorySources: typeof f.prepared.workingDirectorySources }>('session-launch', f.run.sessionId)!;
  f.store.set('session-launch', { ...launch, workingDirectorySources: launch.workingDirectorySources.filter(root => root.id !== attachment.id) });
  await assert.rejects(f.seam.captureActual(f.context), /undeclared folder/);
  f.store.set('session-launch', launch);
  await assert.rejects(f.seam.captureActual({ ...f.context, session: { ...f.context.session, workingDirectories: f.context.session.workingDirectories!.map(root => root.id === attachment.id ? { ...root, baseCommit: 'f'.repeat(40) } : root) } }), /undeclared folder/);
  await assert.rejects(f.seam.captureActual({ ...f.context, session: { ...f.context.session, workingDirectories: f.context.session.workingDirectories!.map(root => root.id === attachment.id ? { ...root, path: f.roots[0]!.path } : root) } }), /retained host mount path/);
  const container = { ...f.context, execution: { kind: 'container', containerId: 'not-started', workdir: '/work' }, session: { ...f.context.session, workingDirectories: f.context.session.workingDirectories!.map(root => ({ ...root, path: root.id === attachment.id ? '/workspaces/wrong-mount' : `/workspaces/${root.name}` })) } } as AgentToolBridgeContext;
  await assert.rejects(f.seam.captureActual(container), /frozen mount path/);
  assert.equal(f.store.list('inspection-source-snapshots').length, 0);
});
