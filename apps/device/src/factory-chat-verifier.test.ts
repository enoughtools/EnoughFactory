import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentError, RUNTIME_PINS, type AgentManager, type TurnInput } from '@enoughfactory/agents';
import type { Attempt, Chat, FactoryTask, Goal, InspectionVerificationRun, Project, RuntimeCapability, Session } from '@enoughfactory/contracts';
import type { AttemptDetail, FactoryStore } from '@enoughfactory/factory';
import type { DeviceApp } from './app.ts';
import { ChatController, type AgentToolBridgeContext } from './chats.ts';
import { assertFactoryChatCanStartTurn } from './factory-chat.ts';
import { inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verifier.ts';

class MemoryStore implements FactoryStore {
  private records = new Map<string, unknown>();
  private journal: { seq: number; topic: string; entity: string; value: unknown }[] = [];
  readonly writes: { bucket: string; value: { id: string; [key: string]: unknown } }[] = [];
  list<T>(bucket: string): T[] { return [...this.records.entries()].filter(([key]) => key.startsWith(`${bucket}:`)).map(([, value]) => structuredClone(value) as T); }
  get<T>(bucket: string, id: string): T | undefined { return structuredClone(this.records.get(`${bucket}:${id}`)) as T | undefined; }
  set<T extends { id: string }>(bucket: string, record: T): void { this.records.set(`${bucket}:${record.id}`, structuredClone(record)); this.writes.push({ bucket, value: structuredClone(record) }); }
  delete(bucket: string, id: string): void { this.records.delete(`${bucket}:${id}`); }
  transaction<T>(operation: () => T): T { return operation(); }
  append<T>(topic: string, entity: string, value: T): number { const seq = this.journal.length + 1; this.journal.push({ seq, topic, entity, value: structuredClone(value) }); return seq; }
  events<T>(topic: string, entity: string, cursor = 0): { seq: number; value: T }[] { return this.journal.filter(event => event.topic === topic && event.entity === entity && event.seq > cursor).map(({ seq, value }) => ({ seq, value: structuredClone(value) as T })); }
}

function fixture() {
  const store = new MemoryStore(), at = new Date().toISOString();
  const project: Project = { id: 'project', name: 'Mail', path: '/user/mail-primary', deviceId: 'device', createdAt: at, runtime: 'codex', approvalMode: 'approve-all', rules: [] };
  const goal: Goal = { id: 'goal', projectId: project.id, coordinatorId: 'device', title: 'Native Mail', objective: 'Deliver the native client', criteria: ['Real workflow acceptance'], status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', createdAt: at, updatedAt: at, revision: 13, concurrency: 2 };
  const task: FactoryTask = { id: 'task', goalId: goal.id, title: 'Deliver reading', description: 'Retain functional reading', dependsOn: [], status: 'review', currentAttemptId: 'author-attempt', sessionId: 'author-session', deviceId: 'device', createdAt: at, updatedAt: at };
  const attempt: Attempt = { id: 'author-attempt', taskId: task.id, generation: 5, deviceId: 'device', chatId: 'author-chat', sessionId: 'author-session', status: 'succeeded', startedAt: at, endedAt: at, candidate: 'candidate', executionTargetKind: 'container', executionTargetId: 'author-container' };
  const detail: AttemptDetail = { id: attempt.id, goalId: goal.id, goalRevision: goal.revision, assignmentGoalRevision: 11, cancellation: 'none', phase: 'checking', candidate: { id: 'candidate', commit: 'c'.repeat(40), baseCommit: 'a'.repeat(40), deviceId: 'device' }, contract: { title: task.title, description: task.description, dependsOn: [], checks: [], planRevision: 11, quality: { platforms: ['macos'], workflows: [{ id: 'read-and-reply', platform: 'macos' }], referenceIds: ['mail-web'] } } };
  const run: InspectionVerificationRun = { id: 'verification', authority: { goalId: goal.id, goalRevision: 11, taskId: task.id, attemptId: attempt.id, authorityGeneration: attempt.generation, policyRevision: 11 }, source: { snapshotId: 'combined-snapshot', sha256: 'd'.repeat(64), candidateId: detail.candidate!.id, candidateCommit: detail.candidate!.commit, checkedCommit: 'e'.repeat(40) }, quality: detail.contract!.quality!, policySha256: 'f'.repeat(64), ownerDeviceId: 'device', executionTargetKind: 'host-macos', executionTargetId: 'native-verifier', sessionId: 'verifier-session', chatId: 'verifier-chat', status: 'running', createdAt: at, updatedAt: at, startedAt: at, deadlineAt: new Date(Date.now() + 60_000).toISOString() };
  run.policySha256 = inspectionQualityPolicySha256(run.quality);
  run.id = inspectionVerificationKey(run);
  const session: Session = { id: run.sessionId!, name: 'Independent verifier', projectId: project.id, deviceId: 'device', status: 'ready', verificationRunId: run.id, executionTargetKind: run.executionTargetKind, executionTargetId: run.executionTargetId, createdAt: at, updatedAt: at, services: [] };
  const chat: Chat = { id: run.chatId!, sessionId: session.id, deviceId: 'device', verificationRunId: run.id, title: 'Verify retained native client', runtime: 'codex', approvalMode: 'approve-all', status: 'idle', createdAt: at, updatedAt: at };
  for (const [bucket, record] of [['projects', project], ['goals', goal], ['tasks', task], ['attempts', attempt], ['factory-attempt-details', detail], ['inspection-verifier-runs', run], ['sessions', session], ['chats', chat]] as const) store.set(bucket, record);
  const guard = (requestedAttemptId: string | undefined = attempt.id, requestedRunId: string | undefined = run.id, deviceId = 'device') => assertFactoryChatCanStartTurn(store, store.get<Chat>('chats', chat.id)!, deviceId, requestedAttemptId, requestedRunId);
  return { store, project, goal, task, attempt, detail, run, session, chat, guard };
}

function rekeyVerifier(f: ReturnType<typeof fixture>, updates: Partial<InspectionVerificationRun>): void {
  f.store.delete('inspection-verifier-runs', f.run.id);
  Object.assign(f.run, updates);
  f.run.policySha256 = inspectionQualityPolicySha256(f.run.quality);
  f.run.id = inspectionVerificationKey(f.run);
  f.session.verificationRunId = f.run.id;
  f.chat.verificationRunId = f.run.id;
  f.store.set('inspection-verifier-runs', f.run); f.store.set('sessions', f.session); f.store.set('chats', f.chat);
}

function finalFixture() {
  const f = fixture();
  Object.assign(f.task, { status: 'completed' });
  Object.assign(f.detail, { goalRevision: 12, phase: 'done', integration: { commit: 'f'.repeat(40), previousHead: 'a'.repeat(40), candidateCommit: f.detail.candidate!.commit, checks: [] } });
  const sibling: FactoryTask = { ...f.task, id: 'ios-task', currentAttemptId: 'ios-author', sessionId: 'ios-author-session', title: 'Retain drafts on iPhone', quality: { platforms: ['ios-simulator'], workflows: [{ id: 'draft-restart', platform: 'ios-simulator' }], referenceIds: ['native-guidelines', 'mail-web'] } };
  const siblingAttempt: Attempt = { ...f.attempt, id: sibling.currentAttemptId!, taskId: sibling.id, chatId: 'ios-author-chat', sessionId: sibling.sessionId, generation: 2 };
  const siblingDetail: AttemptDetail = { ...f.detail, id: siblingAttempt.id, assignmentGoalRevision: 12, candidate: { ...f.detail.candidate!, id: 'ios-candidate', commit: 'b'.repeat(40) }, contract: { ...f.detail.contract!, quality: sibling.quality }, integration: { ...f.detail.integration!, candidateCommit: 'b'.repeat(40) } };
  for (const [bucket, record] of [['tasks', f.task], ['factory-attempt-details', f.detail], ['tasks', sibling], ['attempts', siblingAttempt], ['factory-attempt-details', siblingDetail]] as const) f.store.set(bucket, record);
  rekeyVerifier(f, { purpose: 'goal-final', goalRevision: f.goal.revision, quality: { platforms: ['ios-simulator', 'macos'], workflows: [{ id: 'draft-restart', platform: 'ios-simulator' }, { id: 'read-and-reply', platform: 'macos' }], referenceIds: ['mail-web', 'native-guidelines'] } });
  return { ...f, sibling, siblingAttempt, siblingDetail };
}

const stale = (error: unknown): boolean => (error as { code?: string; status?: number }).code === 'INSPECTION_VERIFICATION_STALE';

test('independent verifier accepts a current succeeded author candidate with frozen assignment authority', () => {
  const f = fixture();
  assert.equal(f.run.authority.goalRevision, 11); assert.equal(f.goal.revision, 13);
  assert.notEqual(f.run.source.checkedCommit, f.run.source.candidateCommit, 'Combined verification preserves M separately from candidate C');
  assert.equal(f.chat.attemptId, undefined);
  assert.equal(f.guard(), undefined, 'The verifier receives no author-chat binding');
  const ordinary = { ...f.chat, id: f.attempt.chatId!, sessionId: f.attempt.sessionId!, verificationRunId: undefined, attemptId: f.attempt.id };
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, ordinary, 'device', f.attempt.id), error => (error as { code?: string }).code === 'FACTORY_TASK_RETRY_REQUIRED');
  f.store.set('factory-workers', { id: f.attempt.id, coordinatorId: 'device', chatId: f.attempt.chatId, sessionId: f.attempt.sessionId, status: 'succeeded', goal: f.goal, task: f.task, attempt: f.attempt });
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, { ...ordinary, id: 'new-user-chat', attemptId: undefined }, 'device'), error => (error as { code?: string }).code === 'FACTORY_TASK_RETRY_REQUIRED', 'A new ordinary chat cannot reopen the ended author session');
});

test('ordinary chats cannot reopen durable author identities after worker journal retirement', async t => {
  for (const identity of ['chat', 'session'] as const) await t.test(identity, () => {
    const f = fixture();
    const ordinary: Chat = { ...f.chat, id: identity === 'chat' ? f.attempt.chatId! : 'new-user-chat', sessionId: identity === 'session' ? f.attempt.sessionId! : 'new-user-session', verificationRunId: undefined };
    assert.equal(ordinary.attemptId, undefined);
    assert.equal(f.store.list('factory-workers').length, 0);
    assert.throws(() => assertFactoryChatCanStartTurn(f.store, ordinary, 'device'), error => (error as { code?: string }).code === 'FACTORY_TASK_RETRY_REQUIRED');
  });
});

test('a paired Linux author can hand retained source to the coordinator-owned Mac verifier', () => {
  const f = fixture();
  f.store.set('attempts', { ...f.attempt, deviceId: 'paired-linux-author' });
  f.store.set('tasks', { ...f.task, deviceId: 'paired-linux-author' });
  f.store.set('factory-attempt-details', { ...f.detail, candidate: { ...f.detail.candidate!, deviceId: 'paired-linux-author' } });
  assert.equal(f.run.ownerDeviceId, f.goal.coordinatorId);
  assert.equal(f.run.executionTargetKind, 'host-macos');
  assert.equal(f.guard(), undefined);
});

test('verifier start requires the internal exact run marker and original authority attempt', () => {
  const f = fixture();
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, f.chat, 'device'), stale);
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, f.chat, 'device', f.attempt.id), stale);
  assert.throws(() => f.guard('different-attempt'), stale);
  assert.throws(() => f.guard(f.attempt.id, 'different-run'), stale);
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, { ...f.chat, verificationRunId: undefined }, 'device', f.attempt.id, f.run.id), stale);
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, { ...f.chat, attemptId: f.attempt.id }, 'device', f.attempt.id, f.run.id), stale);
});

test('final goal verifier uses all frozen UI contracts without reopening historical accepted authors', () => {
  const f = finalFixture();
  assert.equal(f.task.status, 'completed'); assert.equal(f.detail.goalRevision, 12); assert.equal(f.goal.revision, 13);
  assert.notEqual(f.run.source.checkedCommit, f.detail.integration!.commit, 'Final M may include later accepted integrations');
  assert.notDeepEqual(f.run.quality, f.detail.contract!.quality, 'The final policy includes the other accepted task');
  assert.equal(f.guard(), undefined);
  const ordinary = { ...f.chat, id: 'ordinary-chat', sessionId: f.attempt.sessionId!, verificationRunId: undefined };
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, ordinary, 'device'), error => (error as { code?: string }).code === 'FACTORY_TASK_RETRY_REQUIRED');
  assert.throws(() => assertFactoryChatCanStartTurn(f.store, f.chat, 'device'), stale, 'A public turn cannot claim final-verifier authority');
  f.store.set('factory-attempt-details', { ...f.detail, assignmentGoalRevision: undefined, goalRevision: f.run.authority.goalRevision });
  assert.equal(f.guard(), undefined, 'Older accepted attempts can retain their frozen revision without a newer assignment field');
});

test('final policy cannot drop another task by rewriting its run hash and all verifier markers', () => {
  const f = finalFixture();
  rekeyVerifier(f, { quality: f.detail.contract!.quality! });
  assert.equal(f.run.policySha256, inspectionQualityPolicySha256(f.run.quality));
  assert.equal(f.run.id, inspectionVerificationKey(f.run));
  assert.throws(() => f.guard(), stale, 'Only the canonical full goal policy can authorize final inspection');
});

test('final policy remains bound to frozen contracts rather than mutable task metadata', () => {
  const f = finalFixture();
  f.store.set('tasks', { ...f.sibling, quality: undefined });
  assert.equal(f.guard(), undefined, 'Current task metadata cannot erase the accepted frozen iPhone policy');
  f.store.set('factory-attempt-details', { ...f.siblingDetail, contract: { ...f.siblingDetail.contract!, quality: undefined } });
  f.store.set('tasks', f.sibling);
  assert.throws(() => f.guard(), stale, 'An explicit frozen contract without quality cannot fall through to mutable task quality');
});

test('verifier keys distinguish final purpose and current goal revision from frozen task authority', () => {
  const f = finalFixture();
  assert.notEqual(f.run.id, inspectionVerificationKey({ ...f.run, purpose: 'task', goalRevision: undefined }));
  assert.notEqual(f.run.id, inspectionVerificationKey({ ...f.run, goalRevision: f.goal.revision + 1 }));
  const task = fixture();
  assert.equal(task.run.id, inspectionVerificationKey({ ...task.run, purpose: 'task' }), 'An explicit task marker preserves legacy task keys');
});

test('final verifier rejects stale accepted source, incomplete goal work and malformed purpose authority', async t => {
  const changes: Array<[string, (f: ReturnType<typeof finalFixture>) => void]> = [
    ['anchor task returned to review', f => f.store.set('tasks', { ...f.task, status: 'review' as const })],
    ['accepted candidate C changed', f => f.store.set('factory-attempt-details', { ...f.detail, candidate: { ...f.detail.candidate!, commit: 'a'.repeat(40) } })],
    ['integration absent', f => f.store.set('factory-attempt-details', { ...f.detail, integration: undefined })],
    ['integration accepted another C', f => f.store.set('factory-attempt-details', { ...f.detail, integration: { ...f.detail.integration!, candidateCommit: 'a'.repeat(40) } })],
    ['accepted detail belongs to another goal', f => f.store.set('factory-attempt-details', { ...f.detail, goalId: 'another-goal' })],
    ['accepted detail claims a future revision', f => f.store.set('factory-attempt-details', { ...f.detail, goalRevision: f.goal.revision + 1 })],
    ['author is not succeeded', f => f.store.set('attempts', { ...f.attempt, status: 'unknown' as const })],
    ['anchor selects a replacement author', f => f.store.set('tasks', { ...f.task, currentAttemptId: 'replacement-author' })],
    ['other work is queued', f => f.store.set('tasks', { ...f.sibling, status: 'queued' as const })],
    ['other accepted policy changed', f => f.store.set('factory-attempt-details', { ...f.siblingDetail, contract: { ...f.siblingDetail.contract!, quality: { ...f.sibling.quality!, workflows: [] } } })],
    ['final current goal revision changed', f => f.store.set('goals', { ...f.goal, revision: f.goal.revision + 1 })],
    ['final revision missing', f => f.store.set('inspection-verifier-runs', { ...f.run, goalRevision: undefined })],
    ['final revision fractional', f => f.store.set('inspection-verifier-runs', { ...f.run, goalRevision: f.goal.revision + 0.5 })],
    ['final revision invalid', f => f.store.set('inspection-verifier-runs', { ...f.run, goalRevision: NaN })],
    ['unknown purpose', f => f.store.set('inspection-verifier-runs', { ...f.run, purpose: 'unknown-purpose' })],
    ['final goal canceled', f => f.store.set('goals', { ...f.goal, status: 'canceled' as const })],
    ['final author canceled', f => f.store.set('factory-attempt-details', { ...f.detail, cancellation: 'requested' as const })],
    ['final verifier owner changed', f => f.store.set('inspection-verifier-runs', { ...f.run, ownerDeviceId: 'other-device' })],
    ['final verifier deadline expired', f => f.store.set('inspection-verifier-runs', { ...f.run, deadlineAt: new Date(Date.now() - 1).toISOString() })],
  ];
  for (const [name, change] of changes) await t.test(name, () => { const f = finalFixture(); change(f); assert.throws(() => f.guard(), stale); });
  const task = fixture();
  task.store.set('inspection-verifier-runs', { ...task.run, purpose: 'task', goalRevision: task.goal.revision });
  assert.throws(() => task.guard(), stale, 'Task verifier authority cannot carry a final-goal revision');
});

test('verifier guard rejects stale source, revision, status, owner, deadline and cancellation state', async t => {
  const changes: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ['missing verifier record', f => f.store.delete('inspection-verifier-runs', f.run.id)],
    ['changed candidate ID', f => f.store.set('factory-attempt-details', { ...f.detail, candidate: { ...f.detail.candidate!, id: 'replacement-candidate' } })],
    ['changed candidate commit C', f => f.store.set('factory-attempt-details', { ...f.detail, candidate: { ...f.detail.candidate!, commit: 'b'.repeat(40) } })],
    ['malformed checked commit M', f => f.store.set('inspection-verifier-runs', { ...f.run, source: { ...f.run.source, checkedCommit: 'HEAD' } })],
    ['malformed source digest', f => f.store.set('inspection-verifier-runs', { ...f.run, source: { ...f.run.source, sha256: 'latest' } })],
    ['changed source digest', f => f.store.set('inspection-verifier-runs', { ...f.run, source: { ...f.run.source, sha256: 'a'.repeat(64) } })],
    ['changed source root identity', f => f.store.set('inspection-verifier-runs', { ...f.run, source: { ...f.run.source, roots: [{ id: 'reference', sha256: 'a'.repeat(64) }] } })],
    ['malformed policy digest', f => f.store.set('inspection-verifier-runs', { ...f.run, policySha256: 'latest-policy' })],
    ['changed policy digest', f => f.store.set('inspection-verifier-runs', { ...f.run, policySha256: 'a'.repeat(64) })],
    ['changed frozen quality contract', f => f.store.set('factory-attempt-details', { ...f.detail, contract: { ...f.detail.contract!, quality: { ...f.run.quality, referenceIds: ['replacement-reference'] } } })],
    ['changed verifier quality contract', f => f.store.set('inspection-verifier-runs', { ...f.run, quality: { ...f.run.quality, workflows: [] } })],
    ['replacement policy cannot keep the old verifier identity', f => { const quality = { ...f.run.quality, workflows: [] }; f.store.set('inspection-verifier-runs', { ...f.run, quality, policySha256: inspectionQualityPolicySha256(quality) }); }],
    ['current goal changed', f => f.store.set('goals', { ...f.goal, revision: 14 })],
    ['assignment revision changed', f => f.store.set('factory-attempt-details', { ...f.detail, assignmentGoalRevision: 12 })],
    ['policy authority revision changed', f => f.store.set('inspection-verifier-runs', { ...f.run, authority: { ...f.run.authority, policyRevision: 12 } })],
    ['attempt generation changed', f => f.store.set('attempts', { ...f.attempt, generation: 6 })],
    ['task selects another author', f => f.store.set('tasks', { ...f.task, currentAttemptId: 'another-attempt' })],
    ['task left review', f => f.store.set('tasks', { ...f.task, status: 'completed' as const })],
    ['author outcome unknown', f => f.store.set('attempts', { ...f.attempt, status: 'unknown' as const })],
    ['author canceled', f => f.store.set('factory-attempt-details', { ...f.detail, cancellation: 'requested' as const })],
    ['integration already recorded', f => f.store.set('factory-attempt-details', { ...f.detail, integration: { commit: 'e'.repeat(40), previousHead: 'a'.repeat(40), candidateCommit: f.detail.candidate!.commit, checks: [] } })],
    ['goal paused', f => f.store.set('goals', { ...f.goal, status: 'paused' as const })],
    ['goal approval policy changed', f => f.store.set('goals', { ...f.goal, approvalMode: 'manual' as const })],
    ['chat approval policy changed', f => f.store.set('chats', { ...f.chat, approvalMode: 'manual' as const })],
    ['goal coordinator changed', f => f.store.set('goals', { ...f.goal, coordinatorId: 'other-device' })],
    ['original author missing', f => f.store.delete('attempts', f.attempt.id)],
    ['verifier owner changed', f => f.store.set('inspection-verifier-runs', { ...f.run, ownerDeviceId: 'other-device' })],
    ['verifier chat owner changed', f => f.store.set('chats', { ...f.chat, deviceId: 'other-device' })],
    ['verifier session owner changed', f => f.store.set('sessions', { ...f.session, deviceId: 'other-device' })],
    ['session verification binding changed', f => f.store.set('sessions', { ...f.session, verificationRunId: 'different-run' })],
    ['execution target changed', f => f.store.set('sessions', { ...f.session, executionTargetId: 'other-target' })],
    ['execution kind changed', f => f.store.set('sessions', { ...f.session, executionTargetKind: 'container' as const })],
    ['run chat binding changed', f => f.store.set('inspection-verifier-runs', { ...f.run, chatId: 'another-chat' })],
    ['run session binding changed', f => f.store.set('inspection-verifier-runs', { ...f.run, sessionId: 'another-session' })],
    ['deadline expired', f => f.store.set('inspection-verifier-runs', { ...f.run, deadlineAt: new Date(Date.now() - 1).toISOString() })],
    ['deadline invalid', f => f.store.set('inspection-verifier-runs', { ...f.run, deadlineAt: 'never' })],
    ['session stopped', f => f.store.set('sessions', { ...f.session, status: 'stopped' as const })],
    ['session archived', f => f.store.set('sessions', { ...f.session, archivedAt: new Date().toISOString() })],
    ['run canceled', f => f.store.set('inspection-verifier-runs', { ...f.run, status: 'canceled' as const })],
    ['run ownership unknown', f => f.store.set('inspection-verifier-runs', { ...f.run, status: 'unknown' as const })],
    ['author worker owns chat', f => f.store.set('factory-workers', { id: 'retired-worker', chatId: f.chat.id })],
    ['author worker owns session', f => f.store.set('factory-workers', { id: 'retired-worker', sessionId: f.chat.sessionId })],
  ];
  for (const [name, change] of changes) await t.test(name, () => { const f = fixture(); change(f); assert.throws(() => f.guard(), stale); });
});

test('durable author chat and session identities remain protected after worker journal retirement', async t => {
  for (const identity of ['chat', 'session'] as const) await t.test(identity, () => {
    const f = fixture();
    f.store.set('attempts', { ...f.attempt, ...(identity === 'chat' ? { chatId: f.chat.id } : { sessionId: f.chat.sessionId }) });
    assert.equal(f.store.list('factory-workers').length, 0);
    assert.throws(() => f.guard(), stale);
  });
});

test('independent verifier cannot reuse another retired durable author identity', async t => {
  for (const identity of ['chat', 'session'] as const) await t.test(identity, () => {
    const f = fixture();
    f.store.set('attempts', { ...f.attempt, id: 'different-retired-author', taskId: 'different-task', status: 'retired', chatId: identity === 'chat' ? f.chat.id : 'other-author-chat', sessionId: identity === 'session' ? f.chat.sessionId : 'other-author-session' });
    assert.equal(f.store.list('factory-workers').length, 0);
    assert.throws(() => f.guard(), stale);
  });
});

function controllerFixture(f = fixture()) {
  const calls = { provider: 0, provision: 0, bridge: 0, release: 0 };
  const bridged: AgentToolBridgeContext[] = [], inputs: TurnInput[] = [];
  const capability: RuntimeCapability = { kind: 'codex', available: true, version: RUNTIME_PINS.codex, fullAccess: true, interactiveApprovals: true, resume: true };
  let providerFailure = false;
  const manager = {
    provisionHost: async () => { calls.provision++; return capability; },
    runTurn: async (input: TurnInput) => { calls.provider++; inputs.push(input); assert.equal(f.store.get<Chat>('chats', input.chatId)?.attemptId, undefined); if (providerFailure) throw new AgentError('Verifier provider failure', 'AGENT_TURN_FAILED', true); return { text: 'Real inspection report required', threadId: 'verifier-thread' }; },
    interrupt: async () => false, hostProcesses: async () => [], cancelHostSession: async () => {}, shutdown: async () => {},
  } as unknown as AgentManager;
  const app = {
    store: f.store, device: { id: 'device' }, dataDir: '/tmp/verifier-chat-fixture', repositoryRoot: '/tmp/verifier-chat-fixture/repo', runtime: { endpoint: {} },
    extensions: [], closers: [], runtimeStopHooks: [], diagnostics: {}, changed: () => {}, emit: () => {},
    assertServiceAvailable: () => {}, assertRuntimeCanRun: () => assert.fail('Independent native verification must not use container admission'),
    withServiceOperation: async <T>(operation: (signal: AbortSignal) => Promise<T>) => operation(new AbortController().signal),
    withRuntimeOperation: async () => assert.fail('Independent native verification must not use Docker'),
    sessions: { beforeStop: [], record: (id: string) => f.store.get<Session>('sessions', id)!, assertCanStartWork: () => {}, assertHostExecutionCurrent: async () => {}, execution: () => ({ kind: 'host-macos' as const, targetId: f.session.executionTargetId, workdir: '/tmp/verifier-chat-fixture/private-combined-M' }) },
  } as unknown as DeviceApp;
  const controller = new ChatController(app, manager);
  controller.setToolBridge(async context => { calls.bridge++; bridged.push(context); return { systemInstructions: 'Inspect the exact retained source; preserve evidence.', release: () => { calls.release++; } }; });
  return { ...f, app, controller, calls, bridged, inputs, failProvider: () => { providerFailure = true; } };
}

test('service-owned verifier carries original authority into tools without persisting author identity on its chat', async t => {
  for (const purpose of ['task', 'goal-final'] as const) for (const outcome of ['success', 'failure'] as const) await t.test(`${purpose} ${outcome}`, async () => {
    const f = controllerFixture(purpose === 'goal-final' ? finalFixture() : fixture());
    const chat = f.controller.create({ sessionId: f.session.id, verificationRunId: f.run.id, title: 'Independent retained-source inspection' });
    f.store.set('inspection-verifier-runs', { ...f.run, chatId: chat.id });
    if (outcome === 'failure') f.failProvider();
    const turn = f.controller.run(chat.id, 'Verify combined M against candidate C', { attemptId: f.attempt.id, verificationRunId: f.run.id, autonomous: true });
    if (outcome === 'failure') await assert.rejects(turn, /Verifier provider failure/); else await turn;
    assert.equal(f.calls.provider, 1); assert.equal(f.calls.provision, 1); assert.equal(f.calls.bridge, 1); assert.equal(f.calls.release, 1);
    assert.equal(f.bridged[0]!.verificationRunId, f.run.id); assert.equal(f.bridged[0]!.attemptId, f.attempt.id);
    assert.equal(f.bridged[0]!.chat.verificationRunId, f.run.id); assert.equal(f.bridged[0]!.chat.attemptId, undefined);
    assert.equal(f.inputs[0]!.attemptId, f.attempt.id);
    assert.equal(f.inputs[0]!.sessionId, f.session.id);
    assert.equal(f.controller.get(chat.id).attemptId, undefined); assert.equal(f.controller.get(chat.id).verificationRunId, f.run.id);
    assert(f.store.writes.filter(write => write.bucket === 'chats' && write.value.id === chat.id).every(write => write.value.attemptId === undefined), 'No intermediate running/failure patch relabels the verifier as its ended author');
    assert.equal(f.store.get<Attempt>('attempts', f.attempt.id)?.status, 'succeeded');
    assert.deepEqual(f.store.get<AttemptDetail>('factory-attempt-details', f.detail.id)?.candidate, f.detail.candidate);
  });
});

test('user message route cannot spoof internal verification authority and rejects before provider preparation', async () => {
  const f = controllerFixture();
  const extension = f.app.extensions[0]!;
  await assert.rejects(extension({ method: 'POST', url: new URL(`http://localhost/api/chats/${f.chat.id}/messages`), body: { text: 'Continue verification', attemptId: f.attempt.id, verificationRunId: f.run.id } } as Parameters<typeof extension>[0]), stale);
  assert.equal(f.calls.provision, 0); assert.equal(f.calls.bridge, 0); assert.equal(f.calls.provider, 0);
  assert.equal(f.controller.events(f.chat.id).length, 0);
  assert.equal(f.controller.get(f.chat.id).attemptId, undefined);
  f.store.set('inspection-verifier-runs', { ...f.run, deadlineAt: new Date(Date.now() - 1000).toISOString() });
  assert.throws(() => f.controller.run(f.chat.id, 'Stale internal turn', { attemptId: f.attempt.id, verificationRunId: f.run.id }), stale);
  assert.equal(f.calls.provider, 0);
});

test('public chat creation cannot open an unmarked ordinary turn inside a reserved verifier session', async () => {
  const f = controllerFixture();
  const extension = f.app.extensions[0]!;
  const ordinary = await extension({ method: 'POST', url: new URL('http://localhost/api/chats'), body: { sessionId: f.session.id, verificationRunId: f.run.id, attemptId: f.attempt.id, title: 'User-created conversation' } } as Parameters<typeof extension>[0]) as Chat;
  assert.equal(ordinary.verificationRunId, undefined, 'The public route cannot supply the internal verifier marker');
  assert.equal(ordinary.attemptId, undefined, 'The public route cannot supply author authority');
  await assert.rejects(extension({ method: 'POST', url: new URL(`http://localhost/api/chats/${ordinary.id}/messages`), body: { text: 'Continue in the verifier workspace' } } as Parameters<typeof extension>[0]), stale);
  assert.equal(f.calls.provision, 0); assert.equal(f.calls.bridge, 0); assert.equal(f.calls.provider, 0);
  assert.equal(f.controller.events(ordinary.id).length, 0);
});
