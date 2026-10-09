import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Device, ExecutionTargetAdvertisement, RuntimeCapability } from '@enoughfactory/contracts';
import type { NativeReadiness } from '@enoughfactory/native-inspection';
import type { DeviceApp, Extension } from './app.ts';
import type { ChatController } from './chats.ts';
import { InspectionService } from './inspection-service.ts';
import { Store } from './store.ts';
import { HttpError } from './util.ts';

const macOnly = { skip: process.platform !== 'darwin' };
const denied = (): NativeReadiness => ({ status: 'setup-required', reasons: ['Accessibility and screen capture permission are unavailable.'], accessibility: false, screenCapture: false, guiSession: true });
const ready = (): NativeReadiness => ({ status: 'ready', reasons: [], accessibility: true, screenCapture: true, guiSession: true });
interface PermissionResponse { readiness: NativeReadiness; executionTargets: ExecutionTargetAdvertisement[]; }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((succeed, fail) => { resolve = succeed; reject = fail; });
  return { promise, resolve, reject };
}

/** Real service orchestration and SQLite; native permission prompts and installation are fake. */
async function fixture(t: TestContext) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'ef-mac-permissions-'))), store = new Store(directory);
  let mac = denied(), requestCalls = 0, probeCalls = 0, changes = 0, closeCalls = 0;
  const events: Array<{ topic: string; data: unknown }> = [], controllers = new Set<AbortController>(), operations = new Set<Promise<unknown>>(), cleanups: Array<() => void> = [];
  const device: Device = { id: 'mac', name: 'Test Mac', platform: 'darwin', arch: 'arm64', online: true, local: true, lastSeen: new Date().toISOString(), capacity: 1, workspaceProviders: ['git'] };
  const extensions: Extension[] = [];
  const app = { dataDir: directory, store, device, devices: [device], extensions, closers: [], serviceActivityHooks: [],
    runtime: { endpoint: { host: 'unix:///never-use-docker', cliPath: '/usr/bin/false', configDirectory: path.join(directory, 'private-runtime') } },
    changed: () => { changes++; }, emit: (topic: string, data: unknown) => { events.push({ topic, data }); },
    withServiceOperation: <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const controller = new AbortController(); controllers.add(controller);
      let promise: Promise<T>;
      promise = Promise.resolve().then(() => operation(controller.signal)).finally(() => { controllers.delete(controller); operations.delete(promise); });
      operations.add(promise); return promise;
    },
  } as unknown as DeviceApp;
  const capability: RuntimeCapability = { kind: 'codex', available: true, version: 'pinned-fixture-version', fullAccess: true, interactiveApprovals: true, resume: true };
  const chats = { setToolBridge: () => {}, manager: { hostAvailability: async () => [capability], provisionHost: async () => assert.fail('A ready fake provider must never install anything.') } } as unknown as ChatController;
  const service = new InspectionService(app, chats);
  let request: () => Promise<NativeReadiness> = async () => mac, probe: () => Promise<NativeReadiness> = async () => mac;
  Object.assign(service.native, {
    readiness: async (platform: string) => { probeCalls++; return platform === 'macos' ? probe() : { status: 'unsupported', reasons: ['No simulator in this fixture.'] }; },
    requestMacPermissions: async () => { requestCalls++; return request(); }, closeTransport: async () => { closeCalls++; },
  });
  const settle = async () => {
    await Promise.allSettled([...operations]);
    const maintenance = (service as unknown as { maintaining?: Promise<void> }).maintaining;
    if (maintenance) await maintenance;
  };
  t.after(async () => {
    for (const controller of controllers) controller.abort(new Error('Fixture stopped.'));
    for (const cleanup of cleanups) cleanup();
    await settle(); await service.close(); store.close(); await rm(directory, { recursive: true, force: true });
  });
  const call = async (method: string, url: string) => {
    const extension = extensions[0]; assert.ok(extension, 'initialize registers the normal inspection endpoint');
    return extension({ method, url: new URL(url, 'http://factory.test'), body: {} });
  };
  const get = async () => (await call('GET', '/api/inspection/readiness') as { executionTargets: ExecutionTargetAdvertisement[] }).executionTargets;
  const post = async (query = '?deviceId=mac') => await call('POST', `/api/inspection/mac-permissions${query}`) as PermissionResponse;
  await service.initialize(); await settle();
  return { app, store, service, events, get, post, settle, calls: () => requestCalls, probes: () => probeCalls, changes: () => changes, closes: () => closeCalls,
    setMac: (value: NativeReadiness) => { mac = value; }, setRequest: (value: () => Promise<NativeReadiness>) => { request = value; }, setProbe: (value: () => Promise<NativeReadiness>) => { probe = value; },
    cleanup: (value: () => void) => { cleanups.push(value); }, revoke: () => { for (const controller of controllers) controller.abort(new Error('Device service operation was revoked.')); } };
}
function macInspection(targets: ExecutionTargetAdvertisement[]) {
  const target = targets.find(target => target.kind === 'host-macos'); assert.ok(target);
  const capability = target.capabilities.find(capability => capability.kind === 'macos-app-inspection'); assert.ok(capability);
  return capability;
}

test('initialization, GET, internal reads and actual maintenance never request Mac permissions', macOnly, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = await fixture(t);
  assert.equal(macInspection(await f.get()).readiness, 'setup-required');
  await f.service.readiness();
  const before = f.probes(); t.mock.timers.tick(30000); await f.settle();
  assert.ok(f.probes() > before, 'The actual registered maintenance timer rechecked native readiness');
  assert.equal(f.calls(), 0, 'No passive path can prompt for OS permissions');
  assert.deepEqual(f.store.list('sessions'), []); assert.deepEqual(f.store.list('chats'), []); assert.deepEqual(f.store.list('attempts'), []);
});

test('a user POST requests once and returns the actual helper result plus freshly probed capabilities', macOnly, async t => {
  const f = await fixture(t), actual = ready();
  assert.equal(macInspection(f.app.device.executionTargets!).readiness, 'setup-required');
  f.setRequest(async () => { f.setMac(actual); return actual; });
  const response = await f.post();
  assert.equal(f.calls(), 1); assert.deepEqual(response.readiness, actual); assert.equal(macInspection(response.executionTargets).readiness, 'ready');
  assert.deepEqual(f.app.device.executionTargets, response.executionTargets);
  assert.equal(macInspection(await f.get()).readiness, 'ready'); assert.equal(f.calls(), 1);
  assert.deepEqual(f.store.list('sessions'), []); assert.deepEqual(f.store.list('inspection-jobs'), []);
});

test('a completed prompt honestly keeps missing GUI permissions setup-required', macOnly, async t => {
  const f = await fixture(t), actual = { ...denied(), accessibility: true, reasons: ['Screen capture permission still requires a restart.'] };
  f.setRequest(async () => { f.setMac(actual); return actual; });
  const response = await f.post(); assert.deepEqual(response.readiness, actual); assert.equal(f.calls(), 1);
  const capability = macInspection(response.executionTargets); assert.equal(capability.readiness, 'setup-required'); assert.match(capability.reason!, /requires a restart/); assert.ok(capability.setupAction);
});

test('held concurrent user POSTs share one permission helper and the same settled result', macOnly, async t => {
  const f = await fixture(t), helper = deferred<NativeReadiness>(), started = deferred<void>();
  f.cleanup(() => helper.resolve(denied())); f.setRequest(async () => { started.resolve(); return helper.promise; });
  const outcomes = Promise.allSettled([f.post(), f.post(), f.post()]); await started.promise;
  assert.equal(f.calls(), 1); assert.equal(macInspection(f.app.device.executionTargets!).readiness, 'setup-required');
  const actual = ready(); f.setMac(actual); helper.resolve(actual);
  const responses = (await outcomes).map(outcome => { if (outcome.status === 'rejected') throw outcome.reason; return outcome.value; });
  assert.equal(f.calls(), 1); assert.ok(responses.every(response => response === responses[0]));
  assert.deepEqual(responses[0]!.readiness, actual); assert.equal(macInspection(responses[0]!.executionTargets).readiness, 'ready');
});

test('helper failure reaches every caller unchanged, passive GET stays honest and a fresh POST retries', macOnly, async t => {
  const f = await fixture(t), helper = deferred<NativeReadiness>(), started = deferred<void>(), failure = new Error('Native permission helper disconnected before returning its result.');
  f.cleanup(() => helper.resolve(denied())); f.setRequest(async () => { started.resolve(); return helper.promise; });
  const requests = [f.post(), f.post()], outcomes = Promise.allSettled(requests); await started.promise; helper.reject(failure);
  for (const outcome of await outcomes) { assert.equal(outcome.status, 'rejected'); if (outcome.status === 'rejected') assert.equal(outcome.reason, failure); }
  assert.equal(f.calls(), 1); const unchanged = macInspection(await f.get()); assert.equal(unchanged.readiness, 'setup-required'); assert.match(unchanged.reason!, /permission are unavailable/); assert.equal(f.calls(), 1);
  f.setRequest(async () => { const actual = ready(); f.setMac(actual); return actual; });
  const retried = await f.post(); assert.equal(f.calls(), 2); assert.equal(retried.readiness.status, 'ready'); assert.equal(macInspection(retried.executionTargets).readiness, 'ready');
});

test('foreign or empty owners and a non-Mac local device reject before the permission helper', macOnly, async t => {
  const f = await fixture(t);
  for (const query of ['?deviceId=foreign', '?deviceId=']) await assert.rejects(f.post(query), error => error instanceof HttpError && error.status === 403);
  f.app.device = { ...f.app.device, platform: 'linux' };
  await assert.rejects(f.post(), error => error instanceof HttpError && error.status === 409);
  assert.equal(f.calls(), 0, 'Rejected requests never reach the OS helper');
  f.app.device = { ...f.app.device, platform: 'darwin' };
  const local = await f.post(''); assert.equal(f.calls(), 1); assert.equal(local.readiness.status, 'setup-required');
});

test('close or revocation prevents a late helper or readiness probe from publishing ready capabilities', macOnly, async t => {
  for (const phase of ['helper', 'readiness'] as const) for (const ending of ['close', 'revoke'] as const) await t.test(`${phase}: ${ending}`, async t => {
    const f = await fixture(t), held = deferred<NativeReadiness>(), started = deferred<void>(), actual = ready();
    f.cleanup(() => held.resolve(actual));
    if (phase === 'helper') f.setRequest(async () => { started.resolve(); const result = await held.promise; f.setMac(result); return result; });
    else { f.setRequest(async () => actual); f.setProbe(async () => { started.resolve(); return held.promise; }); }
    const previousTargets = structuredClone(f.app.device.executionTargets), previousEvents = f.events.length, previousChanges = f.changes();
    const pending = f.post(), rejected = assert.rejects(pending, ending === 'close' ? /closed|closing/ : /revoked/); await started.promise;
    if (ending === 'close') await f.service.close(); else f.revoke();
    held.resolve(actual); await rejected; await f.settle();
    assert.deepEqual(f.app.device.executionTargets, previousTargets); assert.equal(f.events.length, previousEvents); assert.equal(f.changes(), previousChanges);
    assert.deepEqual(f.store.list('inspection-host-setup'), []); assert.deepEqual(f.store.list('sessions'), []);
    if (ending === 'close') { assert.equal(f.closes(), 1); await assert.rejects(f.post(), /closing/); }
    else { f.setProbe(async () => actual); f.setRequest(async () => actual); const retry = await f.post(); assert.equal(retry.readiness.status, 'ready'); assert.equal(macInspection(retry.executionTargets).readiness, 'ready'); }
  });
});
