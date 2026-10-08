import { posix } from "node:path";

type CaptureGit = (...args: string[]) => Promise<string>;
export interface CaptureStagingOptions {
  force?: boolean;
  isRegularFile: (path: string) => Promise<boolean>;
}

function inventory(output: string): string[] {
  if (output.length >= 8 * 1024 * 1024 || (output && !output.endsWith("\0"))) throw new Error("Capture source inventory was truncated");
  return output.split("\0").filter(Boolean);
}

/** Preserve authored source without promoting newly generated SwiftPM caches into Git. */
export async function stageCapturedSource(git: CaptureGit, options: CaptureStagingOptions): Promise<{ omittedSwiftBuildCaches: string[] }> {
  const add = ["add", "--all", ...(options.force ? ["--force"] : [])];
  // Update tracked inputs first without negative pathspecs. Excluding an ignored
  // directory can make Git reject the add even when its descendants are excluded.
  // New manifests are discovered from the untracked inventory below, before any
  // generated files can enter the index.
  await git("add", "--update", "--", ".");
  const indexed = inventory(await git("ls-files", "--stage", "-z")).map(value => {
    const match = /^(\d{6}) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(value);
    if (!match) throw new Error("Invalid capture source index inventory");
    return { mode: match[1], stage: match[2], path: match[3]! };
  });
  const untracked = inventory(await git("ls-files", "--others", ...(options.force ? [] : ["--exclude-standard"]), "-z"));
  const paths = new Set(untracked), omittedSwiftBuildCaches: string[] = [];
  const manifests = new Set([
    ...indexed.filter(entry => entry.stage === "0" && ["100644", "100755"].includes(entry.mode!) && posix.basename(entry.path) === "Package.swift").map(entry => entry.path),
    ...untracked.filter(file => posix.basename(file) === "Package.swift" && !file.split("/").includes(".build")),
  ]);
  for (const manifest of manifests) {
    if (!(await options.isRegularFile(manifest))) continue;
    const directory = posix.dirname(manifest), cache = directory === "." ? ".build" : `${directory}/.build`;
    // Tracked and explicitly staged build inputs remain source, regardless of names.
    if (indexed.some(other => other.path === cache || other.path.startsWith(`${cache}/`))) continue;
    const database = `${cache}/build.db`;
    const description = untracked.find(file => file.startsWith(`${cache}/`) && /^[^/]+\/(?:debug|release)\/description\.json$/.test(file.slice(cache.length + 1)));
    if (!paths.has(database) || !description || !(await options.isRegularFile(database)) || !(await options.isRegularFile(description))) continue;
    omittedSwiftBuildCaches.push(cache);
  }
  // Literal top-level pathspecs handle spaces, brackets and leading punctuation.
  // No ignore file, working-tree byte, or prior staged entry is removed or rewritten.
  await git(...add, "--", ".", ...omittedSwiftBuildCaches.map(cache => `:(top,literal,exclude)${cache}`));
  await git("add", "--update", "--", ".");
  return { omittedSwiftBuildCaches };
}
