import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { InspectionAuthority, InspectionJob, InspectionSession } from '@enoughfactory/contracts';
import {
  ArtifactStore, InspectionSnapshotManager, exportInspectionSnapshot, importInspectionSnapshot,
  type InspectionSnapshot, type InspectionSnapshotTransfer,
} from '@enoughfactory/workspaces';
import type { Store } from './store.ts';
import type { InspectionLease } from './inspection-jobs.ts';
import { INSPECTION_SOURCE_MAX_BYTES } from './inspection-source-policy.ts';

const bucket = 'inspection-source-retention';
const terminal = new Set(['succeeded', 'failed', 'canceled']);
type JobReader = { listJobs(): InspectionJob[]; sessions(jobId: string): InspectionSession[]; leases(jobId?: string): InspectionLease[] };
export interface InspectionSourceRetention {
  id: string;
  version: 1;
  sourceDigest: string;
  authority: InspectionAuthority;
  transfer: InspectionSnapshotTransfer;
  retainedAt: number;
  lastUsedAt: number;
  retiredAt?: number;
}
export interface InspectionRetentionOptions {
  /** The same inspection data directory used by InspectionSnapshotManager. */
  dataDir: string;
  artifacts: ArtifactStore;
  store: Pick<Store, 'get' | 'set' | 'list'>;
  jobs: JobReader;
  activeJobIds?: () => ReadonlySet<string>;
  /** Independent source setup also owns immutable input without a native job. */
  protectedSnapshotIds?: () => ReadonlySet<string>;
  clock?: () => number;
}
export interface InspectionSourceSweep {
  retiredSnapshotIds: string[];
  retiredBytes: number;
  keptSnapshotIds: string[];
  errors: Array<{ snapshotId: string; message: string }>;
}

/**
 * Source lives in CAS; private checkouts are a small recreatable cache. Cleanup
 * cannot remove a queued, live or uncertain owner's files, and missing/corrupt
 * durable source prevents retirement instead of silently losing dirty work.
 */
export class InspectionRetention {
  private readonly snapshots: InspectionSnapshotManager;
  private readonly clock: () => number;
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly readers = new Map<string, number>();
  private sweeping?: Promise<InspectionSourceSweep>;
  constructor(private readonly options: InspectionRetentionOptions) {
    this.snapshots = new InspectionSnapshotManager({ dataDir: options.dataDir, artifacts: options.artifacts });
    this.clock = options.clock ?? Date.now;
  }

  async retain(snapshot: InspectionSnapshot, authority: InspectionAuthority): Promise<InspectionSourceRetention> {
    return this.exclusive(snapshot.id, async () => {
      const saved = this.options.store.get<InspectionSourceRetention>(bucket, snapshot.id);
      if (saved) {
        if (saved.sourceDigest !== snapshot.sourceDigest || JSON.stringify(saved.authority) !== JSON.stringify(authority)) throw new Error('Inspection source identity already belongs to a different retained authority');
        await this.verifyDurable(saved); await this.snapshots.verify(snapshot);
        const next = { ...saved, lastUsedAt: this.clock(), retiredAt: undefined }; this.options.store.set(bucket, next); return next;
      }
      const transfer = await exportInspectionSnapshot({ snapshot, artifacts: this.options.artifacts, context: authority, limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES } });
      const now = this.clock(), record: InspectionSourceRetention = { id: snapshot.id, version: 1, sourceDigest: snapshot.sourceDigest, authority: structuredClone(authority), transfer, retainedAt: now, lastUsedAt: now };
      await this.verifyDurable(record);
      // Register every root, rather than retaining only a primary source bundle.
      for (const artifact of [...transfer.sourceArtifacts.map(entry => entry.manifest), transfer.sourceManifest]) this.options.store.set('factory-artifacts', artifact);
      this.options.store.set(bucket, record);
      return record;
    });
  }

  /** Relinquish a temporary checkout; a retained copy now belongs to its durable owners and cache sweep. */
  async releaseTemporary(snapshot: InspectionSnapshot): Promise<void> {
    if (snapshot.path !== this.snapshotPath(snapshot.id)) throw new Error('Temporary inspection source is not owned by this retention cache');
    await this.exclusive(snapshot.id, async () => {
      const saved = this.options.store.get<InspectionSourceRetention>(bucket, snapshot.id);
      if (!saved) { await this.snapshots.remove(snapshot); return; }
      if (saved.sourceDigest !== snapshot.sourceDigest) throw new Error('Temporary inspection source differs from its retained identity');
      await this.verifyDurable(saved);
      // Verifier imports preserve the snapshot ID, so a native audit may share
      // this exact path with its original temporary check. Only sweep may retire
      // a retained copy, after every reader, audit and job releases ownership.
    });
  }

  async restore(snapshotId: string, signal?: AbortSignal): Promise<InspectionSnapshot> {
    return this.exclusive(snapshotId, async () => {
      const saved = this.options.store.get<InspectionSourceRetention>(bucket, snapshotId);
      if (!saved) throw new Error('Inspection source has no durable all-root retention receipt');
      await this.verifyDurable(saved);
      const snapshot = await importInspectionSnapshot({ dataDir: this.options.dataDir, artifacts: this.options.artifacts,
        sourceArtifacts: saved.transfer.sourceArtifacts, sourceManifest: saved.transfer.sourceManifest,
        expectedSource: { snapshotId: saved.id, sourceDigest: saved.sourceDigest }, context: saved.authority, signal,
        limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES },
      });
      this.options.store.set(bucket, { ...saved, lastUsedAt: this.clock(), retiredAt: undefined });
      return snapshot;
    });
  }

  /** Pin a restored source across a read/build so a timer cannot retire it mid-use. */
  async use<T>(snapshotId: string, work: (snapshot: InspectionSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.readers.set(snapshotId, (this.readers.get(snapshotId) ?? 0) + 1);
    try { return await work(await this.restore(snapshotId, signal)); }
    finally { const count = (this.readers.get(snapshotId) ?? 1) - 1; if (count) this.readers.set(snapshotId, count); else this.readers.delete(snapshotId); }
  }

  sweep(input: { maxSnapshotBytes?: number; minIdleMs?: number; pressureIdleMs?: number } = {}): Promise<InspectionSourceSweep> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = this.sweepOwned(input).finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }

  private async sweepOwned(input: { maxSnapshotBytes?: number; minIdleMs?: number; pressureIdleMs?: number }): Promise<InspectionSourceSweep> {
    const maxBytes = input.maxSnapshotBytes ?? 512 * 1024 * 1024, minIdle = input.minIdleMs ?? 5 * 60_000, pressureIdle = input.pressureIdleMs ?? 10_000;
    for (const value of [maxBytes, minIdle, pressureIdle]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid inspection source cache limit');
    const result: InspectionSourceSweep = { retiredSnapshotIds: [], retiredBytes: 0, keptSnapshotIds: [], errors: [] };
    const records = this.options.store.list<InspectionSourceRetention>(bucket).sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const sizes = new Map<string, number>(); let totalBytes = 0;
    for (const record of records) {
      try { const size = await directoryBytes(this.snapshotPath(record.id)); sizes.set(record.id, size); totalBytes += size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.errors.push({ snapshotId: record.id, message: message(error) }); }
    }
    for (const record of records) {
      const size = sizes.get(record.id); if (size === undefined) continue;
      const idle = this.clock() - record.lastUsedAt;
      if (this.protected(record.id) || this.operations.has(record.id) || idle < (totalBytes > maxBytes ? Math.min(minIdle, pressureIdle) : minIdle)) { result.keptSnapshotIds.push(record.id); continue; }
      try {
        await this.exclusive(record.id, async () => {
          const current = this.options.store.get<InspectionSourceRetention>(bucket, record.id);
          if (!current || current.lastUsedAt !== record.lastUsedAt || this.protected(record.id)) { result.keptSnapshotIds.push(record.id); return; }
          await this.verifyDurable(current);
          const snapshot = await importInspectionSnapshot({ dataDir: this.options.dataDir, artifacts: this.options.artifacts,
            sourceArtifacts: current.transfer.sourceArtifacts, sourceManifest: current.transfer.sourceManifest,
            expectedSource: { snapshotId: current.id, sourceDigest: current.sourceDigest }, context: current.authority,
            limits: { maxBytes: INSPECTION_SOURCE_MAX_BYTES },
          });
          // Check owner state again after asynchronous integrity checks.
          if (this.protected(record.id)) { result.keptSnapshotIds.push(record.id); return; }
          await this.snapshots.remove(snapshot);
          this.options.store.set(bucket, { ...current, retiredAt: this.clock() });
          result.retiredSnapshotIds.push(record.id); result.retiredBytes += size; totalBytes -= size;
        });
      } catch (error) { result.errors.push({ snapshotId: record.id, message: message(error) }); result.keptSnapshotIds.push(record.id); }
    }
    return result;
  }

  private protected(snapshotId: string): boolean {
    if (this.options.protectedSnapshotIds?.().has(snapshotId)) return true;
    if (this.readers.has(snapshotId)) return true;
    const active = this.options.activeJobIds?.() ?? new Set<string>();
    for (const job of this.options.jobs.listJobs().filter(value => value.source.snapshotId === snapshotId)) {
      if (!terminal.has(job.status) || active.has(job.id) || this.options.jobs.sessions(job.id).some(session => !['stopped', 'failed'].includes(session.status)) || this.options.jobs.leases(job.id).some(lease => lease.status === 'held')) return true;
    }
    return false;
  }

  private async verifyDurable(record: InspectionSourceRetention): Promise<void> {
    if (record.version !== 1 || record.id !== record.transfer.snapshotId || record.sourceDigest !== record.transfer.sourceDigest || !record.transfer.sourceArtifacts.length || record.transfer.sourceArtifacts.length > 9) throw new Error('Invalid inspection source retention receipt');
    for (const artifact of [...record.transfer.sourceArtifacts.map(entry => entry.manifest), record.transfer.sourceManifest]) {
      const saved = await this.options.artifacts.get(artifact.id);
      if (JSON.stringify(saved) !== JSON.stringify(artifact)) throw new Error('Inspection source artifact manifest changed');
      await this.options.artifacts.path(artifact);
    }
  }
  private snapshotPath(id: string): string {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id)) throw new Error('Invalid inspection source identity');
    return resolve(this.options.dataDir, 'inspection-snapshots', id);
  }
  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation); this.operations.set(id, pending);
    try { return await pending; } finally { if (this.operations.get(id) === pending) this.operations.delete(id); }
  }
}

async function directoryBytes(path: string): Promise<number> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) throw new Error('Inspection cache contains an unsafe source directory');
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const child = join(directory, name), stat = await lstat(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(child);
      else bytes += stat.size;
    }
  };
  await visit(path); return bytes;
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
