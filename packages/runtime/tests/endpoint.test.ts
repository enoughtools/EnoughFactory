import test from 'node:test';
import assert from 'node:assert/strict';
import { dockerInvocation } from '../src/docker.ts';
import { ManagedRuntimeManager } from '../src/manager.ts';

test('all Docker calls pin the owned endpoint and remove inherited context and credentials', () => {
  const keys = ['DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'DOCKER_AUTH_CONFIG', 'DOCKER_BUILDKIT'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'user-runtime-value';
    const call = dockerInvocation({ host: 'unix:///owned/docker.sock', cliPath: '/owned/bin/docker', configDirectory: '/owned/config' }, ['exec', 'factory', 'id']);
    assert.equal(call.command, '/owned/bin/docker');
    assert.deepEqual(call.args, ['--host', 'unix:///owned/docker.sock', '--config', '/owned/config', 'exec', 'factory', 'id']);
    assert.equal(call.env.DOCKER_HOST, 'unix:///owned/docker.sock'); assert.equal(call.env.DOCKER_CONFIG, '/owned/config');
    for (const key of keys.filter(key => key !== 'DOCKER_BUILDKIT')) assert.equal(call.env[key], undefined, key);
    assert.equal(call.env.DOCKER_BUILDKIT, '0');
  } finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('no remote or ambiguous runtime is inferred', () => {
  for (const host of ['tcp://localhost:2375', 'npipe:////pipe/docker_engine', '', 'unix://relative.sock']) assert.throws(() => dockerInvocation({ host, cliPath: '/owned/docker', configDirectory: '/owned/config' }, ['info']));
});

test('a long Mac data directory keeps its private socket short and stable', { skip: process.platform !== 'darwin' }, () => {
  const options = { dataDir: `/private/var/folders/${'a'.repeat(100)}/EnoughFactory`, resourcesDirectory: '/owned/resources' };
  const one = new ManagedRuntimeManager(options); const two = new ManagedRuntimeManager(options);
  assert.equal(one.endpoint.host, two.endpoint.host);
  assert.match(one.endpoint.host, /^unix:\/\/\/Users\/Shared\/\.enoughfactory-runtime-/);
  assert.ok(Buffer.byteLength(one.endpoint.host.slice(7)) <= 100);
});
