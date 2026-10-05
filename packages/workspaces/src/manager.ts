import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, rm, access, readdir } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { ArtifactStore, writeAtomic } from "./artifacts.ts";
import { dockerCheckExecutor } from "./checks.ts";
import { git, run, safeId } from "./process.ts";
import type { ArtifactManifest, Candidate, CheckExecutor, CheckReport, IntegrationResult, ManagedWorkspaceProvider, WorkspaceProvider, WorkspaceRecord } from "./types.ts";

export interface WorkspaceManagerOptions {
  dataDir: string;
  deviceId: string;
  checkExecutor?: CheckExecutor;
  artifactFs?: ManagedWorkspaceProvider;
  checkTimeoutMs?: number;
}

export class WorkspaceManager {
  readonly artifacts: ArtifactStore;
  private readonly root: string;
  private readonly executor: CheckExecutor;
  private readonly integrations = new Map<string, Promise<unknown>>();

  constructor(private readonly options: WorkspaceManagerOptions) {
    this.root = resolve(options.dataDir);
    this.artifacts = new ArtifactStore(join(this.root, "artifacts"), options.deviceId);
    this.executor = options.checkExecutor ?? dockerCheckExecutor();
  }

  async create(input: { projectPath: string; goalId: string; taskId: string; attemptId: string; baseCommit?: string; provider?: WorkspaceProvider; fallbackToGit?: boolean; sessionName?: string; workspaceBranch?: string }): Promise<WorkspaceRecord> {
    for (const id of [input.goalId, input.taskId, input.attemptId]) safeId(id);
    const projectPath = await git(resolve(input.projectPath), "rev-parse", "--show-toplevel");
    const baseCommit = await git(projectPath, "rev-parse", "--verify", `${input.baseCommit ?? "HEAD"}^{commit}`);
    const workspaceId = input.attemptId;
    const directory = join(this.root, "workspaces", workspaceId);
    await mkdir(dirname(directory), { recursive: true });
    try {
      const existing = await this.workspace(workspaceId);
      if (existing.goalId !== input.goalId || existing.taskId !== input.taskId || existing.baseCommit !== baseCommit) throw new Error("Attempt identity already belongs to a different workspace");
      return existing;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

    // This clone is a handoff repository for envmux; envmux still seeds and harvests its own guest.
    const source = await this.exportSource({ projectPath, reference: baseCommit });
    const path = join(directory, "repository");
    await mkdir(directory, { recursive: false });
    const branch = `enoughfactory/attempt/${safeId(input.attemptId)}`;
    try {
      await this.importSource({ artifact: source, targetPath: path, branch });
      await git(path, "config", "core.hooksPath", "/dev/null");
      await copyIdentity(projectPath, path);
      await git(path, "remote", "add", "project", projectPath);
      // Configuration can be local/untracked; the new repository gets only this explicit runtime config.
      const config = join(projectPath, ".envmux.json");
      if (await exists(config)) await copyFile(config, join(path, ".envmux.json"));
      const record: WorkspaceRecord = { id: workspaceId, goalId: input.goalId, taskId: input.taskId, attemptId: input.attemptId, deviceId: this.options.deviceId, projectPath, path, provider: "git", baseCommit, branch, createdAt: new Date().toISOString() };
      if (input.provider === "artifactfs") {
        try {
          if (!this.options.artifactFs) throw new Error("ArtifactFS manager is not installed on this device");
          record.providerState = { ...(input.sessionName ? { sessionName: input.sessionName } : {}), ...(input.workspaceBranch ? { workspaceBranch: input.workspaceBranch } : {}) };
          record.providerState = await this.options.artifactFs.prepare(record);
          record.provider = "artifactfs";
        } catch (error) {
          if (input.fallbackToGit === false) throw error;
          record.fallbackReason = error instanceof Error ? error.message : String(error);
        }
      }
      await writeAtomic(join(directory, "workspace.json"), record);
      return record;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  async workspace(id: string): Promise<WorkspaceRecord> {
    return JSON.parse(await readFile(join(this.root, "workspaces", safeId(id), "workspace.json"), "utf8")) as WorkspaceRecord;
  }

  async candidate(id: string): Promise<Candidate> {
    const candidate = JSON.parse(await readFile(join(this.root, "candidates", `${safeId(id)}.json`), "utf8")) as Candidate;
    validateCandidate(candidate);
    return candidate;
  }

  /** Call after writers stop and envmux harvests. Providers may create an explicit preservation commit in their private attempt. */
  async capture(input: { workspaceId: string; repositoryPath?: string; reference?: string }): Promise<Candidate> {
    const workspace = await this.workspace(input.workspaceId);
    const provided = workspace.provider === "artifactfs" ? await this.options.artifactFs?.capture?.(workspace) : undefined;
    const path = input.repositoryPath ?? provided?.repositoryPath ?? workspace.path;
    let reference = input.reference ?? provided?.reference ?? workspace.branch;
    if (!input.reference && !provided?.reference) {
      // Envmux can harvest onto envmux/<session>; select it explicitly at the adapter instead of guessing a branch.
      reference = workspace.branch;
    }
    if (provided?.bundlePath) {
      if (!provided.commit) throw new Error("ArtifactFS candidate export omitted its commit");
      if (!provided.reference || !provided.reference.startsWith("refs/")) throw new Error("ArtifactFS candidate export omitted its advertised ref");
      const ref = `refs/enoughfactory/import/${randomUUID()}`;
      await git(path, "fetch", provided.bundlePath, `${provided.reference}:${ref}`);
      if (await git(path, "rev-parse", ref) !== provided.commit) throw new Error("ArtifactFS exported ref does not match its exact candidate commit");
      reference = ref;
    }
    const commit = await git(path, "rev-parse", "--verify", `${reference}^{commit}`);
    await git(path, "merge-base", "--is-ancestor", workspace.baseCommit, commit);
    const id = randomUUID();
    const ref = `refs/enoughfactory/candidates/${id}`;
    await git(path, "update-ref", ref, commit);
    const bundlePath = join(this.root, "workspaces", workspace.id, `${id}.bundle`);
    try {
      await git(path, "bundle", "create", bundlePath, ref);
      const metadata = { goalId: workspace.goalId, taskId: workspace.taskId, attemptId: workspace.attemptId };
      const bundleArtifact = await this.artifacts.putFile(bundlePath, { ...metadata, name: `candidate-${id}.bundle`, mime: "application/x-git-bundle", metadata: { commit, ref, baseCommit: workspace.baseCommit } });
      const diff = await git(path, "diff", "--binary", workspace.baseCommit, commit);
      const diffArtifact = await this.artifacts.put(diff, { ...metadata, name: `candidate-${id}.patch`, mime: "text/x-diff", metadata: { commit, baseCommit: workspace.baseCommit } });
      const candidate: Candidate = { id, workspaceId: workspace.id, ...metadata, deviceId: this.options.deviceId, baseCommit: workspace.baseCommit, commit, branch: reference, bundleArtifact, diffArtifact, repairConflicts: workspace.repairConflicts, createdAt: new Date().toISOString() };
      await mkdir(join(this.root, "candidates"), { recursive: true });
      await writeFile(join(this.root, "candidates", `${id}.json`), JSON.stringify(candidate), { flag: "wx", mode: 0o600 });
      return candidate;
    } finally { await rm(bundlePath, { force: true }); }
  }

  /** Coordinator accepts a candidate only after the received bundle's full hash and advertised commit verify. */
  async acceptCandidate(candidate: Candidate, bundlePath: string, diffPath?: string): Promise<void> {
    validateCandidate(candidate);
    await this.artifacts.importFile(bundlePath, candidate.bundleArtifact);
    if (diffPath) await this.artifacts.importFile(diffPath, candidate.diffArtifact);
    const temporary = join(this.root, "accept", randomUUID());
    try {
      await this.cloneCandidate(candidate, temporary);
      await git(temporary, "merge-base", "--is-ancestor", candidate.baseCommit, candidate.commit);
      await mkdir(join(this.root, "candidates"), { recursive: true });
      const candidatePath = join(this.root, "candidates", `${candidate.id}.json`);
      try { await writeFile(candidatePath, JSON.stringify(candidate), { flag: "wx", mode: 0o600 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (JSON.stringify(await this.candidate(candidate.id)) !== JSON.stringify(candidate)) throw new Error("Candidate identifier already belongs to different immutable evidence");
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async exportSource(input: { projectPath: string; reference?: string }): Promise<ArtifactManifest> {
    const commit = await git(input.projectPath, "rev-parse", "--verify", `${input.reference ?? "HEAD"}^{commit}`);
    const id = randomUUID();
    const ref = `refs/enoughfactory/source/${id}`;
    const directory = join(this.root, "source");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${id}.bundle`);
    try {
      await git(input.projectPath, "update-ref", ref, commit);
      await git(input.projectPath, "bundle", "create", path, ref);
      return await this.artifacts.putFile(path, { name: `source-${commit}.bundle`, mime: "application/x-git-bundle", metadata: { commit, ref } });
    } finally { await git(input.projectPath, "update-ref", "-d", ref).catch(() => undefined); await rm(path, { force: true }); }
  }

  async importSource(input: { artifact: ArtifactManifest; targetPath: string; branch?: string }): Promise<string> {
    const commit = String(input.artifact.metadata?.commit ?? "");
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Source bundle manifest has no exact commit");
    const bundlePath = await this.artifacts.path(input.artifact);
    await mkdir(dirname(input.targetPath), { recursive: true });
    if (await exists(input.targetPath)) throw new Error("Source transfer target already exists");
    const initialized = await run("git", ["init", "--quiet", input.targetPath]);
    if (initialized.exitCode !== 0) throw new Error(`Could not create workspace: ${initialized.stderr}`);
    try {
      const ref = String(input.artifact.metadata?.ref ?? "");
      if (!ref.startsWith("refs/")) throw new Error("Source bundle manifest has no advertised ref");
      await git(input.targetPath, "fetch", bundlePath, `${ref}:refs/enoughfactory/seed`);
      await git(input.targetPath, "checkout", "-b", input.branch ?? "enoughfactory/source", commit);
      return commit;
    } catch (error) {
      // This method required a nonexistent target and has not handed it to an author yet.
      await rm(input.targetPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async cloneCandidate(candidate: Candidate, path: string): Promise<void> {
    await this.importSource({ artifact: { ...candidate.bundleArtifact, metadata: { ...candidate.bundleArtifact.metadata, commit: candidate.commit } }, targetPath: path });
    await git(path, "config", "core.hooksPath", "/dev/null");
    await git(path, "config", "user.name", "EnoughFactory");
    await git(path, "config", "user.email", "factory@enoughtools.com");
    const actual = await git(path, "rev-parse", "HEAD");
    if (actual !== candidate.commit) throw new Error("Candidate bundle does not resolve to its claimed exact commit");
  }

  async verify(input: { candidateId: string; commands: string[]; baseCommit?: string; signal?: AbortSignal }): Promise<CheckReport> {
    const candidate = await this.candidate(input.candidateId);
    const path = join(this.root, "checks", randomUUID());
    try {
      await this.cloneCandidate(candidate, path);
      if (input.baseCommit && input.baseCommit !== candidate.baseCommit) {
        throw new Error("Combined checks require integrate() so the current target commit is imported and merged exactly");
      }
      return await this.checkAt(candidate, path, candidate.commit, input.commands, input.signal, input.baseCommit);
    } finally { await this.executor.release?.(path); await rm(path, { recursive: true, force: true }); }
  }

  private async checkAt(candidate: Candidate, path: string, commit: string, commands: string[], signal?: AbortSignal, baseCommit?: string): Promise<CheckReport> {
    const report: CheckReport = { id: randomUUID(), candidateId: candidate.id, commit, baseCommit, status: commands.length ? "passed" : "not-configured", commands: [], logArtifact: undefined as unknown as ArtifactManifest, createdAt: new Date().toISOString() };
    for (const command of commands) {
      if (signal?.aborted) { report.status = "canceled"; break; }
      let result;
      try { result = await this.executor({ path, commit, candidate, command, timeoutMs: this.options.checkTimeoutMs ?? 15 * 60 * 1000, signal }); }
      catch (error) { result = { command, exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error), startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }; }
      report.commands.push(result);
      if (result.exitCode !== 0 || result.timedOut) { report.status = signal?.aborted ? "canceled" : "failed"; break; }
    }
    // Checks that edit tracked files cannot attest the original candidate after those edits.
    const dirty = await git(path, "status", "--porcelain", "--untracked-files=no");
    const actualHead = await git(path, "rev-parse", "HEAD");
    const unresolved: string[] = [];
    for (const file of candidate.repairConflicts ?? []) {
      // Read the immutable Git object; a candidate symlink must never cause a host filesystem read.
      const blob = await run("git", ["-C", path, "show", `${commit}:${file}`]);
      const contents = blob.exitCode === 0 ? blob.stdout : "";
      if (/^<{7} /m.test(contents) && /^>{7} /m.test(contents)) unresolved.push(file);
    }
    if (dirty || actualHead !== commit || unresolved.length) report.status = "failed";
    report.logArtifact = await this.artifacts.put(JSON.stringify({ ...report, logArtifact: undefined, dirty, actualHead, unresolved }), { name: `checks-${report.id}.json`, mime: "application/json", goalId: candidate.goalId, taskId: candidate.taskId, attemptId: candidate.attemptId, metadata: { commit, candidateId: candidate.id } });
    await mkdir(join(this.root, "reports"), { recursive: true });
    await writeFile(join(this.root, "reports", `${report.id}.json`), JSON.stringify(report), { flag: "wx", mode: 0o600 });
    return report;
  }

  async integrate(input: { candidateId: string; projectPath: string; targetBranch?: string; commands: string[]; isCurrent: () => boolean | Promise<boolean>; signal?: AbortSignal }): Promise<IntegrationResult> {
    const projectPath = await git(resolve(input.projectPath), "rev-parse", "--show-toplevel");
    const prior = this.integrations.get(projectPath) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(() => this.integrateLocked({ ...input, projectPath }));
    this.integrations.set(projectPath, operation);
    try { return await operation; } finally { if (this.integrations.get(projectPath) === operation) this.integrations.delete(projectPath); }
  }

  private async integrateLocked(input: { candidateId: string; projectPath: string; targetBranch?: string; commands: string[]; isCurrent: () => boolean | Promise<boolean>; signal?: AbortSignal }): Promise<IntegrationResult> {
    const candidate = await this.candidate(input.candidateId);
    const targetBranch = input.targetBranch ?? await git(input.projectPath, "symbolic-ref", "--short", "HEAD");
    await git(input.projectPath, "check-ref-format", "--branch", targetBranch);
    const targetRef = `refs/heads/${targetBranch}`;
    const previousCommit = await git(input.projectPath, "rev-parse", `${targetRef}^{commit}`);
    const result: IntegrationResult = { status: "stale", candidateId: candidate.id, targetBranch, previousCommit };
    if (!await input.isCurrent() || input.signal?.aborted) return { ...result, message: "Attempt authority was retired before integration" };
    const currentBranch = await git(input.projectPath, "branch", "--show-current");
    if (currentBranch === targetBranch && await git(input.projectPath, "status", "--porcelain")) return { ...result, status: "target-dirty", message: "Integration target has local edits; all candidate work remains cached" };
    const path = join(this.root, "integration", randomUUID());
    const temporaryRef = `refs/enoughfactory/integration/${randomUUID()}`;
    try {
      await this.cloneCandidate(candidate, path);
      await git(path, "fetch", input.projectPath, `${targetRef}:refs/enoughfactory/target`);
      await git(path, "checkout", "--detach", previousCommit);
      const merged = await run("git", ["-C", path, "-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "--no-edit", candidate.commit]);
      if (merged.exitCode !== 0) {
        const conflicts = (await git(path, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
        return { ...result, status: "conflict", conflicts, message: merged.stderr.trim() || merged.stdout.trim() };
      }
      const commit = await git(path, "rev-parse", "HEAD");
      const report = await this.checkAt(candidate, path, commit, input.commands, input.signal, previousCommit);
      if (report.status === "failed" || report.status === "canceled") return { ...result, status: "checks-failed", commit, report };
      if (!await input.isCurrent() || input.signal?.aborted) return { ...result, report, message: "Attempt authority was retired while checking" };
      if (await git(input.projectPath, "rev-parse", targetRef) !== previousCommit) return { ...result, status: "target-moved", report, message: "Target moved while checks ran; recompute and check the combined result" };
      if (currentBranch === targetBranch && await git(input.projectPath, "status", "--porcelain")) return { ...result, status: "target-dirty", report, message: "Local edits appeared while checking; they were preserved" };
      // Cache merged objects before accepting the ref. The object import cannot update the user's branch.
      await git(input.projectPath, "fetch", path, `${commit}:${temporaryRef}`);
      const intentId = randomUUID();
      const intent = { ...result, status: "integrated" as const, commit, report, projectPath: input.projectPath, createdAt: new Date().toISOString() };
      await mkdir(join(this.root, "integration-intents"), { recursive: true });
      await writeFile(join(this.root, "integration-intents", `${intentId}.json`), JSON.stringify(intent), { flag: "wx", mode: 0o600 });
      if (!await input.isCurrent() || input.signal?.aborted) return { ...result, report, message: "Attempt authority was retired before accepting the commit" };
      if (await git(input.projectPath, "branch", "--show-current") !== currentBranch) return { ...result, status: "target-moved", report, message: "The selected checkout changed while checking; it was preserved" };
      const updated = await run("git", ["-C", input.projectPath, "update-ref", targetRef, commit, previousCommit]);
      if (updated.exitCode !== 0) return { ...result, status: "target-moved", report, message: updated.stderr.trim() };
      if (currentBranch === targetBranch) {
        if (await git(input.projectPath, "branch", "--show-current") !== targetBranch) {
          await run("git", ["-C", input.projectPath, "update-ref", targetRef, previousCommit, commit]);
          return { ...result, status: "target-moved", report, message: "The selected checkout changed during acceptance; its files were preserved" };
        }
        const checkout = await run("git", ["-C", input.projectPath, "read-tree", "-u", "-m", previousCommit, commit]);
        if (checkout.exitCode !== 0) {
          await run("git", ["-C", input.projectPath, "update-ref", targetRef, previousCommit, commit]);
          return { ...result, status: "target-dirty", report, message: "Checkout changed during acceptance; candidate preserved and ref acceptance rolled back" };
        }
      }
      const accepted: IntegrationResult = { ...result, status: "integrated", commit, report };
      await mkdir(join(this.root, "integrations"), { recursive: true });
      await writeFile(join(this.root, "integrations", `${intentId}.json`), JSON.stringify({ ...accepted, projectPath: input.projectPath, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      return accepted;
    } finally {
      await git(input.projectPath, "update-ref", "-d", temporaryRef).catch(() => undefined);
      await this.executor.release?.(path);
      await rm(path, { recursive: true, force: true });
    }
  }

  /** Reconcile the recorded acceptance, rather than replaying an unknown merge after a service interruption. */
  async reconcileIntegration(input: { candidateId: string; projectPath: string }): Promise<IntegrationResult | undefined> {
    const projectPath = await git(resolve(input.projectPath), "rev-parse", "--show-toplevel");
    const candidate = await this.candidate(input.candidateId);
    for (const directory of ["integrations", "integration-intents"]) {
      const files = await readdir(join(this.root, directory)).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const record = JSON.parse(await readFile(join(this.root, directory, file), "utf8")) as IntegrationResult & { projectPath: string };
        if (record.candidateId !== candidate.id || record.projectPath !== projectPath || !record.commit || record.report?.commit !== record.commit) continue;
        if (record.report.status !== "passed" && record.report.status !== "not-configured") continue;
        // Read and hash the check evidence before interpreting the acceptance journal.
        await this.artifacts.path(record.report.logArtifact);
        const targetRef = `refs/heads/${record.targetBranch}`;
        const accepted = await run("git", ["-C", projectPath, "merge-base", "--is-ancestor", record.commit, targetRef]);
        const includesCandidate = await run("git", ["-C", projectPath, "merge-base", "--is-ancestor", candidate.commit, record.commit]);
        if (accepted.exitCode !== 0 || includesCandidate.exitCode !== 0) continue;
        if (await git(projectPath, "branch", "--show-current") === record.targetBranch && await git(projectPath, "status", "--porcelain")) {
          // A crash can occur between ref acceptance and checkout. Only recover a wholly untouched prior tree.
          const workingClean = await run("git", ["-C", projectPath, "diff", "--quiet"]);
          const priorIndex = await run("git", ["-C", projectPath, "diff", "--cached", "--quiet", record.previousCommit]);
          const head = await git(projectPath, "rev-parse", targetRef);
          if (head === record.commit && workingClean.exitCode === 0 && priorIndex.exitCode === 0) {
            const checkout = await run("git", ["-C", projectPath, "read-tree", "-u", "-m", record.previousCommit, record.commit]);
            if (checkout.exitCode !== 0) return { ...record, status: "target-dirty", message: "Accepted commit survived; local edits prevented checkout recovery" };
          } else return { ...record, status: "target-dirty", message: "Accepted commit survived; local edits require reconciliation" };
        }
        return { ...record, status: "integrated" };
      }
    }
    return undefined;
  }

  /** A repair starts from both current source and retained failed work; conflicts remain explicit diagnosis inputs. */
  async promotePreviousCandidate(input: { candidateId: string; workspaceId: string }): Promise<{ commit?: string; conflicts: string[]; message?: string }> {
    const candidate = await this.candidate(input.candidateId);
    const workspace = await this.workspace(input.workspaceId);
    const ref = `refs/enoughfactory/repair/${candidate.id}`;
    const bundlePath = await this.artifacts.path(candidate.bundleArtifact);
    if (workspace.provider === "artifactfs") {
      if (!this.options.artifactFs?.promotePreviousCandidate) throw new Error("ArtifactFS provider cannot import repair work into its mounted workspace");
      const promoted = await this.options.artifactFs.promotePreviousCandidate(workspace, candidate, bundlePath);
      if (promoted.conflicts.length) { workspace.repairConflicts = promoted.conflicts; await writeAtomic(join(this.root, "workspaces", workspace.id, "workspace.json"), workspace); }
      return promoted;
    }
    const sourceRef = String(candidate.bundleArtifact.metadata?.ref ?? "");
    await git(workspace.path, "fetch", bundlePath, `${sourceRef}:${ref}`);
    const result = await run("git", ["-C", workspace.path, "-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "--no-edit", candidate.commit]);
    if (result.exitCode !== 0) {
      const conflicts = (await git(workspace.path, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
      if (!conflicts.length) return { conflicts, message: result.stderr.trim() || result.stdout.trim() };
      // Conflict material is an explicit, unchecked repair input. Commit it only on the isolated author branch
      // so envmux's bundle handoff includes the files; acceptance still requires a new candidate and checks.
      await git(workspace.path, "add", "--all");
      await git(workspace.path, "-c", "core.hooksPath=/dev/null", "commit", "-m", `Repair input for ${candidate.id}: resolve conflict markers`);
      workspace.repairConflicts = conflicts;
      await writeAtomic(join(this.root, "workspaces", workspace.id, "workspace.json"), workspace);
      return { commit: await git(workspace.path, "rev-parse", "HEAD"), conflicts, message: "Previous work retained as explicit conflict-marked repair input; these files must be resolved before acceptance" };
    }
    return { commit: await git(workspace.path, "rev-parse", "HEAD"), conflicts: [] };
  }

  async dispose(workspaceId: string): Promise<void> {
    const record = await this.workspace(workspaceId);
    if (record.provider === "artifactfs") await this.options.artifactFs?.dispose?.(record);
    // Retain source/candidate/artifact evidence. Explicit cleanup removes only the author workspace.
    await rm(join(this.root, "workspaces", safeId(workspaceId)), { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function validateCandidate(candidate: Candidate): void {
  for (const value of [candidate.id, candidate.workspaceId, candidate.goalId, candidate.taskId, candidate.attemptId]) safeId(value);
  for (const commit of [candidate.baseCommit, candidate.commit]) if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Candidate must identify exact Git commits");
  for (const path of candidate.repairConflicts ?? []) {
    if (isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).includes("..")) throw new Error("Invalid candidate conflict path");
  }
}
async function copyIdentity(source: string, target: string): Promise<void> {
  for (const [key, fallback] of [["user.name", "EnoughFactory"], ["user.email", "factory@enoughtools.com"]]) {
    const value = await run("git", ["-C", source, "config", "--get", key!]);
    await git(target, "config", key!, value.exitCode === 0 ? value.stdout.trim() : fallback!);
  }
}
