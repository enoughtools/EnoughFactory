#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, rename, rm, mkdtemp, access, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname, parse } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';

const userHome = homedir();
const mac = process.platform === 'darwin';
if (!mac && process.platform !== 'linux') throw new Error('The device service installer supports Mac and Linux.');
const options = {
  resources: mac ? '/Applications/EnoughFactory.app/Contents/Resources' : undefined,
  home: process.env.ENOUGHFACTORY_HOME || join(userHome, '.enoughfactory'),
  port: 4317,
  serviceDir: mac ? join(userHome, 'Library', 'Application Support', 'EnoughFactory', 'service') : join(userHome, '.local', 'lib', 'enoughfactory', 'service'),
  unitDir: mac ? join(userHome, 'Library', 'LaunchAgents') : join(userHome, '.config', 'systemd', 'user'),
  start: true,
};
const explicit = new Set(process.env.ENOUGHFACTORY_HOME ? ['home'] : []);
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--resources') options.resources = process.argv[++i];
  else if (arg === '--home') { options.home = process.argv[++i]; explicit.add('home'); }
  else if (arg === '--port') { options.port = Number(process.argv[++i]); explicit.add('port'); }
  else if (arg === '--service-dir') options.serviceDir = process.argv[++i];
  else if (arg === '--unit-dir') { options.unitDir = process.argv[++i]; explicit.add('unitDir'); }
  else if (arg === '--no-start') options.start = false;
  else if (arg === '--help') {
    console.log('Usage: node install-device-service.mjs --resources <installed app resources> [--home <state directory>] [--port 4317] [--no-start]\nAdvanced staging: --service-dir <directory> --unit-dir <directory>');
    process.exit(0);
  } else throw new Error(`Unknown option: ${arg}`);
}
if (!options.resources) throw new Error('Pass --resources with the installed app resources directory.');
let previous;
try { previous = JSON.parse(await readFile(join(resolve(options.serviceDir), '.enoughfactory-install.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous) {
  if (previous.schema !== 1 || previous.serviceDir !== resolve(options.serviceDir) || previous.platform !== process.platform) throw new Error('Existing service ownership marker does not match this installation.');
  if (!explicit.has('home')) options.home = previous.home;
  if (!explicit.has('port')) options.port = previous.port;
  if (!explicit.has('unitDir')) options.unitDir = dirname(previous.unitPath);
}
if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
for (const key of ['resources', 'home', 'serviceDir', 'unitDir']) {
  if (typeof options[key] !== 'string' || !options[key] || /[\r\n\0]/.test(options[key])) throw new Error(`Invalid ${key} path.`);
  options[key] = resolve(options[key]);
}
for (const key of ['home', 'serviceDir']) {
  if (options[key] === parse(options[key]).root || options[key] === userHome) throw new Error(`Refusing to use a filesystem root or home directory as ${key}.`);
}
if (options.home === options.serviceDir || options.home.startsWith(`${options.serviceDir}/`)) throw new Error('Device state must be outside the installed service directory so ordinary removal preserves it.');
const containerFiles = mac ? ['runtime/container/lima/bin/limactl', 'runtime/container/docker/guest-engine.tgz', 'runtime/container/images/guest.img'] : ['runtime/container/docker/bin/dockerd', 'runtime/container/docker/bin/rootlesskit'];
for (const file of ['runtime/node', 'runtime/container/pins.json', 'runtime/container/docker/bin/docker', ...containerFiles, 'device/service.cjs', 'envmux/envmux', 'web/index.html', 'workspaces/Dockerfile', 'agents/antigravity_bridge.py']) {
  try { await access(join(options.resources, file), constants.R_OK); }
  catch { throw new Error(`Installed application resources are incomplete: ${file}`); }
}
const version = execFileSync(join(options.resources, 'runtime', 'node'), ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'v22.22.0') throw new Error(`Expected bundled Node v22.22.0; found ${version}.`);
const label = 'com.enoughtools.factory.device';
const unit = mac ? `${label}.plist` : 'enoughfactory-device.service';
const unitPath = join(options.unitDir, unit);
function run(command, args, optional = false) {
  try { execFileSync(command, args, { stdio: optional ? 'ignore' : 'inherit' }); }
  catch (error) { if (!optional) throw error; }
}
async function stopDetached(home) {
  async function requireNoUnverifiedRuntime() {
    const paths = mac ? ['container/lima/factory'] : ['docker/run', 'docker/data', 'docker/daemon.json'];
    for (const path of paths) {
      try { await lstat(join(home, path)); }
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
  catch { if (!await portOpen()) { await requireNoUnverifiedRuntime(); return; } throw new Error('A local service is still reachable but its identity could not be verified. Resources were not replaced.'); }
  if (!health.ok || (await health.json()).product !== 'EnoughFactory') throw new Error('A live service does not match this EnoughFactory connection. Stop it explicitly before replacing resources.');
  async function runtimeStatus() {
    const response = await fetch(new URL('/api/runtime', url), { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`This service cannot verify its private runtime (${response.status}). Reopen the updated EnoughFactory app before replacing resources.`);
    const status = await response.json();
    if (status.dataDirectory && resolve(status.dataDirectory) !== resolve(home)) throw new Error('The runtime status does not belong to this device state directory. Resources were preserved.');
    return status;
  }
  await runtimeStatus();
  console.log('Stopping EnoughFactory’s private container runtime before updating its resources…');
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
    if (status.state === 'stopped' || status.phase === 'stopped') { confirmed = true; break; }
    if (['failed', 'unavailable'].includes(status.state) || ['error', 'missing', 'unsupported'].includes(status.phase)) throw new Error('The private runtime did not confirm it stopped. Inspect EnoughFactory runtime diagnostics before retrying; resources and runtime data were preserved.');
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  if (!confirmed) throw new Error('The private runtime stop is still pending or unknown. Wait for EnoughFactory to confirm it stopped, then retry. Resources and runtime data were preserved.');
  const shutdown = await fetch(new URL('/api/service/shutdown', url), { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
  if (!shutdown.ok) throw new Error(`The running service could not shut down safely (${shutdown.status}). Update or stop it before replacing resources.`);
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!await portOpen()) return;
  }
  throw new Error('The device service is still running after shutdown; resources were not replaced.');
}
if (previous?.home && previous.home !== options.home) await stopDetached(previous.home);
await stopDetached(options.home);
if (options.start || previous) {
  if (mac) run('launchctl', ['bootout', `gui/${process.getuid()}`, previous?.unitPath || unitPath], true);
  else run('systemctl', ['--user', 'disable', '--now', unit], true);
}
if (previous?.unitPath && previous.unitPath !== unitPath) await rm(previous.unitPath, { force: true });
await mkdir(dirname(options.serviceDir), { recursive: true });
await mkdir(options.home, { recursive: true, mode: 0o700 });
await mkdir(join(options.home, 'logs'), { recursive: true, mode: 0o700 });
await mkdir(options.unitDir, { recursive: true });
const staged = await mkdtemp(join(dirname(options.serviceDir), '.enoughfactory-install-'));
try {
  for (const folder of ['runtime', 'device', 'envmux', 'web', 'workspaces', 'agents', 'notices', 'install']) {
    try { await access(join(options.resources, folder)); }
    catch { if (['notices', 'install'].includes(folder)) continue; throw new Error(`Missing resource folder: ${folder}`); }
    await cp(join(options.resources, folder), join(staged, folder), { recursive: true });
  }
  try { await cp(join(options.resources, 'icon.png'), join(staged, 'icon.png')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await cp(join(options.resources, 'bundle-provenance.json'), join(staged, 'bundle-provenance.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(join(staged, '.enoughfactory-install.json'), `${JSON.stringify({ schema: 1, platform: process.platform, serviceDir: options.serviceDir, unitPath, home: options.home, port: options.port, startupEnabled: options.start, installedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  // Only replace an installation owned by this installer.
  let exists = false;
  try { await access(options.serviceDir); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    let owned;
    try { owned = JSON.parse(await readFile(join(options.serviceDir, '.enoughfactory-install.json'), 'utf8')); }
    catch { throw new Error('Existing service directory is not an EnoughFactory installation.'); }
    if (owned.schema !== 1 || owned.serviceDir !== options.serviceDir) throw new Error('Existing service directory is not an EnoughFactory installation.');
    await rm(options.serviceDir, { recursive: true });
  }
  await rename(staged, options.serviceDir);
} finally { await rm(staged, { recursive: true, force: true }); }
const env = {
  PATH: [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), join(userHome, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
  ENOUGHFACTORY_HOME: options.home,
  ENOUGHFACTORY_PORT: String(options.port),
  ENOUGHFACTORY_RESOURCES: options.serviceDir,
  ENOUGHFACTORY_WEB_PATH: join(options.serviceDir, 'web'),
  ENOUGHFACTORY_ENVMUX_PATH: join(options.serviceDir, 'envmux', 'envmux'),
};
const node = join(options.serviceDir, 'runtime', 'node');
const service = join(options.serviceDir, 'device', 'service.cjs');
if (mac) {
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const contents = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(service)}</string></array>\n<key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('\n')}</dict>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>StandardOutPath</key><string>${xml(join(options.home, 'logs', 'device.stdout.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(join(options.home, 'logs', 'device.stderr.log'))}</string>\n</dict></plist>\n`;
  await writeFile(unitPath, contents, { mode: 0o600 });
  if (options.start) {
    run('launchctl', ['enable', `gui/${process.getuid()}/${label}`]);
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, unitPath]);
  }
} else {
  const quote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
  const contents = `[Unit]\nDescription=EnoughFactory device service\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${quote(node)} ${quote(service)}\n${Object.entries(env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')}\nRestart=on-failure\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  await writeFile(unitPath, contents, { mode: 0o600 });
  if (options.start) {
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', unit]);
  }
}
console.log(`EnoughFactory device service installed at ${options.serviceDir}.\nState: ${options.home}\nStartup: ${unitPath}\n${options.start ? 'User startup enabled.' : 'Startup definition written; service was not started (--no-start).'}`);
