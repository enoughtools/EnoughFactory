import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore } from '@enoughfactory/workspaces';
import type { DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { BrowserInspectionManager, decodeBrowserImage, runBrowserDocker, type BrowserDockerRunner, type BrowserLease, type BrowserObservation } from '../src/index.ts';

/** Explicitly opt in: this creates disposable fixtures only in this installation's private engine. */
assert.equal(process.env.ENOUGHFACTORY_BROWSER_PILOT, '1', 'Set ENOUGHFACTORY_BROWSER_PILOT=1 to run this real container pilot.');
const required = (name: string) => { const value = process.env[name]; assert.ok(value, `${name} is required; no Docker context fallback is allowed.`); return value; };
const endpoint: DockerRuntimeEndpoint = { host: required('ENOUGHFACTORY_DOCKER_HOST'), cliPath: required('ENOUGHFACTORY_DOCKER_CLI'), configDirectory: required('ENOUGHFACTORY_DOCKER_CONFIG') };
const authorImage = required('ENOUGHFACTORY_BROWSER_PILOT_AUTHOR_IMAGE');
assert.match(authorImage, /^sha256:[a-f0-9]{64}$/, 'Inspect the local Node 22 bookworm fixture image first and supply its immutable ID.');
const owner = createHash('sha256').update(resolve(dirname(dirname(endpoint.configDirectory)))).digest('hex').slice(0, 24);
const pilotId = `browser-pilot-${randomUUID()}`;
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)), '.cache/enoughmail-run/browser-inspection-pilot', pilotId);
await mkdir(root, { recursive: true, mode: 0o700 }); await chmod(root, 0o700);
const store = new ArtifactStore(join(root, 'artifacts'), 'browser-container-pilot');
const transportFailures: Array<Record<string, unknown>> = [];
const tracedDocker: BrowserDockerRunner = async (endpoint, args, options) => {
  try {
    const result = await runBrowserDocker(endpoint, args, options);
    if (result.code) transportFailures.push({ command: args.slice(0, 5), code: result.code, stderr: result.stderr.slice(0, 4000) });
    return result;
  } catch (error) { transportFailures.push({ command: args.slice(0, 5), error: String(error) }); throw error; }
};
const manager = new BrowserInspectionManager({ endpoint, dataDir: join(root, 'leases'), artifacts: store, runDocker: tracedDocker });
const authorIds: string[] = [], browserIds: string[] = [], progress: Array<{ session: string; message: string }> = [];
const receipts: Record<string, unknown> = { version: 1, pilotId, startedAt: new Date().toISOString(), scope: 'real-browser-tool-protocol-and-evidence; no-provider-model-or-native-acceptance-claim', owner, authorImage };
const steps: Array<Record<string, unknown>> = [];
const toolSchemas = new Map<string, Record<string, unknown>>();
const fullId = /^[a-f0-9]{64}$/;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const docker = async (args: string[], input?: string) => {
  const result = await runBrowserDocker(endpoint, args, { input, timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr || result.stdout); return result.stdout;
};
const inspect = async (id: string) => {
  assert.match(id, fullId);
  const result = await runBrowserDocker(endpoint, ['inspect', '--type', 'container', id]);
  if (result.code && /no such (object|container)/i.test(result.stderr)) return undefined;
  assert.equal(result.code, 0, result.stderr); const values = JSON.parse(result.stdout); assert.equal(values.length, 1); assert.equal(values[0].Id, id); return values[0];
};
const runtimeOwned = async () => {
  const info = JSON.parse(await docker(['info', '--format', '{{json .}}']));
  assert.equal(info.OSType, 'linux'); assert.ok(info.Labels?.includes('enoughfactory.managed=true')); assert.ok(info.Labels?.includes(`enoughfactory.owner=${owner}`)); return info;
};
const fixture = (label: string, fixed: boolean) => `<!doctype html><html><head><meta charset="utf-8"><title>${label}</title><style>body{font:16px system-ui;margin:0;background:#f4f5fa;color:#171925}header{padding:20px 28px;border-bottom:1px solid #d9dce8;background:white}main{padding:28px;max-width:900px}button{padding:10px 18px;border:1px solid #4850ed;background:white;color:#343cda;cursor:pointer}section{background:white;padding:24px;border:1px solid #d9dce8;margin-top:20px}[hidden]{display:none}input,textarea{display:block;width:95%;padding:12px;margin:12px 0}</style></head><body><header><h1>${label}</h1></header><main><button id="compose" onclick="document.querySelector('#composer').hidden=false">Compose</button><section><h2>Inbox</h2><p>Welcome to ${label}</p></section><section role="dialog" aria-label="New message" id="composer" hidden><h2>New message</h2><input aria-label="To" placeholder="To"><input aria-label="Subject" placeholder="Subject"><textarea aria-label="Message" placeholder="Message"></textarea><button id="close" ${fixed ? 'onclick="document.querySelector(\'#composer\').hidden=true"' : ''}>Close composer</button></section></main></body></html>`;
const server = `const fs=require('node:fs');fs.mkdirSync('/opt/enoughfactory',{recursive:true});fs.symlinkSync('/usr/local','/opt/enoughfactory/node');fs.mkdirSync('/work',{recursive:true});fs.writeFileSync('/work/index.html',process.env.PILOT_HTML);require('node:http').createServer((req,res)=>{if(req.url==='/slow'){fs.writeFileSync('/work/slow-request-started',new Date().toISOString());return;}res.setHeader('content-type','text/html');res.end(fs.readFileSync('/work/index.html'));}).listen(3000,'127.0.0.1');`;
const author = async (label: string, html: string) => {
  await runtimeOwned();
  const id = (await docker(['run', '-d', '--init', '--name', `${pilotId}-${label.toLowerCase()}`, '--network', 'bridge', '--memory', '256m', '--cpus', '0.5', '--label', 'envmux.schema=2', '--label', 'envmux.kind=session', '--label', 'enoughfactory.managed=true', '--label', `enoughfactory.owner=${owner}`, '--label', `enoughfactory.browser.pilot=${pilotId}`, '--env', `PILOT_HTML=${html}`, '--entrypoint', '/usr/local/bin/node', authorImage, '-e', server])).trim();
  assert.match(id, fullId); authorIds.push(id); const state = await inspect(id);
  assert.equal(state.Config.Labels['enoughfactory.browser.pilot'], pilotId); assert.equal(state.Image, authorImage); assert.equal(state.State.Running, true);
  // The source app listens only on this container's loopback; no host port is published.
  assert.equal(Object.keys(state.HostConfig.PortBindings ?? {}).length, 0);
  for (let attempt = 0; ; attempt++) {
    const ready = await runBrowserDocker(endpoint, ['exec', id, '/usr/local/bin/node', '-e', "fetch('http://127.0.0.1:3000').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]);
    if (!ready.code) break; assert.ok(attempt < 20, ready.stderr); await sleep(100);
  }
  return id;
};
const texts = (observation: BrowserObservation) => observation.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
const call = async (lease: BrowserLease, tool: string, args: Record<string, unknown> = {}) => {
  const observation = await manager.call(lease.id, tool, args); assert.ok(!observation.result.isError, texts(observation));
  steps.push({ browserSessionId: lease.id, arguments: args, ...observation.event }); return observation;
};
const evaluate = (lease: BrowserLease, fn: string) => call(lease, 'browser_evaluate', { function: fn });
const click = async (lease: BrowserLease, name: string) => {
  const snapshot = texts(await call(lease, 'browser_snapshot'));
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ref = snapshot.match(new RegExp(`button "${escaped}"[^\\n]*\\[ref=([^\\]]+)\\]`))?.[1];
  assert.ok(ref, `No accessible button ${name} in snapshot`);
  const properties = toolSchemas.get('browser_click')?.properties as Record<string, unknown> | undefined;
  return call(lease, 'browser_click', properties?.target ? { target: ref } : { element: name, ref });
};
const screenshot = async (lease: BrowserLease, checkpoint: string) => {
  const result = await call(lease, 'browser_take_screenshot', { type: 'png' });
  const images = result.result.content.filter(content => content.type === 'image'); assert.ok(images.length > 0, 'The MCP response must contain actual image content.');
  assert.equal(result.artifacts.length, images.length); assert.ok(!JSON.stringify(result.event).includes('"data":'), 'Compact persisted events must not contain base64 image data.');
  const evidence = [];
  for (const [index, content] of images.entries()) {
    const bytes = decodeBrowserImage(content), manifest = result.artifacts[index]!;
    assert.ok(bytes.length > 100); assert.equal(hash(bytes), manifest.sha256); assert.deepEqual(await store.read(manifest), bytes);
    assert.ok(result.event.content.some(item => item.type === 'resource_link' && item.artifactId === manifest.id));
    assert.deepEqual(manifest.metadata?.source, lease.source);
    const path = join(root, `${checkpoint}-${index}.png`); await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    evidence.push({ artifactId: manifest.id, sha256: manifest.sha256, bytes: bytes.length, path });
  }
  return { checkpoint, evidence };
};

try {
  const info = await runtimeOwned(); receipts.architecture = info.Architecture;
  const image = JSON.parse(await docker(['image', 'inspect', authorImage]))[0];
  assert.equal(image.Id, authorImage); assert.equal(image.Os, 'linux'); assert.match(image.Config.Env.join('\n'), /NODE_VERSION=22\./);
  assert.equal(image.Architecture, ['aarch64', 'arm64'].includes(info.Architecture) ? 'arm64' : 'amd64');
  const a = await author('AppA', fixture('App A', false));
  const b = await author('AppB', fixture('App B', true));
  const prepare = async (session: string, authorContainerId: string, html: string) => {
    const id = `${pilotId}-${session}`; browserIds.push(id);
    const lease = await manager.prepare({ id, sessionId: id, attemptId: `${id}-attempt`, authorContainerId, authorityGeneration: 1, source: { snapshotSha256: hash(html), dirty: true } }, { onProgress: message => { progress.push({ session, message }); console.log(`${session}: ${message}`); } });
    assert.ok(lease.containerId); return lease;
  };
  const leaseA = await prepare('a', a, fixture('App A', false));
  const tools = await manager.listTools(leaseA.id); const names = tools.map(tool => tool.name);
  for (const tool of tools) toolSchemas.set(tool.name, tool.inputSchema);
  for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_evaluate', 'browser_take_screenshot']) assert.ok(names.includes(tool), `${tool} is required`);
  receipts.protocol = { protocolVersion: leaseA.protocolVersion, toolNames: names, selectedToolSchemas: tools.filter(tool => ['browser_click', 'browser_evaluate', 'browser_take_screenshot'].includes(tool.name)), image: leaseA.image };
  await call(leaseA, 'browser_navigate', { url: 'http://127.0.0.1:3000' });
  assert.match(texts(await evaluate(leaseA, '() => document.title')), /App A/);
  await evaluate(leaseA, "() => { document.cookie='pilot=alpha; SameSite=Strict'; return document.cookie; }");
  await click(leaseA, 'Compose'); await click(leaseA, 'Close composer');
  assert.match(texts(await evaluate(leaseA, '() => !document.querySelector("#composer").hidden')), /true/);
  const broken = await screenshot(leaseA, 'broken-composer');
  const repairedHtml = fixture('App A', true);
  await docker(['exec', '-i', a, '/usr/local/bin/node', '-e', "const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c)).on('end',()=>fs.writeFileSync('/work/index.html',Buffer.concat(chunks)));"], repairedHtml);
  // A source-generation change requires a fresh identity; this prevents stale screenshots claiming the repaired source.
  await manager.retire(leaseA.id);
  const repairedA = await prepare('a-repaired', a, repairedHtml);
  await call(repairedA, 'browser_navigate', { url: 'http://127.0.0.1:3000' });
  assert.match(texts(await evaluate(repairedA, '() => document.cookie')), /""/, 'A fresh attempt must not inherit the retired browser profile.');
  await click(repairedA, 'Compose'); await click(repairedA, 'Close composer');
  assert.match(texts(await evaluate(repairedA, '() => document.querySelector("#composer").hidden')), /true/);
  const fixed = await screenshot(repairedA, 'fixed-composer');
  await evaluate(repairedA, "() => { document.cookie='pilot=alpha; SameSite=Strict'; return document.cookie; }");
  const leaseB = await prepare('b', b, fixture('App B', true));
  assert.equal(leaseB.image.image, repairedA.image.image); assert.equal(leaseB.image.image, leaseA.image.image);
  assert.ok(!progress.filter(entry => entry.session === 'b').some(entry => /download|Chromium tools;/.test(entry.message)), 'The second session must reuse shared tools.');
  await call(leaseB, 'browser_navigate', { url: 'http://127.0.0.1:3000' });
  assert.match(texts(await evaluate(leaseB, '() => document.title')), /App B/);
  assert.match(texts(await evaluate(leaseB, '() => document.cookie')), /""/);
  await evaluate(leaseB, "() => { document.cookie='pilot=beta; SameSite=Strict'; return document.cookie; }");
  assert.match(texts(await evaluate(repairedA, '() => document.cookie')), /pilot=alpha/);
  assert.match(texts(await evaluate(leaseB, '() => document.cookie')), /pilot=beta/);
  const isolated = await screenshot(leaseB, 'isolated-app-b');
  const beforeCancel = (await manager.get(repairedA.id)).artifacts.length;
  let resolved = false;
  const pending = manager.call(repairedA.id, 'browser_navigate', { url: 'http://127.0.0.1:3000/slow' }, { timeoutMs: 60_000 }).then(() => { resolved = true; return undefined; }, error => error);
  for (let attempt = 0; (await manager.get(repairedA.id)).state !== 'busy'; attempt++) { assert.ok(attempt < 40); await sleep(100); }
  for (let attempt = 0; ; attempt++) {
    const requested = await runBrowserDocker(endpoint, ['exec', a, '/usr/local/bin/node', '-e', "if(!require('node:fs').existsSync('/work/slow-request-started'))process.exit(1)"]);
    if (!requested.code) break; assert.ok(attempt < 40, 'The pending browser request must reach the author before cancellation.'); await sleep(100);
  }
  const canceled = await manager.cancel(repairedA.id); const error = await pending;
  assert.equal(resolved, false); assert.ok(error instanceof Error); assert.equal(canceled.state, 'retired');
  const finalCanceled = await manager.get(repairedA.id); assert.equal(finalCanceled.state, 'retired', 'A canceled tool must not resurrect its retired lease.');
  assert.equal(finalCanceled.artifacts.length, beforeCancel, 'Canceled action must not publish a successful observation.');
  assert.equal(await inspect(canceled.containerId!), undefined); assert.equal((await inspect(a)).State.Running, true);
  await docker(['exec', a, '/usr/local/bin/node', '-e', "fetch('http://127.0.0.1:3000').then(r=>{if(!r.ok)process.exit(1)})"]);
  const restarted = new BrowserInspectionManager({ endpoint, dataDir: join(root, 'leases'), artifacts: store });
  assert.equal((await restarted.reconcile(leaseB.id))[0]!.state, 'ready');
  assert.ok((await restarted.listTools(leaseB.id)).length > 0);
  await restarted.retire(leaseB.id);
  for (const evidence of [broken, fixed, isolated].flatMap(checkpoint => checkpoint.evidence)) { const manifest = await store.get(evidence.artifactId); assert.equal(hash(await store.read(manifest)), evidence.sha256); }
  receipts.result = { status: 'passed', checkpoints: [broken, fixed, isolated], repairedSourceSha256: hash(repairedHtml), originalSourceSha256: hash(fixture('App A', false)), sameLoopbackPort: 3000, cookieIsolation: true, sharedToolingReused: true, browserCanceledAuthorStillRunning: true, canceledResultNotPublished: true, evidenceSurvivedRetirement: true, readyLeaseReconciledByNewManager: true, cancellation: { code: (error as Error & { code?: string }).code, message: error.message } };
} catch (error) {
  receipts.result = { status: 'failed', error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error) }; process.exitCode = 1;
} finally {
  const cleanup: Record<string, unknown>[] = [];
  for (const id of browserIds) {
    try { cleanup.push({ browserSessionId: id, state: (await manager.retire(id)).state }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') cleanup.push({ browserSessionId: id, notCreated: true });
      else { cleanup.push({ browserSessionId: id, error: String(error) }); process.exitCode = 1; }
    }
  }
  for (const id of authorIds) {
    try {
      await runtimeOwned(); const state = await inspect(id);
      if (state) { assert.equal(state.Config.Labels?.['enoughfactory.browser.pilot'], pilotId); assert.equal(state.Config.Labels?.['enoughfactory.owner'], owner); assert.equal(state.Config.Labels?.['enoughfactory.managed'], 'true'); await docker(['rm', '--force', id]); assert.equal(await inspect(id), undefined); }
      cleanup.push({ authorContainerId: id, removed: true });
    } catch (error) { cleanup.push({ authorContainerId: id, error: String(error) }); process.exitCode = 1; }
  }
  receipts.completedAt = new Date().toISOString(); receipts.progress = progress; receipts.steps = steps; receipts.cleanup = cleanup; receipts.transportFailures = transportFailures;
  const path = join(root, 'receipt.json'); await writeFile(path, JSON.stringify(receipts, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const result = receipts.result as { status: string; error?: { name: string; message: string }; checkpoints?: unknown };
  console.log(JSON.stringify({ receipt: path, receiptSha256: hash(await readFile(path)), result: { status: result.status, error: result.error && { name: result.error.name, message: result.error.message.slice(0, 600) }, checkpoints: result.checkpoints }, cleanup }, null, 2));
}
