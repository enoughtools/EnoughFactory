#!/usr/bin/env node
import { readFile, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, parse, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';

const userHome = homedir();
const mac = process.platform === 'darwin';
if (!mac && process.platform !== 'linux') throw new Error('The device service uninstaller supports Mac and Linux.');
let serviceDir = mac ? join(userHome, 'Library', 'Application Support', 'EnoughFactory', 'service') : join(userHome, '.local', 'lib', 'enoughfactory', 'service');
let purge = false; let stop = true;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--service-dir') serviceDir = process.argv[++i];
  else if (arg === '--purge') purge = true;
  else if (arg === '--no-stop') stop = false;
  else if (arg === '--help') {
    console.log('Usage: node uninstall-device-service.mjs [--purge] [--service-dir <installation>] [--no-stop]\nStops the owned private runtime, removes user startup and installed resources. Preserves VM disks, images, volumes, chats and state unless --purge is specified. --no-stop is only for never-started staged installations; it never bypasses runtime safety checks.');
    process.exit(0);
  } else throw new Error(`Unknown option: ${arg}`);
}
if (!serviceDir || /[\r\n\0]/.test(serviceDir)) throw new Error('Invalid service directory.');
serviceDir = resolve(serviceDir);
if (serviceDir === parse(serviceDir).root || serviceDir === userHome) throw new Error('Refusing to remove a root or home directory.');
let install;
try { install = JSON.parse(await readFile(join(serviceDir, '.enoughfactory-install.json'), 'utf8')); }
catch (error) {
  if (error.code === 'ENOENT') { console.log('No installed EnoughFactory user service found.'); process.exit(0); }
  throw error;
}
if (install.schema !== 1 || install.serviceDir !== serviceDir || install.platform !== process.platform) throw new Error('Installation ownership marker does not match this directory and platform.');
for (const key of ['unitPath', 'home']) {
  if (typeof install[key] !== 'string' || !install[key] || /[\r\n\0]/.test(install[key])) throw new Error(`Invalid installation ${key}.`);
}
if (basename(install.unitPath) !== (mac ? 'com.enoughtools.factory.device.plist' : 'enoughfactory-device.service')) throw new Error('Installation startup filename does not match EnoughFactory.');
if (resolve(install.home) === userHome || resolve(install.home) === parse(install.home).root) throw new Error('Refusing to purge a root or home directory.');
function run(command, args) { try { execFileSync(command, args, { stdio: 'ignore' }); } catch {} }
async function stopDetached(home) {
  const owner = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 24);
  const normalStorage = join(resolve(home), 'container', 'lima');
  const fallbackRoot = join('/Users/Shared', `.enoughfactory-runtime-${process.getuid()}-${owner}`);
  const expectedStorage = mac ? (Buffer.byteLength(join(normalStorage, 'factory/sock/docker.sock')) <= 100 ? normalStorage : join(fallbackRoot, 'lima')) : join(resolve(home), 'docker', 'data');
  const externalRoot = mac && expectedStorage === join(fallbackRoot, 'lima') ? fallbackRoot : undefined;
  async function requireNoUnverifiedRuntime() {
    const paths = mac ? [join(home, 'container/runtime-location.json'), join(home, 'container/lima/factory'), join(expectedStorage, 'factory')] : ['docker/run', 'docker/data', 'docker/daemon.json'].map(path => join(home, path));
    for (const path of paths) {
      try { await lstat(path); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      throw new Error('The device service is offline and its private container runtime cannot be verified stopped. Reopen EnoughFactory using this state directory, stop active goals, chats and environments, then retry with its service still online. Resources and runtime data were preserved.');
    }
  }
  let connection;
  try { connection = JSON.parse(await readFile(join(home, 'connection.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') { await requireNoUnverifiedRuntime(); return; } throw error; }
  const url = new URL(connection.url);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || typeof connection.token !== 'string' || !connection.token) throw new Error('Invalid local device connection record.');
  const headers = { Authorization: `Bearer ${connection.token}` };
  const portOpen = () => new Promise(resolve => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) });
    const finish = open => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(300, () => finish(true));
  });
  let health;
  try { health = await fetch(new URL('/api/health', url), { headers, signal: AbortSignal.timeout(1500) }); }
  catch { if (!await portOpen()) { await requireNoUnverifiedRuntime(); return; } throw new Error('A local service is still reachable but its identity could not be verified. Resources were not removed.'); }
  if (!health.ok || (await health.json()).product !== 'EnoughFactory') throw new Error('A live service does not match this EnoughFactory connection. Stop it explicitly before removing resources.');
  if (!stop) throw new Error('--no-stop is only for never-started staged installations. A live EnoughFactory service must stop its owned runtime before removal; retry without --no-stop.');
  async function runtimeStatus() {
    const response = await fetch(new URL('/api/runtime', url), { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`This service cannot verify its private runtime (${response.status}). Reopen the updated EnoughFactory app before removing resources.`);
    const status = await response.json();
    if (typeof status.stateDirectory !== 'string' || resolve(status.stateDirectory) !== resolve(home)) throw new Error('The runtime status does not belong to this device state directory. Resources were preserved.');
    if (typeof status.dataDirectory !== 'string' || resolve(status.dataDirectory) !== expectedStorage) throw new Error('The private runtime storage path does not match this installation. Resources and runtime data were preserved.');
    return status;
  }
  await runtimeStatus();
  console.log('Stopping EnoughFactory’s private container runtime before removing its resources…');
  const deadline = Date.now() + 180_000;
  let stopped;
  try { stopped = await fetch(new URL('/api/runtime/stop', url), { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(150_000) }); }
  catch { /* A timed-out request is not proof of failure or completion. Verify through the runtime status. */ }
  if (stopped && !stopped.ok) {
    const detail = await stopped.json().catch(() => ({}));
    throw new Error(stopped.status === 409 ? `Stop active goals, chats and environments in EnoughFactory, then retry. ${detail.error || detail.message || 'The private runtime is still in use.'} Resources and runtime data were preserved.` : `The private runtime could not stop safely (${stopped.status}). Resources and runtime data were preserved.`);
  }
  let confirmed = false;
  do {
    const status = await runtimeStatus();
    if (status.state === 'stopped') { confirmed = true; break; }
    if (['failed', 'unavailable'].includes(status.state)) throw new Error('The private runtime did not confirm it stopped. Inspect EnoughFactory runtime diagnostics before retrying; resources and runtime data were preserved.');
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  if (!confirmed) throw new Error('The private runtime stop is still pending or unknown. Wait for EnoughFactory to confirm it stopped, then retry. Resources and runtime data were preserved.');
  const shutdown = await fetch(new URL('/api/service/shutdown', url), { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
  if (!shutdown.ok) throw new Error(`The running service could not shut down safely (${shutdown.status}). Stop it before removing resources.`);
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await portOpen()) return externalRoot;
  }
  throw new Error('The device service is still running after shutdown; resources were not removed.');
}
const externalRuntimeRoot = await stopDetached(install.home);
if (purge && externalRuntimeRoot) {
  let stat;
  try { stat = await lstat(externalRuntimeRoot); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())) throw new Error('The private runtime directory is not owned by this account. Its resources and data were preserved.');
}
if (stop) {
  if (mac) run('launchctl', ['bootout', `gui/${process.getuid()}`, install.unitPath]);
  else run('systemctl', ['--user', 'disable', '--now', 'enoughfactory-device.service']);
}
await rm(install.unitPath, { force: true });
if (!mac && stop) run('systemctl', ['--user', 'daemon-reload']);
await rm(serviceDir, { recursive: true });
if (purge) {
  if (externalRuntimeRoot) await rm(externalRuntimeRoot, { recursive: true, force: true });
  await rm(install.home, { recursive: true, force: true });
}
console.log(`EnoughFactory user service removed. ${purge ? 'Device state removed (--purge).' : `Device state preserved at ${install.home}.`}`);
