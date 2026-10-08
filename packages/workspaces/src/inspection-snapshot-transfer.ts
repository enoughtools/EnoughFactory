import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lchmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ArtifactStore } from "./artifacts.ts";
import { InspectionSnapshotManager, verifyInspectionSnapshotContents, type InspectionSnapshot, type InspectionSnapshotManifest, type InspectionSnapshotRoot, type InspectionSourceEntry } from "./inspection-snapshots.ts";
import type { ArtifactManifest } from "./types.ts";
import { safeId } from "./process.ts";

export interface InspectionSnapshotSourceArtifact { rootId: string; manifest: ArtifactManifest }
export interface InspectionSnapshotTransfer {
  version: 1;
  snapshotId: string;
  sourceDigest: string;
  sourceArtifacts: InspectionSnapshotSourceArtifact[];
  sourceManifest: ArtifactManifest;
}
interface TransferPack { version: 1; purpose: "inspection-snapshot-transfer"; snapshot: InspectionSnapshotManifest; sourceArtifacts: InspectionSnapshotSourceArtifact[] }
type Context = { goalId: string; taskId: string; attemptId: string };
interface Limits { maxBytes?: number; maxEntries?: number; maxManifestBytes?: number; timeoutMs?: number }
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const shaPattern = /^[a-f0-9]{64}$/;
const aliases = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;
const gitOptions = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false", "-c", "core.protectHFS=true", "-c", "core.protectNTFS=true", "-c", "commit.gpgsign=false", "-c", "init.templateDir=", "-c", "transfer.unpackLimit=0", "-c", "fetch.unpackLimit=0", "-c", "pack.threads=1", "-c", "core.compression=6"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Export only private preview repositories. Original author indexes/refs are never touched. */
export async function exportInspectionSnapshot(input: { snapshot: InspectionSnapshot; artifacts: ArtifactStore; context: Context; signal?: AbortSignal; limits?: Limits }): Promise<InspectionSnapshotTransfer> {
  validateContext(input.context);
  const limits = normalizedLimits(input.limits), snapshot = input.snapshot;
  validateManifest(snapshot.manifest, limits);
  if (snapshot.id !== snapshot.manifest.id || snapshot.sourceDigest !== snapshot.manifest.sourceDigest) throw new Error("Inspection snapshot identity does not match its frozen manifest");
  const manager = new InspectionSnapshotManager({ dataDir: dirname(dirname(snapshot.path)) });
  await manager.verify(snapshot, input.signal);
  const scratch = await mkdtemp(join(snapshot.path, "transfer-"));
  const deadline = Date.now() + limits.timeoutMs;
  let uncertain = false;
  try {
    const sourceArtifacts: InspectionSnapshotSourceArtifact[] = [];
    let bundleBytes = 0;
    for (const root of snapshot.roots) {
      const path = join(scratch, `${root.id}.bundle`);
      await git(root.path, ["bundle", "create", path, "HEAD"], input.signal, deadline);
      if ((bundleBytes += (await lstat(path)).size) > limits.maxBytes + limits.maxManifestBytes) throw new Error("Inspection source bundle exceeds its transfer limit");
      const manifest = await input.artifacts.putFile(path, { ...input.context, name: `inspection-source-${snapshot.id}-${root.id}.bundle`, mime: "application/x-git-bundle", metadata: { purpose: "inspection-source-bundle", previewOnly: true, snapshotId: snapshot.id, rootId: root.id, sourceDigest: root.sourceDigest, commit: root.commit, ref: "HEAD" } });
      sourceArtifacts.push({ rootId: root.id, manifest });
    }
    await manager.verify(snapshot, input.signal);
    const pack: TransferPack = { version: 1, purpose: "inspection-snapshot-transfer", snapshot: snapshot.manifest, sourceArtifacts };
    const body = JSON.stringify(pack);
    if (Buffer.byteLength(body) > limits.maxManifestBytes) throw new Error("Inspection source manifest exceeds its transfer limit");
    const sourceManifest = await input.artifacts.put(body, { ...input.context, name: `inspection-source-${snapshot.id}.json`, mime: "application/json", metadata: { purpose: pack.purpose, previewOnly: true, snapshotId: snapshot.id, sourceDigest: snapshot.sourceDigest } });
    return { version: 1, snapshotId: snapshot.id, sourceDigest: snapshot.sourceDigest, sourceArtifacts, sourceManifest };
  } catch (error) { uncertain = (error as { code?: string }).code === "PROCESS_TEARDOWN_UNCONFIRMED"; throw error; }
  finally { if (!uncertain) await rm(scratch, { recursive: true, force: true }); }
}

/**
 * Import verified remote preview bytes without checking out agent-controlled Git trees.
 * Tree membership is compared to the immutable manifest before blobs are streamed into
 * exclusive files. Links are created last, directory modes/empty directories are restored,
 * and the original preview identity is checked before the private copy becomes visible.
 */
export async function importInspectionSnapshot(input: { dataDir: string; artifacts: ArtifactStore; sourceArtifacts: InspectionSnapshotSourceArtifact[]; sourceManifest: ArtifactManifest; expectedSource?: { snapshotId: string; sourceDigest: string }; context?: Context; signal?: AbortSignal; limits?: Limits }): Promise<InspectionSnapshot> {
  const limits = normalizedLimits(input.limits), deadline = Date.now() + limits.timeoutMs;
  if (input.sourceManifest.size > limits.maxManifestBytes || input.sourceManifest.size < 1) throw new Error("Inspection source manifest exceeds its transfer limit");
  const pack = JSON.parse((await input.artifacts.read(input.sourceManifest)).toString("utf8")) as TransferPack;
  if (pack.version !== 1 || pack.purpose !== "inspection-snapshot-transfer") throw new Error("Unsupported inspection snapshot transfer");
  validateManifest(pack.snapshot, limits);
  if (input.sourceManifest.metadata?.purpose !== pack.purpose || input.sourceManifest.metadata.previewOnly !== true || input.sourceManifest.metadata.snapshotId !== pack.snapshot.id || input.sourceManifest.metadata.sourceDigest !== pack.snapshot.sourceDigest) throw new Error("Inspection transfer manifest provenance does not match its frozen source");
  if (input.expectedSource && (input.expectedSource.snapshotId !== pack.snapshot.id || input.expectedSource.sourceDigest !== pack.snapshot.sourceDigest)) throw new Error("Inspection transfer belongs to a different requested source");
  const context = input.context ?? artifactContext(input.sourceManifest);
  validateContext(context); assertContext(input.sourceManifest, context, input.sourceManifest.deviceId);
  if (JSON.stringify(pack.sourceArtifacts) !== JSON.stringify(input.sourceArtifacts) || input.sourceArtifacts.length !== pack.snapshot.roots.length) throw new Error("Inspection source artifact set does not match its manifest");
  let bundleBytes = 0;
  for (let index = 0; index < input.sourceArtifacts.length; index++) {
    const entry = input.sourceArtifacts[index]!, root = pack.snapshot.roots[index]!, artifact = entry.manifest;
    if (entry.rootId !== root.id || artifact.size < 1 || artifact.size > limits.maxBytes + limits.maxManifestBytes || (bundleBytes += artifact.size) > limits.maxBytes + limits.maxManifestBytes || artifact.metadata?.purpose !== "inspection-source-bundle" || artifact.metadata.previewOnly !== true || artifact.metadata.snapshotId !== pack.snapshot.id || artifact.metadata.rootId !== root.id || artifact.metadata.sourceDigest !== root.sourceDigest || artifact.metadata.commit !== root.commit || artifact.metadata.ref !== "HEAD") throw new Error("Inspection bundle provenance does not match its frozen source");
    assertContext(artifact, context, input.sourceManifest.deviceId);
  }
  const storage = resolve(input.dataDir, "inspection-snapshots"); await ensurePrivateStorage(storage);
  const final = join(storage, pack.snapshot.id), manager = new InspectionSnapshotManager({ dataDir: input.dataDir });
  const snapshot = snapshotAt(pack.snapshot, final);
  try { await lstat(final); await manager.verify(snapshot, input.signal); return snapshot; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(storage, `.incoming-${randomUUID()}`); await mkdir(temporary, { mode: 0o700 });
  let uncertain = false;
  try {
    for (let index = 0; index < pack.snapshot.roots.length; index++) {
      input.signal?.throwIfAborted();
      const root = pack.snapshot.roots[index]!, path = index === 0 ? join(temporary, "source") : join(temporary, "source-working-directories", root.id);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await git(path, ["init", "--quiet", `--object-format=${root.commit.length === 64 ? "sha256" : "sha1"}`], input.signal, deadline);
      const bundle = await input.artifacts.path(input.sourceArtifacts[index]!.manifest);
      const advertised = await git(path, ["bundle", "list-heads", bundle], input.signal, deadline);
      if (advertised.trim() !== `${root.commit} HEAD`) throw new Error("Inspection bundle advertises a different synthetic commit");
      await git(path, ["bundle", "verify", bundle], input.signal, deadline);
      await git(path, ["fetch", "--no-tags", "--no-write-fetch-head", bundle, "HEAD:refs/enoughfactory/inspection"], input.signal, deadline);
      if ((await git(path, ["rev-parse", "--verify", "refs/enoughfactory/inspection^{commit}"], input.signal, deadline)).trim() !== root.commit || (await git(path, ["rev-list", "--parents", "-n", "1", root.commit], input.signal, deadline)).trim() !== root.commit) throw new Error("Inspection bundle requires a parentless exact synthetic preview commit");
      const tree = await git(path, ["ls-tree", "-r", "-z", "--full-tree", root.commit], input.signal, deadline);
      const objects = validateTree(tree, root.entries);
      for (const entry of root.entries) {
        if (entry.kind === "symlink") continue;
        const target = join(path, ...entry.path.split("/")); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        if (entry.kind === "directory") { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
        const output = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        const checksum = createHash("sha256"); let size = 0;
        try {
          await git(path, ["cat-file", "blob", objects.get(entry.path)!], input.signal, deadline, async chunk => {
            if ((size += chunk.length) > entry.size) throw new Error("Inspection blob exceeds its declared source size");
            checksum.update(chunk); await output.writeFile(chunk);
          });
          if (size !== entry.size || checksum.digest("hex") !== entry.sha256) throw new Error("Inspection blob does not match its source digest");
          await output.chmod(entry.mode);
        } finally { await output.close(); }
      }
      for (const entry of root.entries) if (entry.kind === "symlink") {
        const chunks: Buffer[] = []; let size = 0;
        await git(path, ["cat-file", "blob", objects.get(entry.path)!], input.signal, deadline, chunk => {
          if ((size += chunk.length) > 8192) throw new Error("Inspection symlink exceeds its transfer limit"); chunks.push(Buffer.from(chunk));
        });
        if (new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) !== entry.target) throw new Error("Inspection symlink does not match its frozen target");
        const target = join(path, ...entry.path.split("/")); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await symlink(entry.target, target);
        if (((await lstat(target)).mode & 0o777) !== entry.mode) await lchmod(target, entry.mode);
      }
      for (const entry of [...root.entries].reverse()) if (entry.kind === "directory") await chmod(join(path, ...entry.path.split("/")), entry.mode);
      await git(path, ["update-ref", "HEAD", root.commit], input.signal, deadline);
      await git(path, ["read-tree", "--reset", root.commit], input.signal, deadline);
    }
    await writeFile(join(temporary, "manifest.json"), JSON.stringify(pack.snapshot), { flag: "wx", mode: 0o400 });
    // Verify while still private, then atomically publish. A colliding final identity is preserved.
    const pending = snapshotAt(pack.snapshot, temporary);
    await verifyMaterialized(pending);
    await verifyInspectionSnapshotContents(pending, input.signal);
    const { rename } = await import("node:fs/promises"); await rename(temporary, final);
    await manager.verify(snapshot, input.signal);
    return snapshot;
  } catch (error) { uncertain = (error as { code?: string }).code === "PROCESS_TEARDOWN_UNCONFIRMED"; throw error; }
  finally { if (!uncertain) await retire(temporary); }
}

function snapshotAt(manifest: InspectionSnapshotManifest, path: string): InspectionSnapshot {
  return { id: manifest.id, path, sourceDigest: manifest.sourceDigest, manifest, roots: manifest.roots.map(({ entries: _entries, ...root }, index) => ({ ...root, path: index === 0 ? join(path, "source") : join(path, "source-working-directories", root.id), containerPath: `/workspaces/${root.name}` })) };
}
function validateManifest(manifest: InspectionSnapshotManifest, limits: Required<Limits>): void {
  if (!manifest || manifest.version !== 1 || manifest.purpose !== "development-inspection" || manifest.previewOnly !== true || !shaPattern.test(manifest.sourceDigest) || !Array.isArray(manifest.roots) || manifest.roots.length < 1 || manifest.roots.length > 9) throw new Error("Invalid frozen inspection snapshot manifest");
  if (typeof manifest.id !== "string") throw new Error("Invalid inspection snapshot identity");
  safeId(manifest.id);
  let totalBytes = 0, totalEntries = 0; const ids = new Set<string>(), names = new Set<string>();
  for (const root of manifest.roots) {
    if (typeof root.id !== "string" || typeof root.name !== "string") throw new Error("Invalid inspection root identity");
    safeId(root.id);
    if (!aliases.test(root.name) || ids.has(root.id.toLowerCase()) || names.has(root.name.toLowerCase()) || !commitPattern.test(root.commit) || (root.sourceCommit !== undefined && !commitPattern.test(root.sourceCommit)) || !["git", "folder"].includes(root.kind) || !shaPattern.test(root.sourceDigest) || !Array.isArray(root.entries)) throw new Error("Invalid inspection root manifest");
    if ((root.originalPath === undefined) !== (root.manifestSha256 === undefined) || (root.originalPath !== undefined && (typeof root.originalPath !== "string" || !isAbsolute(root.originalPath) || root.originalPath.includes("\0") || root.originalPath.length > 8192 || !shaPattern.test(root.manifestSha256!)))) throw new Error("Invalid original inspection source provenance");
    ids.add(root.id.toLowerCase()); names.add(root.name.toLowerCase()); let previous = "";
    const parents = new Map<string, string>();
    for (const entry of root.entries) {
      safeRelative(entry.path);
      if (entry.path <= previous || ++totalEntries > limits.maxEntries || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error("Invalid or excessive inspection source inventory");
      previous = entry.path;
      let parent = dirname(entry.path);
      while (parent !== ".") { if (parents.get(parent) !== "directory") throw new Error("Inspection entry traverses a missing directory or symlink"); parent = dirname(parent); }
      parents.set(entry.path, entry.kind);
      if (entry.kind === "file") { if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !shaPattern.test(entry.sha256)) throw new Error("Invalid inspection file manifest"); totalBytes += entry.size; }
      else if (entry.kind === "symlink") { if (typeof entry.target !== "string" || entry.target.includes("\0") || isAbsolute(entry.target) || Buffer.byteLength(entry.target) > 8192 || !inside("/source", resolve("/source", dirname(entry.path), entry.target))) throw new Error("Inspection symlink escapes its source root"); totalBytes += Buffer.byteLength(entry.target); }
      else if (entry.kind !== "directory") throw new Error("Unsupported inspection source entry");
      if (totalBytes > limits.maxBytes) throw new Error("Inspection source exceeds its byte limit");
    }
    if (hash(root.entries) !== root.sourceDigest) throw new Error("Inspection root digest does not match its exact source inventory");
  }
  if (hash(manifest.roots.map(({ id, name, sourceDigest }) => ({ id, name, sourceDigest }))) !== manifest.sourceDigest) throw new Error("Inspection aggregate source digest does not match its roots");
}
function validateTree(output: string, entries: InspectionSourceEntry[]): Map<string, string> {
  if (output.length >= 8 * 1024 * 1024 || (output && !output.endsWith("\0"))) throw new Error("Inspection Git tree exceeds its transfer limit");
  const expected = new Map(entries.filter(entry => entry.kind !== "directory").map(entry => [entry.path, entry])), objects = new Map<string, string>();
  for (const line of output.split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("Inspection bundle contains unsupported tree entries");
    const [, mode, object, path] = match; safeRelative(path!);
    const entry = expected.get(path!);
    if (!entry || objects.has(path!) || mode !== (entry.kind === "symlink" ? "120000" : (entry.mode & 0o100) ? "100755" : "100644")) throw new Error("Inspection bundle tree differs from its source manifest");
    objects.set(path!, object!);
  }
  if (objects.size !== expected.size) throw new Error("Inspection bundle omitted source entries");
  return objects;
}
async function verifyMaterialized(snapshot: InspectionSnapshot): Promise<void> {
  // Reject undeclared metadata too; the shared content verifier then checks every byte,
  // permission mode, symlink, directory, root digest and exact synthetic HEAD.
  for (let index = 0; index < snapshot.roots.length; index++) {
    const root = snapshot.roots[index]!;
    const names = new Set(snapshot.manifest.roots[index]!.entries.map(entry => entry.path));
    const visit = async (path: string): Promise<void> => {
      const { readdir } = await import("node:fs/promises");
      for (const name of await readdir(path)) {
        if (name === ".git" && path === root.path) continue;
        const child = join(path, name), selected = relative(root.path, child).split(sep).join("/");
        if (!names.has(selected)) throw new Error("Inspection materialized source contains undeclared entries");
        const entry = await lstat(child); if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(child);
      }
    };
    await visit(root.path);
  }
}
function safeRelative(path: string): void { if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") || isAbsolute(path) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Unsafe inspection source path"); }
function inside(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)); }
function normalizedLimits(input?: Limits): Required<Limits> { const limits = { maxBytes: 256 * 1024 * 1024, maxEntries: 30_000, maxManifestBytes: 16 * 1024 * 1024, timeoutMs: 300_000, ...input }; for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < 1 || value > ({ maxBytes: 1024 * 1024 * 1024, maxEntries: 100_000, maxManifestBytes: 32 * 1024 * 1024, timeoutMs: 600_000 } as Record<string, number>)[key]!) throw new Error("Invalid inspection transfer limits"); return limits; }
function artifactContext(artifact: ArtifactManifest): Context { return { goalId: artifact.goalId!, taskId: artifact.taskId!, attemptId: artifact.attemptId! }; }
function validateContext(context: Context): void { for (const key of ["goalId", "taskId", "attemptId"] as const) { if (typeof context[key] !== "string") throw new Error("Inspection transfer requires complete author authority"); safeId(context[key]); } }
function assertContext(artifact: ArtifactManifest, context: Context, deviceId: string): void { if (typeof deviceId !== "string" || !deviceId) throw new Error("Inspection transfer requires an author device identity"); safeId(deviceId); if (artifact.goalId !== context.goalId || artifact.taskId !== context.taskId || artifact.attemptId !== context.attemptId || artifact.deviceId !== deviceId) throw new Error("Inspection source artifact belongs to a different author authority"); }
async function ensurePrivateStorage(path: string): Promise<void> { let current: string = sep; for (const part of resolve(path).split(sep).filter(Boolean)) { current = join(current, part); try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } const entry = await lstat(current); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Inspection transfer storage contains an unsafe parent"); } }
async function retire(path: string): Promise<void> { try { const entry = await lstat(path); if (entry.isDirectory() && !entry.isSymbolicLink()) { await chmod(path, (entry.mode & 0o777) | 0o700); const { readdir } = await import("node:fs/promises"); for (const name of await readdir(path)) await retire(join(path, name)); } await rm(path, { recursive: true, force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }

async function git(path: string, args: string[], signal: AbortSignal | undefined, deadline: number, consume?: (chunk: Buffer) => void | Promise<void>): Promise<string> {
  signal?.throwIfAborted();
  const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("Inspection source transfer timed out");
  return new Promise((resolveResult, reject) => {
    const child = spawn("git", [...gitOptions, "-C", path, ...args], { detached: true, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = []; let stdoutBytes = 0, stderr = "", failure: unknown; let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, kind); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error; } };
    const stop = () => { kill("SIGTERM"); forceTimer ??= setTimeout(() => kill("SIGKILL"), 1000); };
    const abort = () => { failure ??= new Error("Inspection source transfer cancelled"); stop(); };
    const timer = setTimeout(() => { failure ??= new Error("Inspection source transfer timed out"); stop(); }, remaining);
    const consumed = (async () => { try { for await (const chunk of child.stdout) { if (consume) await consume(Buffer.from(chunk)); else { if ((stdoutBytes += chunk.length) > 8 * 1024 * 1024) throw new Error("Inspection Git output exceeds its transfer limit"); stdout.push(Buffer.from(chunk)); } } } catch (error) { failure ??= error; stop(); } })();
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString("utf8").slice(0, 16_384 - stderr.length); });
    child.once("error", error => { failure ??= error; });
    child.once("close", async code => {
      clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); signal?.removeEventListener("abort", abort); await consumed;
      if (code !== 0) failure ??= new Error(`Inspection Git ${args[0]} failed: ${stderr.trim() || code}`);
      if (failure) { kill("SIGKILL"); try { if (child.pid) process.kill(-child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { reject(failure); return; } } reject(Object.assign(new Error("Inspection transfer could not confirm process-group teardown; preserve its private scratch"), { code: "PROCESS_TEARDOWN_UNCONFIRMED", cause: failure })); }
      else { try { resolveResult(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout))); } catch (error) { reject(error); } }
    });
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  });
}
