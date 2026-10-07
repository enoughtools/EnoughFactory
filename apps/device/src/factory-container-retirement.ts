import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import type { RuntimeKind } from '@enoughfactory/contracts';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { hashFile } from '@enoughfactory/workspaces';
import { exec } from './util.ts';
import { FactoryArchiveDependencyError, FactoryArchiveFilter } from './factory-archive-filter.ts';
import { captureTarCas, validateTarCasArchive, validatedTarCasReadable } from './factory-archive-cas.ts';

interface ContainerInspection {
  Id: string; Name: string; Created: string;
  State: { Running: boolean; Paused: boolean; Restarting: boolean; Dead: boolean; Pid: number; Status: string; StartedAt: string; FinishedAt: string; ExitCode: number };
  Config: { Labels: Record<string, string> };
  Mounts?: ContainerMount[];
}
interface ContainerMount { Type: string; Name?: string; Source: string; Destination: string; RW: boolean; Driver?: string; }
export interface RetirementIdentity {
  sessionId: string; container: string; name: string; project: string; sessionName: string;
  projectPath: string; branch: string; workdir: string;
}
interface Receipt {
  version: 1; status: 'archived' | 'removed'; identity: RetirementIdentity; containerId: string;
  fingerprint: unknown; runtime: 'codex'; source: '/root/.codex'; archive: string; sha256: string; size: number; rawSha256: string; rawSize: number; entries: number;
}

async function privateDirectory(anchor: string, directory: string): Promise<void> {
  const relative = path.relative(anchor, directory), uid = process.getuid?.();
  if (uid === undefined || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Provider history path is outside its owned storage.');
  let current = anchor;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const entry = await lstat(current);
    if (entry.uid !== uid || !entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error('Provider history requires private owned directories.');
  }
  if (await realpath(directory) !== path.join(await realpath(anchor), relative)) throw new Error('Provider history path changed ownership.');
}
function fingerprint(container: ContainerInspection, expected: RetirementIdentity, ephemeral = false): unknown {
  const labels = container.Config?.Labels;
  if (!/^[a-f0-9]{64}$/.test(container.Id) || container.Name !== `/${expected.name}` || !container.Created
    || labels?.['envmux.schema'] !== '2' || labels['envmux.kind'] !== 'session' || labels['envmux.service'] || labels['envmux.instance'] !== expected.name
    || labels['envmux.project'] !== expected.project || labels['envmux.session'] !== expected.sessionName
    || labels['envmux.directory'] !== expected.projectPath || labels['envmux.branch'] !== expected.branch || labels['envmux.workdir'] !== expected.workdir) {
    throw new Error('The stopped worker container no longer matches its exact envmux ownership.');
  }
  if (container.State.Running || container.State.Paused || container.State.Restarting || container.State.Dead || container.State.Pid !== 0 || !['exited', ...(ephemeral ? ['created'] : [])].includes(container.State.Status)) throw new Error('The worker container is not conclusively stopped.');
  return { id: container.Id, name: container.Name, created: container.Created, state: container.State, labels: {
    schema: labels['envmux.schema'], kind: labels['envmux.kind'], instance: labels['envmux.instance'], project: labels['envmux.project'],
    session: labels['envmux.session'], directory: labels['envmux.directory'], branch: labels['envmux.branch'], workdir: labels['envmux.workdir'],
  } };
}
async function inspect(endpoint: DockerRuntimeEndpoint, reference: string): Promise<ContainerInspection | undefined> {
  const invocation = dockerInvocation(endpoint, ['inspect', '--type', 'container', reference]);
  let stdout: string;
  try { stdout = (await exec(invocation.command, invocation.args, { env: invocation.env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout; }
  catch (error) {
    if (/no such (object|container)/i.test(String((error as { stderr?: string }).stderr ?? ''))) return undefined;
    throw new Error('Could not inspect the owned worker container; it has been retained.');
  }
  const containers = JSON.parse(stdout) as ContainerInspection[];
  if (!Array.isArray(containers) || containers.length !== 1) throw new Error('The worker container identity is ambiguous.');
  return containers[0];
}
const RAW_LIMIT=1024**3,COMPRESSED_LIMIT=512*1024**2;
async function streamCodexHistory(endpoint: DockerRuntimeEndpoint, containerId: string, filename: string,assertSpace:()=>void): Promise<{rawSha256:string;rawSize:number}> {
  assertSpace();
  const file = await open(filename, 'wx', 0o600);
  const invocation = dockerInvocation(endpoint, ['cp', `${containerId}:/root/.codex`, '-']);
  const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  // Provider state and Docker diagnostics may contain secrets. Neither enters logs.
  child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not archive the worker provider history.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Worker provider history archive failed; its container is retained.')));
  });
  const rawHash=createHash('sha256');let rawSize=0,compressedSize=0;
  const raw=new Transform({transform(chunk:Buffer,_encoding,callback){rawSize+=chunk.length;if(rawSize>RAW_LIMIT)return callback(new Error('Worker provider history exceeds its retained archive limit; the container is retained.'));rawHash.update(chunk);callback(null,chunk);}});
  const compressed=new Transform({transform(chunk:Buffer,_encoding,callback){compressedSize+=chunk.length;if(compressedSize>COMPRESSED_LIMIT)return callback(new Error('Compressed worker provider history exceeds its storage limit; the container is retained.'));try{assertSpace();callback(null,chunk);}catch(error){callback(error as Error);}}});
  try {
    const output=new Writable({write(chunk:Buffer,_encoding,callback){file.writeFile(chunk).then(()=>callback(),error=>callback(error));}});
    await Promise.all([pipeline(child.stdout,raw,createGzip({level:6}),compressed,output), exited]);
    await file.sync();
    return {rawSha256:rawHash.digest('hex'),rawSize};
  } catch (error) { child.kill('SIGTERM'); await exited.catch(() => {}); throw error; }
  finally { await file.close(); }
}
async function validateArchive(filename: string): Promise<{ sha256: string; size: number; rawSha256:string;rawSize:number;entries: number }> {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) throw new Error('Provider history archive is not a private owned file.');
  if (entry.size < 20 || entry.size>COMPRESSED_LIMIT) throw new Error('Provider history archive size is outside its storage limit.');
  // Bound decompression before asking tar to inspect headers, including on replay.
  const rawHash=createHash('sha256');let rawSize=0;
  await pipeline(createReadStream(filename),createGunzip(),new Writable({write(chunk:Buffer,_encoding,callback){rawSize+=chunk.length;if(rawSize>RAW_LIMIT)return callback(new Error('Provider history archive expands beyond its retained limit.'));rawHash.update(chunk);callback();}}));
  let stdout: string;
  try { stdout = (await exec('/usr/bin/tar', ['-tzf', filename], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout; }
  catch { throw new Error('Provider history archive is incomplete; its container is retained.'); }
  const entries = stdout.split('\n').filter(Boolean);
  if (entries.length < 2 || entries.some(name => !/^\.codex(?:\/|$)/.test(name) || name.split('/').includes('..'))) throw new Error('Provider history archive does not contain the expected Codex state.');
  const hash = await hashFile(filename);
  return { ...hash,rawSha256:rawHash.digest('hex'),rawSize,entries: entries.length };
}
async function saveReceipt(filename: string, receipt: unknown): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Only the successful worker release calls this, while holding its stopped-session lease. */
export interface FactoryContainerRetirementInput {
  endpoint: DockerRuntimeEndpoint; dataDir: string; identity: RetirementIdentity; assertCurrent: () => void;
  pinnedContainerId?: string; pinContainerId: (containerId: string) => void;
  assertSpace:()=>void;
  preservation?: { runtimeKinds: RuntimeKind[]; includeWorkAndHome: true; removeOwnedVolumes: true; additionalPaths?: string[] };
}
export async function retireStoppedFactoryContainer(input: FactoryContainerRetirementInput): Promise<Receipt | EphemeralContainerReceipt> {
  if (input.preservation) return retireEphemeralContainer(input);
  const expected = input.identity;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(expected.sessionId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(expected.name)) throw new Error('Invalid worker retirement identity.');
  input.assertCurrent();
  if (input.pinnedContainerId && !/^[a-f0-9]{64}$/.test(input.pinnedContainerId)) throw new Error('Invalid retained worker container identity.');
  const original = await inspect(input.endpoint, input.pinnedContainerId ?? expected.container);
  const containerId = original?.Id ?? input.pinnedContainerId ?? expected.container;
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error('Worker retirement requires its retained full container identity.');
  const pinned = original ? fingerprint(original, expected) : undefined;
  if (input.pinnedContainerId && input.pinnedContainerId !== containerId) throw new Error('The retained worker container identity changed.');
  input.pinContainerId(containerId);
  const directory = path.join(input.dataDir, 'provider-history', expected.sessionId, containerId);
  await privateDirectory(input.dataDir, directory);
  const receiptPath = path.join(directory, 'receipt.json'), archive = path.join(directory, 'codex.tar.gz');
  let receipt: Receipt | undefined, storedReceipt: Receipt | undefined;
  try {
    const entry = await lstat(receiptPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) throw new Error('Provider history receipt is not privately owned.');
    storedReceipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Missing archive bytes are never equivalent to a missing optional receipt.
  // Publish a reusable receipt only after all retained content has verified.
  if(storedReceipt){
    if (storedReceipt.version !== 1 || storedReceipt.containerId !== containerId || storedReceipt.runtime !== 'codex' || storedReceipt.source !== '/root/.codex' || storedReceipt.archive !== archive || !isDeepStrictEqual(storedReceipt.identity, expected)
      || !['archived', 'removed'].includes(storedReceipt.status) || !isDeepStrictEqual(await validateArchive(archive), { sha256: storedReceipt.sha256, size: storedReceipt.size,rawSha256:storedReceipt.rawSha256,rawSize:storedReceipt.rawSize,entries: storedReceipt.entries })) throw new Error('Provider history receipt does not match this worker.');
    receipt=storedReceipt;
  }
  if (!original) {
    if (!receipt) throw new Error('The worker container is missing without retained provider history.');
    receipt = { ...receipt, status: 'removed' }; await saveReceipt(receiptPath, receipt); return receipt;
  }
  if (receipt && !isDeepStrictEqual(receipt.fingerprint, pinned)) throw new Error('The worker ran again after its provider history was archived; it is retained.');
  if (!receipt) {
    try { await lstat(archive); throw new Error('An unrecorded provider archive already exists; the worker is retained.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const staging = path.join(directory, `.codex-${randomUUID()}.tar.gz`);
    try {
      const streamed=await streamCodexHistory(input.endpoint, containerId, staging,input.assertSpace);
      const retained = await validateArchive(staging);
      if(retained.rawSha256!==streamed.rawSha256||retained.rawSize!==streamed.rawSize)throw new Error('Retained provider history does not reproduce its original streamed content.');
      // Never overwrite a previous unknown archive, even after a service restart.
      try { await lstat(archive); throw new Error('An unrecorded provider archive already exists; the worker is retained.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(staging, archive);
      receipt = { version: 1, status: 'archived', identity: expected, containerId, fingerprint: pinned, runtime: 'codex', source: '/root/.codex', archive, ...retained };
      await saveReceipt(receiptPath, receipt);
    } finally { await rm(staging, { force: true }); }
  }
  input.assertCurrent();
  const latest = await inspect(input.endpoint, containerId);
  if (!latest || !isDeepStrictEqual(fingerprint(latest, expected), pinned)) throw new Error('The worker container changed while its history was archived; it is retained.');
  input.assertCurrent();
  const invocation = dockerInvocation(input.endpoint, ['rm', containerId]);
  try { await exec(invocation.command, invocation.args, { env: invocation.env, timeout: 60_000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('Worker container retirement was not confirmed; its provider archive is retained.'); }
  if (await inspect(input.endpoint, containerId)) throw new Error('The worker container still exists after retirement; its provider archive is retained.');
  receipt = { ...receipt, status: 'removed' }; await saveReceipt(receiptPath, receipt); return receipt;
}

interface ArchiveDigest { sha256: string; size: number; rawSha256: string; rawSize: number; entries: number; }
export interface PreservedContainerArchive extends ArchiveDigest {
  source: string; root: string; archive: string; exclusions: string[]; cacheExclusionsDeferred?: true;
  storage?: 'cas-tar-v1'; compressedSize?: number; uniqueCompressedSize?: number; blobCount?: number;
}
interface VolumeInspection {
  Name: string; Driver: string; Scope: string; CreatedAt: string; Labels: Record<string, string>; Options: Record<string, string> | null;
}
interface PreservedVolume { name: string; identity: VolumeInspection; status: 'retained' | 'removed'; }
export interface EphemeralContainerReceipt extends ArchiveDigest {
  version: 2; status: 'archived' | 'removed'; identity: RetirementIdentity; containerId: string; fingerprint: unknown;
  runtime: 'ephemeral'; archive: string; archives: PreservedContainerArchive[]; ownedVolumes: PreservedVolume[];
  runtimeKinds: RuntimeKind[]; exclusions: string[];
}
interface CaptureProgress {
  version: 1; identity: RetirementIdentity; containerId: string; fingerprint: unknown; sources: string[];
  archives: PreservedContainerArchive[]; ownedVolumes: PreservedVolume[]; runtimeKinds: RuntimeKind[];
  staging?: string; pending?: PreservedContainerArchive;
}

const EPHEMERAL_RAW_LIMIT = 64 * 1024 ** 3, EPHEMERAL_COMPRESSED_LIMIT = 16 * 1024 ** 3;
const REPRODUCIBLE_PATHS = ['/root/.npm', '/root/.cache', '/root/.codex/plugins/cache', '/opt/enoughfactory/node', '/opt/enoughfactory/antigravity'];
function containerPath(source: string): string {
  if (!source.startsWith('/') || source === '/' || source.includes('\0') || source !== path.posix.normalize(source) || source.split('/').includes('..')) throw new Error('A preserved container source must be an exact absolute non-root path.');
  return source;
}
function within(source: string, parent: string): boolean { return source === parent || source.startsWith(`${parent}/`); }
function excludedMembers(source: string): string[] {
  const parent = path.posix.dirname(source);
  return REPRODUCIBLE_PATHS.filter(excluded => within(excluded, source)).map(excluded => path.posix.relative(parent, excluded));
}
function mounts(container: ContainerInspection): ContainerMount[] {
  if (!Array.isArray(container.Mounts)) throw new Error('The stopped container mount ownership is unavailable.');
  return container.Mounts.map(mount => {
    if (!mount || !['volume', 'bind', 'tmpfs'].includes(mount.Type) || typeof mount.RW !== 'boolean'
      || mount.Type === 'volume' && !mount.Name || mount.Type === 'bind' && (!mount.Source?.startsWith('/') || mount.Source.includes('\0'))) throw new Error('The container has an unsupported mount; its data is retained.');
    return { Type: mount.Type, ...(mount.Name ? { Name: mount.Name } : {}), Source: mount.Source, Destination: containerPath(mount.Destination), RW: mount.RW, ...(mount.Driver ? { Driver: mount.Driver } : {}) };
  }).sort((left, right) => left.Destination.localeCompare(right.Destination));
}
function ephemeralFingerprint(container: ContainerInspection, expected: RetirementIdentity): unknown {
  return { container: fingerprint(container, expected, true), mounts: mounts(container) };
}
async function docker(endpoint: DockerRuntimeEndpoint, args: string[]): Promise<string> {
  const invocation = dockerInvocation(endpoint, args);
  return (await exec(invocation.command, invocation.args, { env: invocation.env, timeout: 60_000, maxBuffer: 8 * 1024 ** 2 })).stdout;
}
async function inspectVolume(endpoint: DockerRuntimeEndpoint, name: string): Promise<VolumeInspection | undefined> {
  let stdout: string;
  try { stdout = await docker(endpoint, ['volume', 'inspect', name]); }
  catch (error) { if (/no such volume/i.test(String((error as { stderr?: string }).stderr ?? ''))) return undefined; throw new Error('Could not confirm the exact owned session volume; it is retained.'); }
  const volumes = JSON.parse(stdout) as VolumeInspection[];
  if (!Array.isArray(volumes) || volumes.length !== 1) throw new Error('Session volume ownership is ambiguous.');
  const volume = volumes[0]!;
  return { Name: volume.Name, Driver: volume.Driver, Scope: volume.Scope, CreatedAt: volume.CreatedAt, Labels: volume.Labels, Options: volume.Options ?? null };
}
function ownedVolume(volume: VolumeInspection, expected: RetirementIdentity, role: 'home' | 'work'): void {
  const labels = volume.Labels;
  if (volume.Name !== `${expected.name}-${role}` || volume.Driver !== 'local' || volume.Scope !== 'local' || !volume.CreatedAt
    || volume.Options && Object.keys(volume.Options).length || labels?.['envmux.schema'] !== '2' || labels['envmux.instance'] !== expected.name
    || labels['envmux.project'] !== expected.project || labels['envmux.session'] !== expected.sessionName || labels['envmux.service']
    || labels['envmux.directory'] !== expected.projectPath || labels['envmux.branch'] !== expected.branch || labels['envmux.volume'] !== role) throw new Error('A session volume does not match its exact envmux ownership; it is retained.');
}
async function volumeReferences(endpoint: DockerRuntimeEndpoint, name: string): Promise<string[]> {
  const stdout = await docker(endpoint, ['ps', '--all', '--no-trunc', '--filter', `volume=${name}`, '--format', '{{.ID}}']);
  const ids = stdout.split('\n').map(value => value.trim()).filter(Boolean);
  if (ids.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Session volume references are ambiguous.');
  return ids;
}
async function confirmVolumes(input: FactoryContainerRetirementInput, volumes: PreservedVolume[], selected?: string): Promise<void> {
  for (const retained of volumes) {
    const current = await inspectVolume(input.endpoint, retained.name);
    if (!current) {
      if (retained.status === 'removed') continue;
      // A receipt proves its complete bytes before a previous volume removal.
      if (!selected) continue;
      throw new Error('The stopped container lost a volume before preservation completed.');
    }
    if (!isDeepStrictEqual(current, retained.identity)) throw new Error('A retained session volume changed ownership.');
    const references = await volumeReferences(input.endpoint, retained.name);
    if (references.some(reference => reference !== selected)) throw new Error('Another container references this session volume; it is retained.');
  }
}
async function confirmNoActiveMountWriters(input: FactoryContainerRetirementInput, container: ContainerInspection): Promise<void> {
  const sources = mounts(container).filter(mount => mount.Type !== 'tmpfs');
  if (!sources.length) return;
  const ids = (await docker(input.endpoint, ['ps', '--all', '--no-trunc', '--format', '{{.ID}}'])).split('\n').map(value => value.trim()).filter(Boolean).filter(value => value !== container.Id);
  if (ids.length > 1024 || ids.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Container mount sharing cannot be confirmed.');
  if (!ids.length) return;
  const format = '{"id":{{json .Id}},"state":{{json .State}},"mounts":{{json .Mounts}}}';
  const lines = (await docker(input.endpoint, ['inspect', '--type', 'container', '--format', format, ...ids])).split('\n').filter(Boolean);
  if (lines.length !== ids.length) throw new Error('Container mount sharing changed during preservation.');
  for (const line of lines) {
    const other = JSON.parse(line) as { id: string; state: ContainerInspection['State']; mounts: ContainerMount[] };
    if (!ids.includes(other.id) || !Array.isArray(other.mounts) || !other.state) throw new Error('Container mount sharing is invalid.');
    if (!other.state.Running && !other.state.Paused && !other.state.Restarting && other.state.Pid === 0) continue;
    if (other.mounts.some(mount => mount.RW && sources.some(source => source.Type === mount.Type && (source.Type === 'volume' ? source.Name === mount.Name
      : source.Source === '/' || mount.Source === '/' || within(source.Source, mount.Source) || within(mount.Source, source.Source))))) throw new Error('An active container can write this session mount; its data is retained.');
  }
}
async function archiveContainerPath(input: FactoryContainerRetirementInput, containerId: string, source: string, filename: string, preserveCacheDependencies = false): Promise<ArchiveDigest & { exclusions: string[]; cacheExclusionsDeferred?: true; storage?: 'cas-tar-v1'; compressedSize?: number; uniqueCompressedSize?: number; blobCount?: number }> {
  input.assertSpace();
  const exclusions = preserveCacheDependencies ? [] : excludedMembers(source);
  const invocation = dockerInvocation(input.endpoint, ['cp', `${containerId}:${source}`, '-']);
  const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000 });
  child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Error('Could not preserve stopped session files.')));
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Stopped session file capture failed; the container is retained.')));
  });
  let inputSize = 0;
  const admitted = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    inputSize += chunk.length;
    callback(inputSize > EPHEMERAL_RAW_LIMIT ? new Error('Stopped session files exceed the preservation limit; the container is retained.') : null, chunk);
  } });
  const filtered = new FactoryArchiveFilter(path.posix.basename(source), exclusions);
  const streamed = pipeline(child.stdout, admitted, filtered);
  const captured = captureTarCas(filtered, filename, input.dataDir, input.assertSpace);
  try {
    const [digest] = await Promise.all([captured, streamed, exited]);
    const verified = await validateTarCasArchive(filename, input.dataDir);
    if (!isDeepStrictEqual(digest, verified)) throw new Error('Preserved session files do not reproduce their captured content.');
    return { ...digest, exclusions, ...(preserveCacheDependencies ? { cacheExclusionsDeferred: true as const } : {}) };
  } catch (error) {
    child.kill('SIGTERM'); filtered.destroy(); admitted.destroy(); child.stdout.destroy();
    await Promise.allSettled([captured, streamed, exited]);
    if (error instanceof FactoryArchiveDependencyError && !preserveCacheDependencies) {
      await rm(filename, { force: true });
      return await archiveContainerPath(input, containerId, source, filename, true);
    }
    throw error;
  }
}
async function validatePreservedArchive(filename: string, root: string, exclusions: string[]): Promise<ArchiveDigest> {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0 || entry.size < 20 || entry.size > EPHEMERAL_COMPRESSED_LIMIT) throw new Error('Preserved session archive is not a private owned file.');
  const rawHash = createHash('sha256'); let rawSize = 0;
  // Verify both the compressed bytes and the full filtered tar stream on replay.
  await pipeline(createReadStream(filename), createGunzip(), new Transform({ transform(chunk: Buffer, _encoding, callback) {
    rawSize += chunk.length;
    if (rawSize > EPHEMERAL_RAW_LIMIT) return callback(new Error('Preserved session archive exceeds its expanded limit.'));
    rawHash.update(chunk); callback(null, chunk);
  } }), new FactoryArchiveFilter(root, []), new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
  let stdout: string;
  try { stdout = (await exec('/usr/bin/tar', ['-tzf', filename], { timeout: 600_000, maxBuffer: 32 * 1024 ** 2 })).stdout; }
  catch { throw new Error('Preserved session archive is incomplete.'); }
  const entries = stdout.split('\n').filter(Boolean);
  if (!entries.length || entries.some(name => exclusions.some(excluded => name === excluded || name.startsWith(`${excluded}/`)))) throw new Error('A reproducible cache was unexpectedly retained in the session archive.');
  return { ...await hashFile(filename), rawSha256: rawHash.digest('hex'), rawSize, entries: entries.length };
}
function expectedArchiveDigest(archive: PreservedContainerArchive): ArchiveDigest & Partial<Pick<PreservedContainerArchive, 'storage' | 'compressedSize' | 'uniqueCompressedSize' | 'blobCount'>> {
  return { sha256: archive.sha256, size: archive.size, rawSha256: archive.rawSha256, rawSize: archive.rawSize, entries: archive.entries,
    ...(archive.storage === 'cas-tar-v1' ? { storage: archive.storage, compressedSize: archive.compressedSize, uniqueCompressedSize: archive.uniqueCompressedSize, blobCount: archive.blobCount } : {}) };
}
async function validateArchivePayload(archive: PreservedContainerArchive, dataDir: string): Promise<ReturnType<typeof expectedArchiveDigest>> {
  if (archive.storage === undefined) return validatePreservedArchive(archive.archive, archive.root, archive.exclusions);
  if (archive.storage !== 'cas-tar-v1') throw new Error('Stopped session archive storage format is unsupported.');
  const digest = await validateTarCasArchive(archive.archive, dataDir), input = await validatedTarCasReadable(archive.archive, dataDir);
  const raw = createHash('sha256'); let rawSize = 0;
  // A manifest has the same exact tar semantics as its gzip predecessor. Check
  // member ownership and declared cache exclusions before exposing recovery.
  await pipeline(input, new FactoryArchiveFilter(archive.root, archive.exclusions), new Writable({ write(chunk: Buffer, _encoding, callback) {
    rawSize += chunk.length; raw.update(chunk); callback(rawSize > EPHEMERAL_RAW_LIMIT ? new Error('Preserved source exceeds its expanded limit.') : undefined);
  } }));
  if (raw.digest('hex') !== digest.rawSha256 || rawSize !== digest.rawSize) throw new Error('Preserved source contains undeclared excluded cache content.');
  return digest;
}

/** Return the exact preserved tar stream without requiring a duplicate raw tar. */
export async function openPreservedContainerTar(archive: PreservedContainerArchive, dataDir: string): Promise<Readable> {
  await privateDirectory(dataDir, path.dirname(archive.archive));
  if (!isDeepStrictEqual(await validateArchivePayload(archive, dataDir), expectedArchiveDigest(archive))) throw new Error('Preserved source does not match its recovery receipt.');
  return archive.storage === 'cas-tar-v1' ? await validatedTarCasReadable(archive.archive, dataDir) : createReadStream(archive.archive).pipe(createGunzip());
}

/** Validate before recovery; callers separately own the fresh destination container lease. */
export async function validateStoppedFactoryContainerArchives(receipt: EphemeralContainerReceipt, dataDir: string): Promise<void> {
  const directory = path.join(dataDir, 'provider-history', receipt.identity.sessionId, receipt.containerId);
  await privateDirectory(dataDir, directory);
  if (receipt.version !== 2 || !/^[a-f0-9]{64}$/.test(receipt.containerId) || !receipt.archives?.length || !['archived', 'removed'].includes(receipt.status)) throw new Error('Stopped session preservation receipt is invalid.');
  await validateArchiveList(receipt.archives, directory, dataDir);
  const primary = receipt.archives[0]!;
  if (receipt.archive !== primary.archive || receipt.sha256 !== primary.sha256 || receipt.size !== primary.size || receipt.rawSha256 !== primary.rawSha256 || receipt.rawSize !== primary.rawSize || receipt.entries !== primary.entries) throw new Error('Stopped session archive summary changed.');
  if (!Array.isArray(receipt.ownedVolumes) || new Set(receipt.ownedVolumes.map(volume => volume.name)).size !== receipt.ownedVolumes.length) throw new Error('Preserved volume identities are invalid.');
  for (const volume of receipt.ownedVolumes) {
    const role = volume.name === `${receipt.identity.name}-home` ? 'home' : volume.name === `${receipt.identity.name}-work` ? 'work' : undefined;
    if (!role || !['retained', 'removed'].includes(volume.status)) throw new Error('Preserved volume is not owned by this session.');
    ownedVolume(volume.identity, receipt.identity, role);
  }
}
async function validateArchiveList(archives: PreservedContainerArchive[], directory: string, dataDir: string): Promise<void> {
  for (let index = 0; index < archives.length; index++) {
    const archive = archives[index]!, source = containerPath(archive.source);
    if (archive.root !== path.posix.basename(source) || archive.archive !== path.join(directory, `${String(index).padStart(2, '0')}-${archive.root}.tar.${archive.storage === 'cas-tar-v1' ? 'cas.json' : 'gz'}`)
      || !isDeepStrictEqual(archive.exclusions, archive.cacheExclusionsDeferred === true ? [] : excludedMembers(source))
      || !isDeepStrictEqual(await validateArchivePayload(archive, dataDir), expectedArchiveDigest(archive))) throw new Error('Stopped session archive does not match its preservation receipt.');
  }
}

async function readPrivateJson<T>(filename: string): Promise<T | undefined> {
  try {
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0 || entry.size > 8 * 1024 ** 2) throw new Error('Stopped session preservation journal is not private.');
    return JSON.parse(await readFile(filename, 'utf8')) as T;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function retireEphemeralContainer(input: FactoryContainerRetirementInput): Promise<EphemeralContainerReceipt> {
  const expected = input.identity;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(expected.sessionId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(expected.name)
    || !expected.project || !expected.sessionName || !expected.projectPath || !expected.branch || !Array.isArray(input.preservation?.runtimeKinds)
    || input.preservation.includeWorkAndHome !== true || input.preservation.removeOwnedVolumes !== true
    || input.preservation.runtimeKinds.some(runtime => !['codex', 'claude', 'antigravity'].includes(runtime))) throw new Error('Invalid ephemeral session retirement identity.');
  input.assertCurrent();
  if (input.pinnedContainerId && !/^[a-f0-9]{64}$/.test(input.pinnedContainerId)) throw new Error('Invalid retained container identity.');
  const original = await inspect(input.endpoint, input.pinnedContainerId ?? expected.container);
  const containerId = original?.Id ?? input.pinnedContainerId ?? expected.container;
  if (!/^[a-f0-9]{64}$/.test(containerId) || input.pinnedContainerId && containerId !== input.pinnedContainerId) throw new Error('Ephemeral retirement requires the exact retained full container identity.');
  const pinned = original ? ephemeralFingerprint(original, expected) : undefined;
  input.pinContainerId(containerId);
  const directory = path.join(input.dataDir, 'provider-history', expected.sessionId, containerId);
  await privateDirectory(input.dataDir, directory);
  const receiptPath = path.join(directory, 'preservation.json');
  let receipt: EphemeralContainerReceipt | undefined, stored: EphemeralContainerReceipt | undefined;
  try {
    const entry = await lstat(receiptPath);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) throw new Error('Stopped session preservation receipt is not private.');
    stored = JSON.parse(await readFile(receiptPath, 'utf8')) as EphemeralContainerReceipt;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (stored) {
    if (!isDeepStrictEqual(stored.identity, expected) || stored.containerId !== containerId || !isDeepStrictEqual(stored.exclusions, REPRODUCIBLE_PATHS)) throw new Error('Stopped session preservation receipt belongs to another container.');
    await validateStoppedFactoryContainerArchives(stored, input.dataDir);
    receipt = stored;
    if (original && !isDeepStrictEqual(receipt.fingerprint, pinned)) throw new Error('The container ran or changed mounts after its files were preserved.');
  }
  if (!receipt) {
    if (!original) throw new Error('The container is missing without preserved work and history.');
    const sourceMounts = mounts(original), ownedVolumes: PreservedVolume[] = [];
    for (const mount of sourceMounts.filter(mount => mount.Type === 'volume')) {
      const role = mount.Name === `${expected.name}-home` ? 'home' : mount.Name === `${expected.name}-work` ? 'work' : undefined;
      if (!role) continue; // Shared and external volumes are never deleted here.
      if (mount.Destination !== (role === 'home' ? '/home' : expected.workdir)) throw new Error('An owned session volume is mounted at an unexpected path.');
      const volume = await inspectVolume(input.endpoint, mount.Name!);
      if (!volume) throw new Error('The owned session volume disappeared before preservation.');
      ownedVolume(volume, expected, role); ownedVolumes.push({ name: volume.Name, identity: volume, status: 'retained' });
    }
    await confirmVolumes(input, ownedVolumes, containerId);
    await confirmNoActiveMountWriters(input, original);
    const sources = [...new Set([containerPath(expected.workdir), '/home', '/root', ...sourceMounts.filter(mount => mount.RW && mount.Type !== 'tmpfs').map(mount => mount.Destination), ...(input.preservation!.additionalPaths ?? []).map(containerPath)])]
      .filter(source => !REPRODUCIBLE_PATHS.some(excluded => within(source, excluded)));
    const progressPath = path.join(directory, 'capture-progress.json');
    let progress = await readPrivateJson<CaptureProgress>(progressPath);
    if (progress) {
      if (progress.version !== 1 || progress.containerId !== containerId || !isDeepStrictEqual(progress.identity, expected)
        || !isDeepStrictEqual(progress.fingerprint, pinned) || !isDeepStrictEqual(progress.sources, sources)
        || !isDeepStrictEqual(progress.ownedVolumes, ownedVolumes) || !Array.isArray(progress.archives) || progress.archives.length > sources.length) throw new Error('Stopped session capture progress no longer matches its ownership.');
      await validateArchiveList(progress.archives, directory, input.dataDir);
      if (progress.archives.some((archive, index) => archive.source !== sources[index])) throw new Error('Stopped session archive order changed.');
    } else {
      progress = { version: 1, identity: expected, containerId, fingerprint: pinned, sources, archives: [], ownedVolumes, runtimeKinds: [...input.preservation!.runtimeKinds] };
      await saveReceipt(progressPath, progress);
    }
    if (progress.staging) {
      if (path.dirname(progress.staging) !== directory || !/^\.preserve-[a-f0-9-]{36}\.tar\.(?:gz|cas\.json)$/.test(path.basename(progress.staging))) throw new Error('Stopped session staging ownership changed.');
      if (progress.pending) {
        const pending = progress.pending, index = progress.archives.length;
        if (pending.source !== sources[index]) throw new Error('Stopped session pending source changed.');
        try { await validateArchiveList([...progress.archives, pending], directory, input.dataDir); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const staged = await validateArchivePayload({ ...pending, archive: progress.staging }, input.dataDir);
          if (!isDeepStrictEqual(staged, expectedArchiveDigest(pending))) throw new Error('Stopped session pending archive changed.');
          await rename(progress.staging, pending.archive);
          await validateArchiveList([...progress.archives, pending], directory, input.dataDir);
        }
        progress.archives.push(pending);
      }
      try {
        const stage = await lstat(progress.staging);
        if (!stage.isFile() || stage.isSymbolicLink() || stage.uid !== process.getuid?.() || (stage.mode & 0o077) !== 0) throw new Error('Stopped session partial archive is not privately owned.');
        await rm(progress.staging);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      delete progress.staging; delete progress.pending; await saveReceipt(progressPath, progress);
    }
    const archives = progress.archives;
    for (let index = archives.length; index < sources.length; index++) {
      input.assertCurrent();
      const source = sources[index]!, root = path.posix.basename(source), archive = path.join(directory, `${String(index).padStart(2, '0')}-${root}.tar.cas.json`);
      try { await lstat(archive); throw new Error('Unrecorded preserved session bytes already exist; the container is retained.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const staging = path.join(directory, `.preserve-${randomUUID()}.tar.cas.json`);
      progress.staging = staging; await saveReceipt(progressPath, progress);
      try {
        const digest = await archiveContainerPath(input, containerId, source, staging);
        progress.pending = { source, root, archive, ...digest };
        await saveReceipt(progressPath, progress);
        try { await lstat(archive); throw new Error('Unrecorded preserved session bytes already exist; the container is retained.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await rename(staging, archive);
        archives.push(progress.pending);
        delete progress.staging; delete progress.pending; await saveReceipt(progressPath, progress);
      } finally { await rm(staging, { force: true }); }
    }
    const primary = archives[0]!;
    receipt = { version: 2, status: 'archived', identity: expected, containerId, fingerprint: pinned, runtime: 'ephemeral', archives, ownedVolumes,
      runtimeKinds: [...input.preservation!.runtimeKinds], exclusions: [...REPRODUCIBLE_PATHS], archive: primary.archive,
      sha256: primary.sha256, size: primary.size, rawSha256: primary.rawSha256, rawSize: primary.rawSize, entries: primary.entries };
    await saveReceipt(receiptPath, receipt);
  }
  input.assertCurrent();
  if (original) {
    await confirmVolumes(input, receipt.ownedVolumes, containerId);
    const current = await inspect(input.endpoint, containerId);
    if (!current || !isDeepStrictEqual(ephemeralFingerprint(current, expected), pinned)) throw new Error('The stopped container changed while its work was preserved.');
    await confirmNoActiveMountWriters(input, current);
    input.assertCurrent();
    try { await docker(input.endpoint, ['rm', containerId]); }
    catch { throw new Error('Stopped container removal was not confirmed; preserved work and history are retained.'); }
    if (await inspect(input.endpoint, containerId)) throw new Error('The retired container still exists; preserved work and history are retained.');
  }
  // Docker itself atomically refuses volume removal if a new container acquired
  // it after this fresh reference check. Never force removal or prune broadly.
  for (const volume of receipt.ownedVolumes) {
    input.assertCurrent();
    await confirmVolumes(input, [volume]);
    const current = await inspectVolume(input.endpoint, volume.name);
    if (current) {
      ownedVolume(current, expected, volume.name.endsWith('-home') ? 'home' : 'work');
      try { await docker(input.endpoint, ['volume', 'rm', volume.name]); }
      catch { throw new Error('Session volume removal was deferred; its complete preserved archive is retained.'); }
      if (await inspectVolume(input.endpoint, volume.name)) throw new Error('The retired session volume still exists.');
    }
    volume.status = 'removed'; await saveReceipt(receiptPath, receipt);
  }
  receipt = { ...receipt, status: 'removed' }; await saveReceipt(receiptPath, receipt); return receipt;
}
