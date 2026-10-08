import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionTargetAdvertisement } from '@enoughfactory/contracts';
import { negotiatedExecutionTargets, parseExecutionTargets, receiveCatalog } from './network.ts';

const target = (): ExecutionTargetAdvertisement => ({ id: 'host-macos', kind: 'host-macos', protocolVersion: 1, readiness: 'ready', capacity: 1,
  resources: { cpus: 8, memoryGiB: 16 }, workspaceProviders: ['git'], runtimes: ['codex'], capabilities: [
    { kind: 'apple-compilation', readiness: 'ready', version: 'Xcode 27' },
    { kind: 'macos-app-inspection', readiness: 'setup-required', reason: 'The testing helper is unavailable.', setupAction: 'Install and start the testing helper.' },
  ] });

test('paired catalogs preserve explicit readiness and strip untrusted fields without inventing legacy capabilities', () => {
  const advertised = target();
  const received = receiveCatalog('paired-mac', { device: { id: 'untrusted-id', platform: 'darwin', executionTargets: [{ ...advertised, token: 'private-value' }] } });
  assert.equal(received.id, 'paired-mac');
  assert.deepEqual(received.executionTargets, [advertised]);
  assert.equal(JSON.stringify(received).includes('private-value'), false);
  advertised.capabilities[0]!.readiness = 'unsupported';
  assert.equal(received.executionTargets![0]!.capabilities[0]!.readiness, 'ready', 'The received advertisement owns its sanitized copy');
  assert.equal(receiveCatalog('old-mac', { device: { platform: 'darwin' }, capacity: 4 }).executionTargets, undefined);
  assert.deepEqual(receiveCatalog('invalid-mac', { executionTargets: 'ready', device: { platform: 'darwin' } }).executionTargets, []);
  assert.deepEqual(receiveCatalog('invalid-mac', { executionTargets: null, device: { executionTargets: [target()] } }).executionTargets, [], 'An invalid current advertisement cannot fall back to a nested or legacy capability');
  assert.deepEqual(receiveCatalog('paired-mac', { executionTargets: [] }).executionTargets, []);
  assert.deepEqual(receiveCatalog('paired-mac', { executionTargets: [target()] }).executionTargets, [target()], 'Catalog events and state refreshes use the same protocol');
});

test('unknown target protocols, capabilities, readiness and ambiguous identities cannot authorize execution', () => {
  for (const malformed of [
    { ...target(), protocolVersion: 2 },
    { ...target(), kind: 'host-linux' },
    { ...target(), readiness: 'available' },
    { ...target(), capabilities: [{ kind: 'arbitrary-desktop-access', readiness: 'ready' }] },
    { ...target(), capabilities: [{ kind: 'macos-app-inspection', readiness: 'maybe' }] },
    { ...target(), capabilities: [{ kind: 'macos-app-inspection', readiness: 'ready' }, { kind: 'macos-app-inspection', readiness: 'unsupported' }] },
    { ...target(), workspaceProviders: ['future-provider'] },
    { ...target(), runtimes: ['future-runtime'] },
    { ...target(), id: '../another-target' },
    null,
  ]) assert.deepEqual(parseExecutionTargets([malformed]), []);
  assert.deepEqual(parseExecutionTargets([target(), target()]), [], 'Duplicate target identities are ambiguous');
  assert.deepEqual(parseExecutionTargets(Array.from({ length: 17 }, (_, i) => ({ ...target(), id: `target-${i}` }))), [], 'Advertisements have a bounded target inventory');
  const parsed = parseExecutionTargets([{ ...target(), capacity: Number.POSITIVE_INFINITY, resources: { cpus: -1, memoryGiB: 16 }, reason: 'x'.repeat(2000) }])!;
  assert.equal(parsed[0]!.capacity, undefined);
  assert.equal(parsed[0]!.resources, undefined);
  assert.equal(parsed[0]!.reason!.length, 1000);
});

test('saved remote readiness cannot authorize native work before a fresh connection handshake', () => {
  const saved = [target()];
  assert.deepEqual(negotiatedExecutionTargets(saved, true, false), []);
  assert.deepEqual(negotiatedExecutionTargets(saved, true, true), saved);
  assert.deepEqual(negotiatedExecutionTargets(saved, false, false), saved, 'Offline probes remain available as history');
  assert.equal(negotiatedExecutionTargets(undefined, true, false), undefined, 'Legacy peers keep only their existing container fallback');
});
