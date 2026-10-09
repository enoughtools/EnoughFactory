export const PRODUCT = "EnoughFactory";
export const PROTOCOL_VERSION = 1;
export type RuntimeKind = "codex" | "antigravity" | "claude";
export type ApprovalMode = "approve-all" | "rules" | "manual";
export type AutonomyMode = "manual" | "assisted" | "autonomous";
export const EXECUTION_CAPABILITIES = ["linux-shell", "mac-shell", "chromium-inspection", "apple-compilation", "macos-app-inspection", "ios-simulator-inspection"] as const;
export type ExecutionCapability = typeof EXECUTION_CAPABILITIES[number];
export type ExecutionTargetKind = "container" | "host-macos";
export type ExecutionTargetPreference = ExecutionTargetKind | "auto";
export type ExecutionReadiness = "ready" | "preparing" | "busy" | "offline" | "setup-required" | "unsupported";
export interface ExecutionCapabilityAdvertisement {
  kind: ExecutionCapability; readiness: ExecutionReadiness; version?: string; reason?: string; setupAction?: string;
}
export interface ExecutionTargetAdvertisement {
  id: string; kind: ExecutionTargetKind; protocolVersion: 1; readiness: ExecutionReadiness;
  capabilities: ExecutionCapabilityAdvertisement[]; reason?: string; setupAction?: string;
  workspaceProviders?: ("git" | "artifactfs")[];
  runtimes?: RuntimeKind[];
  /** Capacity belongs to this target, independently of the device's container pool. */
  capacity?: number; resources?: { cpus: number; memoryGiB: number };
}
export interface TaskExecutionRequirements {
  /** Omission preserves legacy container execution; auto is an explicit placement choice. */
  target?: ExecutionTargetPreference;
  /** Capabilities that must be available where the author process executes. */
  requiredCapabilities?: ExecutionCapability[];
  /** Tools may be delegated to another configured execution target/device. */
  delegatedCapabilities?: ExecutionCapability[];
}
export type QualityPlatform = "web" | "macos" | "ios-simulator";
export interface TaskQualityRequirements {
  platforms: QualityPlatform[]; workflows: Array<{ id: string; platform: QualityPlatform }>; referenceIds: string[];
}
/** User-selected application acceptance, independent of a planner's task policies. */
export interface ApplicationAcceptance {
  kind: "application"; platforms: QualityPlatform[]; referenceIds: string[];
}
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
  executionTargetId?: string; executionTargetKind?: ExecutionTargetKind;
  verificationRunId?: string;
  /** Reversible catalog removal; execution and evidence records remain available by identity. */
  archivedAt?: string;
}
export interface Device {
  id: string; name: string; platform: string; arch: string; online: boolean; lastSeen: string;
  local: boolean; publicKey?: string; transport?: "local" | "webrtc" | "relay"; capacity?: number;
  /** CPU and memory available to this device's owned container runtime. */
  workerResources?: { cpus: number; memoryGiB: number };
  workspaceProviders?: ("git" | "artifactfs")[];
  /** Explicitly probed execution support; the host platform is not a capability advertisement. */
  executionTargets?: ExecutionTargetAdvertisement[];
}
export interface RuntimeCapability {
  kind: RuntimeKind; available: boolean; version?: string; fullAccess: boolean;
  interactiveApprovals: boolean; resume: boolean; details?: string;
}
export interface Chat {
  id: string; sessionId: string; deviceId: string; title: string; runtime: RuntimeKind;
  attemptId?: string;
  /** Separate immutable-source verifier authority, never permission to reopen the author. */
  verificationRunId?: string;
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
  nextAction?: string; error?: string; concurrency: number; maxAttempts?: number;
  workspaceProvider?: "git" | "artifactfs";
  /** Explicit controller placement and default for tasks without their own execution requirements. */
  execution?: TaskExecutionRequirements;
  /** Omission preserves existing non-application and legacy goal behavior. */
  acceptance?: ApplicationAcceptance;
}
export type TaskKind = "feature" | "unit" | "architecture" | "test";
export interface TaskResources { cpus?: number; memoryGiB?: number; }
export interface FactoryTask {
  id: string; goalId: string; title: string; description: string; dependsOn: string[];
  /** Absent on legacy generic tasks. Kind changes the worker's delivery contract. */
  kind?: TaskKind; acceptanceCriteria?: string[]; expectedOutputs?: string[];
  estimatedMinutes?: number; writePaths?: string[]; resources?: TaskResources;
  execution?: TaskExecutionRequirements;
  quality?: TaskQualityRequirements;
  status: "queued" | "ready" | "running" | "review" | "completed" | "failed" | "canceled";
  deviceId?: string; sessionId?: string; currentAttemptId?: string; createdAt: string; updatedAt: string;
}
export interface Attempt {
  id: string; taskId: string; generation: number; deviceId: string; sessionId?: string; chatId?: string;
  status: "created" | "running" | "succeeded" | "failed" | "retired" | "unknown";
  startedAt: string; endedAt?: string; candidate?: string; baseCommit?: string; error?: string;
  /** Frozen execution placement; absent on legacy container attempts. */
  executionTargetId?: string; executionTargetKind?: ExecutionTargetKind;
}
export type AttemptPhase = "preparing" | "executing" | "capturing" | "checking" | "integrating" | "done";
export type TaskWorkState = "blocked" | "ready" | "queued" | "running" | "review" | "preparing" | "executing" | "capturing" | "checking" | "integrating" | "accepted" | "failed" | "canceled" | "unknown" | "waiting";
export type AppleValidationProfile =
  | { tool: "swift"; package: string; action: "build" | "test" }
  | { tool: "xcodebuild"; project: string; scheme: string; platform: "macos" | "ios-simulator"; configuration: "Debug" | "Release" };
export interface AppleValidationMetadata {
  version: 1; candidateId: string; candidateCommit: string; checkedCommit: string; profile: AppleValidationProfile;
  sandbox: "macos-seatbelt-deny-default"; developerDirectory: string;
  workingDirectories: Array<{ containerPath: string; commit: string }>; products: Artifact[]; artifact?: Artifact;
}
export interface TaskCheck {
  command: string; passed: boolean; output: string; exitCode?: number;
  candidateCommit: string; checkedCommit?: string; outputTruncated?: boolean;
  developmentToolchain?: DevelopmentToolchain;
  appleValidation?: AppleValidationMetadata;
  executionTargetKind?: ExecutionTargetKind; hostPermissions?: "full-host";
  recovery?: { condition: "inspection-evidence" | "check-interrupted"; reason: string };
}
export interface AttemptInspection {
  attempt: Attempt; phase?: AttemptPhase; cancellation?: "none" | "requested" | "acknowledged";
  verificationWait?: { condition: "inspection-evidence"; reason: string; since: string };
  contract?: { title: string; description: string; kind?: TaskKind; acceptanceCriteria?: string[]; expectedOutputs?: string[]; estimatedMinutes?: number; writePaths?: string[]; resources?: TaskResources; execution?: TaskExecutionRequirements; quality?: TaskQualityRequirements; dependsOn: string[]; checks: string[]; planRevision: number };
  workspace?: { id: string; provider: "git" | "artifactfs"; baseCommit: string; sessionId?: string; deviceId?: string; workingDirectories?: WorkingDirectoryMount[]; developmentToolchain?: DevelopmentToolchain };
  candidate?: { id: string; commit: string; baseCommit: string; branch?: string; tree?: string; deviceId?: string; developmentToolchain?: DevelopmentToolchain };
  result?: { status: string; text: string; error?: string; waitReason?: string; wakeCondition?: string };
  checks?: TaskCheck[];
  integration?: { commit: string; previousHead: string; candidateCommit: string; checks: TaskCheck[] };
}
export interface TaskOverview { task: FactoryTask; state: TaskWorkState; reason?: string; phase?: AttemptPhase; attemptId?: string; }
export interface TaskInspection extends TaskOverview {
  detailsAvailable?: boolean;
  wait?: { condition: string; reason: string; since?: string };
  /** Required verifier input names only; coordinator configuration values remain private. */
  verificationInputs?: { missingEnvironment: string[] };
  /** Owning service proof; retries verification of saved work without another author attempt. */
  verificationRecovery?: { eligible: boolean; reason?: string; goalRevision: number; attemptId: string; candidateId: string; candidateCommit: string };
  executionBlocker?: { kind: "execution-capability"; readiness: Exclude<ExecutionReadiness, "ready">; reason: string; capabilities?: ExecutionCapability[]; deviceIds?: string[]; targetIds?: string[] };
  checks: string[]; planRevision?: number; repairInstructions?: string; lastError?: string;
  dependencies: FactoryTask[]; dependents: FactoryTask[]; attempts: AttemptInspection[]; artifacts: Artifact[];
}
export interface ControllerRun {
  id: string; goalId: string; role: "planner" | "evaluator" | "diagnosis";
  sessionId: string; chatId?: string; status: "starting" | "running" | "waiting" | "completed" | "interrupted" | "failed";
  updatedAt: string; error?: string;
}
export interface GoalInspection {
  goal: Goal; tasks: TaskOverview[]; controllers: ControllerRun[];
  plan?: { revision: number; summary: string; checks: string[]; createdAt: string };
  control?: { stage: "plan" | "dispatch" | "evaluate" | "diagnose" | "wait" | "done"; waitingFor?: string; waitReason?: string; wakeAt?: string; replanReason?: string; diagnosisTaskId?: string; replanTaskIds?: string[]; operation?: { kind: "planner" | "evaluator" | "diagnosis"; revision: number }; maxDurationMs?: number };
}
export interface Decision { id: string; goalId: string; at: string; kind: string; text: string; data?: unknown; }
export interface Artifact { id: string; goalId?: string; taskId?: string; attemptId?: string; name: string; mime: string; sha256: string; size: number; deviceId: string; createdAt: string; }
export interface InspectionAuthority {
  goalId: string; goalRevision: number; taskId: string; attemptId: string; authorityGeneration: number; policyRevision: number;
}
export interface InspectionSourceIdentity {
  snapshotId: string; sha256: string; candidateId?: string; candidateCommit?: string; checkedCommit?: string;
  roots?: Array<{ id: string; sha256: string; commit?: string }>;
}
export interface InspectionVerificationAcceptance {
  version: 1;
  /** Original author assignment, never the later mutable task description. */
  task: NonNullable<AttemptInspection["contract"]>;
  /** Canonical completion requirements retained for this final-review revision. */
  goal?: { revision: number; objective: string; criteria: string[]; taskContracts: Array<{ taskId: string; attemptId: string; authorityGeneration: number; assignmentGoalRevision: number; contract: NonNullable<AttemptInspection["contract"]> }> };
}
export interface InspectionVerificationRun {
  id: string; authority: InspectionAuthority; source: InspectionSourceIdentity; quality: TaskQualityRequirements;
  /** Missing only on historical verifiers that did not receive the full acceptance contract. */
  acceptanceContract?: InspectionVerificationAcceptance;
  /** Final product inspection retains an accepted author identity and fences the current goal revision separately. */
  purpose?: "task" | "goal-final"; goalRevision?: number;
  policySha256: string; ownerDeviceId: string; executionTargetKind: ExecutionTargetKind; executionTargetId: string;
  sessionId?: string; chatId?: string;
  status: "queued" | "preparing" | "running" | "waiting" | "unknown" | "succeeded" | "failed" | "canceled";
  createdAt: string; updatedAt: string; reason?: string; deadlineAt: string; startedAt?: string; completedAt?: string;
}
export type InspectionJobStatus = "queued" | "preparing" | "running" | "waiting" | "cancellation-requested" | "unknown" | "succeeded" | "failed" | "canceled";
export interface InspectionJob {
  id: string; authority: InspectionAuthority; ownerDeviceId: string; executionTargetId: string;
  capability: ExecutionCapability; source: InspectionSourceIdentity; profile: Record<string, unknown>;
  status: InspectionJobStatus; createdAt: string; updatedAt: string; sessionId?: string; reason?: string; leaseIds?: string[];
}
export type InspectionSessionStatus = "starting" | "ready" | "waiting" | "stopping" | "stopped" | "unknown" | "failed";
export interface InspectionSession {
  id: string; jobId: string; authority: InspectionAuthority; ownerDeviceId: string; executionTargetId: string;
  capability: ExecutionCapability; source: InspectionSourceIdentity; status: InspectionSessionStatus;
  createdAt: string; updatedAt: string; reason?: string; simulatorId?: string; latestObservationId?: string;
  processIdentity?: { pid: number; startedAt: string; executableSha256?: string };
}
export type InspectionActionKind = "build" | "start" | "restart" | "navigate" | "observe" | "screenshot" | "click" | "type" | "key" | "scroll" | "run-tests" | "stop";
export type InspectionActionStatus = "requested" | "running" | "cancellation-requested" | "succeeded" | "failed" | "unknown" | "canceled";
export interface InspectionAction {
  id: string; jobId: string; sessionId: string; authority: InspectionAuthority; kind: InspectionActionKind;
  /** Each broker validates the capability-specific argument schema before execution. */
  arguments: Record<string, unknown>; observationId?: string; status: InspectionActionStatus;
  createdAt: string; updatedAt: string; evidenceIds?: string[]; reason?: string;
}
export interface InspectionEvidence {
  id: string; jobId: string; sessionId?: string; actionId?: string; authority: InspectionAuthority; source: InspectionSourceIdentity;
  kind: "screenshot" | "observation" | "log" | "trace" | "assertion" | "build-product";
  artifact: Artifact; createdAt: string; metadata?: Record<string, unknown>;
}
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
