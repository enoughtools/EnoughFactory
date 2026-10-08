import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BROWSER_IMAGE_LABELS, BROWSER_MCP_COMMAND, browserImageRecipe, browserMcpArguments,
  prepareBrowserImageWith, verifyBrowserImageWith, type BrowserImageRunner,
} from '../src/image.ts';
import { BROWSER_IMAGE_PATHS, BROWSER_PINS, type BrowserImagePlatform } from '../src/pins.ts';

type Image = { Id: string; Architecture: string; Os: string; Config?: { User: string; Entrypoint: string[]; Labels: Record<string, string> } };
const result = (stdout = '', code = 0, stderr = '') => ({ stdout, code, stderr });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

function gatedPull(run: BrowserImageRunner, delayedCancellation = false) {
  const entered = deferred(), release = deferred(), cancellation = deferred(), cleanup = deferred();
  let first = true, sharedSignal: AbortSignal | undefined, pullCalls = 0;
  const gated: BrowserImageRunner = async (endpoint, args, options) => {
    if (args[0] === 'pull') {
      pullCalls++;
      if (first) {
        first = false; sharedSignal = options.signal; entered.resolve();
        let aborted!: () => void;
        const interrupted = new Promise<void>((_, reject) => {
          aborted = () => {
            cancellation.resolve();
            if (delayedCancellation) cleanup.promise.then(() => reject(options.signal!.reason));
            else reject(options.signal!.reason);
          };
          options.signal?.addEventListener('abort', aborted, { once: true });
          if (options.signal?.aborted) aborted();
        });
        try { await Promise.race([release.promise, interrupted]); }
        finally { options.signal?.removeEventListener('abort', aborted); }
      }
    }
    return run(endpoint, args, options);
  };
  return { run: gated, entered: entered.promise, release: release.resolve, cancellation: cancellation.promise, completeCleanup: cleanup.resolve, get sharedSignal() { return sharedSignal; }, get pullCalls() { return pullCalls; } };
}

function fixture(selectedPlatform: BrowserImagePlatform = 'linux/arm64') {
  const root = `/owned/browser-image-test-${randomUUID()}`;
  const endpoint = { host: `unix://${root}/docker.sock`, cliPath: `${root}/docker`, configDirectory: `${root}/docker/config` };
  const owner = createHash('sha256').update(root).digest('hex').slice(0, 24), recipe = browserImageRecipe(selectedPlatform);
  const images = new Map<string, Image>(), calls: string[][] = [], contexts: string[] = [], probes = new Set<string>();
  let owned = true, buildFailure = false, probeFailure = false, invalidEvidence = false, probeAbort: AbortController | undefined;
  const run: BrowserImageRunner = async (ownedEndpoint, args, options) => {
    assert.deepEqual(ownedEndpoint, endpoint); calls.push([...args]);
    if (args[0] === 'info') return result(JSON.stringify({ OSType: 'linux', Architecture: selectedPlatform.split('/')[1], Labels: owned ? ['enoughfactory.managed=true', `enoughfactory.owner=${owner}`] : ['enoughfactory.managed=true', 'enoughfactory.owner=another-installation'] }));
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = images.get(args[2]!);
      return image ? result(JSON.stringify([image])) : result('', 1, 'No such image');
    }
    if (args[0] === 'pull') {
      assert.deepEqual([...args], ['pull', '--platform', selectedPlatform, recipe.baseImage]);
      assert.match(recipe.baseImage, /@sha256:[a-f0-9]{64}$/);
      images.set(recipe.baseImage, { Id: BROWSER_PINS.architectures[selectedPlatform].config, Architecture: selectedPlatform.split('/')[1]!, Os: 'linux' });
      return result();
    }
    if (args[0] === 'build') {
      const context = args.at(-1)!; contexts.push(context);
      assert.deepEqual((await readdir(context)).sort(), ['Dockerfile', 'image-toolchain.json', 'upstream-browsers.json', 'upstream-package-lock.json', 'verify.cjs']);
      assert.equal(await readFile(join(context, 'Dockerfile'), 'utf8'), recipe.dockerfile);
      assert.deepEqual(JSON.parse(await readFile(join(context, 'image-toolchain.json'), 'utf8')), recipe.receipt);
      assert.equal(args[args.indexOf('--network') + 1], 'none'); assert.ok(args.includes('--pull=false'));
      assert.equal(args[args.indexOf('--platform') + 1], selectedPlatform);
      if (buildFailure) { buildFailure = false; return result('', 1, 'simulated interrupted browser build'); }
      const labels: Record<string, string> = {};
      for (let i = 0; i < args.length; i++) if (args[i] === '--label') {
        const label = args[++i]!, equal = label.indexOf('='); labels[label.slice(0, equal)] = label.slice(equal + 1);
      }
      const image: Image = { Id: `sha256:${recipe.recipeSha256}`, Architecture: selectedPlatform.split('/')[1]!, Os: 'linux', Config: { User: 'node', Entrypoint: [...BROWSER_MCP_COMMAND], Labels: labels } };
      images.set(args[args.indexOf('--tag') + 1]!, image); images.set(image.Id, image); return result();
    }
    if (args[0] === 'run') {
      assert.equal(args[args.indexOf('--network') + 1], 'none');
      assert.ok(args.includes('--read-only')); assert.ok(args.includes('--init'));
      assert.equal(args[args.indexOf('--entrypoint') + 1], BROWSER_IMAGE_PATHS.node);
      assert.equal(args.at(-1), BROWSER_IMAGE_PATHS.verifier);
      assert.equal(args.some(arg => ['--mount', '--volume', '-v', '-e', '--env-file', '--publish', '-p', '--privileged'].includes(arg)), false);
      const environment = args.flatMap((arg, i) => arg === '--env' ? [args[i + 1]] : []);
      assert.deepEqual(environment, ['XDG_CONFIG_HOME=/tmp/config', 'XDG_CACHE_HOME=/tmp/cache'], 'Readonly browser probes require disposable writable crashpad/config paths without inheriting personal HOME');
      const name = args[args.indexOf('--name') + 1]!; assert.match(name, /^enough-browser-tools-probe-/); probes.add(name);
      if (probeAbort) { probeAbort.abort(); options.signal?.throwIfAborted(); }
      if (probeFailure) { probeFailure = false; return result('', 1, 'Chromium executable failed'); }
      return result(JSON.stringify({ playwrightVersion: recipe.playwrightVersion, mcpVersion: recipe.mcpVersion, executablePath: recipe.executablePath, chromiumVersion: recipe.chromiumVersion, screenshotBytes: invalidEvidence ? 0 : 500 }));
    }
    if (args[0] === 'rm') {
      assert.equal(args[1], '--force'); assert.equal(args.length, 3); assert.ok(probes.delete(args[2]!), 'Only this operation’s disposable browser probe can be removed');
      assert.equal(options.signal, undefined, 'Aborted preparation cannot prevent ownership cleanup');
      return result('', 1, 'No such container');
    }
    assert.fail(`Unexpected Docker operation ${args[0]}`);
  };
  return {
    endpoint, recipe, images, calls, contexts, probes, run,
    rejectOwner() { owned = false; }, failNextBuild() { buildFailure = true; }, failNextProbe() { probeFailure = true; },
    returnInvalidEvidence() { invalidEvidence = true; }, abortProbe(controller: AbortController) { probeAbort = controller; },
    async assertClean() { assert.equal(probes.size, 0); for (const context of contexts) await assert.rejects(access(context), { code: 'ENOENT' }); },
  };
}

test('both architecture recipes pin the publisher image, package lock and Chromium revision', async () => {
  const lock = await readFile(new URL('../src/image-assets/upstream-package-lock.json', import.meta.url));
  const browsers = await readFile(new URL('../src/image-assets/upstream-browsers.json', import.meta.url));
  assert.equal(createHash('sha256').update(lock).digest('hex'), BROWSER_PINS.upstreamLockSha256);
  assert.equal(createHash('sha256').update(browsers).digest('hex'), BROWSER_PINS.upstreamBrowsersSha256);
  const recipes = ['linux/arm64', 'linux/amd64'].map(value => browserImageRecipe(value as BrowserImagePlatform));
  assert.notEqual(recipes[0]!.recipeSha256, recipes[1]!.recipeSha256);
  for (const recipe of recipes) {
    assert.match(recipe.baseImage, /^mcr\.microsoft\.com\/playwright\/mcp@sha256:[a-f0-9]{64}$/);
    assert.equal(recipe.dockerfile.includes('npm install'), false); assert.equal(recipe.dockerfile.includes('apt-get'), false);
    assert.match(recipe.dockerfile, /chown node:node \/output/);
    assert.match(recipe.verificationScript, /page\.screenshot\(\)/);
    assert.equal(JSON.parse(recipe.lockText).packages['node_modules/playwright-core'].version, recipe.playwrightVersion);
    assert.equal(JSON.parse(recipe.browsersText).browsers.find((browser: { name: string }) => browser.name === 'chromium').revision, recipe.browserRevision);
  }
});

test('concurrent callers prepare one reusable browser image and one genuine page probe', async () => {
  for (const selectedPlatform of ['linux/arm64', 'linux/amd64'] as const) {
    const f = fixture(selectedPlatform), prepare = () => prepareBrowserImageWith(f.endpoint, {}, f.run);
    const [one, two] = await Promise.all([prepare(), prepare()]); assert.deepEqual(one, two);
    assert.deepEqual(await prepare(), one); assert.deepEqual(await verifyBrowserImageWith(f.endpoint, one, {}, f.run), one);
    assert.equal(f.calls.filter(args => args[0] === 'pull').length, 1);
    assert.equal(f.calls.filter(args => args[0] === 'build').length, 1);
    assert.equal(f.calls.filter(args => args[0] === 'run').length, 1);
    await f.assertClean();
  }
});

test('a different installation’s private engine fails before downloads or execution', async () => {
  const f = fixture(); f.rejectOwner();
  await assert.rejects(prepareBrowserImageWith(f.endpoint, {}, f.run), /this EnoughFactory installation/);
  assert.deepEqual(f.calls.map(args => args[0]), ['info']); await f.assertClean();
});

test('mutable or mismatched image metadata cannot satisfy a cached browser recipe', async () => {
  const f = fixture(), saved = await prepareBrowserImageWith(f.endpoint, {}, f.run), stored = f.images.get(saved.image)!;
  stored.Config!.Labels[BROWSER_IMAGE_LABELS.mcp] = 'unexpected';
  await assert.rejects(verifyBrowserImageWith(f.endpoint, saved, {}, f.run), /cached browser image does not match/);
  stored.Config!.Labels[BROWSER_IMAGE_LABELS.mcp] = saved.mcpVersion;
  await assert.rejects(verifyBrowserImageWith(f.endpoint, { ...saved, browserRevision: '9999' }, {}, f.run), /saved browser image does not match/);
  f.images.delete(saved.image);
  await assert.rejects(verifyBrowserImageWith(f.endpoint, saved, {}, f.run), /browser image is missing/);
  await f.assertClean();
});

test('interrupted preparation releases its shared operation and scratch context before retry', async () => {
  const f = fixture(); f.failNextBuild(); const prepare = () => prepareBrowserImageWith(f.endpoint, {}, f.run);
  const failed = await Promise.allSettled([prepare(), prepare()]);
  assert.ok(failed.every(item => item.status === 'rejected' && /simulated interrupted/.test(item.reason.message)));
  assert.equal(f.calls.some(args => args[0] === 'run'), false); await f.assertClean();
  const prepared = await prepare(); assert.equal(prepared.browserRevision, BROWSER_PINS.browserRevision);
  assert.equal(f.calls.filter(args => args[0] === 'pull').length, 1, 'The valid pinned base can be reused');
  assert.equal(f.calls.filter(args => args[0] === 'build').length, 2);
  assert.equal(new Set(f.contexts).size, 2); await f.assertClean();
});

test('failed or canceled real-browser probes are cleaned and do not mark the image ready', async () => {
  const failed = fixture(); failed.failNextProbe();
  await assert.rejects(prepareBrowserImageWith(failed.endpoint, {}, failed.run), /Chromium executable failed/);
  await failed.assertClean(); await prepareBrowserImageWith(failed.endpoint, {}, failed.run);
  assert.equal(failed.calls.filter(args => args[0] === 'run').length, 2);
  assert.equal(failed.calls.filter(args => args[0] === 'build').length, 1); await failed.assertClean();
  const canceled = fixture(), controller = new AbortController(); canceled.abortProbe(controller);
  await assert.rejects(prepareBrowserImageWith(canceled.endpoint, { signal: controller.signal }, canceled.run), { name: 'AbortError' });
  // A replacement waits for the canceled probe's cleanup, then verifies the cached image.
  await prepareBrowserImageWith(canceled.endpoint, {}, canceled.run);
  await canceled.assertClean();
});

test('canceling the first caller leaves another caller’s shared cold preparation running', { timeout: 2_000 }, async () => {
  const f = fixture(), gate = gatedPull(f.run), controller = new AbortController();
  const firstProgress: string[] = [], remainingProgress: string[] = [];
  const first = prepareBrowserImageWith(f.endpoint, { signal: controller.signal, onProgress: message => firstProgress.push(message) }, gate.run);
  const remaining = prepareBrowserImageWith(f.endpoint, { onProgress: message => remainingProgress.push(message) }, gate.run);
  await gate.entered;
  const rejected = assert.rejects(first, { name: 'AbortError' }); controller.abort(); await rejected;
  const canceledProgressCount = firstProgress.length;
  assert.equal(gate.sharedSignal?.aborted, false, 'The service-owned operation is independent of the first caller');
  gate.release(); const prepared = await remaining;
  assert.equal(prepared.browserRevision, BROWSER_PINS.browserRevision); assert.equal(gate.pullCalls, 1);
  assert.equal(firstProgress.length, canceledProgressCount, 'Canceled callers stop receiving progress');
  assert.ok(remainingProgress.includes('Shared browser tools are ready')); await f.assertClean();
});

test('a joining caller can cancel promptly while the original caller continues downloading', { timeout: 2_000 }, async () => {
  const f = fixture(), gate = gatedPull(f.run), controller = new AbortController();
  const original = prepareBrowserImageWith(f.endpoint, {}, gate.run);
  await gate.entered;
  const joining = prepareBrowserImageWith(f.endpoint, { signal: controller.signal }, gate.run);
  const rejected = assert.rejects(joining, { name: 'AbortError' }); controller.abort(); await rejected;
  assert.equal(gate.sharedSignal?.aborted, false);
  gate.release(); await original; assert.equal(gate.pullCalls, 1); await f.assertClean();
});

test('the last canceled waiter aborts tooling and replacement waits for confirmed cleanup', { timeout: 2_000 }, async () => {
  const f = fixture(), gate = gatedPull(f.run, true), controller = new AbortController();
  const canceled = prepareBrowserImageWith(f.endpoint, { signal: controller.signal }, gate.run);
  await gate.entered;
  const rejected = assert.rejects(canceled, { name: 'AbortError' }); controller.abort(); await rejected;
  await gate.cancellation; assert.equal(gate.sharedSignal?.aborted, true);
  let replacementReady = false;
  const replacement = prepareBrowserImageWith(f.endpoint, {}, gate.run).then(value => { replacementReady = true; return value; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(replacementReady, false); assert.equal(gate.pullCalls, 1, 'Canceled tooling has not finished its cleanup');
  gate.completeCleanup(); const prepared = await replacement;
  assert.equal(prepared.mcpVersion, BROWSER_PINS.mcpVersion); assert.equal(gate.pullCalls, 2); await f.assertClean();
});

test('a no-op probe cannot claim readiness without genuine screenshot evidence', async () => {
  const f = fixture(); f.returnInvalidEvidence();
  await assert.rejects(prepareBrowserImageWith(f.endpoint, {}, f.run), /invalid readiness evidence/); await f.assertClean();
});

test('MCP control is loopback-only with isolated persistent-per-attempt context and image output', () => {
  assert.deepEqual(browserMcpArguments(42319), ['--host', '127.0.0.1', '--port', '42319', '--allowed-hosts', '127.0.0.1:42319', '--output-dir', '/output', '--isolated', '--shared-browser-context', '--image-responses', 'allow']);
  for (const port of [0, 80, 65536, 1.5, NaN]) assert.throws(() => browserMcpArguments(port), /private browser port/);
});
