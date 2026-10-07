import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { SWIFT_TOOLCHAIN, TOOLCHAIN_IMAGE_LABELS, prepareToolchainWith, validatePreparedToolchain, type ToolchainDockerRunner } from '../src/swift.ts';

const imageId = `sha256:${'a'.repeat(64)}`;
const endpoint = (name: string) => ({ host: `unix:///owned-${name}/docker.sock`, cliPath: '/owned/docker', configDirectory: '/owned/config' });
const metadata = () => ({ ...SWIFT_TOOLCHAIN, image: imageId, platform: 'linux/amd64' });
const inspected = (labels = true) => ({ Id: imageId, Architecture: 'amd64', Os: 'linux', Config: { Labels: labels ? { [TOOLCHAIN_IMAGE_LABELS.id]: SWIFT_TOOLCHAIN.id, [TOOLCHAIN_IMAGE_LABELS.recipe]: SWIFT_TOOLCHAIN.recipeSha256, [TOOLCHAIN_IMAGE_LABELS.managed]: 'true' } : {} } });
const result = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });

test('frozen metadata accepts only the shipped recipe and immutable supported image identity', () => {
  assert.equal(validatePreparedToolchain(metadata()).image, imageId);
  for (const patch of [{ id: 'arbitrary' }, { recipeSha256: '0'.repeat(64) }, { baseImage: 'swift:latest' }, { platform: 'linux/riscv64' }, { image: 'swift:6.0.3' }, { swiftVersion: '6.4' }, { nodeVersion: '24.0.0' }]) assert.throws(() => validatePreparedToolchain({ ...metadata(), ...patch }));
});

test('a cached image with unrelated labels cannot become the advertised Swift toolchain', async () => {
  const calls: readonly string[][] = [];
  const run: ToolchainDockerRunner = async (_endpoint, args) => {
    (calls as string[][]).push([...args]);
    return args[0] === 'info' ? result(JSON.stringify({ OSType: 'linux', Architecture: 'amd64' })) : result(JSON.stringify([inspected(false)]));
  };
  await assert.rejects(prepareToolchainWith(endpoint('foreign'), SWIFT_TOOLCHAIN.id, {}, run), /does not match/);
  assert.deepEqual(calls.map(args => args[0]), ['info', 'image']);
});

test('concurrent preparation uses daemon architecture and a clean image instead of author state', async () => {
  const calls: string[][] = [];
  let built = false, contextPath = '';
  const run: ToolchainDockerRunner = async (owned, args) => {
    assert.equal(owned.host, endpoint('shared').host); calls.push([...args]);
    if (args[0] === 'info') return result(JSON.stringify({ OSType: 'linux', Architecture: 'x86_64' }));
    if (args[0] === 'image') return built ? result(JSON.stringify([inspected()])) : result('', 1, 'Error response from daemon: No such image');
    if (args[0] === 'build') {
      assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64');
      contextPath = args.at(-1)!;
      const dockerfile = await readFile(join(contextPath, 'Dockerfile'), 'utf8');
      assert.ok(dockerfile.startsWith(`FROM ${SWIFT_TOOLCHAIN.baseImage}\n`));
      assert.match(dockerfile, /node-v22\.22\.0-linux-/);
      assert.match(dockerfile, /\/etc\/profile\.d\/enoughfactory-toolchains\.sh/);
      assert.match(dockerfile, /PATH=\/opt\/enoughfactory\/node\/bin:\/usr\/local\/swift\/usr\/bin:/);
      built = true; return result();
    }
    if (args[0] === 'run') {
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      assert.equal(args[args.indexOf('--entrypoint') + 1], '/bin/bash');
      assert.ok(args.includes(imageId)); assert.ok(args.includes('-lc'));
      return result(JSON.stringify({ nodeVersion: '22.22.0', swiftVersion: '6.0.3' }));
    }
    return result();
  };
  const [one, two] = await Promise.all([prepareToolchainWith(endpoint('shared'), SWIFT_TOOLCHAIN.id, {}, run), prepareToolchainWith(endpoint('shared'), SWIFT_TOOLCHAIN.id, {}, run)]);
  assert.deepEqual(one, two); assert.equal(one.platform, 'linux/amd64');
  assert.equal(calls.filter(args => args[0] === 'build').length, 1);
  assert.equal(calls.filter(args => args[0] === 'run').length, 1);
  assert.equal(calls.some(args => ['commit', 'exec', 'cp'].includes(args[0])), false);
  await assert.rejects(access(contextPath));
});

test('failed login-shell verification removes only its probe and never returns ready metadata', async () => {
  const calls: string[][] = [];
  const run: ToolchainDockerRunner = async (_endpoint, args) => {
    calls.push([...args]);
    if (args[0] === 'info') return result(JSON.stringify({ OSType: 'linux', Architecture: 'amd64' }));
    if (args[0] === 'image') return result(JSON.stringify([inspected()]));
    if (args[0] === 'run') return result('', 1, 'node: command not found');
    return result();
  };
  await assert.rejects(prepareToolchainWith(endpoint('failed-login'), SWIFT_TOOLCHAIN.id, {}, run), /node: command not found/);
  const cleanup = calls.find(args => args[0] === 'rm');
  assert.deepEqual(cleanup?.slice(0, 2), ['rm', '--force']);
  assert.match(cleanup?.[2] ?? '', /^enough-toolchain-probe-/);
  assert.equal(calls.some(args => args[0] === 'build'), false);
});
