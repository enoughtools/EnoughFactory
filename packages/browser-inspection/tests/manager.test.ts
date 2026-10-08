import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { BrowserInspectionManager } from '../src/manager.ts';
import { browserImageRecipe, type PreparedBrowserImage } from '../src/image.ts';
import { BrowserInspectionError, type BrowserLease } from '../src/types.ts';
import type { BrowserDockerRunner } from '../src/docker.ts';
import { decodeBrowserImage, retainBrowserResult } from '../src/evidence.ts';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWLsAAAAASUVORK5CYII=';
const authorA = 'a'.repeat(64), authorB = 'b'.repeat(64);

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'enough-browser-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = { host: `unix://${root}/owned.sock`, cliPath: `${root}/docker`, configDirectory: `${root}/docker/config` };
  const owner = createHash('sha256').update(root).digest('hex').slice(0,24);
  const recipe = browserImageRecipe('linux/arm64');
  const image: PreparedBrowserImage = { image: `sha256:${'d'.repeat(64)}`, baseImage: recipe.baseImage, platform: 'linux/arm64', recipeSha256: recipe.recipeSha256, nodeVersion: recipe.nodeVersion, playwrightVersion: recipe.playwrightVersion, mcpVersion: recipe.mcpVersion, browserRevision: recipe.browserRevision, chromiumVersion: recipe.chromiumVersion, executablePath: recipe.executablePath, nodePath: recipe.nodePath, mcpCliPath: recipe.mcpCliPath, playwrightPackagePath: recipe.playwrightPackagePath };
  type Container = { Id: string; Name: string; State: { Running: boolean }; Config: { Labels: Record<string,string> }; Image?: string; HostConfig?: { NetworkMode: string; PortBindings: Record<string,never> } };
  const containers = new Map<string, Container>();
  for (const [id, name] of [[authorA, 'author-a'], [authorB, 'author-b']]) containers.set(id!, { Id: id!, Name: `/${name}`, State: { Running: true }, Config: { Labels: { 'envmux.schema': '2', 'envmux.kind': 'session' } } });
  const commands: string[][] = [], requests: any[] = [], records: BrowserLease[] = [];
  let runtimeOwned = true, counter = 1;
  let onTool: ((request: any, signal?: AbortSignal) => Promise<any>) | undefined;
  const run: BrowserDockerRunner = async (_endpoint, args, options) => {
    commands.push([...args]);
    const okay = (value: unknown) => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
    if (args[0] === 'info') return okay({ OSType: 'linux', Architecture: 'aarch64', Labels: runtimeOwned ? ['enoughfactory.managed=true', `enoughfactory.owner=${owner}`] : ['foreign=true'] });
    if (args[0] === 'inspect') {
      const reference = args.at(-1)!;
      const container = containers.get(reference) ?? [...containers.values()].find(container => container.Name === `/${reference}`);
      return container ? okay([container]) : { code: 1, stdout: '', stderr: 'No such container' };
    }
    if (args[0] === 'run') {
      const id = String(++counter).repeat(64).slice(0,64);
      const labels: Record<string,string> = {};
      args.forEach((value,index) => { if (value === '--label') { const [key, ...rest] = args[index+1]!.split('='); labels[key!] = rest.join('='); } });
      containers.set(id, { Id: id, Name: `/${args[args.indexOf('--name')+1]}`, State: { Running: true }, Config: { Labels: labels }, Image: image.image, HostConfig: { NetworkMode: args[args.indexOf('--network')+1]!, PortBindings: {} } });
      return okay(id);
    }
    if (args[0] === 'exec') {
      const { request } = JSON.parse(options!.input!); requests.push(request);
      let result: any;
      if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      else if (request.method === 'notifications/initialized') return okay({ status: 202 });
      else if (request.method === 'tools/list') result = { tools: [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }] };
      else if (request.method === 'tools/call') result = onTool ? await onTool(request, options?.signal) : request.params.name === 'browser_take_screenshot' ? { content: [{ type: 'image', mimeType: 'image/png', data: png }, { type: 'text', text: 'Screenshot of actual browser viewport' }] } : { content: [{ type: 'text', text: '- button "Compose"' }] };
      return okay({ status: 200, sessionId: 'test-mcp-session', message: { jsonrpc: '2.0', id: request.id, result } });
    }
    if (args[0] === 'rm') { containers.delete(args.at(-1)!); return okay('removed'); }
    throw new Error(`Unexpected fake Docker call: ${args.join(' ')}`);
  };
  const options = { endpoint, dataDir: join(root, 'state'), runDocker: run, prepareImage: async () => image, verifyImage: async () => image, onRecord: (record: BrowserLease) => { records.push(record); } };
  const manager = new BrowserInspectionManager(options);
  return { root, owner, image, manager, options, containers, commands, requests, records, setOwned(value: boolean) { runtimeOwned = value; }, onTool(value?: typeof onTool) { onTool = value; }, identity: { id: 'browser-a', sessionId: 'session-a', attemptId: 'attempt-a', goalId: 'goal-a', taskId: 'task-a', authorContainerId: authorA, authorityGeneration: 1, source: { commit: '1'.repeat(40) } } };
}

test('private daemon ownership is checked before any browser allocation', async t => {
  const f = await fixture(t); f.setOwned(false);
  await assert.rejects(f.manager.prepare(f.identity), /private container runtime/);
  assert.equal(f.commands.some(command => command[0] === 'run'), false);
});

test('two authors keep loopback networking, profiles and processes independent with no host ports', async t => {
  const f = await fixture(t);
  const a = await f.manager.prepare(f.identity);
  const b = await f.manager.prepare({ ...f.identity, id: 'browser-b', sessionId: 'session-b', authorContainerId: authorB });
  assert.notEqual(a.containerId, b.containerId);
  const runs = f.commands.filter(command => command[0] === 'run');
  assert.equal(runs.length, 2);
  assert.equal(runs[0]![runs[0]!.indexOf('--network')+1], `container:${authorA}`);
  assert.equal(runs[1]![runs[1]!.indexOf('--network')+1], `container:${authorB}`);
  assert.ok(runs.every(command => !command.includes('-p') && !command.includes('--publish') && !command.includes('--ipc=host') && !command.includes('--mount')));
  assert.ok(runs.every(command => command.includes('--shared-browser-context') && command.includes('--output-max-size')));
  assert.equal(a.mcpSessionId, 'test-mcp-session');
  assert.equal((await f.manager.listTools(a.id))[0]!.name, 'browser_snapshot');
  await f.manager.retire(a.id); await f.manager.retire(b.id);
  assert.equal(f.containers.get(authorA)?.State.Running, true);
  assert.equal(f.containers.get(authorB)?.State.Running, true);
});

test('real image bytes remain in provider result while durable events contain only immutable artifact references', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  const observation = await f.manager.call(lease.id, 'browser_take_screenshot');
  assert.equal(observation.result.content[0]!.data, png);
  assert.equal(JSON.stringify(observation.event).includes(png), false);
  assert.equal(observation.event.content[0]!.type, 'resource_link');
  const artifact = observation.artifacts[0]!;
  assert.equal(artifact.goalId, 'goal-a'); assert.equal(artifact.attemptId, 'attempt-a');
  const object = join(f.root, 'state', 'artifacts', 'objects', artifact.sha256.slice(0,2), artifact.sha256);
  assert.deepEqual(await readFile(object), Buffer.from(png,'base64'));
  await f.manager.retire(lease.id);
  assert.deepEqual(await readFile(object), Buffer.from(png,'base64'));
});

test('attempt authority cannot be reused; fresh source identity is stamped per observation without replacing its browser', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  await assert.rejects(f.manager.prepare({ ...f.identity, authorityGeneration: 2 }), /another attempt/);
  const source = { snapshotSha256: 'e'.repeat(64), dirty: true };
  const observation = await f.manager.call(lease.id, 'browser_take_screenshot', {}, { source });
  assert.deepEqual(observation.artifacts[0]!.metadata?.source, source);
  assert.equal(observation.lease.containerId, lease.containerId);
});

test('stale authority after execution cannot publish successful evidence and requires observation before mutation', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  let current = true;
  f.onTool(async () => { current = false; return { content: [{ type: 'image', mimeType: 'image/png', data: png }] }; });
  await assert.rejects(f.manager.call(lease.id, 'browser_take_screenshot', {}, { assertCurrent() { if (!current) throw new Error('Authority retired'); } }), /Authority retired/);
  assert.equal((await f.manager.get(lease.id)).state, 'unknown');
  assert.equal((await f.manager.get(lease.id)).artifacts.length, 0);
  await assert.rejects(f.manager.call(lease.id, 'browser_click', { ref: 'e1' }), /Observe the current page/);
  f.onTool(); await f.manager.call(lease.id, 'browser_snapshot');
  assert.equal((await f.manager.get(lease.id)).state, 'ready');
});

test('cancel tears down only its sidecar and late action failure cannot resurrect the retired lease', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  let entered!: () => void;
  const executing = new Promise<void>(resolve => { entered = resolve; });
  f.onTool(async (_request, signal) => new Promise((_resolve, reject) => { entered(); signal!.addEventListener('abort', () => reject(new BrowserInspectionError('Transport interrupted','TRANSPORT_INTERRUPTED',true)), { once: true }); }));
  const action = f.manager.call(lease.id, 'browser_click', { ref: 'e1' });
  const rejected = assert.rejects(action, /interrupted/);
  await executing; await f.manager.cancel(lease.id); await rejected;
  assert.equal((await f.manager.get(lease.id)).state, 'retired');
  assert.equal(f.containers.has(lease.containerId!), false);
  assert.equal(f.containers.get(authorA)?.State.Running, true);
});

test('cancel during startup joins preparation and removes the late-created owned sidecar', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  const initializing = new Promise<void>(resolve => { entered = resolve; });
  const manager = new BrowserInspectionManager({ ...f.options, runDocker: async (endpoint, args, options) => {
    if (args[0] === 'exec' && JSON.parse(options!.input!).request.method === 'initialize') {
      entered();
      await new Promise((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(new BrowserInspectionError('Startup interrupted','TRANSPORT_INTERRUPTED',true)), { once: true }));
    }
    return f.options.runDocker(endpoint,args,options);
  } });
  const preparation = manager.prepare(f.identity);
  const rejected = assert.rejects(preparation);
  await initializing; const retired = await manager.cancel(f.identity.id); await rejected;
  assert.equal(retired.state,'retired');
  assert.equal((await manager.get(f.identity.id)).state,'retired');
  assert.equal(f.containers.size,2);
  assert.equal(f.containers.get(authorA)?.State.Running,true);
  const retirement = f.records.findIndex(record => record.state === 'retired');
  assert.equal(f.records.slice(retirement+1).some(record => record.state === 'ready'),false);
});

test('cancel before tooling is ready confirms that no sidecar was allocated', async t => {
  const f = await fixture(t);
  let entered!: () => void;
  const preparing = new Promise<void>(resolve => { entered = resolve; });
  const manager = new BrowserInspectionManager({ ...f.options, prepareImage: async (_endpoint, options) => {
    entered();
    await new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new Error('Tooling preparation canceled')), { once: true }));
    return f.image;
  } });
  const preparation = manager.prepare(f.identity);
  const rejected = assert.rejects(preparation, error => error instanceof BrowserInspectionError && error.code === 'BROWSER_NOT_ALLOCATED' && !error.outcomeUnknown);
  await preparing;
  await assert.rejects(manager.cancel(f.identity.id), error => error instanceof BrowserInspectionError && error.code === 'BROWSER_NOT_ALLOCATED' && !error.outcomeUnknown);
  await rejected;
  assert.equal(f.commands.some(command => command[0] === 'run'), false);
  assert.equal(f.containers.size, 2);
});

test('tooling setup failure records confirmed pre-sidecar failure rather than unknown allocation', async t => {
  const f = await fixture(t);
  const manager = new BrowserInspectionManager({ ...f.options, prepareImage: async () => { throw new Error('Pinned shared tooling unavailable'); } });
  await assert.rejects(manager.prepare(f.identity), error => error instanceof BrowserInspectionError && error.code === 'BROWSER_NOT_ALLOCATED' && !error.outcomeUnknown && error.message.includes('Pinned shared tooling unavailable'));
  assert.equal(f.commands.some(command => command[0] === 'run'), false);
  assert.equal(f.containers.size, 2);
});

test('concurrent stop and cancellation share one confirmed retirement', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  const outcomes = await Promise.all([f.manager.cancel(lease.id),f.manager.retire(lease.id),f.manager.retire(lease.id)]);
  assert.ok(outcomes.every(record=>record.state==='retired'));
  assert.equal(f.commands.filter(command=>command[0]==='rm').length,1);
  assert.equal((await f.manager.get(lease.id)).state,'retired');
});

test('restart reconciles busy sessions as uncertain without replaying an action', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  await writeFile(join(f.root,'state',`${lease.id}.json`), JSON.stringify({ ...lease, state: 'busy', operation: { id: 'interrupted', tool: 'browser_click', startedAt: new Date().toISOString() } }));
  const restarted = new BrowserInspectionManager(f.options);
  const [record] = await restarted.reconcile(lease.id);
  assert.equal(record!.state,'unknown');
  assert.equal(f.requests.some(request => request.method === 'tools/call'),false);
  assert.equal(f.commands.filter(command => command[0] === 'run').length,1);
  await restarted.call(lease.id,'browser_snapshot');
  assert.equal((await restarted.get(lease.id)).state,'ready');
});

test('a runtime outage after container creation preserves unknown ownership for later retirement', async t => {
  const f = await fixture(t);
  let unavailable = false;
  const manager = new BrowserInspectionManager({ ...f.options, runDocker: async (endpoint, args, options) => {
    if (args[0] === 'inspect' && unavailable) return { code: 1, stdout: '', stderr: 'Daemon connection unavailable' };
    const result = await f.options.runDocker(endpoint, args, options);
    if (args[0] === 'run') { unavailable = true; throw new Error('Connection lost after run'); }
    return result;
  } });
  await assert.rejects(manager.prepare(f.identity), /Connection lost/);
  assert.equal((await manager.get(f.identity.id)).state, 'unknown');
  assert.equal(f.containers.size, 3, 'The created sidecar must remain accounted for during the outage');
  unavailable = false;
  const restarted = new BrowserInspectionManager(f.options);
  assert.equal((await restarted.reconcile(f.identity.id))[0]!.state, 'unknown');
  await restarted.retire(f.identity.id);
  assert.equal(f.containers.size, 2);
  assert.equal(f.containers.get(authorA)?.State.Running, true);
});

test('restart finishes recorded retirement when removal preceded the final journal write', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  await writeFile(join(f.root, 'state', `${lease.id}.json`), JSON.stringify({ ...lease, state: 'retiring' }));
  f.containers.delete(lease.containerId!);
  const restarted = new BrowserInspectionManager(f.options);
  assert.equal((await restarted.reconcile(lease.id))[0]!.state, 'retired');
  assert.equal(f.commands.filter(command => command[0] === 'rm').length, 0);
  assert.equal(f.requests.some(request => request.method === 'tools/call'), false);
});

test('reconciliation cannot overwrite a concurrently confirmed retirement', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  let entered!: () => void, release!: () => void, hold = true;
  const inspecting = new Promise<void>(resolve => { entered = resolve; });
  const suspended = new Promise<void>(resolve => { release = resolve; });
  const manager = new BrowserInspectionManager({ ...f.options, runDocker: async (endpoint, args, options) => {
    if (hold && args[0] === 'inspect' && args.at(-1) === lease.containerId) { hold = false; entered(); await suspended; }
    return f.options.runDocker(endpoint, args, options);
  } });
  const reconciling = manager.reconcile(lease.id);
  await inspecting;
  assert.equal((await manager.cancel(lease.id)).state, 'retired');
  release();
  assert.equal((await reconciling)[0]!.state, 'retired');
  assert.equal((await manager.get(lease.id)).state, 'retired');
});

test('missing or ownership-changed sidecars cannot be silently replaced or removed', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  f.containers.get(lease.containerId!)!.Config.Labels['enoughfactory.browser.author'] = authorB;
  await assert.rejects(f.manager.cancel(lease.id), /private lease/);
  assert.equal(f.containers.has(lease.containerId!),true);
  f.containers.delete(lease.containerId!);
  assert.equal((await f.manager.reconcile(lease.id))[0]!.state,'unknown');
  await assert.rejects(f.manager.prepare(f.identity), /missing/);
  assert.equal(f.commands.filter(command => command[0] === 'run').length,1);
});

test('invalid image data is rejected rather than stored as successful visual evidence', async t => {
  const f = await fixture(t), lease = await f.manager.prepare(f.identity);
  assert.throws(() => decodeBrowserImage({ type: 'image', mimeType: 'image/png', data: Buffer.from('not a PNG').toString('base64') }), /format/);
  assert.throws(() => decodeBrowserImage({ type: 'image', mimeType: 'text/html', data: png }), /format/);
  assert.throws(() => decodeBrowserImage({ type: 'image', mimeType: 'image/png', data: 'a'.repeat(12*1024**2) }), /storage limit/);
  let stored = 0;
  await assert.rejects(retainBrowserResult({ content: [{ type: 'image', mimeType: 'image/png', data: 'invalid' }] },lease,'operation','browser_take_screenshot',{ async put() { stored++; throw new Error('must not store'); } }), /invalid/);
  assert.equal(stored,0);
});

test('concurrent requests with a reused browser id cannot coalesce across authorities', async t => {
  const f = await fixture(t);
  let release!: () => void;
  const preparation = new Promise<void>(resolve => { release = resolve; });
  const manager = new BrowserInspectionManager({ ...f.options, prepareImage: async () => { await preparation; return f.image; } });
  const first = manager.prepare(f.identity);
  await assert.rejects(manager.prepare({ ...f.identity, authorityGeneration: 2 }), /concurrent attempt/);
  release(); await first;
  assert.equal(f.commands.filter(command => command[0] === 'run').length,1);
});

test('cancellation during image retention cannot return success or overwrite the retired journal', async t => {
  const f = await fixture(t);
  let entered!: () => void, release!: () => void;
  const retaining = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const manager = new BrowserInspectionManager({ ...f.options, artifacts: { async put(data, metadata) {
    entered(); await held;
    const bytes = Buffer.from(data);
    return { ...metadata, id: 'retained-after-cancel', deviceId: 'fixture', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, createdAt: new Date().toISOString() };
  } } });
  const lease = await manager.prepare(f.identity);
  const action = manager.call(lease.id,'browser_take_screenshot');
  const rejected = assert.rejects(action);
  await retaining; await manager.cancel(lease.id); release(); await rejected;
  assert.equal((await manager.get(lease.id)).state,'retired');
  const retirement = f.records.findIndex(record => record.state === 'retired');
  assert.equal(f.records.slice(retirement+1).some(record => record.state === 'ready'),false);
});
