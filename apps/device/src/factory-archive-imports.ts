import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Chat } from '@enoughfactory/contracts';
import type { EnvmuxReady } from '@enoughfactory/envmux';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { validateStoppedFactoryContainerArchives, type EphemeralContainerReceipt } from './factory-container-retirement.ts';
import type { SessionController } from './sessions.ts';
import type { Store } from './store.ts';
import { terminalSessionCleanupBucket, type TerminalSessionCleanupRecord } from './terminal-session-cleanup.ts';
import { exec } from './util.ts';

export interface FactoryArchiveImportEntry {
  sessionId: string;
  launchGeneration: number;
  receipt: EphemeralContainerReceipt & { status: 'removed' };
}
export interface FactoryArchiveImportManifest {
  version: 1;
  id: string;
  status: 'completed';
  sessions: FactoryArchiveImportEntry[];
}
export interface FactoryArchiveImportRecord {
  id: string;
  manifestId?: string;
  sessionId?: string;
  launchGeneration?: number;
  containerId?: string;
  receiptSha256?: string;
  status: 'imported' | 'deferred';
  updatedAt: string;
  reason?: string;
}
export const factoryArchiveImportBucket = 'session-archive-imports';

interface Launch { id: string; generation: number; dockerHost: string; projectPath: string; }
interface SavedSession { id: string; ready: EnvmuxReady; projectPath: string; }
interface Retirement { id: string; status: string; name: string; containerId: string; receipt?: unknown; }
interface PrivateJson { value: unknown; sha256: string; inode: number; device: number; }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function privateDirectory(anchor: string, directory: string): Promise<void> {
  const relative = path.relative(anchor, directory), uid = process.getuid?.();
  if (uid === undefined || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Archive import path is outside private storage.');
  const anchorReal = await realpath(anchor);
  let current = anchor;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o777) !== 0o700)
      throw new Error('Archive imports require private owned directories.');
  }
  if (await realpath(directory) !== path.join(anchorReal, relative)) throw new Error('Archive import directory identity changed.');
}

async function privateJson(filename: string): Promise<PrivateJson> {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o600 || entry.size > 8 * 1024 ** 2)
    throw new Error('Archive import receipts require private owned files.');
  const bytes = await readFile(filename);
  const after = await lstat(filename);
  if (after.ino !== entry.ino || after.dev !== entry.dev || after.size !== entry.size || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs)
    throw new Error('Archive import receipt changed while it was read.');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Archive import JSON is invalid.'); }
  return { value, sha256: digest(bytes), inode: entry.ino, device: entry.dev };
}

function manifest(value: unknown): FactoryArchiveImportManifest {
  const candidate = value as Partial<FactoryArchiveImportManifest> | null;
  if (!candidate || candidate.version !== 1 || candidate.status !== 'completed' || typeof candidate.id !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(candidate.id) || !Array.isArray(candidate.sessions) || candidate.sessions.length > 10_000)
    throw new Error('Archive import manifest is invalid or unfinished.');
  const seen = new Set<string>();
  for (const entry of candidate.sessions) {
    if (!entry || typeof entry.sessionId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(entry.sessionId)
      || !Number.isSafeInteger(entry.launchGeneration) || entry.launchGeneration < 1 || seen.has(entry.sessionId)
      || !entry.receipt || entry.receipt.version !== 2 || entry.receipt.status !== 'removed' || entry.receipt.runtime !== 'ephemeral'
      || !/^[a-f0-9]{64}$/.test(entry.receipt.containerId) || entry.receipt.identity?.sessionId !== entry.sessionId)
      throw new Error('Archive import session entries are invalid or duplicated.');
    seen.add(entry.sessionId);
  }
  return candidate as FactoryArchiveImportManifest;
}

async function requireAbsent(endpoint: DockerRuntimeEndpoint, reference: string): Promise<void> {
  const invocation = dockerInvocation(endpoint, ['inspect', '--type', 'container', reference]);
  try { await exec(invocation.command, invocation.args, { env: invocation.env, timeout: 30_000, maxBuffer: 1024 ** 2 }); }
  catch (error) {
    if ((error as { code?: unknown }).code === 1 && /no such (object|container)/i.test(String((error as { stderr?: string }).stderr ?? ''))) return;
    throw new Error('The private runtime could not confirm that the archived container is absent.');
  }
  throw new Error('An old or replacement container still exists; its environment has not been adopted as removed.');
}

/** Adopt maintenance preservation through the same durable product records as normal retirement. */
export async function importFactoryEnvironmentArchives(input: {
  dataDir: string;
  store: Pick<Store, 'list' | 'get' | 'set' | 'append' | 'transaction'>;
  sessions: Pick<SessionController, 'owns' | 'record' | 'canRetireEnvironment'>;
  endpoint: DockerRuntimeEndpoint;
  assertCurrent?: () => void;
}): Promise<{ imported: number; deferred: number; skipped: number }> {
  const summary = { imported: 0, deferred: 0, skipped: 0 };
  const inbox = path.join(input.dataDir, 'provider-history-imports');
  try { await lstat(inbox); await privateDirectory(input.dataDir, inbox); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summary;
    input.store.set(factoryArchiveImportBucket, { id: 'inbox', status: 'deferred', updatedAt: new Date().toISOString(),
      reason: 'The archive import inbox is not accessible private storage.' } satisfies FactoryArchiveImportRecord);
    ++summary.deferred; return summary;
  }
  for (const filename of (await readdir(inbox)).filter(name => name.endsWith('.json')).sort()) {
    const manifestPath = path.join(inbox, filename);
    let read: PrivateJson, imported: FactoryArchiveImportManifest;
    try { read = await privateJson(manifestPath); imported = manifest(read.value); }
    catch {
      input.store.set(factoryArchiveImportBucket, { id: `manifest:${digest(filename)}`, status: 'deferred',
        updatedAt: new Date().toISOString(), reason: 'The private archive import manifest could not be validated.' } satisfies FactoryArchiveImportRecord);
      ++summary.deferred; continue;
    }
    for (const entry of imported.sessions) {
      const id = `${imported.id}:${entry.sessionId}`, receiptSha256 = digest(JSON.stringify(entry.receipt));
      const previous = input.store.get<FactoryArchiveImportRecord>(factoryArchiveImportBucket, id);
      const record = { id, manifestId: imported.id, sessionId: entry.sessionId, launchGeneration: entry.launchGeneration,
        containerId: entry.receipt.containerId, receiptSha256 };
      try {
        if (previous?.status === 'imported') {
          if (previous.receiptSha256 !== receiptSha256 || previous.launchGeneration !== entry.launchGeneration || previous.containerId !== entry.receipt.containerId)
            throw new Error('An imported manifest identity was reused with different archive evidence.');
          ++summary.skipped; continue;
        }
        const assertIdentity = () => {
          input.assertCurrent?.();
          const session = input.sessions.record(entry.sessionId);
          const launch = input.store.get<Launch>('session-launch', entry.sessionId);
          const saved = input.store.get<SavedSession>('session-private', entry.sessionId);
          if (!input.sessions.owns(entry.sessionId) || !input.sessions.canRetireEnvironment(entry.sessionId) || !launch || !saved || launch.generation !== entry.launchGeneration
            || launch.dockerHost !== input.endpoint.host || saved.ready.dockerHost !== input.endpoint.host
            || launch.projectPath !== saved.projectPath || !['stopped', 'failed', 'unknown'].includes(session.status)
            || session.containerId != null && session.containerId !== saved.ready.instance)
            throw new Error('Archive import no longer matches its owned terminal environment generation.');
          const expected = { sessionId: entry.sessionId, container: saved.ready.instance, name: saved.ready.instance,
            project: saved.ready.project, sessionName: saved.ready.session, projectPath: launch.projectPath,
            branch: saved.ready.branch, workdir: saved.ready.workdir };
          if (!isDeepStrictEqual(entry.receipt.identity, expected)) throw new Error('Archive import belongs to a different saved environment identity.');
          if (input.store.list<Chat>('chats').some(chat => chat.sessionId === entry.sessionId && ['running', 'waiting'].includes(chat.status)))
            throw new Error('An agent conversation still owns this environment.');
          const retired = input.store.get<Retirement>('session-container-retirement', entry.sessionId);
          if (retired && (retired.status === 'restored' || retired.name !== saved.ready.instance || retired.containerId !== entry.receipt.containerId
            || retired.status === 'removed' && retired.receipt && !isDeepStrictEqual(retired.receipt, entry.receipt)))
            throw new Error('A newer environment retirement or restoration already owns this session.');
          return { identity: `${launch.generation}:${saved.ready.instance}`, name: saved.ready.instance };
        };
        assertIdentity();
        const directory = path.join(input.dataDir, 'provider-history', entry.sessionId, entry.receipt.containerId);
        await privateDirectory(input.dataDir, directory);
        const canonicalPath = path.join(directory, 'preservation.json');
        const canonical = await privateJson(canonicalPath);
        if (!isDeepStrictEqual(canonical.value, entry.receipt)) throw new Error('The canonical preservation receipt differs from the import manifest.');
        await validateStoppedFactoryContainerArchives(entry.receipt, input.dataDir);
        await requireAbsent(input.endpoint, entry.receipt.containerId);
        await requireAbsent(input.endpoint, entry.receipt.identity.name);
        const latestManifest = await privateJson(manifestPath), latestCanonical = await privateJson(canonicalPath);
        if (latestManifest.sha256 !== read.sha256 || latestManifest.inode !== read.inode || latestManifest.device !== read.device
          || latestCanonical.sha256 !== canonical.sha256 || latestCanonical.inode !== canonical.inode || latestCanonical.device !== canonical.device)
          throw new Error('Archive import evidence changed during verification.');
        const current = assertIdentity(), updatedAt = new Date().toISOString();
        let adopted = false;
        input.store.transaction(() => {
          assertIdentity();
          const currentImport = input.store.get<FactoryArchiveImportRecord>(factoryArchiveImportBucket, id);
          if (currentImport?.status === 'imported') {
            if (currentImport.receiptSha256 !== receiptSha256 || currentImport.launchGeneration !== entry.launchGeneration || currentImport.containerId !== entry.receipt.containerId)
              throw new Error('An imported manifest identity changed during adoption.');
            return;
          }
          input.store.set('session-container-retirement', { id: entry.sessionId, name: current.name, containerId: entry.receipt.containerId,
            status: 'removed', receipt: entry.receipt, archive: entry.receipt.archive, sha256: entry.receipt.sha256, size: entry.receipt.size,
            rawSha256: entry.receipt.rawSha256, rawSize: entry.receipt.rawSize, updatedAt });
          input.store.append('session-environment-history', entry.sessionId, { containerId: entry.receipt.containerId,
            receipt: entry.receipt, retiredAt: updatedAt, sourceImportId: id });
          input.store.set(terminalSessionCleanupBucket, { id: entry.sessionId, identity: current.identity, status: 'removed',
            attempts: 0, updatedAt, removedAt: updatedAt } satisfies TerminalSessionCleanupRecord);
          input.store.set(factoryArchiveImportBucket, { ...record, status: 'imported', updatedAt } satisfies FactoryArchiveImportRecord);
          adopted = true;
        });
        if (adopted) ++summary.imported; else ++summary.skipped;
      } catch (error) {
        // Archive bytes and provider diagnostics never enter this metadata record.
        const reason = error instanceof Error ? error.message : 'Archive adoption could not be confirmed.';
        input.store.set(factoryArchiveImportBucket, { ...(previous?.status === 'imported' ? previous : record),
          status: previous?.status === 'imported' ? 'imported' : 'deferred', updatedAt: new Date().toISOString(), reason: reason.slice(0, 2048) } satisfies FactoryArchiveImportRecord);
        ++summary.deferred;
      }
    }
  }
  return summary;
}
