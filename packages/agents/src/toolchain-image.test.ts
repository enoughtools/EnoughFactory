import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_TOOLCHAIN_LABELS, agentToolchainRecipe, prepareAgentToolchainWith, type AgentToolchainRunner } from './toolchain-image.ts';
import { RUNTIME_PINS } from './types.ts';

const baseImage = `sha256:${'a'.repeat(64)}`, otherBase = `sha256:${'b'.repeat(64)}`;
const result = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
type Image = { Id: string; Architecture: string; Os: string; Config: { Labels: Record<string, string> } };

/** Model only image storage and clean probes; an unexpected container/auth action fails. */
function fixture() {
  const state = `/owned/agent-image-test-${randomUUID()}`;
  const endpoint = { host: `unix://${state}/docker.sock`, cliPath: `${state}/docker`, configDirectory: `${state}/docker/config` };
  const owner = createHash('sha256').update(state).digest('hex').slice(0, 24);
  const images = new Map<string, Image>();
  for (const id of [baseImage, otherBase]) images.set(id, { Id: id, Architecture: 'arm64', Os: 'linux', Config: { Labels: {} } });
  const calls: string[][] = [], contexts: string[] = [], probes = new Set<string>();
  let failBuild = false;
  const run: AgentToolchainRunner = async (owned, args) => {
    assert.deepEqual(owned, endpoint); calls.push([...args]);
    if (args[0] === 'info') return result(JSON.stringify({ OSType: 'linux', Architecture: 'aarch64', Labels: ['enoughfactory.managed=true', `enoughfactory.owner=${owner}`] }));
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = images.get(args[2]!);
      return image ? result(JSON.stringify([image])) : result('', 1, 'No such image');
    }
    if (args[0] === 'build') {
      const context = args.at(-1)!; contexts.push(context);
      assert.deepEqual((await readdir(context)).sort(), ['Dockerfile', 'image-toolchain.json', 'install.sh', 'verify.sh']);
      const dockerfile = await readFile(join(context, 'Dockerfile'), 'utf8');
      const receipt = JSON.parse(await readFile(join(context, 'image-toolchain.json'), 'utf8'));
      assert.ok([baseImage, otherBase].includes(receipt.baseImage));
      assert.ok(dockerfile.startsWith(`FROM ${receipt.baseImage}\n`));
      assert.equal(args[args.indexOf('--platform') + 1], 'linux/arm64');
      assert.ok(args.includes('--pull=false'));
      if (failBuild) { failBuild = false; return result('', 1, 'simulated provider transfer failed'); }
      const labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) if (args[i] === '--label') {
        const label = args[++i]!, equal = label.indexOf('='); labels[label.slice(0, equal)] = label.slice(equal + 1);
      }
      const image = { Id: `sha256:${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}`, Architecture: 'arm64', Os: 'linux', Config: { Labels: labels } };
      images.set(args[args.indexOf('--tag') + 1]!, image); images.set(image.Id, image);
      return result();
    }
    if (args[0] === 'run') {
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      assert.equal(args[args.indexOf('--entrypoint') + 1], '/bin/bash');
      assert.ok(args.some(arg => images.has(arg) && arg.startsWith('sha256:')));
      assert.equal(args.some(arg => ['--mount', '--volume', '-v', '--env', '-e', '--env-file'].includes(arg)), false);
      const name = args[args.indexOf('--name') + 1]!;
      assert.match(name, /^enough-agent-tools-probe-/); probes.add(name);
      return result();
    }
    if (args[0] === 'rm') {
      assert.equal(args[1], '--force'); assert.equal(args.length, 3);
      assert.ok(probes.delete(args[2]!), 'Only the disposable probe can be removed');
      return result();
    }
    assert.fail(`Unexpected Docker operation: ${args[0]}`);
  };
  return {
    endpoint, run, calls, contexts, images,
    failNextBuild() { failBuild = true; },
    async assertClean() {
      assert.equal(probes.size, 0);
      for (const context of contexts) await assert.rejects(access(context), { code: 'ENOENT' });
    },
  };
}

test('concurrent preparation shares one immutable image and separates different bases and providers', async () => {
  const context = fixture();
  const prepare = (base = baseImage, runtime: 'codex' | 'claude' = 'codex') => prepareAgentToolchainWith(context.endpoint, base, runtime, {}, context.run);
  const [one, two] = await Promise.all([prepare(), prepare()]);
  assert.deepEqual(one, two); assert.match(one.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(one.providerVersion, RUNTIME_PINS.codex); assert.equal(one.nodeVersion, RUNTIME_PINS.node);
  assert.deepEqual(await prepare(), one);
  assert.equal(context.calls.filter(args => args[0] === 'build').length, 1);
  assert.equal(context.calls.filter(args => args[0] === 'run').length, 1);
  const other = await prepare(otherBase), claude = await prepare(baseImage, 'claude');
  assert.equal(new Set([one.image, other.image, claude.image]).size, 3);
  assert.equal(new Set([one.recipeSha256, other.recipeSha256, claude.recipeSha256]).size, 3);
  assert.equal(other.baseImage, otherBase); assert.equal(claude.providerVersion, RUNTIME_PINS.claude);
  assert.equal(context.calls.filter(args => args[0] === 'build').length, 3);
  await context.assertClean();
});

test('a cached tag cannot substitute a different base or provider pin', async () => {
  for (const [label, wrong] of [[AGENT_TOOLCHAIN_LABELS.base, otherBase], [AGENT_TOOLCHAIN_LABELS.provider, 'untrusted-version']]) {
    const context = fixture(), recipe = agentToolchainRecipe(baseImage, 'codex', 'linux/arm64');
    const labels = { [AGENT_TOOLCHAIN_LABELS.managed]: 'true', [AGENT_TOOLCHAIN_LABELS.recipe]: recipe.recipeSha256, [AGENT_TOOLCHAIN_LABELS.base]: baseImage, [AGENT_TOOLCHAIN_LABELS.runtime]: 'codex', [AGENT_TOOLCHAIN_LABELS.node]: RUNTIME_PINS.node, [AGENT_TOOLCHAIN_LABELS.provider]: RUNTIME_PINS.codex, [label!]: wrong! };
    context.images.set(`enoughfactory-agent-tools:codex-${recipe.recipeSha256.slice(0, 32)}`, { Id: `sha256:${'c'.repeat(64)}`, Architecture: 'arm64', Os: 'linux', Config: { Labels: labels } });
    await assert.rejects(prepareAgentToolchainWith(context.endpoint, baseImage, 'codex', {}, context.run), /does not match its immutable base, architecture and pinned tools/);
    assert.equal(context.calls.some(args => ['build', 'run', 'rm'].includes(args[0]!)), false);
    await context.assertClean();
  }
});

test('a failed shared build releases its inflight entry and clean context before retry', async () => {
  const context = fixture(); context.failNextBuild();
  const prepare = () => prepareAgentToolchainWith(context.endpoint, baseImage, 'codex', {}, context.run);
  const failed = await Promise.allSettled([prepare(), prepare()]);
  assert.equal(failed.every(item => item.status === 'rejected' && /simulated provider transfer failed/.test(item.reason.message)), true);
  assert.equal(context.calls.filter(args => args[0] === 'build').length, 1);
  assert.equal(context.calls.some(args => args[0] === 'run'), false);
  await context.assertClean();
  const prepared = await prepare();
  assert.equal(prepared.baseImage, baseImage); assert.equal(prepared.providerVersion, RUNTIME_PINS.codex);
  assert.equal(context.calls.filter(args => args[0] === 'build').length, 2);
  assert.equal(new Set(context.contexts).size, 2);
  assert.equal(context.calls.filter(args => args[0] === 'run').length, 1);
  await context.assertClean();
});
