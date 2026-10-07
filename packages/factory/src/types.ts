import type { ApprovalMode, Attempt, AttemptInspection, AutonomyMode, Device, FactoryTask, Goal, Project, RuntimeKind, TaskKind, DevelopmentToolchain } from "@enoughfactory/contracts";

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
export interface FactoryWorkspacePort {
  prepare(input: { goal: Goal; task: FactoryTask; attempt: Attempt; project: Project; previousCandidate?: CandidateRef }): Promise<WorkspaceRef>;
  capture(workspace: WorkspaceRef, input: { goal: Goal; task: FactoryTask; attempt: Attempt }): Promise<CandidateRef>;
  check(project: Project, candidate: CandidateRef, commands: string[]): Promise<CheckResult[]>;
  /** Check an isolated exact final repository snapshot after task dependencies integrate. */
  checkGoal?(project: Project, commands: string[]): Promise<{ repository: RepositoryEvidence; checks: CheckResult[] }>;
  /** Recheck the combined result when HEAD changed. Fence immediately before writing. */
  integrate(project: Project, candidate: CandidateRef, input: { checks: string[]; isCurrent: () => boolean }): Promise<IntegrationResult>;
  inspect(project: Project): Promise<RepositoryEvidence>;
  reconcileIntegration?(project: Project, candidate: CandidateRef): Promise<IntegrationResult | undefined>;
  release?(workspace: WorkspaceRef): Promise<void>;
}

export interface ExecutionResult {
  status: "succeeded" | "failed" | "waiting" | "unknown";
  text: string; chatId?: string; sessionId?: string; spend?: number;
  error?: string; waitReason?: string; wakeCondition?: string;
}
export interface FactoryRuntimePort {
  complete(input: { goal: Goal; role: "planner" | "evaluator" | "diagnosis"; prompt: string; project: Project; signal?: AbortSignal }): Promise<{ text: string; chatId?: string; spend?: number }>;
  execute(input: { goal: Goal; task: FactoryTask; attempt: Attempt; workspace: WorkspaceRef; prompt: string; project: Project; assignmentGoalRevision?: number }): Promise<ExecutionResult>;
  reconcile(attempt: Attempt): Promise<{ status: "prepared" | "running" | "succeeded" | "failed" | "unknown"; result?: ExecutionResult; workspace?: WorkspaceRef }>;
  /** Returns after the owner acknowledges cancellation; rejection leaves termination unknown. */
  cancel(attempt: Attempt): Promise<void>;
}

export interface PlannedTask {
  key: string; title: string; description: string; dependsOn: string[];
  checks: string[]; deviceId?: string;
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
  planChecks?: string[]; waitingFor?: string; waitReason?: string;
  lastError?: string; lastCandidate?: CandidateRef; repairInstructions?: string;
  selected: boolean; failureSignatures: string[];
}
export interface AttemptDetail {
  id: string; goalId: string; goalRevision: number; workspace?: WorkspaceRef;
  /** Worker assignment binding remains fixed when unrelated work survives a repair revision. */
  assignmentGoalRevision?: number;
  contract?: AttemptInspection['contract'];
  candidate?: CandidateRef; result?: ExecutionResult; checks?: CheckResult[];
  integration?: IntegrationResult; cancellation: "none" | "requested" | "acknowledged";
  usageAccounted?: boolean; accountedSpend?: number;
  phase: "preparing" | "executing" | "capturing" | "checking" | "integrating" | "done";
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
  spent: number; unpricedTurns?: number; startedAt: string; maxDurationMs?: number;
  waitingFor?: string; waitReason?: string; wakeAt?: string;
  diagnosisTaskId?: string; steering: string[]; replanReason?: string;
  /** Only these unfinished tasks are replaced by a localized repair plan. */
  replanTaskIds?: string[];
  operation?: { id: string; revision: number; kind: "planner" | "evaluator" | "diagnosis" };
  manualAction?: "plan" | "evaluate";
  decisionFailures?: { signature: string; count: number };
  /** Persisted consecutive failures; service restarts cannot reset the retry budget. */
  controllerFailures?: { revision: number; kind: "planner" | "evaluator" | "diagnosis"; count: number };
}
export interface CreateGoalInput {
  projectId: string; title?: string; objective: string; criteria?: string[];
  runtime?: RuntimeKind; approvalMode?: ApprovalMode; autonomy?: AutonomyMode;
  concurrency?: number; maxSpend?: number; maxAttempts?: number; maxDurationMs?: number;
}
export interface ConfigureGoalInput {
  autonomy?: AutonomyMode; approvalMode?: ApprovalMode; runtime?: RuntimeKind; concurrency?: number;
  maxSpend?: number | null; maxAttempts?: number | null; maxDurationMs?: number | null;
}
export interface CoordinatorOptions {
  store: FactoryStore; runtime: FactoryRuntimePort; workspaces: FactoryWorkspacePort;
  deviceId: string; devices: () => Device[]; project: (id: string) => Project | undefined;
  onChange?: () => void; now?: () => Date;
}
