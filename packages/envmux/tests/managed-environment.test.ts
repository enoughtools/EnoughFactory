import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EnvmuxEngine } from '../src/index.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const nativePlatform = process.platform === 'darwin' ? 'osx' : process.platform;
const binary = join(repository, 'artifacts/envmux', `${nativePlatform}-${process.arch}`, 'envmux');
const cliPath = join(repository, '.cache/container-runtime', `${process.platform}-${process.arch}`, 'docker/bin/docker');

test('adapter detection ignores inherited TLS and contacts only its explicit owned socket', {
  skip: !existsSync(binary) || !existsSync(cliPath) ? 'Prepare the bundled native engine and container CLI first' : false,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ef-tls-'));
  const socket = join(directory, 'owned.sock');
  const keys = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH', 'DOCKER_API_VERSION', 'DOCKER_CUSTOM_HEADERS', 'DOCKER_AUTH_CONFIG', 'BUILDKIT_HOST'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'user-runtime-value';
    process.env.DOCKER_TLS = '1'; process.env.DOCKER_TLS_VERIFY = '1';
    const engine = new EnvmuxEngine({ binary, dockerRuntime: {
      host: `unix://${socket}`, cliPath, configDirectory: join(directory, 'private-config'),
    } });
    const detected = await engine.detect();
    assert.equal(detected.available, true, detected.error);
    assert.equal(detected.docker.available, false, 'No daemon was started for this isolated boundary check');
    assert.ok(detected.docker.error?.includes(socket), detected.docker.error);
    assert.doesNotMatch(detected.docker.error ?? '', /ca\.pem|TLS handshake|certificate verification/i);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
