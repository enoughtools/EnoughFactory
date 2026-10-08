import type { RuntimeCapability, RuntimeKind } from "@enoughfactory/contracts";
import { CodexTurn, codexAppServerArguments, codexManagedFeatureArguments } from "./codex.ts";
import { ContainerProcess, containerCommand, checkContainerId, type AgentProcess, type SpawnProcess } from "./process.ts";
import { HostProcess, cancelHostProcess, reconcileHostProcesses, type HostProcessState } from "./host-process.ts";
import { hostCodexAvailability, provisionHostCodex, type HostCodexRuntime } from "./host-provision.ts";
import { prepareHostSession, retireHostSessionState } from "./host-state.ts";
import { codexToolConfiguration, validateToolEnvironment } from "./tool-config.ts";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { ApprovalRouter } from "./policy.ts";
import { availability, copyMinimalAuth, provisionRuntime, releaseCodexPayload, writePrivateFile, type CodexPayloadRelease, type RuntimeOptions } from "./provision.ts";
import { AgentError, type ProvisionOptions, type TurnCallbacks, type TurnInput, type TurnResult } from "./types.ts";

export * from "./types.ts";
export { ApprovalRouter, matchPolicyRule } from "./policy.ts";
export { CODEX_PROTOCOL_VERSION, codexApprovalResponse } from "./codex.ts";
export type { CodexPayloadRelease } from "./provision.ts";
export { prepareAgentToolchain, verifyPreparedAgentToolchain, type PreparedAgentToolchain, type AgentToolchainOptions } from "./toolchain-image.ts";
export { HostProcess, cancelHostProcess, reconcileHostProcesses, type HostProcessState } from "./host-process.ts";
export { provisionHostCodex, hostCodexAvailability, type HostCodexRuntime, type HostProvisionOptions } from "./host-provision.ts";
export { codexToolConfiguration } from "./tool-config.ts";

type ContainerTurnInput = TurnInput & { containerId: string };
interface LiveTurn { containerId?: string; sessionId: string; controller: AbortController; process?: AgentProcess; router: ApprovalRouter; codex?: CodexTurn; }
export interface AgentManagerOptions extends RuntimeOptions {
  autoProvision?: boolean;
  copyHostAuth?: boolean;
  hostAuthDir?: string;
  /** Explicit Factory-owned payload/state directory; never a global provider install. */
  hostRuntimeDir?: string;
  /** Private worker workspace parents. The service also verifies exact session ownership. */
  hostWorkspaceRoots?: string[];
}
export class AgentManager {
  private live = new Map<string, LiveTurn>();
  private provisioning = new Map<string, Promise<RuntimeCapability>>();
  private containerUses = new Map<string, number>();
  private releasing = new Set<string>();
  private hostRetiring = new Set<string>();
  constructor(private options: AgentManagerOptions = {}) {}
  async hostAvailability(signal?: AbortSignal): Promise<RuntimeCapability[]> {
    let runtime: HostCodexRuntime | undefined, details: string | undefined;
    try {
      if (!this.options.hostRuntimeDir || !this.options.hostWorkspaceRoots?.length) details = "Native authoring is not configured for this device.";
      else runtime = await hostCodexAvailability({ runtimeDirectory: this.options.hostRuntimeDir, spawnProcess: this.options.spawnProcess, signal });
    } catch (error) { details = error instanceof Error ? error.message : String(error); }
    return [{ kind: "codex", available: !!runtime, version: runtime?.version, fullAccess: true, interactiveApprovals: !!runtime, resume: !!runtime, details: runtime ? "Pinned Codex in an owned Mac workspace. Same-user full host access; this is not container isolation." : details ?? "Prepare the pinned native Codex runtime." }];
  }
  async provisionHostRuntime(signal?: AbortSignal): Promise<HostCodexRuntime> {
    if (!this.options.hostRuntimeDir || !this.options.hostWorkspaceRoots?.length) throw new AgentError("Native authoring is not configured for this device.", "HOST_EXECUTION_UNCONFIGURED");
    return provisionHostCodex({ runtimeDirectory: this.options.hostRuntimeDir, spawnProcess: this.options.spawnProcess, signal });
  }
  async provisionHost(signal?: AbortSignal): Promise<RuntimeCapability> {
    const runtime = await this.provisionHostRuntime(signal);
    return { kind: "codex", available: true, version: runtime.version, fullAccess: true, interactiveApprovals: true, resume: true, details: "Pinned Codex in an owned Mac workspace. Same-user full host access; this is not container isolation." };
  }
  async hostProcesses(): Promise<HostProcessState[]> {
    if (!this.options.hostRuntimeDir) return [];
    const directory = path.join(this.options.hostRuntimeDir, "sessions");
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name)).flatMap(entry => reconcileHostProcesses(path.join(directory, entry.name, "processes")));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async cancelHostSession(sessionId: string): Promise<void> {
    if (!this.options.hostRuntimeDir) throw new AgentError("Native authoring is not configured for this device.", "HOST_EXECUTION_UNCONFIGURED");
    const directory = path.join(this.options.hostRuntimeDir, "sessions", createHash("sha256").update(sessionId).digest("hex"), "processes");
    for (const record of reconcileHostProcesses(directory)) if (record.state !== "exited") await cancelHostProcess(directory, record.processKey);
  }
  /** Terminal independent verifiers only: the service preserves SQLite chat/CAS first. */
  async retireHostSession(sessionId: string, expectedCwd: string): Promise<boolean> {
    if (!this.options.hostRuntimeDir) return false;
    if (this.hostRetiring.has(sessionId) || [...this.live.values()].some(live => !live.containerId && live.sessionId === sessionId)) throw new AgentError("The host verifier provider still has a live owner.", "HOST_PROCESS_ACTIVE");
    this.hostRetiring.add(sessionId);
    try { return await retireHostSessionState(sessionId, expectedCwd, this.options.hostRuntimeDir); }
    finally { this.hostRetiring.delete(sessionId); }
  }
  private assertNotReleasing(containerId: string): void {
    if (this.releasing.has(containerId)) throw Object.assign(new AgentError("This container is releasing its idle Codex payload. Retry after cleanup completes.", "RUNTIME_CLEANUP_ACTIVE", true), { agentStarted: false });
  }
  private async useContainer<T>(containerId: string, operation: () => Promise<T>): Promise<T> {
    this.assertNotReleasing(containerId);
    this.containerUses.set(containerId, (this.containerUses.get(containerId) ?? 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = this.containerUses.get(containerId)! - 1;
      if (remaining) this.containerUses.set(containerId, remaining); else this.containerUses.delete(containerId);
    }
  }
  /** Fence idle container retirement against provider, credential and provisioning work. */
  async withIdleContainer<T>(containerId:string,operation:()=>Promise<T>):Promise<T> {
    checkContainerId(containerId);this.assertNotReleasing(containerId);
    if(this.containerUses.has(containerId)||[...this.live.values()].some(turn=>turn.containerId===containerId)||[...this.provisioning.keys()].some(key=>key.startsWith(`${containerId}:`)))throw new AgentError('This container still has an active provider, provisioning or credential operation.','RUNTIME_CLEANUP_ACTIVE',true);
    this.releasing.add(containerId);
    try{return await operation();}finally{this.releasing.delete(containerId);}
  }
  availability(containerId: string): Promise<RuntimeCapability[]> { return this.useContainer(containerId, () => availability(containerId, this.options)); }
  async provision(containerId: string, runtime: RuntimeKind, provision: ProvisionOptions = {}, signal?: AbortSignal): Promise<RuntimeCapability> {
    return this.useContainer(containerId, async () => {
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
    });
  }
  async connectApiKey(containerId: string, runtime: RuntimeKind, apiKey: string): Promise<void> {
    if (!apiKey.trim() || apiKey.includes("\0")) throw new AgentError("A provider key is required.", "INVALID_CREDENTIAL");
    return this.useContainer(containerId, async () => {
      if (runtime === "codex") {
        await this.provision(containerId, runtime);
        await containerCommand(containerId, ["sh", "-c", "export PATH=/opt/enoughfactory/node/bin:$PATH; export CODEX_HOME=/root/.codex; exec codex login --with-api-key"], { ...this.options, input: apiKey });
      } else {
        const key = runtime === "claude" ? "ANTHROPIC_API_KEY" : "GEMINI_API_KEY";
        const shellValue = `'${apiKey.replace(/'/g, `'"'"'`)}'`;
        await writePrivateFile(containerId, `/root/.enoughfactory/providers/${runtime}.env`, `export ${key}=${shellValue}\n`, this.options);
      }
    });
  }
  async releaseCodexPayload(containerId: string): Promise<CodexPayloadRelease> {
    checkContainerId(containerId);
    if (this.releasing.has(containerId)) return { status: "deferred", reason: "Codex payload cleanup is already active for this container." };
    if (this.containerUses.has(containerId) || [...this.live.values()].some(turn => turn.containerId === containerId) || [...this.provisioning.keys()].some(key => key.startsWith(`${containerId}:`))) return { status: "deferred", reason: "This container still has an active agent, provisioning or credential operation." };
    this.releasing.add(containerId);
    try { return await releaseCodexPayload(containerId, this.options); }
    finally { this.releasing.delete(containerId); }
  }
  async runTurn(input: TurnInput, callbacks: TurnCallbacks): Promise<TurnResult> {
    if (this.live.has(input.chatId)) throw new AgentError("This conversation already has a live agent turn.", "TURN_ALREADY_RUNNING");
    if (input.executionTarget && !["container", "host-macos"].includes(input.executionTarget)) throw new AgentError("The requested agent execution target is unsupported.", "INVALID_EXECUTION_TARGET");
    if (input.executionTarget === "host-macos") return this.runHostTurn(input, callbacks);
    if (!input.containerId) throw new AgentError("Agent work requires an isolated container session.", "CONTAINER_REQUIRED");
    if (!input.prompt.trim()) throw new AgentError("A message is required.", "EMPTY_PROMPT");
    if (input.runtime === "claude" && input.approvalMode !== "approve-all") throw new AgentError("Claude's current headless adapter supports Approve all. Choose Codex or Antigravity for typed approvals.", "UNSUPPORTED_APPROVAL_MODE");
    this.assertNotReleasing(input.containerId);
    const controller = new AbortController();
    const router = new ApprovalRouter(input, callbacks, controller.signal);
    const live: LiveTurn = { containerId: input.containerId, sessionId: input.sessionId, controller, router };
    this.live.set(input.chatId, live);
    try {
      if (this.options.autoProvision !== false && input.antigravityTransport !== "cli") {
        await callbacks.onEvent({ kind: "status", text: "Preparing container runtime", data: { status: "starting", runtime: input.runtime } });
        await this.provision(input.containerId, input.runtime, { copyHostAuth: this.options.copyHostAuth, hostAuthDir: this.options.hostAuthDir }, controller.signal);
      }
      if (controller.signal.aborted) throw new AgentError("Agent turn interrupted.", "INTERRUPTED");
      const cwd = input.cwd ?? await containerCommand(input.containerId, ["sh", "-c", 'printf "%s" "${ENVMUX_WORKDIR:-/work}"'], { ...this.options, signal: controller.signal });
      const selected: ContainerTurnInput = { ...input, containerId: input.containerId, cwd };
      validateToolEnvironment(input.toolEnvironment);
      if (input.mcpServers && (input.runtime !== "codex" || input.codexTransport === "exec")) throw new AgentError("Inspection tools are currently verified for the Codex app-server adapter.", "UNSUPPORTED_TOOL_RUNTIME");
      if (input.mcpServers) codexToolConfiguration(input.mcpServers); // Validate before dispatch. Private per-thread RPC config avoids shared-container config races.
      let result: TurnResult;
      if (input.runtime === "codex" && input.codexTransport !== "exec") {
        const process = new ContainerProcess(input.containerId, ["codex", ...codexAppServerArguments()], this.options.dockerEndpoint, this.options.spawnProcess, cwd, input.runtime, { environment: input.toolEnvironment });
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

  private async runHostTurn(input: TurnInput, callbacks: TurnCallbacks): Promise<TurnResult> {
    if (!input.prompt.trim()) throw new AgentError("A message is required.", "EMPTY_PROMPT");
    if (input.runtime !== "codex" || input.codexTransport === "exec") throw new AgentError("Native authoring currently supports the pinned Codex app-server adapter.", "UNSUPPORTED_HOST_RUNTIME");
    if (input.containerId) throw new AgentError("A native authoring turn cannot also select a container.", "INVALID_EXECUTION_TARGET");
    if (this.hostRetiring.has(input.sessionId)) throw new AgentError("This terminal verifier provider home is being retired.", "HOST_SESSION_RETIRED");
    if ([...this.live.values()].some(live => !live.containerId && live.sessionId === input.sessionId)) throw new AgentError("This native authoring session already has a live turn.", "TURN_ALREADY_RUNNING");
    if (!this.options.hostRuntimeDir || !this.options.hostWorkspaceRoots?.length) throw new AgentError("Native authoring is not configured for this device.", "HOST_EXECUTION_UNCONFIGURED");
    const controller = new AbortController(), router = new ApprovalRouter(input, callbacks, controller.signal);
    const live: LiveTurn = { sessionId: input.sessionId, controller, router }; this.live.set(input.chatId, live);
    try {
      await callbacks.onEvent({ kind: "status", text: "Preparing native agent runtime", data: { status: "starting", runtime: "codex", executionTarget: "host-macos" } });
      const runtime = this.options.autoProvision === false
        ? await hostCodexAvailability({ runtimeDirectory: this.options.hostRuntimeDir, spawnProcess: this.options.spawnProcess, signal: controller.signal })
        : await this.provisionHostRuntime(controller.signal);
      if (!runtime) throw new AgentError("Prepare the pinned native Codex runtime before authoring.", "RUNTIME_MISSING");
      if (controller.signal.aborted) throw new AgentError("Agent turn interrupted.", "INTERRUPTED");
      const state = await prepareHostSession(input, runtime, { runtimeDirectory: this.options.hostRuntimeDir, workspaceRoots: this.options.hostWorkspaceRoots, copyHostAuth: this.options.copyHostAuth, hostAuthDir: this.options.hostAuthDir });
      if (controller.signal.aborted) throw new AgentError("Agent turn interrupted.", "INTERRUPTED");
      const process = new HostProcess(runtime.nodePath, [runtime.codexPath, ...codexAppServerArguments()], { cwd: state.cwd, environment: state.environment, processDirectory: state.processDirectory, sessionId: input.sessionId, spawnProcess: this.options.spawnProcess });
      live.process = process;
      await process.ready;
      const turn = new CodexTurn({ ...input, cwd: state.cwd }, callbacks, process, router, controller.signal); live.codex = turn;
      const result = await turn.run();
      await callbacks.onEvent({ kind: "status", text: "Agent turn completed", data: { status: "idle", threadId: result.threadId, stopReason: result.stopReason, executionTarget: "host-macos" } });
      return result;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error)), agentStarted = live.codex?.executionMayHaveStarted === true;
      Object.assign(failure, { agentStarted, executionEnded: !agentStarted || failure instanceof AgentError && failure.executionEnded });
      await callbacks.onEvent({ kind: "error", text: failure.message, data: { code: failure instanceof AgentError ? failure.code : "AGENT_RUNTIME_ERROR", interrupted: controller.signal.aborted, agentStarted, executionEnded: (failure as AgentError).executionEnded, phase: agentStarted ? "execution" : "preparation", executionTarget: "host-macos" } });
      throw failure;
    } finally {
      controller.abort(); await router.cancel();
      try { await live.process?.stop(); }
      catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        Object.assign(failure, { agentStarted: live.codex?.executionMayHaveStarted === true, executionEnded: false });
        throw failure;
      } finally { if (this.live.get(input.chatId) === live) this.live.delete(input.chatId); }
    }
  }

  private async runAntigravitySdk(input: ContainerTurnInput, callbacks: TurnCallbacks, live: LiveTurn): Promise<TurnResult> {
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
  private async runCli(input: ContainerTurnInput, callbacks: TurnCallbacks, live: LiveTurn): Promise<TurnResult> {
    if (input.approvalMode !== "approve-all") throw new AgentError("This CLI route has no bidirectional approval channel.", "UNSUPPORTED_APPROVAL_MODE");
    const prompt = input.systemInstructions ? `${input.systemInstructions}\n\n${input.prompt}` : input.prompt;
    const args = input.runtime === "codex"
      ? ["codex", ...codexManagedFeatureArguments(), "exec", ...(input.threadId ? ["resume", input.threadId] : []), "--json", "--dangerously-bypass-approvals-and-sandbox", ...(input.model ? ["--model", input.model] : []), "-"]
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
