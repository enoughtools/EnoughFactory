import assert from 'node:assert/strict';
import test from 'node:test';
import type { InspectionAuthority, InspectionEvidence, InspectionSourceIdentity } from '@enoughfactory/contracts';
import { factoryQualityEvidenceContext, parseQualityEvidenceReport, validateQualityEvidence, type QualityActionReceipt, type QualityEvidenceReport, type QualityEvidenceResolver, type QualityExpectation, type QualityObservationReceipt } from './factory-quality.ts';

function fixture() {
  const authority: InspectionAuthority = { goalId: 'goal', goalRevision: 4, taskId: 'task', attemptId: 'attempt', authorityGeneration: 2, policyRevision: 1 };
  const source: InspectionSourceIdentity = { snapshotId: 'snapshot', sha256: 'a'.repeat(64), candidateId: 'candidate', candidateCommit: 'c'.repeat(40), checkedCommit: 'c'.repeat(40), roots: [{ id: 'design-system', sha256: 'd'.repeat(64) }] };
  const expected: QualityExpectation = { authority, source, platforms: ['macos'], workflows: [{ id: 'close-and-keep-draft', platform: 'macos' }], referenceIds: ['mail-web', 'enough-ui'] };
  const observations = new Map<string, QualityObservationReceipt>();
  for (const [id, sequence] of [['before', 1], ['after', 3]] as const) {
    const artifact = { id: `${id}-image`, name: `${id}.png`, mime: 'image/png', sha256: sequence.toString().repeat(64), size: 256, deviceId: 'mac', createdAt: '2026-10-08T00:00:00Z' };
    const evidence: InspectionEvidence = { id, jobId: 'job', sessionId: 'session', authority, source, kind: 'screenshot', artifact, createdAt: artifact.createdAt };
    observations.set(id, { evidence, observationId: `ui-${id}`, platform: 'macos', sequence, imageDelivery: { chatId: 'author-chat', eventId: `${id}-image-delivery`, artifactSha256: artifact.sha256, route: 'tool-image' } });
  }
  const action: QualityActionReceipt = { source, platform: 'macos', sequence: 2, action: { id: 'close', jobId: 'job', sessionId: 'session', authority, kind: 'click', observationId: 'ui-before', arguments: { element: 'close-draft' }, status: 'succeeded', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:01Z' } };
  const resolver: QualityEvidenceResolver = { observation: async id => observations.get(id), action: async id => id === 'close' ? action : undefined, reference: async id => expected.referenceIds.includes(id) };
  const report: QualityEvidenceReport = { version: 1, source, workflows: [{ id: 'close-and-keep-draft', platform: 'macos', before: 'before', action: 'close', after: 'after', outcome: 'passed', assertion: 'Composer is absent after Close and keep draft; the inbox is visible.' }], reviews: [{ platform: 'macos', observations: ['before', 'after'], references: [{ id: 'mail-web', comparison: 'Inbox remains visible after closing a draft, matching the observed web flow.' }, { id: 'enough-ui', comparison: 'The composer uses the vendored button/input styles and proportionate control spacing.' }], dimensions: { hierarchy: 'Subject and primary action remain clear.', spacing: 'Composer fields have consistent gaps.', clipping: 'Body and action row remain visible.', typography: 'Body text is readable at the recorded scale.', controls: 'Focus stays on a visible control.', states: 'Draft saved state remains distinguishable from sending.' }, defects: [] }] };
  return { authority, source, expected, observations, action, resolver, report };
}

test('quality acceptance requires a real current-source observation/action loop and inspected references', async () => {
  const f = fixture();
  assert.deepEqual(await validateQualityEvidence(f.report, f.expected, f.resolver), { status: 'ready-for-review', issues: [], evidenceIds: ['before', 'after'] });
  f.resolver.reference = async () => false;
  const absentReference = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.equal(absentReference.status, 'evidence-required');
  assert.match(absentReference.issues.join('\n'), /lacks inspected reference mail-web/);
});

test('screenshot files and authored claims cannot replace provider image delivery', async () => {
  const f = fixture();
  f.observations.get('after')!.imageDelivery = undefined;
  let result = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.equal(result.status, 'evidence-required');
  assert.match(result.issues.join('\n'), /image-delivery/);
  f.observations.get('before')!.imageDelivery!.artifactSha256 = 'f'.repeat(64);
  result = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.deepEqual(result.evidenceIds, []);
});

test('old commits, changed secondary roots and stale attempt authority cannot satisfy the new product review', async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.report.source = { ...f.source, checkedCommit: 'e'.repeat(40) }; },
    f => { f.observations.get('after')!.evidence.source = { ...f.source, roots: [{ id: 'design-system', sha256: 'e'.repeat(64) }] }; },
    f => { f.observations.get('after')!.evidence.authority = { ...f.authority, authorityGeneration: 1 }; },
    f => { f.action.action.authority = { ...f.authority, goalRevision: 3 }; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    assert.equal((await validateQualityEvidence(f.report, f.expected, f.resolver)).status, 'evidence-required');
  }
});

test('successful input is insufficient without a fresh same-session result', async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.action.action.observationId = 'older-observation'; },
    f => { f.action.action.sessionId = 'another-session'; },
    f => { f.action.action.status = 'unknown'; },
    f => { f.observations.get('after')!.sequence = 1; },
    f => { f.action.action.kind = 'screenshot'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    const result = await validateQualityEvidence(f.report, f.expected, f.resolver);
    assert.equal(result.status, 'evidence-required');
    assert.match(result.issues.join('\n'), /before\/action\/after/);
  }
});

test('a journaled native restart can verify persistence through a same-session resulting observation', async () => {
  const f = fixture();
  f.action.action.kind = 'restart';
  f.report.workflows[0]!.assertion = 'The retained draft is visible with its edited body after restart.';
  assert.equal((await validateQualityEvidence(f.report, f.expected, f.resolver)).status, 'ready-for-review');
  f.action.action.status = 'unknown';
  assert.equal((await validateQualityEvidence(f.report, f.expected, f.resolver)).status, 'evidence-required');
});

test('observed workflow failures and serious visual defects require repair while minor issues remain visible', async () => {
  const f = fixture();
  f.report.workflows[0]!.outcome = 'failed';
  f.report.workflows[0]!.assertion = 'Composer remains visible after the close action.';
  let result = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.equal(result.status, 'repair-required');
  assert.match(result.issues.join('\n'), /Composer remains visible/);
  f.report.workflows[0]!.outcome = 'passed';
  f.report.reviews[0]!.defects = [{ id: 'clipped-send', severity: 'major', status: 'open', description: 'Send is clipped outside the window.', observation: 'after' }];
  result = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.equal(result.status, 'repair-required');
  f.report.reviews[0]!.defects[0]!.severity = 'minor';
  assert.equal((await validateQualityEvidence(f.report, f.expected, f.resolver)).status, 'ready-for-review');
});

test('missing workflow coverage, duplicate identities and over-budget reports fail closed', async () => {
  const f = fixture();
  f.expected.workflows.push({ id: 'reopen-after-restart', platform: 'macos' });
  const result = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.equal(result.status, 'evidence-required');
  assert.match(result.issues.join('\n'), /reopen-after-restart/);
  f.report.workflows.push({ ...f.report.workflows[0]! });
  assert.throws(() => parseQualityEvidenceReport(f.report), /Duplicate/);
  f.report.workflows.pop();
  assert.throws(() => parseQualityEvidenceReport({ ...f.report, extra: 'x'.repeat(128 * 1024) }), /input budget/);
  assert.equal((await validateQualityEvidence('screenshots looked great', f.expected, f.resolver)).status, 'evidence-required');
});

test('a reported serious defect on an additional platform still requires repair', async () => {
  const f = fixture();
  f.report.reviews.push({ ...f.report.reviews[0]!, platform: 'ios-simulator', defects: [{ id: 'phone-clipping', severity: 'blocking', status: 'open', observation: 'after', description: 'The phone composer hides Send.' }] });
  const result = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.equal(result.status, 'repair-required');
  assert.match(result.issues.join(' '), /phone composer hides Send/);
});

test('unavailable or corrupted retained evidence cannot accidentally pass or crash the quality review', async () => {
  const f = fixture();
  f.resolver.observation = async () => { throw new Error('Retained artifact hash mismatch'); };
  f.resolver.action = async () => { throw new Error('Peer temporarily unavailable'); };
  f.resolver.reference = async () => { throw new Error('Reference manifest is missing'); };
  const result = await validateQualityEvidence(f.report, f.expected, f.resolver);
  assert.equal(result.status, 'evidence-required');
  assert.deepEqual(result.evidenceIds, []);
});

test('controller quality context stays bounded, preserves evidence identities and does not pretend to contain images', () => {
  const f = fixture();
  const stale = structuredClone(f.observations.get('after')!);
  stale.evidence.id = 'stale-image'; stale.evidence.source.sha256 = 'f'.repeat(64);
  const context = factoryQualityEvidenceContext({ source: f.source, observations: [...f.observations.values(), stale], referenceIds: f.expected.referenceIds, maximumScreenshots: 1, uiTrees: { 'ui-after': 'Actual interface text '.repeat(1000) } });
  assert.match(context, /"evidenceId":"after"/);
  assert.match(context, /"observationId":"ui-after"/);
  assert.match(context, /no image bytes/);
  assert.doesNotMatch(context, /stale-image/);
  assert.doesNotMatch(context, /"evidenceId":"before"/);
  assert(context.length < 3500);
});

test('JSON enum coercion cannot hide an open serious defect or relabel a workflow failure', () => {
  const f = fixture();
  const defect = { id: 'broken-composer', severity: 'major', status: ['open'], description: 'Composer cannot close.', observation: 'after' };
  const malformed = { ...f.report, reviews: [{ ...f.report.reviews[0]!, defects: [defect] }] };
  assert.throws(() => parseQualityEvidenceReport(malformed), /Invalid visual review/);
  assert.throws(() => parseQualityEvidenceReport({ ...f.report, workflows: [{ ...f.report.workflows[0]!, outcome: ['failed'] }] }), /Invalid quality workflow/);
});
