import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalRouter, matchPolicyRule } from "./policy.ts";
import { codexApprovalResponse } from "./codex.ts";
import type { AgentEvent, TurnInput } from "./types.ts";
import { ContainerProcess, containerCommand } from "./process.ts";
import { spawn } from "node:child_process";

const input: TurnInput = { chatId: "chat-a", sessionId: "session-a", containerId: "container-a", runtime: "codex", approvalMode: "approve-all", rules: [], prompt: "Work toward the goal", attemptId: "attempt-a", policyRevision: 3 };
test("Approve all owns the decision without waiting for a UI callback", async () => {
  const events: AgentEvent[] = [];
  let asked = false;
  const router = new ApprovalRouter(input, { onEvent: (event) => { events.push(event); }, onApproval: async () => { asked = true; throw new Error("UI offline"); } }, new AbortController().signal);
  assert.equal(await router.decide("command", { command: "git push" }, "Publish", "turn-a", 4), true);
  assert.equal(asked, false);
  assert.equal((events[0].data?.approval as { status: string }).status, "allowed");
  assert.equal((events[0].data?.approval as { attemptId: string }).attemptId, "attempt-a");
});
test("Rules can deny typed actions without invoking manual input", async () => {
  const rules = [{ id: "publish", tool: "item/commandExecution/*", commandPattern: "git push*", decision: "deny" as const }];
  assert.equal(matchPolicyRule(rules, "item/commandExecution/requestApproval", { command: "git push origin main" })?.id, "publish");
  assert.equal(matchPolicyRule(rules, "item/commandExecution/requestApproval", { command: "git status" }), undefined);
  const router = new ApprovalRouter({ ...input, approvalMode: "rules", rules }, { onEvent: () => {}, onApproval: async () => { throw new Error("unexpected UI"); } }, new AbortController().signal);
  assert.equal(await router.decide("item/commandExecution/requestApproval", { command: "git push" }, "Publish"), false);
});
test("Interruption fences a late manual approval and expires its identity", async () => {
  const controller = new AbortController(); const events: AgentEvent[] = [];
  let accept!: (answer: boolean) => void;
  const router = new ApprovalRouter({ ...input, approvalMode: "manual" }, { onEvent: (event) => { events.push(event); }, onApproval: () => new Promise((resolve) => { accept = resolve; }) }, controller.signal);
  const decision = router.decide("command", { command: "publish" }, "Publish", "turn-a", "runtime-9");
  await Promise.resolve(); controller.abort(); await router.cancel(); accept(true);
  assert.equal(await decision, false);
  assert.equal(events.some((event) => (event.data?.approval as { status?: string })?.status === "allowed"), false);
  assert.equal(events.some((event) => (event.data?.approval as { status?: string })?.status === "expired"), true);
});
test("A native resolved request cannot receive an operator's stale acceptance", async () => {
  const router = new ApprovalRouter({ ...input, approvalMode: "manual" }, { onEvent: () => {}, onApproval: () => new Promise(() => {}) }, new AbortController().signal);
  const pending = router.decide("command", {}, "Run", "turn-a", 99);
  await Promise.resolve(); router.expire(99);
  assert.equal(await pending, false);
});
test("Pinned Codex approvals preserve schema and never activate provider review", () => {
  assert.deepEqual(codexApprovalResponse("item/commandExecution/requestApproval", {}, true), { decision: "accept" });
  assert.deepEqual(codexApprovalResponse("item/fileChange/requestApproval", {}, false), { decision: "decline" });
  const permissions = { network: { enabled: true }, fileSystem: { write: ["/opt"] } };
  assert.deepEqual(codexApprovalResponse("item/permissions/requestApproval", { permissions }, true), { permissions, scope: "turn", strictAutoReview: false });
  assert.deepEqual(codexApprovalResponse("item/permissions/requestApproval", { permissions }, false).permissions, {});
});
test("An unconfigured runtime cannot fall back to a user's Docker context", async () => {
  assert.throws(() => new ContainerProcess("container-a", ["true"]), { code: "MANAGED_RUNTIME_UNCONFIGURED" });
  await assert.rejects(containerCommand("container-a", ["true"]), { code: "MANAGED_RUNTIME_UNCONFIGURED" });
});
test("Provision and credential commands preserve the explicitly selected runtime", async () => {
  const calls: Array<{ command: string; args: string[]; environment: NodeJS.ProcessEnv }> = [];
  const spawnProcess: typeof spawn = ((command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args: [...args], environment: options.env ?? {} });
    return spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end',()=>console.log('selected'));"], { stdio: "pipe" });
  }) as typeof spawn;
  const dockerEndpoint = { cliPath: "/managed/runtime/bin/docker", host: "unix:///managed/runtime/docker.sock", configDirectory: "/managed/runtime/config" };
  assert.equal(await containerCommand("container-a", ["sh", "-s"], { dockerEndpoint, spawnProcess, input: "private payload" }), "selected");
  assert.equal(calls[0].command, dockerEndpoint.cliPath);
  assert.deepEqual(calls[0].args.slice(0, 4), ["--host", dockerEndpoint.host, "--config", dockerEndpoint.configDirectory]);
  assert.equal(calls[0].environment.DOCKER_HOST, dockerEndpoint.host);
  assert.equal(calls[0].environment.DOCKER_CONFIG, dockerEndpoint.configDirectory);
  assert.equal(calls[0].environment.DOCKER_CONTEXT, undefined);
});
