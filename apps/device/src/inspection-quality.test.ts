import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { InspectionAction, InspectionAuthority, InspectionEvidence, InspectionJob, InspectionSourceIdentity, TaskQualityRequirements } from '@enoughfactory/contracts';
import { ArtifactStore } from '@enoughfactory/workspaces';
import { Store } from './store.ts';
import { InspectionQualityService, inspectionSourceContentMatches, type InspectionImageDelivery, type InspectionQualityEquivalence, type InspectionReferenceView } from './inspection-quality.ts';
import type { InspectionObservation } from './inspection-jobs.ts';
import type { QualityEvidenceReport } from './factory-quality.ts';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'enough-quality-'));
  const store = new Store(directory), artifacts = new ArtifactStore(path.join(directory, 'artifacts'), 'mac');
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 4, taskId: 'task', attemptId: 'attempt', authorityGeneration: 2, policyRevision: 1 };
  const source: InspectionSourceIdentity = { snapshotId: 'preview-snapshot', sha256: 'a'.repeat(64), roots: [{ id: 'primary', sha256: 'b'.repeat(64), commit: 'c'.repeat(40) }, { id: 'enough-ui', sha256: 'd'.repeat(64), commit: 'e'.repeat(40) }] };
  const quality: TaskQualityRequirements = { platforms: ['macos'], workflows: [{ id: 'close-draft', platform: 'macos' }], referenceIds: ['enough-ui'] };
  const now = '2026-10-08T00:00:00Z';
  const job: InspectionJob = { id: 'job', authority, ownerDeviceId: 'mac', executionTargetId: 'mac-desktop', capability: 'macos-app-inspection', source, profile: {}, status: 'running', sessionId: 'session', createdAt: now, updatedAt: now };
  store.set('inspection-jobs', job);
  const evidence: InspectionEvidence[] = [];
  const observe = async (id: string) => {
    const artifact = await artifacts.put(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5Wj4sAAAAASUVORK5CYII=', 'base64'), { name: `${id}.png`, mime: 'image/png', goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId });
    const record: InspectionEvidence = { id, jobId: job.id, sessionId: 'session', actionId: `observe-${id}`, authority, source, kind: 'screenshot', artifact, createdAt: now, metadata: { platform: 'macos', observationId: `ui-${id}` } };
    const observation: InspectionObservation = { id: `ui-${id}`, sessionId: 'session', actionId: `observe-${id}`, screenshotEvidenceId: id, uiTree: id === 'before' ? 'Composer with Close and keep draft button' : 'Inbox visible; composer absent', createdAt: now };
    store.set('inspection-actions', { id: observation.actionId, jobId: job.id, sessionId: 'session', authority, kind: 'observe', arguments: {}, status: 'succeeded', createdAt: now, updatedAt: now });
    store.set('inspection-evidence', record); store.set('inspection-observations', observation);
    store.append('inspection-journal', observation.id, { kind: 'observation-recorded', at: now, value: { jobId: job.id, actionId: observation.actionId } });
    const delivery: InspectionImageDelivery = { id: `delivery-${id}`, chatId: 'author-chat', eventId: `provider-image-${id}`, artifactSha256: artifact.sha256, authority, route: 'tool-image' };
    store.set('provider-image-deliveries', delivery);
    evidence.push(record);
  };
  await observe('before');
  const action: InspectionAction = { id: 'close', jobId: job.id, sessionId: 'session', authority, kind: 'click', arguments: { elementId: 'close-button' }, observationId: 'ui-before', status: 'succeeded', createdAt: now, updatedAt: now };
  store.set('inspection-actions', action); store.append('inspection-journal', action.id, { kind: 'action-requested', at: now, value: { jobId: job.id, sessionId: action.sessionId } });
  await observe('after');
  const assertionArtifact = await artifacts.put(JSON.stringify({ passed: true, observationId: 'ui-after', condition: { absent: true, labelIncludes: 'Composer' } }), { name: 'workflow-assertion.json', mime: 'application/json', goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId });
  const assertion: InspectionEvidence = { id: 'assert-close', jobId: job.id, sessionId: 'session', authority, source, kind: 'assertion', artifact: assertionArtifact, createdAt: now, metadata: { passed: true, observationId: 'ui-after', platform: 'macos' } };
  store.set('inspection-evidence', assertion); store.append('inspection-journal', assertion.id, { kind: 'evidence-published', at: now, value: { jobId: job.id, kind: 'assertion' } });
  const referenceArtifact = await artifacts.put('Original pinned EnoughUI reference component source', { name: 'EnoughUI-reference.swift', mime: 'text/plain', goalId: authority.goalId, taskId: authority.taskId, attemptId: authority.attemptId });
  const reference: InspectionReferenceView = { id: 'reference-view', referenceId: 'enough-ui', authority, source, artifacts: [referenceArtifact], artifactIds: [referenceArtifact.id], inspectedAt: now };
  store.set('inspection-reference-views', reference);
  const report: QualityEvidenceReport = { version: 1, source, workflows: [{ id: 'close-draft', platform: 'macos', before: 'before', action: 'close', after: 'after', outcome: 'passed', assertion: 'Composer disappeared and inbox became visible.', assertionEvidenceId: assertion.id }], reviews: [{ platform: 'macos', observations: ['before', 'after'], references: [{ id: 'enough-ui', comparison: 'The inspected native control styles and layout match the pinned component reference.' }], dimensions: { hierarchy: 'Primary actions are clear.', spacing: 'Fields have deliberate padding.', clipping: 'Content remains within the viewport.', typography: 'Text uses the supplied semantic styles.', controls: 'Focus belongs to a visible control.', states: 'Saved draft state remains visible.' }, defects: [] }] };
  let current = true;
  const service = new InspectionQualityService({ store, artifacts, authorityCurrent: value => current && JSON.stringify(value) === JSON.stringify(authority), now: () => now });
  const checked: InspectionSourceIdentity = { ...source, snapshotId: 'saved-candidate-snapshot', candidateId: 'real-candidate', candidateCommit: 'f'.repeat(40), checkedCommit: 'f'.repeat(40), roots: source.roots!.map(root => ({ ...root, commit: 'f'.repeat(40) })) };
  const check = () => service.check({ authority, quality, source: checked, candidateCommit: checked.candidateCommit! });
  return { store, artifacts, authority, source, checked, quality, job, report, evidence, action, assertion, service, check, setCurrent: (value: boolean) => { current = value; } };
}

test('quality reports retain original preview identity while a saved candidate passes only exact-content equivalence', async t => {
  const f = await fixture(t);
  const record = await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  assert.equal(record.gate.status, 'ready-for-review');
  const result = await f.check();
  assert.equal(result.passed, true);
  assert.equal(result.candidateCommit, f.checked.candidateCommit);
  const equivalence = f.store.list<InspectionQualityEquivalence>('inspection-quality-equivalences')[0]!;
  assert.deepEqual(equivalence.testedSource, f.source);
  assert.deepEqual(equivalence.checkedSource, f.checked);
  assert.notEqual(equivalence.testedSource.snapshotId, equivalence.checkedSource.snapshotId);
  assert.equal(equivalence.basis, 'exact-source-digest-and-all-root-digests');
  assert.match(await f.service.context({ source: f.source, authority: f.authority, referenceIds: f.quality.referenceIds }), /"observationId":"ui-after"/);
  const combined = await f.service.check({ authority: f.authority, quality: f.quality, source: { ...f.checked, checkedCommit: '1'.repeat(40) }, candidateCommit: f.checked.candidateCommit!, checkedCommit: '1'.repeat(40) });
  assert.equal(combined.passed, true);
  assert.equal(combined.candidateCommit, 'f'.repeat(40));
  assert.equal(combined.checkedCommit, '1'.repeat(40));
  assert.equal(f.store.list<InspectionQualityEquivalence>('inspection-quality-equivalences')[1]!.testedSource.snapshotId, 'preview-snapshot');
});

test('changed source, secondary folders or frozen quality contract require new inspection evidence', async t => {
  const f = await fixture(t);
  const missing = await f.check();
  assert.equal(missing.passed, false); assert.equal(missing.recovery?.condition, 'inspection-evidence');
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  const changedSource = await f.service.check({ authority: f.authority, quality: f.quality, source: { ...f.checked, sha256: '9'.repeat(64) }, candidateCommit: '9'.repeat(40) });
  assert.equal(changedSource.passed, false);
  const changedRoot = { ...f.checked, roots: f.checked.roots!.map(root => root.id === 'enough-ui' ? { ...root, sha256: '9'.repeat(64) } : root) };
  assert.equal((await f.service.check({ authority: f.authority, quality: f.quality, source: changedRoot, candidateCommit: '9'.repeat(40) })).passed, false);
  assert.equal((await f.service.check({ authority: f.authority, quality: { ...f.quality, referenceIds: ['different-reference'] }, source: f.checked, candidateCommit: f.checked.candidateCommit! })).passed, false);
});

test('a newer failed report cannot be masked by an older passing report for the same content', async t => {
  const f = await fixture(t);
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  f.report.workflows[0]!.outcome = 'failed'; f.report.workflows[0]!.assertion = 'Composer stays open after the close action.';
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  const result = await f.check();
  assert.equal(result.passed, false);
  assert.match(result.output, /Composer stays open/);
  assert.equal(result.recovery, undefined, 'A concrete workflow defect requires source repair, not another verifier wait');
});

test('an authored passed claim without a genuine assertion on the after-state remains a verifier wait', async t => {
  const f = await fixture(t);
  f.report.workflows[0]!.assertionEvidenceId = undefined;
  const record = await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  assert.equal(record.gate.status, 'evidence-required');
  const result = await f.check();
  assert.equal(result.passed, false); assert.equal(result.recovery?.condition, 'inspection-evidence');
  f.report.workflows[0]!.assertionEvidenceId = f.assertion.id;
  f.store.set('inspection-evidence', { ...f.assertion, metadata: { ...f.assertion.metadata, observationId: 'ui-before' } });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'evidence-required');
});

test('a genuine failed broker assertion requires repair rather than waiting for nonexistent evidence', async t => {
  const f = await fixture(t);
  const artifact = await f.artifacts.put(JSON.stringify({ passed: false, observationId: 'ui-after', condition: { absent: true, labelIncludes: 'Composer' } }), { name: 'failed-assertion.json', mime: 'application/json', goalId: f.authority.goalId, taskId: f.authority.taskId, attemptId: f.authority.attemptId });
  f.store.set('inspection-evidence', { ...f.assertion, artifact, metadata: { ...f.assertion.metadata, passed: false } });
  const submitted = await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  assert.equal(submitted.gate.status, 'repair-required');
  const checked = await f.check();
  assert.equal(checked.passed, false); assert.equal(checked.recovery, undefined);
  assert.match(checked.output, /failed broker assertion/);
});

test('candidate checks revalidate receipt authority, provider image delivery and unresolved actions', async t => {
  const f = await fixture(t);
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  f.store.set('inspection-actions', { ...f.action, status: 'unknown' });
  assert.equal((await f.check()).passed, false);
  f.store.set('inspection-actions', f.action);
  f.store.set('inspection-jobs', { ...f.job, status: 'unknown' });
  assert.equal((await f.check()).passed, false);
  f.store.set('inspection-jobs', f.job);
  for (const delivery of f.store.list<InspectionImageDelivery>('provider-image-deliveries')) f.store.set('provider-image-deliveries', { ...delivery, authority: { ...f.authority, authorityGeneration: 1 } });
  assert.equal((await f.check()).passed, false);
});

test('a screenshot published by a failed observing action cannot satisfy quality even when pixels were delivered', async t => {
  const f = await fixture(t);
  const observing = f.store.get<InspectionAction>('inspection-actions', 'observe-after')!;
  f.store.set('inspection-actions', { ...observing, status: 'failed', reason: 'Structured UI snapshot failed.' });
  const report = await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  assert.equal(report.gate.status, 'evidence-required');
  assert.equal((await f.check()).passed, false);
});

test('report and screenshot bytes are verified again rather than trusting a retained gate success', async t => {
  const f = await fixture(t);
  const record = await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  const image = await f.artifacts.path(f.evidence[0]!.artifact);
  await writeFile(image, 'corrupted image');
  assert.equal((await f.check()).passed, false);
  const reportPath = await f.artifacts.path(record.reportArtifact);
  await writeFile(reportPath, '{}');
  const result = await f.check();
  assert.equal(result.passed, false);
  assert.match(result.output, /failed retained artifact verification/);
});

test('stale authority cannot submit or certify quality', async t => {
  const f = await fixture(t);
  f.setCurrent(false);
  await assert.rejects(f.service.submit({ authority: f.authority, quality: f.quality, report: f.report }), /stale/);
  await assert.rejects(f.check(), /stale/);
  assert.deepEqual(f.store.list('inspection-quality-reports'), []);
});

test('reference existence alone and undelivered reference screenshots cannot pass an inspected-reference requirement', async t => {
  const f = await fixture(t);
  const view = f.store.get<InspectionReferenceView>('inspection-reference-views', 'reference-view')!;
  f.store.set('inspection-reference-views', { ...view, artifacts: [], artifactIds: [] });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'evidence-required');
  const image = await f.artifacts.put('distinct reference pixels', { name: 'reference.png', mime: 'image/png', goalId: f.authority.goalId, taskId: f.authority.taskId, attemptId: f.authority.attemptId });
  f.store.set('inspection-reference-views', { ...view, artifacts: [image], artifactIds: [image.id] });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'evidence-required');
  f.store.set('provider-image-deliveries', { id: 'reference-delivery', chatId: 'author-chat', eventId: 'reference-image', artifactSha256: image.sha256, authority: f.authority, route: 'tool-image' });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'ready-for-review');
});

test('an unknown outcome arriving during asynchronous evidence verification prevents acceptance', async t => {
  const f = await fixture(t);
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  const read = f.artifacts.read.bind(f.artifacts);
  let changed = false;
  f.artifacts.read = async manifest => {
    const bytes = await read(manifest);
    if (!changed) { changed = true; f.store.set('inspection-jobs', { ...f.job, status: 'unknown' }); }
    return bytes;
  };
  const result = await f.check();
  assert.equal(result.passed, false);
  assert.equal(result.recovery?.condition, 'inspection-evidence');
  assert.deepEqual(f.store.list('inspection-quality-equivalences'), []);
});

test('fresh inspected references recover from older unavailable views and pin the original manifests', async t => {
  const f = await fixture(t);
  const view = f.store.get<InspectionReferenceView>('inspection-reference-views', 'reference-view')!;
  const original = view.artifacts![0]!;
  f.store.set('inspection-reference-views', { ...view, artifacts: [{ ...original, sha256: '9'.repeat(64) }] });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'evidence-required');
  f.store.set('inspection-reference-views', { ...view, id: 'newer-valid-reference-view' });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'ready-for-review');
  // The newest unread/unavailable view must not hide an earlier valid one either.
  f.store.set('inspection-reference-views', { ...view, id: 'newest-unavailable-reference-view', artifacts: [{ ...original, id: 'missing' }] });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'ready-for-review');
  const substituted = await f.artifacts.put('Substituted reference bytes', { name: 'other.swift', mime: 'text/plain', goalId: f.authority.goalId, taskId: f.authority.taskId, attemptId: f.authority.attemptId });
  const get = f.artifacts.get.bind(f.artifacts);
  f.artifacts.get = async id => id === original.id ? { ...substituted, id } : get(id);
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'evidence-required');
});

test('reference pixels need genuine nonblank image delivery fields', async t => {
  const f = await fixture(t);
  const view = f.store.get<InspectionReferenceView>('inspection-reference-views', 'reference-view')!;
  const image = await f.artifacts.put('unique reference image', { name: 'ref.png', mime: 'image/png', goalId: f.authority.goalId, taskId: f.authority.taskId, attemptId: f.authority.attemptId });
  f.store.set('inspection-reference-views', { ...view, artifacts: [image] });
  f.store.set('provider-image-deliveries', { id: 'blank-delivery', chatId: ' ', eventId: '', artifactSha256: image.sha256, authority: f.authority, route: 'tool-image' });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'evidence-required');
  f.store.set('provider-image-deliveries', { id: 'blank-delivery', chatId: 'author', eventId: 'provider-event', artifactSha256: image.sha256, authority: f.authority, route: 'tool-image' });
  assert.equal((await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report })).gate.status, 'ready-for-review');
});

test('source-content matching is independent of synthetic commit IDs and rejects omitted/duplicate roots', () => {
  const source: InspectionSourceIdentity = { snapshotId: 'preview', sha256: 'a'.repeat(64), roots: [{ id: 'primary', sha256: 'b'.repeat(64), commit: 'c'.repeat(40) }, { id: 'ui', sha256: 'd'.repeat(64) }] };
  assert.equal(inspectionSourceContentMatches(source, { ...source, snapshotId: 'candidate', roots: [...source.roots!].reverse().map(root => ({ ...root, commit: 'f'.repeat(40) })) }), true);
  assert.equal(inspectionSourceContentMatches(source, { ...source, roots: source.roots!.slice(0, 1) }), false);
  assert.equal(inspectionSourceContentMatches(source, { ...source, roots: [source.roots![0]!, source.roots![0]!] }), false);
  assert.equal(inspectionSourceContentMatches(undefined as unknown as InspectionSourceIdentity, source), false);
  assert.equal(inspectionSourceContentMatches({ ...source, roots: [null] } as unknown as InspectionSourceIdentity, source), false);
});

async function evaluatorFixture(f: Awaited<ReturnType<typeof fixture>>) {
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  f.store.set('goals', { id: f.authority.goalId, revision: 4, status: 'running' });
  f.store.set('factory-controller-runs', { id: 'evaluator', goalId: f.authority.goalId, role: 'evaluator', status: 'completed', chatId: 'review-chat' });
  for (const evidence of f.evidence) f.store.set('controller-image-deliveries', { id: `review-${evidence.id}`, controllerRunId: 'evaluator', goalId: f.authority.goalId, goalRevision: 4, chatId: 'review-chat', eventId: `tool-${evidence.id}`, artifactSha256: evidence.artifact.sha256 });
  const reference = f.store.get<InspectionReferenceView>('inspection-reference-views', 'reference-view')!;
  f.store.set('controller-reference-views', { id: 'review-reference', controllerRunId: 'evaluator', goalId: f.authority.goalId, source: f.checked, referenceId: 'enough-ui', artifacts: reference.artifacts });
  f.store.set('controller-evidence-views', { id: 'review-assertion', controllerRunId: 'evaluator', goalId: f.authority.goalId, evidenceId: f.assertion.id, source: f.checked, artifact: f.assertion.artifact, viewedAt: '2026-10-08T00:00:01Z' });
  const review = { source: f.checked, reviews: structuredClone(f.report.reviews) };
  const check = () => f.service.reviewCheck({ goalId: f.authority.goalId, controllerRunId: 'evaluator', source: f.checked, quality: f.quality, review });
  return { review, check };
}

test('completion requires a separate current evaluator to view original source-equivalent screenshots and references', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  const result = await evaluator.check();
  assert.deepEqual(result, { ready: true, evidenceIds: ['assert-close', 'before', 'after'] });
  for (const record of f.store.list<{ id: string }>('controller-image-deliveries')) f.store.delete('controller-image-deliveries', record.id);
  const unseen = await evaluator.check();
  assert.equal(unseen.ready, false); assert.match(unseen.reason!, /this evaluator's image tool/);
  assert.ok(f.store.list('provider-image-deliveries').length, 'Author image delivery must not substitute for evaluator viewing');
});

test('old controllers, old goal revisions, old source and authored review claims cannot certify completion', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  for (const record of f.store.list<{ id: string }>('controller-image-deliveries')) f.store.set('controller-image-deliveries', { ...record, controllerRunId: 'previous-evaluator' });
  assert.equal((await evaluator.check()).ready, false);
  await evaluatorFixture(f);
  f.store.set('goals', { id: f.authority.goalId, revision: 5, status: 'running' });
  assert.equal((await evaluator.check()).ready, false);
  f.store.set('goals', { id: f.authority.goalId, revision: 4, status: 'running' });
  evaluator.review.source = { ...f.checked, roots: f.checked.roots!.map(root => ({ ...root, sha256: '9'.repeat(64) })) };
  assert.equal((await evaluator.check()).ready, false);
  assert.equal((await f.service.reviewCheck({ goalId: 'goal', controllerRunId: 'evaluator', source: f.checked, quality: f.quality, review: undefined })).ready, false);
});

test('evaluator comparisons require original current-source reference bytes and real reference image viewing', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  const image = await f.artifacts.put('new distinct reference image', { name: 'reference.png', mime: 'image/png', goalId: 'goal' });
  f.store.set('controller-reference-views', { id: 'review-reference', controllerRunId: 'evaluator', goalId: 'goal', source: f.checked, referenceId: 'enough-ui', artifacts: [image] });
  assert.equal((await evaluator.check()).ready, false);
  f.store.set('controller-image-deliveries', { id: 'reference-image', controllerRunId: 'evaluator', goalId: 'goal', goalRevision: 4, chatId: 'review-chat', eventId: 'reference-view', artifactSha256: image.sha256 });
  assert.equal((await evaluator.check()).ready, true);
  f.store.set('controller-reference-views', { id: 'review-reference', controllerRunId: 'evaluator', goalId: 'goal', source: f.checked, referenceId: 'enough-ui', artifacts: [{ ...image, sha256: '9'.repeat(64) }] });
  assert.equal((await evaluator.check()).ready, false);
});

test('evaluator evidence corruption, unknown outcomes, incomplete critique and open serious defects refuse completion', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  evaluator.review.reviews[0]!.defects = [{ id: 'clipping', severity: 'major', status: 'open', description: 'Send remains outside the viewport.', observation: 'after' }];
  const defect = await evaluator.check(); assert.equal(defect.ready, false); assert.match(defect.reason!, /Repair clipping/);
  evaluator.review.reviews[0]!.defects = [];
  evaluator.review.reviews[0]!.dimensions.spacing = '';
  assert.equal((await evaluator.check()).ready, false);
  evaluator.review.reviews[0]!.dimensions.spacing = 'Controls retain deliberate padding.';
  f.store.set('inspection-jobs', { ...f.job, status: 'unknown' });
  assert.equal((await evaluator.check()).ready, false);
  f.store.set('inspection-jobs', f.job);
  await writeFile(await f.artifacts.path(f.evidence[0]!.artifact), 'changed pixels');
  assert.equal((await evaluator.check()).ready, false);
});

test('evaluator acceptance fences relevant receipt changes without blocking independent goals', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f), original = f.artifacts.path.bind(f.artifacts);
  let changed = false;
  f.artifacts.path = async manifest => {
    const result = await original(manifest);
    if (!changed) { changed = true; f.store.set('inspection-observations', { id: 'independent', sessionId: 'another-goal-session', actionId: 'other', uiTree: 'Unrelated task', createdAt: 'now' }); }
    return result;
  };
  assert.equal((await evaluator.check()).ready, true);
  changed = false;
  f.artifacts.path = async manifest => {
    const result = await original(manifest);
    if (!changed) { changed = true; f.store.set('inspection-jobs', { ...f.job, status: 'unknown' }); }
    return result;
  };
  const result = await evaluator.check();
  assert.equal(result.ready, false); assert.match(result.reason!, /evidence changed/);
});

test('completion requires the evaluator to read original current-source workflow assertions', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  f.store.delete('controller-evidence-views', 'review-assertion');
  const unread = await evaluator.check();
  assert.equal(unread.ready, false); assert.match(unread.reason!, /Read original resulting assertion/);
  await evaluatorFixture(f);
  const view = f.store.get<{ id: string; artifact: typeof f.assertion.artifact; source: InspectionSourceIdentity }>('controller-evidence-views', 'review-assertion')!;
  f.store.set('controller-evidence-views', { ...view, artifact: { ...view.artifact, sha256: '9'.repeat(64) } });
  assert.equal((await evaluator.check()).ready, false, 'A read receipt must pin the actual original assertion manifest');
  f.store.set('controller-evidence-views', { ...view, source: { ...view.source, sha256: '9'.repeat(64) } });
  assert.equal((await evaluator.check()).ready, false, 'An assertion read from a different integrated source cannot count');
  f.store.set('controller-evidence-views', view);
  assert.equal((await evaluator.check()).ready, true);
});

test('a latest failed integrated workflow report prevents completion despite older passing evidence and visual critique', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  assert.equal((await evaluator.check()).ready, true);
  f.report.workflows[0]!.outcome = 'failed'; f.report.workflows[0]!.assertion = 'Composer remains open after the close action.';
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  const failed = await evaluator.check();
  assert.equal(failed.ready, false); assert.match(failed.reason!, /latest report.*Composer remains open/);
  f.report.workflows[0]!.outcome = 'passed'; f.report.workflows[0]!.assertion = 'Composer disappeared and inbox became visible.';
  await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  assert.equal((await evaluator.check()).ready, true, 'A fresh valid report can repair the earlier workflow failure');
});

test('a newly failed report arriving during evaluator verification cannot race completion', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f), original = f.artifacts.path.bind(f.artifacts);
  const first = f.store.list<{ id: string; sequence: number }>('inspection-quality-reports')[0]!;
  const failedReport = structuredClone(f.report); failedReport.workflows[0]!.outcome = 'failed';
  const failedArtifact = await f.artifacts.put(JSON.stringify(failedReport), { name: 'later-failed-review.json', mime: 'application/json', goalId: f.authority.goalId, taskId: f.authority.taskId, attemptId: f.authority.attemptId });
  let changed = false;
  f.artifacts.path = async manifest => {
    const result = await original(manifest);
    if (!changed) { changed = true; f.store.set('inspection-quality-reports', { ...first, id: 'new-report-during-review', sequence: first.sequence + 1, reportArtifact: failedArtifact }); }
    return result;
  };
  const checked = await evaluator.check();
  assert.equal(checked.ready, false); assert.match(checked.reason!, /evidence changed/);
});

test('retired workflow authority during asynchronous evaluator verification cannot certify completion', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f), original = f.artifacts.path.bind(f.artifacts);
  let retired = false;
  f.artifacts.path = async manifest => {
    const result = await original(manifest);
    if (!retired) { retired = true; f.setCurrent(false); }
    return result;
  };
  const checked = await evaluator.check();
  assert.equal(checked.ready, false); assert.match(checked.reason!, /authority changed/);
});

test('a platform-only quality policy cannot hide an author report with an open blocking visual defect', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  const quality: TaskQualityRequirements = { ...f.quality, workflows: [] };
  const report = structuredClone(f.report); report.workflows = [];
  report.reviews[0]!.defects = [{ id: 'send-clipped', severity: 'blocking', status: 'open', description: 'Send is outside the viewport.', observation: 'after' }];
  assert.equal((await f.service.submit({ authority: f.authority, quality, report })).gate.status, 'repair-required');
  const checked = await f.service.reviewCheck({ goalId: 'goal', controllerRunId: 'evaluator', source: f.checked, quality, review: evaluator.review });
  assert.equal(checked.ready, false); assert.match(checked.reason!, /send-clipped/);
});

test('platform-only final acceptance still needs a current-source retained quality report', async t => {
  const f = await fixture(t), evaluator = await evaluatorFixture(f);
  for (const record of f.store.list<{ id: string }>('inspection-quality-reports')) f.store.delete('inspection-quality-reports', record.id);
  const checked = await f.service.reviewCheck({ goalId: 'goal', controllerRunId: 'evaluator', source: f.checked, quality: { ...f.quality, workflows: [] }, review: evaluator.review });
  assert.equal(checked.ready, false); assert.match(checked.reason!, /needs a retained quality report/);
});

test('controller report context bounds repeated review history and links workflows only after verifying the original', async t => {
  const f = await fixture(t);
  const first = await f.service.submit({ authority: f.authority, quality: f.quality, report: f.report });
  for (let index = 1; index < 30; index++) f.store.set('inspection-quality-reports', { ...first, id: `later-report-${index}`, sequence: first.sequence + index });
  const context = await f.service.controllerReportContext({ goalId: 'goal', source: f.checked });
  assert.ok(context.reports.length <= 24); assert.ok(context.omitted >= 6);
  assert.ok(Buffer.byteLength(JSON.stringify(context)) <= 49 * 1024, 'A long history must not exhaust controller input');
  assert.equal(context.reports[0]!.latestForPolicy, true); assert.equal(context.reports[1]!.latestForPolicy, false);
  const workflow = (context.reports[0]!.workflows as Array<{ assertionEvidenceId: string }>)[0]!;
  assert.equal(workflow.assertionEvidenceId, f.assertion.id);
  const original = await f.service.controllerReport({ goalId: 'goal', reportId: first.id });
  assert.deepEqual(JSON.parse(original.original), f.report);
  await assert.rejects(f.service.controllerReport({ goalId: 'different-goal', reportId: first.id }), /your goal/);
});
