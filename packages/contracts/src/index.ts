export const PRODUCT = "EnoughFactory";
export const PROTOCOL_VERSION = 1;
export type RuntimeKind = "codex" | "antigravity" | "claude";
export type ApprovalMode = "approve-all" | "rules" | "manual";
export type AutonomyMode = "manual" | "assisted" | "autonomous";
export interface PolicyRule { id: string; tool?: string; commandPattern?: string; decision: "allow" | "deny" | "ask"; }
export interface Project {
  id: string; name: string; path: string; deviceId: string; createdAt: string;
  runtime: RuntimeKind; approvalMode: ApprovalMode; rules: PolicyRule[];
  internal?: boolean; sourceProjectId?: string;
}
export type SessionStatus = "starting" | "ready" | "stopping" | "stopped" | "failed" | "unknown";
export interface Service {
  name: string; status: string; command?: string; url?: string; port?: number; exitCode?: number;
}
export interface Session {
  id: string; projectId: string; deviceId: string; name: string; status: SessionStatus;
  phase?: string; error?: string; createdAt: string; updatedAt: string; branch?: string;
  services: Service[]; containerId?: string; enginePid?: number;
}
export interface Device {
  id: string; name: string; platform: string; arch: string; online: boolean; lastSeen: string;
  local: boolean; publicKey?: string; transport?: "local" | "webrtc" | "relay"; capacity?: number;
}
export interface RuntimeCapability {
  kind: RuntimeKind; available: boolean; version?: string; fullAccess: boolean;
  interactiveApprovals: boolean; resume: boolean; details?: string;
}
export interface Chat {
  id: string; sessionId: string; deviceId: string; title: string; runtime: RuntimeKind;
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
export interface FactoryTask {
  id: string; goalId: string; title: string; description: string; dependsOn: string[];
  status: "queued" | "ready" | "running" | "review" | "completed" | "failed" | "canceled";
  deviceId?: string; sessionId?: string; currentAttemptId?: string; createdAt: string; updatedAt: string;
}
export interface Attempt {
  id: string; taskId: string; generation: number; deviceId: string; sessionId?: string; chatId?: string;
  status: "created" | "running" | "succeeded" | "failed" | "retired" | "unknown";
  startedAt: string; endedAt?: string; candidate?: string; baseCommit?: string; error?: string;
}
export interface Decision { id: string; goalId: string; at: string; kind: string; text: string; data?: unknown; }
export interface Artifact { id: string; goalId?: string; taskId?: string; attemptId?: string; name: string; mime: string; sha256: string; size: number; deviceId: string; createdAt: string; }
export interface ContainerRuntimeStatus {
  kind: "lima" | "rootless";
  state: "unavailable" | "stopped" | "starting" | "ready" | "stopping" | "failed";
  version?: string; dockerVersion?: string; socketPath: string; dataDirectory: string;
  cpus?: number; memoryGiB?: number; diskGiB?: number; phase?: string; error?: string;
  requiredActions?: { label: string; detail: string; command?: string }[];
  artifactFsSupported: boolean;
}
export interface Diagnostics {
  docker: { available: boolean; version?: string; error?: string };
  containerRuntime?: ContainerRuntimeStatus;
  envmux: { available: boolean; version?: string; error?: string };
  runtimes: RuntimeCapability[];
}
export interface Settings {
  deviceName: string; signalingUrl?: string; turnUrls?: string[]; turnUsername?: string;
  turnCredential?: string; defaultRuntime: RuntimeKind; defaultApprovalMode: ApprovalMode;
}
export interface FactoryState {
  product: typeof PRODUCT; version: string; device: Device; devices: Device[];
  projects: Project[]; sessions: Session[]; chats: Chat[]; approvals: Approval[];
  goals: Goal[]; tasks: FactoryTask[]; attempts: Attempt[]; diagnostics: Diagnostics; settings: Settings;
}
export interface RepositoryChanges { branch: string; head: string; status: string; diff: string; }
export interface ApiError { error: string; code?: string; details?: unknown; }
export interface RpcRequest { v: 1; id: string; method: string; path: string; body?: unknown; }
export interface RpcResponse { v: 1; id: string; status: number; body: unknown; }
export interface StreamEvent { v: 1; type: "event"; topic: string; cursor: number; data: unknown; }
export type PeerEnvelope = RpcRequest | RpcResponse | StreamEvent;
