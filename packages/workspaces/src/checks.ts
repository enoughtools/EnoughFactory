import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { prepareToolchain, validatePreparedToolchain, verifyPreparedToolchain } from "@enoughfactory/runtime";
import { resolveDockerRuntime, runManagedDocker, type DockerRuntimeEndpoint } from "./docker.ts";
import { discoverSwiftBuildCaches, prepareSwiftBuildMountpoint, removeSwiftBuildMountpoints, type SwiftBuildCache, type SwiftBuildMountpoint } from "./swift-check-cache.ts";
import { captureSwiftCheckCompatibility, swiftCheckCompatibilityBootstrap } from "./swift-check-compatibility.ts";
import type { Candidate, CheckExecutor, CommandResult, DevelopmentToolchain } from "./types.ts";

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
        const emptyDirectoryRestorations: string[] = [];
        const environment = ["--env", `GIT_CONFIG_COUNT=${roots.length}`];
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
            const flag = `preserve_empty_${emptyDirectoryChecks.length}`;
            const diagnostic = shellLiteral(`Captured empty directory changed: ${root.containerPath}/${entry.path} (expected mode ${mode})`);
            emptyDirectoryChecks.push(`${flag}=0; if [ ! -L ${path} ] && [ -d ${path} ] && [ "$(stat -c '%a' -- ${path} 2>/dev/null)" = '${mode}' ]; then ${flag}=1; else printf '%s\\n' ${diagnostic} >&2; if [ "$command_status" -eq 0 ]; then command_status=1; fi; fi`);
            emptyDirectoryRestorations.push(`if [ "$${flag}" -eq 1 ] && [ ! -L ${path} ] && [ -d ${path} ]; then chmod '${mode}' -- ${path} 2>/dev/null || true; fi`);
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
        // Attest captured modes before accessibility cleanup. Restore only directories that
        // matched then; real mode edits fail the command and remain visible in final evidence.
        const cleanup = `cleanup() { command_status=$?; ${emptyDirectoryChecks.join("; ")}${emptyDirectoryChecks.length ? "; " : ""}chmod -R a+rwX ${roots.map(root => root.containerPath).join(" ")} 2>/dev/null || true; ${emptyDirectoryRestorations.join("; ")}${emptyDirectoryRestorations.length ? "; " : ""}trap - EXIT; exit "$command_status"; }`;
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
