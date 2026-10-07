import { statfsSync } from 'node:fs';
import path from 'node:path';
import { HttpError } from './util.ts';

const GiB = 1024 ** 3;
// A real Mac run consumed almost 4 GiB during two concurrent preparations.
// Keep this reserve in addition to the bounded setup reservations below.
export const MIN_HOST_FREE_BYTES = 5 * GiB;
export const PREPARATION_HEADROOM_BYTES = GiB;

export class HostDiskHeadroomError extends HttpError {
  readonly code = 'HOST_DISK_HEADROOM';
  readonly agentStarted = false;
  readonly executionEnded = true;
  constructor(message: string, readonly details: { hostAvailableBytes?: number; requiredBytes: number }) {
    super(409, message, 'HOST_DISK_HEADROOM', details); this.name = 'HostDiskHeadroomError';
  }
}

function availableBytes(directory: string): number {
  // Runtime storage may not exist before the first start. Its existing ancestor
  // identifies the host filesystem without creating it or starting Docker.
  let current = path.resolve(directory);
  for (;;) {
    try {
      const status = statfsSync(current, { bigint: true });
      const available = Number(status.bavail * status.bsize);
      if (!Number.isSafeInteger(available) || available < 0) throw new Error('Invalid filesystem space report.');
      return available;
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw error;
      current = parent;
    }
  }
}

/** Known immutable transfer sizes are a lower bound; archive expansion is not inferred. */
export function preparationArtifactBytes(artifacts: ReadonlyArray<{ sha256: string; size: number }>): number {
  const unique = new Map<string, number>();
  for (const artifact of artifacts) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 0)
      throw new Error('Invalid preparation artifact size.');
    const previous = unique.get(artifact.sha256);
    if (previous !== undefined && previous !== artifact.size) throw new Error('Preparation artifact size disagrees with its content identity.');
    unique.set(artifact.sha256, artifact.size);
  }
  const total = [...unique.values()].reduce((sum, size) => sum + size, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Preparation artifact sizes exceed the supported range.');
  return total;
}

/** Fresh host checks and synchronous setup leases prevent parallel admission races.
 * This is host capacity admission, not evidence that a guest filesystem is writable.
 */
export class HostDiskAdmission {
  private readonly reservations = new Map<string, number>();
  constructor(private readonly directories: () => string[], private readonly deviceName: () => string,
    private readonly probe: (directory: string) => number = availableBytes) {}

  blocker(additionalBytes = PREPARATION_HEADROOM_BYTES): { reason: string; condition: 'host-disk-space' } | undefined {
    const error = this.failure(additionalBytes);
    return error ? { reason: error.message, condition: 'host-disk-space' } : undefined;
  }

  assert(): void {
    const error = this.failure(0);
    if (error) throw error;
  }

  reserve(identity: string, artifactBytes = 0): () => void {
    if (this.reservations.has(identity)) throw new Error('Preparation already owns a host disk reservation.');
    if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 0 || artifactBytes > Number.MAX_SAFE_INTEGER / 2)
      throw new Error('Invalid preparation artifact size.');
    // Retained bytes can be copied on the host and into the private runtime.
    // Keep a separate floor for Git checkout, provider setup and unknown inputs.
    const required = PREPARATION_HEADROOM_BYTES + artifactBytes * 2;
    const error = this.failure(required);
    if (error) throw error;
    this.reservations.set(identity, required);
    let released = false;
    return () => { if (!released) { this.reservations.delete(identity); released = true; } };
  }

  private failure(additionalBytes: number): HostDiskHeadroomError | undefined {
    const reserved = [...this.reservations.values()].reduce((sum, bytes) => sum + bytes, 0);
    const requiredBytes = MIN_HOST_FREE_BYTES + reserved + additionalBytes;
    let hostAvailableBytes: number;
    try {
      const directories = [...new Set(this.directories())];
      if (!directories.length) throw new Error('No owned storage location.');
      hostAvailableBytes = Math.min(...directories.map(directory => this.probe(directory)));
      if (!Number.isSafeInteger(hostAvailableBytes) || hostAvailableBytes < 0) throw new Error('Invalid filesystem space report.');
    } catch {
      return new HostDiskHeadroomError(`EnoughFactory cannot verify free disk space on ${this.deviceName()}. Restore access to its storage, then work will resume.`, { requiredBytes });
    }
    if (hostAvailableBytes >= requiredBytes) return undefined;
    return new HostDiskHeadroomError(`Free disk space on ${this.deviceName()} to continue: ${(hostAvailableBytes / GiB).toFixed(1)} GiB available; at least ${(requiredBytes / GiB).toFixed(1)} GiB required for the host reserve and preparing work. Move or remove files you no longer need; EnoughFactory will resume when space is available.`, { hostAvailableBytes, requiredBytes });
  }
}
