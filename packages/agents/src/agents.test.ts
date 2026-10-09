import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalRouter, matchPolicyRule } from "./policy.ts";
import { codexApprovalResponse, CodexTurn, type RpcMessage } from "./codex.ts";
import type { AgentEvent, TurnInput } from "./types.ts";
import { ContainerProcess, containerCommand } from "./process.ts";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgentManager } from "./index.ts";

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
test("a preparation failure records that the task provider never started", async () => {
  let starts = 0;
  const spawnProcess = (() => {
    starts++;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { child.stderr.write("container unavailable"); child.emit("close", 1); });
    return child;
  }) as unknown as typeof spawn;
  const manager = new AgentManager({ dockerEndpoint: { cliPath: "/managed/docker", host: "unix:///managed/docker.sock", configDirectory: "/managed/config" }, spawnProcess });
  const events: AgentEvent[] = [];
  await assert.rejects(manager.runTurn(input, { onEvent: event => { events.push(event); }, onApproval: async () => true }), error => {
    assert.equal((error as Error & { agentStarted?: boolean }).agentStarted, false);
    assert.equal((error as Error & { executionEnded?: boolean }).executionEnded, true);
    return true;
  });
  assert.equal(starts, 1, "Only the preparation query may launch; never a task provider or replacement");
  assert.equal(events.at(-1)?.data?.phase, "preparation");
  assert.equal(events.at(-1)?.data?.agentStarted, false);
});

test('only a terminal Codex provider response proves a failed turn ended', async () => {
  for (const terminalResponse of [true, false]) {
    let receive!: (line: string) => void, close!: (value: { code: number }) => void;
    const process = {
      lines(callback: (line: string) => void) { receive = callback; },
      exit: new Promise<{ code: number }>(resolve => { close = resolve; }), errorText: () => 'Transport closed',
      write(message: RpcMessage) {
        if (message.id === undefined) return;
        const result = message.method === 'thread/start' ? { thread: { id: 'thread' } } : message.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
        queueMicrotask(() => {
          receive(JSON.stringify({ id: message.id, result }));
          if (message.method === 'turn/start') {
            if (terminalResponse) receive(JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'Task failed' } } } }));
            else close({ code: 1 });
          }
        });
      },
    } as unknown as ContainerProcess;
    const callbacks = { onEvent: () => {}, onApproval: async () => true };
    const controller = new AbortController(), router = new ApprovalRouter(input, callbacks, controller.signal);
    await assert.rejects(new CodexTurn(input, callbacks, process, router, controller.signal).run(), error => {
      assert.equal((error as { executionEnded?: boolean }).executionEnded, terminalResponse);
      assert.equal((error as { code?: string }).code, terminalResponse ? 'AGENT_TURN_FAILED' : 'RUNTIME_DISCONNECTED');
      return true;
    });
  }
});

function terminalNotificationTurn(onEvent: (event: AgentEvent) => void | Promise<void>) {
  let receive!: (line: string) => void, admitted!: () => void;
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  const process = {
    lines(callback: (line: string) => void) { receive = callback; },
    exit: new Promise<{ code: number }>(() => {}), errorText: () => '',
    write(message: RpcMessage) {
      if (message.id === undefined) return;
      const result = message.method === 'thread/start' ? { thread: { id: 'thread' } } : message.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
      queueMicrotask(() => {
        receive(JSON.stringify({ id: message.id, result }));
        if (message.method === 'turn/start') {
          receive(JSON.stringify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } }));
          admitted();
        }
      });
    },
  } as unknown as ContainerProcess;
  const controller = new AbortController(), callbacks = { onEvent, onApproval: async () => true };
  const turn = new CodexTurn(input, callbacks, process, new ApprovalRouter(input, callbacks, controller.signal), controller.signal);
  return { ready, result: turn.run(), notify(method: string, params: Record<string, unknown>) { receive(JSON.stringify({ method, params })); } };
}

test('terminal interactions retain exact poll and Ctrl-C input with original ownership before genuine command completion', async () => {
  const events: AgentEvent[] = [], f = terminalNotificationTurn(event => {
    events.push(event);
    if (event.kind === 'status') f.notify('item/commandExecution/terminalInteraction', { threadId: 'thread', turnId: 'turn', itemId: 'server', processId: '86613', stdin: 'before turn admission' });
  });
  f.notify('item/commandExecution/terminalInteraction', { threadId: 'thread', turnId: 'turn', itemId: 'server', processId: '86613', stdin: 'before thread admission' });
  await f.ready;
  const interaction = { threadId: 'thread', turnId: 'turn', itemId: 'server', processId: '86613', stdin: '' };
  f.notify('item/started', { threadId: 'thread', turnId: 'turn', item: { id: 'server', type: 'commandExecution', command: 'node server.cjs', processId: '86613', status: 'inProgress' } });
  f.notify('item/commandExecution/terminalInteraction', interaction);
  f.notify('item/commandExecution/terminalInteraction', { ...interaction, threadId: 'foreign-thread', stdin: 'foreign' });
  f.notify('item/commandExecution/terminalInteraction', { ...interaction, turnId: 'retired-turn', stdin: 'retired' });
  f.notify('item/commandExecution/terminalInteraction', { ...interaction, stdin: '\u0003' });
  const completed = { id: 'server', type: 'commandExecution', command: 'node server.cjs', processId: '86613', status: 'completed', exitCode: 0, aggregatedOutput: 'Server ready\nShutdown complete\n' };
  f.notify('item/completed', { threadId: 'thread', turnId: 'turn', item: completed });
  f.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  assert.equal((await f.result).stopReason, 'completed');
  const original = events.filter(event => event.data?.method === 'item/commandExecution/terminalInteraction');
  assert.deepEqual(original.map(event => event.data), [{ method: 'item/commandExecution/terminalInteraction', ...interaction }, { method: 'item/commandExecution/terminalInteraction', ...interaction, stdin: '\u0003' }]);
  assert.ok(original.every(event => event.kind === 'tool' && event.data?.status === undefined && event.data?.exitCode === undefined && event.data?.result === undefined));
  const completion = events.find(event => event.data?.method === 'item/completed');
  assert.deepEqual(completion?.data?.item, completed, 'Completion is independently reported by the provider, not inferred from Ctrl-C');
  assert.ok(events.indexOf(original[1]!) < events.indexOf(completion!));
  f.notify('item/commandExecution/terminalInteraction', { ...interaction, stdin: 'after completion' });
  await Promise.resolve();
  assert.equal(events.filter(event => event.data?.method === 'item/commandExecution/terminalInteraction').length, 2);
});

test('terminal interactions arriving during completed-turn persistence drain cannot enter its original event prefix', async () => {
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; }), persist = new Promise<void>(resolve => { release = resolve; });
  const events: AgentEvent[] = [], f = terminalNotificationTurn(async event => {
    if (event.data?.method === 'item/commandExecution/terminalInteraction') { entered(); await persist; }
    events.push(event);
  });
  await f.ready;
  const interaction = { threadId: 'thread', turnId: 'turn', itemId: 'server', processId: '86613', stdin: '\u0003' };
  f.notify('item/commandExecution/terminalInteraction', interaction); await held;
  f.notify('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  f.notify('item/commandExecution/terminalInteraction', { ...interaction, stdin: 'late input' });
  release(); await f.result;
  assert.deepEqual(events.filter(event => event.kind === 'tool').map(event => event.data), [{ method: 'item/commandExecution/terminalInteraction', ...interaction }]);
});

test('malformed terminal interactions cannot create typed input or completed execution evidence', async () => {
  for (const params of [
    { threadId: 'thread', turnId: 'turn', itemId: 'server', processId: '86613' },
    { threadId: 'thread', turnId: 'turn', itemId: 'server', processId: 86613, stdin: '\u0003' },
    { threadId: 'thread', turnId: 'turn', itemId: 'server', processId: '86613', stdin: null },
  ]) {
    const events: AgentEvent[] = [], f = terminalNotificationTurn(event => { events.push(event); });
    await f.ready;
    const rejected = assert.rejects(f.result, error => (error as { code?: string; executionEnded?: boolean }).code === 'PROTOCOL_ERROR' && (error as { executionEnded?: boolean }).executionEnded === false);
    f.notify('item/commandExecution/terminalInteraction', params); await rejected;
    assert.equal(events.some(event => event.kind === 'tool'), false);
  }
});

test('a nonzero CLI transport exit cannot masquerade as confirmed provider completion', async () => {
  const spawnProcess = (() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
    queueMicrotask(() => { child.stderr.write('Docker transport disconnected'); child.emit('close', 1); });
    return child;
  }) as unknown as typeof spawn;
  const manager = new AgentManager({ autoProvision: false, dockerEndpoint: { cliPath: '/managed/docker', host: 'unix:///managed/docker.sock', configDirectory: '/managed/config' }, spawnProcess });
  await assert.rejects(manager.runTurn({ ...input, cwd: '/work', codexTransport: 'exec' }, { onEvent: () => {}, onApproval: async () => true }), error => {
    assert.equal((error as { agentStarted?: boolean }).agentStarted, true);
    assert.equal((error as { executionEnded?: boolean }).executionEnded, false);
    return true;
  });
});

test('Codex startup closure is conclusively not started while sent turn requests stay uncertain', async () => {
  for (const boundary of ['initialize-closed', 'turn-sent-no-ack', 'turn-write-error'] as const) {
    const requests: string[] = [], events: AgentEvent[] = [];
    const spawnProcess = ((_command: string, _args: readonly string[], options: { stdio?: string }) => {
      const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean };
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
      if (options.stdio === 'ignore') { queueMicrotask(() => child.emit('close', 0)); return child; }
      child.stdin.on('data', (bytes: Buffer) => {
        const message = JSON.parse(bytes.toString()) as RpcMessage;
        if (message.id === undefined) return;
        requests.push(message.method!);
        if (message.method === 'initialize' && boundary === 'initialize-closed') {
          // Classification must use the protocol boundary, independent of stderr text.
          queueMicrotask(() => { child.stderr.write('An opaque loader failure'); child.emit('close', 1); });
        } else if (message.method === 'turn/start') {
          if (boundary === 'turn-write-error') throw new Error('An arbitrary write failure');
          queueMicrotask(() => child.emit('close', 1));
        } else queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: message.method === 'thread/start' ? { thread: { id: 'thread' } } : {} })}\n`));
      });
      return child;
    }) as unknown as typeof spawn;
    const manager = new AgentManager({ autoProvision: false, dockerEndpoint: { cliPath: '/managed/docker', host: 'unix:///managed/docker.sock', configDirectory: '/managed/config' }, spawnProcess });
    const mayHaveStarted = boundary !== 'initialize-closed';
    await assert.rejects(manager.runTurn({ ...input, cwd: '/work' }, { onEvent: event => { events.push(event); }, onApproval: async () => true }), error => {
      assert.equal((error as { agentStarted?: boolean }).agentStarted, mayHaveStarted, boundary);
      assert.equal((error as { executionEnded?: boolean }).executionEnded, !mayHaveStarted, boundary);
      return true;
    });
    assert.deepEqual(requests, mayHaveStarted ? ['initialize', 'thread/start', 'turn/start'] : ['initialize']);
    assert.equal(events.at(-1)?.data?.agentStarted, mayHaveStarted);
    assert.equal(events.at(-1)?.data?.executionEnded, !mayHaveStarted);
    assert.equal(events.at(-1)?.data?.phase, mayHaveStarted ? 'execution' : 'preparation');
  }
});
