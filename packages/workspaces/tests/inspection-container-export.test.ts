import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, lchmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InspectionSnapshotManager } from "../src/inspection-snapshots.ts";
import { exportInspectionContainerRoots } from "../src/inspection-container-export.ts";
import { git, run } from "../src/process.ts";

const containerId = "inspection-export-test-container";
const endpoint = { host: "unix:///private/enoughfactory-test.sock", cliPath: "/private/enoughfactory-tools/docker", configDirectory: "/private/enoughfactory-test-config" };
type Invocation = { command: string; args: string[]; env: NodeJS.ProcessEnv };
type Transport = (invocation: Invocation, options: { signal?: AbortSignal; timeoutMs: number }, consume: (chunk: Buffer) => Promise<void>) => Promise<{ exitCode: number; stderr: string }>;

// Run the exact read-only container script locally. No daemon, image or live Factory state is used.
const localTransport: Transport = async (invocation, options, consume) => {
  assert.equal(invocation.command, endpoint.cliPath);
  const separator = invocation.args.indexOf(containerId);
  assert.ok(separator >= 0, "the private Docker invocation must identify the requested container");
  assert.equal(invocation.args[separator + 1], process.execPath);
  const child = spawn(process.execPath, invocation.args.slice(separator + 2), { env: invocation.env, stdio: ["ignore", "pipe", "pipe"], signal: options.signal });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  try {
    for await (const chunk of child.stdout) await consume(Buffer.from(chunk));
    return { exitCode: await closed, stderr };
  } catch (error) { child.kill("SIGKILL"); await closed.catch(() => undefined); throw error; }
  finally { clearTimeout(timer); }
};

async function initializeRepository(path: string) {
  await mkdir(path, { recursive: true });
  const result = await run("git", ["init", "--quiet", "-b", "main", path]);
  assert.equal(result.exitCode, 0, result.stderr);
  await git(path, "config", "user.name", "Inspection Export Test");
  await git(path, "config", "user.email", "inspection@example.com");
}

async function assertEmptyScratch(path: string) {
  try { assert.deepEqual(await readdir(path), [], "a failed export must remove its partial source and stream staging"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

test("container inspection exports dirty roots with HEAD provenance without running Git helpers or changing its index", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-container-")));
  const project = join(root, "project"), plain = join(root, "notes"), scratch = join(root, "scratch");
  try {
    await initializeRepository(project);
    await writeFile(join(project, "tracked.txt"), "committed\n");
    await writeFile(join(project, "removed.txt"), "deleted in working copy\n");
    await writeFile(join(project, ".gitignore"), "cache/\nnode_modules/\n");
    await git(project, "add", "."); await git(project, "commit", "-qm", "Baseline");
    const commit = await git(project, "rev-parse", "HEAD");
    await writeFile(join(project, "tracked.txt"), "staged change\n");
    await git(project, "add", "tracked.txt");
    await writeFile(join(project, "tracked.txt"), "working change after staging\n");
    await rm(join(project, "removed.txt"));
    await mkdir(join(project, "new directory"));
    await writeFile(join(project, "new directory", "not-yet-committed.txt"), "untracked source\n");
    await mkdir(join(project, "cache")); await writeFile(join(project, "cache", "large.bin"), Buffer.alloc(32_768));
    await mkdir(join(project, "node_modules")); await writeFile(join(project, "node_modules", "dependency.js"), "ignored dependency\n");
    await mkdir(plain); await writeFile(join(plain, "notes.md"), "secondary root\n");
    const sentinel = join(root, "git-helper-ran");
    const hook = join(project, ".git", "hooks", "post-index-change");
    const monitor = join(root, "fsmonitor");
    const helper = `#!/bin/sh\nprintf ran >> '${sentinel.replaceAll("'", "'\\''")}'\nexit 0\n`;
    await writeFile(hook, helper); await chmod(hook, 0o700);
    await writeFile(monitor, helper); await chmod(monitor, 0o700);
    await git(project, "config", "core.fsmonitor", monitor);
    const indexBefore = await readFile(join(project, ".git", "index"));
    const headBefore = await readFile(join(project, ".git", "HEAD"));
    const indexStatBefore = await stat(join(project, ".git", "index"));
    const exported = await exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "mail-source", path: project }, { id: "notes", name: "Notes", path: plain }], scratchDirectory: scratch }, { transport: localTransport });
    try {
      assert.equal(exported.manifest.version, 1);
      assert.equal(exported.roots.length, 2);
      const source = exported.roots.find(item => item.id === "source")!;
      const notes = exported.roots.find(item => item.id === "notes")!;
      assert.equal(source.sourceCommit, commit);
      assert.equal(source.originalPath, project);
      assert.match(source.manifestSha256, /^[a-f0-9]{64}$/);
      assert.equal(await readFile(join(source.path, "tracked.txt"), "utf8"), "working change after staging\n");
      assert.equal(await readFile(join(source.path, "new directory", "not-yet-committed.txt"), "utf8"), "untracked source\n");
      assert.equal(await readFile(join(notes.path, "notes.md"), "utf8"), "secondary root\n");
      for (const omitted of ["removed.txt", "cache", "node_modules", ".git"]) await assert.rejects(access(join(source.path, omitted)), { code: "ENOENT" });
      assert.deepEqual(await readFile(join(project, ".git", "index")), indexBefore);
      assert.deepEqual(await readFile(join(project, ".git", "HEAD")), headBefore);
      assert.equal((await stat(join(project, ".git", "index"))).mtimeMs, indexStatBefore.mtimeMs);
      await assert.rejects(access(sentinel), { code: "ENOENT" });
      const snapshots = new InspectionSnapshotManager({ dataDir: join(root, "private-snapshots") });
      const snapshot = await snapshots.create({ roots: exported.roots });
      try {
        await snapshots.verify(snapshot);
        assert.equal(snapshot.roots[0]!.sourceCommit, commit);
        for (const [index, exportedRoot] of exported.roots.entries()) {
          assert.equal(snapshot.roots[index]!.originalPath, exportedRoot.originalPath);
          assert.equal(snapshot.roots[index]!.manifestSha256, exportedRoot.manifestSha256);
          assert.equal(snapshot.manifest.roots[index]!.originalPath, exportedRoot.originalPath);
          assert.equal(snapshot.manifest.roots[index]!.manifestSha256, exportedRoot.manifestSha256);
        }
        assert.equal(await readFile(join(snapshot.roots[0]!.path, "tracked.txt"), "utf8"), "working change after staging\n");
        assert.equal(await readFile(join(snapshot.roots[1]!.path, "notes.md"), "utf8"), "secondary root\n");
      } finally { await snapshots.remove(snapshot); }
    } finally { await exported.cleanup(); }
    await assert.rejects(access(exported.path), { code: "ENOENT" });
    await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("container inspection enforces byte and entry bounds and disposes partial exports", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-bounds-")));
  const project = join(root, "source"), scratch = join(root, "scratch");
  try {
    await mkdir(project); await writeFile(join(project, "one.txt"), Buffer.alloc(4_096, "a"));
    await writeFile(join(project, "two.txt"), "second file\n");
    for (const limits of [{ maxBytes: 1 }, { maxEntries: 1 }]) {
      await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch, limits }, { transport: localTransport }), /limit|maximum|bytes|entries/i);
      await assertEmptyScratch(scratch);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an interrupted container source stream is rejected and its partial files are removed", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-stream-")));
  const project = join(root, "source"), scratch = join(root, "scratch");
  try {
    await mkdir(project); await writeFile(join(project, "file.txt"), "must arrive in a complete verified stream\n");
    let transportUsed = false;
    const truncated: Transport = async (invocation, options, consume) => {
      transportUsed = true;
      const chunks: Buffer[] = [];
      const result = await localTransport(invocation, options, async chunk => { chunks.push(chunk); });
      assert.equal(result.exitCode, 0, result.stderr);
      const output = Buffer.concat(chunks);
      assert.ok(output.length > 1);
      await consume(output.subarray(0, Math.floor(output.length / 2)));
      return result;
    };
    await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch }, { transport: truncated }));
    assert.equal(transportUsed, true);
    await assertEmptyScratch(scratch);
    assert.equal(await readFile(join(project, "file.txt"), "utf8"), "must arrive in a complete verified stream\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("untrusted streamed paths cannot escape the owned export tree", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-path-")));
  const project = join(root, "source"), scratch = join(root, "scratch"), outside = join(root, "outside.txt");
  try {
    await mkdir(project); await writeFile(join(project, "file.txt"), "source contents\n");
    await writeFile(outside, "outside sentinel\n");
    for (const unsafePath of ["../../../outside.txt", outside, "directory/../outside.txt", ".git/config", ".GIT/config"]) {
      let changedEntry = false;
      const malicious: Transport = async (invocation, options, consume) => {
        const chunks: Buffer[] = [];
        const result = await localTransport(invocation, options, async chunk => { chunks.push(chunk); });
        assert.equal(result.exitCode, 0, result.stderr);
        const records = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
        const entry = records.find(record => record.type === "entry");
        assert.ok(entry); entry.path = unsafePath; changedEntry = true;
        await consume(Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n"));
        return result;
      };
      await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch }, { transport: malicious }), /unsafe inspection export path/i);
      assert.equal(changedEntry, true, "the test must exercise the streamed path validation");
      assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
      assert.equal(await readFile(join(project, "file.txt"), "utf8"), "source contents\n");
      await assertEmptyScratch(scratch);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a source edit during streaming retries from a new inventory and cannot publish mixed file bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-race-")));
  const project = join(root, "source"), scratch = join(root, "scratch"), sourceFile = join(project, "large.txt");
  const first = Buffer.alloc(2 * 1024 * 1024, "a"), edited = Buffer.alloc(first.length, "b");
  try {
    await mkdir(project); await writeFile(sourceFile, first);
    let calls = 0;
    const racing: Transport = async (invocation, options, consume) => {
      calls++;
      let observedOutput = false;
      return localTransport(invocation, options, async chunk => {
        // The file is larger than the pipe buffer: this occurs after its first inventory
        // and while the exporter is still writing, before its final verification.
        if (!observedOutput && calls === 1) { observedOutput = true; await writeFile(sourceFile, edited); }
        await consume(chunk);
      });
    };
    const exported = await exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch, limits: { maxRetries: 1 } }, { transport: racing });
    try {
      assert.equal(calls, 2, "the first changing source must be discarded before a fresh export");
      assert.deepEqual(await readFile(join(exported.roots[0]!.path, "large.txt")), edited);
      assert.deepEqual(await readFile(sourceFile), edited);
    } finally { await exported.cleanup(); }
    await assertEmptyScratch(scratch);
    await writeFile(sourceFile, first); calls = 0;
    await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch, limits: { maxRetries: 0 } }, { transport: racing }), error => (error as { code?: string }).code === "SOURCE_CHANGED");
    assert.equal(calls, 1, "a caller disabling retries must receive the source-change failure");
    await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("folder exports preserve authored directories, empty folders and read-only modes, and clean them up", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-folders-")));
  const project = join(root, "source"), scratch = join(root, "scratch");
  const readOnly = join(project, "read-only"), nested = join(readOnly, "nested"), empty = join(nested, "empty");
  try {
    await mkdir(empty, { recursive: true });
    await writeFile(join(nested, "source.txt"), "read-only authored source\n", { mode: 0o444 });
    for (const directory of ["build", "dist", "node_modules"]) {
      await mkdir(join(project, directory));
      await writeFile(join(project, directory, "authored.txt"), `authored input in ${directory}\n`);
    }
    await chmod(empty, 0o555); await chmod(nested, 0o555); await chmod(readOnly, 0o555);
    const input = { endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch };
    const exported = await exportInspectionContainerRoots(input, { transport: localTransport });
    try {
      const output = exported.roots[0]!;
      assert.equal(output.kind, "folder");
      for (const path of ["read-only", "read-only/nested", "read-only/nested/empty"]) {
        const metadata = await stat(join(output.path, path));
        assert.equal(metadata.isDirectory(), true);
        assert.equal(metadata.mode & 0o777, 0o555);
      }
      assert.deepEqual(await readdir(join(output.path, "read-only/nested/empty")), []);
      assert.equal((await stat(join(output.path, "read-only/nested/source.txt"))).mode & 0o777, 0o444);
      for (const directory of ["build", "dist", "node_modules"]) assert.equal(await readFile(join(output.path, directory, "authored.txt"), "utf8"), `authored input in ${directory}\n`);
    } finally { await exported.cleanup(); }
    await assertEmptyScratch(scratch);
    const missingCompletion: Transport = async (invocation, options, consume) => {
      const chunks: Buffer[] = [];
      const result = await localTransport(invocation, options, async chunk => { chunks.push(chunk); });
      assert.equal(result.exitCode, 0, result.stderr);
      const records = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
      assert.equal(records.at(-1)?.type, "complete");
      records.pop(); // root-end has already applied the imported read-only modes.
      await consume(Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n"));
      return result;
    };
    await assert.rejects(exportInspectionContainerRoots(input, { transport: missingCompletion }), /ended before completion/i);
    await assertEmptyScratch(scratch);
    assert.equal((await stat(readOnly)).mode & 0o777, 0o555, "cleanup must not change permissions on the author source");
    assert.equal(await readFile(join(nested, "source.txt"), "utf8"), "read-only authored source\n");
  } finally {
    for (const path of [readOnly, nested, empty]) await chmod(path, 0o755).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("container exports preserve internal symlinks and reject relative or absolute escapes without following them", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-symlinks-")));
  const project = join(root, "source"), scratch = join(root, "scratch"), outside = join(root, "outside.txt");
  try {
    await mkdir(join(project, "nested"), { recursive: true });
    await writeFile(join(project, "actual.txt"), "inside source\n"); await writeFile(outside, "outside sentinel\n");
    await symlink("actual.txt", join(project, "link.txt"));
    await symlink("../actual.txt", join(project, "nested", "link.txt"));
    // Linux links report 0777; macOS creates 0755 links by default. Explicitly
    // emulate Linux producer metadata while testing the real Mac receiver.
    if (process.platform === "darwin") for (const name of ["link.txt", "nested/link.txt"]) await lchmod(join(project, name), 0o777);
    const input = { endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch };
    const exported = await exportInspectionContainerRoots(input, { transport: localTransport });
    try {
      for (const [path, target] of [["link.txt", "actual.txt"], ["nested/link.txt", "../actual.txt"]]) {
        assert.equal((await lstat(join(exported.roots[0]!.path, path!))).isSymbolicLink(), true);
        assert.equal((await lstat(join(exported.roots[0]!.path, path!))).mode & 0o777, 0o777);
        assert.equal(await readlink(join(exported.roots[0]!.path, path!)), target);
        assert.equal(await readFile(join(exported.roots[0]!.path, path!), "utf8"), "inside source\n");
      }
      const manager = new InspectionSnapshotManager({ dataDir: join(root, "snapshots") });
      const snapshot = await manager.create({ roots: exported.roots });
      try {
        for (const name of ["link.txt", "nested/link.txt"]) assert.equal((await lstat(join(snapshot.roots[0]!.path, name))).mode & 0o777, 0o777);
        assert.ok(snapshot.manifest.roots[0]!.entries.filter(entry => entry.kind === "symlink").every(entry => entry.mode === 0o777));
        await manager.verify(snapshot);
      } finally { await manager.remove(snapshot); }
    } finally { await exported.cleanup(); }
    for (const target of ["../outside.txt", outside]) {
      const unsafe = join(project, "unsafe.txt"); await symlink(target, unsafe);
      try { await assert.rejects(exportInspectionContainerRoots(input, { transport: localTransport }), /symlink must remain inside/i); }
      finally { await rm(unsafe); }
      assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
      await assertEmptyScratch(scratch);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a tracked deletion under an empty Git directory does not recreate that parent in the exported tree", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-deletion-")));
  const project = join(root, "source"), scratch = join(root, "scratch");
  try {
    await initializeRepository(project);
    await mkdir(join(project, "removed", "nested"), { recursive: true });
    await writeFile(join(project, "removed", "nested", "tracked.txt"), "tracked then removed\n");
    await writeFile(join(project, "retained.txt"), "retained\n");
    await git(project, "add", "."); await git(project, "commit", "-qm", "Baseline");
    await rm(join(project, "removed", "nested", "tracked.txt"));
    assert.deepEqual(await readdir(join(project, "removed", "nested")), []);
    const exported = await exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch }, { transport: localTransport });
    try {
      await assert.rejects(access(join(exported.roots[0]!.path, "removed")), { code: "ENOENT" });
      assert.equal(await readFile(join(exported.roots[0]!.path, "retained.txt"), "utf8"), "retained\n");
    } finally { await exported.cleanup(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("container inspection copies raw CRLF working bytes without invoking configured attribute filters", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-filters-")));
  const project = join(root, "source"), scratch = join(root, "scratch"), sentinel = join(root, "filter-ran");
  const contents = Buffer.from("first line\r\nsecond line\r\n");
  try {
    await initializeRepository(project);
    await writeFile(join(project, ".gitattributes"), "*.txt text eol=lf filter=inspection-spy\n");
    await writeFile(join(project, "source.txt"), contents);
    await git(project, "add", "."); await git(project, "commit", "-qm", "Baseline");
    const filter = join(root, "filter");
    await writeFile(filter, `#!/bin/sh\nprintf ran >> '${sentinel.replaceAll("'", "'\\''")}'\ncat\n`, { mode: 0o700 });
    await git(project, "config", "filter.inspection-spy.clean", filter);
    await git(project, "config", "filter.inspection-spy.smudge", filter);
    await git(project, "config", "filter.inspection-spy.required", "true");
    await git(project, "config", "core.autocrlf", "true");
    await writeFile(join(project, "source.txt"), contents);
    const index = await readFile(join(project, ".git", "index"));
    const exported = await exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch }, { transport: localTransport });
    try {
      assert.deepEqual(await readFile(join(exported.roots[0]!.path, "source.txt")), contents);
      assert.deepEqual(await readFile(join(project, "source.txt")), contents);
      assert.deepEqual(await readFile(join(project, ".git", "index")), index);
      await assert.rejects(access(sentinel), { code: "ENOENT" });
    } finally { await exported.cleanup(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("container root selection rejects nested roots and two spellings of the same directory", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-overlap-")));
  const project = join(root, "source"), nested = join(project, "nested"), alias = join(root, "source-alias"), scratch = join(root, "scratch");
  try {
    await mkdir(nested, { recursive: true }); await writeFile(join(nested, "file.txt"), "source\n");
    await symlink(project, alias);
    for (const path of [nested, alias]) {
      await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }, { id: "overlap", name: "Overlap", path }], scratchDirectory: scratch }, { transport: localTransport }), /roots must not overlap/i);
      await assertEmptyScratch(scratch);
      assert.equal(await readFile(join(nested, "file.txt"), "utf8"), "source\n");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Git directory replacements export the new file or contained symlink while marking old descendants deleted", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-replacement-")));
  const project = join(root, "source"), scratch = join(root, "scratch"), replaced = join(project, "dir");
  try {
    await initializeRepository(project);
    await mkdir(replaced); await writeFile(join(replaced, "old.txt"), "original tracked descendant\n");
    await mkdir(join(project, "safe-target")); await writeFile(join(project, "safe-target", "old.txt"), "separate target source\n");
    await git(project, "add", "."); await git(project, "commit", "-qm", "Baseline");
    const head = await git(project, "rev-parse", "HEAD"), index = await readFile(join(project, ".git", "index"));
    for (const replacement of ["file", "symlink"] as const) {
      await rm(replaced, { recursive: true, force: true });
      if (replacement === "file") await writeFile(replaced, "new regular file\n");
      else await symlink("safe-target", replaced);
      const chunks: Buffer[] = [];
      const observed: Transport = async (invocation, options, consume) => localTransport(invocation, options, async chunk => { chunks.push(chunk); await consume(chunk); });
      const exported = await exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch }, { transport: observed });
      try {
        const records = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
        const previousDescendant = records.find(record => record.type === "entry" && record.path === "dir/old.txt");
        assert.equal(previousDescendant?.sourceType, "deleted", "cached descendants hidden by the replacement must not be read through its new type");
        const output = exported.roots[0]!.path;
        if (replacement === "file") {
          assert.equal((await lstat(join(output, "dir"))).isFile(), true);
          assert.equal(await readFile(join(output, "dir"), "utf8"), "new regular file\n");
          await assert.rejects(access(join(output, "dir", "old.txt")), { code: "ENOTDIR" });
        } else {
          assert.equal((await lstat(join(output, "dir"))).isSymbolicLink(), true);
          assert.equal(await readlink(join(output, "dir")), "safe-target");
          assert.equal(await readFile(join(output, "safe-target", "old.txt"), "utf8"), "separate target source\n");
        }
        assert.equal(await readFile(join(project, "safe-target", "old.txt"), "utf8"), "separate target source\n");
        assert.equal(exported.roots[0]!.sourceCommit, head);
        assert.deepEqual(await readFile(join(project, ".git", "index")), index);
      } finally { await exported.cleanup(); }
      await assertEmptyScratch(scratch);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("snapshot integration ignores an ancestor host repository around transferred roots and retains original source provenance", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-host-ancestor-")));
  const project = join(root, "container-source"), host = join(root, "host-repository");
  try {
    await initializeRepository(project);
    await writeFile(join(project, "source.txt"), "original source\n");
    await git(project, "add", "."); await git(project, "commit", "-qm", "Source baseline");
    const originalCommit = await git(project, "rev-parse", "HEAD");
    await writeFile(join(project, "source.txt"), "dirty source to inspect\n");
    await writeFile(join(project, "untracked.txt"), "untracked source to inspect\n");
    await initializeRepository(host);
    await writeFile(join(host, ".gitignore"), ".cache/\n");
    await writeFile(join(host, "unrelated-host.txt"), "host repository must never supply preview source\n");
    await git(host, "add", "."); await git(host, "commit", "-qm", "Host baseline");
    const hostCommit = await git(host, "rev-parse", "HEAD");
    assert.notEqual(originalCommit, hostCommit);
    const scratch = join(host, ".cache", "exports");
    const exported = await exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "source", name: "Source", path: project }], scratchDirectory: scratch }, { transport: localTransport });
    try {
      const snapshots = new InspectionSnapshotManager({ dataDir: join(host, ".cache", "snapshot-store") });
      const snapshot = await snapshots.create({ roots: exported.roots });
      try {
        await snapshots.verify(snapshot);
        assert.equal(snapshot.roots[0]!.sourceCommit, originalCommit);
        assert.equal(snapshot.manifest.roots[0]!.sourceCommit, originalCommit);
        for (const observed of [snapshot.roots[0]!, snapshot.manifest.roots[0]!]) {
          assert.equal(observed.originalPath, project);
          assert.equal(observed.manifestSha256, exported.roots[0]!.manifestSha256);
        }
        assert.equal(await readFile(join(snapshot.roots[0]!.path, "source.txt"), "utf8"), "dirty source to inspect\n");
        assert.equal(await readFile(join(snapshot.roots[0]!.path, "untracked.txt"), "utf8"), "untracked source to inspect\n");
        await assert.rejects(access(join(snapshot.roots[0]!.path, "unrelated-host.txt")), { code: "ENOENT" });
        assert.equal(await git(host, "rev-parse", "HEAD"), hostCommit);
      } finally { await snapshots.remove(snapshot); }
    } finally { await exported.cleanup(); }
    await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Docker OCI startup failure names the missing pinned helper and preserves the author's source", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-helper-start-")));
  const source = join(root, "source"), scratch = join(root, "scratch");
  try {
    await mkdir(source); await writeFile(join(source, "mail.ts"), "author source remains unchanged\n");
    const diagnostic = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "/opt/enoughfactory/node/bin/node": stat /opt/enoughfactory/node/bin/node: no such file or directory: unknown\r\n';
    const transport: Transport = async (_invocation, _options, consume) => { await consume(Buffer.from(diagnostic)); return { exitCode: 127, stderr: "" }; };
    await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, roots: [{ id: "mail", name: "Mail", path: source }], scratchDirectory: scratch }, { transport }), error => {
      const failure = error as Error & { code?: string };
      assert.equal(failure.code, "INSPECTION_EXPORT_HELPER_START_FAILED");
      assert.match(failure.message, /(?:helper|source export).*(?:could not|couldn't|failed to|unable to) start|(?:could not|couldn't|failed to|unable to) start.*(?:helper|source export)/i);
      assert.ok(failure.message.includes("/opt/enoughfactory/node/bin/node"));
      assert.ok(Buffer.byteLength(failure.message) <= 1200, "startup diagnostics stay bounded");
      return true;
    });
    assert.equal(await readFile(join(source, "mail.ts"), "utf8"), "author source remains unchanged\n");
    await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("non-UTF8 startup output has a bounded safe helper diagnostic rather than a source protocol error", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-binary-start-")));
  const source = join(root, "source"), scratch = join(root, "scratch");
  try {
    await mkdir(source); await writeFile(join(source, "mail.ts"), "unchanged\n");
    for (const raw of [
      Buffer.concat([Buffer.from([0xff, 0xfe, 0]), Buffer.from("\u001b[31mOCI runtime exec failed: " + "unexpected output ".repeat(800) + "\u001b[0m\n")]),
      // Replacement characters encode to more bytes than the original binary
      // input, so bounding before UTF8 decoding does not bound the final error.
      Buffer.concat([Buffer.alloc(1000, 0xff), Buffer.from("\n")]),
    ]) {
      const transport: Transport = async (_invocation, _options, consume) => { await consume(raw); return { exitCode: 127, stderr: "" }; };
      await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, roots: [{ id: "mail", name: "Mail", path: source }], scratchDirectory: scratch }, { transport }), error => {
        const failure = error as Error & { code?: string };
        assert.equal(failure.code, "INSPECTION_EXPORT_HELPER_START_FAILED");
        assert.ok(Buffer.byteLength(failure.message) <= 1200);
        assert.equal(/[\u0000\u001b]/.test(failure.message), false, "untrusted startup output cannot inject terminal escapes or NUL into the error UI");
        return true;
      });
      await assertEmptyScratch(scratch);
    }
    assert.equal(await readFile(join(source, "mail.ts"), "utf8"), "unchanged\n");
    await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("malformed records after helper startup produce a typed protocol error without exposing source payload", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-private-protocol-")));
  const source = join(root, "source"), scratch = join(root, "scratch");
  try {
    await mkdir(source); await writeFile(join(source, "mail.ts"), "unchanged\n");
    const sourceSentinel = "sensitive author source bytes must not enter error messages", encoded = Buffer.from(sourceSentinel).toString("base64");
    const transport: Transport = async (_invocation, _options, consume) => {
      await consume(Buffer.from('{"type":"start","version":1}\n'));
      await consume(Buffer.from(encoded + "\n")); return { exitCode: 0, stderr: "" };
    };
    await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, roots: [{ id: "mail", name: "Mail", path: source }], scratchDirectory: scratch }, { transport }), error => {
      const failure = error as Error & { code?: string };
      assert.equal(failure.code, "INSPECTION_EXPORT_PROTOCOL");
      assert.equal(failure.message.includes(encoded), false);
      assert.equal(failure.message.includes(sourceSentinel), false);
      assert.ok(Buffer.byteLength(failure.message) <= 1200); return true;
    });
    assert.equal(await readFile(join(source, "mail.ts"), "utf8"), "unchanged\n");
    await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("valid Unicode records survive byte-fragmented transport and source chunks keep their exact bytes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-fragmented-")));
  const source = join(root, "source"), scratch = join(root, "scratch"), name = "caf\u00e9-\u90ae\u4ef6-\ud83d\udcec.txt";
  const bytes = Buffer.from("raw source with Unicode \u90ae\u4ef6 and CRLF\r\n".repeat(2500));
  try {
    await mkdir(source); await writeFile(join(source, name), bytes);
    const transport: Transport = async (invocation, options, consume) => {
      const output: Buffer[] = [];
      const result = await localTransport(invocation, options, async chunk => { output.push(Buffer.from(chunk)); });
      const stream = Buffer.concat(output); let cursor = 0, records = 0;
      while (cursor < stream.length) {
        const newline = stream.indexOf(10, cursor), end = newline < 0 ? stream.length : newline + 1;
        const line = stream.subarray(cursor, end);
        // Fragment metadata one byte at a time, including inside multibyte UTF8.
        // Chunk payload uses varied cuts so the test remains fast with real files.
        const step = line.includes(Buffer.from('"type":"chunk"')) ? [1, 7, 4096, 13, 32768][records % 5]! : 1;
        for (let position = 0; position < line.length; position += step) await consume(line.subarray(position, position + step));
        records++; cursor = end;
      }
      return result;
    };
    const exported = await exportInspectionContainerRoots({ endpoint, containerId, nodeExecutable: process.execPath, roots: [{ id: "mail", name: "Mail", path: source }], scratchDirectory: scratch }, { transport });
    try { assert.deepEqual(await readFile(join(exported.roots[0]!.path, name)), bytes); }
    finally { await exported.cleanup(); }
    assert.deepEqual(await readFile(join(source, name)), bytes); await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a well-formed unsupported helper version keeps its compatibility error", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "enough-inspection-protocol-version-")));
  const source = join(root, "source"), scratch = join(root, "scratch");
  try {
    await mkdir(source); await writeFile(join(source, "mail.ts"), "unchanged\n");
    const transport: Transport = async (_invocation, _options, consume) => { await consume(Buffer.from('{"type":"start","version":2}\n')); return { exitCode: 0, stderr: "" }; };
    await assert.rejects(exportInspectionContainerRoots({ endpoint, containerId, roots: [{ id: "mail", name: "Mail", path: source }], scratchDirectory: scratch }, { transport }), error => {
      const failure = error as Error & { code?: string };
      assert.match(failure.message, /inspection export protocol version/i);
      assert.notEqual(failure.code, "INSPECTION_EXPORT_HELPER_START_FAILED"); return true;
    });
    assert.equal(await readFile(join(source, "mail.ts"), "utf8"), "unchanged\n"); await assertEmptyScratch(scratch);
  } finally { await rm(root, { recursive: true, force: true }); }
});
