import type { RuntimeCapability, RuntimeKind } from "@enoughfactory/contracts";
import { CodexTurn } from "./codex.ts";
import { ContainerProcess, containerCommand, type SpawnProcess } from "./process.ts";
import { ApprovalRouter } from "./policy.ts";
import { availability, copyMinimalAuth, provisionRuntime, writePrivateFile, type RuntimeOptions } from "./provision.ts";
import { AgentError, type ProvisionOptions, type TurnCallbacks, type TurnInput, type TurnResult } from "./types.ts";

export * from "./types.ts";
export { ApprovalRouter, matchPolicyRule } from "./policy.ts";
export { CODEX_PROTOCOL_VERSION, codexApprovalResponse } from "./codex.ts";

interface LiveTurn { controller: AbortController; process?: ContainerProcess; router: ApprovalRouter; codex?: CodexTurn; }
export interface AgentManagerOptions extends RuntimeOptions {
  autoProvision?: boolean;
  copyHostAuth?: boolean;
  hostAuthDir?: string;
}
export class AgentManager {
  private live = new Map<string, LiveTurn>();
  private provisioning = new Map<string, Promise<RuntimeCapability>>();
  constructor(private options: AgentManagerOptions = {}) {}
  availability(containerId: string): Promise<RuntimeCapability[]> { return availability(containerId, this.options); }
  async provision(containerId: string, runtime: RuntimeKind, provision: ProvisionOptions = {}, signal?: AbortSignal): Promise<RuntimeCapability> {
    const key = `${containerId}:${runtime}`;
    const existing = this.provisioning.get(key);
    if (existing) {
      const result = await existing;
      if (provision.copyHostAuth) await copyMinimalAuth(containerId, runtime, provision, this.options);
      return result;
    }
    const job = provisionRuntime(containerId, runtime, provision, { ...this.options, signal });
    this.provisioning.set(key, job);
    try { return await job; } finally { this.provisioning.delete(key); }
  }
  async connectApiKey(containerId: string, runtime: RuntimeKind, apiKey: string): Promise<void> {
    if (!apiKey.trim() || apiKey.includes("\0")) throw new AgentError("A provider key is required.", "INVALID_CREDENTIAL");
    if (runtime === "codex") {
      await this.provision(containerId, runtime);
      await containerCommand(containerId, ["sh", "-c", "export PATH=/opt/enoughfactory/node/bin:$PATH; export CODEX_HOME=/root/.codex; exec codex login --with-api-key"], { ...this.options, input: apiKey });
    } else {
      const key = runtime === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
      const shellValue = `'${apiKey.replace(/'/g, `'"'"'`)}'`;
      await writePrivateFile(containerId, `/root/.enoughfactory/providers/${runtime}.env`, `export ${key}=${shellValue}\n`, this.options);
    }
  }
  async runTurn(input: TurnInput, callbacks: TurnCallbacks): Promise<TurnResult> {
    if (this.live.has(input.chatId)) throw new AgentError("This conversation already has a live agent turn.", "TURN_ALREADY_RUNNING");
    if (!input.containerId) throw new AgentError("Agent work requires an isolated container session.", "CONTAINER_REQUIRED");
    if (!input.prompt.trim()) throw new AgentError("A message is required.", "EMPTY_PROMPT");
    if (input.runtime === "claude" && input.approvalMode !== "approve-all") throw new AgentError("Claude's current headless adapter supports Approve all. Choose Codex or Antigravity for typed approvals.", "UNSUPPORTED_APPROVAL_MODE");
    const controller = new AbortController();
    const router = new ApprovalRouter(input, callbacks, controller.signal);
    const live: LiveTurn = { controller, router };
    this.live.set(input.chatId, live);
    try {
      if (this.options.autoProvision !== false && input.antigravityTransport !== "cli") {
        await callbacks.onEvent({ kind: "status", text: "Preparing container runtime", data: { status: "starting", runtime: input.runtime } });
        await this.provision(input.containerId, input.runtime, { copyHostAuth: this.options.copyHostAuth, hostAuthDir: this.options.hostAuthDir }, controller.signal);
      }
      if (controller.signal.aborted) throw new AgentError("Agent turn interrupted.", "INTERRUPTED");
      const cwd = input.cwd ?? await containerCommand(input.containerId, ["sh", "-c", 'printf "%s" "${ENVMUX_WORKDIR:-/work}"'], { ...this.options, signal: controller.signal });
      const selected = { ...input, cwd };
      let result: TurnResult;
      if (input.runtime === "codex" && input.codexTransport !== "exec") {
        const process = new ContainerProcess(input.containerId, ["codex", "app-server", "--listen", "stdio://"], this.options.dockerEndpoint, this.options.spawnProcess, cwd, input.runtime);
        live.process = process;
        const turn = new CodexTurn(selected, callbacks, process, router, controller.signal); live.codex = turn;
        result = await turn.run();
      } else if (input.runtime === "antigravity") {
        const capability = (await this.availability(input.containerId)).find((entry) => entry.kind === "antigravity")!;
        if (capability.interactiveApprovals && input.antigravityTransport !== "cli") result = await this.runAntigravitySdk(selected, callbacks, live);
        else {
          if (input.approvalMode !== "approve-all") throw new AgentError("The Antigravity SDK is required for rules/manual approvals.", "UNSUPPORTED_APPROVAL_MODE");
          result = await this.runCli(selected, callbacks, live);
        }
      } else result = await this.runCli(selected, callbacks, live);
      await callbacks.onEvent({ kind: "status", text: "Agent turn completed", data: { status: "idle", threadId: result.threadId, stopReason: result.stopReason } });
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const agentStarted = input.runtime === "codex" && input.codexTransport !== "exec" ? live.codex?.executionMayHaveStarted === true : !!live.process;
      Object.assign(failure, { agentStarted, executionEnded: !agentStarted || (failure instanceof AgentError && failure.executionEnded) });
      await callbacks.onEvent({ kind: "error", text: failure.message, data: { code: failure instanceof AgentError ? failure.code : "AGENT_RUNTIME_ERROR", interrupted: controller.signal.aborted, agentStarted, executionEnded: (failure as AgentError).executionEnded, phase: agentStarted ? "execution" : "preparation" } });
      throw failure;
    } finally {
      controller.abort(); await router.cancel(); await live.process?.stop();
      if (this.live.get(input.chatId) === live) this.live.delete(input.chatId);
    }
  }
  async interrupt(chatId: string): Promise<boolean> {
    const live = this.live.get(chatId);
    if (!live) return false;
    // Fence callbacks immediately. Native interruption is best effort; process-group teardown
    // also covers runtimes and tools which are waiting on an input callback.
    live.controller.abort(); await live.router.cancel(); await live.process?.stop();
    return true;
  }
  async shutdown(): Promise<void> { await Promise.allSettled([...this.live.keys()].map((id) => this.interrupt(id))); }

  private async runAntigravitySdk(input: TurnInput, callbacks: TurnCallbacks, live: LiveTurn): Promise<TurnResult> {
    const process = new ContainerProcess(input.containerId, ["/opt/enoughfactory/antigravity/bin/python", "-u", "/opt/enoughfactory/agents/antigravity_bridge.py"], this.options.dockerEndpoint, this.options.spawnProcess, input.cwd, input.runtime);
    live.process = process;
    return new Promise<TurnResult>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => { if (settled) return; settled = true; reject(error); };
      live.controller.signal.addEventListener("abort", () => fail(new AgentError("Agent turn interrupted.", "INTERRUPTED")), { once: true });
      process.lines((line) => {
        let message: Record<string, any>;
        try { message = JSON.parse(line); } catch { fail(new AgentError("Antigravity emitted malformed bridge output.", "PROTOCOL_ERROR")); return; }
        void (async () => {
          if (settled || live.controller.signal.aborted) return;
          if (message.type === "event") {
            const event = message.event ?? {};
            if (event.kind === "text-delta") await callbacks.onEvent({ kind: "message", role: "assistant", text: event.text ?? "", data: { delta: true, itemId: message.turnId } });
            else if (event.kind === "tool-call" || event.kind === "tool-result") await callbacks.onEvent({ kind: "tool", text: event.tool?.name ?? event.kind, data: event });
            else await callbacks.onEvent({ kind: "status", text: event.kind === "thread-started" ? "Agent running" : undefined, data: { ...event, status: event.kind === "interrupted" ? "interrupted" : "running" } });
          }
          else if (message.type === "approval") {
            const allowed = await live.router.decide(message.action, message.arguments, message.description ?? message.action, message.turnId, message.id);
            if (!settled && !live.controller.signal.aborted) process.write({ type: "approval-response", id: message.id, approved: allowed });
          } else if (message.type === "question") {
            if (!callbacks.onQuestion) { fail(new AgentError("The agent needs an answer before it can continue.", "AGENT_INPUT_REQUIRED")); return; }
            const questions = (Array.isArray(message.questions) ? message.questions : []).map((question: Record<string, unknown>, index: number) => ({ ...question, id: typeof question.id === "string" ? question.id : String(index) }));
            await callbacks.onEvent({ kind: "status", text: "Agent needs input", data: { status: "waiting", requestId: message.id, questions } });
            const answers = await callbacks.onQuestion({ id: message.id, questions, chatId: input.chatId }, live.controller.signal);
            // The public input port is shared with Codex. SDK questions require ordered
            // freeform responses, rather than Codex's map keyed by question identity.
            const ordered = questions.map((question: { id: string }) => {
              const answer = answers[question.id];
              if (!answer?.answers?.length) throw new AgentError("The SDK question did not receive an answer.", "AGENT_INPUT_REQUIRED");
              return { freeform_response: answer.answers.join("\n"), skipped: false };
            });
            if (!settled && !live.controller.signal.aborted) process.write({ type: "question-response", id: message.id, answers: ordered });
          } else if (message.type === "result") {
            await callbacks.onEvent({ kind: "message", role: "assistant", text: message.text ?? "", data: { final: true, itemId: message.turnId } });
            settled = true; resolve({ threadId: message.threadId, text: message.text ?? "", usage: message.usage, stopReason: message.stopReason });
          }
          else if (message.type === "error") fail(new AgentError(message.message ?? "Antigravity failed.", message.code ?? "AGENT_TURN_FAILED"));
        })().catch((error: Error) => fail(error));
      });
      void process.exit.then(({ code }) => { if (!settled) fail(new AgentError(process.errorText() || `Antigravity disconnected before completing the turn (${code}).`, "RUNTIME_DISCONNECTED")); }, fail);
      process.write({ type: "start", prompt: input.prompt, threadId: input.threadId, approvalMode: input.approvalMode, model: input.model, systemInstructions: input.systemInstructions, saveDir: "/root/.enoughfactory/antigravity/sessions" });
    });
  }
  private async runCli(input: TurnInput, callbacks: TurnCallbacks, live: LiveTurn): Promise<TurnResult> {
    if (input.approvalMode !== "approve-all") throw new AgentError("This CLI route has no bidirectional approval channel.", "UNSUPPORTED_APPROVAL_MODE");
    const prompt = input.systemInstructions ? `${input.systemInstructions}\n\n${input.prompt}` : input.prompt;
    const args = input.runtime === "codex"
      ? ["codex", "exec", ...(input.threadId ? ["resume", input.threadId] : []), "--json", "--dangerously-bypass-approvals-and-sandbox", ...(input.model ? ["--model", input.model] : []), "-"]
      : input.runtime === "claude" ? ["claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", ...(input.threadId ? ["--resume", input.threadId] : []), ...(input.model ? ["--model", input.model] : []), prompt]
      : ["agy", "-p", prompt, "--output-format", "stream-json", "--dangerously-skip-permissions", ...(input.threadId ? ["--conversation", input.threadId] : []), ...(input.model ? ["--model", input.model] : [])];
    const process = new ContainerProcess(input.containerId, args, this.options.dockerEndpoint, this.options.spawnProcess, input.cwd, input.runtime); live.process = process;
    let threadId = input.threadId, text = "", usage: Record<string, unknown> | undefined, runtimeError: string | undefined;
    let eventChain = Promise.resolve();
    const emit = (event: Parameters<TurnCallbacks["onEvent"]>[0]) => { eventChain = eventChain.then(() => callbacks.onEvent(event)); };
    process.lines((line) => {
      let record: Record<string, any>;
      try { record = JSON.parse(line); } catch { emit({ kind: "tool", text: line, data: { stream: "stdout" } }); return; }
      if (input.runtime === "antigravity") {
        if (record.event === "init") { threadId = record.conversation_id; emit({ kind: "status", text: "Agent running", data: { status: "running", threadId } }); }
        else if (record.event === "step_update") {
          const step = record.step_update ?? {};
          if (step.step_type === "agent_response" && step.text_delta) {
            text += step.text_delta;
            emit({ kind: "message", role: "assistant", text: step.text_delta, data: { delta: true, itemId: `step-${step.step_index}` } });
          } else if (step.step_type === "tool") emit({ kind: "tool", text: step.tool_name, data: step });
        } else if (record.event === "result") {
          const result = record.result ?? {};
          threadId = result.conversation_id ?? threadId; usage = result.usage; text = result.response ?? text;
          if (result.status !== "SUCCESS") runtimeError = result.error ?? `Antigravity stopped with ${result.status}.`;
          emit({ kind: "message", role: "assistant", text, data: { final: true, itemId: "response" } });
          emit({ kind: "usage", data: { usage } });
        }
        return;
      }
      if (record.type === "thread.started") threadId = record.thread_id;
      else if (record.type === "system" && record.subtype === "init") threadId = record.session_id;
      else if (record.type === "item.completed" && record.item?.type === "agent_message") {
        const message = record.item.text ?? ""; text += `${text ? "\n\n" : ""}${message}`; emit({ kind: "message", role: "assistant", text: message, data: { final: true, itemId: record.item.id } });
      } else if (record.type === "assistant") {
        const content = record.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text") { text += `${text ? "\n\n" : ""}${block.text}`; emit({ kind: "message", role: "assistant", text: block.text }); }
          else emit({ kind: "tool", text: block.name ?? block.type, data: block });
        }
      } else if (record.type === "result") {
        threadId = record.session_id ?? threadId; usage = record.usage;
        if (record.is_error) runtimeError = record.result ?? record.errors?.join("\n") ?? "Agent execution failed.";
        if (record.result && !text) { text = record.result; emit({ kind: "message", role: "assistant", text }); }
      } else if (record.type === "turn.completed") { usage = record.usage; emit({ kind: "usage", data: { usage } }); }
      else if (record.type === "error" || record.type === "turn.failed") { runtimeError = record.message ?? record.error?.message ?? "Agent execution failed."; emit({ kind: "error", text: runtimeError }); }
      else emit({ kind: "tool", text: record.item?.command ?? record.type, data: record });
    });
    if (input.runtime === "codex") process.write(prompt);
    process.end();
    const exit = await process.exit; await eventChain;
    if (live.controller.signal.aborted) throw new AgentError("Agent turn interrupted.", "INTERRUPTED");
    if (exit.code !== 0 || runtimeError) throw new AgentError(runtimeError ?? process.errorText() ?? `Agent exited with ${exit.code}.`, "AGENT_TURN_FAILED");
    return { text, threadId, usage, stopReason: "completed" };
  }
}
