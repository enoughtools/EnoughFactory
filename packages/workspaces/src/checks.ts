import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareToolchain, validatePreparedToolchain, verifyPreparedToolchain } from "@enoughfactory/runtime";
import { resolveDockerRuntime, runManagedDocker, type DockerRuntimeEndpoint } from "./docker.ts";
import { discoverSwiftBuildCaches, prepareSwiftBuildMountpoint, removeSwiftBuildMountpoints, type SwiftBuildCache, type SwiftBuildMountpoint } from "./swift-check-cache.ts";
import { captureSwiftCheckCompatibility, swiftCheckCompatibilityBootstrap } from "./swift-check-compatibility.ts";
import type { Candidate, CheckExecutor, CommandResult, DevelopmentToolchain, FrozenCheckInputs, WorkingDirectoryCapture } from "./types.ts";

const checkPathEnvironment = new Set(["ENOUGH_EVIDENCE_ROOT", "ENOUGH_NATIVE_UI_RECEIPT_DESCRIPTOR"]);
const checkDigestEnvironment = new Set(["ENOUGH_NATIVE_INDEX_SHA256", "ENOUGH_ACCEPTANCE_INDEX_SHA256"]);
const checkMountPattern = /^\/workspaces\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/;

type SourceMode = { kind: "directory" | "file" | "symlink"; mode: number };

/** The check owns these private copies; never follow authored links while attesting them. */
async function sourceModes(roots: readonly { path: string; containerPath: string }[], expected?: ReadonlyMap<string, SourceMode>): Promise<Map<string, SourceMode>> {
  const modes = new Map<string, SourceMode>();
  for (const root of roots) {
    if (!(await lstat(root.path)).isDirectory()) throw new Error("Check source root identity changed");
    const visit = async (path: string, relative: string): Promise<void> => {
      const key = `${root.containerPath}/${relative}`;
      // Newly generated dependency/build trees are not original inputs to attest.
      if (expected && !expected.has(key)) return;
      const state = await lstat(path);
      const kind = state.isSymbolicLink() ? "symlink" : state.isDirectory() ? "directory" : state.isFile() ? "file" : undefined;
      if (!kind) throw new Error(`Check source contains a special file: ${root.containerPath}/${relative}`);
      if (modes.size >= 100_000) throw new Error("Check source mode inventory exceeded its entry limit");
      modes.set(key, { kind, mode: state.mode & 0o777 });
      if (kind === "directory") {
        let names: string[];
        try { names = await readdir(path); }
        catch (error) { throw new Error(`Check source metadata is unreadable: ${key} (observed mode ${(state.mode & 0o777).toString(8)}${expected?.has(key) ? `, expected ${expected.get(key)!.mode.toString(8)}` : ""}): ${error instanceof Error ? error.message : String(error)}`); }
        for (const name of names.sort()) if (name.toLowerCase() !== ".git") await visit(join(path, name), relative ? `${relative}/${name}` : name);
      }
    };
    await visit(root.path, "");
  }
  return modes;
}

function changedSourceModes(before: Map<string, SourceMode>, after: Map<string, SourceMode>): string[] {
  const changes: string[] = [];
  for (const [path, expected] of before) {
    const actual = after.get(path);
    if (actual && actual.kind === expected.kind && actual.mode === expected.mode) continue;
    changes.push(`${path}: expected ${expected.kind} mode ${expected.mode.toString(8)}, observed ${actual ? `${actual.kind} mode ${actual.mode.toString(8)}` : "missing"}`);
  }
  return changes;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

/** Validate a copied check contract; capture/checking additionally binds paths to selected roots. */
export function validateCheckInputs(value: unknown, workingDirectories?: readonly Pick<WorkingDirectoryCapture, "id" | "containerPath">[]): FrozenCheckInputs | undefined {
  if (value === undefined) return;
  if (!plainRecord(value) || Object.keys(value).some(key => !["configurationRevision", "workingDirectoryIds", "environment"].includes(key)) || !Number.isSafeInteger(value.configurationRevision) || (value.configurationRevision as number) < 0) throw new Error("Invalid frozen check-input configuration");
  if (!Array.isArray(value.workingDirectoryIds) || value.workingDirectoryIds.length > 8 || value.workingDirectoryIds.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id))) throw new Error("Invalid frozen check-input working-directory identifiers");
  const workingDirectoryIds = value.workingDirectoryIds as string[];
  if (new Set(workingDirectoryIds.map(id => id.toLowerCase())).size !== workingDirectoryIds.length) throw new Error("Frozen check inputs repeat a working-directory identifier");
  if (!plainRecord(value.environment)) throw new Error("Invalid frozen check-input environment");
  const selectedRoots = new Map<string, string>();
  if (workingDirectories !== undefined) {
    if (!Array.isArray(workingDirectories) || workingDirectories.length > 8) throw new Error("Invalid captured check-input working directories");
    for (const id of workingDirectoryIds) {
      const matches = workingDirectories.filter(root => root.id === id);
      if (matches.length !== 1 || typeof matches[0]!.containerPath !== "string" || !checkMountPattern.test(matches[0]!.containerPath)) throw new Error("Frozen check inputs require their selected captured working directories");
      selectedRoots.set(id, matches[0]!.containerPath);
    }
  }
  const environment: Record<string, string> = {};
  for (const name of Object.keys(value.environment).sort()) {
    const entry = value.environment[name];
    if (typeof entry !== "string") throw new Error(`Invalid frozen check-input environment value: ${name}`);
    if (checkDigestEnvironment.has(name)) {
      if (!/^[a-f0-9]{64}$/.test(entry)) throw new Error(`Frozen check-input digest must be an exact SHA-256: ${name}`);
    } else if (checkPathEnvironment.has(name)) {
      const parts = entry.split("/");
      if (entry.length > 4096 || /[\u0000-\u001f\u007f\\]/.test(entry) || !checkMountPattern.test(parts.slice(0, 3).join("/")) || parts.slice(1).some(part => !part || part === "." || part === "..")) throw new Error(`Frozen check-input path must be a canonical container working-directory path: ${name}`);
      if (workingDirectories !== undefined && ![...selectedRoots.values()].some(root => entry === root || entry.startsWith(`${root}/`))) throw new Error(`Frozen check-input path is outside its selected captured working directories: ${name}`);
    } else throw new Error(`Unsupported frozen check-input environment name: ${name}`);
    environment[name] = entry;
  }
  return { configurationRevision: value.configurationRevision as number, workingDirectoryIds: [...workingDirectoryIds], environment };
}

export function candidateCheckInputs(candidate: Pick<Candidate, "checkInputs" | "bundleArtifact" | "diffArtifact" | "workingDirectories">): FrozenCheckInputs | undefined {
  const inputs = validateCheckInputs(candidate.checkInputs, candidate.workingDirectories ?? []);
  for (const artifact of [candidate.bundleArtifact, candidate.diffArtifact]) {
    const evidence = validateCheckInputs(artifact.metadata?.checkInputs, candidate.workingDirectories ?? []);
    if (JSON.stringify(evidence) !== JSON.stringify(inputs)) throw new Error("Candidate check inputs do not match their immutable source evidence");
  }
  return inputs;
}

export function frozenDevelopmentToolchain(value?: DevelopmentToolchain): DevelopmentToolchain | undefined {
  if (value === undefined) return;
  return validatePreparedToolchain(value);
}

export function sameDevelopmentRecipe(author: DevelopmentToolchain, checker: DevelopmentToolchain): boolean {
  return author.id === checker.id && author.recipeSha256 === checker.recipeSha256 && author.baseImage === checker.baseImage && author.swiftVersion === checker.swiftVersion && author.nodeVersion === checker.nodeVersion;
}

export function candidateDevelopmentToolchain(candidate: Pick<Candidate, "developmentToolchain" | "bundleArtifact" | "diffArtifact">): DevelopmentToolchain | undefined {
  const toolchain = frozenDevelopmentToolchain(candidate.developmentToolchain);
  for (const artifact of [candidate.bundleArtifact, candidate.diffArtifact]) {
    const evidence = frozenDevelopmentToolchain(artifact.metadata?.developmentToolchain as DevelopmentToolchain | undefined);
    if (JSON.stringify(evidence) !== JSON.stringify(toolchain)) throw new Error("Candidate toolchain does not match its immutable source evidence");
  }
  return toolchain;
}

/** Commands run as root with full network/tool access inside an isolated container. */
export function dockerCheckExecutor(options: { image?: string; dockerRuntime?: DockerRuntimeEndpoint } = {}): CheckExecutor {
  const metadataVolumes = new Map<string, Map<string, string>>();
  const buildCaches = new Map<string, Array<SwiftBuildCache & { volume: string }>>();
  const containers = new Map<string, Set<string>>();
  const mountpoints = new Map<string, Map<string, SwiftBuildMountpoint>>();
  const preparedToolchains = new Map<string, Promise<DevelopmentToolchain>>();
  const release = async (path: string) => {
    preparedToolchains.delete(path);
    const failures: unknown[] = [];
    if (!containers.get(path)?.size && !metadataVolumes.get(path)?.size && !buildCaches.get(path)?.length && !mountpoints.get(path)?.size) return;
    const dockerRuntime = resolveDockerRuntime(options.dockerRuntime);
    for (const name of containers.get(path) ?? []) {
      try {
        const result = await runManagedDocker(dockerRuntime, ["rm", "--force", name], { timeoutMs: 30_000 });
        if (result.timedOut || result.exitCode !== 0 && !/no such container/i.test(result.stderr)) throw new Error(result.timedOut ? "Check container removal timed out; termination is unconfirmed" : result.stderr.trim() || "Could not terminate check container");
        containers.get(path)?.delete(name);
      } catch (error) { failures.push(error); }
    }
    if (!containers.get(path)?.size) containers.delete(path);
    if (containers.has(path)) throw new AggregateError(failures, `Could not confirm private check containers stopped: ${failures.map(error => error instanceof Error ? error.message : String(error)).join("; ")}`);
    if (!containers.has(path)) {
      try { await removeSwiftBuildMountpoints(mountpoints.get(path) ?? new Map()); }
      catch (error) { failures.push(error); }
      if (!mountpoints.get(path)?.size) mountpoints.delete(path);
    }
    const volumes = metadataVolumes.get(path);
    const caches = buildCaches.get(path);
    for (const volume of new Set([...(volumes?.values() ?? []), ...(caches ?? []).map(cache => cache.volume)])) {
      try {
        const result = await runManagedDocker(dockerRuntime, ["volume", "rm", "--force", volume], { timeoutMs: 30_000 });
        if (result.timedOut || result.exitCode !== 0 && !/no such volume/i.test(result.stderr)) throw new Error(result.timedOut ? "Private check volume removal timed out; removal is unconfirmed" : result.stderr.trim() || "Could not remove private check volume");
        for (const [destination, name] of volumes ?? []) if (name === volume) volumes!.delete(destination);
        if (caches) buildCaches.set(path, (buildCaches.get(path) ?? []).filter(cache => cache.volume !== volume));
      } catch (error) { failures.push(error); }
    }
    if (!volumes?.size) metadataVolumes.delete(path);
    if (!buildCaches.get(path)?.length) buildCaches.delete(path);
    if (failures.length) throw new AggregateError(failures, `Could not release private check resources: ${failures.map(error => error instanceof Error ? error.message : String(error)).join("; ")}`);
  };
  const execute: CheckExecutor = async (context) => {
    try {
      const authorToolchain = candidateDevelopmentToolchain(context.candidate);
      const checkInputs = candidateCheckInputs(context.candidate);
      for (const id of checkInputs?.workingDirectoryIds ?? []) {
        const capture = context.candidate.workingDirectories!.find(root => root.id === id)!;
        const mounted = context.workingDirectories?.filter(root => root.containerPath === capture.containerPath);
        if (mounted?.length !== 1 || mounted[0]!.commit !== capture.commit) throw new Error("Frozen check inputs require the exact captured working-directory mounts");
      }
      const dockerRuntime = resolveDockerRuntime(options.dockerRuntime);
      let toolchain: DevelopmentToolchain | undefined;
      if (authorToolchain) {
        let preparation = preparedToolchains.get(context.path);
        if (!preparation) {
          preparation = prepareToolchain(dockerRuntime, authorToolchain.id, { signal: context.signal });
          preparedToolchains.set(context.path, preparation);
        }
        toolchain = frozenDevelopmentToolchain(await preparation)!;
        if (!sameDevelopmentRecipe(authorToolchain, toolchain)) throw new Error("The check runtime prepared a different development recipe from the candidate");
        await verifyPreparedToolchain(dockerRuntime, toolchain, { signal: context.signal });
      }
      for (const root of context.workingDirectories ?? []) {
        if (dirname(resolve(root.path)) !== resolve(`${context.path}-working-directories`)) throw new Error("Check working directories must use this report's private snapshot copies");
      }
      const roots = [{ path: context.path, containerPath: "/work", commit: context.commit }, ...context.workingDirectories ?? []];
      const destinations = new Set<string>();
      for (const root of roots) {
        if (root.containerPath !== "/work" && !/^\/workspaces\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(root.containerPath)) throw new Error("Invalid check working-directory destination");
        if (destinations.has(root.containerPath.toLowerCase())) throw new Error("Duplicate check working-directory destination");
        destinations.add(root.containerPath.toLowerCase());
      }
      const originalModes = await sourceModes(roots);
      const name = `enough-check-${randomUUID()}`;
      const reportContainers = containers.get(context.path) ?? new Set<string>();
      containers.set(context.path, reportContainers);
      reportContainers.add(name);
      const createdMountpoints = mountpoints.get(context.path) ?? new Map<string, SwiftBuildMountpoint>();
      mountpoints.set(context.path, createdMountpoints);
      let passed = false;
      let failureDetail = "";
      let completed: CommandResult | undefined;
      try {
        const volumes = metadataVolumes.get(context.path) ?? new Map<string, string>();
        metadataVolumes.set(context.path, volumes);
        const mounts: string[] = [];
        const initialization: string[] = [];
        const emptyDirectoryChecks: string[] = [];
        const environment = ["--env", `GIT_CONFIG_COUNT=${roots.length}`];
        for (const [key, value] of Object.entries(checkInputs?.environment ?? {})) environment.push(`--env=${key}=${value}`);
        let caches = buildCaches.get(context.path);
        if (!caches) {
          caches = (await discoverSwiftBuildCaches(roots)).map(cache => ({ ...cache, volume: `enough-check-swift-${randomUUID()}` }));
          // Register names before fallible setup/launch, including an ambiguous aborted Docker run.
          buildCaches.set(context.path, caches);
        }
        for (const cache of caches) {
          await prepareSwiftBuildMountpoint(cache, createdMountpoints, cache.rootPath === resolve(context.path));
        }
        for (const [index, root] of roots.entries()) {
          const volume = volumes.get(root.containerPath) ?? `enough-check-git-${randomUUID()}`;
          volumes.set(root.containerPath, volume);
          const seed = `/input-git-${index}`;
          mounts.push("--mount", `type=bind,source=${resolve(root.path)},target=${root.containerPath}`, "--mount", `type=bind,source=${resolve(root.path, ".git")},target=${seed},readonly`, "--mount", `type=volume,source=${volume},target=${root.containerPath}/.git,volume-nocopy`);
          initialization.push(`if [ ! -f ${root.containerPath}/.git/config ]; then cp -a ${seed}/. ${root.containerPath}/.git/; fi`);
          environment.push("--env", `GIT_CONFIG_KEY_${index}=safe.directory`, "--env", `GIT_CONFIG_VALUE_${index}=${root.containerPath}`);
          const capture = context.candidate.workingDirectories?.find(candidate => candidate.containerPath === root.containerPath);
          const inventory = capture?.bundleArtifact.metadata?.emptyDirectories ?? [];
          if (!Array.isArray(inventory)) throw new Error("Invalid captured empty-directory inventory");
          for (const entry of inventory) {
            if (!entry || typeof entry.path !== "string" || !entry.path || entry.path.includes("\0") || entry.path.includes("\\") || entry.path.startsWith("/") || entry.path.split("/").some((part: string) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw new Error("Invalid captured empty-directory path or mode");
            const path = shellLiteral(`${root.containerPath}/${entry.path}`);
            const mode = entry.mode.toString(8);
            const diagnostic = shellLiteral(`Captured empty directory changed: ${root.containerPath}/${entry.path} (expected mode ${mode})`);
            emptyDirectoryChecks.push(`if [ -L ${path} ] || [ ! -d ${path} ] || [ "$(stat -c '%a' -- ${path} 2>/dev/null)" != '${mode}' ]; then printf '%s\\n' ${diagnostic} >&2; if [ "$command_status" -eq 0 ]; then command_status=1; fi; fi`);
          }
        }
        // Keep nested cache mounts after their source binds. These fresh, per-package volumes
        // preserve SwiftPM's normal paths without sharing build databases between packages.
        for (const cache of caches) mounts.push("--mount", `type=volume,source=${cache.volume},target=${cache.containerPath},volume-nocopy`);
        const startedAt = new Date().toISOString();
        // Git metadata is private and writable inside the check container. The host metadata is a
        // read-only seed, overlaid by a volume at each root's .git. Checks can configure their Git
        // without changing the metadata used by the host's post-check inspection. All writable
        // source mounts are private exact candidate copies, never the original source folders.
        // Do not widen source permissions for cleanup: inspection binds their full modes.
        // Accessibility changes belong to retirement, after source/report evidence is saved.
        const cleanup = `cleanup() { command_status=$?; ${emptyDirectoryChecks.join("; ")}${emptyDirectoryChecks.length ? "; " : ""}trap - EXIT; exit "$command_status"; }`;
        const compatibility = process.platform === "darwin" && toolchain?.id === "swift-6.0.3" ? swiftCheckCompatibilityBootstrap() : undefined;
        const wrapper = `${initialization.join("; ")}; ${cleanup}; trap cleanup EXIT; ${compatibility?.preparation ?? ""}${compatibility?.invocation ?? `${toolchain ? "bash" : "sh"} -lc "$1"`}`;
        const output = await runManagedDocker(dockerRuntime, ["run", "--name", name, "--rm", "--user", "0:0", "--label", "enoughfactory.role=check", ...mounts, ...environment, "--workdir", "/work", toolchain?.image ?? options.image ?? "node:22-bookworm", "sh", "-c", wrapper, "enoughfactory-check", context.command], { timeoutMs: context.timeoutMs, signal: context.signal });
        const result = compatibility ? captureSwiftCheckCompatibility(output) : output;
        passed = result.exitCode === 0 && !result.timedOut;
        failureDetail = result.stderr;
        completed = { command: context.command, ...result, developmentToolchain: toolchain, startedAt, endedAt: new Date().toISOString() };
        return completed;
      } catch (error) {
        failureDetail = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        try {
          // Killing the client does not confirm termination. Remove the exact container;
          // mountpoint objects stay stable until the whole report is released.
          const removed = await runManagedDocker(dockerRuntime, ["rm", "--force", name], { timeoutMs: 30_000 });
          if (removed.timedOut || removed.exitCode !== 0 && !/no such container/i.test(removed.stderr)) throw new Error(removed.timedOut ? "Check container removal timed out; termination is unconfirmed" : removed.stderr.trim() || "Could not terminate check container");
          reportContainers.delete(name);
          // A stopped, removed exact container cannot race this read-only attestation.
          const changed = changedSourceModes(originalModes, await sourceModes(roots, originalModes));
          if (changed.length) {
            const detail = `Check changed source metadata:\n${changed.slice(0, 100).join("\n")}${changed.length > 100 ? `\n${changed.length - 100} more entries changed` : ""}`;
            passed = false;
            failureDetail = `${failureDetail ? `${failureDetail}\n` : ""}${detail}`;
            if (completed) { completed.exitCode = completed.exitCode || 1; completed.stderr = failureDetail; }
            else throw new Error(detail);
          }
        } catch (error) {
          passed = false;
          failureDetail = `${failureDetail ? `${failureDetail}\n` : ""}Check cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
          if (completed) completed.cleanupErrors = [...completed.cleanupErrors ?? [], error instanceof Error ? error.message : String(error)];
          else throw new Error(failureDetail);
        } finally {
          if (!passed) {
            try { await release(context.path); }
            catch (error) {
              if (completed) completed.cleanupErrors = [...completed.cleanupErrors ?? [], error instanceof Error ? error.message : String(error)];
              else throw new Error(`${failureDetail ? `${failureDetail}\n` : ""}${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      }
    } catch (error) {
      // Preparation failures must release earlier commands' report-owned resources as well.
      try { await release(context.path); }
      catch (cleanup) { throw new AggregateError([error, cleanup], `${error instanceof Error ? error.message : String(error)}\n${cleanup instanceof Error ? cleanup.message : String(cleanup)}`); }
      throw error;
    }
  };
  execute.release = release;
  return execute;
}

function shellLiteral(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
