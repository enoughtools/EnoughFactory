import type { Approval, ApprovalMode, ChatEvent, PolicyRule, RuntimeKind } from "@enoughfactory/contracts";

export type AgentEvent = Omit<ChatEvent, "id" | "chatId" | "seq" | "at">;
export interface TurnInput {
  chatId: string;
  sessionId: string;
  containerId: string;
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
}
export interface TurnCallbacks {
  onEvent: (event: AgentEvent) => void | Promise<void>;
  onApproval: (approval: Approval, signal?: AbortSignal) => Promise<boolean | { decision: "allow" | "deny" }>;
  onQuestion?: (request: { id: string; questions: unknown; chatId: string }, signal: AbortSignal) => Promise<Record<string, { answers: string[] }>>;
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
  constructor(message: string, readonly code = "AGENT_RUNTIME_ERROR", readonly executionEnded = false) { super(message); this.name = "AgentError"; }
}
