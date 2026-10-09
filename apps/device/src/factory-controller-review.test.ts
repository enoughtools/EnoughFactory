import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ControllerRun, Device, FactoryTask, Goal, Project, Session } from '@enoughfactory/contracts';
import type { TurnInput } from '@enoughfactory/agents';
import { FactoryControllerError } from '@enoughfactory/factory';
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
  let prepareReview: NonNullable<FactoryInspectionPorts['prepareControllerReview']> = async () => {};
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
    const factory = await initializeFactory(app, chats, undefined, { prepareControllerReview: input=>prepareReview(input),reviewController: async input => {
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
  return { directory, primary, library, goal, project, task, turns, reviews, state, runs, complete, restart, changePrimary, changeLibrary, review: (handler: Review) => { review = handler; },prepareReview:(handler:typeof prepareReview)=>{prepareReview=handler;} };
}

function isInspectionWait(error: unknown): boolean {
  assert.equal((error as { recovery: string }).recovery, 'inspection-evidence');
  assert.match((error as Error).message, /native|inspect|evidence/i); return true;
}

test('canonical evaluator source preparation finishes before its first provider turn',nativeMac,async t=>{
  const f=await fixture(t,true,true);let prepared=0;
  f.prepareReview(async input=>{
    prepared++;assert.equal(f.turns.length,0);assert.equal(input.goal.id,f.goal.id);
    assert.equal(f.state().app.sessions.record(input.run.sessionId).status,'ready');
    assert.equal(f.state().chats.get(input.run.chatId!).status,'idle');
    assert(input.signal instanceof AbortSignal);assert.equal(input.signal.aborted,false);
  });
  await f.complete();assert.equal(prepared,1);assert.equal(f.turns.length,1);
});

test('changed evaluator source preparation cannot dispatch a provider or fabricate its result',nativeMac,async t=>{
  const f=await fixture(t);f.prepareReview(async()=>{throw new Error('Canonical evaluator source bytes changed before preparation.');});
  await assert.rejects(f.complete(),/source bytes changed/);assert.equal(f.turns.length,0);
  const run=f.runs()[0]!;assert.equal(run.status,'failed');
  assert.equal(f.state().app.store.events('chat',run.chatId!).length,0);
  assert.equal(f.state().app.store.get('chat-results',run.chatId!),undefined);
});

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


test('container evaluator provisions its frozen runtime before canonical source export and provider dispatch', async t => {
  const f=await fixture(t), {app,chats}=f.state();
  app.allowRuntimeStart();
  app.diagnostics.containerRuntime={kind:'lima',state:'ready',socketPath:'/fixture-owned.sock',dataDirectory:path.join(f.directory,'runtime-data'),stateDirectory:path.join(f.directory,'runtime-state'),artifactFsSupported:false,cpus:4,memoryGiB:8};
  app.setDevice({...app.device,executionTargets:[{id:'owned-container-target',kind:'container',protocolVersion:1,readiness:'ready',capacity:2,workspaceProviders:['git'],runtimes:['codex'],capabilities:[{kind:'linux-shell',readiness:'ready'}]}]});
  const goal={...app.store.get<Goal>('goals',f.goal.id)!,execution:{target:'container' as const}};app.store.set('goals',goal);
  t.mock.method(app,'ensureRuntimeReady',async()=>{});
  let execution!:ReturnType<typeof app.sessions.execution>, sessionId='', provisioned=false, exports=0;
  t.mock.method(app.sessions,'create',async(project:Project,name:string)=>{
    sessionId='owned-controller-container-session';
    execution={kind:'container',targetId:'owned-container-target',containerId:'owned-controller-container',workdir:project.path};
    const session:Session={id:sessionId,projectId:project.id,deviceId:app.device.id,name,status:'ready',createdAt:goal.createdAt,updatedAt:goal.updatedAt,services:[]};
    app.store.set('sessions',session);return session;
  });
  t.mock.method(app.sessions,'waitExecutionReady',async(id:string,_timeout?:number,signal?:AbortSignal)=>{assert.equal(id,sessionId);assert(signal,'Preparation uses the original service cancellation signal');signal.throwIfAborted();return execution;});
  t.mock.method(app.sessions,'execution',(id:string)=>{assert.equal(id,sessionId);return execution;});
  t.mock.method(chats.manager,'provision',async(containerId:string,runtime:string,options:{copyHostAuth?:boolean},signal?:AbortSignal)=>{
    assert.equal(containerId,'owned-controller-container');assert.equal(runtime,goal.runtime);assert.deepEqual(options,{copyHostAuth:true});assert(signal);signal.throwIfAborted();
    assert.equal(exports,0);assert.equal(f.turns.length,0);provisioned=true;
    return {kind:'codex',available:true,fullAccess:true,interactiveApprovals:true,resume:true};
  });
  f.prepareReview(async input=>{
    exports++;assert.equal(provisioned,true,'Pinned Node must exist before the canonical exporter runs');
    assert.equal(input.run.sessionId,sessionId);assert.equal(app.sessions.execution(sessionId).containerId,'owned-controller-container');
    assert.equal(f.turns.length,0,'Source capture is required before the first provider turn');
    assert.equal(await readFile(path.join(execution.workdir,'source.txt'),'utf8'),'current native source\n');
    throw new FactoryControllerError('Fixture source export was reached after runtime preparation.','inspection-evidence');
  });
  await assert.rejects(f.complete(),error=>(error as FactoryControllerError).recovery==='inspection-evidence');
  assert.equal(exports,1);assert.equal(f.turns.length,0);assert.equal(provisioned,true);
  assert.equal(await readFile(path.join(f.primary,'source.txt'),'utf8'),'current native source\n');
  app.store.set('sessions',{...app.sessions.record(sessionId),status:'stopped'});
});
