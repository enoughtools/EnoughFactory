import type { Approval, ApprovalMode, ChatEvent, PolicyRule, RuntimeKind } from "@enoughfactory/contracts";

export type AgentEvent = Omit<ChatEvent, "id" | "chatId" | "seq" | "at">;
export interface TurnInput {
  chatId: string;
  sessionId: string;
  /** Omission preserves the existing container route. Host execution is explicit. */
  executionTarget?: "container" | "host-macos";
  containerId?: string;
  runtime: RuntimeKind;
  approvalMode: ApprovalMode;
  rules: PolicyRule[];
  prompt: string;
  threadId?: string;
  attemptId?: string;
  policyRevision?: number;
  cwd?: string;
  model?: string;
  systemInstructions?: string;
  codexTransport?: "app-server" | "exec";
  antigravityTransport?: "sdk" | "cli";
  /** Factory-owned tools only; never inherited from the user's provider configuration. */
  mcpServers?: Record<string, AgentMcpServer>;
  /** Scoped tool credentials travel in the provider environment, never in argv or events. */
  toolEnvironment?: Record<string, string>;
}
export type AgentMcpServer =
  | { command: string; args?: string[]; env?: Record<string, string>; enabledTools?: string[]; startupTimeoutSeconds?: number; toolTimeoutSeconds?: number }
  | { url: string; bearerTokenEnvVar?: string; enabledTools?: string[]; startupTimeoutSeconds?: number; toolTimeoutSeconds?: number };
export interface AgentImageReference { artifactId?: string; sha256: string; mimeType: string; byteLength: number; [key: string]: unknown; }
export interface TurnCallbacks {
  onEvent: (event: AgentEvent) => void | Promise<void>;
  onApproval: (approval: Approval, signal?: AbortSignal) => Promise<boolean | { decision: "allow" | "deny" }>;
  onQuestion?: (request: { id: string; questions: unknown; chatId: string }, signal: AbortSignal) => Promise<Record<string, { answers: string[] }>>;
  /** Persist original bytes once. Only the returned reference is stored with tool events. */
  onToolImage?: (image: { bytes: Buffer; mimeType: string; itemId?: string }, signal: AbortSignal) => Promise<AgentImageReference>;
}
export interface TurnResult {
  threadId?: string;
  text: string;
  usage?: Record<string, unknown>;
  stopReason?: string;
}
export interface ProvisionOptions { copyHostAuth?: boolean; hostAuthDir?: string; }
export const RUNTIME_PINS = { codex: "0.160.0", claude: "2.1.289", antigravitySdk: "0.1.20", node: "22.22.0" } as const;

export class AgentError extends Error {
  /** False proves no task turn was dispatched; true can still mean an uncertain outcome. */
  agentStarted?: boolean;
  constructor(message: string, readonly code = "AGENT_RUNTIME_ERROR", readonly executionEnded = false) { super(message); this.name = "AgentError"; }
}
