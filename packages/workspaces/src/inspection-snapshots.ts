import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lchmod, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import type { ArtifactManifest } from "./types.ts";
import { run, safeId } from "./process.ts";

export interface InspectionSourceRoot {
  id: string;
  name: string;
  path: string;
  /** Original provenance supplied by a verified container export, never an ancestry claim. */
  sourceCommit?: string;
  kind?: "git" | "folder";
  /** Verified container transfer provenance; private output paths remain separate. */
  originalPath?: string;
  manifestSha256?: string;
}
export type InspectionSourceEntry =
  | { path: string; kind: "file"; mode: number; size: number; sha256: string }
  | { path: string; kind: "symlink"; mode: number; target: string }
  | { path: string; kind: "directory"; mode: number };
export interface InspectionSnapshotRoot {
  id: string;
  name: string;
  path: string;
  containerPath: string;
  kind: "git" | "folder";
  sourceCommit?: string;
  sourceDigest: string;
  originalPath?: string;
  manifestSha256?: string;
  /** Synthetic commit in this private copy. It is not an accepted author candidate. */
  commit: string;
}
export interface InspectionSnapshotManifest {
  version: 1;
  id: string;
  purpose: "development-inspection";
  previewOnly: true;
  createdAt: string;
  sourceDigest: string;
  roots: Array<Omit<InspectionSnapshotRoot, "path" | "containerPath"> & { entries: InspectionSourceEntry[] }>;
}
export interface InspectionSnapshot {
  id: string;
  /** Pass this directory as appleCheckExecutor's checksRoot. */
  path: string;
  sourceDigest: string;
  manifest: InspectionSnapshotManifest;
  manifestArtifact?: ArtifactManifest;
  roots: InspectionSnapshotRoot[];
}
export interface InspectionSnapshotOptions {
  roots: readonly InspectionSourceRoot[];
  /** Service-owned retirement capture, including ignored files and empty directories. */
  includeAll?: boolean;
  signal?: AbortSignal;
  maxBytes?: number;
  maxEntries?: number;
  /** Additional attempts after observing concurrent source edits; at most two. */
  maxRetries?: number;
  onProgress?: (event: { phase: "inventory" | "copying" | "verifying" | "ready"; attempt: number; rootId?: string }) => void | Promise<void>;
  context?: { goalId?: string; taskId?: string; attemptId?: string };
}
interface InventoriedRoot extends InspectionSourceRoot {
  kind: "git" | "folder";
  entries: InspectionSourceEntry[];
  states: Map<string, string>;
  sourceDigest: string;
}
interface Budget { bytes: number; entries: number; maxBytes: number; maxEntries: number }
class SourceChanged extends Error {
  constructor() { super("Inspection source changed while it was being captured; wait for the current edit and retry"); }
}
const aliases = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const commits = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const gitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "init.templateDir="];

/**
 * Freeze selected source bytes into private repositories without touching author Git state.
 * Sources are inventoried twice across the entire multi-root copy. Concurrent writes fail or
 * retry, rather than producing a build with a misleading identity. The manifest deliberately
 * distinguishes a preview commit from the original saved candidate or integrated commit.
 */
export class InspectionSnapshotManager {
  private readonly root: string;
  constructor(private readonly options: { dataDir: string; artifacts?: ArtifactStore }) {
    this.root = resolve(options.dataDir, "inspection-snapshots");
  }

  async create(input: InspectionSnapshotOptions): Promise<InspectionSnapshot> {
    const roots = await normalizeRoots(input.roots);
    const maxBytes = bounded(input.maxBytes, 256 * 1024 * 1024, 1024 * 1024 * 1024, "byte limit");
    const maxEntries = bounded(input.maxEntries, 30_000, 100_000, "entry limit");
    const retries = input.maxRetries ?? 1;
    if (!Number.isInteger(retries) || retries < 0 || retries > 2) throw new Error("Inspection snapshot retries must be between zero and two");
    if (roots.some(source => contains(source.path, this.root) || contains(this.root, source.path))) throw new Error("Inspection storage and source roots must not overlap");
    await ensurePrivateDirectory(this.root);
    for (let attempt = 0; attempt <= retries; attempt++) {
      const id = randomUUID(), temporary = join(this.root, `.${id}`), final = join(this.root, id);
      await mkdir(temporary, { mode: 0o700 });
      try {
        input.signal?.throwIfAborted();
        await input.onProgress?.({ phase: "inventory", attempt });
        const inventories = await inventoryAll(roots, maxBytes, maxEntries, input.signal, input.includeAll === true);
        const copies: InspectionSnapshotRoot[] = [];
        for (let index = 0; index < inventories.length; index++) {
          const source = inventories[index]!;
          await input.onProgress?.({ phase: "copying", attempt, rootId: source.id });
          const destination = index === 0 ? join(temporary, "source") : join(temporary, "source-working-directories", source.id);
          await copyRoot(source, destination, input.signal);
          copies.push({ id: source.id, name: source.name, path: index === 0 ? join(final, "source") : join(final, "source-working-directories", source.id), containerPath: `/workspaces/${source.name}`, kind: source.kind, sourceCommit: source.sourceCommit, sourceDigest: source.sourceDigest, ...(source.originalPath ? { originalPath: source.originalPath, manifestSha256: source.manifestSha256 } : {}), commit: await createPrivateCommit(destination, source.id, source.sourceDigest, input.signal) });
        }
        await input.onProgress?.({ phase: "verifying", attempt });
        const verification = await inventoryAll(roots, maxBytes, maxEntries, input.signal, input.includeAll === true);
        if (inventories.some((source, index) => source.sourceDigest !== verification[index]!.sourceDigest || source.sourceCommit !== verification[index]!.sourceCommit || !sameStates(source.states, verification[index]!.states))) throw new SourceChanged();
        const sourceDigest = digest(copies.map(({ id: rootId, name, sourceDigest: hash }) => ({ id: rootId, name, sourceDigest: hash })));
        const manifest: InspectionSnapshotManifest = { version: 1, id, purpose: "development-inspection", previewOnly: true, createdAt: new Date().toISOString(), sourceDigest, roots: copies.map(({ path: _path, containerPath: _containerPath, ...root }, index) => ({ ...root, entries: inventories[index]!.entries })) };
        await writeFile(join(temporary, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o400 });
        // A ready observation is emitted only after every selected root has been verified.
        await rename(temporary, final);
        let manifestArtifact: ArtifactManifest | undefined;
        try {
          if (this.options.artifacts) manifestArtifact = await this.options.artifacts.put(JSON.stringify(manifest), { ...input.context, name: `inspection-source-${id}.json`, mime: "application/json", metadata: { sourceDigest, previewOnly: true, purpose: manifest.purpose } });
          await input.onProgress?.({ phase: "ready", attempt });
          return { id, path: final, sourceDigest, manifest, manifestArtifact, roots: copies };
        } catch (error) { await retire(final); throw error; }
      } catch (error) {
        await retire(temporary);
        if (error instanceof SourceChanged && attempt < retries) continue;
        throw error;
      }
    }
    throw new SourceChanged();
  }

  /** Detect accidental mutation before reusing a private preview source. */
  async verify(snapshot: InspectionSnapshot, signal?: AbortSignal): Promise<void> {
    await this.owned(snapshot);
    if (snapshot.roots.length !== snapshot.manifest.roots.length || snapshot.roots.length < 1 || snapshot.roots.length > 9) throw new Error("Inspection snapshot root identity changed");
    for (let index = 0; index < snapshot.roots.length; index++) {
      const root = snapshot.roots[index]!, expected = snapshot.manifest.roots[index]!;
      safeId(root.id);
      const path = index === 0 ? join(snapshot.path, "source") : join(snapshot.path, "source-working-directories", root.id);
      if (root.path !== path || root.id !== expected.id || root.name !== expected.name || root.commit !== expected.commit || root.sourceDigest !== expected.sourceDigest || root.originalPath !== expected.originalPath || root.manifestSha256 !== expected.manifestSha256 || await realpath(root.path) !== path) throw new Error("Inspection snapshot root identity changed");
    }
    const manifest = JSON.parse(await readFile(join(snapshot.path, "manifest.json"), "utf8")) as InspectionSnapshotManifest;
    if (JSON.stringify(manifest) !== JSON.stringify(snapshot.manifest) || manifest.sourceDigest !== snapshot.sourceDigest) throw new Error("Inspection snapshot manifest identity changed");
    await verifyInspectionSnapshotContents(snapshot, signal);
  }

  /** Only this manager's exact snapshot identity can be retired. Evidence remains in ArtifactStore. */
  async remove(snapshot: InspectionSnapshot): Promise<void> {
    await this.owned(snapshot);
    await makeRemovable(snapshot.path);
    await rm(snapshot.path, { recursive: true, force: true });
  }

  private async owned(snapshot: InspectionSnapshot): Promise<void> {
    safeId(snapshot.id);
    if (snapshot.path !== join(this.root, snapshot.id) || await realpath(snapshot.path) !== snapshot.path || !(await lstat(snapshot.path)).isDirectory()) throw new Error("Inspection snapshot is not owned by this manager");
  }
}

/** Read-only content verification for a service-owned staging copy before atomic publication. */
export async function verifyInspectionSnapshotContents(snapshot: InspectionSnapshot, signal?: AbortSignal): Promise<void> {
  if (snapshot.roots.length !== snapshot.manifest.roots.length) throw new Error("Inspection snapshot source root count changed");
  const inspected = await inventoryAll(snapshot.roots.map(root => ({ id: root.id, name: root.name, path: root.path })), 1024 * 1024 * 1024, 100_000, signal, true);
  for (let index = 0; index < snapshot.roots.length; index++) {
    const root = snapshot.roots[index]!, expected = snapshot.manifest.roots[index]!;
    if (inspected[index]!.sourceDigest !== expected.sourceDigest || root.sourceDigest !== expected.sourceDigest || await git(root.path, ["rev-parse", "--verify", "HEAD^{commit}"], signal) !== root.commit) throw new Error("Inspection snapshot source changed; build a fresh preview");
  }
  if (digest(snapshot.roots.map(({ id, name, sourceDigest }) => ({ id, name, sourceDigest }))) !== snapshot.sourceDigest || snapshot.sourceDigest !== snapshot.manifest.sourceDigest) throw new Error("Inspection aggregate source identity changed");
}

async function normalizeRoots(roots: readonly InspectionSourceRoot[]): Promise<InspectionSourceRoot[]> {
  if (!Array.isArray(roots) || roots.length < 1 || roots.length > 9) throw new Error("Inspection requires one primary root and at most eight additional roots");
  const ids = new Set<string>(), names = new Set<string>(), result: InspectionSourceRoot[] = [];
  for (const source of roots) {
    safeId(source.id);
    if (!aliases.test(source.name) || ids.has(source.id.toLowerCase()) || names.has(source.name.toLowerCase())) throw new Error("Inspection root identifiers and names must be valid and unique");
    if (source.sourceCommit !== undefined && !commits.test(source.sourceCommit)) throw new Error("Inspection source provenance requires an exact original commit");
    if (source.kind !== undefined && source.kind !== "git" && source.kind !== "folder") throw new Error("Invalid inspection source kind");
    if ((source.originalPath === undefined) !== (source.manifestSha256 === undefined) || (source.originalPath !== undefined && (!isAbsolute(source.originalPath) || source.originalPath.includes("\0") || source.originalPath.length > 8192 || !/^[a-f0-9]{64}$/.test(source.manifestSha256!)))) throw new Error("Invalid inspection container export provenance");
    const path = await realpath(resolve(source.path));
    if (!(await lstat(path)).isDirectory()) throw new Error("Inspection source must be a directory");
    if (result.some(other => contains(path, other.path) || contains(other.path, path))) throw new Error("Inspection source roots must not overlap");
    result.push({ ...source, path }); ids.add(source.id.toLowerCase()); names.add(source.name.toLowerCase());
  }
  return result;
}

async function inventoryAll(roots: readonly InspectionSourceRoot[], maxBytes: number, maxEntries: number, signal?: AbortSignal, includeAll = false): Promise<InventoriedRoot[]> {
  const budget: Budget = { bytes: 0, entries: 0, maxBytes, maxEntries }, result: InventoriedRoot[] = [];
  for (const root of roots) result.push(await inventory(root, budget, signal, includeAll));
  return result;
}
async function inventory(root: InspectionSourceRoot, budget: Budget, signal?: AbortSignal, includeAll = false): Promise<InventoriedRoot> {
  signal?.throwIfAborted();
  // An export has deliberately omitted metadata; an enclosing host repository must
  // never replace its container HEAD or hide its files via host ignore rules.
  const discovery = root.originalPath ? undefined : await gitResult(root.path, ["rev-parse", "--show-toplevel"], signal);
  const isGit = discovery?.exitCode === 0 && await realpath(discovery.stdout.trim()) === root.path;
  const head = isGit ? await gitResult(root.path, ["rev-parse", "--verify", "HEAD^{commit}"], signal) : undefined;
  const sourceCommit = head?.exitCode === 0 ? head.stdout.trim() : root.sourceCommit;
  if (sourceCommit && !commits.test(sourceCommit)) throw new Error("Invalid original inspection source commit");
  const states = new Map<string, string>(), entries: InspectionSourceEntry[] = [];
  const selected = new Set<string>(), selectedDirectories = new Set<string>();
  if (isGit && !includeAll) {
    const result = await gitResult(root.path, ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", "."], signal);
    if (result.exitCode !== 0 || result.stdout.length >= 8 * 1024 * 1024 || (result.stdout && !result.stdout.endsWith("\0"))) throw new Error("Inspection Git source inventory failed or exceeded its limit");
    for (const path of result.stdout.split("\0").filter(Boolean)) {
      validateRelative(path);
      if (path.split("/").some(part => part.toLowerCase() === ".git")) continue;
      selected.add(path);
      let parent = dirname(path);
      while (parent !== ".") { selected.add(parent); selectedDirectories.add(parent); parent = dirname(parent); }
      if (selected.size > budget.maxEntries) throw new Error("Inspection source exceeds its entry limit; exclude generated output first");
    }
  } else {
    const visit = async (path: string): Promise<void> => {
      signal?.throwIfAborted();
      for (const name of (await readdir(path)).sort()) {
        if (name.toLowerCase() === ".git") continue;
        const child = join(path, name), relativePath = relative(root.path, child).split(sep).join("/");
        validateRelative(relativePath); selected.add(relativePath);
        if (selected.size > budget.maxEntries) throw new Error("Inspection source exceeds its entry limit; exclude generated output first");
        const stat = await stableLstat(child);
        if (stat.isDirectory() && !stat.isSymbolicLink()) await visit(child);
      }
    };
    await visit(root.path);
  }
  const replacedDirectories = new Set<string>();
  for (const path of [...selected].sort()) {
    signal?.throwIfAborted();
    let ancestor = dirname(path), removedByTypeChange = false;
    while (ancestor !== ".") { if (replacedDirectories.has(ancestor)) { removedByTypeChange = true; break; } ancestor = dirname(ancestor); }
    if (removedByTypeChange) continue;
    const absolute = join(root.path, ...path.split("/"));
    let stat: BigIntStats;
    try { stat = await lstat(absolute, { bigint: true }); } catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; throw error; }
    await checkParents(root.path, path);
    if (++budget.entries > budget.maxEntries) throw new Error("Inspection source exceeds its entry limit; exclude generated output first");
    const mode = Number(stat.mode & 0o777n);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (Buffer.byteLength(target) > 8192 || (budget.bytes += Buffer.byteLength(target)) > budget.maxBytes) throw new Error("Inspection source exceeds its byte limit");
      if (isAbsolute(target) || !contains(root.path, resolve(dirname(absolute), target))) throw new Error(`Inspection symlink must remain inside its selected root: ${path}`);
      entries.push({ path, kind: "symlink", mode, target });
    } else if (stat.isDirectory()) {
      if (isGit && !includeAll && !selectedDirectories.has(path)) throw new Error(`Inspection requires an initialized submodule or explicit additional source root: ${path}`);
      entries.push({ path, kind: "directory", mode });
    } else if (stat.isFile()) {
      const size = Number(stat.size);
      if (!Number.isSafeInteger(size) || (budget.bytes += size) > budget.maxBytes) throw new Error("Inspection source exceeds its byte limit; exclude generated output first");
      entries.push({ path, kind: "file", mode, size, sha256: await fileHash(absolute, stat, signal) });
    } else throw new Error(`Inspection cannot capture special files: ${path}`);
    if (!stat.isDirectory()) replacedDirectories.add(path);
    const after = await stableLstat(absolute);
    if (state(stat) !== state(after)) throw new SourceChanged();
    states.set(path, state(stat));
  }
  if (isGit && !includeAll) {
    // A tracked deletion must not retain a now-empty parent absent from the selected tree.
    const nonempty = new Set<string>();
    for (const entry of entries) if (entry.kind !== "directory") { let parent = dirname(entry.path); while (parent !== ".") { nonempty.add(parent); parent = dirname(parent); } }
    for (let index = entries.length - 1; index >= 0; index--) if (entries[index]!.kind === "directory" && !nonempty.has(entries[index]!.path)) { states.delete(entries[index]!.path); entries.splice(index, 1); }
  }
  return { ...root, kind: root.kind ?? (isGit ? "git" : "folder"), sourceCommit, entries, states, sourceDigest: digest(entries) };
}

async function copyRoot(source: InventoriedRoot, destination: string, signal?: AbortSignal): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of source.entries) {
    signal?.throwIfAborted();
    const from = join(source.path, ...entry.path.split("/")), to = join(destination, ...entry.path.split("/"));
    await checkParents(source.path, entry.path);
    const before = await stableLstat(from);
    if (state(before) !== source.states.get(entry.path)) throw new SourceChanged();
    await mkdir(dirname(to), { recursive: true, mode: 0o700 });
    if (entry.kind === "directory") await mkdir(to, { recursive: true, mode: 0o700 });
    else if (entry.kind === "symlink") {
      if (!before.isSymbolicLink() || await readlink(from) !== entry.target) throw new SourceChanged();
      await symlink(entry.target, to);
      if ((Number((await lstat(to, { bigint: true })).mode & 0o777n)) !== entry.mode) await lchmod(to, entry.mode);
    } else {
      const input = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW), output = await open(to, "wx", entry.mode | 0o600);
      try {
        if (state(await input.stat({ bigint: true })) !== source.states.get(entry.path)) throw new SourceChanged();
        const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (true) {
          signal?.throwIfAborted();
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          if (position + bytesRead > entry.size) throw new SourceChanged();
          hash.update(buffer.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written, position + written)).bytesWritten;
          position += bytesRead;
        }
        if (position !== entry.size || hash.digest("hex") !== entry.sha256 || state(await input.stat({ bigint: true })) !== source.states.get(entry.path)) throw new SourceChanged();
      } finally { await input.close(); await output.close(); }
      await chmod(to, entry.mode);
    }
    if (state(await stableLstat(from)) !== source.states.get(entry.path)) throw new SourceChanged();
  }
  // Preserve directory modes after populating children; no original root is changed.
  for (const entry of [...source.entries].reverse()) if (entry.kind === "directory") await chmod(join(destination, ...entry.path.split("/")), entry.mode);
}

async function createPrivateCommit(path: string, rootId: string, sourceDigest: string, signal?: AbortSignal): Promise<string> {
  await git(path, ["init", "--quiet"], signal);
  await git(path, ["config", "user.name", "EnoughFactory"], signal);
  await git(path, ["config", "user.email", "factory@enoughtools.com"], signal);
  // Preserve exact bytes even when copied project attributes request CRLF, ident or filters.
  await mkdir(join(path, ".git", "info"), { recursive: true, mode: 0o700 });
  await writeFile(join(path, ".git", "info", "attributes"), "* -text -filter -ident -working-tree-encoding\n", { mode: 0o600 });
  await git(path, ["add", "--all", "--force", "--", "."], signal);
  // Capture time belongs to the manifest. Identical private source has one preview
  // commit/bundle object, even when observed again under a new snapshot identity.
  const result = await run("git", [...gitOptions, "-C", path, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", `EnoughFactory development inspection ${rootId} ${sourceDigest}`], {
    env: { ...gitEnvironment(), GIT_AUTHOR_NAME: "EnoughFactory", GIT_AUTHOR_EMAIL: "factory@enoughtools.com", GIT_COMMITTER_NAME: "EnoughFactory", GIT_COMMITTER_EMAIL: "factory@enoughtools.com", GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00", GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00" },
    inheritEnv: false, timeoutMs: 120_000, signal,
  });
  if (result.exitCode !== 0) throw new Error(`Inspection private Git commit failed: ${(result.stderr || result.stdout).trim()}`);
  return git(path, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
}
async function fileHash(path: string, expected: BigIntStats, signal?: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (state(await handle.stat({ bigint: true })) !== state(expected)) throw new SourceChanged();
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) { signal?.throwIfAborted(); hash.update(chunk); }
    if (state(await handle.stat({ bigint: true })) !== state(expected)) throw new SourceChanged();
    return hash.digest("hex");
  } finally { await handle.close(); }
}
async function checkParents(root: string, path: string): Promise<void> {
  let current = root;
  for (const component of path.split("/").slice(0, -1)) {
    current = join(current, component);
    const stat = await stableLstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SourceChanged();
  }
}
async function ensurePrivateDirectory(path: string): Promise<void> {
  // Build one component at a time so no mkdir follows an existing storage symlink.
  const selected = resolve(path), components = selected.split(sep).filter(Boolean);
  let current: string = sep;
  for (const component of components) {
    current = join(current, component);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Inspection private storage contains a symlink or non-directory parent");
  }
}
async function retire(path: string): Promise<void> {
  try { await makeRemovable(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rm(path, { recursive: true, force: true });
}
async function makeRemovable(path: string): Promise<void> {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) return;
  await chmod(path, (entry.mode & 0o777) | 0o700);
  for (const name of await readdir(path)) await makeRemovable(join(path, name));
}
async function stableLstat(path: string): Promise<BigIntStats> {
  try { return await lstat(path, { bigint: true }); } catch (error) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new SourceChanged(); throw error; }
}
function state(stat: BigIntStats): string { return (stat.isDirectory() ? [stat.dev, stat.ino, stat.mode] : [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs]).join(":"); }
function sameStates(left: Map<string, string>, right: Map<string, string>): boolean { return left.size === right.size && [...left].every(([path, value]) => right.get(path) === value); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function bounded(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw new Error(`Invalid inspection ${name}`);
  return selected;
}
function contains(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)); }
function validateRelative(path: string): void {
  if (!path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Inspection source contains a nonportable or escaping path");
}
function gitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}
async function gitResult(path: string, args: string[], signal?: AbortSignal) {
  return run("git", [...gitOptions, "-C", path, ...args], { env: gitEnvironment(), inheritEnv: false, timeoutMs: 120_000, signal });
}
async function git(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  const result = await gitResult(path, args, signal);
  if (result.exitCode !== 0) throw new Error(`Inspection private Git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}
