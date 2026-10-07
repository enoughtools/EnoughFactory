import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { hashFile } from '@enoughfactory/workspaces';
import { exec } from './util.ts';

interface ContainerInspection {
  Id: string; Name: string; Created: string;
  State: { Running: boolean; Paused: boolean; Restarting: boolean; Dead: boolean; Pid: number; Status: string; StartedAt: string; FinishedAt: string; ExitCode: number };
  Config: { Labels: Record<string, string> };
}
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
function fingerprint(container: ContainerInspection, expected: RetirementIdentity): unknown {
  const labels = container.Config?.Labels;
  if (!/^[a-f0-9]{64}$/.test(container.Id) || container.Name !== `/${expected.name}` || !container.Created
    || labels?.['envmux.schema'] !== '2' || labels['envmux.kind'] !== 'session' || labels['envmux.service'] || labels['envmux.instance'] !== expected.name
    || labels['envmux.project'] !== expected.project || labels['envmux.session'] !== expected.sessionName
    || labels['envmux.directory'] !== expected.projectPath || labels['envmux.branch'] !== expected.branch || labels['envmux.workdir'] !== expected.workdir) {
    throw new Error('The stopped worker container no longer matches its exact envmux ownership.');
  }
  if (container.State.Running || container.State.Paused || container.State.Restarting || container.State.Dead || container.State.Pid !== 0 || container.State.Status !== 'exited') throw new Error('The worker container is not conclusively stopped.');
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
async function saveReceipt(filename: string, receipt: Receipt): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Only the successful worker release calls this, while holding its stopped-session lease. */
export async function retireStoppedFactoryContainer(input: {
  endpoint: DockerRuntimeEndpoint; dataDir: string; identity: RetirementIdentity; assertCurrent: () => void;
  pinnedContainerId?: string; pinContainerId: (containerId: string) => void;
  assertSpace:()=>void;
}): Promise<Receipt> {
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
