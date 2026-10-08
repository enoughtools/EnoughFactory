import assert from 'node:assert/strict';
import test from 'node:test';
import type { Device, TaskExecutionRequirements } from '@enoughfactory/contracts';
import { executionPreference, readyMacTarget, withExecutionPreference } from './execution-preference';

const device: Device = { id: 'mac', name: 'Mac', platform: 'darwin', arch: 'arm64', local: true, online: true, lastSeen: '2026-10-08T00:00:00.000Z', executionTargets: [{ id: 'host', kind: 'host-macos', protocolVersion: 1, readiness: 'ready', runtimes: ['codex'], workspaceProviders: ['git'], capabilities: [{ kind: 'mac-shell', readiness: 'ready' }] }] };

test('legacy execution stays container while changing preference retains the capability contract', () => {
  assert.equal(executionPreference(undefined), 'container');
  assert.equal(executionPreference({ delegatedCapabilities: ['apple-compilation'] }), 'container');
  const original: TaskExecutionRequirements = { target: 'container', requiredCapabilities: ['mac-shell'], delegatedCapabilities: ['apple-compilation'] };
  assert.deepEqual(withExecutionPreference(original, 'auto'), { ...original, target: 'auto' });
  assert.equal(original.target, 'container');
  assert.deepEqual(withExecutionPreference(undefined, 'auto'), { target: 'auto' });
});

test('Mac choice requires an online explicit ready compatible target rather than a Mac platform label', () => {
  assert.equal(readyMacTarget({ ...device, executionTargets: undefined }, undefined, 'codex', 'git'), undefined);
  assert.equal(readyMacTarget({ ...device, online: false }, undefined, 'codex', 'git'), undefined);
  assert.equal(readyMacTarget(device, undefined, 'claude', 'git'), undefined);
  assert.equal(readyMacTarget(device, undefined, 'codex', 'artifactfs'), undefined);
  assert.equal(readyMacTarget(device, { requiredCapabilities: ['apple-compilation'] }, 'codex', 'git'), undefined);
  assert.equal(readyMacTarget({ ...device, executionTargets: [{ ...device.executionTargets![0]!, readiness: 'preparing' }] }, undefined, 'codex', 'git'), undefined);
  assert.equal(readyMacTarget({ ...device, executionTargets: [{ ...device.executionTargets![0]!, capabilities: [{ kind: 'mac-shell', readiness: 'preparing' }] }] }, undefined, 'codex', 'git'), undefined);
  assert.equal(readyMacTarget(device, { delegatedCapabilities: ['apple-compilation'] }, 'codex', 'git')?.id, 'host', 'Delegated testing can be provided by another configured device');
  assert.equal(readyMacTarget(device, undefined, 'codex', 'git')?.id, 'host');
});
