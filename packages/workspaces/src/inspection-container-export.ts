import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lchmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, symlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dockerInvocation, type DockerRuntimeEndpoint } from "@enoughfactory/runtime";

export interface InspectionContainerRoot { id: string; name: string; path: string }
export interface ExportedInspectionRoot extends InspectionContainerRoot {
  originalPath: string;
  sourceCommit?: string;
  kind: "git" | "folder";
  manifestSha256: string;
}
export interface InspectionContainerExportLimits { maxBytes?: number; maxEntries?: number; maxRetries?: number; timeoutMs?: number }
export interface InspectionContainerExportInput {
  endpoint: DockerRuntimeEndpoint;
  containerId: string;
  roots: InspectionContainerRoot[];
  /** An application-owned directory. Source paths are never reused as output paths. */
  scratchDirectory: string;
  nodeExecutable?: string;
  limits?: InspectionContainerExportLimits;
  signal?: AbortSignal;
}
export type InspectionContainerExportTransport = (
  invocation: { command: string; args: string[]; env: NodeJS.ProcessEnv },
  options: { signal?: AbortSignal; timeoutMs: number },
  consume: (chunk: Buffer) => Promise<void>,
) => Promise<{ exitCode: number; stderr: string }>;
export interface InspectionContainerExport {
  path: string;
  roots: ExportedInspectionRoot[];
  manifest: { version: 1; roots: Array<{ id: string; kind: "git" | "folder"; originalPath: string; sourceCommit?: string; sha256: string; entries: number; bytes: number }> };
  cleanup(): Promise<void>;
}

const DEFAULT_LIMITS = { maxBytes: 256 * 1024 * 1024, maxEntries: 30_000, maxRetries: 1, timeoutMs: 120_000 };
const CHUNK_BYTES = 32 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/**
 * This script only reads the selected trees and Git index. The transfer repeats
 * the complete inventory after streaming, so an author edit cannot silently
 * become a mixed-source inspection snapshot. No Git config, index or ref is
 * copied to the host, and optional Git writes/hooks/fsmonitor are disabled.
 */
const EXPORT_SCRIPT = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const config = JSON.parse(process.argv[1]);
const digest = value => createHash('sha256').update(value).digest('hex');
const changed = () => { const error = new Error('Inspection source changed during export'); error.code = 'SOURCE_CHANGED'; throw error; };
const safePath = value => {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Unsafe inspection source path');
  return value;
};
const gitEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
function git(root, args, required = true) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, '-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.untrackedCache=false', ...args], { env: gitEnv, maxBuffer: Math.min(32 * 1024 * 1024, Math.max(1024 * 1024, config.maxEntries * 4096)), timeout: config.timeoutMs });
  if (result.error) throw result.error;
  if (result.status !== 0) { if (!required) return undefined; throw new Error('Cannot inventory selected Git source: ' + (result.stderr || '').toString().slice(0, 1000)); }
  return result.stdout;
}
async function parents(root, name) {
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    let st; try { st = await fs.lstat(path.join(root, ...parts.slice(0, i))); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Inspection source path traverses a symlink or non-directory');
  }
}
async function fileHash(root, name, expected) {
  await parents(root, name);
  let file; try { file = await fs.open(path.join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if (['ENOENT', 'ELOOP'].includes(error.code)) changed(); throw error; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.size) || before.ino !== expected.ino || before.dev !== expected.dev) changed();
    const h = createHash('sha256'), buffer = Buffer.alloc(${CHUNK_BYTES});
    let count = 0;
    for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; count += bytesRead; if (count > expected.size) changed(); h.update(buffer.subarray(0, bytesRead)); }
    const after = await file.stat({ bigint: true });
    if (count !== expected.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode) changed();
    return h.digest('hex');
  } finally { await file.close(); }
}
async function inventory() {
  const roots = [], totals = { bytes: 0, entries: 0 };
  for (const selected of config.roots) {
    const root = await fs.realpath(selected.path), st = await fs.lstat(root);
    if (!st.isDirectory()) throw new Error('Selected inspection source is not a directory');
    if (roots.some(other => root === other.root || root.startsWith(other.root + '/') || other.root.startsWith(root + '/'))) throw new Error('Selected inspection source roots must not overlap');
    const topLevel = git(root, ['rev-parse', '--show-toplevel'], false)?.toString().trim();
    const gitRoot = topLevel ? await fs.realpath(topLevel).catch(() => undefined) : undefined;
    const kind = gitRoot === root ? 'git' : 'folder';
    const commit = kind === 'git' ? git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], false)?.toString().trim() : undefined;
    if (commit && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error('Invalid source Git identity');
    let names;
    const selectedDirectories = new Set();
    if (kind === 'git') {
      const raw = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.']);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      const selected = new Set(text.split('\0').filter(name => name && !name.split('/').some(part => part.toLowerCase() === '.git')));
      for (const name of [...selected]) {
        safePath(name); let parent = path.posix.dirname(name);
        while (parent !== '.') { selected.add(parent); selectedDirectories.add(parent); parent = path.posix.dirname(parent); }
        if (selected.size > config.maxEntries) throw new Error('Inspection source exceeds entry limit');
      }
      names = [...selected].sort();
    } else {
      names = [];
      async function walk(directory, prefix = '') {
        const children = await fs.readdir(directory, { withFileTypes: true });
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          if (child.name.toLowerCase() === '.git') continue;
          const name = prefix + child.name;
          names.push(name);
          if (names.length > config.maxEntries) throw new Error('Inspection source exceeds entry limit');
          if (child.isDirectory()) await walk(path.join(directory, child.name), name + '/');
        }
      }
      await walk(root); names.sort();
    }
    const entries = [], nonDirectoryPaths = new Set();
    for (const name of names) {
      safePath(name);
      if (++totals.entries > config.maxEntries) throw new Error('Inspection source exceeds entry limit');
      let parent = path.posix.dirname(name), hiddenByTypeChange = false;
      while (parent !== '.') { if (nonDirectoryPaths.has(parent)) { hiddenByTypeChange = true; break; } parent = path.posix.dirname(parent); }
      // ls-files can contain both an untracked replacement file/symlink and the
      // old tracked descendants. Those descendants are deleted, never followed.
      if (hiddenByTypeChange) { entries.push({ path: name, type: 'deleted' }); continue; }
      await parents(root, name);
      let st; try { st = await fs.lstat(path.join(root, name), { bigint: true }); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; entries.push({ path: name, type: 'deleted' }); continue; }
      const mode = Number(st.mode & 511n);
      if (!st.isDirectory()) nonDirectoryPaths.add(name);
      if (st.isDirectory() && (kind === 'folder' || selectedDirectories.has(name))) {
        entries.push({ path: name, type: 'directory', mode });
      } else if (st.isSymbolicLink()) {
        const target = await fs.readlink(path.join(root, name));
        if (Buffer.byteLength(target) > 8192) throw new Error('Inspection symlink exceeds limit');
        const targetPath = path.resolve(path.dirname(path.join(root, name)), target);
        if (path.isAbsolute(target) || (targetPath !== root && !targetPath.startsWith(root + '/'))) throw new Error('Inspection symlink must remain inside its selected root');
        totals.bytes += Buffer.byteLength(target);
        entries.push({ path: name, type: 'symlink', mode, target, sha256: digest(target) });
      } else if (st.isFile()) {
        const size = Number(st.size);
        if (!Number.isSafeInteger(size) || size > config.maxBytes - totals.bytes) throw new Error('Inspection source exceeds byte limit');
        totals.bytes += size;
        entries.push({ path: name, type: 'file', mode, size, sha256: await fileHash(root, name, { size, ino: st.ino, dev: st.dev }) });
      } else throw new Error('Inspection source contains an unsupported entry (declare nested repositories separately)');
      if (totals.bytes > config.maxBytes) throw new Error('Inspection source exceeds byte limit');
    }
    if (kind === 'git') {
      const nonempty = new Set();
      for (const entry of entries) if (entry.type === 'file' || entry.type === 'symlink') { let parent = path.posix.dirname(entry.path); while (parent !== '.') { nonempty.add(parent); parent = path.posix.dirname(parent); } }
      for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === 'directory' && !nonempty.has(entries[i].path)) entries.splice(i, 1);
    }
    roots.push({ id: selected.id, kind, originalPath: selected.path, ...(commit ? { sourceCommit: commit } : {}), root, entries, sha256: digest(JSON.stringify(entries)) });
  }
  return roots;
}
async function emit(value) { if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain'); }
async function main() {
  const before = await inventory();
  await emit({ type: 'start', version: 1 });
  for (let index = 0; index < before.length; index++) {
    const root = before[index];
    await emit({ type: 'root', index, id: root.id, kind: root.kind, originalPath: root.originalPath, sourceCommit: root.sourceCommit, sha256: root.sha256 });
    for (const entry of root.entries) {
      const { type: sourceType, ...metadata } = entry;
      await emit({ type: 'entry', sourceType, ...metadata });
      if (entry.type === 'file') {
        await parents(root.root, entry.path);
        const file = await fs.open(path.join(root.root, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const st = await file.stat(); if (!st.isFile() || st.size !== entry.size) changed();
          const h = createHash('sha256'), buffer = Buffer.alloc(${CHUNK_BYTES}); let count = 0;
          for (;;) { const { bytesRead } = await file.read(buffer, 0, buffer.length, null); if (!bytesRead) break; count += bytesRead; if (count > entry.size) changed(); const bytes = buffer.subarray(0, bytesRead); h.update(bytes); await emit({ type: 'chunk', data: bytes.toString('base64') }); }
          if (count !== entry.size || h.digest('hex') !== entry.sha256) changed();
        } finally { await file.close(); }
        await emit({ type: 'file-end' });
      }
    }
    await emit({ type: 'root-end' });
  }
  const after = await inventory();
  if (digest(JSON.stringify(before)) !== digest(JSON.stringify(after))) changed();
  await emit({ type: 'complete', roots: before.map(({ id, kind, originalPath, sourceCommit, sha256, entries }) => ({ id, kind, originalPath, ...(sourceCommit ? { sourceCommit } : {}), sha256, entries: entries.length, bytes: entries.reduce((sum, entry) => sum + (entry.size ?? (entry.target ? Buffer.byteLength(entry.target) : 0)), 0) })) });
}
main().catch(async error => { await emit({ type: 'error', code: error.code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'EXPORT_FAILED', message: String(error.message).slice(0, 1000) }); process.exitCode = 1; });
`;

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid inspection export ${label}`);
  return value;
}

async function rejectSymlinkAncestors(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    const stat = await lstat(current).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (stat?.isSymbolicLink()) throw new Error("Inspection scratch directory has a symlink ancestor");
    if (stat && !stat.isDirectory()) throw new Error("Inspection scratch parent is not a directory");
    const parent = dirname(current); if (parent === current) return; current = parent;
  }
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || isAbsolute(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Unsafe inspection export path");
  return value;
}

async function removeOwnedExport(path: string): Promise<void> {
  // Imported directories can intentionally be read-only. Restore only owned
  // directory permissions without following links before removing scratch.
  const writable = async (directory: string): Promise<void> => {
    const stat = await lstat(directory).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    await chmod(directory, (stat.mode & 0o777) | 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) await writable(join(directory, entry.name));
  };
  await writable(path); await rm(path, { recursive: true, force: true });
}

function validSha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

function protocolFailure(line: Buffer, started: boolean): Error {
  if (started) return Object.assign(new Error("Invalid inspection export protocol record after the helper started"), { code: "INSPECTION_EXPORT_PROTOCOL" });
  // Docker can put an OCI exec-start error on stdout when the pinned helper is
  // absent. Retain a bounded startup diagnostic, never source/chunk payloads.
  const clean = line.subarray(0, 1000).toString("utf8").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  let diagnostic = "", bytes = 0;
  for (const character of clean) { const length = Buffer.byteLength(character); if (bytes + length > 1000) break; diagnostic += character; bytes += length; }
  return Object.assign(new Error(`Inspection source export helper could not start${diagnostic ? `: ${diagnostic}` : ". Provision the pinned Factory Node helper before inspecting this container."}`), { code: "INSPECTION_EXPORT_HELPER_START_FAILED" });
}

/** Stream from only the explicitly selected EnoughFactory endpoint. */
const streamDocker: InspectionContainerExportTransport = async (invocation, options, consume) => {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(invocation.command, invocation.args, { env: invocation.env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "", failure: unknown, stopped = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { if (stopped) return; stopped = true; child.kill("SIGTERM"); forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000); forceTimer.unref(); };
    const abort = () => { failure ??= new Error("Inspection source export was cancelled"); stop(); };
    const timer = setTimeout(() => { failure ??= new Error("Inspection source export timed out"); stop(); }, options.timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString().slice(0, 16_384 - stderr.length); });
    const consumed = (async () => { try { for await (const chunk of child.stdout) await consume(Buffer.from(chunk)); } catch (error) { failure ??= error; stop(); } })();
    child.once("error", error => { failure ??= error; });
    child.once("close", async code => {
      clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); options.signal?.removeEventListener("abort", abort);
      await consumed;
      if (failure) reject(failure); else resolveResult({ exitCode: code ?? 130, stderr });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
};

/**
 * Export dirty and untracked source to a new owned scratch tree, without commits
 * or writes in the author's container. Returned roots intentionally contain no
 * .git metadata: sourceCommit preserves provenance, while the snapshot manager
 * computes its independent exact-byte identity.
 */
export async function exportInspectionContainerRoots(input: InspectionContainerExportInput, options: { transport?: InspectionContainerExportTransport } = {}): Promise<InspectionContainerExport> {
  dockerInvocation(input.endpoint, []); // Validate even when tests inject transport.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(input.containerId)) throw new Error("Invalid inspection author container identity");
  if (!Array.isArray(input.roots) || !input.roots.length || input.roots.length > 9) throw new Error("Inspection export needs between 1 and 9 selected roots");
  const ids = new Set<string>(), names = new Set<string>();
  for (const root of input.roots) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(root.id) || ids.has(root.id.toLowerCase()) || typeof root.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(root.name) || names.has(root.name.toLowerCase()) || typeof root.path !== "string" || !root.path.startsWith("/") || root.path.includes("\0") || root.path.length > 8192) throw new Error("Invalid selected inspection root");
    ids.add(root.id.toLowerCase()); names.add(root.name.toLowerCase());
  }
  const nodeExecutable = input.nodeExecutable ?? "/opt/enoughfactory/node/bin/node";
  if (!nodeExecutable.startsWith("/") || nodeExecutable.includes("\0")) throw new Error("Inspection export requires an absolute pinned Node executable");
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  boundedInteger(limits.maxBytes, 1, 1024 * 1024 * 1024, "byte limit");
  boundedInteger(limits.maxEntries, 1, 100_000, "entry limit");
  boundedInteger(limits.maxRetries, 0, 2, "retry limit");
  boundedInteger(limits.timeoutMs, 1, 10 * 60_000, "timeout");
  if (!isAbsolute(input.scratchDirectory)) throw new Error("Inspection scratch directory must be absolute");
  await rejectSymlinkAncestors(input.scratchDirectory);
  await mkdir(input.scratchDirectory, { recursive: true, mode: 0o700 });
  await rejectSymlinkAncestors(input.scratchDirectory);
  const scratch = await realpath(input.scratchDirectory);
  const transport = options.transport ?? streamDocker;
  for (let retry = 0; ; retry++) {
    if (input.signal?.aborted) throw new Error("Inspection source export was cancelled");
    const output = await mkdtemp(join(scratch, "inspection-container-"));
    let activeFile: { handle: FileHandle; sha: ReturnType<typeof createHash>; size: number; received: number; mode: number; path: string; expected: string } | undefined;
    let buffer = Buffer.alloc(0), totalBytes = 0, totalEntries = 0, started = false, completed = false, rootIndex = -1, rootOpen = false, reportedError: { code: string; message: string } | undefined;
    const roots: ExportedInspectionRoot[] = [], rootEntries: unknown[][] = [];
    let manifest: InspectionContainerExport["manifest"] | undefined;
    const cleanup = async () => { if (activeFile) { await activeFile.handle.close(); activeFile = undefined; } await removeOwnedExport(output); };
    const consumeLine = async (line: Buffer) => {
      if (completed || reportedError) throw new Error("Inspection export sent data after its terminal record");
      let message: any; try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { throw protocolFailure(line, started); }
      if (message.type === "error") { reportedError = { code: String(message.code), message: String(message.message).slice(0, 1000) }; return; }
      if (!started) { if (message.type !== "start" || message.version !== 1) throw new Error("Invalid inspection export protocol version"); started = true; return; }
      if (message.type === "root") {
        if (activeFile || rootOpen || message.index !== rootIndex + 1 || message.index >= input.roots.length) throw new Error("Invalid inspection export root order");
        const original = input.roots[++rootIndex]!;
        if (message.id !== original.id || message.originalPath !== original.path || !["git", "folder"].includes(message.kind) || !validSha(message.sha256) || (message.sourceCommit !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(message.sourceCommit))) throw new Error("Invalid inspection export root provenance");
        const path = join(output, original.id); await mkdir(path, { mode: 0o700 });
        roots.push({ ...original, path, originalPath: original.path, kind: message.kind, ...(message.sourceCommit ? { sourceCommit: message.sourceCommit } : {}), manifestSha256: message.sha256 });
        rootEntries.push([]); rootOpen = true; return;
      }
      if (message.type === "entry") {
        if (!rootOpen || activeFile || ++totalEntries > limits.maxEntries) throw new Error("Inspection export exceeds entry limit or invalid entry order");
        const name = safeRelativePath(message.path), root = roots[rootIndex]!, entries = rootEntries[rootIndex]!;
        if (entries.length && (entries[entries.length - 1] as { path: string }).path >= name) throw new Error("Duplicate or unordered inspection source entry");
        const sourceType = message.sourceType;
        if (sourceType === "deleted") { entries.push({ path: name, type: "deleted" }); return; }
        const path = join(root.path, name); await rejectSymlinkAncestors(dirname(path));
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        if (!Number.isInteger(message.mode) || message.mode < 0 || message.mode > 0o777) throw new Error("Invalid inspection source metadata");
        if (sourceType === "directory") { await mkdir(path, { mode: 0o700 }); entries.push({ path: name, type: "directory", mode: message.mode }); return; }
        if (!validSha(message.sha256)) throw new Error("Invalid inspection source digest");
        if (sourceType === "symlink") {
          if (typeof message.target !== "string" || message.target.includes("\0") || Buffer.byteLength(message.target) > 8192 || hash(message.target) !== message.sha256) throw new Error("Invalid inspection symlink");
          const target = resolve(dirname(path), message.target);
          if (isAbsolute(message.target) || (target !== root.path && !target.startsWith(root.path + "/"))) throw new Error("Inspection symlink must remain inside its selected root");
          totalBytes += Buffer.byteLength(message.target); if (totalBytes > limits.maxBytes) throw new Error("Inspection export exceeds byte limit");
          await symlink(message.target, path);
          if (((await lstat(path)).mode & 0o777) !== message.mode) await lchmod(path, message.mode);
          entries.push({ path: name, type: "symlink", mode: message.mode, target: message.target, sha256: message.sha256 }); return;
        }
        if (sourceType !== "file" || !Number.isSafeInteger(message.size) || message.size < 0 || message.size > limits.maxBytes - totalBytes) throw new Error("Inspection export exceeds byte limit or invalid file size");
        totalBytes += message.size;
        const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        activeFile = { handle, sha: createHash("sha256"), size: message.size, received: 0, mode: message.mode, path, expected: message.sha256 };
        entries.push({ path: name, type: "file", mode: message.mode, size: message.size, sha256: message.sha256 }); return;
      }
      if (message.type === "chunk") {
        if (!activeFile || typeof message.data !== "string" || message.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) throw new Error("Invalid inspection file chunk");
        const chunk = Buffer.from(message.data, "base64"); activeFile.received += chunk.length;
        if (!chunk.length || activeFile.received > activeFile.size) throw new Error("Inspection file exceeds declared size");
        activeFile.sha.update(chunk); await activeFile.handle.writeFile(chunk); return;
      }
      if (message.type === "file-end") {
        if (!activeFile || activeFile.received !== activeFile.size || activeFile.sha.digest("hex") !== activeFile.expected) throw new Error("Inspection file failed integrity verification");
        await activeFile.handle.chmod(activeFile.mode); await activeFile.handle.close(); activeFile = undefined; return;
      }
      if (message.type === "root-end") {
        if (!rootOpen || activeFile || hash(JSON.stringify(rootEntries[rootIndex])) !== roots[rootIndex]!.manifestSha256) throw new Error("Inspection source manifest failed integrity verification");
        for (const entry of [...rootEntries[rootIndex]!].reverse() as Array<{ path: string; type: string; mode?: number }>) {
          if (entry.type === "directory") await chmod(join(roots[rootIndex]!.path, entry.path), entry.mode!);
        }
        rootOpen = false; return;
      }
      if (message.type === "complete") {
        if (rootOpen || activeFile || roots.length !== input.roots.length || !Array.isArray(message.roots) || message.roots.length !== roots.length) throw new Error("Incomplete inspection source export");
        const expected = roots.map((root, index) => ({ id: root.id, kind: root.kind, originalPath: root.originalPath, ...(root.sourceCommit ? { sourceCommit: root.sourceCommit } : {}), sha256: root.manifestSha256, entries: rootEntries[index]!.length, bytes: (rootEntries[index] as Array<{ size?: number; target?: string }>).reduce((sum, entry) => sum + (entry.size ?? (entry.target ? Buffer.byteLength(entry.target) : 0)), 0) }));
        if (JSON.stringify(message.roots) !== JSON.stringify(expected)) throw new Error("Inspection completion manifest mismatch");
        manifest = { version: 1, roots: expected }; completed = true; return;
      }
      throw new Error("Unexpected inspection export record");
    };
    try {
      const configuration = { roots: input.roots, maxBytes: limits.maxBytes, maxEntries: limits.maxEntries, timeoutMs: limits.timeoutMs };
      const invocation = dockerInvocation(input.endpoint, ["exec", "--user", "0", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=", "--env", "LD_PRELOAD=", "--env", "LD_LIBRARY_PATH=", input.containerId, nodeExecutable, "--input-type=commonjs", "-e", EXPORT_SCRIPT, "--", JSON.stringify(configuration)]);
      const result = await transport(invocation, { signal: input.signal, timeoutMs: limits.timeoutMs }, async chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) { const newline = buffer.indexOf(10); if (newline < 0) break; if (newline > MAX_LINE_BYTES) throw new Error("Inspection export protocol record exceeds limit"); const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1); await consumeLine(line); }
        if (buffer.length > MAX_LINE_BYTES) throw new Error("Inspection export protocol record exceeds limit");
      });
      if (reportedError) { const error = new Error(reportedError.message); Object.assign(error, { code: reportedError.code }); throw error; }
      if (result.exitCode !== 0) throw new Error(`Inspection source export failed: ${result.stderr.trim().slice(0, 1000) || `exit ${result.exitCode}`}`);
      if (buffer.length || !completed || !manifest) throw new Error("Inspection source export ended before completion");
      await chmod(output, 0o700);
      let disposed = false;
      return { path: output, roots, manifest, cleanup: async () => { if (disposed) return; if (dirname(output) !== scratch || !relative(scratch, output).startsWith("inspection-container-")) throw new Error("Refusing cleanup outside owned inspection scratch"); await removeOwnedExport(output); disposed = true; } };
    } catch (error) {
      await cleanup();
      if ((error as { code?: string }).code === "SOURCE_CHANGED" && retry < limits.maxRetries && !input.signal?.aborted) continue;
      throw error;
    }
  }
}
