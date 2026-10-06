import assert from 'node:assert/strict';
import test from 'node:test';
import { finishIdleServiceHandoff, prepareServiceUpdate, type ServiceUpdateStatus } from './service-update.ts';
import type { DeviceConnection } from './service-connection.ts';

const old: DeviceConnection = { url: 'http://127.0.0.1:4317', token: 'inert-test-token', version: '0.1.3' };
const current = { ...old, version: '0.1.5' };

function harness(status: ServiceUpdateStatus | undefined) {
  const calls: string[] = [];
  let running: DeviceConnection | undefined = old;
  let result: DeviceConnection | undefined = current;
  return { calls, running: (connection: DeviceConnection | undefined) => { running = connection; }, accepted: (connection: DeviceConnection | undefined) => { result = connection; }, options: {
    targetVersion: '0.1.5',
    stage: async () => { calls.push('stage'); return '/owned/staged-bundle'; },
    current: async () => { calls.push('current'); return running; },
    inspect: async () => { calls.push('inspect'); return status; },
    replace: async (connection: DeviceConnection, resources: string) => {
      calls.push('replace'); assert.equal(connection, running); assert.equal(resources, '/owned/staged-bundle'); return result;
    },
  } };
}

test('legacy service remains connected while fresh resources stage without any shutdown', async () => {
  const fixture = harness(undefined);
  const result = await prepareServiceUpdate(old, fixture.options);
  assert.equal(result.state, 'deferred');
  assert.equal(result.connection, old);
  assert.deepEqual(fixture.calls, ['stage', 'current', 'inspect']);
});

test('active work defers replacement after staging and stays usable', async () => {
  const fixture = harness({ canUpdate: false, idleShutdown: true, busy: ['An agent turn is running'] });
  const result = await prepareServiceUpdate(old, fixture.options);
  assert.equal(result.state, 'busy');
  assert.match(result.reason!, /agent turn/);
  assert.equal(result.connection, old);
  assert.deepEqual(fixture.calls, ['stage', 'current', 'inspect']);
});

test('atomic shutdown rejection preserves work started after the idle snapshot', async () => {
  const fixture = harness({ canUpdate: true, idleShutdown: true }); fixture.accepted(undefined);
  const result = await prepareServiceUpdate(old, fixture.options);
  assert.equal(result.state, 'busy');
  assert.equal(result.connection, old);
});

test('a supported idle service hands off to the staged bundle', async () => {
  const fixture = harness({ canUpdate: true, idleShutdown: true });
  const result = await prepareServiceUpdate(old, fixture.options);
  assert.equal(result.state, 'updated');
  assert.equal(result.connection, current);
  assert.deepEqual(fixture.calls, ['stage', 'current', 'inspect', 'replace']);
});

test('a newer daemon that appeared during staging is preserved and never downgraded', async () => {
  const fixture = harness({ canUpdate: true, idleShutdown: true });
  const newer = { ...current, version: '0.1.6' }; fixture.running(newer);
  const result = await prepareServiceUpdate(old, fixture.options);
  assert.equal(result.state, 'current');
  assert.equal(result.connection, newer);
  assert.deepEqual(fixture.calls, ['stage', 'current']);
  assert.equal((await prepareServiceUpdate(newer, fixture.options)).state, 'current');
  assert.deepEqual(fixture.calls, ['stage', 'current']);
});

test('a lost shutdown acknowledgement launches the staged service only after confirmed port closure', async () => {
  let time = 0, ports = 0; const calls: string[] = [];
  const result = await finishIdleServiceHandoff({ shutdown: async () => 'unknown', portOpen: async () => { calls.push('port'); return ++ports < 3; },
    current: async () => old, closePreview: async () => { calls.push('preview'); }, start: async () => { calls.push('start'); return current; },
    now: () => time, wait: async milliseconds => { time += milliseconds; } });
  assert.equal(result, current);
  assert.deepEqual(calls, ['port', 'port', 'port', 'preview', 'start']);
});

test('a busy atomic guard never closes previews or starts a replacement', async () => {
  const unexpected = async () => assert.fail('Busy work must remain connected');
  assert.equal(await finishIdleServiceHandoff({ shutdown: async () => 'busy', portOpen: unexpected, current: unexpected, closePreview: unexpected, start: unexpected }), undefined);
});

test('an unknown shutdown outcome preserves a healthy service that remains reachable', async () => {
  let time = 0;
  const result = await finishIdleServiceHandoff({ shutdown: async () => 'unknown', portOpen: async () => true, current: async () => old,
    closePreview: async () => assert.fail('The original preview stays connected'), start: async () => assert.fail('A reachable service cannot be duplicated'),
    timeoutMs: 500, now: () => time, wait: async milliseconds => { time += milliseconds; } });
  assert.equal(result, old);
});
