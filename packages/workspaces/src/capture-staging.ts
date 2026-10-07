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
  // Discover newly authored manifests too. This first pass leaves every .build
  // subtree untouched; the final pass below still captures ordinary .build inputs.
  await git(...add, "--", ".", ":(exclude,glob).build/**", ":(exclude,glob)**/.build/**");
  const indexed = inventory(await git("ls-files", "--stage", "-z")).map(value => {
    const match = /^(\d{6}) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(value);
    if (!match) throw new Error("Invalid capture source index inventory");
    return { mode: match[1], stage: match[2], path: match[3]! };
  });
  const untracked = inventory(await git("ls-files", "--others", ...(options.force ? [] : ["--exclude-standard"]), "-z"));
  const paths = new Set(untracked), omittedSwiftBuildCaches: string[] = [];
  for (const entry of indexed) {
    if (entry.stage !== "0" || !["100644", "100755"].includes(entry.mode!) || posix.basename(entry.path) !== "Package.swift") continue;
    const directory = posix.dirname(entry.path), cache = directory === "." ? ".build" : `${directory}/.build`;
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
