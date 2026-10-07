import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Session } from '@enoughfactory/contracts';
import type { FactoryStore } from '@enoughfactory/factory';
import { writeAtomic, type ArtifactStore, type WorkingDirectoryManager, type WorkingDirectorySource } from '@enoughfactory/workspaces';
import type { SessionController } from './sessions.ts';

/** Release generated controller inputs only when their container is conclusively terminal. */
export async function releaseControllerInputs(input: {
  operation: string; sessionId?: string; dataDir: string; store: FactoryStore;
  sessions: Pick<SessionController, 'record' | 'owns' | 'stop' | 'waitStopped' | 'needsTermination' | 'assertCanArchive'>;
  directoryManager: WorkingDirectoryManager; artifacts: ArtifactStore;
}): Promise<void> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operation)) throw new Error('Invalid controller input ownership.');
  const projectId = `workspace-${input.operation}`;
  // create() can persist a session and then throw before returning its identity.
  const matches = input.store.list<Session>('sessions').filter(session => session.projectId === projectId);
  if (matches.length > 1) throw new Error('Controller environment ownership is ambiguous; inputs are retained.');
  const sessionId = input.sessionId ?? matches[0]?.id;
  if (sessionId) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(sessionId)) throw new Error('Invalid controller environment identity.');
    const session = input.sessions.record(sessionId);
    if (session.projectId !== projectId || !input.sessions.owns(sessionId)) throw new Error('Controller environment ownership is unconfirmed; inputs are retained.');
    if (session.status !== 'stopped') {
      if (session.status !== 'stopping') await input.sessions.stop(sessionId);
      await input.sessions.waitStopped(sessionId);
    }
    if (input.sessions.record(sessionId).status !== 'stopped' || input.sessions.needsTermination(sessionId)) throw new Error('Controller termination is unconfirmed; inputs are retained.');
    input.sessions.assertCanArchive(sessionId);
  }

  const workspaceData = path.join(input.dataDir, 'workspace-data');
  const identities = [`${input.operation}-project-context`, `${input.operation}-evidence-context`, ...(sessionId ? [sessionId] : [])];
  const retained = [];
  const verified = new Set<string>();
  const launch = sessionId ? input.store.get<{ id: string; workingDirectorySources?: WorkingDirectorySource[] }>('session-launch', sessionId) : undefined;
  for (const identity of identities) {
    const directory = path.join(workspaceData, 'working-directories', identity);
    try { const entry = await lstat(directory); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Controller input directory is not owned.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // The manager verifies identity, source contracts and every private path.
    const snapshots = await input.directoryManager.sourceSnapshots(identity);
    const journal = JSON.parse(await readFile(path.join(directory, 'snapshots.json'), 'utf8'));
    for (const snapshot of snapshots) {
      if (identity === sessionId && !launch?.workingDirectorySources?.some(source => source.id === snapshot.id && source.baseCommit === snapshot.baseCommit && isDeepStrictEqual(source.sourceArtifact, snapshot.sourceArtifact))) throw new Error('Controller restart sources are not retained; inputs are preserved.');
      const manifest = await input.artifacts.get(snapshot.sourceArtifact.id);
      if (!isDeepStrictEqual(manifest, snapshot.sourceArtifact)) throw new Error('Controller source manifest is not durably retained.');
      if (!verified.has(manifest.sha256)) { await input.artifacts.path(manifest); verified.add(manifest.sha256); }
    }
    retained.push({ identity, directory, journal });
  }

  // Archive the small journals outside the reusable snapshot identities. Leaving
  // snapshots.json beside removed roots would break ordinary session restart.
  const receiptDirectory = path.join(workspaceData, 'controller-input-receipts', input.operation);
  if (retained.length) await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  for (const item of retained) await writeAtomic(path.join(receiptDirectory, `${item.identity}.json`), {
    version: 1, operation: input.operation, sessionId, identity: item.identity, journal: item.journal,
  });
  const ownership = input.store.get<{ id: string }>('factory-controller-inputs', input.operation);
  input.store.set('factory-controller-inputs', { ...ownership, id: input.operation, sessionId, status: 'releasing', identities: retained.map(item => item.identity), receiptDirectory, updatedAt: new Date().toISOString() });
  for (const item of retained) await rm(item.directory, { recursive: true, force: true });
  input.store.set('factory-controller-inputs', { ...ownership, id: input.operation, sessionId, status: 'released', identities: retained.map(item => item.identity), receiptDirectory, updatedAt: new Date().toISOString() });
}
