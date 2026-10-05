import { randomUUID } from "node:crypto";
import type { Approval, PolicyRule } from "@enoughfactory/contracts";
import type { AgentEvent, TurnCallbacks, TurnInput } from "./types.ts";

function matches(pattern: string, value: string): boolean {
  const expression = pattern.split("*").map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join(".*");
  return new RegExp(`^${expression}$`, "s").test(value);
}
export function matchPolicyRule(rules: PolicyRule[], action: string, args: unknown): PolicyRule | undefined {
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const command = typeof record.command === "string" ? record.command : Array.isArray(record.command) ? record.command.join(" ") : "";
  return rules.find((rule) => (!rule.tool || matches(rule.tool, action)) && (!rule.commandPattern || matches(rule.commandPattern, command)));
}

/** A decision is scoped to one live runtime; interruption never accepts a late callback. */
export class ApprovalRouter {
  private pending = new Map<string, Approval>();
  private native = new Map<string | number, { id: string; controller: AbortController }>();
  private resolved = new Set<string | number>();
  constructor(private input: TurnInput, private callbacks: TurnCallbacks, readonly signal: AbortSignal) {}
  async decide(action: string, args: unknown, description: string, turnId?: string, nativeId?: string | number): Promise<boolean> {
    if (this.signal.aborted) return false;
    const approval: Approval = {
      id: randomUUID(), chatId: this.input.chatId, sessionId: this.input.sessionId,
      attemptId: this.input.attemptId, turnId, runtime: this.input.runtime, action, arguments: args,
      description, status: "pending", createdAt: new Date().toISOString(), policyRevision: this.input.policyRevision ?? 1,
    };
    this.pending.set(approval.id, approval);
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort();
    this.signal.addEventListener("abort", abortRequest, { once: true });
    if (nativeId !== undefined) this.native.set(nativeId, { id: approval.id, controller: requestController });
    const emit = (status: Approval["status"], extra?: Record<string, unknown>) => this.callbacks.onEvent({
      kind: "approval", text: description, data: { approval: { ...approval, status, decidedAt: status === "pending" ? undefined : new Date().toISOString() }, nativeId, ...extra },
    });
    try {
      const rule = this.input.approvalMode === "rules" ? matchPolicyRule(this.input.rules, action, args) : undefined;
      let allowed: boolean;
      if (this.input.approvalMode === "approve-all") allowed = true;
      else if (rule && rule.decision !== "ask") allowed = rule.decision === "allow";
      else {
        await emit("pending");
        const response = await Promise.race([
          this.callbacks.onApproval(approval, requestController.signal),
          new Promise<false>((resolve) => requestController.signal.addEventListener("abort", () => resolve(false), { once: true })),
        ]);
        allowed = typeof response === "boolean" ? response : response.decision === "allow";
      }
      if (this.signal.aborted || requestController.signal.aborted || !this.pending.has(approval.id)) return false;
      await emit(allowed ? "allowed" : "denied", { ruleId: rule?.id });
      return allowed;
    } finally {
      this.pending.delete(approval.id);
      if (nativeId !== undefined) this.native.delete(nativeId);
      this.signal.removeEventListener("abort", abortRequest);
    }
  }
  expire(nativeId?: string | number): void {
    if (nativeId === undefined) return;
    this.resolved.add(nativeId);
    const request = this.native.get(nativeId);
    if (!request) return;
    const approval = this.pending.get(request.id);
    this.native.delete(nativeId); this.pending.delete(request.id); request.controller.abort();
    if (approval) void this.callbacks.onEvent({ kind: "approval", text: approval.description, data: { approval: { ...approval, status: "expired" } } });
  }
  isResolved(nativeId: string | number): boolean { return this.resolved.has(nativeId); }
  async cancel(): Promise<void> {
    const pending = [...this.pending.values()]; this.pending.clear();
    for (const request of this.native.values()) request.controller.abort();
    this.native.clear();
    await Promise.allSettled(pending.map((approval) => this.callbacks.onEvent({ kind: "approval", text: approval.description, data: { approval: { ...approval, status: "expired" } } } satisfies AgentEvent)));
  }
}
