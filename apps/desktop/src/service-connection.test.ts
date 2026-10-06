import assert from 'node:assert/strict';
import test from 'node:test';
import { compatibleServiceVersions, connectExistingService, probeDeviceConnection, serviceUpgradeNeeded } from './service-connection.ts';

const connection = { url: 'http://127.0.0.1:4317', token: 'inert-test-token' };
const runtime = { kind: 'lima', stateDirectory: '/owned/factory', socketPath: '/owned/factory/container/lima/factory/sock/docker.sock' };
const options = { serviceVersion: '0.1.5', stateDirectory: runtime.stateDirectory };
const health = { ok: true, product: 'EnoughFactory', version: options.serviceVersion };

function requests(responses: Record<string, unknown>) {
  const paths: string[] = [];
  const request: typeof fetch = async (input, init) => {
    assert.equal((init?.headers as { Authorization: string }).Authorization, `Bearer ${connection.token}`);
    const path = new URL(String(input)).pathname;
    paths.push(path);
    assert.ok(Object.hasOwn(responses, path), `Connection unexpectedly requested ${path}`);
    return Response.json(responses[path]);
  };
  return { paths, request };
}

test('healthy service connects while its private VM is waking, without probing container commands', async () => {
  const calls = requests({ '/api/health': { ...health, runtime } });
  assert.deepEqual(await probeDeviceConnection(connection, { ...options, request: calls.request }), { ...connection, version: health.version });
  assert.deepEqual(calls.paths, ['/api/health']);
});

test('legacy service uses retained runtime identity instead of waiting on Docker status', async () => {
  const calls = requests({ '/api/health': health, '/api/state': { diagnostics: { containerRuntime: { ...runtime, state: 'failed', error: 'VM is resuming' } } } });
  assert.deepEqual(await probeDeviceConnection(connection, { ...options, request: calls.request }), { ...connection, version: health.version });
  assert.deepEqual(calls.paths, ['/api/health', '/api/state']);
});

test('incompatible service and an unowned runtime retain explicit update fences', async () => {
  const old = requests({ '/api/health': { ...health, version: '0.2.0', runtime } });
  await assert.rejects(probeDeviceConnection(connection, { ...options, request: old.request }), /\[DEVICE_SERVICE_UPDATE_REQUIRED\]/);
  assert.deepEqual(old.paths, ['/api/health']);
  for (const invalid of [{ ...runtime, socketPath: '/var/run/docker.sock' }, { ...runtime, stateDirectory: '/other/installation' }, { ...runtime, kind: 'external' }]) {
    const calls = requests({ '/api/health': { ...health, runtime: invalid } });
    await assert.rejects(probeDeviceConnection(connection, { ...options, request: calls.request }), /\[DEVICE_SERVICE_UPDATE_REQUIRED\]/);
  }
});

test('explicit service update can inspect healthy prior versions without VM ownership probes', async () => {
  const calls = requests({ '/api/health': { ...health, version: '0.1.3' } });
  assert.deepEqual(await probeDeviceConnection(connection, { ...options, requireManagedRuntime: false, request: calls.request }), { ...connection, version: '0.1.3' });
  assert.deepEqual(calls.paths, ['/api/health']);
});

test('a transient timeout reuses the existing daemon after it wakes', async () => {
  let probes = 0, time = 0;
  const ready = await connectExistingService({ readConnection: () => connection, probe: async () => ++probes === 3 ? connection : undefined,
    portOpen: async () => true, now: () => time, wait: async milliseconds => { time += milliseconds; } });
  assert.equal(ready, connection);
  assert.equal(probes, 3);
});

test('a reachable unresponsive service cannot authorize a duplicate daemon', async () => {
  let time = 0;
  await assert.rejects(connectExistingService({ readConnection: () => connection, probe: async () => undefined, portOpen: async () => true,
    timeoutMs: 500, now: () => time, wait: async milliseconds => { time += milliseconds; } }), /existing device service is still reconnecting/);
});

test('a confirmed closed service port allows a replacement to start', async () => {
  assert.equal(await connectExistingService({ readConnection: () => connection, probe: async () => undefined, portOpen: async () => false }), undefined);
});

test('compatible patch releases connect immediately and report the running service version', async () => {
  for (const version of ['0.1.3', '0.1.5', '0.1.6']) {
    const calls = requests({ '/api/health': { ...health, version, runtime } });
    assert.deepEqual(await probeDeviceConnection(connection, { ...options, request: calls.request }), { ...connection, version });
    assert.deepEqual(calls.paths, ['/api/health']);
  }
  assert.ok(compatibleServiceVersions('0.1.3', '0.1.5'));
  assert.equal(compatibleServiceVersions('0.2.0', '0.1.5'), false);
  assert.equal(compatibleServiceVersions('unknown', '0.1.5'), false);
  assert.ok(serviceUpgradeNeeded('0.1.3', '0.1.5'));
  assert.equal(serviceUpgradeNeeded('0.1.5', '0.1.3'), false, 'an older app must never downgrade its newer service');
  assert.equal(serviceUpgradeNeeded('0.1.5', '0.1.5'), false);
});
