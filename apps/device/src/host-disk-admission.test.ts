import assert from 'node:assert/strict';
import test from 'node:test';
import type { Attempt, Device, FactoryTask, Goal, Project } from '@enoughfactory/contracts';
import { FactoryCapacityError, FactoryCoordinator, type AttemptDetail, type ControlRecord, type FactoryStore } from '@enoughfactory/factory';
import { HostDiskAdmission, HostDiskHeadroomError, preparationArtifactBytes } from './host-disk-admission.ts';
import { factoryAttemptTransferSource } from './factory.ts';
import type { ArtifactManifest } from '@enoughfactory/workspaces';

test('low host space blocks dispatch before copies and parallel setup cannot spend the same headroom', async () => {
  const GiB = 1024 ** 3;
  let at = Date.parse('2026-10-10T00:00:00Z');
  let available = Math.floor(3.87 * GiB), probeFails = false;
  const disk = new HostDiskAdmission(() => ['/owned-state', '/owned-runtime'], () => 'Test Mac', () => {
    if (probeFails) throw new Error('Filesystem unavailable');
    return available;
  });
  const artifact = { sha256: 'a'.repeat(64), size: GiB / 8 };
  const knownBytes = preparationArtifactBytes([artifact, artifact]);
  assert.equal(knownBytes, artifact.size, 'The same immutable content is counted once.');
  const tables = new Map<string, Map<string, unknown>>();
  const store: FactoryStore = {
    list: <T>(table: string) => [...(tables.get(table)?.values() ?? [])] as T[],
    get: <T>(table: string, id: string) => tables.get(table)?.get(id) as T | undefined,
    set: (table, value) => { if (!tables.has(table)) tables.set(table, new Map()); tables.get(table)!.set(value.id, value); },
    delete: (table, id) => { tables.get(table)?.delete(id); }, transaction: fn => fn(),
  };
  const device: Device = { id: 'mac', name: 'Test Mac', local: true, online: true, platform: 'darwin', arch: 'arm64', lastSeen: new Date().toISOString(), capacity: 2 };
  const project: Project = { id: 'project', name: 'Mail', path: '/project', deviceId: device.id, runtime: 'codex', approvalMode: 'approve-all', rules: [], createdAt: device.lastSeen };
  let planner = 0, copied = 0, provider = 0, executionCalls = 0, captured = 0, checkouts = 0, releasePreparation!: () => void;
  let providerBlocked = true, checkArtifactBytes = 3 * GiB, retainController = true;
  const preparing = new Promise<void>(resolve => { releasePreparation = resolve; });
  const coordinator = new FactoryCoordinator({
    store, deviceId: device.id, devices: () => [device], project: () => project, now: () => new Date(at),
    admission: () => disk.blocker(GiB + knownBytes * 2),
    runtime: {
      async complete() { planner++; return { text: JSON.stringify({ summary: 'Two independent mail tasks', criteria: ['Mail works'], checks: [], tasks: [
        { key: 'read', title: 'Read mail', description: 'Read messages', dependsOn: [], checks: [], writePaths: ['read/'] },
        { key: 'write', title: 'Write mail', description: 'Compose messages', dependsOn: [], checks: [], writePaths: ['write/'] },
      ] }) }; },
      async execute() {
        executionCalls++;
        if (providerBlocked) { providerBlocked = false; return { status: 'waiting', text: '', agentStarted: false, waitReason: 'Waiting for host disk space before provider setup.', wakeCondition: 'host-disk-space' }; }
        provider++; return { status: 'succeeded', text: 'Done' };
      },
      async reconcile() { return { status: 'unknown' }; }, async cancel() {},
    },
    workspaces: {
      async prepare({ attempt }) {
        const release = disk.reserve(attempt.id, knownBytes);
        try {
          disk.assert(); copied++;
          await preparing;
          return { id: attempt.id, path: '/isolated', baseCommit: 'base', provider: 'git' };
        } finally { release(); }
      },
      async capture(workspace) { captured++; return { id: workspace.id, commit: 'candidate', baseCommit: 'base' }; },
      async check(_project, candidate) {
        if (retainController) {
          retainController = false;
          const active = store.get<ControlRecord>('factory-control', created.id)!;
          store.set('factory-control', { ...active, operation: { id: 'live-localized-planner', revision: 1, kind: 'planner' } });
        }
        let release: () => void;
        try { release = disk.reserve(`check:${candidate.id}`, checkArtifactBytes); }
        catch (error) { assert.ok(error instanceof HostDiskHeadroomError); throw new FactoryCapacityError(error.message); }
        try { checkouts++; return []; } finally { release(); }
      },
      async integrate(_project, candidate) { return { commit: 'integrated', previousHead: 'base', candidateCommit: candidate.commit, checks: [] }; },
      async inspect() { return { head: 'integrated', branch: 'main', status: '' }; },
    },
  });
  const created = coordinator.create({ projectId: project.id, objective: 'Build mail', autonomy: 'autonomous', approvalMode: 'approve-all', concurrency: 2 });
  const goal = () => store.get<Goal>('goals', created.id)!;
  const control = () => store.get<ControlRecord>('factory-control', created.id)!;
  await coordinator.tick();
  assert.equal(planner, 0); assert.equal(copied, 0); assert.equal(provider, 0);
  assert.equal(store.list<Attempt>('attempts').length, 0);
  assert.equal(goal().status, 'waiting'); assert.equal(control().waitingFor, 'host-disk-space');
  assert.match(goal().nextAction!, /Free disk space on Test Mac.*3\.9 GiB available.*6\.3 GiB required/);
  assert.equal(store.list('approvals').length, 0, 'Capacity is not an approval request.');

  available = Math.floor(6.5 * GiB);
  await coordinator.tick(); await coordinator.waitForIdle();
  assert.equal(planner, 1); assert.equal(store.list<FactoryTask>('tasks').length, 2);
  await coordinator.tick();
  assert.equal(store.list<Attempt>('attempts').length, 1, 'The second parallel attempt is refused before allocation.');
  assert.equal(copied, 1); assert.equal(provider, 0);
  assert.throws(() => disk.reserve('competing-setup', knownBytes), (error: unknown) => {
    assert.ok(error instanceof HostDiskHeadroomError);
    assert.equal(error.code, 'HOST_DISK_HEADROOM'); assert.equal(error.status, 409);
    assert.equal(error.agentStarted, false); assert.equal(error.executionEnded, true);
    assert.ok(error.details.requiredBytes > available);
    return true;
  });
  probeFails = true;
  assert.match(disk.blocker()!.reason, /cannot verify free disk space/);
  assert.throws(() => disk.assert(), HostDiskHeadroomError, 'A stale successful probe never overrides a current failure.');
  probeFails = false;

  coordinator.pause(created.id);
  available = 10 * GiB;
  releasePreparation(); await coordinator.waitForIdle();
  await coordinator.tick();
  assert.equal(goal().status, 'paused', 'Returning disk headroom cannot resume an explicit pause.');
  assert.equal(store.list<Attempt>('attempts').length, 1);
  assert.equal(provider, 0, 'A positively refused provider setup never counts as execution.');
  const deferredAttempt = store.list<Attempt>('attempts')[0]!;
  assert.equal(deferredAttempt.status, 'created');
  assert.equal(store.get<AttemptDetail>('factory-attempt-details', deferredAttempt.id)!.capacityWait, 'executing');
  coordinator.resume(created.id);
  await coordinator.tick(); await coordinator.waitForIdle();
  assert.equal(store.list<Attempt>('attempts').length, 2);
  assert.equal(copied, 2); assert.equal(provider, 2);
  assert.equal(executionCalls, 3, 'The same prepared attempt resumes without another source preparation.');
  assert.equal(captured, 2, 'Completed work is captured despite a check capacity refusal.');
  assert.equal(checkouts, 0, 'A check capacity refusal precedes isolated checkout.');
  assert.ok(store.list<FactoryTask>('tasks').every(task => task.status === 'review'));
  assert.ok(store.list<Attempt>('attempts').every(attempt => attempt.status === 'succeeded'));
  assert.equal(control().operation!.id, 'live-localized-planner', 'An independent check wait cannot revoke a live controller.');
  store.set('factory-control', { ...control(), operation: undefined });
  available = GiB;
  await coordinator.tick(); await coordinator.waitForIdle();
  assert.equal(goal().status, 'waiting');
  assert.equal(captured, 2); assert.equal(checkouts, 0, 'Repeated disk waits create no new checkout or check report.');
  available = 10 * GiB; checkArtifactBytes = 0;
  at += 10_000;
  await coordinator.tick(); await coordinator.waitForIdle();
  assert.equal(checkouts, 2);
  assert.ok(store.list<FactoryTask>('tasks').every(task => task.status === 'completed'));
  assert.equal(disk.blocker(), undefined, 'Every completed preparation releases its reservation.');
  let exports = 0, configReads = 0;
  const transfer = await factoryAttemptTransferSource(store, 'remote-attempt', async () => {
    exports++; return { ...artifact, id: 'source', name: 'source.bundle', mime: 'application/octet-stream', deviceId: device.id, createdAt: device.lastSeen, metadata: { commit: 'original-head', ref: 'original-bundle-ref' } } satisfies ArtifactManifest;
  }, async () => { configReads++; return 'original config'; });
  const retry = await factoryAttemptTransferSource(store, 'remote-attempt', async () => {
    exports++; throw new Error('A changed repository must not replace the original transfer.');
  }, async () => { configReads++; return 'changed config'; });
  assert.deepEqual(retry, transfer);
  assert.equal(exports, 1); assert.equal(configReads, 1, 'A remote capacity retry reuses the exact source and config without re-export.');
});
