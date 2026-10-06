#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, lstat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, createConnection } from 'node:net';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { once } from 'node:events';
import { seedDataFixture, inspectMigratedData, checkRejectedStartup } from './installed-service-data-boundary.mjs';

const mac = process.platform === 'darwin';
if (!mac && process.platform !== 'linux') throw new Error('Installed user-service verification requires native Mac or Linux.');
const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--resources') options.resources = process.argv[++index];
  else if (flag === '--receipt') options.receipt = process.argv[++index];
  else if (flag === '--source-commit') options.sourceCommit = process.argv[++index];
  else if (flag === '--keep-state') options.keepState = true;
  else if (flag === '--help') {
    console.log('Usage: node scripts/check-installed-service.mjs --resources <native installed app resources> --receipt <output.json> [--source-commit <40hex>] [--keep-state]\nRequires an available launchd login domain or systemd user manager. Refuses an existing EnoughFactory startup registration. Verifies isolated installation/update/removal, retained legacy data and invalid database rejection without starting a container VM.');
    process.exit(0);
  } else throw new Error(`Unknown option: ${flag}`);
}
if (!options.resources || !options.receipt) throw new Error('Pass --resources and --receipt.');
if (options.sourceCommit && !/^[a-f0-9]{40}$/.test(options.sourceCommit)) throw new Error('Invalid --source-commit.');
const resources = resolve(options.resources);
const receiptPath = resolve(options.receipt);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const label = mac ? 'com.enoughtools.factory.device' : 'enoughfactory-device.service';
const domain = `gui/${process.getuid()}`;

function registration() {
  if (mac) {
    try { return { registered: true, detail: execFileSync('launchctl', ['print', `${domain}/${label}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 }) }; }
    catch (error) {
      if (/Could not find service/.test(String(error.stderr))) return { registered: false, detail: '' };
      throw new Error(`The launchd login domain could not be inspected: ${String(error.stderr || error.message).trim()}`);
    }
  }
  let detail;
  try { detail = execFileSync('systemctl', ['--user', 'show', label, '--property=LoadState,ActiveState,FragmentPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 }); }
  catch (error) {
    detail = String(error.stdout || '');
    if (!detail.includes('LoadState=not-found')) throw new Error(`The systemd user manager could not be inspected: ${String(error.stderr || error.message).trim()}`);
  }
  const fields = Object.fromEntries(detail.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
  return { registered: fields.LoadState !== 'not-found' || fields.ActiveState !== 'inactive', detail, fragmentPath: fields.FragmentPath };
}
async function requireVacantRegistration() {
  if (!mac) execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore', timeout: 5_000 });
  if (registration().registered) throw new Error('An EnoughFactory user service is already registered. This isolated check will not replace or stop it.');
  const usualUnit = mac ? join(homedir(), 'Library/LaunchAgents', `${label}.plist`) : join(homedir(), '.config/systemd/user', label);
  try { await lstat(usualUnit); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`An existing EnoughFactory startup definition was found at ${usualUnit}. This check leaves it untouched.`);
}
function requireOwnedRegistration(serviceDir, unitPath) {
  const current = registration();
  if (!current.registered) return;
  const owned = mac ? current.detail.includes(join(serviceDir, 'runtime/node')) && current.detail.includes(join(serviceDir, 'device/service.cjs')) : current.fragmentPath && realpathSync(current.fragmentPath) === realpathSync(unitPath);
  if (!owned) throw new Error('The fixed EnoughFactory startup label belongs to another installation. Its service was left untouched.');
}
async function run(node, script, args) {
  return await new Promise((accept, reject) => {
    const child = spawn(node, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Installed service operation exceeded its deadline.\n${output}`)); }, 240_000);
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => { output = (output + bytes).slice(-20_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? accept(output) : reject(new Error(`Installed service operation exited with ${code}.\n${output}`)); });
  });
}
async function portOpen(port) {
  return await new Promise(accept => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = result => { socket.destroy(); accept(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code !== 'ECONNREFUSED'));
    socket.setTimeout(500, () => finish(true));
  });
}
async function waitHealthy(home, port, version) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const connection = JSON.parse(await readFile(join(home, 'connection.json'), 'utf8'));
      if (connection.url !== `http://127.0.0.1:${port}` || typeof connection.token !== 'string' || !connection.token || !Number.isInteger(connection.pid) || connection.pid <= 1) throw new Error('The user service connection record does not match the isolated installation.');
      const response = await fetch(`${connection.url}/api/health`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(1_500) });
      const health = await response.json();
      if (response.ok && health.ok && health.product === 'EnoughFactory' && health.version === version) return { connection, health };
    } catch {}
    await new Promise(accept => setTimeout(accept, 250));
  }
  const stderr = await readFile(join(home, 'logs/device.stderr.log'), 'utf8').catch(() => '');
  throw new Error(`Installed user service did not answer authenticated health requests.\n${stderr.slice(-12_000)}`);
}
await requireVacantRegistration();
const provenanceBytes = await readFile(join(resources, 'bundle-provenance.json'));
const provenance = JSON.parse(provenanceBytes);
if (provenance.formatVersion !== 1 || provenance.product !== 'EnoughFactory' || provenance.platform !== process.platform || provenance.arch !== process.arch || !/^[a-f0-9]{40}$/.test(provenance.sourceCommit || '') || (options.sourceCommit && options.sourceCommit !== provenance.sourceCommit)) throw new Error('Installed bundle provenance does not match the native worker and requested source commit.');
const verifiedFiles = {};
for (const file of ['runtime/node', 'device/service.cjs', 'install/install-device-service.mjs', 'install/uninstall-device-service.mjs']) {
  const actual = digest(await readFile(join(resources, file)));
  if (actual !== provenance.files?.[file]) throw new Error(`Packaged service resource differs from its bundle manifest: ${file}`);
  verifiedFiles[file] = actual;
}
const node = join(resources, 'runtime/node');
const native = JSON.parse(execFileSync(node, ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,version:process.version})'], { encoding: 'utf8', timeout: 10_000 }));
if (native.platform !== process.platform || native.arch !== process.arch || native.version !== 'v22.22.0') throw new Error('Bundled Node does not match this native user-service worker.');
const fixture = await mkdtemp(join(mac ? '/private/tmp' : tmpdir(), 'ef-service-'));
const home = join(fixture, 'state');
const serviceDir = join(fixture, 'service');
const unitDir = join(fixture, 'units');
const unitPath = join(unitDir, mac ? `${label}.plist` : label);
const sentinel = join(home, 'installation-check-preserve.txt');
await mkdir(home, { mode: 0o700 });
await writeFile(sentinel, 'Installed-service removal must preserve device state.\n');
await seedDataFixture(node, home);
const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; listener.close(); await once(listener, 'close');
let installed = false;
let success = false;
try {
  await requireVacantRegistration();
  console.log(`Checking packaged ${mac ? 'launchd' : 'systemd user'} installation/update/removal and retained device data…`);
  const rejectedStartup = {
    futureVersion: await checkRejectedStartup(resources, join(fixture, 'future-version'), 'future'),
    malformedBaseline: await checkRejectedStartup(resources, join(fixture, 'malformed-baseline'), 'malformed'),
  };
  await requireVacantRegistration();
  const installArgs = ['--resources', resources, '--home', home, '--port', String(port), '--service-dir', serviceDir, '--unit-dir', unitDir];
  installed = true;
  await run(node, join(resources, 'install/install-device-service.mjs'), installArgs);
  requireOwnedRegistration(serviceDir, unitPath);
  if (!registration().registered) throw new Error('The installed user service was not registered with its native process manager.');
  async function verifyCopiedResources() {
    const copiedProvenanceBytes = await readFile(join(serviceDir, 'bundle-provenance.json'));
    if (digest(copiedProvenanceBytes) !== digest(provenanceBytes)) throw new Error('The installed service did not retain the exact bundle provenance.');
    const copiedVerifiedFiles = {};
    for (const [file, expected] of Object.entries(verifiedFiles)) {
      const actual = digest(await readFile(join(serviceDir, file)));
      if (actual !== expected) throw new Error(`Installed service copy differs from the packaged resource: ${file}`);
      copiedVerifiedFiles[file] = actual;
    }
    return { copiedProvenanceBytes, copiedVerifiedFiles };
  }
  await verifyCopiedResources();
  let { connection, health } = await waitHealthy(home, port, provenance.version);
  const firstConnection = connection;
  const request = async route => {
    const response = await fetch(`${connection.url}${route}`, { headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(20_000) });
    const value = await response.json();
    if (!response.ok) throw new Error(`Installed service ${route} returned ${response.status}.`);
    return value;
  };
  const state = await request('/api/state');
  if (state.product !== 'EnoughFactory' || state.device?.platform !== process.platform || state.device?.arch !== process.arch) throw new Error('Installed user-service catalog does not match this native worker.');
  const runtime = await request('/api/runtime');
  if (runtime.stateDirectory !== home || runtime.state !== 'stopped' || runtime.kind !== (mac ? 'lima' : 'rootless')) throw new Error(`Fresh installed runtime did not positively confirm its owned stopped state: ${JSON.stringify(runtime)}`);
  const denied = await fetch(`${connection.url}/api/state`, { signal: AbortSignal.timeout(5_000) });
  if (denied.status !== 401) throw new Error('Installed service accepted an unauthenticated state request.');
  const unitText = await readFile(unitPath, 'utf8');
  if (!unitText.includes(join(serviceDir, 'runtime/container'))) throw new Error('Installed startup did not pin its copied private runtime assets.');
  const legacyAdoption = inspectMigratedData(join(serviceDir, 'runtime/node'), home);
  requireOwnedRegistration(serviceDir, unitPath);
  const updateOutput = await run(node, join(resources, 'install/install-device-service.mjs'), installArgs);
  if (!updateOutput.includes('Stopping EnoughFactory’s private container runtime')) throw new Error('The packaged installer update did not execute the owned runtime stop path.');
  requireOwnedRegistration(serviceDir, unitPath);
  if (!registration().registered) throw new Error('The updated user service was not registered with its native process manager.');
  const { copiedProvenanceBytes, copiedVerifiedFiles } = await verifyCopiedResources();
  ({ connection, health } = await waitHealthy(home, port, provenance.version));
  if (connection.pid === firstConnection.pid || connection.token !== firstConnection.token) throw new Error('The installer update did not restart the service while retaining its access identity.');
  const updatedState = await request('/api/state');
  if (updatedState.device?.id !== state.device.id) throw new Error('The updated user service did not retain its device identity.');
  const updatedRuntime = await request('/api/runtime');
  if (updatedRuntime.stateDirectory !== home || updatedRuntime.state !== 'stopped') throw new Error('The installer update changed the state directory or started the private engine.');
  const version1Reopen = inspectMigratedData(join(serviceDir, 'runtime/node'), home);
  if (legacyAdoption.retainedDataSha256 !== version1Reopen.retainedDataSha256) throw new Error('The installer update changed retained records or event cursors.');
  if (version1Reopen.persistentCursorHighWaterMark < legacyAdoption.persistentCursorHighWaterMark) throw new Error('The installer update reset the persistent event cursor.');
  requireOwnedRegistration(serviceDir, unitPath);
  const removalOutput = await run(join(serviceDir, 'runtime/node'), join(serviceDir, 'install/uninstall-device-service.mjs'), ['--service-dir', serviceDir]);
  if (!removalOutput.includes('Stopping EnoughFactory’s private container runtime')) throw new Error('The packaged uninstaller did not execute the owned runtime stop path.');
  if (registration().registered || await portOpen(port)) throw new Error('The removed fixture still has a startup registration or a reachable service.');
  for (const path of [serviceDir, unitPath]) {
    try { await access(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`Service removal left installed resources or startup at ${path}.`);
  }
  if (await readFile(sentinel, 'utf8') !== 'Installed-service removal must preserve device state.\n') throw new Error('Normal service removal did not preserve device state.');
  await access(join(home, 'connection.json'));
  const uninstallRetention = inspectMigratedData(node, home);
  if (uninstallRetention.retainedDataSha256 !== legacyAdoption.retainedDataSha256) throw new Error('Normal removal changed retained records or event cursors.');
  if (uninstallRetention.persistentCursorHighWaterMark < version1Reopen.persistentCursorHighWaterMark) throw new Error('Normal removal reset the persistent event cursor.');
  const receipt = {
    formatVersion: 1, product: 'EnoughFactory', version: provenance.version, platform: process.platform, arch: process.arch,
    sourceCommit: provenance.sourceCommit, verifiedAt: new Date().toISOString(), verificationScope: 'installed-user-service',
    resources: { bundleProvenanceSha256: digest(provenanceBytes), copiedBundleProvenanceSha256: digest(copiedProvenanceBytes), verifiedFiles, copiedVerifiedFiles },
    service: { manager: mac ? 'launchd' : 'systemd-user', startup: 'registered-and-started', health: 'authenticated', version: health.version, unauthenticatedStateStatus: denied.status, stateDirectory: 'isolated-fixture', privateRuntimeStartupState: runtime.state, runtimeStarted: false, uninstall: 'authenticated-owned-runtime-stop-and-service-shutdown', startupRegistrationRemoved: true, connectionClosed: true, installedResourcesRemoved: true, deviceStatePreserved: true, ...(options.keepState ? { preservedFixtureStateDirectory: home } : {}) },
    dataBoundary: { formatVersion: 1, status: 'passed', sourceCommit: provenance.sourceCommit, bundleProvenanceSha256: digest(provenanceBytes), installedServiceSha256: copiedVerifiedFiles['device/service.cjs'], nodeSha256: copiedVerifiedFiles['runtime/node'], fixtureBucket: 'migration-fixture', legacyAdoption, version1Reopen, updateRetention: { status: 'passed', sameStateDirectory: true, accessIdentityPreserved: true, deviceIdentityPreserved: true, restartedService: true, privateRuntimeState: updatedRuntime.state, retainedDataSha256: version1Reopen.retainedDataSha256 }, uninstallRetention, rejectedStartup },
  };
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  installed = false; success = true;
  console.log(`Packaged user service verified on ${process.platform}/${process.arch}; removal preserved device state. Receipt: ${receiptPath}`);
} finally {
  if (installed) {
    try {
      requireOwnedRegistration(serviceDir, unitPath);
      await run(join(serviceDir, 'runtime/node'), join(serviceDir, 'install/uninstall-device-service.mjs'), ['--service-dir', serviceDir]);
    } catch (error) { console.error(`Fixture cleanup preserved resources for inspection at ${fixture}: ${error.message}`); }
  }
  if (success && !options.keepState) await rm(fixture, { recursive: true, force: true });
  else if (success) console.log(`Fixture device state preserved at ${home}.`);
  else console.error(`Installation check did not complete; fixture diagnostics remain at ${fixture}.`);
}
