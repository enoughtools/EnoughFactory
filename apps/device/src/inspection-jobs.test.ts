import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Artifact, InspectionAuthority, InspectionJob } from '@enoughfactory/contracts';
import { InspectionJobs } from './inspection-jobs.ts';
import { Store } from './store.ts';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'enough-inspection-journal-'));
  let store = new Store(directory);
  let current: InspectionAuthority = { goalId: 'goal', goalRevision: 8, taskId: 'task', attemptId: 'attempt-3', authorityGeneration: 3, policyRevision: 2 };
  let time = '2026-10-08T21:00:00.000Z';
  const options = { deviceId: 'device', capacities: { browser: 2, 'ios-simulator': 2 }, authorityCurrent: (authority: InspectionAuthority) => JSON.stringify(authority) === JSON.stringify(current), now: () => time };
  let jobs = new InspectionJobs(store, options);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const grant = jobs.issueAuthority(current, { capabilities: ['macos-app-inspection', 'ios-simulator-inspection', 'chromium-inspection', 'apple-compilation'], executionTargetIds: ['mac', 'container'] });
  const source = { snapshotId: 'snapshot-dirty-3', sha256: '1'.repeat(64), candidateCommit: '2'.repeat(40), checkedCommit: '3'.repeat(40), roots: [{ id: 'main', sha256: '4'.repeat(64) }, { id: 'design-system', sha256: '5'.repeat(64) }] };
  const create = (key: string, capability: InspectionJob['capability'] = 'macos-app-inspection', resources?: Parameters<InspectionJobs['createJob']>[1]['resources']) => jobs.createJob(grant.token, { idempotencyKey: key, capability, executionTargetId: capability === 'chromium-inspection' ? 'container' : 'mac', source, profile: { fixture: 'private-test' }, ...(resources ? { resources } : {}) });
  const ready = () => { const job = jobs.claimNext()!; jobs.markRunning(job.id); const session = jobs.openSession(job.id); jobs.markSessionReady(session.id, { processIdentity: { pid: 514, startedAt: '2026-10-08T21:00:00Z' } }); return { job, session }; };
  const observe = (sessionId: string, key = 'observe-1', extra: Parameters<InspectionJobs['recordObservation']>[1] = {}) => {
    const { action } = jobs.beginAction(grant.token, sessionId, { idempotencyKey: key, kind: 'observe', arguments: {} });
    jobs.markActionRunning(action.id);
    const observation = jobs.recordObservation(action.id, { elementIds: ['button-save', 'body-field'], uiTree: 'Compose\nSave draft\nBody', ...extra });
    jobs.actionComplete(action.id, { status: 'succeeded' }); return observation;
  };
  return {
    get jobs() { return jobs; }, get store() { return store; }, grant, source, create, ready, observe, directory,
    retire: () => { current = { ...current, authorityGeneration: 4, attemptId: 'attempt-4' }; },
    advance: () => { time = '2026-10-09T21:00:00.000Z'; },
    restart: () => { store.close(); store = new Store(directory); jobs = new InspectionJobs(store, options); return jobs.recoverAfterRestart(); },
    artifact: (id = 'screenshot-object'): Artifact => ({ id, goalId: 'goal', taskId: 'task', attemptId: 'attempt-3', name: 'App interface', mime: 'image/png', sha256: '6'.repeat(64), size: 4096, deviceId: 'device', createdAt: time }),
  };
}

test('attempt-scoped opaque credentials expose no raw token and cannot access another target or capability', async t => {
  const f = await fixture(t);
  assert.equal(f.jobs.authorize(f.grant.token).id, f.grant.grant.id);
  assert.throws(() => f.jobs.authorize('invalid'), /authority/);
  assert.throws(() => f.jobs.authorize(f.grant.token, 'mac-shell'), /outside/);
  assert.throws(() => f.jobs.authorize(f.grant.token, 'macos-app-inspection', 'unpaired'), /outside/);
  for (const bucket of ['inspection-private-grants', 'inspection-private-token-index']) assert.equal(JSON.stringify(f.store.list(bucket)).includes(f.grant.token), false);
  const job = f.create('first');
  assert.equal(JSON.stringify(job).includes(f.grant.token), false);
  assert.equal(Object.hasOwn(job, 'grantId'), false);
  assert.equal(job.source.candidateCommit, '2'.repeat(40));
  assert.equal(job.source.checkedCommit, '3'.repeat(40), 'candidate and checked integration identity remain separate');
  f.advance();
  assert.throws(() => f.jobs.authorize(f.grant.token), /Expired/);
  assert.equal(f.jobs.claimNext(), undefined);
  assert.equal(f.jobs.getJob(job.id)?.status, 'canceled');
});

test('duplicate job requests are journaled once, mismatched retries and unbounded/non-immutable inputs fail', async t => {
  const f = await fixture(t), first = f.create('request-1');
  assert.equal(f.create('request-1').id, first.id);
  assert.equal(f.jobs.listJobs().length, 1);
  assert.throws(() => f.jobs.createJob(f.grant.token, { idempotencyKey: 'request-1', executionTargetId: 'mac', capability: 'macos-app-inspection', source: f.source, profile: { fixture: 'different' } }), /different inputs/);
  for (const source of [{ ...f.source, sha256: 'bad' }, { ...f.source, roots: [{ id: 'same', sha256: 'a'.repeat(64) }, { id: 'same', sha256: 'b'.repeat(64) }] }]) assert.throws(() => f.jobs.createJob(f.grant.token, { idempotencyKey: 'bad', executionTargetId: 'mac', capability: 'macos-app-inspection', source, profile: {} }));
  assert.throws(() => f.jobs.createJob(f.grant.token, { idempotencyKey: 'large', executionTargetId: 'mac', capability: 'macos-app-inspection', source: f.source, profile: { data: 'a'.repeat(70_000) } }), /bounded/);
  assert.equal(f.jobs.listJobs().length, 1);
  assert.equal(f.store.events<{ kind: string }>('inspection-journal', first.id).filter(event => event.value.kind === 'job-queued').length, 1);
});

test('desktop jobs queue fairly while independent browser and owned simulator pools continue', async t => {
  const f = await fixture(t);
  const desktop1 = f.create('desktop-1'), desktop2 = f.create('desktop-2'), browser1 = f.create('browser-1', 'chromium-inspection'), browser2 = f.create('browser-2', 'chromium-inspection'), browser3 = f.create('browser-3', 'chromium-inspection');
  assert.equal(f.jobs.claimNext('native-desktop')?.id, desktop1.id);
  assert.equal(f.jobs.claimNext('native-desktop'), undefined);
  assert.equal(f.jobs.claimNext('browser')?.id, browser1.id);
  assert.equal(f.jobs.claimNext('browser')?.id, browser2.id);
  assert.equal(f.jobs.claimNext('browser'), undefined);
  f.jobs.finishJob(browser1.id, { status: 'succeeded' });
  assert.equal(f.jobs.claimNext('browser')?.id, browser3.id);
  f.jobs.finishJob(desktop1.id, { status: 'succeeded' });
  assert.equal(f.jobs.claimNext('native-desktop')?.id, desktop2.id);
  const sim1 = f.create('sim-a-1', 'ios-simulator-inspection', [{ pool: 'ios-simulator', key: 'owned-udid-a' }]);
  const sim2 = f.create('sim-a-2', 'ios-simulator-inspection', [{ pool: 'ios-simulator', key: 'owned-udid-a' }]);
  const sim3 = f.create('sim-b-1', 'ios-simulator-inspection', [{ pool: 'ios-simulator', key: 'owned-udid-b' }]);
  assert.equal(f.jobs.claimNext('ios-simulator')?.id, sim1.id);
  assert.equal(f.jobs.claimNext('ios-simulator')?.id, sim3.id);
  assert.equal(f.jobs.claimNext('ios-simulator'), undefined, 'one recorded simulator cannot have two owners');
  f.jobs.finishJob(sim1.id, { status: 'succeeded' });
  assert.equal(f.jobs.claimNext('ios-simulator')?.id, sim2.id);
});

test('atomic multi-resource admission cannot exceed a pool or bypass the native desktop owner', async t => {
  const f = await fixture(t);
  assert.throws(() => f.create('bypass-native', 'macos-app-inspection', [{ pool: 'browser' }]), /cannot bypass/);
  assert.throws(() => f.create('oversized-browser', 'chromium-inspection', [{ pool: 'browser', key: 'a', units: 2 }, { pool: 'browser', key: 'b', units: 1 }]), /Combined/);
  const existing = f.create('one-browser', 'chromium-inspection'); assert.equal(f.jobs.claimNext()?.id, existing.id);
  const pair = f.create('two-browsers', 'chromium-inspection', [{ pool: 'browser', key: 'a' }, { pool: 'browser', key: 'b' }]);
  assert.equal(f.jobs.claimNext(), undefined, 'all resources must fit before any are leased');
  assert.equal(f.jobs.leases(pair.id).length, 0);
  f.jobs.finishJob(existing.id, { status: 'succeeded' });
  assert.equal(f.jobs.claimNext()?.id, pair.id); assert.equal(f.jobs.leases(pair.id).length, 2);
});

test('actions journal before effects, never replay a request, and reject stale element observations', async t => {
  const f = await fixture(t); f.create('native'); const { session } = f.ready();
  const observation = f.observe(session.id);
  const input = { idempotencyKey: 'save-draft', kind: 'click' as const, arguments: { elementId: 'button-save' }, observationId: observation.id };
  const started = f.jobs.beginAction(f.grant.token, session.id, input);
  assert.equal(started.execute, true);
  assert.equal(f.jobs.actions(session.id).find(action => action.id === started.action.id)?.status, 'requested', 'durable intent exists before the backend is allowed to click');
  assert.equal(f.jobs.beginAction(f.grant.token, session.id, input).execute, false, 'caller must reconcile/read the existing effect instead of replaying it');
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { ...input, arguments: { elementId: 'other' } }), /different inputs/);
  f.jobs.markActionRunning(started.action.id); f.jobs.actionComplete(started.action.id, { status: 'succeeded' });
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { ...input, idempotencyKey: 'stale-second-click' }), /Stale/);
  const fresh = f.observe(session.id, 'observe-2');
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { ...input, idempotencyKey: 'unknown-element', observationId: fresh.id, arguments: { elementId: 'guessed-element' } }), /absent/);
  assert.equal(f.jobs.actions(session.id).length, 3, 'rejected operations create no effect journal entries');
});

test('coordinate input requires an owned screenshot and exactly matching observation viewport', async t => {
  const f = await fixture(t); f.create('native'); const { job, session } = f.ready();
  const { action } = f.jobs.beginAction(f.grant.token, session.id, { idempotencyKey: 'screen', kind: 'screenshot', arguments: {} });
  const screenshot = f.jobs.publishEvidence(job.id, { sessionId: session.id, actionId: action.id, kind: 'screenshot', artifact: f.artifact() });
  const viewport = { width: 800, height: 600, scale: 2 };
  const observation = f.jobs.recordObservation(action.id, { screenshotEvidenceId: screenshot.id, viewport });
  f.jobs.actionComplete(action.id, { status: 'succeeded', evidenceIds: [screenshot.id] });
  const input = { idempotencyKey: 'coordinate', kind: 'click' as const, observationId: observation.id, arguments: { x: 100, y: 200, viewport } };
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { ...input, arguments: { ...input.arguments, viewport: { ...viewport, scale: 1 } } }), /matching viewport/);
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { ...input, arguments: { ...input.arguments, x: 900 } }), /outside/);
  assert.equal(f.jobs.beginAction(f.grant.token, session.id, input).execute, true);
});

test('service restart retains native reservations and unresolved actions until backend reconciliation', async t => {
  const f = await fixture(t); f.create('native-1'); const { job, session } = f.ready(); const observation = f.observe(session.id);
  const request = { idempotencyKey: 'edit-body', kind: 'type' as const, arguments: { elementId: 'body-field', text: 'A real edit' }, observationId: observation.id };
  const { action } = f.jobs.beginAction(f.grant.token, session.id, request); f.jobs.markActionRunning(action.id);
  const competing = f.create('native-2');
  assert.equal(f.restart()[0]?.id, job.id);
  assert.equal(f.jobs.getJob(job.id)?.status, 'unknown'); assert.equal(f.jobs.getSession(session.id)?.status, 'unknown');
  assert.equal(f.jobs.actions(session.id).find(value => value.id === action.id)?.status, 'unknown');
  assert.equal(f.jobs.leases(job.id)[0]?.status, 'held'); assert.equal(f.jobs.claimNext('native-desktop'), undefined);
  assert.throws(() => f.jobs.reconcileJob(job.id, { status: 'running' }), /actions/);
  f.jobs.reconcileAction(action.id, { status: 'succeeded', reason: 'Owned process confirms body value', outcomeConfirmed: true });
  assert.throws(() => f.jobs.reconcileJob(job.id, { status: 'running' }), /session ownership/);
  f.jobs.reconcileSession(session.id, { status: 'ready', identityConfirmed: true });
  f.jobs.reconcileJob(job.id, { status: 'running' });
  assert.equal(f.jobs.beginAction(f.grant.token, session.id, request).execute, false, 'a completed effect is not repeated after service restart');
  assert.throws(() => f.jobs.finishJob(job.id, { status: 'succeeded' }), /live or unknown/);
  f.jobs.confirmSessionStopped(session.id); f.jobs.finishJob(job.id, { status: 'succeeded' });
  assert.equal(f.jobs.claimNext('native-desktop')?.id, competing.id);
});

test('cancellation and stale authority cannot publish evidence or release uncertain resources', async t => {
  const f = await fixture(t); f.create('native-1'); const { job, session } = f.ready(); const competing = f.create('native-2');
  const { action } = f.jobs.beginAction(f.grant.token, session.id, { idempotencyKey: 'long-test', kind: 'run-tests', arguments: {} }); f.jobs.markActionRunning(action.id);
  f.jobs.requestCancel(f.grant.token, job.id);
  assert.equal(f.jobs.getJob(job.id)?.status, 'cancellation-requested'); assert.equal(f.jobs.leases(job.id)[0]?.status, 'held');
  assert.throws(() => f.jobs.publishEvidence(job.id, { sessionId: session.id, actionId: action.id, kind: 'screenshot', artifact: f.artifact() }), /reconciliation/);
  assert.throws(() => f.jobs.reconcileJob(job.id, { status: 'failed' }), /positive backend/);
  assert.equal(f.jobs.claimNext('native-desktop'), undefined);
  f.jobs.confirmCanceled(job.id);
  assert.equal(f.jobs.actions(session.id).find(value => value.id === action.id)?.status, 'unknown', 'process termination does not prove that a previously sent effect never happened');
  assert.equal(f.jobs.claimNext('native-desktop')?.id, competing.id);
  f.retire();
  assert.throws(() => f.jobs.authorize(f.grant.token), /stale/);
  assert.throws(() => f.jobs.publishEvidence(competing.id, { kind: 'assertion', artifact: f.artifact() }), /stale/);
  assert.equal(f.jobs.evidence(competing.id).length, 0);
  f.jobs.revokeAuthority(f.grant.grant.id);
  assert.equal(f.jobs.getJob(competing.id)?.status, 'cancellation-requested'); assert.equal(f.jobs.leases(competing.id)[0]?.status, 'held');
  f.jobs.confirmCanceled(competing.id); assert.equal(f.jobs.leases(competing.id)[0]?.status, 'released');
});

test('an unrelated same-device session or artifact cannot supply another attempt or source evidence', async t => {
  const f = await fixture(t); f.create('browser-1', 'chromium-inspection'); const first = f.ready(); f.create('browser-2', 'chromium-inspection'); const second = f.ready();
  const { action } = f.jobs.beginAction(f.grant.token, first.session.id, { idempotencyKey: 'screen', kind: 'screenshot', arguments: {} });
  assert.throws(() => f.jobs.publishEvidence(first.job.id, { sessionId: second.session.id, actionId: action.id, kind: 'screenshot', artifact: f.artifact() }), /session belongs/);
  assert.throws(() => f.jobs.publishEvidence(first.job.id, { sessionId: first.session.id, actionId: action.id, kind: 'screenshot', artifact: { ...f.artifact(), attemptId: 'previous-attempt' } }), /author attempt/);
  const evidence = f.jobs.publishEvidence(first.job.id, { sessionId: first.session.id, actionId: action.id, kind: 'screenshot', artifact: f.artifact() });
  const secondAction = f.jobs.beginAction(f.grant.token, second.session.id, { idempotencyKey: 'screen', kind: 'screenshot', arguments: {} }).action;
  assert.throws(() => f.jobs.recordObservation(secondAction.id, { screenshotEvidenceId: evidence.id, viewport: { width: 10, height: 10, scale: 1 } }), /not owned/);
  assert.deepEqual(f.jobs.evidence(first.job.id)[0]?.source, f.source);
});

test('backend timeout records an unknown action and session without releasing or guessing failure', async t => {
  const f = await fixture(t); f.create('native-1'); const { job, session } = f.ready(); const observation = f.observe(session.id);
  const input = { idempotencyKey: 'possible-click', kind: 'click' as const, arguments: { elementId: 'button-save' }, observationId: observation.id };
  const { action } = f.jobs.beginAction(f.grant.token, session.id, input); f.jobs.markActionRunning(action.id);
  const competing = f.create('native-2');
  assert.equal(f.jobs.markActionUnknown(action.id, 'Native helper socket closed after dispatch').status, 'unknown');
  assert.equal(f.jobs.getJob(job.id)?.status, 'unknown'); assert.equal(f.jobs.getSession(session.id)?.status, 'unknown');
  assert.equal(f.jobs.leases(job.id)[0]?.status, 'held'); assert.equal(f.jobs.claimNext('native-desktop'), undefined);
  assert.throws(() => f.jobs.actionComplete(action.id, { status: 'failed' }), /reconciliation/);
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, input), /reconciliation/);
  f.jobs.confirmCanceled(job.id);
  assert.equal(f.jobs.actions(session.id).find(value => value.id === action.id)?.status, 'unknown');
  assert.equal(f.jobs.claimNext('native-desktop')?.id, competing.id);
});

test('native restart requires a fresh observation, holds the same lease and journals at most one relaunch', async t => {
  const f = await fixture(t); f.create('native'); const { job, session } = f.ready(); const observation = f.observe(session.id);
  const request = { idempotencyKey: 'restart-1', kind: 'restart' as const, arguments: {}, observationId: observation.id };
  const leaseIds = f.jobs.leases(job.id).map(lease => lease.id);
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { ...request, observationId: 'stale' }), /Stale/);
  const begun = f.jobs.beginAction(f.grant.token, session.id, request); assert.equal(begun.execute, true);
  f.jobs.markActionRunning(begun.action.id); f.jobs.actionComplete(begun.action.id, { status: 'succeeded' });
  f.jobs.confirmSessionRestarted(session.id, { previousProcessExited: true, processIdentity: { pid: 998, startedAt: '2026-10-08T21:00:05Z' } });
  assert.equal(f.jobs.getSession(session.id)?.processIdentity?.pid, 998);
  assert.equal(f.jobs.beginAction(f.grant.token, session.id, request).execute, false);
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { ...request, idempotencyKey: 'restart-2' }), /Stale/);
  assert.deepEqual(f.jobs.leases(job.id).map(lease => lease.id), leaseIds); assert.equal(f.jobs.leases(job.id)[0]?.status, 'held');
});

test('a new observation attempt invalidates prior input authority even when the capture fails', async t => {
  const f = await fixture(t); f.create('native'); const { session } = f.ready(); const prior = f.observe(session.id);
  const begun = f.jobs.beginAction(f.grant.token, session.id, { idempotencyKey: 'fresh-capture-failed', kind: 'screenshot', arguments: {} });
  assert.equal(f.jobs.getSession(session.id)?.latestObservationId, undefined);
  f.jobs.markActionRunning(begun.action.id); f.jobs.actionComplete(begun.action.id, { status: 'failed', reason: 'Structured UI capture was unavailable.' });
  assert.throws(() => f.jobs.beginAction(f.grant.token, session.id, { idempotencyKey: 'cannot-use-old-tree', kind: 'click', arguments: { elementId: 'button-save' }, observationId: prior.id }), /Stale/);
  assert.equal(f.jobs.getSession(session.id)?.latestObservationId, undefined);
  const fresh = f.observe(session.id, 'capture-recovered'); assert.notEqual(fresh.id, prior.id);
  assert.equal(f.jobs.beginAction(f.grant.token, session.id, { idempotencyKey: 'fresh-click', kind: 'click', arguments: { elementId: 'button-save' }, observationId: fresh.id }).execute, true);
});

test('paired owner read projections never enter this device resource queue or restart reconciliation', async t => {
  const f = await fixture(t), local = f.create('local');
  f.store.set('inspection-jobs', { ...local, id: 'remote-queued', ownerDeviceId: 'paired-mac', status: 'queued' });
  f.store.set('inspection-jobs', { ...local, id: 'remote-running', ownerDeviceId: 'paired-mac', status: 'running' });
  assert.equal(f.jobs.claimNext()?.id, local.id); assert.equal(f.jobs.claimNext(), undefined);
  assert.throws(() => f.jobs.markUnknown('remote-running', 'Wrong device'), /original owner/);
  f.restart(); assert.equal(f.jobs.getJob('remote-queued')?.status, 'queued'); assert.equal(f.jobs.getJob('remote-running')?.status, 'running');
});
