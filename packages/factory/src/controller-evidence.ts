import { createHash } from "node:crypto";
import type { Attempt, FactoryTask } from "@enoughfactory/contracts";
import { FactoryControllerError } from "./errors.js";
import type { AttemptDetail, CandidateRef, CheckResult, GoalCheckRecord, RepositoryEvidence, TaskDetail } from "./types.js";

// Leave room for the runtime's project rules and source-context manifest below its 1 MiB input limit.
export const CONTROLLER_PROMPT_LIMIT = 768 * 1024;
const DIAGNOSTIC_CHARACTERS = 64 * 1024;
export const CONTROLLER_EVIDENCE_NOTICE = "Evidence below is a bounded projection, not a replacement for retained records or proof of completion. Contract text and check outcome fields are separate from diagnostic excerpts. Excerpts retain the beginning and end; SHA-256 and character counts identify the full retained text. Record references identify coordinator records, not container paths. When runtime instructions supply a controller-context manifest, inspect its records entries for matching record IDs, actual JSON evidence paths, SHA-256 and size; only listed available files are promised. Inspect the actual source and verified evidence; if omitted evidence is needed but unavailable, report that concrete evidence gap rather than infer success.";

/** One shared diagnostic budget per controller turn; contracts and identities are never clipped. */
export class ControllerEvidence {
  constructor(private remaining = DIAGNOSTIC_CHARACTERS) {}

  text(value: string | undefined, record: string, maximum = 2048) {
    if (value === undefined) return undefined;
    const count = Math.min(value.length, maximum, this.remaining);
    this.remaining -= count;
    const omitted = value.length - count;
    const beginning = Math.ceil(count / 2);
    return { record, characters: value.length, sha256: createHash("sha256").update(value).digest("hex"),
      excerpt: omitted ? `${value.slice(0, beginning)}\n[${omitted} characters omitted]\n${count > beginning ? value.slice(-(count - beginning)) : ""}` : value,
      ...(omitted ? { omittedCharacters: omitted } : {}) };
  }

  candidate(value: CandidateRef | undefined) {
    if (!value) return undefined;
    return { id: value.id, commit: value.commit, baseCommit: value.baseCommit, branch: value.branch,
      tree: value.tree, deviceId: value.deviceId, bundle: value.bundle, manifest: value.manifest,
      bundleArtifact: this.artifact(value.bundleArtifact), diffArtifact: this.artifact(value.diffArtifact),
      developmentToolchain: this.toolchain(value.developmentToolchain),
      workingDirectories: Array.isArray(value.workingDirectories) ? value.workingDirectories.map((root: Record<string, unknown>) => ({
        id: root.id, name: root.name, kind: root.kind, containerPath: root.containerPath, baseCommit: root.baseCommit, commit: root.commit,
        bundleArtifact: this.artifact(root.bundleArtifact), diffArtifact: this.artifact(root.diffArtifact),
      })) : undefined };
  }

  private artifact(value: unknown) {
    if (!value || typeof value !== "object") return undefined;
    const artifact = value as Record<string, unknown>;
    return { id: artifact.id, name: artifact.name, sha256: artifact.sha256, size: artifact.size, deviceId: artifact.deviceId };
  }

  private toolchain(value: unknown) {
    if (!value || typeof value !== "object") return undefined;
    const toolchain = value as Record<string, unknown>;
    return { id: toolchain.id, recipeSha256: toolchain.recipeSha256, image: toolchain.image, baseImage: toolchain.baseImage,
      platform: toolchain.platform, swiftVersion: toolchain.swiftVersion, nodeVersion: toolchain.nodeVersion };
  }

  task(task: FactoryTask, detail: TaskDetail) {
    return { id: task.id, key: detail.key, goalId: task.goalId, title: task.title, description: task.description,
      kind: task.kind, acceptanceCriteria: task.acceptanceCriteria, expectedOutputs: task.expectedOutputs,
      dependsOn: task.dependsOn, checks: detail.checks, planChecks: detail.planChecks, planRevision: detail.planRevision,
      writePaths: task.writePaths, resources: task.resources, estimatedMinutes: task.estimatedMinutes,
      status: task.status, deviceId: task.deviceId, currentAttemptId: task.currentAttemptId };
  }

  checks(checks: CheckResult[] | undefined, record: string) {
    if (!checks) return undefined;
    // Allocate excerpts to failures first without changing check order or retained record indexes.
    const outputs = new Map(checks.map((check, index) => ({ check, index })).sort((a, b) => Number(a.check.passed) - Number(b.check.passed))
      .map(({ check, index }) => [index, this.text(check.output, `${record}[${index}].output`, check.passed ? 1024 : 8192)]));
    return checks.map((check, index) => ({ command: check.command, passed: check.passed, exitCode: check.exitCode,
      candidateCommit: check.candidateCommit, checkedCommit: check.checkedCommit, developmentToolchain: this.toolchain(check.developmentToolchain),
      output: outputs.get(index) }));
  }

  attempt(attempt: Attempt | undefined, detail: AttemptDetail | undefined) {
    if (!detail) return undefined;
    const record = `factory-attempt-details/${detail.id}`;
    return { record, id: detail.id, taskId: attempt?.taskId, generation: attempt?.generation, status: attempt?.status,
      deviceId: attempt?.deviceId, goalId: detail.goalId, goalRevision: detail.goalRevision, assignmentGoalRevision: detail.assignmentGoalRevision,
      phase: detail.phase, cancellation: detail.cancellation, contract: detail.contract,
      candidate: this.candidate(detail.candidate),
      checks: this.checks(detail.checks, `${record}.checks`),
      integration: detail.integration ? { commit: detail.integration.commit, previousHead: detail.integration.previousHead,
        candidateCommit: detail.integration.candidateCommit, checks: this.checks(detail.integration.checks, `${record}.integration.checks`) } : undefined,
      result: detail.result ? { status: detail.result.status, chatId: detail.result.chatId, sessionId: detail.result.sessionId,
        text: this.text(detail.result.text, `${record}.result.text`), error: this.text(detail.result.error, `${record}.result.error`, 8192),
        waitReason: this.text(detail.result.waitReason, `${record}.result.waitReason`), wakeCondition: detail.result.wakeCondition } : undefined,
      error: this.text(attempt?.error, `attempts/${detail.id}.error`, 8192),
      workspace: detail.workspace ? { id: detail.workspace.id, baseCommit: detail.workspace.baseCommit, provider: detail.workspace.provider,
        sessionId: detail.workspace.sessionId, deviceId: detail.workspace.deviceId, developmentToolchain: this.toolchain(detail.workspace.developmentToolchain) } : undefined };
  }

  repository(value: RepositoryEvidence, record: string) {
    return { head: value.head, branch: value.branch, fingerprint: value.fingerprint, developmentToolchain: this.toolchain(value.developmentToolchain),
      status: this.text(value.status, `${record}.status`), summary: this.text(value.summary, `${record}.summary`),
      diff: this.text(value.diff, `${record}.diff`, 8192), artifacts: value.artifacts?.map(value => ({ name: value.name, sha256: value.sha256, path: value.path })) };
  }

  goalChecks(value: GoalCheckRecord | undefined) {
    if (!value) return { commands: [], checks: [] };
    const record = `factory-goal-checks/${value.id}`;
    return { record, id: value.id, goalId: value.goalId, revision: value.revision, at: value.at, commands: value.commands,
      checks: this.checks(value.checks, `${record}.checks`), repository: this.repository(value.repository, `${record}.repository`) };
  }
}

export function controllerPrompt(build: (evidence: ControllerEvidence) => string[]): string {
  for (const budget of [DIAGNOSTIC_CHARACTERS, 0]) {
    const prompt = [...build(new ControllerEvidence(budget)), CONTROLLER_EVIDENCE_NOTICE].join("\n\n");
    // Measure serialized text, including JSON escaping, rather than assuming one log character costs one input character.
    if (prompt.length <= CONTROLLER_PROMPT_LIMIT) return prompt;
  }
  throw new FactoryControllerError("The goal and task contracts exceed the controller input budget even with diagnostic excerpts removed. Preserve the recorded requirements and split the planning context before retrying.", "controller-retry-required");
}
