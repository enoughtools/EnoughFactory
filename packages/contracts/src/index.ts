export const PRODUCT = "EnoughFactory";
export const PROTOCOL_VERSION = 1;
export type RuntimeKind = "codex" | "antigravity" | "claude";
export type ApprovalMode = "approve-all" | "rules" | "manual";
export type AutonomyMode = "manual" | "assisted" | "autonomous";
export interface PolicyRule { id: string; tool?: string; commandPattern?: string; decision: "allow" | "deny" | "ask"; }
export interface WorkingDirectory { id: string; name: string; path: string; }
export type DevelopmentToolchainId = "default" | "swift-6.0.3";
/** Fixed recipe and immutable image actually used by an owned container runtime. */
export interface DevelopmentToolchain {
  id: "swift-6.0.3"; recipeSha256: string; image: string; baseImage: string;
  platform: "linux/arm64" | "linux/amd64"; swiftVersion: string; nodeVersion: string;
}
export interface WorkingDirectoryMount {
  id: string; name: string; path: string; kind: "git" | "folder"; baseCommit: string; sourceCommit?: string;
  status: "preparing" | "ready" | "captured" | "failed"; error?: string;
  capture?: { commit: string; bundleArtifactId: string; diffArtifactId: string };
}
export interface Project {
  id: string; name: string; path: string; deviceId: string; createdAt: string;
  runtime: RuntimeKind; approvalMode: ApprovalMode; rules: PolicyRule[];
  internal?: boolean; sourceProjectId?: string;
  /** Additional roots are writable isolated snapshots; only the primary repository auto-integrates. */
  workingDirectories?: WorkingDirectory[];
  /** Absent detects Swift source; default explicitly retains the ordinary environment. */
  developmentToolchain?: DevelopmentToolchainId;
  /** Reversible catalog removal. Repository files and retained history are unchanged. */
  archivedAt?: string;
}
export type SessionStatus = "starting" | "ready" | "stopping" | "stopped" | "failed" | "unknown";
export interface Service {
  name: string; status: string; command?: string; url?: string; port?: number; exitCode?: number;
}
export interface Session {
  id: string; projectId: string; deviceId: string; name: string; status: SessionStatus;
  phase?: string; error?: string; createdAt: string; updatedAt: string; branch?: string;
  services: Service[]; containerId?: string; enginePid?: number;
  workingDirectories?: WorkingDirectoryMount[];
  developmentToolchain?: DevelopmentToolchain;
  /** Reversible catalog removal; execution and evidence records remain available by identity. */
  archivedAt?: string;
}
export interface Device {
  id: string; name: string; platform: string; arch: string; online: boolean; lastSeen: string;
  local: boolean; publicKey?: string; transport?: "local" | "webrtc" | "relay"; capacity?: number;
  /** CPU and memory available to this device's owned container runtime. */
  workerResources?: { cpus: number; memoryGiB: number };
  workspaceProviders?: ("git" | "artifactfs")[];
}
export interface RuntimeCapability {
  kind: RuntimeKind; available: boolean; version?: string; fullAccess: boolean;
  interactiveApprovals: boolean; resume: boolean; details?: string;
}
export interface Chat {
  id: string; sessionId: string; deviceId: string; title: string; runtime: RuntimeKind;
  attemptId?: string;
  approvalMode: ApprovalMode; status: "idle" | "running" | "waiting" | "failed" | "interrupted";
  createdAt: string; updatedAt: string; threadId?: string; error?: string;
}
export type ChatEventKind = "message" | "tool" | "approval" | "status" | "usage" | "artifact" | "error";
export interface ChatEvent {
  id: string; chatId: string; seq: number; at: string; kind: ChatEventKind;
  role?: "user" | "assistant" | "system"; text?: string; data?: Record<string, unknown>;
}
export interface Approval {
  id: string; chatId: string; sessionId: string; attemptId?: string; turnId?: string;
  runtime: RuntimeKind; action: string; description: string; arguments: unknown;
  status: "pending" | "allowed" | "denied" | "expired"; createdAt: string; decidedAt?: string;
  policyRevision: number;
}
export type GoalStatus = "draft" | "planning" | "running" | "paused" | "waiting" | "completed" | "failed" | "canceled";
export interface Goal {
  id: string; projectId: string; coordinatorId: string; title: string; objective: string;
  criteria: string[]; status: GoalStatus; autonomy: AutonomyMode; approvalMode: ApprovalMode;
  runtime: RuntimeKind; createdAt: string; updatedAt: string; revision: number;
  nextAction?: string; error?: string; concurrency: number; maxSpend?: number; maxAttempts?: number;
  workspaceProvider?: "git" | "artifactfs";
}
export type TaskKind = "feature" | "unit" | "architecture" | "test";
export interface TaskResources { cpus?: number; memoryGiB?: number; }
export interface FactoryTask {
  id: string; goalId: string; title: string; description: string; dependsOn: string[];
  /** Absent on legacy generic tasks. Kind changes the worker's delivery contract. */
  kind?: TaskKind; acceptanceCriteria?: string[]; expectedOutputs?: string[];
  estimatedMinutes?: number; writePaths?: string[]; resources?: TaskResources;
  status: "queued" | "ready" | "running" | "review" | "completed" | "failed" | "canceled";
  deviceId?: string; sessionId?: string; currentAttemptId?: string; createdAt: string; updatedAt: string;
}
export interface Attempt {
  id: string; taskId: string; generation: number; deviceId: string; sessionId?: string; chatId?: string;
  status: "created" | "running" | "succeeded" | "failed" | "retired" | "unknown";
  startedAt: string; endedAt?: string; candidate?: string; baseCommit?: string; error?: string;
}
export type AttemptPhase = "preparing" | "executing" | "capturing" | "checking" | "integrating" | "done";
export type TaskWorkState = "blocked" | "ready" | "queued" | "running" | "review" | "preparing" | "executing" | "capturing" | "checking" | "integrating" | "accepted" | "failed" | "canceled" | "unknown" | "waiting";
export interface TaskCheck {
  command: string; passed: boolean; output: string; exitCode?: number;
  candidateCommit: string; checkedCommit?: string; outputTruncated?: boolean;
  developmentToolchain?: DevelopmentToolchain;
}
export interface AttemptInspection {
  attempt: Attempt; phase?: AttemptPhase; cancellation?: "none" | "requested" | "acknowledged";
  contract?: { title: string; description: string; kind?: TaskKind; acceptanceCriteria?: string[]; expectedOutputs?: string[]; estimatedMinutes?: number; writePaths?: string[]; resources?: TaskResources; dependsOn: string[]; checks: string[]; planRevision: number };
  workspace?: { id: string; provider: "git" | "artifactfs"; baseCommit: string; sessionId?: string; deviceId?: string; workingDirectories?: WorkingDirectoryMount[]; developmentToolchain?: DevelopmentToolchain };
  candidate?: { id: string; commit: string; baseCommit: string; branch?: string; tree?: string; deviceId?: string; developmentToolchain?: DevelopmentToolchain };
  result?: { status: string; text: string; error?: string; waitReason?: string; wakeCondition?: string };
  checks?: TaskCheck[];
  integration?: { commit: string; previousHead: string; candidateCommit: string; checks: TaskCheck[] };
}
export interface TaskOverview { task: FactoryTask; state: TaskWorkState; reason?: string; phase?: AttemptPhase; attemptId?: string; }
export interface TaskInspection extends TaskOverview {
  detailsAvailable?: boolean;
  checks: string[]; planRevision?: number; repairInstructions?: string; lastError?: string;
  dependencies: FactoryTask[]; dependents: FactoryTask[]; attempts: AttemptInspection[]; artifacts: Artifact[];
}
export interface ControllerRun {
  id: string; goalId: string; role: "planner" | "evaluator" | "diagnosis";
  sessionId: string; chatId?: string; status: "starting" | "running" | "completed" | "interrupted" | "failed";
  updatedAt: string; error?: string;
}
export interface GoalInspection {
  goal: Goal; tasks: TaskOverview[]; controllers: ControllerRun[];
  plan?: { revision: number; summary: string; checks: string[]; createdAt: string };
  control?: { stage: "plan" | "dispatch" | "evaluate" | "diagnose" | "wait" | "done"; waitingFor?: string; waitReason?: string; wakeAt?: string; replanReason?: string; diagnosisTaskId?: string; replanTaskIds?: string[]; operation?: { kind: "planner" | "evaluator" | "diagnosis"; revision: number }; spent: number; unpricedTurns?: number; maxDurationMs?: number };
}
export interface Decision { id: string; goalId: string; at: string; kind: string; text: string; data?: unknown; }
export interface Artifact { id: string; goalId?: string; taskId?: string; attemptId?: string; name: string; mime: string; sha256: string; size: number; deviceId: string; createdAt: string; }
export interface ContainerRuntimeStatus {
  kind: "lima" | "rootless";
  state: "unavailable" | "stopped" | "starting" | "ready" | "stopping" | "failed";
  version?: string; dockerVersion?: string; socketPath: string; dataDirectory: string; stateDirectory: string;
  cpus?: number; memoryGiB?: number; diskGiB?: number; phase?: string; error?: string;
  requiredActions?: { label: string; detail: string; command?: string }[];
  artifactFsSupported: boolean;
}
export interface Diagnostics {
  networking?: { hostedRelay: boolean };
  docker: { available: boolean; version?: string; error?: string };
  containerRuntime?: ContainerRuntimeStatus;
  envmux: { available: boolean; version?: string; error?: string };
  runtimes: RuntimeCapability[];
}
export interface Settings {
  deviceName: string; signalingUrl?: string; turnUrls?: string[]; turnUsername?: string;
  turnCredential?: string; defaultRuntime: RuntimeKind; defaultApprovalMode: ApprovalMode;
  /** Concurrent factory attempts on this device; absent selects capacity from runtime resources. */
  workerCapacity?: number;
}
export interface FactoryState {
  product: typeof PRODUCT; version: string; device: Device; devices: Device[];
  projects: Project[]; sessions: Session[]; chats: Chat[]; approvals: Approval[];
  goals: Goal[]; tasks: FactoryTask[]; attempts: Attempt[]; diagnostics: Diagnostics; settings: Settings;
}
export interface RepositoryChangeFile { path: string; originalPath?: string; indexStatus: string; workingTreeStatus: string; }
export interface RepositoryChanges {
  branch: string; head: string; status: string; diff: string;
  /** Present on services that inspect both tracked and untracked live workspace files. */
  files?: RepositoryChangeFile[]; path?: string; truncated?: boolean;
}
export interface ApiError { error: string; code?: string; details?: unknown; }
export interface RpcRequest { v: 1; id: string; method: string; path: string; body?: unknown; }
export interface RpcResponse { v: 1; id: string; status: number; body: unknown; }
export interface StreamEvent { v: 1; type: "event"; topic: string; cursor: number; data: unknown; }
export type PeerEnvelope = RpcRequest | RpcResponse | StreamEvent;
