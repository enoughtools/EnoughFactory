import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Settings } from '@enoughfactory/contracts';
import { DeviceApp } from './app.ts';
import { Store } from './store.ts';
import { automaticWorkerCapacity, parseWorkerResources } from './worker-capacity.ts';

test('automatic slots account for memory and CPU limits and reject invalid peer budgets', () => {
  assert.equal(automaticWorkerCapacity({ cpus: 32, memoryGiB: 6 }), 3, 'memory can limit a many-core device');
  assert.equal(automaticWorkerCapacity({ cpus: 2, memoryGiB: 64 }), 1, 'CPU can limit a high-memory device');
  assert.equal(automaticWorkerCapacity({ cpus: 1, memoryGiB: 1 }), 1);
  assert.equal(automaticWorkerCapacity({ cpus: 256, memoryGiB: 512 }), 32);
  assert.equal(automaticWorkerCapacity(undefined), 2, 'legacy resource discovery keeps a conservative fallback');
  assert.deepEqual(parseWorkerResources({ cpus: 8, memoryGiB: 7.5, unexpected: true }), { cpus: 8, memoryGiB: 7.5 });
  for (const value of [null, [], { cpus: '8', memoryGiB: 16 }, { cpus: 8, memoryGiB: -1 }, { cpus: Infinity, memoryGiB: 16 }, { cpus: 2, memoryGiB: NaN }, { cpus: 1025, memoryGiB: 16 }]) {
    assert.equal(parseWorkerResources(value), undefined);
  }
});

test('capacity settings persist, reset to automatic, and invalid updates leave existing settings intact', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'enoughfactory-worker-capacity-'));
  const store = new Store(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  // Exercise the real API and persistence without instantiating or starting a container runtime.
  const app = Object.assign(Object.create(DeviceApp.prototype) as DeviceApp, {
    store, settings: { deviceName: 'Capacity fixture', defaultRuntime: 'codex', defaultApprovalMode: 'approve-all' },
    device: { id: 'capacity-device', name: 'Capacity fixture', local: true, platform: 'darwin', arch: 'arm64', online: true, lastSeen: '2026-10-05T00:00:00.000Z' },
    devices: [], diagnostics: { containerRuntime: { state: 'stopped', cpus: 8, memoryGiB: 16 } },
    changed() {}, state() { return { settings: this.settings }; },
  });
  const patch = (body: Record<string, unknown>) => app.dispatch({ method: 'PATCH', url: new URL('http://localhost/api/settings'), body });
  await patch({ workerCapacity: 7 });
  assert.equal(app.device.capacity, 7);
  assert.equal(store.get<Settings & { id: string }>('settings', 'main')?.workerCapacity, 7);
  for (const invalid of [0, 33, 2.5, '8', false, {}, NaN]) {
    await assert.rejects(patch({ workerCapacity: invalid, deviceName: 'Invalid mutation' }), /1–32/);
    assert.equal(app.settings.deviceName, 'Capacity fixture');
    assert.equal(app.device.capacity, 7);
    assert.equal(store.get<Settings & { id: string }>('settings', 'main')?.workerCapacity, 7);
  }
  await patch({ deviceName: 'Renamed fixture' });
  assert.equal(app.device.capacity, 7, 'unrelated settings must retain a manual worker limit');
  await patch({ workerCapacity: null });
  assert.equal(app.device.capacity, 4);
  assert.equal(Object.hasOwn(app.settings, 'workerCapacity'), false);
  assert.equal(store.get<Settings & { id: string }>('settings', 'main')?.workerCapacity, undefined);
});
