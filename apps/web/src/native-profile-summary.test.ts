import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeProfileAuditSummaries, nativeProfileSummaries } from './native-profile-summary';

test('profiles expose original matching audit manifests without claiming current source verification', () => {
  const receipt = { id: 'audit', name: 'Fixture audit', mime: 'application/json', sha256: 'a'.repeat(64), size: 100, deviceId: 'mac', createdAt: '2026-10-08T00:00:00.000Z', storagePath: '/private/internal' };
  const profile = { id: 'mac', build: { tool: 'xcodebuild', platform: 'macos', scheme: 'MailMac' }, fixtureEvidenceSha256: receipt.sha256, launchArguments: ['private'], receipt };
  const summary = nativeProfileSummaries([profile])[0]!;
  assert.equal(summary.platform, 'macos');
  assert.equal(summary.receipt?.id, 'audit');
  assert.equal('storagePath' in summary.receipt!, false);
  assert.equal('launchArguments' in summary, false);
  assert.equal(nativeProfileSummaries([{ ...profile, receipt: { ...receipt, sha256: 'b'.repeat(64) } }])[0]?.receipt, undefined);
  assert.equal(nativeProfileSummaries([{ ...profile, receipt: { ...receipt, size: 2 * 1024 * 1024 } }])[0]?.receipt, undefined);
  assert.equal(nativeProfileSummaries([{ ...profile, receipt: undefined }])[0]?.receipt, undefined);
  assert.deepEqual(nativeProfileSummaries([{ ...profile, build: { tool: 'xcodebuild', platform: 'unknown' } }]), []);
  assert.deepEqual(nativeProfileSummaries({ profiles: [profile] }), []);
});

test('automatic setup reviews preserve each service state before a profile is configured', () => {
  for (const status of ['queued', 'preparing', 'running', 'waiting', 'unknown', 'rejected', 'configured', 'canceled']) {
    const value = nativeProfileAuditSummaries([{ id: `audit-${status}`, profileId: 'mail-mac', status, reason: 'Concrete source review finding.', nextAction: 'Continue this original review.', source: { privatePath: '/private/author' }, runtimeConfiguration: 'private' }]);
    assert.equal(value.available, true);
    assert.deepEqual(value.audits, [{ id: `audit-${status}`, profileId: 'mail-mac', status, reason: 'Concrete source review finding.', nextAction: 'Continue this original review.' }]);
  }
});

test('review summaries retain only the latest creation per profile and bound visible history', () => {
  const rows = [
    { id: 'old-ready', profileId: 'mail-mac', status: 'configured' },
    { id: 'phone', profileId: 'mail-phone', status: 'queued' },
    { id: 'other', profileId: 'another-app', status: 'waiting' },
    { id: 'latest-mac', profileId: 'mail-mac', status: 'rejected', reason: 'The current source still opens production storage.' },
    { id: 'newest', profileId: 'new-profile', status: 'running' },
  ];
  assert.deepEqual(nativeProfileAuditSummaries(rows).audits.map(audit => [audit.id, audit.status]), [['newest', 'running'], ['latest-mac', 'rejected'], ['other', 'waiting'], ['phone', 'queued']]);
  const history = Array.from({ length: 20 }, (_, index) => ({ id: `configured-${index}`, profileId: `configured-${index}`, status: 'configured' }));
  const bounded = nativeProfileAuditSummaries([{ id: 'important-wait', profileId: 'mail-mac', status: 'waiting' }, ...history]);
  assert.equal(bounded.audits[0]?.id, 'important-wait'); assert.equal(bounded.audits.length, 16); assert.equal(bounded.omitted, 5);
  assert.deepEqual(nativeProfileAuditSummaries([...rows, { id: 'malformed-newest', profileId: 'mail-mac', status: 'unrecognized' }]), { available: false, audits: [] });
  assert.deepEqual(nativeProfileAuditSummaries([]), { available: true, audits: [] });
  for (const value of [null, {}, { audits: [] }, [null], [{ id: 'review', status: 'queued' }]]) assert.deepEqual(nativeProfileAuditSummaries(value), { available: false, audits: [] });
});

test('review findings project only bounded original JSON manifests without weakening rejected status', () => {
  const verdict = { id: 'findings', name: 'Original source findings', mime: 'application/json', sha256: 'b'.repeat(64), size: 100, deviceId: 'review-owner', createdAt: '2026-10-09T00:00:00.000Z', storagePath: '/private/findings', token: 'private' };
  const audit = { id: 'rejected', profileId: 'mail-mac', status: 'rejected', reason: `\u0000${'r'.repeat(900)}`, nextAction: `\u001b${'n'.repeat(700)}`, verdict };
  const summary = nativeProfileAuditSummaries([audit]).audits[0]!;
  assert.equal(summary.reason?.length, 800); assert.equal(summary.nextAction?.length, 600);
  assert.equal(summary.reason?.includes('\u0000'), false); assert.equal(summary.nextAction?.includes('\u001b'), false);
  assert.equal(summary.verdict?.deviceId, 'review-owner');
  assert.equal('storagePath' in summary.verdict!, false); assert.equal('token' in summary.verdict!, false);
  for (const changed of [{ sha256: 'bad' }, { size: 2 * 1024 * 1024 }, { size: -1 }, { deviceId: '' }, { mime: 'text/plain' }, { createdAt: 'unknown' }]) {
    const response = nativeProfileAuditSummaries([{ ...audit, verdict: { ...verdict, ...changed } }]);
    assert.equal(response.available, true); assert.equal(response.audits[0]!.status, 'rejected'); assert.equal(response.audits[0]!.verdict, undefined);
  }
});
