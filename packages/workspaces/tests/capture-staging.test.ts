import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { stageCapturedSource } from "../src/capture-staging.ts";

const exec = promisify(execFile);

test("capture omits only new SwiftPM caches and preserves staged source, deletions and build inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "enough-capture-source-"));
  try {
    const git = async (...args: string[]) => (await exec("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args])).stdout;
    const file = async (path: string, value = "source\n") => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), value); };
    const packageAt = (path: string) => file(`${path}/Package.swift`, "// swift-tools-version: 6.0\n");
    const cacheAt = async (path: string) => {
      await file(`${path}/.build/build.db`, "generated database\n");
      await file(`${path}/.build/aarch64-unknown-linux-gnu/debug/description.json`, "{\"swiftCommands\":{}}\n");
      await file(`${path}/.build/aarch64-unknown-linux-gnu/debug/Module.swiftmodule`, "generated module\n");
    };
    await git("init", "--quiet");
    await git("config", "user.name", "Fixture"); await git("config", "user.email", "fixture@example.test");
    for (const path of ["Packages/Reading [Features]", "Packages/Tracked", "Packages/Staged", "Packages/Link", "Packages/Unrecognized"]) await packageAt(path);
    await file("Packages/Tracked/.build/input.txt");
    await file("Sources/main.swift"); await file("deleted.swift");
    await git("add", "--all"); await git("commit", "--quiet", "-m", "input");
    await cacheAt("Packages/Reading [Features]");
    await packageAt("Packages/New"); await cacheAt("Packages/New");
    await cacheAt("Packages/Tracked"); await file("Packages/Tracked/.build/input.txt", "authored input edit\n");
    await cacheAt("Packages/Staged"); await file("Packages/Staged/.build/explicit.txt", "explicit authored input\n");
    await git("add", "--", "Packages/Staged/.build/explicit.txt");
    await cacheAt("ordinary");
    await cacheAt("Packages/Link"); await rm(join(root, "Packages/Link/.build/build.db"));
    await symlink("../Package.swift", join(root, "Packages/Link/.build/build.db"));
    await file("Packages/Unrecognized/.build/notes.txt", "authored notes\n");
    await file("Sources/main.swift", "authored source edit\n"); await rm(join(root, "deleted.swift"));
    const options = { isRegularFile: async (path: string) => { const entry = await lstat(join(root, path)); return entry.isFile() && !entry.isSymbolicLink(); } };
    const result = await stageCapturedSource(git, options);
    assert.deepEqual(result.omittedSwiftBuildCaches.sort(), ["Packages/New/.build", "Packages/Reading [Features]/.build"]);
    const indexed = (await git("ls-files", "-z")).split("\0").filter(Boolean);
    assert(!indexed.some(path => path.startsWith("Packages/Reading [Features]/.build/")));
    assert(!indexed.some(path => path.startsWith("Packages/New/.build/")));
    for (const path of ["Packages/Tracked/.build/input.txt", "Packages/Tracked/.build/build.db", "Packages/Staged/.build/explicit.txt", "ordinary/.build/build.db", "Packages/Link/.build/build.db", "Packages/Unrecognized/.build/notes.txt", "Packages/New/Package.swift"]) assert(indexed.includes(path), path);
    assert.equal(await git("show", ":Sources/main.swift"), "authored source edit\n");
    assert.equal(await git("show", ":Packages/Tracked/.build/input.txt"), "authored input edit\n");
    assert(!indexed.includes("deleted.swift"));
    assert.equal(await readFile(join(root, "Packages/Reading [Features]/.build/build.db"), "utf8"), "generated database\n");
    assert.equal(await readFile(join(root, "Packages/New/.build/aarch64-unknown-linux-gnu/debug/Module.swiftmodule"), "utf8"), "generated module\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
