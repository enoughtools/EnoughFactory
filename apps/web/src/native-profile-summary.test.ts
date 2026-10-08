import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeProfileSummaries } from './native-profile-summary';

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
