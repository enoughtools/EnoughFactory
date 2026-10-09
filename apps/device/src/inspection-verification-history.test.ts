import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Attempt, AttemptInspection, Chat, FactoryTask, Goal, Project, Session, InspectionAction, InspectionAuthority, InspectionEvidence, InspectionJob, InspectionSourceIdentity, InspectionVerificationRun, TaskQualityRequirements } from '@enoughfactory/contracts';
import type { AttemptDetail, GoalCheckRecord } from '@enoughfactory/factory';
import { ArtifactStore, exportInspectionSnapshot, InspectionSnapshotManager } from '@enoughfactory/workspaces';
import { Store } from './store.ts';
import type { InspectionObservation } from './inspection-jobs.ts';
import { InspectionQualityService } from './inspection-quality.ts';
import { inspectionQualityPolicySha256, inspectionVerificationKey } from './inspection-verification-identity.ts';
import { InspectionVerificationHistory } from './inspection-verification-history.ts';
import type { InspectionSourceRetention } from './inspection-retention.ts';
import type { EphemeralContainerReceipt } from './factory-container-retirement.ts';

const at = '2026-10-09T00:00:00.000Z';
const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 12, taskId: 'drafts', attemptId: 'current-author', authorityGeneration: 3, policyRevision: 12 };
const originalAuthority: InspectionAuthority = { ...authority };
const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'restore-draft', platform: 'macos' }], referenceIds: [] };
const contract: NonNullable<AttemptInspection['contract']> = { title: 'Restore complete drafts', description: 'Restore every original draft field.\nPreserve multiline body and trailing whitespace.',
  acceptanceCriteria: ['Recipient, subject and complete body are restored.'], expectedOutputs: ['Native draft restoration and original measured evidence'], kind: 'feature',
  dependsOn: [], checks: ['sh check-drafts.sh'], planRevision: 12, quality };
const originalSource: InspectionSourceIdentity = { snapshotId: 'original-snapshot', sha256: 'a'.repeat(64), candidateId: 'original-candidate', candidateCommit: 'c'.repeat(40), checkedCommit: 'c'.repeat(40), roots: [{ id: 'primary', sha256: 'b'.repeat(64), commit: 'c'.repeat(40) }] };
const currentSource: InspectionSourceIdentity = { snapshotId: 'current-snapshot', sha256: 'd'.repeat(64), candidateId: originalSource.candidateId, candidateCommit: originalSource.candidateCommit, checkedCommit: 'e'.repeat(40), roots: [{ id: 'primary', sha256: 'f'.repeat(64), commit: 'e'.repeat(40) }] };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Wj4sAAAAASUVORK5CYII=', 'base64');

/** Real immutable artifacts and SQLite history; no provider, app or browser is started. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ef-verification-history-'));
  const store = new Store(directory), artifacts = new ArtifactStore(path.join(directory, 'artifacts'), 'mac');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const goal: Goal = { id: authority.goalId, projectId: 'project', coordinatorId: 'mac', title: 'Build EnoughMail', objective: 'Build the complete native mail client.', criteria: ['All original mail workflows work.'],
    status: 'running', autonomy: 'autonomous', approvalMode: 'approve-all', runtime: 'codex', createdAt: at, updatedAt: at, revision: authority.goalRevision, concurrency: 1 };
  store.set('goals', goal);
  const task: FactoryTask = { id: authority.taskId, goalId: goal.id, title: 'A later weaker title', description: 'Only check one marker.', dependsOn: [], status: 'review', currentAttemptId: authority.attemptId, createdAt: at, updatedAt: at };
  store.set('tasks', task);
  const author: Attempt = { id: authority.attemptId, taskId: task.id, generation: authority.authorityGeneration, deviceId: 'mac', status: 'succeeded', startedAt: at, endedAt: at };
  const originalAuthor: Attempt = { ...author, id: originalAuthority.attemptId, generation: originalAuthority.authorityGeneration, status: 'failed', candidate: originalSource.candidateId, baseCommit: '1'.repeat(40), error: 'The complete multiline body was not restored.' };
  store.set('attempts', author); store.set('attempts', originalAuthor);
  const detail: AttemptDetail = { id: author.id, goalId: goal.id, goalRevision: authority.goalRevision, assignmentGoalRevision: authority.goalRevision, contract: structuredClone(contract), phase: 'checking', cancellation: 'none' };
  const originalContract = { ...structuredClone(contract), planRevision: originalAuthority.goalRevision };
  const diffText = 'diff --git a/Draft.swift b/Draft.swift\n--- a/Draft.swift\n+++ b/Draft.swift\n@@ -1 +1 @@\n-old body\n+first\\nsecond\\nlast \n';
  const diffArtifact = await artifacts.put(diffText, { name: 'original.patch', mime: 'text/x-diff', goalId: goal.id, taskId: task.id, attemptId: originalAuthor.id, metadata: { commit: originalSource.candidateCommit, baseCommit: originalAuthor.baseCommit } });
  store.set('factory-artifacts', diffArtifact);
  const originalDetail: AttemptDetail = { id: originalAuthor.id, goalId: goal.id, goalRevision: originalAuthority.goalRevision, assignmentGoalRevision: originalAuthority.goalRevision, contract: originalContract,
    phase: 'done', cancellation: 'none', candidate: { id: originalSource.candidateId!, commit: originalSource.candidateCommit!, baseCommit: originalAuthor.baseCommit!, diffArtifact },
    result: { status: 'succeeded', text: 'Original author explanation\nExact retained second line.', chatId: 'original-chat', sessionId: 'original-session' },
    checks: [{ command: 'sh check-drafts.sh', passed: false, output: 'Expected complete body:\nfirst\nsecond\nlast \nObserved only first line.', exitCode: 1, candidateCommit: originalSource.candidateCommit!, checkedCommit: originalSource.checkedCommit! }] };
  store.set('factory-attempt-details', detail); store.set('factory-attempt-details', originalDetail);
  const runBase = { authority, source: currentSource, quality, acceptanceContract: { version: 1 as const, task: structuredClone(contract) }, policySha256: inspectionQualityPolicySha256(quality), ownerDeviceId: 'mac',
    executionTargetKind: 'host-macos' as const, executionTargetId: 'mac-host', sessionId: 'current-verifier-session', chatId: 'current-verifier-chat', status: 'running' as const, createdAt: at, updatedAt: at, deadlineAt: '2026-10-09T01:00:00.000Z' };
  const run: InspectionVerificationRun = { ...runBase, id: inspectionVerificationKey(runBase) };
  const historicalBase = { ...runBase, authority: originalAuthority, source: originalSource, acceptanceContract: undefined, sessionId: 'historical-verifier-session', chatId: 'historical-verifier-chat', status: 'failed' as const, completedAt: at, reason: 'Original restoration assertion failed.' };
  const historicalRun: InspectionVerificationRun = { ...historicalBase, id: inspectionVerificationKey(historicalBase) };
  store.set('inspection-verifier-runs', run); store.set('inspection-verifier-runs', historicalRun);
  const job: InspectionJob = { id: 'original-job', authority: originalAuthority, ownerDeviceId: 'mac', executionTargetId: 'mac-host', capability: 'macos-app-inspection', source: originalSource,
    profile: { fixture: true }, status: 'failed', sessionId: 'original-inspection-session', createdAt: at, updatedAt: at };
  const screenshotArtifact = await artifacts.put(png, { name: 'original-draft.png', mime: 'image/png', goalId: goal.id, taskId: task.id, attemptId: originalAuthor.id });
  const screenshot: InspectionEvidence = { id: 'original-screen', jobId: job.id, sessionId: job.sessionId, actionId: 'original-observe', authority: originalAuthority, source: originalSource, kind: 'screenshot', artifact: screenshotArtifact, createdAt: at,
    metadata: { platform: 'macos', observationId: 'original-observation' } };
  const action: InspectionAction = { id: 'original-close', jobId: job.id, sessionId: job.sessionId!, authority: originalAuthority, kind: 'click', arguments: { elementId: 'close-draft' }, observationId: 'original-observation', status: 'succeeded', createdAt: at, updatedAt: at };
  const observing: InspectionAction = { ...action, id: screenshot.actionId!, kind: 'observe', arguments: {}, observationId: undefined };
  const observation: InspectionObservation = { id: 'original-observation', sessionId: job.sessionId!, actionId: observing.id, screenshotEvidenceId: screenshot.id, createdAt: at, uiTree: 'Draft editor\nBody: first\nsecond\nlast ', viewport: { width: 1200, height: 800, scale: 1 } };
  const assertionText = JSON.stringify({ passed: false, observationId: observation.id, condition: { elementId: 'body', valueEquals: 'first\nsecond\nlast ' }, observedValue: 'first' }, null, 2);
  const assertionArtifact = await artifacts.put(assertionText, { name: 'original-assertion.json', mime: 'application/json', goalId: goal.id, taskId: task.id, attemptId: originalAuthor.id });
  const assertion: InspectionEvidence = { ...screenshot, id: 'original-assertion', actionId: undefined, kind: 'assertion', artifact: assertionArtifact, metadata: { platform: 'macos', observationId: observation.id, passed: false } };
  store.set('inspection-jobs', job); store.set('inspection-actions', action); store.set('inspection-actions', observing);
  store.set('inspection-observations', observation); store.set('inspection-evidence', screenshot); store.set('inspection-evidence', assertion);
  const goalCheck: GoalCheckRecord = { id: 'original-goal-check', goalId: goal.id, revision: originalAuthority.goalRevision, at, repository: { head: originalSource.candidateCommit!, branch: 'main', status: '' }, commands: ['sh check-drafts.sh'], checks: originalDetail.checks! };
  store.set('factory-goal-checks', goalCheck);
  const qualityReports = new InspectionQualityService({ store, artifacts, authorityCurrent: () => true });
  const qualityReport = await qualityReports.submit({ authority: originalAuthority, quality, report: { version: 1, source: originalSource,
    workflows: [{ id: 'restore-draft', platform: 'macos', before: screenshot.id, after: screenshot.id, action: action.id, outcome: 'failed', assertion: 'The original full body was reduced to one line.', assertionEvidenceId: assertion.id }], reviews: [] } });
  let selected: InspectionVerificationRun | undefined = run;
  let currentHook: (() => void | Promise<void>) | undefined;
  const current = async () => { await currentHook?.(); return selected ? { run: selected } : undefined; };
  const service = new InspectionVerificationHistory({ store, artifacts, current, qualityReports });
  return { directory, store, artifacts, goal, task, author, originalAuthor, detail: originalDetail, originalDetail, diffArtifact, diffText, run, historicalRun, job, screenshot, assertion, assertionText, observation, action, goalCheck, qualityReports, qualityReport, service,
    setCurrent: (value: InspectionVerificationRun | undefined) => { selected = value; }, setCurrentHook: (value: typeof currentHook) => { currentHook = value; } };
}

type ToolResult = Awaited<ReturnType<InspectionVerificationHistory['call']>>;
function payload(response: ToolResult): Record<string, unknown> {
  const block = response.content.find(value => value.type === 'text');
  assert.ok(block && 'text' in block);
  return JSON.parse(block.text) as Record<string, unknown>;
}
async function readAll(service: InspectionVerificationHistory, kind: string, id: string, maximum = 97): Promise<string> {
  let offset = 0, original = '', total = Infinity, digest: unknown;
  while (offset < total) {
    const page = payload(await service.call('factory_verification_evidence', { kind, id, offset, maxCharacters: maximum }));
    assert.equal(page.historical, true); assert.equal(page.acceptanceUse, 'context-only');
    if (digest !== undefined) assert.equal(page.contentSha256, digest);
    digest = page.contentSha256; original += String(page.original); total = Number(page.totalCharacters);
    assert.equal(page.offset, offset); assert.ok(Number(page.nextOffset) > offset || offset === total);
    offset = Number(page.nextOffset);
  }
  assert.equal(createHash('sha256').update(original).digest('hex'), digest);
  return original;
}

test('historical reads expose original contract, exact C/base/check/result and measured UI evidence without changing current acceptance ledgers', async t => {
  const f = await fixture(t);
  const ledgers = ['inspection-evidence', 'inspection-actions', 'inspection-quality-reports', 'provider-image-deliveries', 'inspection-quality-equivalences'];
  const before = ledgers.map(bucket => f.store.list(bucket));
  const index = payload(await f.service.call('factory_verification_history', {}));
  assert.equal(index.historical, true); assert.equal(index.acceptanceUse, 'context-only');
  assert.deepEqual(index.checkedSource, currentSource);
  const items = index.items as Array<Record<string, unknown>>;
  assert.ok(items.some(item => item.id === f.screenshot.id && item.evidenceKind === 'screenshot'));
  assert.ok(items.some(item => item.kind === 'candidate-diff' && item.id === f.diffArtifact.id));
  assert.ok(items.every(item => item.bytes === undefined));
  const original = JSON.parse(await readAll(f.service, 'attempt', `factory-attempt-details/${authority.attemptId}`)) as AttemptDetail;
  assert.deepEqual(original.contract, contract); assert.notEqual(original.contract!.description, f.task.description);
  assert.equal(original.candidate!.id, originalSource.candidateId); assert.equal(original.candidate!.commit, originalSource.candidateCommit);
  assert.equal(original.candidate!.baseCommit, f.originalAuthor.baseCommit);
  assert.equal((original.candidate!.diffArtifact as { sha256: string }).sha256, f.diffArtifact.sha256);
  assert.deepEqual(original.checks, f.originalDetail.checks);
  assert.deepEqual(original.result, f.originalDetail.result); assert.equal(original.integration, undefined);
  assert.equal(await readAll(f.service, 'candidate-diff', f.diffArtifact.id), f.diffText);
  assert.deepEqual(JSON.parse(await readAll(f.service, 'goal-check', `factory-goal-checks/${f.goalCheck.id}`)), f.goalCheck);
  const inspected = JSON.parse(await readAll(f.service, 'inspection', f.assertion.id)) as Record<string, unknown>;
  assert.equal(inspected.original, f.assertionText); assert.deepEqual(inspected.observation, f.observation);
  assert.deepEqual(inspected.job, f.job); assert.deepEqual(inspected.actions, f.store.list('inspection-actions'));
  assert.equal(await readAll(f.service, 'quality-report', f.qualityReport.id), (await f.qualityReports.controllerReport({ goalId: f.goal.id, reportId: f.qualityReport.id })).original);
  assert.deepEqual(ledgers.map(bucket => f.store.list(bucket)), before);
  assert.ok(f.store.list('inspection-verification-history-views').length > 0);
  assert.equal(f.store.get<InspectionVerificationRun>('inspection-verifier-runs', f.historicalRun.id)!.acceptanceContract, undefined, 'A legacy record does not inherit the current contract');
});

test('historical index and original text ranges are paged and bounded without dropping or duplicating entries', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 30; index++) f.store.set('inspection-evidence', { ...f.assertion, id: `retained-${String(index).padStart(2, '0')}` });
  const first = payload(await f.service.call('factory_verification_history', { offset: 0, limit: 24 }));
  const second = payload(await f.service.call('factory_verification_history', { offset: first.nextOffset, limit: 24 }));
  const items = [...first.items as Array<{ kind: string; id: string }>, ...second.items as Array<{ kind: string; id: string }>];
  assert.equal(items.length, first.total); assert.equal(new Set(items.map(item => `${item.kind}/${item.id}`)).size, first.total);
  for (const args of [{ limit: 25 }, { limit: 0 }, { offset: -1 }, { offset: Number(first.total) + 1 }, { limit: '24' }]) await assert.rejects(f.service.call('factory_verification_history', args), /bounded historical index/);
  for (const args of [{ offset: -1, maxCharacters: 24 }, { offset: 0, maxCharacters: 16001 }, { offset: 0, maxCharacters: 0 }]) await assert.rejects(f.service.call('factory_verification_evidence', { kind: 'candidate-diff', id: f.diffArtifact.id, ...args }), /original historical range/);
  assert.equal(await readAll(f.service, 'candidate-diff', f.diffArtifact.id, 1), f.diffText);
});

test('same-goal unselected attempts and mismatched job evidence remain outside historical scope', async t => {
  for (const mutation of ['foreign-goal', 'unselected-attempt', 'wrong-generation', 'wrong-source'] as const) await t.test(mutation, async t => {
    const f = await fixture(t);
    const badAuthority = { ...originalAuthority, ...(mutation === 'foreign-goal' ? { goalId: 'foreign-goal' } : mutation === 'unselected-attempt' ? { attemptId: 'unselected-attempt' } : mutation === 'wrong-generation' ? { authorityGeneration: 1 } : {}) };
    const badJob = { ...f.job, id: 'foreign-job', authority: badAuthority };
    const badEvidence = { ...f.assertion, id: 'private-evidence', jobId: badJob.id, authority: badAuthority,
      ...(mutation === 'wrong-source' ? { source: { ...originalSource, roots: [{ id: 'primary', sha256: '9'.repeat(64) }] } } : {}) };
    f.store.set('inspection-jobs', badJob); f.store.set('inspection-evidence', badEvidence);
    const index = payload(await f.service.call('factory_verification_history', {}));
    assert.ok(!(index.items as Array<{ id: string }>).some(item => item.id === badEvidence.id));
    await assert.rejects(f.service.call('factory_verification_evidence', { kind: 'inspection', id: badEvidence.id, offset: 0, maxCharacters: 100 }), /same-goal task scope/);
    assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  });
});

test('retired verifier owner, conversation, source and original acceptance contract reject before publishing historical views', async t => {
  for (const change of ['missing-owner', 'wrong-chat', 'foreign-goal', 'wrong-source', 'stale-contract', 'retired-status', 'original-contract'] as const) await t.test(change, async t => {
    const f = await fixture(t);
    if (change === 'missing-owner') f.setCurrent(undefined);
    else if (change === 'original-contract') f.store.set('factory-attempt-details', { ...f.detail, contract: { ...contract, description: 'Only verify a weaker marker.' } });
    else f.setCurrent({ ...f.run, ...(change === 'wrong-chat' ? { chatId: 'other-chat' } : change === 'foreign-goal' ? { authority: { ...authority, goalId: 'foreign-goal' } }
      : change === 'wrong-source' ? { source: originalSource } : change === 'stale-contract' ? { acceptanceContract: { version: 1, task: { ...contract, description: 'Only one marker.' } } } : { status: 'failed' }) });
    await assert.rejects(f.service.call('factory_verification_image', { evidenceId: f.screenshot.id }), /current independent verifier|owner or acceptance|original historical task/);
    assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  });
});

test('original artifact corruption and changed manifest ownership fail before historical output or delivery', async t => {
  for (const change of ['corrupt-bytes', 'foreign-manifest-owner'] as const) await t.test(change, async t => {
    const f = await fixture(t);
    if (change === 'corrupt-bytes') await writeFile(await f.artifacts.path(f.assertion.artifact), 'Corrupted retained assertion');
    else await writeFile(path.join(f.artifacts.root, 'manifests', `${f.assertion.artifact.id}.json`), JSON.stringify({ ...f.assertion.artifact, goalId: 'foreign-goal' }));
    await assert.rejects(f.service.call('factory_verification_evidence', { kind: 'inspection', id: f.assertion.id, offset: 0, maxCharacters: 16000 }), /integrity verification|manifest or original owner/);
    assert.deepEqual(f.store.list('inspection-verification-history-views'), []); assert.deepEqual(f.store.list('provider-image-deliveries'), []);
  });
});

test('owner retirement during an asynchronous original artifact read prevents historical publication', async t => {
  const f = await fixture(t), read = f.artifacts.read.bind(f.artifacts);
  f.artifacts.read = async artifact => { const bytes = await read(artifact); f.setCurrent(undefined); return bytes; };
  await assert.rejects(f.service.call('factory_verification_image', { evidenceId: f.screenshot.id }), /current independent verifier/);
  assert.deepEqual(f.store.list('inspection-verification-history-views'), []); assert.deepEqual(f.store.list('inspection-verification-history-image-deliveries'), []);
});

test('an original frozen contract changed during an awaited artifact read fences historical output', async t => {
  const f = await fixture(t), read = f.artifacts.read.bind(f.artifacts);
  let reads = 0;
  f.artifacts.read = async artifact => {
    const bytes = await read(artifact); reads++;
    f.store.set('factory-attempt-details', { ...f.detail, contract: { ...contract, description: 'Only restore a single text marker.' } });
    return bytes;
  };
  await assert.rejects(f.service.call('factory_verification_evidence', { kind: 'inspection', id: f.assertion.id, offset: 0, maxCharacters: 16000 }), /original historical task\/attempt contract/);
  assert.equal(reads, 1, 'The original bytes were read before the frozen assignment changed');
  assert.deepEqual(f.store.get<InspectionVerificationRun>('inspection-verifier-runs', f.run.id), f.run, 'The run and current callback stay unchanged, so this exercises the original contract fence');
  assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  assert.deepEqual(f.store.list('inspection-verification-history-image-deliveries'), []); assert.deepEqual(f.store.list('provider-image-deliveries'), []);
});

test('screenshot evidence exposes original job/session/action chronology without claiming its pixels were viewed', async t => {
  const f = await fixture(t);
  const session = { id: f.job.sessionId!, jobId: f.job.id, authority: originalAuthority, source: originalSource, ownerDeviceId: 'mac', executionTargetId: 'mac-host',
    capability: 'macos-app-inspection', status: 'stopped', latestObservationId: f.observation.id, createdAt: at, updatedAt: '2026-10-09T00:01:00.000Z' };
  const stopped: InspectionAction = { ...f.action, id: 'original-stop', kind: 'stop', arguments: {}, observationId: undefined, createdAt: session.updatedAt, updatedAt: session.updatedAt };
  const laterJob = { ...f.job, id: 'later-request', source: currentSource, createdAt: '2026-10-09T00:02:00.000Z', updatedAt: '2026-10-09T00:02:00.000Z' };
  const laterAction: InspectionAction = { ...f.action, id: 'later-start', jobId: laterJob.id, kind: 'start', createdAt: laterJob.createdAt, updatedAt: laterJob.updatedAt };
  f.store.set('inspection-sessions', session); f.store.set('inspection-actions', stopped);
  f.store.set('inspection-jobs', laterJob); f.store.set('inspection-actions', laterAction);
  const response = await f.service.call('factory_verification_evidence', { kind: 'inspection', id: f.screenshot.id, offset: 0, maxCharacters: 16000 });
  const record = JSON.parse(String(payload(response).original)) as Record<string, unknown>;
  assert.deepEqual(record.evidence, f.screenshot); assert.deepEqual(record.job, f.job); assert.deepEqual(record.session, session);
  assert.deepEqual(record.observation, f.observation);
  assert.deepEqual(record.actions, [...f.store.list<InspectionAction>('inspection-actions').filter(action => action.jobId === f.job.id)]);
  assert.ok((record.actions as InspectionAction[]).some(action => action.id === stopped.id));
  assert.ok(!(record.actions as InspectionAction[]).some(action => action.id === laterAction.id));
  assert.equal(record.originalPixelsTool, 'factory_verification_image'); assert.equal(record.original, undefined);
  assert.ok(response.content.every(block => block.type === 'text')); assert.equal(JSON.stringify(record).includes(png.toString('base64')), false);
  const views = f.store.list<{ kind: string }>('inspection-verification-history-views');
  assert.equal(views.length, 1); assert.equal(views[0]!.kind, 'inspection');
  assert.throws(() => f.service.acknowledgeImage({ run: f.run, chatId: f.run.chatId!, sha256: f.screenshot.artifact.sha256, server: 'factory', tool: 'factory_verification_image', eventId: 'metadata-only', mimeType: 'image/png', byteLength: png.length }), /positive original tool\/view/);
  assert.deepEqual(f.store.list('inspection-verification-history-image-deliveries'), []); assert.deepEqual(f.store.list('provider-image-deliveries'), []);
});

test('historical screenshot delivery uses explicit tool provenance and a separate bucket even when current pixels have the same SHA', async t => {
  const f = await fixture(t);
  f.store.set('inspection-jobs', { ...f.job, id: 'current-job', source: currentSource });
  f.store.set('inspection-evidence', { ...f.screenshot, id: 'current-screen', jobId: 'current-job', source: currentSource });
  const response = await f.service.call('factory_verification_image', { evidenceId: f.screenshot.id });
  const image = response.content.find(block => block.type === 'image'); assert.ok(image && 'data' in image);
  assert.deepEqual(Buffer.from(image.data, 'base64'), png); assert.deepEqual(payload(response).originalSource, originalSource);
  const input = { run: f.run, chatId: f.run.chatId!, sha256: f.screenshot.artifact.sha256, eventId: 'provider-history-image', mimeType: 'image/png', byteLength: png.length };
  assert.throws(() => f.service.acknowledgeImage(input), /ambiguous historical image/);
  assert.throws(() => f.service.acknowledgeImage({ ...input, tool: 'factory_verification_image', server: 'other-server' }), /positive original tool\/view/);
  assert.throws(() => f.service.acknowledgeImage({ ...input, tool: 'factory_verification_image', server: 'factory', chatId: 'foreign-chat' }), /verifier owner changed/);
  assert.throws(() => f.service.acknowledgeImage({ ...input, tool: 'factory_verification_image', server: 'factory', byteLength: png.length + 1 }), /original artifact/);
  assert.deepEqual(f.store.list('inspection-verification-history-image-deliveries'), []);
  assert.deepEqual(f.service.acknowledgeImage({ ...input, tool: 'factory_verification_image', server: 'factory' }), f.screenshot.artifact);
  const deliveries = f.store.list<{ historical: boolean; evidenceId: string; eventId: string }>('inspection-verification-history-image-deliveries');
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0]!.historical, true); assert.equal(deliveries[0]!.evidenceId, f.screenshot.id); assert.equal(deliveries[0]!.eventId, input.eventId);
  assert.equal(f.service.acknowledgeImage({ ...input, tool: 'factory_observe', server: 'factory', eventId: 'current-provider-image' }), undefined, 'Positive current-origin handling remains with the service');
  assert.deepEqual(f.store.list('provider-image-deliveries'), []); assert.deepEqual(f.store.list('inspection-quality-equivalences'), []);
});

test('unviewed, non-image and excessive historical screenshots cannot create delivery proof', async t => {
  const f = await fixture(t);
  assert.throws(() => f.service.acknowledgeImage({ run: f.run, chatId: f.run.chatId!, sha256: f.screenshot.artifact.sha256, eventId: 'missing-origin', mimeType: 'image/png', byteLength: png.length }), /ambiguous historical image/);
  assert.throws(() => f.service.acknowledgeImage({ run: f.run, chatId: f.run.chatId!, sha256: f.screenshot.artifact.sha256, tool: 'factory_verification_image', server: 'factory', eventId: 'unviewed', mimeType: 'image/png', byteLength: png.length }), /positive original tool\/view/);
  f.store.set('inspection-evidence', { ...f.screenshot, id: 'not-image', artifact: f.assertion.artifact });
  f.store.set('inspection-evidence', { ...f.screenshot, id: 'excessive-image', artifact: { ...f.screenshot.artifact, size: 8 * 1024 * 1024 + 1 } });
  for (const evidenceId of ['not-image', 'excessive-image']) await assert.rejects(f.service.call('factory_verification_image', { evidenceId }), /bounded original historical screenshot/);
  assert.deepEqual(f.store.list('inspection-verification-history-views'), []); assert.deepEqual(f.store.list('inspection-verification-history-image-deliveries'), []);
});

test('final verification reads only its frozen accepted task contracts and rejects an accepted attempt that was retired', async t => {
  const f = await fixture(t);
  const acceptedContract = { ...structuredClone(contract), title: 'Preserve original account scope', description: 'Keep each account distinct.\nRestore the exact sender account with each draft.', planRevision: 9 };
  const acceptedAuthority: InspectionAuthority = { goalId: authority.goalId, goalRevision: 9, policyRevision: 9, taskId: 'accounts', attemptId: 'accepted-account-author', authorityGeneration: 2 };
  const acceptedTask: FactoryTask = { ...f.task, id: acceptedAuthority.taskId, title: 'Later simplified account task', description: 'Only use a unified account.', status: 'completed', currentAttemptId: acceptedAuthority.attemptId };
  const acceptedAttempt: Attempt = { ...f.author, id: acceptedAuthority.attemptId, taskId: acceptedTask.id, generation: acceptedAuthority.authorityGeneration, status: 'succeeded', candidate: 'accepted-account-candidate' };
  const commit = '2'.repeat(40), baseCommit = '3'.repeat(40);
  const checks = [{ command: 'sh account-scope.sh', passed: true, output: 'Both original account identities retained.', candidateCommit: commit, checkedCommit: commit }];
  const acceptedDetail: AttemptDetail = { id: acceptedAttempt.id, goalId: f.goal.id, goalRevision: 9, assignmentGoalRevision: 9, contract: acceptedContract, phase: 'done', cancellation: 'none',
    candidate: { id: acceptedAttempt.candidate!, commit, baseCommit }, checks, integration: { commit: '4'.repeat(40), previousHead: baseCommit, candidateCommit: commit, checks } };
  f.store.set('tasks', acceptedTask); f.store.set('attempts', acceptedAttempt); f.store.set('factory-attempt-details', acceptedDetail);
  const acceptedSource: InspectionSourceIdentity = { snapshotId: 'accepted-account-source', sha256: '5'.repeat(64), candidateId: acceptedAttempt.candidate, candidateCommit: commit, checkedCommit: commit, roots: [{ id: 'primary', sha256: '6'.repeat(64), commit }] };
  const acceptedJob = { ...f.job, id: 'accepted-account-job', authority: acceptedAuthority, source: acceptedSource };
  const acceptedArtifact = await f.artifacts.put(png, { name: 'accepted-accounts.png', mime: 'image/png', goalId: f.goal.id, taskId: acceptedTask.id, attemptId: acceptedAttempt.id });
  const acceptedScreen = { ...f.screenshot, id: 'accepted-account-screen', jobId: acceptedJob.id, authority: acceptedAuthority, source: acceptedSource, artifact: acceptedArtifact };
  f.store.set('inspection-jobs', acceptedJob); f.store.set('inspection-evidence', acceptedScreen);
  const finalBase = { ...f.run, purpose: 'goal-final' as const, goalRevision: f.goal.revision,
    acceptanceContract: { ...f.run.acceptanceContract!, goal: { revision: f.goal.revision, objective: f.goal.objective, criteria: f.goal.criteria,
      taskContracts: [{ taskId: acceptedTask.id, attemptId: acceptedAttempt.id, authorityGeneration: acceptedAttempt.generation, assignmentGoalRevision: 9, contract: acceptedContract }] } } };
  const finalRun = { ...finalBase, id: inspectionVerificationKey(finalBase) };
  f.store.set('inspection-verifier-runs', finalRun); f.setCurrent(finalRun);
  const index = payload(await f.service.call('factory_verification_history', {}));
  assert.ok((index.items as Array<{ id: string }>).some(item => item.id === acceptedScreen.id));
  const original = JSON.parse(await readAll(f.service, 'attempt', `factory-attempt-details/${acceptedAttempt.id}`)) as AttemptDetail;
  assert.deepEqual(original.contract, acceptedContract); assert.notEqual(original.contract!.description, acceptedTask.description);
  assert.deepEqual(original.integration, acceptedDetail.integration);
  f.store.set('tasks', { ...acceptedTask, status: 'failed' });
  await assert.rejects(f.service.call('factory_verification_history', {}), /accepted historical task was retired/);
});

test('historical screenshot acknowledgment rechecks original scope after viewing before recording delivery', async t => {
  for (const mutation of ['foreign-job-authority', 'changed-evidence-manifest', 'changed-original-contract'] as const) await t.test(mutation, async t => {
    const f = await fixture(t);
    await f.service.call('factory_verification_image', { evidenceId: f.screenshot.id });
    if (mutation === 'foreign-job-authority') f.store.set('inspection-jobs', { ...f.job, authority: { ...originalAuthority, goalId: 'foreign-goal' } });
    else if (mutation === 'changed-evidence-manifest') f.store.set('inspection-evidence', { ...f.screenshot, artifact: { ...f.screenshot.artifact, attemptId: 'foreign-attempt' } });
    else f.store.set('factory-attempt-details', { ...f.detail, contract: { ...contract, description: 'Only restore a marker.' } });
    assert.throws(() => f.service.acknowledgeImage({ run: f.run, chatId: f.run.chatId!, sha256: f.screenshot.artifact.sha256, server: 'factory', tool: 'factory_verification_image', eventId: 'retired-image', mimeType: 'image/png', byteLength: png.length }), /original scope or immutable manifest|original historical task/);
    assert.deepEqual(f.store.list('inspection-verification-history-image-deliveries'), []); assert.deepEqual(f.store.list('provider-image-deliveries'), []);
  });
});

type HistoryFixture = Awaited<ReturnType<typeof fixture>>;
const completedAt = '2026-10-09T00:01:00.000Z';
async function authorFixture(t: TestContext) {
  const f = await fixture(t);
  const workspace = { id: f.originalAuthor.id, attemptId: f.originalAuthor.id, taskId: f.task.id, goalId: f.goal.id, path: path.join(f.directory, 'author'),
    provider: 'git' as const, baseCommit: f.originalAuthor.baseCommit!, sessionId: 'original-session', deviceId: 'mac' };
  const author = { ...f.originalAuthor, chatId: 'original-chat', sessionId: workspace.sessionId };
  const project: Project = { id: 'original-internal-project', name: 'Original worker', path: workspace.path, deviceId: 'mac', createdAt: at,
    runtime: 'codex', approvalMode: 'approve-all', rules: [], internal: true, sourceProjectId: f.goal.projectId };
  const session: Session = { id: author.sessionId, projectId: project.id, deviceId: 'mac', name: 'f-original', status: 'stopped', createdAt: at, updatedAt: completedAt,
    branch: 'factory/original', containerId: 'envmux-original', services: [] };
  const chat: Chat = { id: author.chatId, sessionId: session.id, deviceId: 'mac', title: 'Original author', runtime: 'codex', attemptId: author.id,
    approvalMode: 'approve-all', status: 'idle', createdAt: at, updatedAt: completedAt, threadId: 'original-provider-thread' };
  const detail = { ...f.detail, workspace };
  const result = { id: chat.id, attemptId: author.id, completedAt, result: { stopReason: 'completed', text: detail.result!.text, threadId: chat.threadId } };
  f.store.set('attempts', author); f.store.set('factory-attempt-details', detail); f.store.set('projects', project);
  f.store.set('sessions', session); f.store.set('chats', chat); f.store.set('chat-results', result);
  return { ...f, author, detail, workspace, project, session, chat, result };
}

/** The production chat writer saves seq:0 in JSON; SQL owns the durable cursor and timestamp. */
function originalEvents(f: HistoryFixture, values: Array<{ at: string; value: Record<string, unknown> }>) {
  const db = new DatabaseSync(path.join(f.directory, 'factory.sqlite'));
  try {
    const insert = db.prepare('INSERT INTO events(topic,entity,value,at) VALUES(?,?,?,?)');
    return values.map(({ at, value }) => {
      const original = JSON.stringify({ id: `event-${value.id}`, chatId: 'original-chat', seq: 0, at, ...value });
      return { seq: Number(insert.run('chat', 'original-chat', original, at).lastInsertRowid), at, original };
    });
  } finally { db.close(); }
}
async function tracePage(f: HistoryFixture, eventCursor = 0, eventLimit = 32, maximum = 16000) {
  let original = '', offset = 0, digest: unknown;
  for (;;) {
    const page = payload(await f.service.call('factory_verification_evidence', { kind: 'author-trace', id: authority.attemptId, eventCursor, eventLimit, offset, maxCharacters: maximum }));
    assert.equal(page.historical, true); assert.equal(page.acceptanceUse, 'context-only');
    if (digest !== undefined) assert.equal(page.contentSha256, digest);
    digest = page.contentSha256; original += String(page.original); offset = Number(page.nextOffset);
    if (offset === page.totalCharacters) break;
  }
  assert.equal(createHash('sha256').update(original).digest('hex'), digest);
  return JSON.parse(original) as { originalOwner: { chatId: string; sessionId: string }; prefix: ReturnType<Store['chatEventPrefix']>; events: Array<{ seq: number; at: string; original: string }>; nextEventCursor: number; complete: boolean; limits: string };
}

test('author trace preserves failed server, repaired edit, successful check and later browser chronology in exact original pages', async t => {
  const f = await authorFixture(t);
  const rows = originalEvents(f, [
    { at: '2026-10-09T00:00:01.000Z', value: { id: 'server-failed', kind: 'tool', data: { type: 'commandExecution', status: 'completed', command: 'node server.cjs', exitCode: 127, output: 'node: not found\n' } } },
    { at: '2026-10-09T00:00:02.000Z', value: { id: 'server-started', kind: 'tool', data: { type: 'commandExecution', status: 'started', command: 'node server.cjs', processId: 10959 } } },
    { at: '2026-10-09T00:00:03.000Z', value: { id: 'edit', kind: 'tool', data: { type: 'fileChange', status: 'completed', changes: [{ path: 'app.js', diff: '-false\n+true\n' }] } } },
    { at: '2026-10-09T00:00:04.000Z', value: { id: 'check', kind: 'tool', data: { type: 'commandExecution', status: 'completed', command: 'node scripts/check.cjs', exitCode: 0, output: 'PASS complete body\n' } } },
    { at: '2026-10-09T00:00:05.000Z', value: { id: 'browser', kind: 'tool', data: { type: 'mcpToolCall', status: 'completed', server: 'factory', tool: 'factory_browser_start', result: { jobId: 'original-job' } } } },
    { at: '2026-10-09T00:00:06.000Z', value: { id: 'server-exited', kind: 'tool', data: { type: 'commandExecution', status: 'completed', command: 'node server.cjs', processId: 10959, exitCode: 0 } } },
    { at: '2026-10-09T00:02:00.000Z', value: { id: 'later-turn', kind: 'tool', data: { command: 'unrelated later work' } } },
  ]);
  const before = ['inspection-evidence', 'provider-image-deliveries', 'inspection-quality-equivalences'].map(bucket => f.store.list(bucket));
  const first = await tracePage(f, 0, 2, 83), second = await tracePage(f, first.nextEventCursor, 2), last = await tracePage(f, second.nextEventCursor, 2);
  assert.deepEqual([...first.events, ...second.events, ...last.events], rows.slice(0, 6));
  assert.equal(first.complete, false); assert.equal(last.complete, true); assert.equal(last.nextEventCursor, rows[5]!.seq);
  assert.equal(first.originalOwner.chatId, f.chat.id); assert.equal(first.originalOwner.sessionId, f.session.id);
  assert.deepEqual(first.prefix, f.store.chatEventPrefix(f.chat.id, completedAt));
  assert.equal(first.prefix.toolEventCount, 6); assert.equal(JSON.parse(first.events[0]!.original).seq, 0);
  assert.equal(JSON.parse(first.events[0]!.original).data.exitCode, 127);
  assert.ok(rows[3]!.seq < rows[4]!.seq); assert.match(last.limits, /write absence is not proven/);
  assert.deepEqual(['inspection-evidence', 'provider-image-deliveries', 'inspection-quality-equivalences'].map(bucket => f.store.list(bucket)), before);
  for (const args of [{ eventLimit: 0 }, { eventLimit: 33 }, { eventCursor: -1 }, { eventCursor: rows[6]!.seq }, { eventLimit: '2' }]) {
    await assert.rejects(f.service.call('factory_verification_evidence', { kind: 'author-trace', id: f.author.id, offset: 0, maxCharacters: 16000, ...args }), /original tool-event cursor/);
  }
});

test('author trace reaches original tool events after 10000 messages and freezes its viewed prefix', async t => {
  const f = await authorFixture(t);
  const rows = originalEvents(f, [
    ...Array.from({ length: 10005 }, (_, id) => ({ at, value: { id, kind: 'message', role: 'assistant', text: `Original explanation ${id}` } })),
    { at: '2026-10-09T00:00:59.000Z', value: { id: 'late-check', kind: 'tool', data: { command: 'node scripts/check.cjs', exitCode: 0 } } },
  ]);
  assert.equal(f.store.events('chat', f.chat.id).length, 10000, 'The ordinary UI window omits the late tool event');
  const page = await tracePage(f);
  assert.deepEqual(page.events, [rows.at(-1)!]); assert.equal(page.prefix.eventCount, rows.length); assert.equal(page.complete, true);
  const expectedDigest = createHash('sha256');
  for (const row of rows) expectedDigest.update(JSON.stringify([row.seq, row.at, row.original]) + '\n');
  assert.equal(page.prefix.sha256, expectedDigest.digest('hex'));
  originalEvents(f, [{ at: '2026-10-09T00:00:59.500Z', value: { id: 'backfilled', kind: 'tool', data: { command: 'forged earlier check' } } }]);
  await assert.rejects(tracePage(f), /journal prefix changed/);
});

test('author trace requires the original completed provider, chat, session, internal project and workspace chain', async t => {
  for (const mutation of ['foreign-chat', 'verifier-chat', 'foreign-session', 'verifier-session', 'foreign-project', 'workspace-path', 'workspace-attempt', 'device', 'result-text', 'result-attempt', 'result-incomplete', 'contract'] as const) await t.test(mutation, async t => {
    const f = await authorFixture(t);
    if (mutation === 'foreign-chat') f.store.set('chats', { ...f.chat, attemptId: 'another-author' });
    if (mutation === 'verifier-chat') f.store.set('chats', { ...f.chat, verificationRunId: f.run.id });
    if (mutation === 'foreign-session') f.store.set('sessions', { ...f.session, projectId: 'foreign-project' });
    if (mutation === 'verifier-session') f.store.set('sessions', { ...f.session, verificationRunId: f.run.id });
    if (mutation === 'foreign-project') f.store.set('projects', { ...f.project, sourceProjectId: 'another-goal-project' });
    if (mutation === 'workspace-path') f.store.set('projects', { ...f.project, path: path.join(f.directory, 'another-worker') });
    if (mutation === 'workspace-attempt') f.store.set('factory-attempt-details', { ...f.detail, workspace: { ...f.workspace, attemptId: 'another-author' } });
    if (mutation === 'device') f.store.set('sessions', { ...f.session, deviceId: 'other-device' });
    if (mutation === 'result-text') f.store.set('chat-results', { ...f.result, result: { ...f.result.result, text: 'A newer author result' } });
    if (mutation === 'result-attempt') f.store.set('chat-results', { ...f.result, attemptId: 'another-author' });
    if (mutation === 'result-incomplete') f.store.set('chat-results', { ...f.result, result: { ...f.result.result, stopReason: 'interrupted' } });
    if (mutation === 'contract') f.store.set('factory-attempt-details', { ...f.detail, contract: { ...contract, description: 'Only verify one line' } });
    if (mutation !== 'contract') {
      const items = payload(await f.service.call('factory_verification_history', {})).items as Array<{ kind: string; unavailable?: string }>;
      assert.ok(items.find(item => item.kind === 'author-trace')?.unavailable);
    }
    await assert.rejects(tracePage(f), /ownership is unavailable|original historical task/);
    assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  });
});

test('author trace rejects owner or journal changes during its awaited publication fence', async t => {
  for (const mutation of ['session', 'prefix'] as const) await t.test(mutation, async t => {
    const f = await authorFixture(t);
    originalEvents(f, [{ at, value: { id: 'check', kind: 'tool', data: { exitCode: 0 } } }]);
    let reads = 0;
    f.setCurrentHook(() => {
      if (++reads !== 2) return;
      if (mutation === 'session') f.store.set('sessions', { ...f.session, deviceId: 'foreign-device' });
      else originalEvents(f, [{ at, value: { id: 'late-added', kind: 'tool', data: { exitCode: 0 } } }]);
    });
    await assert.rejects(tracePage(f), /owner, prefix or captured source changed|journal prefix changed/);
    assert.equal(reads, 2); assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  });
});

async function sourceFixture(t: TestContext) {
  const f = await fixture(t), physical = await realpath(f.directory), primary = path.join(physical, 'mail-source'), secondary = path.join(physical, 'enough-ui');
  await mkdir(primary); await mkdir(path.join(secondary, 'empty'), { recursive: true });
  await writeFile(path.join(primary, 'app.js'), 'const restore = true;\r\nconst body = "first\\nsecond\\nlast ";\n');
  await writeFile(path.join(secondary, 'tokens.css'), ':root { --spacing: 12px; }\n');
  const dataDir = path.join(physical, 'captured'); await mkdir(dataDir, { mode: 0o700 });
  const snapshots = new InspectionSnapshotManager({ dataDir, artifacts: f.artifacts });
  const snapshot = await snapshots.create({ roots: [{ id: 'mail', name: 'Mail', path: primary }, { id: 'ui', name: 'EnoughUI', path: secondary }], context: originalAuthority });
  const transfer = await exportInspectionSnapshot({ snapshot, artifacts: f.artifacts, context: originalAuthority });
  const retention: InspectionSourceRetention = { id: snapshot.id, version: 1, sourceDigest: snapshot.sourceDigest, authority: originalAuthority, transfer, retainedAt: Date.parse(snapshot.manifest.createdAt), lastUsedAt: Date.parse(snapshot.manifest.createdAt) };
  const source: InspectionSourceIdentity = { snapshotId: snapshot.id, sha256: snapshot.sourceDigest, roots: snapshot.roots.map(root => ({ id: root.id, sha256: root.sourceDigest, commit: root.commit })) };
  const job = { ...f.job, id: 'captured-author-preview', source };
  f.store.set('inspection-jobs', job); f.store.set('inspection-source-retention', retention);
  return { ...f, snapshots, snapshot, transfer, retention, source, capturedJob: job };
}

test('source history returns the original all-root transfer manifest, capture time and exact file inventory from retained CAS bytes', async t => {
  const f = await sourceFixture(t);
  const expected = (await f.artifacts.read(f.transfer.sourceManifest)).toString('utf8');
  const index = payload(await f.service.call('factory_verification_history', {})).items as Array<{ kind: string; id: string; originalAuthority?: unknown; jobId?: string }>;
  const entry = index.find(item => item.kind === 'source-manifest');
  assert.equal(entry?.id, f.transfer.sourceManifest.id); assert.deepEqual(entry.originalAuthority, originalAuthority); assert.equal(entry.jobId, f.capturedJob.id);
  await f.snapshots.remove(f.snapshot);
  assert.equal(await readAll(f.service, 'source-manifest', f.transfer.sourceManifest.id, 127), expected);
  const pack = JSON.parse(expected);
  assert.equal(pack.snapshot.id, f.source.snapshotId); assert.equal(pack.snapshot.sourceDigest, f.source.sha256);
  assert.equal(pack.snapshot.createdAt, f.snapshot.manifest.createdAt); assert.equal(pack.snapshot.roots.length, 2);
  assert.deepEqual(pack.snapshot.roots, JSON.parse(JSON.stringify(f.snapshot.manifest.roots))); assert.deepEqual(pack.sourceArtifacts, f.transfer.sourceArtifacts);
  assert.deepEqual(f.store.list('provider-image-deliveries'), []);
});

test('source history rejects foreign transfer ownership, root omission and mutable source drift', async t => {
  for (const mutation of ['retention-authority', 'retention-digest', 'transfer-id', 'root-omission', 'job-roots', 'artifact-owner', 'corrupt-bytes'] as const) await t.test(mutation, async t => {
    const f = await sourceFixture(t);
    if (mutation === 'retention-authority') f.store.set('inspection-source-retention', { ...f.retention, authority: { ...originalAuthority, attemptId: 'another-author' } });
    if (mutation === 'retention-digest') f.store.set('inspection-source-retention', { ...f.retention, sourceDigest: '9'.repeat(64) });
    if (mutation === 'transfer-id') f.store.set('inspection-source-retention', { ...f.retention, transfer: { ...f.transfer, snapshotId: 'another-snapshot' } });
    if (mutation === 'root-omission') f.store.set('inspection-source-retention', { ...f.retention, transfer: { ...f.transfer, sourceArtifacts: f.transfer.sourceArtifacts.slice(0, 1) } });
    if (mutation === 'job-roots') f.store.set('inspection-jobs', { ...f.capturedJob, source: { ...f.source, roots: f.source.roots!.slice(0, 1) } });
    if (mutation === 'artifact-owner') {
      const first = f.transfer.sourceArtifacts[0]!;
      f.store.set('inspection-source-retention', { ...f.retention, transfer: { ...f.transfer, sourceArtifacts: [{ ...first, manifest: { ...first.manifest, attemptId: 'another-author' } }, f.transfer.sourceArtifacts[1]!] } });
    }
    if (mutation === 'corrupt-bytes') await writeFile(await f.artifacts.path(f.transfer.sourceManifest), 'corrupt original inventory');
    await assert.rejects(readAll(f.service, 'source-manifest', f.transfer.sourceManifest.id), /same-goal task scope|transfer manifest|artifact|digest|content/i);
    assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  });
});

test('source history revalidates original job and retention ownership after asynchronous artifact reads', async t => {
  for (const mutation of ['job', 'retention'] as const) await t.test(mutation, async t => {
    const f = await sourceFixture(t), originalRead = f.artifacts.read.bind(f.artifacts);
    let reads = 0;
    f.artifacts.read = async manifest => {
      const bytes = await originalRead(manifest);
      if (manifest.id === f.transfer.sourceManifest.id && ++reads === 1) {
        if (mutation === 'job') f.store.set('inspection-jobs', { ...f.capturedJob, authority: { ...originalAuthority, attemptId: 'foreign-author' } });
        else f.store.set('inspection-source-retention', { ...f.retention, sourceDigest: '9'.repeat(64) });
      }
      return bytes;
    };
    await assert.rejects(readAll(f.service, 'source-manifest', f.transfer.sourceManifest.id), /owner, prefix or captured source changed/);
    assert.equal(reads, 1); assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  });
});

async function retirementFixture(t: TestContext) {
  const f = await authorFixture(t), containerId = '7'.repeat(64);
  const identity = { sessionId: f.session.id, container: f.session.containerId!, name: f.session.containerId!, project: f.project.id, sessionName: f.session.name, projectPath: f.workspace.path, branch: f.session.branch!, workdir: '/work' };
  const labels = { schema: '2', kind: 'session', instance: identity.name, project: identity.project, session: identity.sessionName, directory: identity.projectPath, branch: identity.branch, workdir: identity.workdir };
  const receipt: EphemeralContainerReceipt = { version: 2, status: 'removed', identity, containerId, runtime: 'ephemeral', runtimeKinds: ['codex'],
    fingerprint: { container: { id: containerId, name: `/${identity.name}`, created: at, state: { Running: false, Paused: false, Restarting: false, Dead: false, Pid: 0, Status: 'exited' }, labels }, mounts: [] },
    archive: path.join(f.directory, 'recorded-provider-archive.tar.gz'), sha256: '8'.repeat(64), size: 100, rawSha256: '9'.repeat(64), rawSize: 1000, entries: 3, archives: [], exclusions: [],
    ownedVolumes: ['home', 'work'].map(role => ({ name: `${identity.name}-${role}`, status: 'removed', identity: { Name: `${identity.name}-${role}`, Driver: 'local', Scope: 'local', CreatedAt: at,
      Labels: { 'envmux.schema': '2', 'envmux.instance': identity.name, 'envmux.project': identity.project, 'envmux.session': identity.sessionName, 'envmux.directory': identity.projectPath, 'envmux.branch': identity.branch, 'envmux.volume': role }, Options: null } })) };
  const retired = { id: f.session.id, containerId, name: identity.name, status: 'removed', receipt, updatedAt: completedAt };
  f.store.set('session-container-retirement', retired);
  return { ...f, receipt, retired };
}

test('author retirement exposes the original typed removed-container receipt without claiming unrecorded server or write evidence', async t => {
  const f = await retirementFixture(t);
  const before = f.store.list('inspection-evidence');
  const record = JSON.parse(await readAll(f.service, 'author-retirement', f.author.id));
  assert.equal(record.originalOwner.sessionId, f.session.id); assert.deepEqual(record.originalSession, f.session); assert.deepEqual(record.originalRetirement, f.retired);
  assert.equal(record.originalRetirement.receipt.version, 2); assert.equal(record.originalRetirement.receipt.containerId, f.retired.containerId);
  assert.equal(record.originalRetirement.updatedAt, completedAt); assert.match(record.limits, /not unrecorded write absence/);
  assert.deepEqual(f.store.list('provider-image-deliveries'), []); assert.deepEqual(f.store.list('inspection-evidence'), before);
});

test('author retirement fails closed for unavailable, foreign, live or incompletely removed environments', async t => {
  for (const mutation of ['missing', 'foreign-session', 'foreign-container', 'foreign-workspace', 'still-archived', 'running', 'foreign-labels', 'retained-volume', 'no-volume-proof'] as const) await t.test(mutation, async t => {
    const f = await retirementFixture(t);
    const receipt = structuredClone(f.receipt);
    if (mutation === 'missing') f.store.delete('session-container-retirement', f.session.id);
    else {
      if (mutation === 'foreign-session') receipt.identity.sessionId = 'another-session';
      if (mutation === 'foreign-container') receipt.containerId = '6'.repeat(64);
      if (mutation === 'foreign-workspace') receipt.identity.projectPath = path.join(f.directory, 'another-worker');
      if (mutation === 'still-archived') receipt.status = 'archived';
      if (mutation === 'running') (receipt.fingerprint as { container: { state: { Running: boolean } } }).container.state.Running = true;
      if (mutation === 'foreign-labels') (receipt.fingerprint as { container: { labels: { project: string } } }).container.labels.project = 'another-project';
      if (mutation === 'retained-volume') receipt.ownedVolumes[0]!.status = 'retained';
      if (mutation === 'no-volume-proof') receipt.ownedVolumes = [];
      f.store.set('session-container-retirement', { ...f.retired, receipt });
    }
    const items = payload(await f.service.call('factory_verification_history', {})).items as Array<{ kind: string; unavailable?: string }>;
    assert.ok(items.find(item => item.kind === 'author-retirement')?.unavailable);
    await assert.rejects(readAll(f.service, 'author-retirement', f.author.id), /retirement receipt|retirement fingerprint/);
    assert.deepEqual(f.store.list('inspection-verification-history-views'), []);
  });
});
