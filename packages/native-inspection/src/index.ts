import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { HelperTransport, IOSCommandBroker } from './transport.js';
import { sha256, verifyNativeProduct } from './product.js';
import { NativeInspectionError, type NativeAction, type NativeActionOutcome, type NativeBackendOptions, type NativeObservation, type NativePlatform, type NativeProduct, type NativeReadiness, type NativeRecoveryResult, type NativeSession } from './types.js';
import { resolveNativeAssets } from './assets.js';
import { captureProcessIdentity, stopOwnedProcess, type OwnedProcessIdentity } from './process-identity.js';
export * from './types.js';
export * from './product.js';
export * from './assets.js';

/** A failed preflight proved that this start created no session journal or native resource. */
export class NativeSessionNotAllocatedError extends NativeInspectionError {
  readonly allocationOutcome = 'not-allocated' as const;
  constructor(readonly sessionId: string | undefined, readonly reasonCode: string, message: string) {
    super('session-not-allocated', message);
    this.name = 'NativeSessionNotAllocatedError';
  }
}

const execute = promisify(execFile);
interface Running { session: NativeSession; broker?: IOSCommandBroker; runner?: ChildProcess; observationId?: string; busy?: boolean; unknown?: boolean; restartPending?: boolean; }
function productIdentity(product: NativeProduct): string {
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return sha256(JSON.stringify(canonical(product)));
}
async function atomicJSON(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Per-device execution backend. The service owns authority, durable jobs and foreground leases. */
export class NativeInspectionBackend {
  private mac?: HelperTransport;
  private running = new Map<string, Running>();
  private recovering = new Set<string>();
  private startPending = false;
  constructor(readonly options: NativeBackendOptions) {}
  private helper(): HelperTransport {
    return this.mac ??= new HelperTransport(this.options.macHelperExecutable ?? resolveNativeAssets().macHelperExecutable, this.options.commandTimeoutMs);
  }
  async readiness(platform: NativePlatform): Promise<NativeReadiness> {
    if (process.platform !== 'darwin') return { status: 'unsupported', reasons: ['Native Apple inspection requires a Mac.'] };
    try {
      if (platform === 'macos') return await this.helper().call({ kind: 'readiness' });
      await execute('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'], { timeout: 15_000 });
      await stat(this.iosXctestrun());
      return { status: 'ready', reasons: [] };
    } catch (error) { return { status: 'setup-required', reasons: [`Native inspection setup is incomplete: ${error instanceof Error ? error.message : String(error)}`] }; }
  }
  async requestMacPermissions(): Promise<NativeReadiness> { return await this.helper().call({ kind: 'requestPermissions' }); }
  private iosXctestrun(): string {
    const path = this.options.iosXctestrunPath ?? resolveNativeAssets().iosXctestrunPath;
    if (!path) throw new NativeInspectionError('setup-required', 'Install the iOS UI runner built for this Xcode version.');
    return path;
  }
  private async save(running: Running, status: string): Promise<void> {
    await atomicJSON(join(running.session.directory, 'session.json'), { version: 1, status, ...running.session, restartPending: Boolean(running.restartPending), updatedAt: new Date().toISOString() });
  }
  async start(product: NativeProduct, ownerAttemptId: string, sessionId?: string): Promise<NativeSession> {
    if (sessionId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)) throw new NativeInspectionError('invalid-session', 'The coordinator session identity must be a canonical UUID.');
    if (this.startPending || this.recovering.size) throw new NativeInspectionError('native-busy', 'Another native session is being prepared or reconciled.');
    this.startPending = true;
    try { return await this.startSession(product, ownerAttemptId, sessionId); } finally { this.startPending = false; }
  }
  private async startSession(product: NativeProduct, ownerAttemptId: string, requestedId?: string): Promise<NativeSession> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ownerAttemptId)) throw new NativeInspectionError('invalid-owner', 'A valid owning attempt is required.');
    if ([...this.running.values()].some(x => x.session.platform === product.platform)) throw new NativeInspectionError('native-busy', 'This backend already owns an active or uncertain native session.');
    if ((await this.discover()).some(x => x.platform === product.platform)) throw new NativeInspectionError('native-busy', 'Reconcile the previous native session before replacing its resource.');
    if (requestedId) {
      try {
        await lstat(join(resolve(this.options.directory), requestedId));
        throw new NativeInspectionError('session-exists', 'The coordinator session identity already has retained state; reconcile it instead of relaunching.');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    try {
      await verifyNativeProduct(product);
      const ready = await this.readiness(product.platform);
      if (ready.status !== 'ready') throw new NativeInspectionError(ready.status, ready.reasons.join(' '));
    } catch (error) {
      if (requestedId) {
        try {
          await lstat(join(resolve(this.options.directory), requestedId));
          throw new NativeInspectionError('session-exists', 'The coordinator session identity acquired retained state during preflight; reconcile it instead of releasing its ownership.');
        } catch (ownershipError) { if ((ownershipError as NodeJS.ErrnoException).code !== 'ENOENT') throw ownershipError; }
      }
      throw new NativeSessionNotAllocatedError(requestedId, error instanceof NativeInspectionError ? error.code : 'preflight-failed', error instanceof Error ? error.message : 'Native session preparation failed before allocation.');
    }
    await mkdir(resolve(this.options.directory), { recursive: true, mode: 0o700 });
    const id = requestedId ?? randomUUID(); const directory = join(await realpath(resolve(this.options.directory)), id);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new NativeInspectionError('session-exists', 'The coordinator session identity already has retained state; reconcile it instead of relaunching.'); throw error; }
    const session: NativeSession = { id, ownerAttemptId, platform: product.platform, product: structuredClone(product), startedAt: new Date().toISOString(), directory };
    await writeFile(join(directory, 'session-owner.json'), JSON.stringify({ version: 1, sessionId: id, ownerAttemptId, platform: product.platform, directory, startedAt: session.startedAt, productIdentitySha256: productIdentity(product), productInventorySha256: product.inventorySha256, originalArtifactSha256: product.originalArtifactSha256, fixtureRunId: product.fixture.runId }), { mode: 0o600, flag: 'wx' });
    const running: Running = { session }; this.running.set(id, running); await this.save(running, 'preparing');
    try {
      if (product.platform === 'macos') {
        if (product.fixture.expectedDataRoot) {
          try { await stat(product.fixture.expectedDataRoot); throw new NativeInspectionError('fixture-exists', 'Use a fresh verified fixture run to avoid adopting another session’s state.'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        running.unknown = true; // A lost launch reply is not evidence that no process was created.
        const result = await this.helper().call({ kind: 'start', sessionId: id, appPath: product.appPath, bundleIdentifier: product.bundleIdentifier, launchArguments: product.launchArguments, outputDirectory: directory });
        session.pid = result.pid;
        if (Number.isFinite(result.processStartedAt)) session.processStartedAt = result.processStartedAt;
        await this.macLaunchReceipt(session);
      } else await this.startIOS(running);
      await verifyNativeProduct(product); // A launch never silently blesses changed original bytes.
      running.unknown = false; await this.save(running, 'running'); return structuredClone(session);
    } catch (error) {
      running.unknown = running.unknown || Boolean(session.pid || session.simulatorId); await this.save(running, running.unknown ? 'unknown' : 'failed');
      if (!running.unknown) this.running.delete(id);
      throw error;
    }
  }
  private async startIOS(running: Running): Promise<void> {
    const session = running.session; const product = session.product;
    const runtimes = JSON.parse((await execute('/usr/bin/xcrun', ['simctl', 'list', 'runtimes', '--json'])).stdout).runtimes as any[];
    const runtime = runtimes.filter(x => x.isAvailable && (this.options.iosSimulatorRuntime ? x.identifier === this.options.iosSimulatorRuntime : x.identifier.includes('.iOS-'))).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
    if (!runtime) throw new NativeInspectionError('setup-required', 'Install a compatible iOS Simulator runtime in Xcode.');
    const types = JSON.parse((await execute('/usr/bin/xcrun', ['simctl', 'list', 'devicetypes', '--json'])).stdout).devicetypes as any[];
    const deviceType = this.options.iosSimulatorDeviceType ?? types.find(x => x.name.startsWith('iPhone'))?.identifier;
    if (!deviceType) throw new NativeInspectionError('setup-required', 'No iPhone Simulator device type is installed.');
    const name = `EnoughFactory ${session.id.slice(0, 12)}`;
    const simulatorId = (await execute('/usr/bin/xcrun', ['simctl', 'create', name, deviceType, runtime.identifier])).stdout.trim();
    if (!/^[A-Fa-f0-9-]{36}$/.test(simulatorId)) throw new NativeInspectionError('simulator-unknown', 'Simulator creation did not return an owned identity.');
    session.simulatorId = simulatorId; await this.save(running, 'preparing');
    const created = await this.simulator(simulatorId);
    if (!created || created.name !== name || created.deviceTypeIdentifier !== deviceType) throw new NativeInspectionError('ownership-unknown', 'The created Simulator identity could not be verified.');
    const dataPath = await realpath(created.dataPath);
    const owner = JSON.stringify({ version: 1, sessionId: session.id, ownerAttemptId: session.ownerAttemptId, simulatorId, name, runtime: runtime.identifier, deviceType, dataPath, productInventorySha256: product.inventorySha256 });
    await writeFile(join(dataPath, '.enoughfactory-native-owner.json'), owner, { mode: 0o600, flag: 'wx' });
    await writeFile(join(session.directory, 'simulator-owner.json'), owner, { mode: 0o600, flag: 'wx' });
    await execute('/usr/bin/xcrun', ['simctl', 'boot', simulatorId], { timeout: 30_000 });
    await execute('/usr/bin/xcrun', ['simctl', 'bootstatus', simulatorId, '-b'], { timeout: 180_000 });
    await execute('/usr/bin/xcrun', ['simctl', 'install', simulatorId, product.appPath], { timeout: 60_000 });
    const installed = (await execute('/usr/bin/xcrun', ['simctl', 'get_app_container', simulatorId, product.bundleIdentifier, 'app'])).stdout.trim();
    // Simulator installation may add metadata; compare every original file byte, never substitute installed identity.
    const { inventoryApp } = await import('./product.js');
    const original = await inventoryApp(product.appPath); const installedRoot = await realpath(installed);
    for (const entry of original) {
      if (entry.type === 'file' && sha256(await readFile(join(installedRoot, entry.path))) !== entry.sha256) throw new NativeInspectionError('product-changed', 'Installed Simulator app bytes differ from the original product.');
    }
    const data = (await execute('/usr/bin/xcrun', ['simctl', 'get_app_container', simulatorId, product.bundleIdentifier, 'data'])).stdout.trim();
    await writeFile(join(session.directory, 'installed-product.json'), JSON.stringify({ originalInventorySha256: product.inventorySha256, installedApp: installedRoot, dataRoot: data, simulatorId, runtime: runtime.identifier, verifiedOriginalFiles: original.filter(x => x.type === 'file').length }, null, 2), { mode: 0o600 });
    const broker = new IOSCommandBroker(session.id, this.options.commandTimeoutMs); await broker.listen(); running.broker = broker;
    const configuration = join(session.directory, 'runner-configuration.json');
    await writeFile(configuration, JSON.stringify({ sourceXctestrunPath: this.iosXctestrun(), outputDirectory: session.directory, brokerUrl: broker.url, token: broker.token, sessionId: session.id, bundleIdentifier: product.bundleIdentifier, launchArguments: product.launchArguments, maxDurationSeconds: 1800 }), { mode: 0o600 });
    const prepared = await execute(process.execPath, [resolveNativeAssets().iosPrepareRunScript, configuration], { timeout: 15_000 });
    const runPath = prepared.stdout.trim();
    await writeFile(join(session.directory, 'runner-launch-started.json'), JSON.stringify({ version: 1, sessionId: session.id, simulatorId }), { mode: 0o600, flag: 'wx' });
    const runner = spawn('/usr/bin/xcrun', ['xcodebuild', 'test-without-building', '-xctestrun', runPath, '-destination', `id=${simulatorId}`, '-resultBundlePath', join(session.directory, 'Runner.xcresult'), '-parallel-testing-enabled', 'NO'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.runner = runner;
    const log: string[] = []; let total = 0;
    const record = (chunk: Buffer) => { if (total < 2 * 1024 * 1024) { log.push(chunk.toString()); total += chunk.length; } };
    runner.stdout?.on('data', record); runner.stderr?.on('data', record);
    runner.once('error', error => { record(Buffer.from(`Runner launch failed: ${error.message}`)); });
    runner.once('exit', () => { void writeFile(join(session.directory, 'runner.log'), log.join(''), { mode: 0o600 }); });
    if (runner.pid) {
      const identity = await captureProcessIdentity(runner.pid);
      if (!identity) throw new NativeInspectionError('ownership-unknown', 'The iOS runner launch identity was not retained.');
      await writeFile(join(session.directory, 'runner-owner.json'), JSON.stringify({ version: 1, sessionId: session.id, simulatorId, identity }), { mode: 0o600, flag: 'wx' });
    }
    await broker.ready();
    if (broker.readyIdentity?.bundleIdentifier !== product.bundleIdentifier) throw new NativeInspectionError('process-changed', 'iOS UI runner opened a different application.');
    if (runner.pid) {
      const identity = await captureProcessIdentity(runner.pid);
      if (!identity) throw new NativeInspectionError('ownership-unknown', 'The ready iOS runner launch identity could not be verified.');
      await writeFile(join(session.directory, 'runner-owner.json'), JSON.stringify({ version: 1, sessionId: session.id, simulatorId, identity }), { mode: 0o600 });
    }
  }
  private async simulator(id: string): Promise<any | undefined> {
    const listed = JSON.parse((await execute('/usr/bin/xcrun', ['simctl', 'list', 'devices', '--json'], { timeout: 15_000 })).stdout);
    if (!listed.devices || typeof listed.devices !== 'object') throw new NativeInspectionError('ownership-unknown', 'Simulator inventory is unavailable.');
    for (const [runtime, devices] of Object.entries(listed.devices)) {
      if (!Array.isArray(devices)) throw new NativeInspectionError('ownership-unknown', 'Simulator inventory is incomplete.');
      const found = devices.find((x: any) => x.udid === id); if (found) return { ...found, runtime };
    }
    return undefined;
  }
  private async macLaunchReceipt(session: NativeSession): Promise<void> {
    if (!Number.isInteger(session.pid) || !Number.isFinite(session.processStartedAt)) throw new NativeInspectionError('ownership-unknown', 'The Mac helper did not retain a complete process launch identity.');
    await writeFile(join(session.directory, `mac-launch-${session.pid}-${session.processStartedAt}.json`), JSON.stringify({ version: 1, sessionId: session.id, ownerAttemptId: session.ownerAttemptId, pid: session.pid, processStartedAt: session.processStartedAt, productIdentitySha256: productIdentity(session.product) }), { mode: 0o600, flag: 'wx' });
  }
  private async retained(id: string): Promise<NativeSession & { status: string }> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new NativeInspectionError('ownership-unknown', 'Invalid retained session identity.');
    const root = await realpath(resolve(this.options.directory)); const directory = join(root, id);
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) throw new NativeInspectionError('ownership-unknown', 'Retained native session directory is not owned.');
    const record = await this.retainedJSON(directory, 'session.json'); const owner = await this.retainedJSON(directory, 'session-owner.json');
    if (record.version !== 1 || record.id !== id || record.directory !== directory || !['macos', 'ios-simulator'].includes(record.platform)
      || owner.version !== 1 || owner.sessionId !== id || owner.directory !== directory || owner.platform !== record.platform || owner.ownerAttemptId !== record.ownerAttemptId
      || owner.startedAt !== record.startedAt || owner.productIdentitySha256 !== productIdentity(record.product)
      || owner.productInventorySha256 !== record.product?.inventorySha256 || owner.originalArtifactSha256 !== record.product?.originalArtifactSha256 || owner.fixtureRunId !== record.product?.fixture?.runId) throw new NativeInspectionError('ownership-unknown', 'Retained native session and ownership journal disagree.');
    return record;
  }
  private async retainedJSON(directory: string, name: string): Promise<any> {
    const path = join(directory, name); const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 131_072) throw new NativeInspectionError('ownership-unknown', 'Native ownership record is unavailable or invalid.');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new NativeInspectionError('ownership-unknown', 'Native ownership record is invalid.');
    return record;
  }
  /** After a service restart, reconcile only shutdown of a previously owned resource, never input adoption. */
  async recoverStop(id: string): Promise<NativeRecoveryResult> {
    if (this.startPending || this.recovering.size || this.running.has(id)) throw new NativeInspectionError('session-busy', 'Use the live session stop operation, or wait for native reconciliation to finish.');
    this.recovering.add(id);
    let retained: (NativeSession & { status: string }) | undefined;
    try {
      retained = await this.retained(id);
      if (retained.status === 'stopped') return { sessionId: id, status: 'stopped', originalProcessExited: true, historicalActionsRemainUnknown: true };
      if (retained.platform === 'macos' && (retained.status === 'restarting' || (retained as any).restartPending === true)) throw new NativeInspectionError('ownership-unknown', 'An interrupted app restart may have created an unrecorded replacement process.');
      await verifyNativeProduct(retained.product);
      if (retained.platform === 'macos') {
        if (!Number.isInteger(retained.pid) || !Number.isFinite(retained.processStartedAt)) throw new NativeInspectionError('ownership-unknown', 'The retained Mac process launch identity is incomplete.');
        const launch = await this.retainedJSON(retained.directory, `mac-launch-${retained.pid}-${retained.processStartedAt}.json`);
        if (launch.version !== 1 || launch.sessionId !== id || launch.ownerAttemptId !== retained.ownerAttemptId || launch.pid !== retained.pid || launch.processStartedAt !== retained.processStartedAt || launch.productIdentitySha256 !== productIdentity(retained.product)) throw new NativeInspectionError('ownership-unknown', 'The retained Mac launch receipt does not match its session.');
        const result = await this.helper().call({ kind: 'recoverStop', pid: retained.pid, processStartedAt: retained.processStartedAt, appPath: retained.product.appPath, bundleIdentifier: retained.product.bundleIdentifier });
        if (result.originalProcessExited !== true) throw new NativeInspectionError('termination-unknown', 'The retained Mac process exit was not confirmed.');
      } else await this.recoverIOS(retained);
      const result: NativeRecoveryResult = { sessionId: id, status: 'stopped', originalProcessExited: true, historicalActionsRemainUnknown: true };
      await writeFile(join(retained.directory, `recovery-${Date.now()}.json`), JSON.stringify({ ...result, reconciledAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      await atomicJSON(join(retained.directory, 'session.json'), { version: 1, ...retained, status: 'stopped', updatedAt: new Date().toISOString(), recovery: result });
      return result;
    } catch (error) {
      const result: NativeRecoveryResult = { sessionId: id, status: 'unknown', historicalActionsRemainUnknown: true, reason: error instanceof NativeInspectionError ? error.message : 'The retained native resource could not be safely reconciled.' };
      if (retained) await writeFile(join(retained.directory, `recovery-${Date.now()}.json`), JSON.stringify({ ...result, reconciledAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return result;
    } finally { this.recovering.delete(id); }
  }
  private async recoverIOS(session: NativeSession): Promise<void> {
    if (!session.simulatorId || !/^[A-Fa-f0-9-]{36}$/.test(session.simulatorId)) throw new NativeInspectionError('ownership-unknown', 'The retained Simulator identity is incomplete.');
    const owner = await this.retainedJSON(session.directory, 'simulator-owner.json');
    if (owner.version !== 1 || owner.sessionId !== session.id || owner.ownerAttemptId !== session.ownerAttemptId || owner.simulatorId !== session.simulatorId || owner.name !== `EnoughFactory ${session.id.slice(0, 12)}` || owner.productInventorySha256 !== session.product.inventorySha256
      || typeof owner.runtime !== 'string' || !owner.runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-') || typeof owner.deviceType !== 'string' || !owner.deviceType.startsWith('com.apple.CoreSimulator.SimDeviceType.') || typeof owner.dataPath !== 'string' || !owner.dataPath.endsWith('/' + session.simulatorId + '/data')) throw new NativeInspectionError('ownership-unknown', 'The retained Simulator ownership journal does not match.');
    let launch: any;
    try { launch = await this.retainedJSON(session.directory, 'runner-launch-started.json'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const device = await this.simulator(session.simulatorId);
    if (device) {
      if (device.name !== owner.name || device.runtime !== owner.runtime || device.deviceTypeIdentifier !== owner.deviceType || await realpath(device.dataPath) !== owner.dataPath) throw new NativeInspectionError('ownership-unknown', 'The Simulator no longer matches its retained ownership identity.');
      const marker = await this.retainedJSON(owner.dataPath, '.enoughfactory-native-owner.json');
      if (JSON.stringify(marker) !== JSON.stringify(owner)) throw new NativeInspectionError('ownership-unknown', 'The Simulator owner marker does not match its coordinator journal.');
      let installed: any;
      try { installed = await this.retainedJSON(session.directory, 'installed-product.json'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!installed && (launch || (session as any).status !== 'preparing')) throw new NativeInspectionError('ownership-unknown', 'The installed product receipt is missing from a session that may have run.');
      if (installed) {
        const actual = await realpath((await execute('/usr/bin/xcrun', ['simctl', 'get_app_container', session.simulatorId, session.product.bundleIdentifier, 'app'], { timeout: 15_000 })).stdout.trim());
        if (installed.simulatorId !== session.simulatorId || installed.originalInventorySha256 !== session.product.inventorySha256 || actual !== installed.installedApp || !actual.startsWith(owner.dataPath + '/Containers/Bundle/Application/')) throw new NativeInspectionError('ownership-unknown', 'Installed app identity no longer matches its retained Simulator product.');
        const { inventoryApp } = await import('./product.js');
        const [original, current] = await Promise.all([inventoryApp(session.product.appPath), inventoryApp(actual)]);
        const byPath = new Map(current.map(entry => [entry.path, entry]));
        for (const entry of original) if (entry.type === 'file' && (byPath.get(entry.path)?.type !== 'file' || (byPath.get(entry.path) as any).sha256 !== entry.sha256)) throw new NativeInspectionError('product-changed', 'Installed Simulator app bytes changed since the original product was launched.');
      }
    }
    if (launch) {
      if (launch.sessionId !== session.id || launch.simulatorId !== session.simulatorId) throw new NativeInspectionError('ownership-unknown', 'The iOS runner launch journal does not match its session.');
      const runner = await this.retainedJSON(session.directory, 'runner-owner.json');
      if (runner.version !== 1 || runner.sessionId !== session.id || runner.simulatorId !== session.simulatorId) throw new NativeInspectionError('ownership-unknown', 'The iOS runner ownership journal is incomplete.');
      await stopOwnedProcess(runner.identity as OwnedProcessIdentity);
    }
    if (device) {
      // Recheck immediately before destructive cleanup; another session's UUID is never selected.
      const current = await this.simulator(session.simulatorId);
      if (!current || current.name !== owner.name || current.runtime !== owner.runtime || current.deviceTypeIdentifier !== owner.deviceType || await realpath(current.dataPath) !== owner.dataPath || JSON.stringify(await this.retainedJSON(owner.dataPath, '.enoughfactory-native-owner.json')) !== JSON.stringify(owner)) throw new NativeInspectionError('ownership-unknown', 'Simulator ownership changed during reconciliation.');
      if (current.state !== 'Shutdown') await execute('/usr/bin/xcrun', ['simctl', 'shutdown', session.simulatorId], { timeout: 30_000 });
      await execute('/usr/bin/xcrun', ['simctl', 'delete', session.simulatorId], { timeout: 30_000 });
      if (await this.simulator(session.simulatorId)) throw new NativeInspectionError('termination-unknown', 'The owned Simulator still exists after cleanup.');
    }
  }
  private owned(id: string): Running {
    const running = this.running.get(id); if (!running) throw new NativeInspectionError('session-not-found', 'Native session is not owned by this backend.');
    if (running.busy) throw new NativeInspectionError('session-busy', 'Another operation is already in flight for this session.');
    return running;
  }
  private async operation<T>(id: string, action: () => Promise<T>): Promise<T> {
    const running = this.owned(id); running.busy = true;
    try { return await action(); }
    catch (error) { if (['action-unknown', 'helper-disconnected', 'termination-unknown', 'restart-unknown', 'process-changed', 'simulator-unknown'].includes((error as NativeInspectionError).code)) { running.unknown = true; await this.save(running, 'unknown'); } throw error; }
    finally { running.busy = false; }
  }
  async observe(id: string): Promise<NativeObservation> {
    return this.operation(id, async () => {
      const running = this.running.get(id)!; const session = running.session;
      const result = session.platform === 'macos' ? await this.helper().call({ kind: 'observe', sessionId: id }) : await running.broker!.call({ kind: 'observe' });
      const image = result.screenshot;
      let path: string;
      if (image.dataBase64) { path = join(session.directory, `${result.observationId}.png`); await writeFile(path, Buffer.from(image.dataBase64, 'base64'), { mode: 0o600 }); }
      else path = image.path;
      const canonical = await realpath(path); if (!canonical.startsWith(session.directory + '/')) throw new NativeInspectionError('invalid-evidence', 'Screenshot escaped its owned session.');
      const bytes = await readFile(canonical); if (bytes.length > 24 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new NativeInspectionError('invalid-evidence', 'Native runner did not return bounded PNG image bytes.');
      const observation: NativeObservation = { sessionId: id, observationId: result.observationId, observedAt: result.observedAt, appState: result.appState, elements: result.elements, truncated: Boolean(result.truncated), screenshot: { path: canonical, mimeType: 'image/png', sha256: sha256(bytes), width: image.width, height: image.height } };
      running.observationId = result.observationId; running.unknown = false;
      await writeFile(join(session.directory, `${result.observationId}.json`), JSON.stringify(observation, null, 2), { mode: 0o600 });
      await this.save(running, 'running'); return observation;
    });
  }
  async act(id: string, action: NativeAction): Promise<NativeActionOutcome> {
    return this.operation(id, async () => {
      const running = this.running.get(id)!;
      const journal = join(running.session.directory, `action-${Date.now()}-${randomUUID()}.json`);
      try {
      if (!running.observationId || action.observationId !== running.observationId) throw new NativeInspectionError('stale-observation', 'Observe the app again before using its interface references.');
      running.observationId = undefined;
      if (action.kind === 'type' && (typeof action.text !== 'string' || Buffer.byteLength(action.text) > 65_536)) throw new NativeInspectionError('invalid-request', 'Text exceeds the input limit.');
      await atomicJSON(journal, { action, outcome: 'unknown', submittedAt: new Date().toISOString() });
      const result = running.session.platform === 'macos' ? await this.helper().call({ ...action, sessionId: id }) : await running.broker!.call(action);
      await writeFile(journal, JSON.stringify({ action, result, occurredAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      return result;
      } catch (error) {
        await writeFile(journal, JSON.stringify({ action, error: { code: (error as NativeInspectionError).code ?? 'native-error', message: error instanceof Error ? error.message : String(error) }, occurredAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
        throw error;
      }
    });
  }
  async stop(id: string): Promise<void> {
    await this.operation(id, async () => {
      const running = this.running.get(id)!; const session = running.session;
      if (session.platform === 'macos') await this.helper().call({ kind: 'stop', sessionId: id });
      else {
        if (running.broker && running.runner?.exitCode === null) await running.broker.call({ kind: 'stop' });
        if (running.runner?.exitCode === null) await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new NativeInspectionError('termination-unknown', 'iOS runner did not confirm termination; keep its reservation.')), 30_000); running.runner!.once('exit', () => { clearTimeout(timer); resolve(); }); });
        running.broker?.close();
        if (session.simulatorId) {
          await execute('/usr/bin/xcrun', ['simctl', 'shutdown', session.simulatorId], { timeout: 30_000 });
          await execute('/usr/bin/xcrun', ['simctl', 'delete', session.simulatorId], { timeout: 30_000 });
        }
      }
      await this.save(running, 'stopped'); this.running.delete(id);
    });
  }
  /** Restart only the app in its existing owned fixture/simulator; retain data and exact product identity. */
  async restart(id: string, observationId?: string): Promise<NativeActionOutcome & { previousProcessExited: true; pid?: number; previousPid?: number }> {
    return this.operation(id, async () => {
      const running = this.running.get(id)!;
      const current = running.observationId;
      if (!current || (observationId !== undefined && observationId !== current)) throw new NativeInspectionError('stale-observation', 'Observe the app before restarting its owned process.');
      running.observationId = undefined;
      await verifyNativeProduct(running.session.product);
      running.restartPending = true; await this.save(running, 'restarting');
      const result = running.session.platform === 'macos' ? await this.helper().call({ kind: 'restart', sessionId: id, observationId: current }) : await running.broker!.call({ kind: 'restart', observationId: current });
      if (result.previousProcessExited !== true) throw new NativeInspectionError('restart-unknown', 'The app did not confirm its previous process exited.');
      if (result.pid) running.session.pid = result.pid;
      if (Number.isFinite(result.processStartedAt)) running.session.processStartedAt = result.processStartedAt;
      if (running.session.platform === 'macos') await this.macLaunchReceipt(running.session);
      await verifyNativeProduct(running.session.product);
      await writeFile(join(running.session.directory, `restart-${Date.now()}.json`), JSON.stringify({ result, occurredAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      running.restartPending = false; await this.save(running, 'running'); return result;
    });
  }
  /** Restart reports prior active sessions as unknown; the service must reconcile before reuse. */
  async discover(): Promise<Array<NativeSession & { status: string }>> {
    const results: Array<NativeSession & { status: string }> = [...this.running.values()].map(x => ({ ...structuredClone(x.session), status: x.unknown || x.restartPending ? 'unknown' : 'running' }));
    let directories: string[]; try { directories = await readdir(this.options.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return results; throw error; }
    for (const name of directories) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      if (this.running.has(name)) continue;
      try { const session = await this.retained(name); if (!['stopped', 'failed'].includes(session.status)) results.push({ ...session, status: 'unknown' }); }
      catch { throw new NativeInspectionError('ownership-unknown', `Retained native session ${name} is incomplete; reconcile its ownership before replacing or retiring products.`); }
    }
    return results;
  }
  closeTransport(): void { this.mac?.close(); for (const running of this.running.values()) running.broker?.close(); }
}
