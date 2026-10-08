import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ControllerRun, Device, FactoryTask, Goal, Project, Session } from '@enoughfactory/contracts';
import type { TurnInput } from '@enoughfactory/agents';
import { git } from '../../../packages/workspaces/src/process.ts';
import { DeviceApp } from './app.ts';
import { ChatController } from './chats.ts';
import { initializeFactory, type FactoryInspectionPorts } from './factory.ts';
import { Store } from './store.ts';

type Review = NonNullable<FactoryInspectionPorts['reviewController']>;
type ReviewInput = Parameters<Review>[0];
type ReviewResult = Awaited<ReturnType<Review>>;
const nativeMac = { skip: process.platform !== 'darwin' };
const criterion = 'The native mail workflow works on the delivered source';
const evaluation = (summary: string) => JSON.stringify({ complete: true, summary, criteria: [{ criterion, satisfied: true, evidence: ['Native workflow evidence'] }] });
const initialText = evaluation('Initial evaluation before the independent visual review');
const followupText = evaluation('Evaluation after inspecting the missing native evidence');
const newRevisionText = evaluation('Fresh evaluation for the revised goal');
const missing = (reason = 'Inspect the current native inbox and composer screenshots before accepting the result.'): ReviewResult => ({ ready: false, reason, evidenceIds: [] });
const ready = (): ReviewResult => ({ ready: true, evidenceIds: ['fixture-reviewed-image'] });

async function fixture(t: TestContext, quality = true, extraRoot = false) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'enough-controller-review-')));
  const seed = new Store(directory); seed.set('private', { id: 'runtime-control', suspended: true }); seed.close();
  const primary = path.join(directory, 'source'); await mkdir(primary);
  await git(primary, 'init', '--quiet'); await git(primary, 'config', 'user.name', 'Fixture'); await git(primary, 'config', 'user.email', 'fixture@example.test');
  await writeFile(path.join(primary, 'source.txt'), 'current native source\n');
  await git(primary, 'add', '.'); await git(primary, 'commit', '--quiet', '-m', 'baseline');
  const library = path.join(directory, 'library');
  let expectedPrimary = 'current native source\n', expectedLibrary = 'current library source\n';
  if (extraRoot) { await mkdir(library); await writeFile(path.join(library, 'source.txt'), expectedLibrary); }
  let identity: Device | undefined;
  const turns: TurnInput[] = [], reviews: ReviewInput[] = [];
  const responses = [initialText, followupText, newRevisionText];
  let review: Review = async () => ready();
  let current!: { app: DeviceApp; chats: ChatController; factory: Awaited<ReturnType<typeof initializeFactory>> };
  async function start() {
    const previous = process.env.ENOUGHFACTORY_HOME;
    let app: DeviceApp;
    try { process.env.ENOUGHFACTORY_HOME = directory; app = new DeviceApp(); }
    finally { if (previous === undefined) delete process.env.ENOUGHFACTORY_HOME; else process.env.ENOUGHFACTORY_HOME = previous; }
    identity ??= app.device;
    app.setDevice({ ...identity, executionTargets: [{ id: `${identity.id}:native`, kind: 'host-macos', protocolVersion: 1,
      readiness: 'ready', workspaceProviders: ['git'], runtimes: ['codex'], capacity: 2, capabilities: [{ kind: 'mac-shell', readiness: 'ready' }] }] });
    t.mock.method(app, 'ensureRuntimeReady', async () => assert.fail('Independent evaluator review must not start Docker'));
    t.mock.method(app.runtime, 'prepareWorkspace', async () => assert.fail('Independent evaluator review must not copy source into Docker'));
    Object.defineProperty(app.sessions, 'engine', { value: new Proxy({}, { get(_target, method) {
      return () => assert.fail(`Independent evaluator review must not invoke envmux.${String(method)}`);
    } }) });
    await app.sessions.recover();
    const chats = new ChatController(app);
    t.mock.method(chats.manager, 'provisionHost', async () => ({ kind: 'codex', available: true, fullAccess: true, interactiveApprovals: true, resume: true }));
    t.mock.method(chats.manager, 'hostProcesses', async () => []);
    t.mock.method(chats.manager, 'cancelHostSession', async () => {});
    t.mock.method(chats.manager, 'interrupt', async () => {});
    t.mock.method(chats.manager, 'runTurn', async (input: TurnInput) => {
      turns.push(input); assert.equal(input.executionTarget, 'host-macos'); assert(input.cwd);
      assert.equal(await readFile(path.join(input.cwd, 'source.txt'), 'utf8'), expectedPrimary);
      if (extraRoot) {
        const root = app.sessions.record(input.sessionId).workingDirectories?.find(root => root.id === 'library');
        assert(root); assert.notEqual(root.path, library);
        assert.equal(await readFile(path.join(root.path, 'source.txt'), 'utf8'), expectedLibrary);
      }
      return { threadId: input.threadId ?? `fixture-thread-${input.chatId}`, text: responses.shift() ?? evaluation(`Additional evaluation ${turns.length}`) };
    });
    const factory = await initializeFactory(app, chats, undefined, { reviewController: async input => {
      reviews.push(structuredClone({ ...input, signal: undefined }));
      assert.equal(input.goal.id, goal.id); assert.equal(input.run.role, 'evaluator');
      assert.equal(input.run.chatId, turns.at(-1)!.chatId);
      return review(input);
    } });
    factory.coordinator.stop();
    return { app, chats, factory };
  }
  // No controller is scheduled before this explicit evaluator call.
  let goal!: Goal;
  current = await start();
  const project: Project = { id: 'project', name: 'Mail client', path: primary, deviceId: current.app.device.id, createdAt: new Date().toISOString(), runtime: 'codex', approvalMode: 'approve-all', rules: [], developmentToolchain: 'default', ...(extraRoot ? { workingDirectories: [{ id: 'library', name: 'library', path: library }] } : {}) };
  current.app.store.set('projects', project);
  goal = current.factory.coordinator.create({ projectId: project.id, objective: 'Deliver the native mail application', criteria: [criterion], autonomy: 'manual', execution: { target: 'host-macos' } });
  const task: FactoryTask = { id: 'ui-task', goalId: goal.id, title: 'Deliver the native mail UI', description: 'Deliver inbox and compose workflows', dependsOn: [], status: 'completed', createdAt: goal.createdAt, updatedAt: goal.updatedAt,
    ...(quality ? { quality: { platforms: ['macos'], workflows: [{ id: 'compose-and-keep-draft', platform: 'macos' }], referenceIds: ['enoughmail-web'] } } : {}) };
  current.app.store.set('tasks', task);
  t.after(async () => { await current.app.close(); await rm(directory, { recursive: true, force: true }); });
  const state = () => current;
  const runs = () => current.app.store.list<ControllerRun>('factory-controller-runs').filter(run => run.goalId === goal.id);
  const complete = (role: 'planner' | 'evaluator' = 'evaluator') => current.factory.runtime.complete({ goal: current.app.store.get<Goal>('goals', goal.id)!, project, role, prompt: `Evaluate the exact current source against: ${criterion}` });
  const restart = async () => { await current.app.close(); current = await start(); };
  const changePrimary = async () => {
    expectedPrimary = 'updated integrated native source\n'; await writeFile(path.join(primary, 'source.txt'), expectedPrimary);
    await git(primary, 'add', '.'); await git(primary, 'commit', '--quiet', '-m', 'integrated source changed');
  };
  const changeLibrary = async () => { expectedLibrary = 'updated selected library source\n'; await writeFile(path.join(library, 'source.txt'), expectedLibrary); };
  return { directory, primary, library, goal, project, task, turns, reviews, state, runs, complete, restart, changePrimary, changeLibrary, review: (handler: Review) => { review = handler; } };
}

function isInspectionWait(error: unknown): boolean {
  assert.equal((error as { recovery: string }).recovery, 'inspection-evidence');
  assert.match((error as Error).message, /native|inspect|evidence/i); return true;
}

test('missing evaluator inspection triggers one follow-up in the same conversation and accepts only the reviewed result', nativeMac, async t => {
  const f = await fixture(t); let calls = 0;
  f.review(async input => {
    assert(input.signal instanceof AbortSignal);
    return ++calls === 1 ? missing() : ready();
  });
  const result = await f.complete();
  assert.equal(result.text, followupText); assert.equal(f.turns.length, 2); assert.equal(f.reviews.length, 2);
  assert.equal(f.reviews[0]!.resultText, initialText); assert.equal(f.reviews[1]!.resultText, followupText);
  assert.equal(f.turns[1]!.chatId, f.turns[0]!.chatId); assert.equal(f.turns[1]!.sessionId, f.turns[0]!.sessionId);
  assert.equal(f.turns[1]!.threadId, `fixture-thread-${f.turns[0]!.chatId}`);
  assert.match(f.turns[1]!.prompt, /native inbox and composer screenshots/);
  assert.equal(result.chatId, f.turns[0]!.chatId); assert.equal(f.runs().length, 1); assert.equal(f.runs()[0]!.status, 'completed');
  assert.equal(f.state().app.store.list('chats').length, 1); assert.equal(f.state().app.store.list('sessions').length, 1);
  assert.equal(await readFile(path.join(f.primary, 'source.txt'), 'utf8'), 'current native source\n');
});

test('inspection missing twice preserves the controller and resumes its exact retained result without another provider turn', nativeMac, async t => {
  const f = await fixture(t); f.review(async () => missing());
  await assert.rejects(f.complete(), isInspectionWait);
  assert.equal(f.turns.length, 2); assert.equal(f.reviews.length, 2);
  const pending = f.runs()[0]!;
  assert.equal(pending.status, 'waiting'); assert.equal(pending.chatId, f.turns[0]!.chatId);
  assert.equal(pending.sessionId, f.turns[0]!.sessionId);
  assert.equal(f.state().app.store.get<Session>('sessions', pending.sessionId)!.executionTargetKind, 'host-macos');
  f.review(async input => { assert.equal(input.run.id, pending.id); assert.equal(input.resultText, followupText); return ready(); });
  const result = await f.complete();
  assert.deepEqual(result, { text: followupText, chatId: pending.chatId });
  assert.equal(f.turns.length, 2, 'Arriving inspection evidence must not rerun an already completed provider decision');
  assert.equal(f.runs().length, 1); assert.equal(f.runs()[0]!.id, pending.id); assert.equal(f.runs()[0]!.status, 'completed');
});

test('service restart keeps a pending evaluator inspection and reuses its conversation, source and retained result', nativeMac, async t => {
  const f = await fixture(t); f.review(async () => missing());
  await assert.rejects(f.complete(), isInspectionWait);
  const pending = f.runs()[0]!, oldChat = f.state().app.store.get('chats', pending.chatId!)!;
  // A crash can occur after the durable wait receipt but before the public run
  // leaves running. The wait receipt, rather than that transient status, owns recovery.
  f.state().app.store.set('factory-controller-runs', { ...pending, status: 'running' });
  await f.restart();
  assert.equal(f.runs().length, 1); assert.equal(f.runs()[0]!.id, pending.id); assert.equal(f.runs()[0]!.status, 'waiting');
  assert.deepEqual(f.state().app.store.get('chats', pending.chatId!), oldChat, 'An ended provider turn awaiting external evidence is not an interrupted provider turn');
  f.review(async input => { assert.equal(input.run.id, pending.id); assert.equal(input.run.sessionId, pending.sessionId); assert.equal(input.resultText, followupText); return ready(); });
  const result = await f.complete();
  assert.deepEqual(result, { text: followupText, chatId: pending.chatId }); assert.equal(f.turns.length, 2);
  assert.equal(f.runs()[0]!.status, 'completed');
});

test('a changed goal revision cannot reuse a pending evaluator result from the earlier authority', nativeMac, async t => {
  const f = await fixture(t); f.review(async () => missing());
  await assert.rejects(f.complete(), isInspectionWait);
  const pending = f.runs()[0]!;
  const old = f.state().app.store.get<Goal>('goals', f.goal.id)!;
  f.state().app.store.set('goals', { ...old, revision: old.revision + 1, objective: `${old.objective}\nInclude the revised native workflow.` });
  f.review(async input => { assert.equal(input.goal.revision, old.revision + 1); assert.notEqual(input.run.id, pending.id); return ready(); });
  const result = await f.complete();
  assert.equal(result.text, newRevisionText); assert.notEqual(result.chatId, pending.chatId); assert.equal(f.turns.length, 3);
  assert.notEqual(f.turns[2]!.sessionId, pending.sessionId); assert.equal(f.runs().length, 2);
});

test('an integrated primary commit change invalidates pending inspection even when the goal revision is unchanged', nativeMac, async t => {
  const f = await fixture(t); f.review(async () => missing());
  await assert.rejects(f.complete(), isInspectionWait);
  const pending = f.runs()[0]!, previousHead = await git(f.primary, 'rev-parse', 'HEAD');
  await f.changePrimary();
  assert.notEqual(await git(f.primary, 'rev-parse', 'HEAD'), previousHead);
  assert.equal(f.state().app.store.get<Goal>('goals', f.goal.id)!.revision, f.goal.revision);
  f.review(async input => { assert.notEqual(input.run.id, pending.id); return ready(); });
  const result = await f.complete();
  assert.equal(result.text, newRevisionText); assert.notEqual(result.chatId, pending.chatId); assert.equal(f.turns.length, 3);
  assert.notEqual(f.turns[2]!.cwd, f.turns[0]!.cwd);
  assert.equal(f.runs().find(run => run.id === pending.id)!.status, 'interrupted');
});

test('changes in a selected additional source root invalidate pending inspection without changing the primary commit', nativeMac, async t => {
  const f = await fixture(t, true, true); f.review(async () => missing());
  await assert.rejects(f.complete(), isInspectionWait);
  const pending = f.runs()[0]!, previousHead = await git(f.primary, 'rev-parse', 'HEAD');
  await f.changeLibrary();
  assert.equal(await git(f.primary, 'rev-parse', 'HEAD'), previousHead);
  assert.equal(f.state().app.store.get<Goal>('goals', f.goal.id)!.revision, f.goal.revision);
  f.review(async input => { assert.notEqual(input.run.id, pending.id); return ready(); });
  const result = await f.complete();
  assert.equal(result.text, newRevisionText); assert.notEqual(result.chatId, pending.chatId); assert.equal(f.turns.length, 3);
  assert.notEqual(f.turns[2]!.sessionId, pending.sessionId);
  assert.equal(await readFile(path.join(f.library, 'source.txt'), 'utf8'), 'updated selected library source\n');
});

test('pausing preserves pending inspection inputs while canceling the goal retires its owned waiting session', nativeMac, async t => {
  const f = await fixture(t); f.review(async () => missing());
  await assert.rejects(f.complete(), isInspectionWait);
  const pending = f.runs()[0]!, app = f.state().app;
  const session = app.sessions.record(pending.sessionId), roots = session.workingDirectories!.map(root => root.path);
  let stateChanged!: () => void;
  const stateEvent = new Promise<void>(resolve => { stateChanged = resolve; });
  const observed = (topic: string) => { if (topic === 'state') { app.listeners.delete(observed); stateChanged(); } };
  app.listeners.add(observed); f.state().factory.coordinator.pause(f.goal.id); await stateEvent;
  assert.equal(f.runs()[0]!.status, 'waiting'); assert.equal(app.sessions.record(pending.sessionId).status, 'ready');
  assert(app.store.get('factory-controller-reviews', pending.id));
  for (const root of roots) await readFile(path.join(root, '.git', 'HEAD'));
  await f.state().factory.coordinator.cancel(f.goal.id);
  await waitUntil(() => app.sessions.record(pending.sessionId).status === 'stopped' &&
    app.store.get<{ status: string }>('factory-controller-inputs', pending.id)?.status === 'released');
  assert.equal(app.store.get<Goal>('goals', f.goal.id)!.status, 'canceled');
  assert.equal(f.runs()[0]!.status, 'interrupted'); assert.equal(app.store.get('factory-controller-reviews', pending.id), undefined);
  assert(app.store.get<{ releasedAt?: string }>('session-host', pending.sessionId)?.releasedAt);
  for (const root of roots) await assert.rejects(readFile(path.join(root, '.git', 'HEAD')), /ENOENT/);
  assert.equal(f.turns.length, 2, 'Canceling a pending inspection cannot start another provider turn');
  assert.equal(app.store.get<{ id: string }>('chats', pending.chatId!)!.id, pending.chatId);
  assert.equal(await readFile(path.join(f.primary, 'source.txt'), 'utf8'), 'current native source\n');
});

test('cancellation during an awaited inspection check cannot park a new stale continuation or start a follow-up turn', nativeMac, async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const checking = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.review(async () => { entered(); await held; return missing(); });
  const completing = f.complete(), rejected = assert.rejects(completing, /controller decision was revoked/);
  await checking;
  await f.state().factory.coordinator.cancel(f.goal.id); release(); await rejected;
  const run = f.runs()[0]!, app = f.state().app;
  assert.notEqual(run.status, 'waiting'); assert.equal(app.store.get('factory-controller-reviews', run.id), undefined);
  assert.equal(app.sessions.record(run.sessionId).status, 'stopped');
  assert.equal(app.store.get<{ status: string }>('factory-controller-inputs', run.id)!.status, 'released');
  assert.equal(f.turns.length, 1, 'Revoked evidence authority cannot start another provider turn');
});

test('independent controller inspection is required only for evaluators with explicit UI quality tasks', nativeMac, async t => {
  const plain = await fixture(t, false); plain.review(async () => assert.fail('Legacy tasks have no implicit UI review gate'));
  assert.equal((await plain.complete()).text, initialText); assert.equal(plain.turns.length, 1); assert.equal(plain.reviews.length, 0);
  const planning = await fixture(t); planning.review(async () => assert.fail('The evaluator review lane must not gate planner turns'));
  assert.equal((await planning.complete('planner')).text, initialText); assert.equal(planning.turns.length, 1); assert.equal(planning.reviews.length, 0);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) assert.fail('The owning service did not finish retiring the canceled controller inputs');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
