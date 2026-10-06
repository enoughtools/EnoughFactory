import { availableParallelism, totalmem } from 'node:os';
import type { ContainerRuntimeStatus, Device, Settings } from '@enoughfactory/contracts';

export const MAX_WORKER_CAPACITY = 32;

export function validWorkerCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_WORKER_CAPACITY;
}

/** Catalog data comes from a paired peer, so malformed budgets must never enter scheduling arithmetic. */
export function parseWorkerResources(value: unknown): Device['workerResources'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { cpus, memoryGiB } = value as Record<string, unknown>;
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus <= 0 || cpus > 1024
      || typeof memoryGiB !== 'number' || !Number.isFinite(memoryGiB) || memoryGiB <= 0 || memoryGiB > 16384) return undefined;
  return { cpus, memoryGiB };
}

export function runtimeWorkerResources(status: ContainerRuntimeStatus | undefined): Device['workerResources'] {
  const configured = parseWorkerResources(status);
  if (configured) return configured;
  // The Linux private engine runs directly on the host; it has no separate VM resource allocation.
  if (status?.kind === 'rootless') return { cpus: availableParallelism(), memoryGiB: Math.floor(totalmem() / 1024 ** 3 * 10) / 10 };
  return undefined;
}

export function automaticWorkerCapacity(resources: Device['workerResources']): number {
  if (!resources) return 2;
  // Leave each author enough room for an agent and ordinary development tools.
  return Math.max(1, Math.min(MAX_WORKER_CAPACITY, Math.floor(resources.cpus / 2), Math.floor(resources.memoryGiB / 2)));
}

export function configuredWorkerCapacity(settings: Pick<Settings, 'workerCapacity'>, resources: Device['workerResources']): number {
  return validWorkerCapacity(settings.workerCapacity) ? settings.workerCapacity : automaticWorkerCapacity(resources);
}
