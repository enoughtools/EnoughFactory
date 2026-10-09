import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { InspectionAuthority, InspectionEvidence, InspectionSourceIdentity, InspectionVerificationRun, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { BrowserObservation } from '@enoughfactory/browser-inspection';
import type { DeviceApp } from './app.ts';
import type { AgentToolBridgeContext, ChatController } from './chats.ts';
import { InspectionService } from './inspection-service.ts';
import type { InspectionQualityRecord, InspectionReferenceView } from './inspection-quality.ts';
import type { QualityEvidenceReport } from './factory-quality.ts';
import { Store } from './store.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Wj4sAAAAASUVORK5CYII=', 'base64');
interface ToolResult { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; }
interface TestSeam {
  call(context: AgentToolBridgeContext, token: string, name: string, args: Record<string, unknown>): Promise<ToolResult>;
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
  return { directory, workdir, referencePath, store, authority, quality, source, service, seam, context, token, call, createSession, deliver, events };
}

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
