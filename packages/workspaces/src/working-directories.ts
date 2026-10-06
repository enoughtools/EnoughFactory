import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ArtifactStore, writeAtomic } from "./artifacts.ts";
import { run, safeId } from "./process.ts";
import type { ArtifactManifest, WorkingDirectoryCapture, WorkingDirectoryConfig, WorkingDirectorySnapshot, WorkingDirectorySource } from "./types.ts";

const operations = new Map<string, Promise<unknown>>();
const aliasPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const commitPattern = /^[a-f0-9]{40,64}$/;
interface SnapshotJournal {
  version: 1;
  identity: string;
  configuration: string;
  snapshots: WorkingDirectorySnapshot[];
}

/** Resolve selected symlink roots, while rejecting overlapping execution roots. */
export async function validateWorkingDirectories(primary: string, sources: readonly WorkingDirectoryConfig[]): Promise<WorkingDirectoryConfig[]> {
  return normalizeSources(sources, await directory(primary));
}

export interface EmptyWorkingDirectory { path: string; mode: number }

/** Git omits empty directory trees; include their empty ancestors and permission modes. */
export async function workingDirectoryEmptyDirectories(path: string): Promise<EmptyWorkingDirectory[]> {
  const root = await directory(path), result: EmptyWorkingDirectory[] = [];
  const visit = async (current: string): Promise<boolean> => {
    let hasFiles = false;
    for (const name of (await readdir(current)).sort()) {
      if (name.toLowerCase() === ".git") continue;
      const child = join(current, name), entry = await lstat(child);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const childHasFiles = await visit(child);
        if (!childHasFiles) result.push({ path: relative(root, child).split(sep).join("/"), mode: entry.mode & 0o777 });
        hasFiles ||= childHasFiles;
      } else hasFiles = true;
    }
    return hasFiles;
  };
  await visit(root);
  return result.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

/** Input/check cache identity includes ignored bytes and symlink targets, without following links. */
export async function fingerprintWorkingDirectories(sources: readonly WorkingDirectoryConfig[]): Promise<string> {
  const normalized = await normalizeSources(sources);
  const hash = createHash("sha256");
  const record = (value: unknown) => hash.update(`${JSON.stringify(value)}\n`);
  const visit = async (root: string, current: string): Promise<void> => {
    for (const name of (await readdir(current)).sort()) {
      if (name.toLowerCase() === ".git") continue;
      const path = join(current, name), entry = await lstat(path), relativePath = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) record([relativePath, "symlink", entry.mode & 0o7777, await readlink(path)]);
      else if (entry.isDirectory()) { record([relativePath, "directory", entry.mode & 0o7777]); await visit(root, path); }
      else if (entry.isFile()) {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const contents = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false })) contents.update(chunk);
          record([relativePath, "file", entry.mode & 0o7777, contents.digest("hex")]);
        } finally { await handle.close(); }
      } else throw new Error(`Working directory contains an unsupported special file: ${name}`);
    }
  };
  for (const source of normalized.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)) {
    record([source.id, source.name]);
    await visit(source.path, source.path);
  }
  return hash.digest("hex");
}

async function normalizeSources(sources: readonly WorkingDirectoryConfig[], primary?: string): Promise<WorkingDirectoryConfig[]> {
  validateNames(sources);
  const result: WorkingDirectoryConfig[] = [];
  const paths = primary ? [primary] : [];
  for (const source of sources) {
    const path = await directory(source.path);
    if (paths.some((other) => contains(other, path) || contains(path, other))) throw new Error("Working directories must not overlap the primary project or one another");
    paths.push(path);
    result.push({ id: source.id, name: source.name, path });
  }
  return result;
}

function validateNames(sources: readonly { id: string; name: string }[]): void {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error("Select at most eight extra working directories");
  const ids = new Set<string>(), names = new Set<string>();
  for (const source of sources) {
    safeId(source.id);
    if (!aliasPattern.test(source.name)) throw new Error("Working directory names must use 1–48 letters, numbers, dots, underscores or hyphens");
    const id = source.id.toLowerCase(), name = source.name.toLowerCase();
    if (ids.has(id) || names.has(name)) throw new Error("Working directory identifiers and names must be unique");
    ids.add(id); names.add(name);
  }
}

export class WorkingDirectoryManager {
  private readonly root: string;
  constructor(private readonly options: { dataDir: string; artifacts: ArtifactStore }) { this.root = resolve(options.dataDir); }

  /** A durable journal makes an identity retain its original inputs after reconnect/retry. */
  async prepare(input: { identity: string; sources?: readonly WorkingDirectoryConfig[]; transferred?: readonly WorkingDirectorySource[] }): Promise<WorkingDirectorySnapshot[]> {
    safeId(input.identity);
    if (input.sources && input.transferred) throw new Error("Working directories require local sources or transferred sources, not both");
    const key = join(this.root, "working-directories", input.identity);
    const previous = operations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.prepareLocked(input));
    operations.set(key, operation);
    try { return await operation; } finally { if (operations.get(key) === operation) operations.delete(key); }
  }

  private async prepareLocked(input: { identity: string; sources?: readonly WorkingDirectoryConfig[]; transferred?: readonly WorkingDirectorySource[] }): Promise<WorkingDirectorySnapshot[]> {
    const selected = input.transferred ?? input.sources ?? [];
    validateNames(selected);
    const configuration = JSON.stringify(input.transferred
      ? input.transferred.map((source) => ({ id: source.id, name: source.name, baseCommit: source.baseCommit, artifact: source.sourceArtifact.sha256, emptyDirectoriesSha256: inventoryHash(bundleEmptyDirectories(source.sourceArtifact)) }))
      : (input.sources ?? []).map((source) => ({ id: source.id, name: source.name, path: resolve(source.path) })));
    try {
      const journal = await this.journal(input.identity);
      if ((input.sources || input.transferred) && journal.configuration !== configuration) throw new Error("Working directory identity already belongs to different inputs");
      for (const source of journal.snapshots) {
        await this.options.artifacts.path(source.sourceArtifact);
        if (inventoryHash(await workingDirectoryEmptyDirectories(source.path)) !== inventoryHash(bundleEmptyDirectories(source.sourceArtifact))) throw new Error("Working directory baseline directory inventory changed; preserve it before retrying");
      }
      return journal.snapshots;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    const sources = input.transferred ? undefined : await normalizeSources(input.sources ?? []);
    const final = join(this.root, "working-directories", input.identity);
    const temporary = join(this.root, "working-directories", `.${input.identity}-${randomUUID()}`);
    await this.ensureOwnedParent(temporary);
    if (await exists(final)) throw new Error("Working directory identity has an incomplete snapshot; preserve it before retrying");
    await mkdir(temporary, { mode: 0o700 });
    try {
      const snapshots: WorkingDirectorySnapshot[] = [];
      for (const source of input.transferred ?? sources ?? []) {
        const path = join(temporary, "roots", source.id, "repository");
        let snapshot: WorkingDirectorySnapshot;
        if ("sourceArtifact" in source) {
          validateSource(source);
          await this.importBundle(source.sourceArtifact, path, source.baseCommit, source.baseCommit);
          snapshot = { ...source, path: join(final, "roots", source.id, "repository") };
        } else {
          const prepared = await this.snapshotSource(source, path);
          snapshot = { ...prepared, path: join(final, "roots", source.id, "repository") };
        }
        snapshots.push(snapshot);
      }
      await writeAtomic(join(temporary, "snapshots.json"), { version: 1, identity: input.identity, configuration, snapshots } satisfies SnapshotJournal);
      await rename(temporary, final);
      return snapshots;
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }

  async sourceSnapshots(identity: string): Promise<WorkingDirectorySnapshot[]> {
    try { return (await this.journal(identity)).snapshots; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }

  private async journal(identity: string): Promise<SnapshotJournal> {
    const path = join(this.root, "working-directories", safeId(identity), "snapshots.json");
    await this.verifyOwnedExistingParents(path);
    const journal = JSON.parse(await readFile(path, "utf8")) as SnapshotJournal;
    if (journal.version !== 1 || journal.identity !== identity || !Array.isArray(journal.snapshots)) throw new Error("Invalid working directory snapshot journal");
    validateNames(journal.snapshots);
    for (const snapshot of journal.snapshots) {
      validateSource(snapshot);
      if (snapshot.path !== join(this.root, "working-directories", identity, "roots", snapshot.id, "repository")) throw new Error("Working directory snapshot has an invalid private path");
    }
    return journal;
  }

  private async snapshotSource(source: WorkingDirectoryConfig, path: string): Promise<WorkingDirectorySource> {
    await this.ensureOwnedParent(path);
    const discovered = await gitResult(source.path, "rev-parse", "--show-toplevel");
    const isGit = discovered.exitCode === 0 && await realpath(discovered.stdout.trim()) === source.path;
    let sourceCommit: string | undefined;
    if (isGit) {
      const head = await gitResult(source.path, "rev-parse", "--verify", "HEAD^{commit}");
      if (head.exitCode === 0) sourceCommit = head.stdout.trim();
    }
    if (isGit && sourceCommit) {
      await command(["clone", "--no-local", "--no-checkout", "--", source.path, path]);
      await privateConfiguration(path);
      await ownGit(path, "reset", "--mixed", sourceCommit);
      // Keep all cloned history but remove the private source location from local config.
      const references = await ownGit(path, "for-each-ref", "--format=%(objectname)", "refs/remotes/origin");
      for (const commit of references.split("\n").filter(Boolean)) await ownGit(path, "update-ref", `refs/enoughfactory/original/${randomUUID()}`, commit);
      await ownGit(path, "remote", "remove", "origin");
    } else {
      await command(["init", "--quiet", path]);
      await privateConfiguration(path);
    }
    await replaceTree(source.path, path);
    await ownGit(path, "add", "--all", "--force", "--", ".");
    await ownGit(path, "commit", "--allow-empty", "--no-verify", "-m", "EnoughFactory working directory baseline");
    const baseCommit = await ownGit(path, "rev-parse", "HEAD");
    const sourceArtifact = await this.bundle(path, baseCommit, baseCommit, source.id, "source", true);
    return { id: source.id, name: source.name, kind: isGit ? "git" : "folder", containerPath: `/workspaces/${source.name}`, baseCommit, sourceCommit, sourceArtifact };
  }

  /** Exported agent .git is untrusted: rebuild in fresh service-owned Git instead. */
  async captureFromPath(snapshot: WorkingDirectorySnapshot, exportedPath: string, context: { goalId?: string; taskId?: string; attemptId?: string } = {}): Promise<WorkingDirectoryCapture> {
    validateSource(snapshot);
    const exported = await directory(exportedPath);
    const actualRoot = await directory(this.root);
    if (!contains(actualRoot, exported) || actualRoot === exported) throw new Error("Working directory capture must read an app-owned export");
    const path = join(this.root, "working-directory-captures", randomUUID(), "repository");
    try {
      await this.importBundle(snapshot.sourceArtifact, path, snapshot.baseCommit, snapshot.baseCommit);
      await replaceTree(exported, path);
      await ownGit(path, "add", "--all", "--force", "--", ".");
      await ownGit(path, "commit", "--allow-empty", "--no-verify", "-m", "EnoughFactory retained working directory output");
      const commit = await ownGit(path, "rev-parse", "HEAD");
      const bundleArtifact = await this.bundle(path, commit, snapshot.baseCommit, snapshot.id, "output", false, context);
      const diff = await gitResult(path, "diff", "--binary", "--no-ext-diff", "--no-textconv", snapshot.baseCommit, commit);
      if (diff.exitCode !== 0) throw new Error(`Working directory diff failed: ${diff.stderr}`);
      const diffArtifact = await this.options.artifacts.put(diff.stdout, { ...context, name: `working-directory-${snapshot.id}-${commit}.patch`, mime: "text/x-diff", metadata: { commit, baseCommit: snapshot.baseCommit, workingDirectoryId: snapshot.id } });
      return { id: snapshot.id, name: snapshot.name, kind: snapshot.kind, containerPath: snapshot.containerPath, baseCommit: snapshot.baseCommit, commit, bundleArtifact, diffArtifact };
    } finally { await rm(dirname(path), { recursive: true, force: true }); }
  }

  /** Reconstruct exact retained output for checks/export without touching original sources. */
  async importCapture(capture: WorkingDirectoryCapture, targetPath: string): Promise<void> {
    validateEnvelope(capture);
    if (!commitPattern.test(capture.commit)) throw new Error("Working directory output requires an exact commit");
    await this.options.artifacts.path(capture.diffArtifact);
    await this.options.artifacts.path(capture.bundleArtifact);
    const emptyDirectories = bundleEmptyDirectories(capture.bundleArtifact), emptyDirectoriesSha256 = inventoryHash(emptyDirectories);
    const path = resolve(targetPath), receiptPath = `${path}.working-directory-import.json`;
    await this.ensureOwnedParent(path);
    if (await exists(path)) {
      const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { sha256: string; commit: string; baseCommit: string; gitConfigSha256: string; emptyDirectoriesSha256?: string };
      if (receipt.sha256 !== capture.bundleArtifact.sha256 || receipt.commit !== capture.commit || receipt.baseCommit !== capture.baseCommit || (receipt.emptyDirectoriesSha256 ?? inventoryHash([])) !== emptyDirectoriesSha256) throw new Error("Working directory import target belongs to different immutable output");
      const target = await lstat(path);
      if (!target.isDirectory() || target.isSymbolicLink()) throw new Error("Working directory import has an unsafe target");
      const metadata = await lstat(join(path, ".git"));
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Working directory import has unsafe Git metadata");
      const configuration = await lstat(join(path, ".git", "config"));
      if (!configuration.isFile() || configuration.isSymbolicLink() || createHash("sha256").update(await readFile(join(path, ".git", "config"))).digest("hex") !== receipt.gitConfigSha256) throw new Error("Working directory import Git configuration changed; preserve it before retrying");
      if (await ownGit(path, "rev-parse", "HEAD") !== capture.commit || await ownGit(path, "status", "--porcelain=v1", "--untracked-files=all", "--ignored")) throw new Error("Working directory imported output has local edits; preserve them before retrying");
      if (inventoryHash(await workingDirectoryEmptyDirectories(path)) !== emptyDirectoriesSha256) throw new Error("Working directory imported empty directory inventory changed; preserve it before retrying");
      await ownGit(path, "merge-base", "--is-ancestor", capture.baseCommit, capture.commit);
      return;
    }
    await this.importBundle(capture.bundleArtifact, path, capture.commit, capture.baseCommit);
    await writeAtomic(receiptPath, { sha256: capture.bundleArtifact.sha256, commit: capture.commit, baseCommit: capture.baseCommit, emptyDirectoriesSha256, gitConfigSha256: createHash("sha256").update(await readFile(join(path, ".git", "config"))).digest("hex") });
  }

  private async importBundle(artifact: ArtifactManifest, targetPath: string, commit: string, baseCommit: string): Promise<void> {
    if (!commitPattern.test(commit) || !commitPattern.test(baseCommit) || artifact.metadata?.commit !== commit || artifact.metadata?.baseCommit !== baseCommit) throw new Error("Working directory bundle metadata does not match its exact commits");
    const ref = String(artifact.metadata?.ref ?? "");
    if (!/^refs\/[a-zA-Z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith("/") || ref.endsWith(".")) throw new Error("Working directory bundle omitted a safe advertised ref");
    const bundlePath = await this.options.artifacts.path(artifact);
    const emptyDirectories = bundleEmptyDirectories(artifact);
    const path = resolve(targetPath);
    await this.ensureOwnedParent(path);
    if (await exists(path)) throw new Error("Working directory import target already exists");
    await command(["init", "--quiet", path]);
    try {
      await privateConfiguration(path);
      await ownGit(path, "fetch", "--no-tags", bundlePath, `${ref}:refs/enoughfactory/seed`);
      if (await ownGit(path, "rev-parse", "--verify", "refs/enoughfactory/seed^{commit}") !== commit) throw new Error("Working directory bundle ref does not resolve to its claimed exact commit");
      await ownGit(path, "merge-base", "--is-ancestor", baseCommit, commit);
      await ownGit(path, "checkout", "--detach", "--force", commit);
      await restoreEmptyDirectories(path, emptyDirectories);
      if (inventoryHash(await workingDirectoryEmptyDirectories(path)) !== inventoryHash(emptyDirectories)) throw new Error("Working directory bundle directory inventory does not match its exact tree");
    } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  }

  private async bundle(path: string, commit: string, baseCommit: string, id: string, purpose: "source" | "output", all = false, context: { goalId?: string; taskId?: string; attemptId?: string } = {}): Promise<ArtifactManifest> {
    const ref = `refs/enoughfactory/working-directories/${purpose}/${randomUUID()}`;
    const temporary = join(dirname(path), `${randomUUID()}.bundle`);
    await ownGit(path, "update-ref", ref, commit);
    try {
      await ownGit(path, "bundle", "create", temporary, ref, ...(all ? ["--all"] : []));
      const emptyDirectories = await workingDirectoryEmptyDirectories(path);
      return await this.options.artifacts.putFile(temporary, { ...context, name: `working-directory-${id}-${purpose}-${commit}.bundle`, mime: "application/x-git-bundle", metadata: { ref, commit, baseCommit, workingDirectoryId: id, emptyDirectories, emptyDirectoriesSha256: inventoryHash(emptyDirectories) } });
    } finally { await rm(temporary, { force: true }); }
  }

  /** Never create through a symlink inside private storage. */
  private async ensureOwnedParent(path: string): Promise<void> {
    const selected = resolve(path);
    if (!contains(this.root, selected) || selected === this.root) throw new Error("Working directory targets must be inside app-owned storage");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let current = this.root;
    for (const part of relative(this.root, dirname(selected)).split(sep).filter(Boolean)) {
      current = join(current, part);
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Working directory storage contains an unsafe parent");
    }
  }

  private async verifyOwnedExistingParents(path: string): Promise<void> {
    const selected = resolve(path);
    if (!contains(this.root, selected) || selected === this.root) throw new Error("Working directory targets must be inside app-owned storage");
    let current = this.root;
    for (const part of relative(this.root, dirname(selected)).split(sep).filter(Boolean)) {
      current = join(current, part);
      const entry = await lstat(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Working directory storage contains an unsafe parent");
    }
  }
}

function validateEnvelope(source: Pick<WorkingDirectorySource, "id" | "name" | "kind" | "containerPath" | "baseCommit">): void {
  validateNames([source]);
  if (source.kind !== "git" && source.kind !== "folder") throw new Error("Unsupported working directory kind");
  if (source.containerPath !== `/workspaces/${source.name}`) throw new Error("Invalid working directory container path");
  if (!commitPattern.test(source.baseCommit)) throw new Error("Working directory source requires an exact baseline commit");
}
function validateSource(source: WorkingDirectorySource): void {
  validateEnvelope(source);
  if (source.sourceCommit && !commitPattern.test(source.sourceCommit)) throw new Error("Invalid original working directory commit");
  if (!source.sourceArtifact) throw new Error("Working directory source omitted its immutable bundle");
  bundleEmptyDirectories(source.sourceArtifact);
}

function inventoryHash(value: readonly EmptyWorkingDirectory[]): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function bundleEmptyDirectories(artifact: ArtifactManifest): EmptyWorkingDirectory[] {
  const value = artifact.metadata?.emptyDirectories, expectedHash = artifact.metadata?.emptyDirectoriesSha256;
  if (value === undefined && expectedHash === undefined) return [];
  if (!Array.isArray(value) || typeof expectedHash !== "string") throw new Error("Working directory bundle omitted its immutable empty directory inventory");
  let previous = "";
  const result: EmptyWorkingDirectory[] = value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid empty working directory inventory");
    const { path, mode } = entry as EmptyWorkingDirectory;
    if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || path <= previous || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("Invalid empty working directory inventory path or mode");
    previous = path;
    return { path, mode };
  });
  if (inventoryHash(result) !== expectedHash) throw new Error("Working directory empty directory inventory failed integrity verification");
  return result;
}
async function restoreEmptyDirectories(root: string, inventory: readonly EmptyWorkingDirectory[]): Promise<void> {
  for (const entry of inventory) {
    let current = root;
    for (const part of entry.path.split("/")) {
      current = join(current, part);
      try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const directory = await lstat(current);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Empty working directory inventory crosses a file or symlink");
    }
  }
  // Populate children before applying parent modes.
  for (const entry of [...inventory].reverse()) await chmod(join(root, ...entry.path.split("/")), entry.mode);
}
async function directory(path: string): Promise<string> {
  const resolved = await realpath(resolve(path));
  if (!(await lstat(resolved)).isDirectory()) throw new Error("Working directory must be a directory");
  return resolved;
}
function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }

/** No ambient Git configuration, hooks, signing, filesystem monitors or filter commands. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}
const gitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "init.templateDir=", "-c", "core.protectHFS=true", "-c", "core.protectNTFS=true"];
async function command(args: string[], path?: string): Promise<string> {
  const result = await run("git", [...gitOptions, ...(path ? ["-C", path] : []), ...args], { env: gitEnvironment(), inheritEnv: false, timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(`Working directory Git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}
async function ownGit(path: string, ...args: string[]): Promise<string> { return command(args, path); }
async function gitResult(path: string, ...args: string[]) { return run("git", [...gitOptions, "-C", path, ...args], { env: gitEnvironment(), inheritEnv: false, timeoutMs: 30_000 }); }
async function privateConfiguration(path: string): Promise<void> {
  for (const [key, value] of [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["user.name", "EnoughFactory"], ["user.email", "factory@enoughtools.com"], ["commit.gpgsign", "false"]]) await ownGit(path, "config", key!, value!);
}
async function replaceTree(source: string, target: string): Promise<void> {
  for (const entry of await readdir(target)) if (entry.toLowerCase() !== ".git") await rm(join(target, entry), { recursive: true, force: true });
  await copyTree(source, target);
}
async function copyTree(source: string, target: string): Promise<void> {
  for (const name of await readdir(source)) {
    if (name.toLowerCase() === ".git") continue;
    const from = join(source, name), to = join(target, name);
    const entry = await lstat(from);
    if (entry.isSymbolicLink()) await symlink(await readlink(from), to);
    else if (entry.isDirectory()) { await mkdir(to, { mode: (entry.mode & 0o777) | 0o700 }); await copyTree(from, to); await chmod(to, entry.mode & 0o777); }
    else if (entry.isFile()) await copyFile(from, to);
    else throw new Error(`Working directory contains an unsupported special file: ${name}`);
  }
}
