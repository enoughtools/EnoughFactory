import { serviceUpgradeNeeded, type DeviceConnection } from './service-connection.ts';

export interface ServiceUpdateStatus { canUpdate: boolean; idleShutdown: boolean; busy?: string[] }
export interface ServiceUpdateResult { state: 'current' | 'deferred' | 'busy' | 'updated'; connection?: DeviceConnection; reason?: string }

/** An HTTP timeout is an unknown shutdown outcome. Confirm port closure before starting its successor. */
export async function finishIdleServiceHandoff(options: {
  shutdown(): Promise<'accepted' | 'busy' | 'unknown'>;
  portOpen(): Promise<boolean>;
  current(): Promise<DeviceConnection | undefined>;
  closePreview(): Promise<void>;
  start(): Promise<DeviceConnection>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<DeviceConnection | undefined> {
  const outcome = await options.shutdown();
  if (outcome === 'busy') return undefined;
  if (outcome === 'accepted') await options.closePreview();
  const now = options.now ?? Date.now;
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + (options.timeoutMs ?? 25_000);
  while (await options.portOpen()) {
    if (now() >= deadline) {
      const retained = await options.current();
      if (retained) return retained;
      throw new Error('The prior device service is still closing. EnoughFactory will reconnect when it responds.');
    }
    await wait(250);
  }
  if (outcome !== 'accepted') await options.closePreview();
  return options.start();
}

/** Staging never interrupts work. Only a service's atomic idle guard can authorize replacement. */
export async function prepareServiceUpdate(connection: DeviceConnection, options: {
  targetVersion: string;
  stage(): Promise<string>;
  current(): Promise<DeviceConnection | undefined>;
  inspect(connection: DeviceConnection): Promise<ServiceUpdateStatus | undefined>;
  replace(connection: DeviceConnection, resources: string): Promise<DeviceConnection | undefined>;
}): Promise<ServiceUpdateResult> {
  if (!serviceUpgradeNeeded(connection.version, options.targetVersion)) return { state: 'current', connection };
  const resources = await options.stage();
  const current = await options.current();
  if (!current) return { state: 'deferred', reason: 'The device service is reconnecting.' };
  if (!serviceUpgradeNeeded(current.version, options.targetVersion)) return { state: 'current', connection: current };
  const status = await options.inspect(current);
  if (!status?.idleShutdown) return { state: 'deferred', connection: current, reason: 'This device service does not support safe automatic updates. Its running work remains connected.' };
  if (!status.canUpdate) return { state: 'busy', connection: current, reason: status.busy?.join('; ') || 'The device service is finishing current work.' };
  // Inspection is informational; replace must check idle again atomically at shutdown.
  const updated = await options.replace(current, resources);
  if (!updated) return { state: 'busy', connection: current, reason: 'New work started before the service could update.' };
  if (serviceUpgradeNeeded(updated.version, options.targetVersion)) return { state: 'busy', connection: updated, reason: 'The running service is still finishing its update.' };
  return { state: 'updated', connection: updated };
}
