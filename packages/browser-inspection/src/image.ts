import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import upstreamLock from './image-assets/upstream-package-lock.json' with { type: 'json' };
import upstreamBrowsers from './image-assets/upstream-browsers.json' with { type: 'json' };
import { BROWSER_IMAGE_PATHS, BROWSER_PINS, type BrowserImagePlatform } from './pins.ts';
import { validateBrowserViewport, type BrowserViewport } from './types.ts';

export interface PreparedBrowserImage {
  image: string;
  baseImage: string;
  platform: BrowserImagePlatform;
  recipeSha256: string;
  nodeVersion: string;
  playwrightVersion: string;
  mcpVersion: string;
  browserRevision: string;
  chromiumVersion: string;
  executablePath: string;
  nodePath: string;
  mcpCliPath: string;
  playwrightPackagePath: string;
}

export interface BrowserImageOptions { signal?: AbortSignal; onProgress?: (message: string) => void; }
export interface BrowserImageRunOptions { signal?: AbortSignal; timeoutMs?: number; }
/** An explicit runner seam for ownership, cache and cancellation verification. */
export type BrowserImageRunner = (endpoint: DockerRuntimeEndpoint, args: readonly string[], options: BrowserImageRunOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
interface Image { Id: string; Architecture: string; Os: string; Config?: { Labels?: Record<string, string>; User?: string; Entrypoint?: string[] }; }

export const BROWSER_IMAGE_LABELS = Object.freeze({
  managed: 'enoughfactory.managed', recipe: 'enoughfactory.browser-toolchain.recipe',
  base: 'enoughfactory.browser-toolchain.base', node: 'enoughfactory.browser-toolchain.node',
  playwright: 'enoughfactory.browser-toolchain.playwright', mcp: 'enoughfactory.browser-toolchain.mcp',
  browser: 'enoughfactory.browser-toolchain.chromium-revision',
});
export const BROWSER_MCP_COMMAND = Object.freeze([BROWSER_IMAGE_PATHS.node, BROWSER_IMAGE_PATHS.mcpCli, '--headless', '--browser', 'chromium', '--no-sandbox']);
export const BROWSER_PROBE_COMMAND = Object.freeze([BROWSER_IMAGE_PATHS.node, BROWSER_IMAGE_PATHS.verifier]);
/** Chromium crashpad needs writable XDG paths even with an isolated browser profile. */
export const BROWSER_PROBE_ENVIRONMENT = Object.freeze({ XDG_CONFIG_HOME: '/tmp/config', XDG_CACHE_HOME: '/tmp/cache' });
const immutableImageId = /^sha256:[a-f0-9]{64}$/;
const serialize = (value: unknown) => JSON.stringify(value) + '\n';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const lockText = serialize(upstreamLock), browsersText = serialize(upstreamBrowsers);

function platform(value: string): BrowserImagePlatform {
  if (['arm64', 'aarch64'].includes(value)) return 'linux/arm64';
  if (['amd64', 'x86_64'].includes(value)) return 'linux/amd64';
  throw new Error('Browser inspection requires the private Linux arm64 or amd64 runtime.');
}

/** Arguments are passed directly to the image entrypoint, never through a shell. */
export function browserMcpArguments(port: number, viewport?: BrowserViewport): string[] {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('The private browser port must be between 1024 and 65535.');
  const initial = validateBrowserViewport(viewport);
  // Pinned MCP compares the complete HTTP Host header, including the port.
  return ['--host', '127.0.0.1', '--port', String(port), '--allowed-hosts', `127.0.0.1:${port}`, '--output-dir', BROWSER_IMAGE_PATHS.output, '--isolated', '--shared-browser-context', '--image-responses', 'allow', ...(initial ? ['--viewport-size', `${initial.width}x${initial.height}`] : [])];
}

/** This layer adds only local metadata and writable output; upstream bytes remain digest-pinned. */
export function browserImageRecipe(selectedPlatform: BrowserImagePlatform) {
  const pin = BROWSER_PINS.architectures[selectedPlatform];
  if (!pin) throw new Error('Unsupported browser image architecture.');
  const baseImage = `${BROWSER_PINS.upstreamImage}@${pin.manifest}`;
  const details = {
    baseImage, platform: selectedPlatform, nodeVersion: BROWSER_PINS.nodeVersion,
    playwrightVersion: BROWSER_PINS.playwrightVersion, mcpVersion: BROWSER_PINS.mcpVersion,
    browserRevision: BROWSER_PINS.browserRevision, chromiumVersion: BROWSER_PINS.chromiumVersion,
    executablePath: pin.executablePath, nodePath: BROWSER_IMAGE_PATHS.node,
    mcpCliPath: BROWSER_IMAGE_PATHS.mcpCli, playwrightPackagePath: BROWSER_IMAGE_PATHS.playwrightPackage,
  };
  const verificationScript = `const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const pins = ${JSON.stringify(details)};
const root = '/opt/enoughfactory/browser';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
for (const [name, path] of Object.entries(${JSON.stringify(BROWSER_PROBE_ENVIRONMENT)})) {
  assert.equal(process.env[name], path, 'Chromium must keep its config/cache in disposable scratch space');
  fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  fs.accessSync(path, fs.constants.W_OK);
}
assert.equal(process.version, 'v' + pins.nodeVersion);
assert.equal(require('/app/package.json').version, pins.mcpVersion);
assert.equal(require('/app/node_modules/playwright/package.json').version, pins.playwrightVersion);
assert.equal(require('/app/node_modules/playwright-core/package.json').version, pins.playwrightVersion);
assert.equal(hash(fs.readFileSync(root + '/upstream-package-lock.json')), '${sha256(lockText)}');
assert.equal(hash(fs.readFileSync(root + '/upstream-browsers.json')), '${sha256(browsersText)}');
assert.deepEqual(JSON.parse(fs.readFileSync('/app/node_modules/playwright-core/browsers.json', 'utf8')), JSON.parse(fs.readFileSync(root + '/upstream-browsers.json', 'utf8')));
const lock = JSON.parse(fs.readFileSync(root + '/upstream-package-lock.json', 'utf8'));
assert.equal(lock.packages[''].version, pins.mcpVersion);
for (const name of ['playwright', 'playwright-core']) assert.equal(lock.packages['node_modules/' + name].version, pins.playwrightVersion);
assert.ok(fs.readdirSync('/ms-playwright').every(name => !/^(firefox|webkit|chromium_headless_shell)-/.test(name)), 'Unexpected duplicate browser payload');
const { chromium } = require(pins.playwrightPackagePath);
assert.equal(chromium.executablePath(), pins.executablePath);
fs.accessSync(pins.executablePath, fs.constants.X_OK);
(async () => {
  const browser = await chromium.launch({ executablePath: pins.executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    assert.equal(browser.version(), pins.chromiumVersion);
    const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
    await page.setContent('<!doctype html><title>EnoughFactory browser probe</title><button>Inspect this page</button>');
    assert.equal(await page.getByRole('button').textContent(), 'Inspect this page');
    const screenshot = await page.screenshot();
    assert.deepEqual([...screenshot.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    process.stdout.write(JSON.stringify({ ...pins, screenshotBytes: screenshot.length }) + '\\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
  const dockerfile = `FROM ${baseImage}\nUSER root\nRUN mkdir -p /output /opt/enoughfactory/browser && chown node:node /output\nCOPY verify.cjs image-toolchain.json upstream-package-lock.json upstream-browsers.json /opt/enoughfactory/browser/\nRUN chmod 0444 /opt/enoughfactory/browser/*\nUSER node\nWORKDIR /output\nENTRYPOINT ${JSON.stringify(BROWSER_MCP_COMMAND)}\n`;
  const recipeSha256 = sha256(JSON.stringify({ schemaVersion: 1, ...details, upstreamIndex: BROWSER_PINS.upstreamIndex, lockSha256: sha256(lockText), browsersSha256: sha256(browsersText), probeEnvironment: BROWSER_PROBE_ENVIRONMENT, verificationScript, dockerfile }));
  const receipt = { schemaVersion: 1, ...details, recipeSha256, upstreamIndex: BROWSER_PINS.upstreamIndex, lockSha256: sha256(lockText), browsersSha256: sha256(browsersText), probeEnvironment: BROWSER_PROBE_ENVIRONMENT };
  return { ...details, recipeSha256, receipt, dockerfile, verificationScript, lockText, browsersText };
}

function labels(recipe: ReturnType<typeof browserImageRecipe>) {
  return {
    [BROWSER_IMAGE_LABELS.managed]: 'true', [BROWSER_IMAGE_LABELS.recipe]: recipe.recipeSha256,
    [BROWSER_IMAGE_LABELS.base]: recipe.baseImage, [BROWSER_IMAGE_LABELS.node]: recipe.nodeVersion,
    [BROWSER_IMAGE_LABELS.playwright]: recipe.playwrightVersion, [BROWSER_IMAGE_LABELS.mcp]: recipe.mcpVersion,
    [BROWSER_IMAGE_LABELS.browser]: recipe.browserRevision,
  };
}

async function ownedPlatform(endpoint: DockerRuntimeEndpoint, run: BrowserImageRunner, options: BrowserImageOptions): Promise<BrowserImagePlatform> {
  dockerInvocation(endpoint, []); options.signal?.throwIfAborted();
  const result = await run(endpoint, ['info', '--format', '{{json .}}'], { signal: options.signal, timeoutMs: 30_000 });
  if (result.code) throw new Error(result.stderr.trim() || 'The private browser runtime is unavailable.');
  const info = JSON.parse(result.stdout) as { OSType?: string; Architecture?: string; Labels?: string[] };
  const owner = sha256(resolve(dirname(dirname(endpoint.configDirectory)))).slice(0, 24);
  if (info.OSType !== 'linux' || !info.Labels?.includes('enoughfactory.managed=true') || !info.Labels.includes(`enoughfactory.owner=${owner}`)) throw new Error('Browser images require this EnoughFactory installation’s private container engine.');
  return platform(info.Architecture ?? '');
}

async function inspect(endpoint: DockerRuntimeEndpoint, ref: string, run: BrowserImageRunner, options: BrowserImageOptions): Promise<Image | undefined> {
  const result = await run(endpoint, ['image', 'inspect', ref], { signal: options.signal, timeoutMs: 30_000 });
  if (result.code) {
    if (/no such image|image .* not found/i.test(result.stderr)) return undefined;
    throw new Error(result.stderr.trim() || 'The pinned browser image could not be inspected.');
  }
  const images: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(images) || images.length !== 1) throw new Error('Docker returned ambiguous browser image metadata.');
  return images[0] as Image;
}

function metadata(image: Image, selectedPlatform: BrowserImagePlatform): PreparedBrowserImage {
  const recipe = browserImageRecipe(selectedPlatform), actualLabels = image.Config?.Labels;
  if (!immutableImageId.test(image.Id) || image.Os !== 'linux' || platform(image.Architecture) !== selectedPlatform || image.Config?.User !== 'node' || JSON.stringify(image.Config?.Entrypoint) !== JSON.stringify(BROWSER_MCP_COMMAND) || !Object.entries(labels(recipe)).every(([key, value]) => actualLabels?.[key] === value)) throw new Error('The cached browser image does not match its pinned tools, entrypoint and architecture.');
  const { baseImage, platform: preparedPlatform, recipeSha256, nodeVersion, playwrightVersion, mcpVersion, browserRevision, chromiumVersion, executablePath, nodePath, mcpCliPath, playwrightPackagePath } = recipe;
  return { image: image.Id, baseImage, platform: preparedPlatform, recipeSha256, nodeVersion, playwrightVersion, mcpVersion, browserRevision, chromiumVersion, executablePath, nodePath, mcpCliPath, playwrightPackagePath };
}

const verified = new Set<string>();
async function probe(endpoint: DockerRuntimeEndpoint, value: PreparedBrowserImage, run: BrowserImageRunner, options: BrowserImageOptions) {
  const key = `${endpoint.host}\0${value.image}`;
  if (verified.has(key)) return;
  options.onProgress?.('Verifying Chromium and screenshot capture without network or credentials');
  const name = `enough-browser-tools-probe-${randomUUID()}`;
  try {
    const result = await run(endpoint, ['run', '--rm', '--init', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777', '--shm-size', '128m', ...Object.entries(BROWSER_PROBE_ENVIRONMENT).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--entrypoint', BROWSER_IMAGE_PATHS.node, value.image, BROWSER_IMAGE_PATHS.verifier], { signal: options.signal, timeoutMs: 60_000 });
    if (result.code) throw new Error(result.stderr.trim() || result.stdout.trim() || 'The pinned browser did not pass its real page and screenshot check.');
    const evidence = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    if (evidence.playwrightVersion !== value.playwrightVersion || evidence.mcpVersion !== value.mcpVersion || evidence.executablePath !== value.executablePath || evidence.chromiumVersion !== value.chromiumVersion || typeof evidence.screenshotBytes !== 'number' || evidence.screenshotBytes < 100) throw new Error('The pinned browser returned invalid readiness evidence.');
  } finally {
    const cleanup = await run(endpoint, ['rm', '--force', name], { timeoutMs: 30_000 });
    if (cleanup.code && !/no such container/i.test(cleanup.stderr)) throw new Error('The disposable browser probe could not be confirmed stopped.');
  }
  options.signal?.throwIfAborted(); verified.add(key);
}

export async function verifyBrowserImage(endpoint: DockerRuntimeEndpoint, value: PreparedBrowserImage, options: BrowserImageOptions = {}): Promise<PreparedBrowserImage> {
  return verifyBrowserImageWith(endpoint, value, options, runDocker);
}
export async function verifyBrowserImageWith(endpoint: DockerRuntimeEndpoint, value: PreparedBrowserImage, options: BrowserImageOptions, run: BrowserImageRunner): Promise<PreparedBrowserImage> {
  if (!value || !immutableImageId.test(value.image)) throw new Error('An immutable prepared browser image is required.');
  const selectedPlatform = await ownedPlatform(endpoint, run, options);
  const image = await inspect(endpoint, value.image, run, options);
  if (!image) throw new Error('The session’s browser image is missing. Its source, chat and captured evidence remain saved.');
  const actual = metadata(image, selectedPlatform);
  for (const key of Object.keys(actual) as Array<keyof PreparedBrowserImage>) if (actual[key] !== value[key]) throw new Error('The saved browser image does not match the pinned recipe.');
  await probe(endpoint, actual, run, options); options.signal?.throwIfAborted(); return actual;
}

interface SharedPreparation {
  promise: Promise<PreparedBrowserImage>;
  controller: AbortController;
  waiters: Map<symbol, BrowserImageOptions['onProgress']>;
  settled: boolean;
}
const preparations = new Map<string, SharedPreparation>();

/** Cancel the caller's wait promptly without transferring cancellation to other owners. */
function waitForPreparation<T>(promise: Promise<T>, signal?: AbortSignal, leave: () => void = () => {}): Promise<T> {
  return new Promise<T>((accept, reject) => {
    let finished = false;
    const clean = () => { signal?.removeEventListener('abort', abort); leave(); };
    const abort = () => {
      if (finished) return; finished = true; clean();
      reject(signal?.reason ?? new DOMException('Browser image preparation was canceled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    // Both handlers stay attached after cancellation so shared cleanup is observed.
    promise.then(value => {
      if (finished) return;
      if (signal?.aborted) { abort(); return; }
      finished = true; clean(); accept(value);
    }, error => { if (!finished) { finished = true; clean(); reject(error); } });
    if (signal?.aborted) abort();
  });
}
export async function prepareBrowserImage(endpoint: DockerRuntimeEndpoint, options: BrowserImageOptions = {}): Promise<PreparedBrowserImage> {
  return prepareBrowserImageWith(endpoint, options, runDocker);
}
export async function prepareBrowserImageWith(endpoint: DockerRuntimeEndpoint, options: BrowserImageOptions, run: BrowserImageRunner): Promise<PreparedBrowserImage> {
  dockerInvocation(endpoint, []); options.signal?.throwIfAborted();
  const key = `${endpoint.host}\0${endpoint.configDirectory}\0${BROWSER_PINS.upstreamIndex}`;
  let active = preparations.get(key);
  if (active?.controller.signal.aborted) {
    // Serialize replacement preparation behind the canceled operation's confirmed cleanup.
    await waitForPreparation(active.promise.then(() => undefined, () => undefined), options.signal);
    return prepareBrowserImageWith(endpoint, options, run);
  }
  if (!active) {
    const shared: SharedPreparation = { controller: new AbortController(), waiters: new Map(), settled: false, promise: undefined! };
    shared.promise = Promise.resolve().then(() => prepareOwned(endpoint, {
      signal: shared.controller.signal,
      onProgress: message => {
        for (const listener of shared.waiters.values()) {
          // Progress observers do not own or cancel the shared tooling operation.
          try { listener?.(message); } catch { /* A UI observer cannot break another caller's preparation. */ }
        }
      },
    }, run)).finally(() => { shared.settled = true; if (preparations.get(key) === shared) preparations.delete(key); });
    preparations.set(key, shared); active = shared;
  }
  const shared = active, waiter = Symbol('browser-image-waiter');
  shared.waiters.set(waiter, options.onProgress);
  return waitForPreparation(shared.promise, options.signal, () => {
    shared.waiters.delete(waiter);
    if (!shared.settled && shared.waiters.size === 0) shared.controller.abort();
  });
}

async function prepareOwned(endpoint: DockerRuntimeEndpoint, options: BrowserImageOptions, run: BrowserImageRunner): Promise<PreparedBrowserImage> {
  options.onProgress?.('Checking shared browser tools');
  const selectedPlatform = await ownedPlatform(endpoint, run, options), recipe = browserImageRecipe(selectedPlatform);
  const tag = `enoughfactory-browser-tools:${recipe.recipeSha256.slice(0, 32)}`;
  let image = await inspect(endpoint, tag, run, options);
  if (!image) {
    let base = await inspect(endpoint, recipe.baseImage, run, options);
    if (!base) {
      options.onProgress?.('Preparing shared Chromium tools; later tasks reuse this download');
      const pull = await run(endpoint, ['pull', '--platform', selectedPlatform, recipe.baseImage], { signal: options.signal, timeoutMs: 15 * 60_000 });
      if (pull.code) throw new Error(pull.stderr.trim() || 'The pinned Chromium image could not be downloaded.');
      base = await inspect(endpoint, recipe.baseImage, run, options);
    }
    if (!base || base.Id !== BROWSER_PINS.architectures[selectedPlatform].config || base.Os !== 'linux' || platform(base.Architecture) !== selectedPlatform) throw new Error('The downloaded browser base does not match its immutable architecture-specific digest.');
    const context = await mkdtemp(join(tmpdir(), 'enoughfactory-browser-image-'));
    try {
      await Promise.all([
        writeFile(join(context, 'Dockerfile'), recipe.dockerfile, { mode: 0o600 }),
        writeFile(join(context, 'verify.cjs'), recipe.verificationScript, { mode: 0o600 }),
        writeFile(join(context, 'image-toolchain.json'), serialize(recipe.receipt), { mode: 0o600 }),
        writeFile(join(context, 'upstream-package-lock.json'), recipe.lockText, { mode: 0o600 }),
        writeFile(join(context, 'upstream-browsers.json'), recipe.browsersText, { mode: 0o600 }),
      ]);
      options.onProgress?.('Preparing shared browser output and pinned tool metadata');
      const build = await run(endpoint, ['build', '--pull=false', '--network', 'none', '--platform', selectedPlatform, '--tag', tag, ...Object.entries(labels(recipe)).flatMap(([key, value]) => ['--label', `${key}=${value}`]), context], { signal: options.signal, timeoutMs: 120_000 });
      if (build.code) throw new Error(build.stderr.trim() || build.stdout.trim() || 'The shared browser image could not be prepared.');
    } finally { await rm(context, { recursive: true, force: true }); }
    image = await inspect(endpoint, tag, run, options);
  }
  if (!image) throw new Error('The private runtime did not retain the prepared browser image.');
  const result = metadata(image, selectedPlatform); await probe(endpoint, result, run, options);
  options.signal?.throwIfAborted(); options.onProgress?.('Shared browser tools are ready'); return result;
}

async function runDocker(endpoint: DockerRuntimeEndpoint, args: readonly string[], options: BrowserImageRunOptions) {
  const invocation = dockerInvocation(endpoint, args); options.signal?.throwIfAborted();
  return await new Promise<{ code: number; stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure: Error | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => { if (failure) return; failure = error; child.kill('SIGTERM'); force = setTimeout(() => child.kill('SIGKILL'), 2_000); force.unref(); };
    const abort = () => stop(new Error('Browser image preparation was canceled.'));
    const timer = setTimeout(() => stop(new Error('Browser image preparation exceeded its deadline.')), options.timeoutMs ?? 30_000);
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-200_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20_000); });
    const clean = () => { clearTimeout(timer); if (force) clearTimeout(force); options.signal?.removeEventListener('abort', abort); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', code => { clean(); if (failure) reject(failure); else accept({ code: code ?? 1, stdout, stderr }); });
  });
}
