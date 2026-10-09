import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { InspectionAuthority, InspectionEvidence, InspectionJob, InspectionSourceIdentity, InspectionVerificationRun, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { BrowserObservation } from '@enoughfactory/browser-inspection';
import { InspectionSnapshotManager, type InspectionSnapshot } from '@enoughfactory/workspaces';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext, ChatController } from './chats.ts';
import { InspectionService } from './inspection-service.ts';
import type { InspectionQualityRecord, InspectionReferenceView } from './inspection-quality.ts';
import type { QualityEvidenceReport } from './factory-quality.ts';
import { Store } from './store.ts';
import { inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verifier.ts';
import type { NativeProfileAudit } from './inspection-profile-setup.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Wj4sAAAAASUVORK5CYII=', 'base64');
interface ToolResult { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; }
interface TestSeam {
  call(context: AgentToolBridgeContext, token: string, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  capture(context: AgentToolBridgeContext, authority: InspectionAuthority): Promise<{ id: string; snapshot: InspectionSnapshot; source: InspectionSourceIdentity }>;
  pump(): void;
  active: Map<string, Promise<void>>;
  closing: boolean;
  recoverOwnedSessions(): Promise<void>;
  reconcileVerifierInspection(run: InspectionVerificationRun, signal: AbortSignal): Promise<boolean>;
  contexts: Map<string, AgentToolBridgeContext>;
}
const value = <T>(result: ToolResult): T => JSON.parse(result.content.find(block => block.type === 'text')!.text!) as T;

/** Real journal, snapshots/artifacts and service orchestration; only native/browser effects are injected. */
async function fixture(t: TestContext, platform: 'macos' | 'web' = 'macos') {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-inspection-service-')));
  const workdir = path.join(directory, 'author'), referencePath = path.join(directory, 'reference');
  await mkdir(workdir); await mkdir(referencePath);
  await writeFile(path.join(workdir, 'README.md'), 'Mail app author source');
  await writeFile(path.join(referencePath, 'Button.swift'), 'Original EnoughUI button source');
  const store = new Store(path.join(directory, 'service'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 4, taskId: 'task', attemptId: 'attempt', authorityGeneration: 2, policyRevision: 4 };
  const quality: TaskQualityRequirements = { platforms: [platform], workflows: [{ id: 'close-draft', platform }], referenceIds: ['enough-ui'] };
  store.set('goals', { id: 'goal', revision: 7, status: 'running' });
  store.set('tasks', { id: 'task', goalId: 'goal', currentAttemptId: 'attempt', quality });
  store.set('attempts', { id: 'attempt', taskId: 'task', generation: 2, status: 'running' });
  store.set('factory-attempt-details', { id: 'attempt', assignmentGoalRevision: 4, contract: { quality } });
  store.set('projects', { id: 'project' });
  const events: Array<{ name: string; data: unknown }> = [];
  const app = { dataDir: path.join(directory, 'service'), device: { id: 'mac', capacity: 1 }, runtime: { endpoint: { host: 'unix:///does-not-use-docker', cliPath: '/usr/bin/false', configDirectory: path.join(directory, 'private-docker') } }, store,
    emit: (name: string, data: unknown) => { events.push({ name, data }); }, changed: () => {},
    withServiceOperation: async <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal),
  } as unknown as DeviceApp;
  const service = new InspectionService(app, {} as ChatController);
  Object.assign(service.native,{readiness:async()=>({status:'ready',reasons:[]})});
  const seam = service as unknown as TestSeam;
  const context = { attemptId: 'attempt', chat: { id: 'chat', runtime: 'codex' }, session: { id: 'chat-session', projectId: 'project', workingDirectories: [{ id: 'enough-ui', name: 'enough-ui', path: referencePath }] },
    execution: { kind: 'host-macos', targetId: 'mac-host', workdir }, signal: new AbortController().signal,
  } as unknown as AgentToolBridgeContext;
  const snapshot = await service.snapshots.create({ roots: [{ id: 'primary', name: 'primary', path: workdir }, { id: 'enough-ui', name: 'enough-ui', path: referencePath }], context: { goalId: 'goal', taskId: 'task', attemptId: 'attempt' } });
  const source: InspectionSourceIdentity = { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, ...(root.sourceCommit ? { commit: root.sourceCommit } : {}) })) };
  store.set('inspection-source-snapshots', { id: snapshot.id, snapshot, source });
  const grant = service.jobs.issueAuthority(authority, { capabilities: ['chromium-inspection', 'macos-app-inspection', 'apple-compilation'], executionTargetIds: ['container', 'mac-host'] });
  const token = grant.token;
  const call = (name: string, args: Record<string, unknown>) => seam.call(context, token, name, args);
  const createSession = (kind: 'native' | 'browser' = platform === 'macos' ? 'native' : 'browser') => {
    const job = service.jobs.createJob(token, { idempotencyKey: `session-${store.list('inspection-jobs').length}`, executionTargetId: kind === 'native' ? 'mac-host' : 'container', capability: kind === 'native' ? 'macos-app-inspection' : 'chromium-inspection', source, profile: {} });
    assert.equal(service.jobs.claimNext()!.id, job.id); service.jobs.markRunning(job.id);
    const session = service.jobs.openSession(job.id); service.jobs.markSessionReady(session.id);
    store.set('inspection-backends', { id: session.id, kind, backendSessionId: 'backend' });
    return { job, session };
  };
  const deliver = (result: ToolResult) => {
    for (const [index, image] of result.content.filter(block => block.type === 'image').entries()) {
      store.set('provider-image-deliveries', { id: `delivery-${store.list('provider-image-deliveries').length}`, chatId: 'chat', eventId: `event-${index}-${store.list('provider-image-deliveries').length}`, artifactSha256: createHash('sha256').update(Buffer.from(image.data!, 'base64')).digest('hex'), authority, route: 'tool-image' });
    }
  };
  return { directory, workdir, referencePath, store, app, authority, quality, source, service, seam, context, token, call, createSession, deliver, events };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(ready => { resolve = ready; });
  return { promise, resolve };
}

async function nativeProposalFixture(t: TestContext) {
  const f = await fixture(t);
  await mkdir(path.join(f.workdir, 'Demo.xcodeproj'));
  await writeFile(path.join(f.workdir, 'Demo.xcodeproj', 'project.pbxproj'), '// Original fixed native build recipe.');
  await writeFile(path.join(f.workdir, 'App.swift'), '// Original isolated fixture entry.');
  f.store.set('goals', { ...f.store.get<Record<string, unknown>>('goals', 'goal'), id: 'goal', projectId: 'project', approvalMode: 'approve-all' });
  f.context.session.deviceId = 'mac';
  Object.assign(f.app, { sessions: { record: (id: string) => { assert.equal(id, f.context.session.id); return f.context.session; } } });
  const setup = f.service.profileSetup as unknown as {
    options: { verifySnapshot(snapshot: InspectionSnapshot, signal?: AbortSignal): Promise<void> };
    pump(id: string): void;
  };
  setup.pump = () => {}; // Reviewer admission is the injected provider seam; proposal/source ownership is real.
  const args = { requestId: 'native-profile', profile: { id: 'fixture', build: { tool: 'xcodebuild', project: 'Demo.xcodeproj', scheme: 'Demo', platform: 'macos' }, launchArguments: ['--factory-fixture', '{runId}'], fixtureExpectedDataRoot: '/tmp/enoughfactory-fixtures/{runId}' },
    auditPaths: [{ rootId: 'primary', path: 'App.swift', purposes: ['entry', 'storage', 'credentials', 'providers', 'preferences', 'notifications'] }, { rootId: 'primary', path: 'Demo.xcodeproj/project.pbxproj', purposes: ['build'] }] };
  return { ...f, setup, args };
}

test('native profile proposal pins all source roots across a pressure sweep until its durable audit owns them', { timeout: 30000 }, async t => {
  const f = await nativeProposalFixture(t);
  for (const id of ['mail-web', 'verification-inputs', 'repair-source']) {
    const directory = path.join(f.directory, id);
    await mkdir(directory); await writeFile(path.join(directory, 'original.txt'), `Original ${id} bytes`);
    f.context.session.workingDirectories!.push({ id, name: id, path: directory, kind: 'git', baseCommit: 'b'.repeat(40), status: 'ready' });
  }
  const entered = deferred<InspectionSnapshot>(), release = deferred<void>(), verify = f.setup.options.verifySnapshot;
  f.setup.options.verifySnapshot = async (snapshot, signal) => { entered.resolve(snapshot); await release.promise; await verify(snapshot, signal); };
  const pending = f.call('factory_native_profile_propose', f.args);
  const settled = Promise.allSettled([pending]);
  const snapshot = await Promise.race([entered.promise, pending.then(() => { throw new Error('Proposal completed before source verification'); })]);
  try {
    assert.equal(snapshot.roots.length, 5);
    assert.equal(f.service.profileSetup.list().length, 0, 'The proposal has not yet published its source owner');
    const swept = await f.service.retention.sweep({ maxSnapshotBytes: 1, minIdleMs: 0, pressureIdleMs: 0 });
    assert.ok(swept.keptSnapshotIds.includes(snapshot.id), 'Pressure must not retire source in use by a proposal');
    assert.equal(swept.retiredSnapshotIds.includes(snapshot.id), false);
    await f.service.snapshots.verify(snapshot);
  } finally { release.resolve(); await settled; }
  const { audit } = value<{ audit: NativeProfileAudit }>(await pending);
  assert.equal(audit.status, 'queued'); assert.equal(audit.source.snapshotId, snapshot.id);
  assert.equal(audit.source.sha256, snapshot.sourceDigest);
  assert.deepEqual(audit.source.roots!.map(({ id, sha256 }) => ({ id, sha256 })), snapshot.roots.map(({ id, sourceDigest }) => ({ id, sha256: sourceDigest })));
  const owned = await f.service.retention.sweep({ maxSnapshotBytes: 1, minIdleMs: 0, pressureIdleMs: 0 });
  assert.ok(owned.keptSnapshotIds.includes(snapshot.id), 'The queued audit takes over protection after the temporary reader releases');
  f.store.set('inspection-profile-audits', { ...f.service.profileSetup.get(audit.id), status: 'canceled' });
  const retired = await f.service.retention.sweep({ maxSnapshotBytes: 1, minIdleMs: 0, pressureIdleMs: 0 });
  assert.ok(retired.retiredSnapshotIds.includes(snapshot.id), 'Finished ownership releases the source; no permanent pin remains');
  await assert.rejects(lstat(snapshot.path), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(f.workdir, 'App.swift'), 'utf8'), '// Original isolated fixture entry.');
  for (const id of ['mail-web', 'verification-inputs', 'repair-source']) assert.equal(await readFile(path.join(f.directory, id, 'original.txt'), 'utf8'), `Original ${id} bytes`);
});

test('failed and aborted native profile proposals release their temporary retained-source readers', async t => {
  for (const outcome of ['error', 'abort'] as const) await t.test(outcome, async t => {
    const f = await nativeProposalFixture(t);
    let sourceId: string | undefined;
    if (outcome === 'error') {
      f.setup.options.verifySnapshot = async snapshot => { sourceId = snapshot.id; throw new Error('Injected source verification failed'); };
      await assert.rejects(f.call('factory_native_profile_propose', f.args), /Injected source verification failed/);
    } else {
      const controller = new AbortController(), capture = f.seam.capture.bind(f.service);
      f.context.signal = controller.signal;
      f.seam.capture = async (context, authority) => { const source = await capture(context, authority); sourceId = source.id; controller.abort(); return source; };
      await assert.rejects(f.call('factory_native_profile_propose', f.args), { name: 'AbortError' });
    }
    assert.ok(sourceId); assert.equal(f.service.profileSetup.list().length, 0);
    const swept = await f.service.retention.sweep({ maxSnapshotBytes: 1, minIdleMs: 0, pressureIdleMs: 0 });
    assert.ok(swept.retiredSnapshotIds.includes(sourceId), 'An unsuccessful proposal must release the reader in finally');
  });
});

test('native profile proposals preserve independently owned verifier snapshots without restoring author cache', async t => {
  const f = await nativeProposalFixture(t);
  const external = new InspectionSnapshotManager({ dataDir: path.join(f.directory, 'verifier'), artifacts: f.service.artifacts });
  const snapshot = await external.create({ roots: [{ id: 'primary', name: 'primary', path: f.workdir }, { id: 'enough-ui', name: 'enough-ui', path: f.referencePath }] });
  const source: InspectionSourceIdentity = { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest })) };
  f.context.chat.verificationRunId = 'original-verifier';
  Object.assign(f.service.verifier, { verificationSource: async () => ({ id: snapshot.id, source, snapshot, run: { id: 'original-verifier' } }), verifySnapshot: (actual: InspectionSnapshot, signal?: AbortSignal) => { assert.equal(actual.path, snapshot.path); return external.verify(actual, signal); } });
  Object.assign(f.service.retention, { use: async () => assert.fail('An independently owned verifier copy must not use author-cache restore') });
  const { audit } = value<{ audit: NativeProfileAudit }>(await f.call('factory_native_profile_propose', f.args));
  assert.equal(audit.status, 'queued'); assert.deepEqual(audit.source, source);
  assert.equal(f.store.get('inspection-source-retention', snapshot.id) !== undefined, true, 'The audit retains its own imported copy as before');
  await external.verify(snapshot);
  const owned = f.service.profileSetup.get(audit.id);
  assert.notEqual(owned.snapshot.path, snapshot.path); await f.service.snapshots.verify(owned.snapshot);
});

function retainedCandidateInput(f: Awaited<ReturnType<typeof fixture>>) {
  const candidate={id:'retained-author-C',commit:'c'.repeat(40),baseCommit:'b'.repeat(40)};
  const goal={...f.store.get<Record<string,unknown>>('goals','goal')!,id:'goal',coordinatorId:'mac'};
  const attempt={...f.store.get<Record<string,unknown>>('attempts','attempt')!,id:'attempt',status:'failed',candidate:candidate.commit};
  const task={...f.store.get<Record<string,unknown>>('tasks','task')!,id:'task',status:'failed'};
  f.store.set('goals',goal);f.store.set('attempts',attempt);f.store.set('tasks',task);
  f.store.set('factory-attempt-details',{...f.store.get<Record<string,unknown>>('factory-attempt-details','attempt')!,id:'attempt',candidate,cancellation:'none',phase:'checking',result:{status:'succeeded'},checks:[{command:'original-check',passed:false,candidateCommit:candidate.commit,checkedCommit:candidate.commit}]});
  return {goal,task:f.store.get('tasks','task'),attempt,candidate,quality:f.quality} as Parameters<typeof f.service.retainedVerificationSettled>[0];
}

test('exact-source rejected fixture audit fails a UI-quality check without allocating a readiness-dependent verifier',async t=>{
  const f=await fixture(t);
  const verdict=await f.service.artifacts.put(Buffer.from(JSON.stringify({approved:false,blockedReasons:['Fixture startup still opens production credentials.']})),{goalId:'goal',taskId:'task',attemptId:'attempt',name:'original-source-judgment.json',mime:'application/json'});
  f.store.set('inspection-profile-audits',{id:'original-rejected-audit',authority:f.authority,source:f.source,status:'rejected',proposal:{profile:{id:'fixture'}},reason:'Fixture startup still opens production credentials.',verdict});
  let allocations=0,readiness=0;
  Object.assign(f.service.native,{readiness:async()=>{readiness++;return{status:'setup-required',reasons:['Actual screen access is unavailable.']};}});
  Object.assign(f.service.verifier,{ensure:async()=>{allocations++;assert.fail('A source audit rejection must reach repair before any verifier admission.');}});
  const input={goal:{...f.store.get('goals','goal'),projectId:'project'},task:f.store.get('tasks','task'),attempt:f.store.get('attempts','attempt'),candidate:{id:'C',commit:'c'.repeat(40)},quality:f.quality,path:f.workdir,workingDirectories:[{path:f.referencePath,containerPath:'enough-ui'}],checkedCommit:'c'.repeat(40),signal:new AbortController().signal} as Parameters<typeof f.service.qualityCheck>[0];
  const checked=await f.service.qualityCheck(input);
  assert.equal(checked.passed,false);assert.equal(checked.exitCode,1);assert.equal(checked.recovery,undefined);
  assert.match(checked.output,/Fixture startup still opens production credentials/);assert(checked.output.includes(verdict.id));assert(checked.output.includes(verdict.sha256));
  assert.equal(allocations,0);assert.equal(readiness,0);assert.equal(f.store.list('inspection-verifier-runs').length,0);assert.equal(f.store.list('chats').length,0);
  assert.equal(f.store.list('inspection-quality-reports').length,0,'The test has no invented UI report');
  await writeFile(path.join(f.workdir,'README.md'),'A different current source');
  Object.assign(f.service.verifier,{ensure:async()=>{allocations++;return{status:'waiting',reason:'Actual screen access is unavailable.'};}});
  const unrelated=await f.service.qualityCheck(input);
  assert.equal(unrelated.recovery?.condition,'inspection-evidence');assert.match(unrelated.output,/Actual screen access/);assert.equal(allocations,1,'An older-source rejection cannot fail the current source');
});

test('an older source quality pass still waits for contract-aware independent verification',async t=>{
  const f=await fixture(t);
  let checks=0,allocations=0;
  let setupPending=false,verifierStatus:'waiting'|'failed'|'canceled'='waiting';
  Object.assign(f.service.quality,{check:async(input:Parameters<typeof f.service.quality.check>[0])=>{
    checks++;
    assert.equal(input.verification,undefined,'The first evidence lookup has no new independent contract-bound result');
    return{command:'ui-quality',candidateCommit:input.candidateCommit,checkedCommit:input.checkedCommit,passed:true,exitCode:0,output:'An earlier current-source quality report passed.'};
  }});
  Object.assign(f.service.verifier,{ensure:async(input:Parameters<typeof f.service.verifier.ensure>[0])=>{
    allocations++;
    assert.equal(input.source.sha256,f.source.sha256);
    assert.deepEqual(input.quality,f.quality);
    return{status:verifierStatus,reason:`The current frozen acceptance contract has independent verification ${verifierStatus}.`};
  }});
  Object.assign(f.service.profileSetup,{pending:()=>setupPending?{auditId:'original-pending-audit',status:'pending',reason:'The current fixture source audit is pending.'}:undefined,maintain:()=>{}});
  const input={goal:{...f.store.get('goals','goal'),projectId:'project'},task:f.store.get('tasks','task'),attempt:f.store.get('attempts','attempt'),candidate:{id:'C',commit:'c'.repeat(40)},quality:f.quality,path:f.workdir,workingDirectories:[{path:f.referencePath,containerPath:'enough-ui'}],checkedCommit:'c'.repeat(40),signal:new AbortController().signal} as Parameters<typeof f.service.qualityCheck>[0];
  setupPending=true;
  const pending=await f.service.qualityCheck(input);
  assert.equal(pending.passed,false);assert.equal(pending.exitCode,1);assert.equal(pending.recovery?.condition,'inspection-evidence');
  assert.match(pending.output,/fixture source audit is pending/);assert.equal(allocations,0,'A pending source audit does not admit another verifier');
  setupPending=false;
  for(const status of ['waiting','failed','canceled'] as const){
    verifierStatus=status;
    const checked=await f.service.qualityCheck(input);
    assert.equal(checked.passed,false,status);assert.equal(checked.exitCode,1,status);
    assert.equal(checked.recovery?.condition,status==='waiting'?'inspection-evidence':undefined,status);
    assert.match(checked.output,/current frozen acceptance contract/);
  }
  assert.equal(checks,4);assert.equal(allocations,3,'An earlier pass cannot skip the new independent verifier');
  assert.equal(f.store.list('inspection-quality-reports').length,0,'The injected earlier lookup does not fabricate a new accepted report');
  assert.equal(f.store.list('chats').length,0,'The injected admission wait performs no live provider work');
});
function retainUnknownVerifier(f: Awaited<ReturnType<typeof fixture>>, input: ReturnType<typeof retainedCandidateInput>): InspectionVerificationRun {
  const source={...f.source,candidateId:input.candidate.id,candidateCommit:input.candidate.commit,checkedCommit:input.candidate.commit};
  const run:InspectionVerificationRun={id:inspectionVerificationKey({authority:f.authority,source,quality:f.quality}),authority:f.authority,source,quality:f.quality,policySha256:inspectionQualityPolicySha256(f.quality),ownerDeviceId:'mac',executionTargetKind:'host-macos',executionTargetId:'mac-host',status:'unknown',sessionId:'original-verifier-session',chatId:'original-verifier-chat',startedAt:new Date().toISOString(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deadlineAt:new Date().toISOString()};
  f.store.set('inspection-verifier-runs',run);return run;
}

test('retained candidate preflight only reads exact ended ownership and preserves unknown verification history',async t=>{
  const f=await fixture(t),{job,session}=f.createSession(),input=retainedCandidateInput(f),run=retainUnknownVerifier(f,input);
  let providerChecks=0;
  Object.assign(f.service.verifier,{providerSettled:async()=>{providerChecks++;return{ready:true};},providerOwnerCurrent:()=>true,ensure:async()=>{throw new Error('Preflight must never dispatch a verifier');}});
  f.seam.recoverOwnedSessions=async()=>{throw new Error('Preflight must never stop an inspection');};
  assert.equal(f.service.authorityCurrent(f.authority),false,'Failed-check recovery cannot reactivate author tool authority');
  assert.equal((await f.service.retainedVerificationSettled(input)).ready,false,'A stopped provider cannot erase active native inspection ownership');
  f.service.jobs.confirmSessionStopped(session.id);f.service.jobs.reconcileJob(job.id,{status:'failed',reason:'The injected owned backend positively stopped; its old workflow did not pass.',releaseConfirmed:true});
  const before={run:f.store.get('inspection-verifier-runs',run.id),events:f.store.events('inspection-verifier-reconciliation',run.id),notices:f.events.length,jobs:f.service.jobs.listJobs()};
  assert.deepEqual(await f.service.retainedVerificationSettled(input),{ready:true});assert.equal(providerChecks,2);
  assert.deepEqual(f.store.get('inspection-verifier-runs',run.id),before.run);assert.deepEqual(f.store.events('inspection-verifier-reconciliation',run.id),before.events);
  assert.equal(f.events.length,before.notices);assert.deepEqual(f.service.jobs.listJobs(),before.jobs);
  assert.equal(f.store.get<InspectionVerificationRun>('inspection-verifier-runs',run.id)!.status,'unknown');
});

test('retained candidate preflight refuses stale source/policy, active providers and unresolved original effects',async t=>{
  const f=await fixture(t),input=retainedCandidateInput(f),run=retainUnknownVerifier(f,input);
  let providerReady=true;
  Object.assign(f.service.verifier,{providerSettled:async()=>({ready:providerReady,reason:providerReady?undefined:'Original provider termination is unconfirmed.'}),providerOwnerCurrent:()=>true});
  providerReady=false;assert.equal((await f.service.retainedVerificationSettled(input)).ready,false);providerReady=true;
  for(const changed of [
    {...run,source:{...run.source,candidateId:'another-C'}},
    {...run,source:{...run.source,candidateCommit:'d'.repeat(40)}},
    {...run,policySha256:'0'.repeat(64)},
    {...run,authority:{...run.authority,authorityGeneration:3}},
  ]){f.store.set('inspection-verifier-runs',changed);assert.equal((await f.service.retainedVerificationSettled(input)).ready,false);}
  f.store.set('inspection-verifier-runs',run);
  assert.equal((await f.service.retainedVerificationSettled({...input,candidate:{...input.candidate,commit:'d'.repeat(40)}})).ready,false);
  assert.equal((await f.service.retainedVerificationSettled({...input,quality:{...f.quality,referenceIds:[]}})).ready,false);
  f.seam.contexts.set('original-active-context',f.context);assert.equal((await f.service.retainedVerificationSettled(input)).ready,false);f.seam.contexts.clear();
  const unresolved=await fixture(t),{job}=unresolved.createSession();unresolved.service.jobs.markUnknown(job.id,'A native backend outcome is genuinely unresolved.');
  const unresolvedInput=retainedCandidateInput(unresolved),unknown=unresolved.service.jobs.getJob(job.id);
  assert.equal((await unresolved.service.retainedVerificationSettled(unresolvedInput)).ready,false);assert.deepEqual(unresolved.service.jobs.getJob(job.id),unknown,'No GET-side reconciliation rewrites unknown effects');
});

test('retained candidate preflight rechecks authority after reading provider evidence',async t=>{
  const f=await fixture(t),input=retainedCandidateInput(f);retainUnknownVerifier(f,input);
  Object.assign(f.service.verifier,{providerSettled:async()=>{f.store.set('attempts',{id:'attempt',taskId:'task',generation:3,status:'failed'});return{ready:true};},providerOwnerCurrent:()=>true});
  assert.equal((await f.service.retainedVerificationSettled(input)).ready,false);
});

test('retained candidate preflight refuses a newly admitted or restarted verifier during provider inspection',async t=>{
  const f=await fixture(t),input=retainedCandidateInput(f),run=retainUnknownVerifier(f,input);
  Object.assign(f.service.verifier,{providerOwnerCurrent:()=>false,providerSettled:async()=>({ready:true})});
  assert.equal((await f.service.retainedVerificationSettled(input)).ready,false,'A late live provider cannot reuse the earlier ended receipt');
  Object.assign(f.service.verifier,{providerOwnerCurrent:()=>true,providerSettled:async()=>{
    const source={...run.source,sha256:'d'.repeat(64)};
    f.store.set('inspection-verifier-runs',{...run,id:inspectionVerificationKey({...run,source}),source});return{ready:true};
  }});
  assert.equal((await f.service.retainedVerificationSettled(input)).ready,false,'A newly admitted run invalidates the original provider inventory');
});

test('inspection service respects frozen assignment authority and rejects a retired author before any effect', async t => {
  const f = await fixture(t);
  assert.equal(f.service.authorityCurrent(f.authority), true, 'An unrelated newer goal revision does not invalidate frozen work');
  const { session } = f.createSession();
  let effects = 0;
  Object.assign(f.service.native, { observe: async () => { effects++; throw new Error('must not run'); } });
  f.store.set('attempts', { id: 'attempt', taskId: 'task', generation: 3, status: 'running' });
  await assert.rejects(f.call('factory_observe', { sessionId: session.id, requestId: 'observe' }), /stale|current|authority/i);
  assert.equal(effects, 0);
});

test('native launch journals its owned session before backend execution and preserves a lease for an unknown launch', async t => {
  const f = await fixture(t);
  const job = f.service.jobs.createJob(f.token, { idempotencyKey: 'launch', executionTargetId: 'mac-host', capability: 'macos-app-inspection', source: f.source, profile: { buildId: 'built' } });
  f.store.set('inspection-submissions', { id: job.id, kind: 'native', chatSessionId: 'chat-session', buildId: 'built' });
  Object.assign(f.service.native, { start: async () => {
    assert.equal(f.service.jobs.sessions(job.id).length, 1, 'Ownership must exist before a launch can have effects');
    const session=f.service.jobs.sessions(job.id)[0]!;
    assert.equal(f.store.get<{backendSessionId:string}>('inspection-backends',session.id)?.backendSessionId,session.id,'Recovery identity must be durable before the launch');
    throw new Error('Native helper disconnected after launch');
  } });
  f.seam.pump(); await Promise.all(f.seam.active.values());
  assert.equal(f.service.jobs.getJob(job.id)!.status, 'unknown');
  assert.equal(f.service.jobs.sessions(job.id)[0]!.status, 'unknown');
  assert.equal(f.service.jobs.leases(job.id)[0]!.status, 'held');
  const replacement = f.service.jobs.createJob(f.token, { idempotencyKey: 'replacement', executionTargetId: 'mac-host', capability: 'macos-app-inspection', source: f.source, profile: {} });
  assert.equal(f.service.jobs.claimNext(), undefined);
  assert.equal(f.service.jobs.getJob(replacement.id)!.status, 'queued');
});

test('an unconfirmed browser removal retains its job, session and shared reservation',async t=>{
  const f=await fixture(t,'web'),{job,session}=f.createSession();
  Object.assign(f.service.browser,{retire:async()=>({state:'unknown',reason:'The browser process disappeared before removal was recorded.'})});
  await assert.rejects(f.call('factory_stop',{sessionId:session.id}),/disappeared/);
  assert.equal(f.service.jobs.getSession(session.id)!.status,'ready');
  assert.equal(f.service.jobs.leases(job.id)[0]!.status,'held');
});

test('a locked desktop detected before launch releases this unallocated request without inventing an unknown process',async t=>{
  const f=await fixture(t);
  const job=f.service.jobs.createJob(f.token,{idempotencyKey:'locked-launch',executionTargetId:'mac-host',capability:'macos-app-inspection',source:f.source,profile:{buildId:'built'}});
  f.store.set('inspection-submissions',{id:job.id,kind:'native',chatSessionId:'chat-session',buildId:'built'});
  let launches=0;Object.assign(f.service.native,{readiness:async()=>({status:'setup-required',reasons:['Unlock the Mac desktop.']}),start:async()=>{launches++;throw new Error('must not launch');}});
  f.seam.pump();await Promise.all(f.seam.active.values());
  assert.equal(launches,0);assert.equal(f.service.jobs.sessions(job.id).length,0);
  assert.equal(f.service.jobs.getJob(job.id)!.status,'failed');assert.match(f.service.jobs.getJob(job.id)!.reason!,/Unlock/);
  assert.equal(f.service.jobs.leases(job.id)[0]!.status,'released');
});

test('a readiness race releases only the exact backend-confirmed unallocated native session',async t=>{
  for(const matches of [true,false])await t.test(matches?'matching owner':'different owner',async t=>{
    const f=await fixture(t),job=f.service.jobs.createJob(f.token,{idempotencyKey:'race',executionTargetId:'mac-host',capability:'macos-app-inspection',source:f.source,profile:{buildId:'built'}});
    f.store.set('inspection-submissions',{id:job.id,kind:'native',chatSessionId:'chat-session',buildId:'built'});
    Object.assign(f.service.native,{start:async(_build:string,_attempt:string,sessionId:string)=>{throw Object.assign(new Error('Desktop locked before allocation.'),{code:'session-not-allocated',allocationOutcome:'not-allocated',sessionId:matches?sessionId:'other-owned-session'});}});
    f.seam.pump();await Promise.all(f.seam.active.values());
    assert.equal(f.service.jobs.getJob(job.id)!.status,matches?'failed':'unknown');
    assert.equal(f.service.jobs.leases(job.id)[0]!.status,matches?'released':'held');
    assert.equal(f.service.jobs.sessions(job.id)[0]!.status,matches?'stopped':'unknown');
  });
});

test('restart reconciliation releases only confirmed owned resources and preserves historical unknown inputs',async t=>{
  const f=await fixture(t),{job,session}=f.createSession();
  const observationAction=f.service.jobs.beginAction(f.token,session.id,{idempotencyKey:'observe',kind:'observe',arguments:{}});
  f.service.jobs.markActionRunning(observationAction.action.id);
  f.service.jobs.recoverAfterRestart();
  Object.assign(f.service.native,{recoverStop:async(id:string)=>{assert.equal(id,'backend');return {status:'unknown',reason:'Process identity changed.'};}});
  await f.seam.recoverOwnedSessions();
  assert.equal(f.service.jobs.getJob(job.id)!.status,'unknown');assert.equal(f.service.jobs.leases(job.id)[0]!.status,'held');
  Object.assign(f.service.native,{recoverStop:async()=>({status:'stopped',originalProcessExited:true,historicalActionsRemainUnknown:true})});
  await f.seam.recoverOwnedSessions();
  assert.equal(f.service.jobs.getJob(job.id)!.status,'failed');assert.equal(f.service.jobs.getSession(session.id)!.status,'stopped');
  assert.equal(f.service.jobs.leases(job.id)[0]!.status,'released');assert.equal(f.service.jobs.actions(session.id)[0]!.status,'unknown');
});

test('verifier reboot reconciliation stops only its original jobs while unrelated active inspection survives',async t=>{
  const f=await fixture(t),owned=f.createSession();
  const action=f.service.jobs.beginAction(f.token,owned.session.id,{idempotencyKey:'interrupted-action',kind:'observe',arguments:{}});
  f.service.jobs.markActionRunning(action.action.id);f.service.jobs.recoverAfterRestart();
  const otherAuthority={...f.authority,taskId:'other-task',attemptId:'other-attempt'};
  f.store.set('tasks',{id:otherAuthority.taskId,goalId:'goal',currentAttemptId:otherAuthority.attemptId});
  f.store.set('attempts',{id:otherAuthority.attemptId,taskId:otherAuthority.taskId,generation:2,status:'running'});
  f.store.set('factory-attempt-details',{id:otherAuthority.attemptId,assignmentGoalRevision:4});
  const otherToken=f.service.jobs.issueAuthority(otherAuthority,{capabilities:['chromium-inspection'],executionTargetIds:['container']}).token;
  const other=f.service.jobs.createJob(otherToken,{idempotencyKey:'other-live-browser',executionTargetId:'container',capability:'chromium-inspection',source:{snapshotId:'other-source',sha256:'e'.repeat(64)},profile:{}});
  assert.equal(f.service.jobs.claimNext()!.id,other.id);f.service.jobs.markRunning(other.id);
  const otherSession=f.service.jobs.openSession(other.id);f.service.jobs.markSessionReady(otherSession.id);
  f.store.set('inspection-backends',{id:otherSession.id,kind:'browser',backendSessionId:'other-live-backend'});
  f.seam.active.set(other.id,Promise.resolve());
  f.seam.contexts.set('other-context',{...f.context,attemptId:otherAuthority.attemptId});
  let ownStops=0,otherStops=0;
  Object.assign(f.service.native,{recoverStop:async(id:string)=>{assert.equal(id,'backend');ownStops++;return {status:'stopped'};}});
  Object.assign(f.service.browser,{retire:async()=>{otherStops++;throw new Error('Unrelated browser must remain live');}});
  const run={id:'original-verifier',authority:f.authority,source:f.source} as InspectionVerificationRun;
  assert.equal(await f.seam.reconcileVerifierInspection(run,new AbortController().signal),true);
  assert.equal(ownStops,1);assert.equal(otherStops,0);
  assert.equal(f.service.jobs.getJob(owned.job.id)!.status,'failed');assert.equal(f.service.jobs.getSession(owned.session.id)!.status,'stopped');
  assert.equal(f.service.jobs.actions(owned.session.id)[0]!.status,'unknown');
  assert.equal(f.service.jobs.getJob(other.id)!.status,'running');assert.equal(f.service.jobs.getSession(otherSession.id)!.status,'ready');
  assert.equal(f.service.jobs.leases(other.id)[0]!.status,'held');
});

test('verifier reconciliation cannot stop or replace a related inspection with a live job or tool context',async t=>{
  for(const owner of ['job','context'] as const)await t.test(owner,async t=>{
    const f=await fixture(t),{job,session}=f.createSession();
    if(owner==='job')f.seam.active.set(job.id,Promise.resolve());else f.seam.contexts.set('live-context',f.context);
    let stops=0;Object.assign(f.service.native,{recoverStop:async()=>{stops++;return {status:'stopped'};}});
    assert.equal(await f.seam.reconcileVerifierInspection({id:'original-verifier',authority:f.authority,source:f.source} as InspectionVerificationRun,new AbortController().signal),false);
    assert.equal(stops,0);assert.equal(f.service.jobs.getSession(session.id)!.status,'ready');assert.equal(f.service.jobs.leases(job.id)[0]!.status,'held');
  });
});

test('reusing a native build request with different semantic arguments rejects before another capture', async t => {
  const f = await fixture(t); f.seam.closing = true;
  f.store.set('inspection-project-profiles', { id: 'project', profiles: [{ id: 'one' }, { id: 'two' }] });
  const first = value<{ job: { id: string } }>(await f.call('factory_native_build', { profileId: 'one', requestId: 'build' }));
  const count = f.store.list('inspection-source-snapshots').length;
  assert.equal(value<{ job: { id: string } }>(await f.call('factory_native_build', { profileId: 'one', requestId: 'build' })).job.id, first.job.id);
  await assert.rejects(f.call('factory_native_build', { profileId: 'two', requestId: 'build' }), /reused|different arguments/);
  assert.equal(f.store.list('inspection-source-snapshots').length, count);
});

function recordedBrowserCapture(f: Awaited<ReturnType<typeof fixture>>) {
  f.context.execution = { ...f.context.execution, kind: 'container', targetId: 'container', containerId: 'non-live-author-container' };
  f.seam.closing = true;
  let captures = 0;
  f.seam.capture = async (context, authority) => {
    captures++;
    assert.equal(context, f.context);
    assert.deepEqual(authority, f.authority);
    return f.store.get<{ id: string; snapshot: InspectionSnapshot; source: InspectionSourceIdentity }>('inspection-source-snapshots', f.source.snapshotId)!;
  };
  return () => captures;
}

test('browser start rejects malformed initial viewports before source capture or job allocation', async t => {
  const f = await fixture(t, 'web'), captures = recordedBrowserCapture(f);
  const invalid: unknown[] = [
    null, [], '1440x900', {}, { width: 1440 }, { height: 900 },
    { width: 0, height: 900 }, { width: -1, height: 900 }, { width: 1440, height: 0 },
    { width: 1440.5, height: 900 }, { width: 1440, height: 900.5 },
    { width: '1440', height: 900 }, { width: 1440, height: true },
    { width: Number.NaN, height: 900 }, { width: 1440, height: Number.POSITIVE_INFINITY },
    { width: Number.MAX_SAFE_INTEGER + 1, height: 900 },
    { width: 4097, height: 900 }, { width: 1440, height: 4097 },
    { width: 1440, height: 900, scale: 1 },
  ];
  for (const [index, viewport] of invalid.entries()) {
    await assert.rejects(f.call('factory_browser_start', { requestId: `invalid-${index}`, viewport }), /viewport/i);
  }
  assert.equal(captures(), 0);
  assert.equal(f.store.list('inspection-jobs').length, 0);
  assert.equal(f.store.list('inspection-submissions').length, 0);
  assert.equal(f.store.list('inspection-request-jobs').length, 0);
  assert.equal(f.store.list('inspection-source-snapshots').length, 1);
});

test('browser start retains canonical viewport dimensions and rejects conflicting request replay without recapturing source', async t => {
  const f = await fixture(t, 'web'), captures = recordedBrowserCapture(f);
  const viewport = { height: 4096, width: 1 };
  const first = value<{ job: InspectionJob }>(await f.call('factory_browser_start', { requestId: 'sized-browser', viewport })).job;
  viewport.width = 320; viewport.height = 240;
  assert.deepEqual(first.profile, { viewport: { width: 1, height: 4096 } });
  assert.deepEqual(first.source, f.source);
  assert.deepEqual(first.authority, f.authority);
  const submission = f.store.get<{ viewport?: { width: number; height: number }; snapshot: InspectionSnapshot; containerId: string }>('inspection-submissions', first.id)!;
  assert.deepEqual(submission.viewport, { width: 1, height: 4096 });
  assert.equal(submission.snapshot.id, f.source.snapshotId);
  assert.equal(submission.containerId, f.context.execution.containerId);
  assert.deepEqual(f.service.jobs.getJob(first.id)!.profile, first.profile, 'Mutating the caller object cannot change retained dimensions');
  const replay = value<{ job: InspectionJob }>(await f.call('factory_browser_start', { requestId: 'sized-browser', viewport: { width: 1, height: 4096 } })).job;
  assert.equal(replay.id, first.id);
  for (const args of [
    { requestId: 'sized-browser', viewport: { width: 2, height: 4096 } },
    { requestId: 'sized-browser', viewport: { width: 1, height: 4095 } },
    { requestId: 'sized-browser' },
  ]) await assert.rejects(f.call('factory_browser_start', args), /reused|different arguments/);
  assert.equal(captures(), 1);
  assert.equal(f.service.jobs.listJobs().length, 1);
  assert.deepEqual(f.service.jobs.getJob(first.id)!.source, f.source);
  assert.deepEqual(f.service.jobs.getJob(first.id)!.authority, f.authority);
  assert.equal(f.store.list('inspection-source-snapshots').length, 1);
});

test('browser start keeps the omitted viewport default and distinguishes explicit dimensions on replay', async t => {
  const f = await fixture(t, 'web'), captures = recordedBrowserCapture(f);
  const first = value<{ job: InspectionJob }>(await f.call('factory_browser_start', { requestId: 'default-browser' })).job;
  assert.deepEqual(first.profile, {});
  assert.equal(Object.hasOwn(f.store.get<Record<string, unknown>>('inspection-submissions', first.id)!, 'viewport'), false);
  assert.equal(value<{ job: InspectionJob }>(await f.call('factory_browser_start', { requestId: 'default-browser' })).job.id, first.id);
  await assert.rejects(f.call('factory_browser_start', { requestId: 'default-browser', viewport: { width: 1440, height: 900 } }), /reused|different arguments/);
  assert.equal(captures(), 1);
  assert.equal(f.service.jobs.listJobs().length, 1);
  assert.deepEqual(first.source, f.source);
  assert.deepEqual(first.authority, f.authority);
});

test('delayed browser preparation uses the retained initial viewport before marking its session ready', async t => {
  for (const viewport of [{ width: 1440, height: 900 }, undefined]) await t.test(viewport ? 'explicit dimensions' : 'omitted default', async t => {
    const f = await fixture(t, 'web'), captures = recordedBrowserCapture(f);
    const first = value<{ job: InspectionJob }>(await f.call('factory_browser_start', { requestId: 'delayed-browser', ...(viewport ? { viewport } : {}) })).job;
    assert.equal(first.status, 'queued');
    assert.equal(f.service.jobs.sessions(first.id).length, 0);
    const restarted = new InspectionService(f.service.app, {} as ChatController), seam = restarted as unknown as TestSeam;
    let release!: () => void, preparations = 0, toolReads = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    Object.assign(restarted.browser, {
      prepare: async (identity: Parameters<typeof restarted.browser.prepare>[0], options: Parameters<typeof restarted.browser.prepare>[1]) => {
        preparations++;
        assert.deepEqual(identity.viewport, viewport);
        assert.equal(Object.hasOwn(identity, 'viewport'), viewport !== undefined);
        assert.equal(identity.authorContainerId, f.context.execution.containerId);
        assert.equal(identity.authorityGeneration, f.authority.authorityGeneration);
        assert.deepEqual(identity.source, { snapshotSha256: f.source.sha256, dirty: true });
        assert.equal(restarted.jobs.getSession(identity.id)!.status, 'starting');
        options?.assertCurrent?.();
        await pending;
        return { id: identity.id, state: 'ready' };
      },
      listTools: async () => { toolReads++; return [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }]; },
    });
    seam.pump();
    const active = [...seam.active.values()], session = restarted.jobs.sessions(first.id)[0]!;
    assert.equal(preparations, 1);
    assert.equal(active.length, 1);
    assert.equal(session.status, 'starting');
    const before = value<{ tools?: unknown }>(await seam.call(f.context, f.token, 'factory_job_status', { jobId: first.id }));
    assert.equal(before.tools, undefined); assert.equal(toolReads, 0);
    release(); await Promise.all(active);
    assert.equal(restarted.jobs.getSession(session.id)!.status, 'ready');
    assert.deepEqual(restarted.jobs.getJob(first.id)!.source, f.source);
    assert.deepEqual(restarted.jobs.getJob(first.id)!.authority, f.authority);
    const after = value<{ tools: Array<{ name: string }> }>(await seam.call(f.context, f.token, 'factory_job_status', { jobId: first.id }));
    assert.equal(after.tools[0]!.name, 'browser_snapshot'); assert.equal(toolReads, 1);
    assert.equal(captures(), 1, 'A delayed pump never recaptures or replaces the retained source');
  });
});

test('reference inspection binds configured reference identity and retains the exact returned original manifest', async t => {
  const f = await fixture(t); f.createSession();
  await assert.rejects(f.call('factory_reference', { sourceSnapshotId: f.source.snapshotId, referenceId: 'enough-ui', rootId: 'primary', relativePath: 'README.md' }), /reference|root/i);
  const result = await f.call('factory_reference', { sourceSnapshotId: f.source.snapshotId, referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  assert.match(result.content[1]!.text!, /Original EnoughUI/);
  const view = f.store.list<InspectionReferenceView>('inspection-reference-views')[0]!;
  assert.equal(view.referenceId, 'enough-ui');
  assert.deepEqual(view.artifacts?.[0], value<{ artifact: unknown }>(result).artifact);
});

test('changed browser author source refuses an effect before the backend receives input', async t => {
  const f = await fixture(t, 'web'), { session } = f.createSession();
  let effects = 0;
  Object.assign(f.service.browser, { call: async () => { effects++; throw new Error('must not run'); } });
  await writeFile(path.join(f.workdir, 'README.md'), 'Changed app source after preview started');
  await assert.rejects(f.call('factory_observe', { sessionId: session.id, requestId: 'observe' }), /Source changed/);
  assert.equal(effects, 0);
  assert.equal(f.service.jobs.actions(session.id).length, 0);
});

test('native workflow observation/action/assertion produces certifiable original evidence and rejects stale actions', async t => {
  const f = await fixture(t), { session, job } = f.createSession();
  const screenshotPath = path.join(f.directory, 'native.png'); await writeFile(screenshotPath, png);
  let composer = true;
  Object.assign(f.service.native, {
    observe: async () => ({ observationId: composer ? 'backend-before' : 'backend-after', elements: composer ? [{ id: 'close', label: 'Close draft', value: '', identifier: 'close' }, { id: 'composer', label: 'Composer', value: 'Draft' }] : [{ id: 'inbox', label: 'Inbox', value: '' }], truncated: false, screenshot: { path: screenshotPath, width: 1, height: 1 } }),
    act: async (_id: string, action: { observationId: string }) => { assert.equal(action.observationId, 'backend-before'); composer = false; return { ok: true }; },
  });
  const beforeResult = await f.call('factory_observe', { sessionId: session.id, requestId: 'before' }); f.deliver(beforeResult);
  const before = value<{ observationId: string; screenshotEvidenceId: string }>(beforeResult);
  const action = value<{ actionId: string }>(await f.call('factory_native_action', { sessionId: session.id, requestId: 'close', observationId: before.observationId, action: { kind: 'click', target: 'close' } }));
  await assert.rejects(f.call('factory_native_action', { sessionId: session.id, requestId: 'stale-close', observationId: before.observationId, action: { kind: 'click', target: 'close' } }), /fresh|stale|observation/i);
  const afterResult = await f.call('factory_observe', { sessionId: session.id, requestId: 'after' }); f.deliver(afterResult);
  const after = value<{ observationId: string; screenshotEvidenceId: string }>(afterResult);
  const assertion = value<{ passed: boolean; evidenceId: string }>(await f.call('factory_assert', { sessionId: session.id, observationId: after.observationId, labelIncludes: 'Composer', absent: true }));
  assert.equal(assertion.passed, true);
  const assertionEvidence = f.store.get<InspectionEvidence>('inspection-evidence', assertion.evidenceId)!;
  assert.equal(assertionEvidence.kind, 'assertion'); assert.equal(assertionEvidence.metadata?.observationId, after.observationId);
  assert.equal(JSON.parse((await f.service.artifacts.read(assertionEvidence.artifact)).toString()).passed, true);
  await f.call('factory_reference', { sourceSnapshotId: f.source.snapshotId, referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  const report: QualityEvidenceReport = { version: 1, source: f.source, workflows: [{ id: 'close-draft', platform: 'macos', before: before.screenshotEvidenceId, action: action.actionId, after: after.screenshotEvidenceId, assertion: 'Composer disappeared after Close draft.', assertionEvidenceId: assertion.evidenceId, outcome: 'passed' }], reviews: [{ platform: 'macos', observations: [before.screenshotEvidenceId, after.screenshotEvidenceId], references: [{ id: 'enough-ui', comparison: 'EnoughUI semantic controls match the supplied source.' }], dimensions: { hierarchy: 'Inbox is primary after closing.', spacing: 'Padding preserves readable control gaps.', clipping: 'All content is visible.', typography: 'Labels remain legible.', controls: 'Close belongs to the visible composer.', states: 'Inbox appears after close.' }, defects: [] }] };
  const submitted = value<InspectionQualityRecord>(await f.call('factory_quality_submit', { report }));
  assert.equal(submitted.gate.status, 'ready-for-review');
  assert.equal((await f.service.quality.check({ authority: f.authority, quality: f.quality, source: f.source, candidateCommit: 'c'.repeat(40) })).passed, true);
  assert.equal(f.service.jobs.evidence(job.id).filter(evidence => evidence.kind === 'screenshot').length, 2);
});

test('local native exact assertions preserve the entire observed value and do not invent missing empty values', async t => {
  const f = await fixture(t), { session } = f.createSession();
  const screenshotPath = path.join(f.directory, 'native-exact.png'); await writeFile(screenshotPath, png);
  Object.assign(f.service.native, {
    observe: async () => ({ observationId: 'backend-exact', elements: [
      { id: 'recipient', label: 'Recipient', value: 'person@example.com' },
      { id: 'from', label: 'From, owner@example.com', value: null },
      { id: 'body', label: 'Message body', value: 'Complete body' },
      { id: 'empty', label: 'Empty subject', value: '' },
      { id: 'missing', label: 'Save draft' },
    ], truncated: false, screenshot: { path: screenshotPath, width: 1, height: 1 } }),
  });
  const observed = value<{ observationId: string }>(await f.call('factory_observe', { sessionId: session.id, requestId: 'exact-observation' }));
  const cases = [
    ['Recipient', 'person@example.com', true], ['Recipient', 'person', false], ['Recipient', 'example.com', false],
    ['Message body', 'Complete body', true], ['Message body', 'Complete body suffix', false],
    ['Empty subject', '', true], ['Save draft', '', false],
  ] as const;
  for (const [labelIncludes, valueEquals, expected] of cases) {
    const result = value<{ passed: boolean; evidenceId: string }>(await f.call('factory_assert', { sessionId: session.id, observationId: observed.observationId, labelIncludes, valueEquals }));
    assert.equal(result.passed, expected, `${labelIncludes} must preserve exact observed string equality`);
    const evidence = f.store.get<InspectionEvidence>('inspection-evidence', result.evidenceId)!;
    assert.equal(evidence.source.sha256, f.source.sha256); assert.equal(evidence.metadata?.observationId, observed.observationId);
    assert.equal(JSON.parse((await f.service.artifacts.read(evidence.artifact)).toString()).condition.valueEquals, valueEquals);
  }
  for (const [labelEquals, expected] of [['From, owner@example.com', true], ['From, owner', false], ['From, owner@example.com suffix', false]] as const) {
    const result = value<{ passed: boolean; evidenceId: string }>(await f.call('factory_assert', { sessionId: session.id, observationId: observed.observationId, labelIncludes: 'From', labelEquals }));
    assert.equal(result.passed, expected, 'Exact read-only text comes from the observed label even when the value is null');
    const evidence = f.store.get<InspectionEvidence>('inspection-evidence', result.evidenceId)!;
    assert.equal(evidence.source.sha256, f.source.sha256); assert.equal(evidence.metadata?.observationId, observed.observationId);
    assert.equal(JSON.parse((await f.service.artifacts.read(evidence.artifact)).toString()).condition.labelEquals, labelEquals);
  }
  assert.equal(value<{ passed: boolean }>(await f.call('factory_assert', { sessionId: session.id, observationId: observed.observationId, labelIncludes: 'From', labelEquals: 'From, owner@example.com', valueEquals: '' })).passed, false, 'Exact label does not fabricate an editable value');
  await f.call('factory_observe', { sessionId: session.id, requestId: 'new-exact-observation' });
  await assert.rejects(f.call('factory_assert', { sessionId: session.id, observationId: observed.observationId, labelIncludes: 'Recipient', valueEquals: 'person@example.com' }), /Re-observe|current|stale/i);
});

test('browser assertions preserve unnamed text and actual input values rather than ARIA metadata', async t => {
  const f = await fixture(t, 'web'), { session } = f.createSession();
  const tree = '### Page state\n- Page URL: http://127.0.0.1:3000/\n### Page Snapshot\n```yaml\n- text: Composer\n- status [ref=e7]: Saved\n- textbox "Body" [ref=e8]: draft text\n- button "Close draft" [ref=e9]\n```\n';
  const artifact = await f.service.artifacts.put(png, { name: 'browser.png', mime: 'image/png', goalId: 'goal', taskId: 'task', attemptId: 'attempt' });
  Object.assign(f.service.browser, {
    listTools: async () => [{ name: 'browser_snapshot' }, { name: 'browser_take_screenshot' }],
    call: async (_id: string, tool: string) => ({ result: { content: tool === 'browser_snapshot' ? [{ type: 'text', text: tree }] : [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }, artifacts: tool === 'browser_snapshot' ? [] : [artifact] } as BrowserObservation),
  });
  const result = await f.call('factory_observe', { sessionId: session.id, requestId: 'observe' }); f.deliver(result);
  const observed = value<{ observationId: string }>(result);
  const absent = value<{ passed: boolean; evidenceId: string }>(await f.call('factory_assert', { sessionId: session.id, observationId: observed.observationId, labelIncludes: 'Composer', absent: true }));
  assert.equal(absent.passed, false, 'Visible unnamed text cannot be certified absent');
  const metadata = value<{ passed: boolean }>(await f.call('factory_assert', { sessionId: session.id, observationId: observed.observationId, labelIncludes: 'Close draft', valueIncludes: 'ref=e9' }));
  assert.equal(metadata.passed, false, 'Element reference metadata is not its actual value');
  assert.equal(f.store.get<InspectionEvidence>('inspection-evidence', absent.evidenceId)!.kind, 'assertion');
});

test('a browser tool cannot execute a native action while disguising it as an observation', async t => {
  const f = await fixture(t), { session } = f.createSession();
  const screenshotPath = path.join(f.directory, 'native.png'); await writeFile(screenshotPath, png);
  let effects = 0;
  Object.assign(f.service.native, {
    observe: async () => ({ observationId: 'backend-before', elements: [{ id: 'close', label: 'Close draft', value: '' }], truncated: false, screenshot: { path: screenshotPath, width: 1, height: 1 } }),
    act: async () => { effects++; return { ok: true }; },
  });
  const observed = value<{ observationId: string }>(await f.call('factory_observe', { sessionId: session.id, requestId: 'before' }));
  await assert.rejects(f.call('factory_browser_call', { sessionId: session.id, requestId: 'disguised', observationId: observed.observationId, tool: 'browser_snapshot', arguments: { kind: 'click', elementId: 'close' } }), /browser|native|tool|backend/i);
  assert.equal(effects, 0);
  assert.equal(f.service.jobs.actions(session.id).length, 1);
});

test('an error snapshot with valid screenshot pixels cannot certify an absent UI element', async t => {
  const f = await fixture(t, 'web'), { session } = f.createSession();
  const artifact = await f.service.artifacts.put(png, { name: 'browser.png', mime: 'image/png', goalId: 'goal', taskId: 'task', attemptId: 'attempt' });
  Object.assign(f.service.browser, {
    listTools: async () => [{ name: 'browser_snapshot' }, { name: 'browser_take_screenshot' }],
    call: async (_id: string, tool: string) => ({ result: tool === 'browser_snapshot' ? { isError: true, content: [{ type: 'text', text: 'Error: Snapshot unavailable' }] } : { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }, artifacts: tool === 'browser_snapshot' ? [] : [artifact] } as BrowserObservation),
  });
  await f.call('factory_observe', { sessionId: session.id, requestId: 'error-observation' }).catch(() => undefined);
  assert.equal(f.service.jobs.getSession(session.id)!.latestObservationId, undefined, 'An unsuccessful snapshot must not create assertion-ready UI state');
  assert.equal(f.store.list('inspection-structured-observations').length, 0);
});

test('browser workflow passes the enforced quality gate only with resulting UI assertions and delivered screenshots', async t => {
  const f = await fixture(t, 'web'), { session } = f.createSession();
  const artifact = await f.service.artifacts.put(png, { name: 'browser.png', mime: 'image/png', goalId: 'goal', taskId: 'task', attemptId: 'attempt' });
  let composer = true;
  Object.assign(f.service.browser, {
    listTools: async () => [{ name: 'browser_snapshot' }, { name: 'browser_take_screenshot' }, { name: 'browser_click' }],
    call: async (_id: string, tool: string) => {
      if (tool === 'browser_click') { composer = false; return { result: { content: [{ type: 'text', text: 'Clicked Close draft' }] }, artifacts: [] } as unknown as BrowserObservation; }
      const tree = `### Page Snapshot\n\`\`\`yaml\n${composer ? '- text: Composer\n- button "Close draft" [ref=e9]' : '- heading "Inbox" [ref=e10]'}\n\`\`\`\n`;
      return { result: { content: tool === 'browser_snapshot' ? [{ type: 'text', text: tree }] : [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }, artifacts: tool === 'browser_snapshot' ? [] : [artifact] } as BrowserObservation;
    },
  });
  const beforeResult = await f.call('factory_observe', { sessionId: session.id, requestId: 'before' }); f.deliver(beforeResult);
  const before = value<{ observationId: string; evidenceIds: string[] }>(beforeResult);
  const action = value<{ actionId: string }>(await f.call('factory_browser_call', { sessionId: session.id, requestId: 'close', observationId: before.observationId, tool: 'browser_click', arguments: { ref: 'e9', element: 'Close draft' } }));
  const afterResult = await f.call('factory_observe', { sessionId: session.id, requestId: 'after' }); f.deliver(afterResult);
  const after = value<{ observationId: string; evidenceIds: string[] }>(afterResult);
  const assertion = value<{ passed: boolean; evidenceId: string }>(await f.call('factory_assert', { sessionId: session.id, observationId: after.observationId, labelIncludes: 'Composer', absent: true }));
  assert.equal(assertion.passed, true);
  await f.call('factory_reference', { sourceSnapshotId: f.source.snapshotId, referenceId: 'enough-ui', rootId: 'enough-ui', relativePath: 'Button.swift' });
  const report: QualityEvidenceReport = { version: 1, source: f.source, workflows: [{ id: 'close-draft', platform: 'web', before: before.evidenceIds[0]!, action: action.actionId, after: after.evidenceIds[0]!, outcome: 'passed', assertion: 'Composer disappears and the inbox returns.', assertionEvidenceId: assertion.evidenceId }], reviews: [{ platform: 'web', observations: [before.evidenceIds[0]!, after.evidenceIds[0]!], references: [{ id: 'enough-ui', comparison: 'Close uses the supplied design-system control.' }], dimensions: { hierarchy: 'Inbox is the primary screen.', spacing: 'Controls retain deliberate gaps.', clipping: 'All actions fit the viewport.', typography: 'Heading and controls are distinct.', controls: 'Close draft is actionable.', states: 'Inbox appears after the click.' }, defects: [] }] };
  const submitted = value<InspectionQualityRecord>(await f.call('factory_quality_submit', { report }));
  assert.equal(submitted.gate.status, 'ready-for-review');
  assert.equal((await f.service.quality.check({ authority: f.authority, quality: f.quality, source: f.source, candidateCommit: 'c'.repeat(40) })).passed, true);
});

test('a failed refresh invalidates the previous UI observation rather than certifying stale state', async t => {
  const f = await fixture(t, 'web'), { session } = f.createSession();
  const artifact = await f.service.artifacts.put(png, { name: 'browser.png', mime: 'image/png', goalId: 'goal', taskId: 'task', attemptId: 'attempt' });
  let fail = false;
  Object.assign(f.service.browser, {
    listTools: async () => [{ name: 'browser_snapshot' }, { name: 'browser_take_screenshot' }],
    call: async (_id: string, tool: string) => ({ result: tool !== 'browser_snapshot' ? { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] } : fail ? { isError: true, content: [{ type: 'text', text: 'Error: UI snapshot unavailable' }] } : { content: [{ type: 'text', text: '### Snapshot\n```yaml\n- heading "Inbox" [ref=e1]\n```\n' }] }, artifacts: tool === 'browser_snapshot' ? [] : [artifact] } as BrowserObservation),
  });
  const prior = value<{ observationId: string }>(await f.call('factory_observe', { sessionId: session.id, requestId: 'valid' }));
  assert.equal(f.service.jobs.getSession(session.id)!.latestObservationId, prior.observationId);
  fail = true;
  await f.call('factory_observe', { sessionId: session.id, requestId: 'failed-refresh' }).catch(() => undefined);
  assert.equal(f.service.jobs.getSession(session.id)!.latestObservationId, undefined);
  await assert.rejects(f.call('factory_assert', { sessionId: session.id, observationId: prior.observationId, labelIncludes: 'Composer', absent: true }), /Re-observe|current|stale/i);
  assert.ok(f.service.jobs.observation(prior.observationId), 'Historical evidence remains available without remaining current');
});

test('native restart completes only after exit acknowledgement and an uncertain restart retains its lease', async t => {
  for (const uncertain of [false, true]) {
    const f = await fixture(t), { session, job } = f.createSession();
    const screenshotPath = path.join(f.directory, 'native.png'); await writeFile(screenshotPath, png);
    let restarts = 0;
    Object.assign(f.service.native, {
      observe: async () => ({ observationId: 'backend-before', elements: [{ id: 'draft', label: 'Draft body', value: 'retained text' }], truncated: false, screenshot: { path: screenshotPath, width: 1, height: 1 } }),
      restart: async (_id: string, observationId: string) => {
        assert.equal(observationId, 'backend-before'); restarts++;
        if (uncertain) throw Object.assign(new Error('Restart acknowledgement unavailable'), { code: 'restart-unknown' });
        return { previousProcessExited: true, pid: 12345 };
      },
    });
    const before = value<{ observationId: string }>(await f.call('factory_observe', { sessionId: session.id, requestId: 'before-restart' }));
    const args = { sessionId: session.id, requestId: 'restart', observationId: before.observationId };
    if (uncertain) {
      await assert.rejects(f.call('factory_native_restart', args), /acknowledgement/);
      assert.equal(f.service.jobs.getJob(job.id)!.status, 'unknown');
      assert.equal(f.service.jobs.leases(job.id)[0]!.status, 'held');
    } else {
      const outcome = value<{ actionId: string }>(await f.call('factory_native_restart', args));
      assert.equal(f.service.jobs.actions(session.id).find(action => action.id === outcome.actionId)!.status, 'succeeded');
      assert.equal(f.service.jobs.actions(session.id).find(action => action.id === outcome.actionId)!.kind, 'restart');
      assert.equal(f.service.jobs.getSession(session.id)!.processIdentity?.pid, 12345);
      assert.equal(f.service.jobs.getSession(session.id)!.latestObservationId, undefined);
      await f.call('factory_native_restart', args);
      assert.equal(restarts, 1, 'Retried request must never launch another process');
    }
  }
});

test('browser exact form observations retain original raw DOM evidence and reject flattened or stale-page assertions', async t => {
  const f=await fixture(t,'web'), {session}=f.createSession();
  const artifact=await f.service.artifacts.put(png,{name:'browser.png',mime:'image/png',goalId:'goal',taskId:'task',attemptId:'attempt'});
  const href='http://127.0.0.1:3000/', body='First line\nMiddle line\nLast line\n';
  const snapshot=`### Page\n- Page URL: ${href}\n### Snapshot\n\`\`\`yaml\n- textbox "Message" [ref=e81]: First line Middle line Last line\n- button "Close" [ref=e82]\n\`\`\`\n`;
  let changed=false, pageReads=0, userScriptReads=0;
  const lease={id:'backend',sessionId:'chat-session',goalId:'goal',taskId:'task',attemptId:'attempt',authorityGeneration:2,source:{snapshotSha256:f.source.sha256}};
  Object.assign(f.service.browser,{
    listTools:async()=>['browser_snapshot','browser_take_screenshot','browser_evaluate','browser_tabs','browser_console_messages','browser_network_requests'].map(name=>({name})),
    call:async(_id:string,tool:string,args:Record<string,unknown>)=>{
      let result:BrowserObservation['result'];
      if(tool==='browser_tabs') result={content:[{type:'text',text:`### Open tabs\n- 0: (current) [Mail](${href})\n`}]};
      else if(['browser_snapshot','browser_console_messages','browser_network_requests'].includes(tool)) result={content:[{type:'text',text:snapshot}]};
      else if(tool==='browser_take_screenshot') result={content:[{type:'image',mimeType:'image/png',data:png.toString('base64')}]};
      else if(args.target){
        assert.equal(args.target,'e81');assert.equal(args.element,'Message');assert(!String(args.function).includes(body));
        const json={version:1,href,timeOrigin:42,connected:true,tag:'textarea',value:body};
        result={content:[{type:'text',text:`### Result\n${JSON.stringify(json)}\n### Ran Playwright code\nAgent assertions and generated code are not structured UI values.`}]};
      }else if(String(args.function).includes('document.URL')){
        pageReads++;result={content:[{type:'text',text:`### Result\n${JSON.stringify({version:1,href,timeOrigin:changed&&pageReads%2===0?43:42})}\n`}]};
      }else{userScriptReads++;result={content:[{type:'text',text:'### Result\n{"value":"fabricated","expectedMatches":true}\n'}]};}
      return {lease,result,artifacts:tool==='browser_take_screenshot'?[artifact]:[]} as BrowserObservation;
    }
  });
  const observedResult=await f.call('factory_observe',{sessionId:session.id,requestId:'full-value'});
  const observed=value<{observationId:string;exactFormValues:{artifact:Parameters<typeof f.service.artifacts.read>[0]}}>(observedResult);
  const structured=f.store.get<{elements:Array<{label:string;value?:string}>;formValues:{artifact:{id:string;sha256:string}}}>('inspection-structured-observations',observed.observationId)!;
  assert.equal(structured.elements[0]!.value,body);
  const raw=JSON.parse((await f.service.artifacts.read(observed.exactFormValues.artifact)).toString());
  assert.equal(raw.source.sha256,f.source.sha256);assert.equal(raw.inspectionSessionId,session.id);assert.equal(raw.observationId,observed.observationId);
  assert.equal(raw.fields[0].identifier,'e81');assert.equal(raw.reads.filter((read:{stage:string})=>read.stage==='field:e81').length,1);
  assert(raw.reads.find((read:{stage:string})=>read.stage==='field:e81').result.content[0].text.includes(JSON.stringify(body)));
  const exact=value<{passed:boolean;evidenceId:string}>(await f.call('factory_assert',{sessionId:session.id,observationId:observed.observationId,labelIncludes:'Message',valueEquals:body}));
  assert.equal(exact.passed,true);
  const evidence=f.store.get<InspectionEvidence>('inspection-evidence',exact.evidenceId)!;
  assert.equal(evidence.metadata?.formValuesArtifactId,structured.formValues.artifact.id);
  assert.equal(evidence.metadata?.formValuesArtifactSha256,structured.formValues.artifact.sha256);
  const assertion=JSON.parse((await f.service.artifacts.read(evidence.artifact!)).toString());
  assert.equal(assertion.formValuesArtifact.id,structured.formValues.artifact.id);
  for(const wrong of [body.trimEnd(),body.replaceAll('\n',' '),body+'suffix'])assert.equal(value<{passed:boolean}>(await f.call('factory_assert',{sessionId:session.id,observationId:observed.observationId,labelIncludes:'Message',valueEquals:wrong})).passed,false);
  await f.call('factory_browser_call',{sessionId:session.id,requestId:'untrusted-script',observationId:observed.observationId,tool:'browser_evaluate',arguments:{function:'() => ({value:"fabricated",expectedMatches:true})'}});
  assert.equal(userScriptReads,1);assert.equal(f.store.get<{elements:Array<{value?:string}>}>('inspection-structured-observations',observed.observationId)!.elements[0]!.value,body,'An agent script result does not replace broker observation values');
  for(const tool of ['browser_console_messages','browser_network_requests']){
    const logs=await f.call('factory_browser_call',{sessionId:session.id,requestId:tool,tool});
    assert.equal(value<{observationId?:string}>(logs).observationId,undefined,'Snapshot-looking diagnostic text cannot become authoritative form or reference evidence');
  }
  changed=true;pageReads=0;
  const stale=await f.call('factory_observe',{sessionId:session.id,requestId:'changed-page'});
  assert.equal((stale as {isError?:boolean}).isError,true);assert.equal(value<{observationId?:string}>(stale).observationId,undefined);
  assert.equal(f.service.jobs.getSession(session.id)!.latestObservationId,undefined);
  await assert.rejects(f.call('factory_assert',{sessionId:session.id,observationId:observed.observationId,labelIncludes:'Message',valueEquals:body}),/Re-observe/);
});
