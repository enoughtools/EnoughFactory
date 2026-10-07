import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { prepareToolchain, validatePreparedToolchain, verifyPreparedToolchain } from "@enoughfactory/runtime";
import { resolveDockerRuntime, runManagedDocker, type DockerRuntimeEndpoint } from "./docker.ts";
import type { Candidate, CheckExecutor, DevelopmentToolchain } from "./types.ts";

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
  const preparedToolchains = new Map<string, Promise<DevelopmentToolchain>>();
  const execute: CheckExecutor = async (context) => {
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
    const roots = [{ path: context.path, containerPath: "/work" }, ...context.workingDirectories ?? []];
    const destinations = new Set<string>();
    for (const root of roots) {
      if (root.containerPath !== "/work" && !/^\/workspaces\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(root.containerPath)) throw new Error("Invalid check working-directory destination");
      if (destinations.has(root.containerPath.toLowerCase())) throw new Error("Duplicate check working-directory destination");
      destinations.add(root.containerPath.toLowerCase());
    }
    const name = `enough-check-${randomUUID()}`;
    const volumes = metadataVolumes.get(context.path) ?? new Map<string, string>();
    metadataVolumes.set(context.path, volumes);
    const mounts: string[] = [];
    const initialization: string[] = [];
    const emptyDirectoryChecks: string[] = [];
    const emptyDirectoryRestorations: string[] = [];
    const environment = ["--env", `GIT_CONFIG_COUNT=${roots.length}`];
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
    const startedAt = new Date().toISOString();
    try {
      // Git metadata is private and writable inside the check container. The host metadata is a
      // read-only seed, overlaid by a volume at each root's .git. Checks can configure their Git
      // without changing the metadata used by the host's post-check inspection. All writable
      // source mounts are private exact candidate copies, never the original source folders.
      // Attest captured modes before accessibility cleanup. Restore only directories that
      // matched then; real mode edits fail the command and remain visible in final evidence.
      const cleanup = `cleanup() { command_status=$?; ${emptyDirectoryChecks.join("; ")}${emptyDirectoryChecks.length ? "; " : ""}chmod -R a+rwX ${roots.map(root => root.containerPath).join(" ")} 2>/dev/null || true; ${emptyDirectoryRestorations.join("; ")}${emptyDirectoryRestorations.length ? "; " : ""}trap - EXIT; exit "$command_status"; }`;
      const wrapper = `${initialization.join("; ")}; ${cleanup}; trap cleanup EXIT; ${toolchain ? "bash" : "sh"} -lc "$1"`;
      const result = await runManagedDocker(dockerRuntime, ["run", "--name", name, "--rm", "--user", "0:0", "--label", "enoughfactory.role=check", ...mounts, ...environment, "--workdir", "/work", toolchain?.image ?? options.image ?? "node:22-bookworm", "sh", "-c", wrapper, "enoughfactory-check", context.command], { timeoutMs: context.timeoutMs, signal: context.signal });
      return { command: context.command, ...result, developmentToolchain: toolchain, startedAt, endedAt: new Date().toISOString() };
    } finally {
      // Killing the Docker client does not confirm container termination.
      await runManagedDocker(dockerRuntime, ["rm", "--force", name]).catch(() => undefined);
    }
  };
  execute.release = async path => {
    preparedToolchains.delete(path);
    const volumes = metadataVolumes.get(path);
    metadataVolumes.delete(path);
    if (!volumes) return;
    const failures: unknown[] = [];
    for (const volume of volumes.values()) {
      try {
        const result = await runManagedDocker(resolveDockerRuntime(options.dockerRuntime), ["volume", "rm", "--force", volume]);
        if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "Could not remove check Git metadata volume");
      }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Could not release check Git metadata volumes");
  };
  return execute;
}

function shellLiteral(value: string): string { return `'${value.replaceAll("'", `'"'"'`)}'`; }
