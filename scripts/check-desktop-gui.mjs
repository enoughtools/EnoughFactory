#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const value = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
if (process.argv.includes('--help')) { console.log('Usage: node scripts/check-desktop-gui.mjs --resources <installed resources> --receipt <json> [--executable <native app>] [--source-commit <sha>]'); process.exit(0); }
if (process.platform !== 'linux' || !value('--resources') || !value('--receipt')) throw new Error('Run the native Linux desktop check with installed resources and a receipt path.');
const resources = resolve(value('--resources'));
const executable = resolve(value('--executable') ?? join(dirname(resources), 'enoughfactory'));
await access(executable);
const provenanceBytes = await readFile(join(resources, 'bundle-provenance.json'));
const provenance = JSON.parse(provenanceBytes.toString('utf8'));
if (provenance.platform !== process.platform || provenance.arch !== process.arch || (value('--source-commit') && provenance.sourceCommit !== value('--source-commit'))) throw new Error('Desktop GUI source/native identity mismatch.');
const state = await mkdtemp(join(tmpdir(), 'ef-gui-'));
const address = createServer(); address.listen(0, '127.0.0.1'); await once(address, 'listening');
const port = address.address().port; address.close(); await once(address, 'close');
const output = join(state, 'native-window.json');
const child = spawn('xvfb-run', ['-a', executable, '--enoughfactory-verify-desktop'], { env: { ...process.env, ENOUGHFACTORY_HOME: state, ENOUGHFACTORY_PORT: String(port), ENOUGHFACTORY_GUI_VERIFICATION_RECEIPT: output, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; let launchError;
for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { log = (log + data.toString()).slice(-24_000); });
child.on('error', error => { launchError = error; });
let success;
try {
  const deadline = Date.now() + 70_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    try { success = JSON.parse(await readFile(output, 'utf8')); break; } catch {}
    if (child.exitCode !== null) throw new Error(`Packaged Electron failed before native window verification (${child.exitCode}).\n${log}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  if (!success || success.status !== 'passed' || success.rendererSandbox?.enabled !== true || success.rendererSandbox?.seccomp !== 2 || success.sourceCommit !== provenance.sourceCommit || success.bundleProvenanceSha256 !== createHash('sha256').update(provenanceBytes).digest('hex')) throw new Error(`Packaged Linux GUI did not produce a sandboxed native frame and healthy device service.\n${log}`);
  const screenshot = await readFile(`${output}.png`);
  if (createHash('sha256').update(screenshot).digest('hex') !== success.screenshotSha256) throw new Error('Native GUI screenshot binding mismatch.');
  await writeFile(`${resolve(value('--receipt'))}.png`, screenshot);
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), new Promise(resolveWait => setTimeout(resolveWait, 8_000))]);
  if (child.exitCode !== 0) throw new Error('The verified native desktop did not exit cleanly.');
  const connection = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8'));
  const health = await fetch(`${connection.url}/api/health`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(3_000) });
  if (!health.ok || (await health.json()).product !== 'EnoughFactory') throw new Error('The device service did not continue after the native desktop exited.');
  success.checks.push('device service remains healthy after native desktop exits');
} finally {
  if (child.exitCode === null && !launchError) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), new Promise(resolveWait => setTimeout(resolveWait, 5_000))]); }
  let connection;
  try { connection = JSON.parse(await readFile(join(state, 'connection.json'), 'utf8')); } catch {}
  if (connection) {
    try {
      const headers = { Authorization: `Bearer ${connection.token}` };
      const health = await fetch(`${connection.url}/api/health`, { headers, signal: AbortSignal.timeout(2_000) });
      if (health.ok && (await health.json()).product === 'EnoughFactory') await fetch(`${connection.url}/api/service/shutdown`, { method: 'POST', headers, signal: AbortSignal.timeout(5_000) });
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        try { await fetch(`${connection.url}/api/health`, { headers, signal: AbortSignal.timeout(500) }); } catch { break; }
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
      }
    } catch { /* Preserve private state if daemon shutdown could not be confirmed. */ }
  }
  // A GUI-only check never starts the VM/engine. Its private files are disposable
  // after the authenticated service's listener has closed.
  let live = false;
  if (connection) { try { await fetch(`${connection.url}/api/health`, { signal: AbortSignal.timeout(500) }); live = true; } catch {} }
  if (!live) await rm(state, { recursive: true, force: true });
}
await writeFile(resolve(value('--receipt')), `${JSON.stringify(success, null, 2)}\n`);
console.log(`Native Linux desktop rendered with Chromium seccomp sandbox and its independent service on ${process.arch}.`);
