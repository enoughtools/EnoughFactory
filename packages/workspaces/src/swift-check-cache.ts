import { lstat, mkdir, readdir, rmdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { run } from "./process.ts";

export interface SwiftBuildCache {
  path: string;
  containerPath: string;
  rootPath: string;
}

/** Read the immutable checked tree, including integration's combined commit, not a mutable index. */
export async function discoverSwiftBuildCaches(roots: Array<{ path: string; containerPath: string; commit: string }>): Promise<SwiftBuildCache[]> {
  const caches: SwiftBuildCache[] = [];
  for (const root of roots) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(root.commit)) throw new Error("Invalid checked source commit");
    const result = await run("git", ["-C", root.path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "ls-tree", "-r", "-z", "--full-tree", root.commit]);
    if (result.exitCode !== 0) throw new Error(`Could not discover checked Swift packages: ${result.stderr.trim()}`);
    // process.run bounds captured output at 8 MiB. A boundary exactly after a NUL must
    // fail too; otherwise later tracked inputs could disappear from this safety check.
    if (result.stdout.length >= 8 * 1024 * 1024 || (result.stdout && !result.stdout.endsWith("\0"))) throw new Error("Checked source tree inventory was truncated");
    const entries = result.stdout.split("\0").filter(Boolean).map(entry => {
      const match = /^(\d{6}) (?:blob|commit) [a-f0-9]+\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Invalid checked source tree inventory");
      return { mode: match[1], path: match[2] };
    });
    for (const entry of entries) {
      if (posix.basename(entry.path) !== "Package.swift") continue;
      if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error(`Checked Swift manifest must be a regular file: ${entry.path}`);
      const directory = posix.dirname(entry.path);
      const cache = directory === "." ? ".build" : `${directory}/.build`;
      if (/[,\\"\r\n]/.test(cache) || cache.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Unsupported Swift build-cache path in checked source");
      if (entries.some(other => other.path === cache || other.path.startsWith(`${cache}/`))) throw new Error(`Cannot hide tracked Swift build inputs with a cache volume: ${cache}`);
      caches.push({ path: resolve(root.path, cache), containerPath: posix.join(root.containerPath, cache), rootPath: resolve(root.path) });
    }
  }
  return caches;
}

/** Check again for every command: a previous check must not introduce an input that a mount hides. */
async function realPackageAncestors(path: string, rootPath: string): Promise<void> {
  if (!path.startsWith(`${rootPath}/`)) throw new Error("Swift build cache must stay inside its checked source root");
  const root = await lstat(rootPath);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Checked source root must be a real directory");
  const relative = path.slice(rootPath.length + 1);
  let ancestor = rootPath;
  for (const part of relative.split("/").slice(0, -1)) {
    ancestor = join(ancestor, part);
    const entry = await lstat(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Swift package directory must be a real directory: ${ancestor}`);
  }
}

export async function prepareSwiftBuildMountpoint(cache: SwiftBuildCache, created: Map<string, string>, allowExisting: boolean): Promise<void> {
  await realPackageAncestors(cache.path, cache.rootPath);
  const entry = await lstat(cache.path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (entry) {
    // A captured secondary empty directory is source evidence too. Do not hide its later
    // contents behind a build volume or alter its recorded mode/inventory semantics.
    if (!allowExisting) throw new Error(`Cannot hide a captured Swift build directory: ${cache.path}`);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (await readdir(cache.path)).length) throw new Error(`Cannot hide existing Swift build-cache inputs: ${cache.path}`);
    return;
  }
  // No recursive creation: the package ancestors above have already been checked.
  await mkdir(cache.path);
  created.set(cache.path, cache.rootPath);
}

/** Never recursively delete an edited directory or follow a check-created symlink. */
export async function removeSwiftBuildMountpoints(created: Map<string, string>): Promise<void> {
  const failures: unknown[] = [];
  for (const [path, rootPath] of created) {
    try {
      await realPackageAncestors(path, rootPath);
      const entry = await lstat(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!entry) { created.delete(path); continue; }
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Swift build-cache mountpoint changed during the check: ${path}`);
      // rmdir fails if a check left host-visible bytes. Keep those bytes for the source audit.
      await rmdir(path);
      created.delete(path);
    } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, `Could not remove private Swift build-cache mountpoints: ${failures.map(error => error instanceof Error ? error.message : String(error)).join("; ")}`);
}
