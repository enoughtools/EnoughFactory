import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, run } from "./process.ts";
import type { Candidate, ManagedWorkspaceProvider, WorkspaceRecord } from "./types.ts";

export const ARTIFACTFS_REVISION = "6a62f2f34aebe75da3d8b917131a6ace185928e5";
export const ARTIFACTFS_IMAGE = "enoughfactory/artifactfs:6a62f2f34aeb";

export interface ArtifactFsMountRecord {
  version: 1;
  provider: "artifactfs";
  attemptId: string;
  baseCommit: string;
  branch: string;
  containerName: string;
  containerId: string;
  stateVolume: string;
  bindSource: string;
  managerMountPath: "/mount/repo";
  stateTarget: "/var/lib/artifact-fs";
  sourceRevision: string;
  image: string;
  createdAt: string;
}

export interface ArtifactFsProviderOptions {
  rootDirectory: string;
  image?: string;
  dockerCommand?: string;
  /** Packaging places the five runtime build resources in this directory. */
  runtimeDirectory?: string;
  /** Optional committed source checkout; uncommitted changes are never built. */
  sourceDirectory?: string;
  buildImage?: boolean;
  sessionName?: (record: WorkspaceRecord) => string;
  workspaceBranch?: (record: WorkspaceRecord) => string;
}

/**
 * Mounts real ArtifactFS in the Linux Docker host, including a Mac's Docker VM.
 * Only the trusted service owns Docker and mount namespace capabilities.
 * Consumers bind bindSource with rslave and stateVolume at stateTarget. They
 * receive no Docker socket, /dev/fuse or mount capability from this provider.
 */
export class ArtifactFsWorkspaceProvider implements ManagedWorkspaceProvider {
  private readonly root: string;
  private readonly image: string;
  private readonly docker: string;
  private imageBuild?: Promise<void>;

  constructor(private readonly options: ArtifactFsProviderOptions) {
    this.root = resolve(options.rootDirectory);
    this.image = options.image ?? ARTIFACTFS_IMAGE;
    this.docker = options.dockerCommand ?? "docker";
  }

  async available(): Promise<{ available: boolean; reason?: string }> {
    try {
      const result = await run(this.docker, ["info", "--format", "{{.OSType}}"], { timeoutMs: 10_000 });
      if (result.exitCode !== 0 || result.stdout.trim() !== "linux") return { available: false, reason: "ArtifactFS requires a running Linux Docker engine." };
      const image = await run(this.docker, ["image", "inspect", this.image], { timeoutMs: 10_000 });
      if (image.exitCode !== 0 && this.options.buildImage === false) return { available: false, reason: `ArtifactFS runtime image ${this.image} is not installed.` };
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async prepare(record: WorkspaceRecord): Promise<Record<string, unknown>> {
    const attempt = attemptId(record.attemptId);
    const baseCommit = await git(record.path, "rev-parse", "--verify", "--end-of-options", `${record.baseCommit}^{commit}`);
    if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("Invalid ArtifactFS source commit");
    const session = this.options.sessionName?.(record) ??
      (typeof record.providerState?.sessionName === "string" ? record.providerState.sessionName :
        record.branch.startsWith("envmux/") ? record.branch.slice(7) : `factory-${attempt}`);
    const branch = this.options.workspaceBranch?.(record) ??
      (typeof record.providerState?.workspaceBranch === "string" ? record.providerState.workspaceBranch : `envmux/${session}`);
    await git(record.path, "check-ref-format", `refs/heads/${branch}`);
    await this.ensureImage();
    const directory = this.directory(attempt);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const previous = await this.readMountRecord(attempt);
    if (previous) {
      if (previous.baseCommit !== baseCommit || previous.branch !== branch) throw new Error("ArtifactFS attempt already belongs to a different source or session");
      await this.recover(previous);
      return this.providerState(previous);
    }
    const bundle = join(directory, "source.bundle");
    const sourceRef = `refs/enoughfactory/source/${attempt}`;
    await git(record.path, "update-ref", sourceRef, baseCommit);
    try { await git(record.path, "bundle", "create", bundle, sourceRef); }
    finally { await git(record.path, "update-ref", "-d", sourceRef, baseCommit); }
    const stateVolume = `enoughfactory-afs-${attempt}`;
    const containerName = `enoughfactory-afs-${attempt}`;
    await this.command(["volume", "create", "--label", "enoughfactory.workspace=artifactfs", "--label", `enoughfactory.attempt=${attempt}`, stateVolume]);
    await this.prepareSharedMount(attempt);
    // A failed create is retained for diagnosis and recovery, not hidden behind
    // a destructive retry which could discard a previous writable overlay.
    const result = await this.command(["run", "--detach", "--name", containerName,
      "--label", "enoughfactory.workspace=artifactfs", "--label", `enoughfactory.attempt=${attempt}`,
      "--cap-add", "SYS_ADMIN", "--device", "/dev/fuse", "--security-opt", "apparmor=unconfined",
      "--mount", `type=volume,src=${stateVolume},dst=/var/lib/artifact-fs`,
      "--mount", `type=bind,src=/var/lib/enoughfactory/workspaces/${attempt},dst=/mount,bind-propagation=rshared`,
      "--mount", `type=bind,src=${directory},dst=/input,readonly`,
      "--env", `ENOUGHFACTORY_BASE_COMMIT=${baseCommit}`, "--env", `ENOUGHFACTORY_WORKSPACE_BRANCH=${branch}`,
      this.image]);
    const mount: ArtifactFsMountRecord = {
      version: 1, provider: "artifactfs", attemptId: attempt, baseCommit, branch, containerName,
      containerId: result.stdout.trim(), stateVolume,
      bindSource: `/var/lib/enoughfactory/workspaces/${attempt}/repo`, managerMountPath: "/mount/repo",
      stateTarget: "/var/lib/artifact-fs", sourceRevision: ARTIFACTFS_REVISION, image: this.image,
      createdAt: new Date().toISOString(),
    };
    await this.writeMountRecord(mount);
    await this.waitReady(mount);
    return this.providerState(mount);
  }

  async readMountRecord(id: string): Promise<ArtifactFsMountRecord | undefined> {
    try {
      const record = JSON.parse(await readFile(join(this.directory(attemptId(id)), "mount.json"), "utf8")) as ArtifactFsMountRecord;
      if (record.version !== 1 || record.provider !== "artifactfs" || record.attemptId !== id ||
        record.containerName !== `enoughfactory-afs-${id}` || record.stateVolume !== `enoughfactory-afs-${id}` ||
        record.bindSource !== `/var/lib/enoughfactory/workspaces/${id}/repo` || !/^[a-f0-9]{40,64}$/.test(record.baseCommit)) {
        throw new Error("Invalid ArtifactFS mount record");
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async recover(mount: ArtifactFsMountRecord): Promise<void> {
    await this.prepareSharedMount(attemptId(mount.attemptId));
    const state = await this.command(["inspect", "--format", "{{.State.Running}}", mount.containerName]);
    if (state.stdout.trim() !== "true") await this.command(["start", mount.containerName]);
    await this.waitReady(mount);
  }

  /** Call after the writer stopped; exports an exact immutable Git candidate. */
  async capture(record: WorkspaceRecord): Promise<{ bundlePath: string; commit: string; reference: string }> {
    const mount = await this.requiredMount(record.attemptId);
    await this.waitReady(mount);
    const exec = async (...args: string[]) => this.workspaceGit(mount, args);
    await exec("add", "--all");
    const diff = await this.workspaceCommand(mount, ["diff", "--cached", "--quiet"], 30_000);
    if (diff.exitCode === 1) await exec("-c", "user.name=EnoughFactory", "-c", "user.email=factory@enoughtools.com", "commit", "-m", "Preserve EnoughFactory attempt changes");
    else if (diff.exitCode !== 0) throw new Error(`Cannot inspect ArtifactFS candidate: ${diff.stderr.trim()}`);
    const commit = (await exec("rev-parse", "--verify", "HEAD^{commit}")).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid ArtifactFS candidate commit");
    await exec("merge-base", "--is-ancestor", mount.baseCommit, commit);
    const reference = `refs/enoughfactory/candidate/${attemptId(record.attemptId)}`;
    await exec("update-ref", reference, commit);
    await exec("bundle", "create", "/var/lib/artifact-fs/candidate.bundle", reference);
    const bundlePath = join(this.directory(record.attemptId), "candidate.bundle");
    await this.command(["cp", `${mount.containerName}:/var/lib/artifact-fs/candidate.bundle`, bundlePath]);
    await git(record.path, "bundle", "verify", bundlePath);
    return { bundlePath, commit, reference };
  }

  /** Materializes retained candidate work in a fresh repair attempt's mount. */
  async promotePreviousCandidate(record: WorkspaceRecord, candidate: Pick<Candidate, "commit">, bundlePath: string): Promise<{ commit: string; conflicts: string[]; message?: string }> {
    const mount = await this.requiredMount(record.attemptId);
    await this.waitReady(mount);
    if (!/^[a-f0-9]{40,64}$/.test(candidate.commit)) throw new Error("Invalid repair candidate commit");
    const exec = async (...args: string[]) => this.workspaceGit(mount, args);
    const status = await exec("status", "--porcelain");
    if (status.stdout.trim()) throw new Error("Repair workspace already contains changes; refusing to replace them");
    await this.command(["cp", bundlePath, `${mount.containerName}:/var/lib/artifact-fs/repair-input.bundle`]);
    await exec("bundle", "verify", "/var/lib/artifact-fs/repair-input.bundle");
    const heads = await exec("bundle", "list-heads", "/var/lib/artifact-fs/repair-input.bundle");
    const line = heads.stdout.split("\n").find((entry) => entry.startsWith(`${candidate.commit} `));
    if (!line) throw new Error("Repair bundle does not contain the exact candidate commit");
    const sourceRef = line.slice(candidate.commit.length + 1).trim();
    await exec("check-ref-format", sourceRef);
    const reference = `refs/enoughfactory/repair-input/${attemptId(record.attemptId)}`;
    await exec("fetch", "/var/lib/artifact-fs/repair-input.bundle", `${sourceRef}:${reference}`);
    const merge = await this.workspaceCommand(mount, ["-c", "user.name=EnoughFactory", "-c", "user.email=factory@enoughtools.com",
      "merge", "--no-edit", "--no-ff", "-m", "Retain previous EnoughFactory candidate for repair", candidate.commit]);
    if (merge.exitCode !== 0) {
      const unresolved = await exec("diff", "--name-only", "--diff-filter=U", "-z");
      const conflicts = unresolved.stdout.split("\0").filter(Boolean);
      if (!conflicts.length) throw new Error(`Cannot retain repair input: ${merge.stderr.trim() || merge.stdout.trim()}`);
      // These markers are explicit repair inputs, never accepted verification
      // results. Commit them so restart and the ordinary engine retain them.
      await exec("add", "--all");
      await exec("-c", "user.name=EnoughFactory", "-c", "user.email=factory@enoughtools.com", "commit", "-m", "Preserve merge conflicts as EnoughFactory repair input");
      const commit = (await exec("rev-parse", "HEAD")).stdout.trim();
      return { commit, conflicts, message: "Previous candidate conflicts are retained for the repair agent." };
    }
    return { commit: (await exec("rev-parse", "HEAD")).stdout.trim(), conflicts: [] };
  }

  /** Retains the state volume and source bundle so stopping never deletes work. */
  async dispose(record: WorkspaceRecord): Promise<void> {
    const mount = await this.readMountRecord(record.attemptId);
    if (mount) await this.command(["stop", "--time", "30", mount.containerName], 45_000);
  }

  /** Explicit storage removal, only after the engine released its bind mount. */
  async remove(id: string): Promise<void> {
    const mount = await this.requiredMount(id);
    const state = await run(this.docker, ["inspect", "--format", "{{.State.Running}}", mount.containerName]);
    if (state.exitCode === 0) {
      if (state.stdout.trim() === "true") await this.command(["stop", "--time", "30", mount.containerName], 45_000);
      await this.command(["rm", mount.containerName]);
    }
    const volume = await run(this.docker, ["volume", "inspect", mount.stateVolume]);
    if (volume.exitCode === 0) await this.command(["volume", "rm", mount.stateVolume]);
    else if (!/no such volume/i.test(volume.stderr)) throw new Error(`Cannot inspect ArtifactFS state: ${volume.stderr.trim()}`);
    await this.prepareSharedMount(id, "remove");
    await rm(this.directory(id), { recursive: true, force: true });
  }

  private directory(id: string): string { return join(this.root, "artifactfs", attemptId(id)); }
  private providerState(mount: ArtifactFsMountRecord): Record<string, unknown> {
    return { ...mount, mountRecordPath: join(this.directory(mount.attemptId), "mount.json"),
      envmuxEnvironment: { ENVMUX_WORKSPACE_BIND: mount.bindSource, ENVMUX_ARTIFACT_STATE_VOLUME: mount.stateVolume } };
  }
  private async requiredMount(id: string): Promise<ArtifactFsMountRecord> {
    const mount = await this.readMountRecord(id);
    if (!mount) throw new Error("ArtifactFS mount record is missing");
    return mount;
  }
  private async writeMountRecord(record: ArtifactFsMountRecord): Promise<void> {
    const path = join(this.directory(record.attemptId), "mount.json");
    await writeFile(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  private async prepareSharedMount(id: string, action: "prepare" | "remove" = "prepare"): Promise<void> {
    // The helper runs generated, path-bounded code. Its host PID namespace and
    // mount capabilities are never passed to an agent container.
    await this.command(["run", "--rm", "--pid", "host", "--cap-add", "SYS_ADMIN", "--cap-add", "SYS_PTRACE",
      "--security-opt", "apparmor=unconfined", "--entrypoint", "/usr/local/bin/enoughfactory-shared-mount", this.image,
      attemptId(id), action]);
  }
  private async waitReady(mount: ArtifactFsMountRecord): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 200_000) {
      const status = await this.command(["inspect", "--format", "{{.State.Running}}", mount.containerName]);
      if (status.stdout.trim() !== "true") {
        const logs = await run(this.docker, ["logs", "--tail", "30", mount.containerName]);
        throw new Error(`ArtifactFS manager exited before readiness: ${logs.stderr.trim() || logs.stdout.trim()}`);
      }
      const ready = await run(this.docker, ["exec", mount.containerName, "sh", "-c", "test -f /var/lib/artifact-fs/ready && mountpoint -q /mount/repo && git -c safe.directory='*' -C /mount/repo rev-parse HEAD"], { timeoutMs: 10_000 });
      if (ready.exitCode === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error("ArtifactFS manager readiness timed out; its state is retained for recovery");
  }
  private async ensureImage(): Promise<void> {
    const inspect = await run(this.docker, ["image", "inspect", this.image], { timeoutMs: 10_000 });
    if (inspect.exitCode === 0) return;
    if (this.options.buildImage === false) throw new Error(`ArtifactFS runtime image ${this.image} is not installed`);
    if (!this.imageBuild) this.imageBuild = (async () => {
      const runtime = this.options.runtimeDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../runtime/workspaces");
      await stat(join(runtime, "build.sh"));
      const result = await run("bash", [join(runtime, "build.sh")], {
        timeoutMs: 20 * 60_000,
        env: { ENOUGHFACTORY_ARTIFACTFS_IMAGE: this.image,
          ...(this.options.sourceDirectory ? { ENOUGHFACTORY_ARTIFACTFS_SOURCE: this.options.sourceDirectory } : {}) },
      });
      if (result.exitCode !== 0) throw new Error(`ArtifactFS runtime build failed: ${result.stderr.trim()}`);
    })().catch((error) => { this.imageBuild = undefined; throw error; });
    await this.imageBuild;
  }
  private async workspaceCommand(mount: ArtifactFsMountRecord, args: string[], timeoutMs = 60_000) {
    // Author-controlled Git configuration and filters must never execute with
    // the FUSE manager's mount capabilities. Use a separate ordinary container.
    return run(this.docker, ["run", "--rm", "--mount", `type=bind,src=${mount.bindSource},dst=/mount/repo,bind-propagation=rslave`,
      "--mount", `type=volume,src=${mount.stateVolume},dst=/var/lib/artifact-fs`, "--entrypoint", "git", mount.image,
      "-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", "/mount/repo", ...args], { timeoutMs });
  }
  private async workspaceGit(mount: ArtifactFsMountRecord, args: string[]) {
    const result = await this.workspaceCommand(mount, args);
    if (result.exitCode !== 0) throw new Error(`ArtifactFS Git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
  private async command(args: string[], timeoutMs = 60_000) {
    const result = await run(this.docker, args, { timeoutMs });
    if (result.exitCode !== 0) throw new Error(`ArtifactFS ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result;
  }
}

function attemptId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) throw new Error("ArtifactFS attempt ID must contain at most 80 letters, digits, underscores or hyphens");
  return value;
}
