import type { ApprovalMode, AppleValidationMetadata, Attempt, AttemptInspection, AutonomyMode, Device, ExecutionTargetKind, FactoryTask, Goal, Project, RuntimeKind, TaskKind, TaskExecutionRequirements, TaskQualityRequirements, DevelopmentToolchain } from "@enoughfactory/contracts";

/** All writes inside a transaction must commit together, including decisions. */
export interface FactoryStore {
  list<T>(table: string): T[];
  get<T>(table: string, id: string): T | undefined;
  set<T extends { id: string }>(table: string, value: T): void;
  delete(table: string, id: string): void;
  transaction<T>(fn: () => T): T;
}

export interface WorkspaceRef {
  id: string; path: string; baseCommit: string; deviceId?: string;
  provider: "git" | "artifactfs"; sessionId?: string;
  [key: string]: unknown;
}
export interface CandidateRef {
  id: string; commit: string; baseCommit: string; branch?: string; bundle?: string;
  manifest?: string; tree?: string; deviceId?: string;
  [key: string]: unknown;
}
export interface CheckResult {
  command: string; passed: boolean; output: string; exitCode?: number;
  candidateCommit: string; checkedCommit?: string;
  developmentToolchain?: DevelopmentToolchain;
  appleValidation?: AppleValidationMetadata;
  executionTargetKind?: ExecutionTargetKind; hostPermissions?: "full-host";
  recovery?: { condition: "inspection-evidence" | "check-interrupted"; reason: string };
}
export interface RepositoryEvidence {
  head: string; branch: string; status: string; summary?: string; diff?: string;
  fingerprint?: string;
  developmentToolchain?: DevelopmentToolchain;
  artifacts?: Array<{ name: string; sha256: string; path?: string }>;
}
export interface IntegrationResult {
  commit: string; previousHead: string; candidateCommit: string; checks: CheckResult[];
}
export const UI_QUALITY_CHECK_COMMAND = "enoughfactory:ui-quality";
export interface FactoryVerificationContext {
  goal: Goal; task: FactoryTask; attempt: Attempt; quality?: TaskQualityRequirements;
}
export type ConfirmCheckRecoveryResult = { status: "settled"; automatic: boolean; evidenceIds: string[] } | { status: "unknown"; reason: string };
export interface RetainedVerificationRecovery {
  eligible: boolean; reason?: string; goalRevision: number; attemptId: string; candidateId: string; candidateCommit: string;
}
export interface FactoryWorkspacePort {
  /** The adapter checks configured UI evidence against both candidate and combined source. */
  qualityChecks?: true;
  prepare(input: { goal: Goal; task: FactoryTask; attempt: Attempt; project: Project; previousCandidate?: CandidateRef }): Promise<WorkspaceRef>;
  capture(workspace: WorkspaceRef, input: { goal: Goal; task: FactoryTask; attempt: Attempt }): Promise<CandidateRef>;
  check(project: Project, candidate: CandidateRef, commands: string[], verification?: FactoryVerificationContext): Promise<CheckResult[]>;
  /** Read-only owning proof of exact source and positively ended prior verification effects. */
  confirmCheckRecovery?(input: FactoryVerificationContext & { project: Project; candidate: CandidateRef; commands: string[]; previousChecks: CheckResult[] }): Promise<ConfirmCheckRecoveryResult>;
  /** Check an isolated exact final repository snapshot after task dependencies integrate. */
  checkGoal?(project: Project, commands: string[], goal: Goal): Promise<{ repository: RepositoryEvidence; checks: CheckResult[] }>;
  /** Recheck the combined result when HEAD changed. Fence immediately before writing. */
  integrate(project: Project, candidate: CandidateRef, input: { checks: string[]; isCurrent: () => boolean; verification?: FactoryVerificationContext }): Promise<IntegrationResult>;
  inspect(project: Project): Promise<RepositoryEvidence>;
  reconcileIntegration?(project: Project, candidate: CandidateRef): Promise<IntegrationResult | undefined>;
  release?(workspace: WorkspaceRef): Promise<void>;
}

export interface ExecutionResult {
  status: "succeeded" | "failed" | "waiting" | "unknown";
  text: string; chatId?: string; sessionId?: string;
  error?: string; waitReason?: string; wakeCondition?: string;
  /** Only an owning adapter may positively report that no provider execution began. */
  agentStarted?: false;
}
export interface FactoryRuntimePort {
  /** Promises immutable mounted JSON records, verified against complete() requirements. */
  controllerRecordReferences?: true;
  complete(input: { goal: Goal; role: "planner" | "evaluator" | "diagnosis"; prompt: string; project: Project; signal?: AbortSignal; recordRequirements?: ControllerRecordRequirement[] }): Promise<{ text: string; chatId?: string }>;
  execute(input: { goal: Goal; task: FactoryTask; attempt: Attempt; workspace: WorkspaceRef; prompt: string; project: Project; assignmentGoalRevision?: number }): Promise<ExecutionResult>;
  reconcile(attempt: Attempt): Promise<{ status: "prepared" | "running" | "succeeded" | "failed" | "unknown"; result?: ExecutionResult; workspace?: WorkspaceRef }>;
  /** Returns after the owner acknowledges cancellation; rejection leaves termination unknown. */
  cancel(attempt: Attempt): Promise<void>;
}

/** Digest of the canonical contract subobject, distinct from the enclosing record file digest. */
export interface ControllerRecordRequirement {
  record: string; field: ".contract"; sha256: string; size: number;
}

export interface PlannedTask {
  key: string; title: string; description: string; dependsOn: string[];
  checks: string[]; deviceId?: string;
  execution?: TaskExecutionRequirements;
  quality?: TaskQualityRequirements;
  /** Names of coordinator-configured verification inputs required before dispatch. */
  requiredCheckEnvironment?: string[];
  kind?: TaskKind; acceptanceCriteria?: string[]; expectedOutputs?: string[];
  estimatedMinutes?: number; writePaths?: string[]; resources?: { cpus?: number; memoryGiB?: number };
}
export interface PlanResponse {
  summary: string; criteria: string[]; tasks: PlannedTask[]; checks: string[];
}
export interface PlanRecord {
  id: string; goalId: string; revision: number; summary: string; checks: string[];
  /** Absent on old plans which attached project checks to every task attempt. */
  checkScope?: "goal";
  taskKeys: Record<string, string>; createdAt: string;
}
export interface TaskDetail {
  id: string; key: string; checks: string[]; planRevision: number;
  planChecks?: string[]; waitingFor?: string; waitReason?: string; waitSince?: string;
  lastError?: string; lastCandidate?: CandidateRef; repairInstructions?: string;
  /** A replacement plan archives prior retry guidance instead of treating it as current. */
  priorRepairInstructions?: Array<{ instructions: string; planRevision?: number; recordedAt?: string; retainedCandidateId?: string; retainedCandidateCommit?: string }>;
  /** Diagnosis guidance accepted with this replacement task's plan. */
  replanInstructions?: string;
  selected: boolean; failureSignatures: string[];
  /** Coordinator-authenticated verification inputs; applied only to new attempts. */
  checkInputs?: TaskCheckInputsConfiguration;
  requiredCheckEnvironment?: string[];
}
export interface FrozenTaskCheckInputs {
  configurationRevision: number; workingDirectoryIds: string[]; environment: Record<string, string>;
}
export interface TaskCheckInputsConfiguration extends FrozenTaskCheckInputs {
  goalRevision: number; configuredAgainstAttemptId: string | null; configuredAt: string; configuredByDeviceId: string;
}
export interface AttemptDetail {
  id: string; goalId: string; goalRevision: number; workspace?: WorkspaceRef;
  /** Worker assignment binding remains fixed when unrelated work survives a repair revision. */
  assignmentGoalRevision?: number;
  contract?: AttemptInspection['contract'];
  checkInputs?: FrozenTaskCheckInputs;
  candidate?: CandidateRef; result?: ExecutionResult; checks?: CheckResult[];
  integration?: IntegrationResult; cancellation: "none" | "requested" | "acknowledged";
  phase: "preparing" | "executing" | "capturing" | "checking" | "integrating" | "done";
  capacityWait?: "preparing" | "executing";
  verificationWait?: { condition: "inspection-evidence"; reason: string; since: string };
  checkRecoveryHistory?: Array<{ at: string; automatic: boolean; checks: CheckResult[]; error?: string; evidenceIds: string[] }>;
  recoveryObservation?: { phase: AttemptDetail["phase"]; reason: string; retryAt: string; failures: number };
}
export interface CriterionEvidence { criterion: string; satisfied: boolean; evidence: string[]; }
export interface EvaluationResponse {
  complete: boolean; summary: string; criteria: CriterionEvidence[];
  additionalTasks?: PlannedTask[]; waitReason?: string; wakeCondition?: string;
}
export interface EvaluationRecord {
  id: string; goalId: string; revision: number; at: string; head: string;
  evaluation: EvaluationResponse;
  goalChecks?: GoalCheckRecord;
}
export interface GoalCheckRecord {
  id: string; goalId: string; revision: number; at: string;
  repository: RepositoryEvidence; commands: string[]; checks: CheckResult[];
}
export interface ControlRecord {
  id: string; stage: "plan" | "dispatch" | "evaluate" | "diagnose" | "wait" | "done";
  startedAt: string; maxDurationMs?: number;
  waitingFor?: string; waitReason?: string; wakeAt?: string;
  diagnosisTaskId?: string; steering: string[]; replanReason?: string;
  /** Pending diagnosis handoff, consumed only by the replacement plan. */
  replanInstructions?: string;
  /** Only these unfinished tasks are replaced by a localized repair plan. */
  replanTaskIds?: string[];
  operation?: { id: string; revision: number; kind: "planner" | "evaluator" | "diagnosis"; inspectionEventRevision?: number };
  manualAction?: "plan" | "evaluate";
  decisionFailures?: { signature: string; count: number };
  /** Persisted consecutive failures; service restarts cannot reset the retry budget. */
  controllerFailures?: { revision: number; kind: "planner" | "evaluator" | "diagnosis"; count: number };
}
export interface CreateGoalInput {
  projectId: string; title?: string; objective: string; criteria?: string[];
  runtime?: RuntimeKind; approvalMode?: ApprovalMode; autonomy?: AutonomyMode;
  concurrency?: number; maxAttempts?: number; maxDurationMs?: number;
  execution?: TaskExecutionRequirements;
  acceptance?: Goal["acceptance"];
}
export interface ConfigureGoalInput {
  autonomy?: AutonomyMode; approvalMode?: ApprovalMode; runtime?: RuntimeKind; concurrency?: number;
  maxAttempts?: number | null; maxDurationMs?: number | null;
  execution?: TaskExecutionRequirements;
}
export interface CoordinatorOptions {
  store: FactoryStore; runtime: FactoryRuntimePort; workspaces: FactoryWorkspacePort;
  deviceId: string; devices: () => Device[]; project: (id: string) => Project | undefined;
  /** Fresh owning-host capacity check before allocating new controller or worker work. */
  admission?: (goal: Goal) => { reason: string; condition: string } | undefined;
  /** Owned inspection/setup agents share this goal's author concurrency budget. */
  additionalActiveAgents?: (goalId: string) => number;
  onChange?: () => void; now?: () => Date;
}
