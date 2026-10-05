#!/usr/bin/env node
import { readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, parse, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';

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
    console.log('Usage: node uninstall-device-service.mjs [--purge] [--service-dir <installation>] [--no-stop]\nRemoves user startup and installed service resources. Preserves projects, chats and state unless --purge is specified.');
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
  let connection;
  try { connection = JSON.parse(await readFile(join(home, 'connection.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
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
  catch { if (!await portOpen()) return; throw new Error('A local service is still reachable but its identity could not be verified. Resources were not removed.'); }
  if (!health.ok || (await health.json()).product !== 'EnoughFactory') throw new Error('A live service does not match this EnoughFactory connection. Stop it explicitly before removing resources.');
  const shutdown = await fetch(new URL('/api/service/shutdown', url), { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
  if (!shutdown.ok) throw new Error(`The running service could not shut down safely (${shutdown.status}). Stop it before removing resources.`);
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await portOpen()) return;
  }
  throw new Error('The device service is still running after shutdown; resources were not removed.');
}
if (stop) {
  if (mac) run('launchctl', ['bootout', `gui/${process.getuid()}`, install.unitPath]);
  else run('systemctl', ['--user', 'disable', '--now', 'enoughfactory-device.service']);
  await stopDetached(install.home);
}
await rm(install.unitPath, { force: true });
if (!mac && stop) run('systemctl', ['--user', 'daemon-reload']);
await rm(serviceDir, { recursive: true });
if (purge) await rm(install.home, { recursive: true, force: true });
console.log(`EnoughFactory user service removed. ${purge ? 'Device state removed (--purge).' : `Device state preserved at ${install.home}.`}`);
