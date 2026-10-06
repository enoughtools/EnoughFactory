export interface DeviceConnection { url: string; token: string; pid?: number; version?: string }
interface RuntimeIdentity { kind?: string; stateDirectory?: string; socketPath?: string }
interface Health { ok?: boolean; product?: string; version?: string; runtime?: RuntimeIdentity }
interface ProbeOptions {
  serviceVersion: string;
  stateDirectory: string;
  requireManagedRuntime?: boolean;
  request?: typeof fetch;
}

const updateRequired = (message: string) => new Error(`[DEVICE_SERVICE_UPDATE_REQUIRED] ${message}`);

function versionNumbers(value: string | undefined): number[] | undefined {
  const match = value?.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  return match ? match.slice(1).map(Number) : undefined;
}

export function compatibleServiceVersions(actual: string | undefined, expected: string): boolean {
  const left = versionNumbers(actual), right = versionNumbers(expected);
  // Before 1.0, minor versions define protocol compatibility. Patch updates do
  // not disconnect an existing workspace or authorize restarting its workers.
  return !!left && !!right && left[0] === right[0] && (left[0] !== 0 || left[1] === right[1]);
}

export function serviceUpgradeNeeded(actual: string | undefined, expected: string): boolean {
  const left = versionNumbers(actual), right = versionNumbers(expected);
  if (!left || !right || !compatibleServiceVersions(actual, expected)) return false;
  for (let index = 0; index < 3; index++) {
    if (right[index] !== left[index]) return right[index]! > left[index]!;
  }
  return false;
}

function assertRuntimeIdentity(runtime: RuntimeIdentity | undefined, stateDirectory: string): void {
  if (!runtime || !['lima', 'rootless'].includes(runtime.kind ?? '') || runtime.stateDirectory !== stateDirectory
      || typeof runtime.socketPath !== 'string' || !runtime.socketPath.startsWith('/') || runtime.socketPath === '/var/run/docker.sock') {
    throw updateRequired('Update the device service to use EnoughFactory’s private runtime. Existing environments and work records are retained.');
  }
}

/** Connection checks must not run Docker commands: a waking VM can be unavailable while its service is healthy. */
export async function probeDeviceConnection(connection: DeviceConnection, options: ProbeOptions): Promise<DeviceConnection | undefined> {
  const request = options.request ?? fetch;
  const headers = { Authorization: `Bearer ${connection.token}` };
  let health: Health;
  try {
    const response = await request(`${connection.url}/api/health`, { headers, signal: AbortSignal.timeout(2_000) });
    health = await response.json() as Health;
    if (!response.ok || !health.ok || health.product !== 'EnoughFactory') return undefined;
  } catch { return undefined; }
  const current = { ...connection, version: health.version };
  if (options.requireManagedRuntime === false) return current;
  if (!compatibleServiceVersions(health.version, options.serviceVersion)) {
    throw updateRequired(`This app requires a compatible device service (${options.serviceVersion}). Existing environments and work records are retained.`);
  }
  let runtime = health.runtime;
  if (runtime === undefined) {
    // Older services already retain runtime identity in their catalog. Inspect it
    // without waiting on VM/Docker readiness; fresh older installations fall back.
    try {
      const state = await request(`${connection.url}/api/state`, { headers, signal: AbortSignal.timeout(2_000) });
      if (state.ok) runtime = (await state.json() as { diagnostics?: { containerRuntime?: RuntimeIdentity } }).diagnostics?.containerRuntime;
    } catch { /* Legacy startup may not have a catalog yet. */ }
    if (runtime === undefined) {
      const response = await request(`${connection.url}/api/runtime`, { headers, signal: AbortSignal.timeout(20_000) });
      if (response.status === 404 || response.status === 405) throw updateRequired('Update the device service to use EnoughFactory’s private runtime. Existing environments and work records are retained.');
      if (!response.ok) throw new Error('The running device service could not inspect its private runtime. Its details are in the device log.');
      runtime = await response.json() as RuntimeIdentity;
    }
  }
  assertRuntimeIdentity(runtime, options.stateDirectory);
  return current;
}

/** A slow existing HTTP service must recover or fail visibly, never invite a duplicate daemon. */
export async function connectExistingService(options: {
  readConnection(): DeviceConnection | undefined;
  probe(connection: DeviceConnection): Promise<DeviceConnection | undefined>;
  portOpen(connection: DeviceConnection): Promise<boolean>;
  timeoutMs?: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<DeviceConnection | undefined> {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.timeoutMs ?? 10_000);
  for (;;) {
    const connection = options.readConnection();
    if (!connection) return undefined;
    const ready = await options.probe(connection);
    if (ready) return ready;
    if (!await options.portOpen(connection)) return undefined;
    if (now() >= deadline) throw new Error('The existing device service is still reconnecting. Try again after it responds; its environments and work records have been left intact.');
    await wait(250);
  }
}
