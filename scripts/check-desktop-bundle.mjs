#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { once } from 'node:events';

const resourceOption = process.argv.indexOf('--resources');
if (resourceOption < 0 || !process.argv[resourceOption + 1]) throw new Error('Usage: node scripts/check-desktop-bundle.mjs --resources <native installed resources>');
const resources = resolve(process.argv[resourceOption + 1]);
for (const file of ['runtime/node', 'device/service.cjs', 'envmux/envmux', 'web/index.html', 'workspaces/source.json', 'agents/antigravity_bridge.py', 'bundle-provenance.json', 'notices/LICENSE', 'notices/THIRD_PARTY_NOTICES.md']) await access(join(resources, file));
const node = join(resources, 'runtime/node');
const native = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'], { encoding: 'utf8' }));
if (native.platform !== process.platform || native.arch !== process.arch || native.version !== 'v22.22.0') throw new Error(`Bundled Node does not match the release worker: ${JSON.stringify(native)}`);
execFileSync(join(resources, 'envmux/envmux'), ['--version'], { stdio: 'pipe', timeout: 20_000 });
// This verifies native dependency resolution from the installed tree, without
// relying on repository node_modules or development SDKs.
execFileSync(node, ['-e', 'const r=require("node:module").createRequire(process.argv[1]);const rtc=r("node-datachannel");rtc.cleanup();console.log("WebRTC native runtime loaded")', join(resources, 'device/service.cjs')], { stdio: 'inherit', timeout: 20_000 });
const address = createServer();
address.listen(0, '127.0.0.1');
await once(address, 'listening');
const port = address.address().port;
address.close();
await once(address, 'close');
const state = await mkdtemp(join(tmpdir(), 'enoughfactory-bundle-'));
const child = spawn(node, [join(resources, 'device/service.cjs')], {
  cwd: state,
  env: {
    ...process.env, ENOUGHFACTORY_HOME: state, ENOUGHFACTORY_PORT: String(port),
    ENOUGHFACTORY_RESOURCES: resources, ENOUGHFACTORY_WEB_PATH: join(resources, 'web'),
    ENOUGHFACTORY_ENVMUX_PATH: join(resources, 'envmux/envmux'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
let launchError;
child.on('error', error => { launchError = error; });
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', value => { log = (log + value).slice(-16_000); });
try {
  const deadline = Date.now() + 30_000;
  let connection;
  let ready = false;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Bundled device service exited with ${child.exitCode}.\n${log}`);
    try {
      connection = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8'));
      const response = await fetch(`${connection.url}/api/health`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1_000) });
      const health = await response.json();
      if (response.ok && health.ok && health.product === 'EnoughFactory') { ready = true; break; }
    } catch { connection = undefined; }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  if (!ready || !connection) throw new Error(`Bundled device service did not become ready.\n${log}`);
  const denied = await fetch(`${connection.url}/api/state`, { signal: AbortSignal.timeout(5_000) });
  if (denied.status !== 401) throw new Error(`The bundled service accepted an unauthenticated state request (${denied.status}).`);
  const response = await fetch(`${connection.url}/api/state`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(5_000) });
  const factory = await response.json();
  if (!response.ok || factory.product !== 'EnoughFactory' || factory.device.platform !== process.platform || factory.device.arch !== process.arch) throw new Error('The installed device catalog did not match this release worker.');
  console.log(`EnoughFactory installed runtime verified on ${process.platform}/${process.arch}: service health, authentication, native WebRTC, engine executable and web resources.`);
} finally {
  if (child.exitCode === null && !launchError) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited;
    clearTimeout(timeout);
  }
  await rm(state, { recursive: true, force: true });
}
