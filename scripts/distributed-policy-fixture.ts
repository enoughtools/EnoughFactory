import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PeerManager } from '../packages/peers/src/index.ts';
import { ApprovalRouter } from '../packages/agents/src/policy.ts';
import { codexApprovalResponse } from '../packages/agents/src/codex.ts';
import type { AgentEvent, TurnInput } from '../packages/agents/src/types.ts';
import type { Approval, PolicyRule } from '../packages/contracts/src/index.ts';

/** This exercises typed callback plumbing, not requests emitted by a real model. */
export const POLICY_FIXTURE_SCOPE = 'Deterministic typed Codex callback fixture over authenticated native WebRTC using production ApprovalRouter and codexApprovalResponse. No model turn or native-emitted approval request is exercised.';

export interface PolicyFixtureBinding {
  chatId: string;
  sessionId: string;
  containerId: string;
  attemptId: string;
  turnId: string;
  policyRevision: number;
}
export interface PolicyFixtureBody {
  name: 'command' | 'file' | 'permissions';
  binding: PolicyFixtureBinding;
  request: { id: string | number; method: string; params: Record<string, unknown> };
}
export interface PolicyFixtureResult {
  name: PolicyFixtureBody['name'];
  allowed: boolean;
  response: { id: string | number; result: Record<string, unknown> };
  approval: Approval;
  nativeId: string | number;
  ruleId: string;
  assertions: { automatic: true; requestIdentity: true; attemptBinding: true; policyRevision: true; exactMapping: true };
  scope: string;
}

const methods = {
  command: 'item/commandExecution/requestApproval',
  file: 'item/fileChange/requestApproval',
  permissions: 'item/permissions/requestApproval',
} as const;
const permissions = { network: { enabled: true }, fileSystem: { write: ['/workspace'] } };
const baseBinding: PolicyFixtureBinding = {
  chatId: 'policy-fixture-chat', sessionId: 'policy-fixture-session', containerId: 'policy-fixture-container',
  attemptId: 'policy-fixture-attempt', turnId: 'policy-fixture-turn', policyRevision: 37,
};

export const POLICY_FIXTURE_CASES: PolicyFixtureBody[] = [
  { name: 'command', binding: { ...baseBinding }, request: { id: 417, method: methods.command,
    params: { threadId: 'policy-fixture-thread', turnId: baseBinding.turnId, itemId: 'policy-fixture-command', command: 'git status --short', cwd: '/workspace' } } },
  { name: 'file', binding: { ...baseBinding }, request: { id: 'policy-fixture-file-42', method: methods.file,
    params: { threadId: 'policy-fixture-thread', turnId: baseBinding.turnId, itemId: 'policy-fixture-file', reason: 'Apply deterministic fixture changes', grantRoot: '/workspace' } } },
  { name: 'permissions', binding: { ...baseBinding }, request: { id: 419, method: methods.permissions,
    params: { threadId: 'policy-fixture-thread', turnId: baseBinding.turnId, itemId: 'policy-fixture-permissions', permissions } } },
];

const rules: PolicyRule[] = [
  { id: 'fixture-command-allow', tool: methods.command, commandPattern: 'git status --short', decision: 'allow' },
  { id: 'fixture-file-deny', tool: methods.file, decision: 'deny' },
  { id: 'fixture-permissions-allow', tool: methods.permissions, decision: 'allow' },
];
const expectedResults: Record<PolicyFixtureBody['name'], Record<string, unknown>> = {
  command: { decision: 'accept' },
  file: { decision: 'decline' },
  permissions: { permissions, scope: 'turn', strictAutoReview: false },
};

function validateBody(value: unknown): PolicyFixtureBody {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'A typed fixture body is required.');
  const body = value as PolicyFixtureBody;
  const sample = POLICY_FIXTURE_CASES.find(item => item.name === body.name);
  assert.ok(sample, 'Unknown deterministic policy fixture.');
  assert.deepEqual(body.request, sample.request, 'The callback must match its deterministic typed request.');
  assert.ok(body.binding && typeof body.binding === 'object', 'The callback needs an attempt binding.');
  for (const field of ['chatId', 'sessionId', 'containerId', 'attemptId', 'turnId'] as const) {
    assert.ok(typeof body.binding[field] === 'string' && body.binding[field].length > 0 && body.binding[field].length <= 256, `Invalid ${field} binding.`);
  }
  assert.equal(body.binding.turnId, body.request.params.turnId, 'The runtime turn and bound turn must match.');
  assert.ok(Number.isSafeInteger(body.binding.policyRevision) && body.binding.policyRevision > 0, 'A positive policy revision is required.');
  return body;
}

/** Mount only in a disposable verification coordinator, never the product API. */
export async function handlePolicyFixture(value: unknown): Promise<PolicyFixtureResult> {
  const body = validateBody(value);
  const events: AgentEvent[] = [];
  let manualCalls = 0;
  const controller = new AbortController();
  const input: TurnInput = {
    ...body.binding, runtime: 'codex', approvalMode: 'rules', rules,
    prompt: 'Deterministic callback fixture; no agent process is launched.',
  };
  const router = new ApprovalRouter(input, {
    onEvent(event) { events.push(event); },
    async onApproval() { manualCalls++; throw new Error('The deterministic fixture must resolve through Enough rules without a UI.'); },
  }, controller.signal);
  try {
    const allowed = await router.decide(body.request.method, body.request.params, `Deterministic ${body.name} fixture`, body.binding.turnId, body.request.id);
    assert.equal(manualCalls, 0, 'The policy must decide without waiting for a manual callback.');
    assert.equal(allowed, body.name !== 'file');
    assert.equal(events.length, 1, 'Exactly one automatic policy decision must be recorded.');
    const event = events[0];
    assert.equal(event.kind, 'approval');
    const approval = event.data?.approval as Approval;
    assert.ok(approval && typeof approval.id === 'string' && approval.id.length > 0);
    assert.equal(approval.status, allowed ? 'allowed' : 'denied');
    assert.equal(approval.runtime, 'codex');
    assert.equal(approval.action, body.request.method);
    assert.deepEqual(approval.arguments, body.request.params);
    for (const field of ['chatId', 'sessionId', 'attemptId', 'turnId', 'policyRevision'] as const) {
      assert.equal(approval[field], body.binding[field], `Approval lost its ${field} binding.`);
    }
    assert.equal(event.data?.nativeId, body.request.id);
    const ruleId = `fixture-${body.name === 'file' ? 'file-deny' : `${body.name}-allow`}`;
    assert.equal(event.data?.ruleId, ruleId);
    const response = { id: body.request.id, result: codexApprovalResponse(body.request.method, body.request.params, allowed) };
    assert.deepEqual(response.result, expectedResults[body.name]);
    return {
      name: body.name, allowed, response, approval, nativeId: body.request.id, ruleId,
      assertions: { automatic: true, requestIdentity: true, attemptBinding: true, policyRevision: true, exactMapping: true },
      scope: POLICY_FIXTURE_SCOPE,
    };
  } finally { controller.abort(); await router.cancel(); }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing ${name}.`);
  return value;
}
async function privateInvitation(file: string): Promise<string> {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'The invitation must be a private regular file.');
  assert.equal(info.mode & 0o077, 0, 'The invitation must not be group/world readable.');
  if (typeof process.getuid === 'function') assert.equal(info.uid, process.getuid(), 'The invitation must belong to the worker user.');
  assert.ok(info.size > 0 && info.size <= 128 * 1024, 'Invalid invitation file size.');
  const text = (await readFile(file, 'utf8')).trim();
  if (!text.startsWith('{')) return text;
  const record = JSON.parse(text) as { code?: unknown; url?: unknown; invite?: unknown };
  const invitation = record.code ?? record.url ?? record.invite;
  assert.ok(typeof invitation === 'string' && invitation.length > 0, 'The private file contains no invitation.');
  return invitation;
}

/** Runs in the native Linux guest with the bundled Node and node-datachannel. */
export async function runPolicyWorker(): Promise<Record<string, unknown>> {
  const dataDir = resolve(requiredEnvironment('ENOUGHFACTORY_POLICY_DATA_DIR'));
  const invitation = await privateInvitation(resolve(requiredEnvironment('ENOUGHFACTORY_POLICY_INVITATION_FILE')));
  const timeout = Number(process.env.ENOUGHFACTORY_POLICY_TIMEOUT_MS || 60_000);
  assert.ok(Number.isFinite(timeout) && timeout >= 1_000 && timeout <= 120_000, 'Invalid bounded worker timeout.');
  const peers = await PeerManager.create({
    dataDir, name: 'Distributed policy fixture worker', signalingUrl: process.env.ENOUGHFACTORY_POLICY_SIGNALING_URL,
    transport: 'webrtc', relayFallback: false,
  });
  try {
    await peers.start();
    const coordinator = await peers.pair(invitation);
    const deadline = Date.now() + timeout;
    let connectionInfo: ReturnType<PeerManager['connectionInfo']>;
    while (Date.now() < deadline) {
      try { connectionInfo = peers.connectionInfo(coordinator.id); } catch { connectionInfo = undefined; }
      if (peers.devices().some(device => device.id === coordinator.id && device.online) && connectionInfo?.transport === 'webrtc') break;
      await sleep(100);
    }
    assert.equal(connectionInfo?.transport, 'webrtc', 'The policy fixture requires a real native WebRTC connection.');
    assert.ok(connectionInfo?.localType && connectionInfo.remoteType, 'The native RTC candidate pair must be observable.');
    const results: PolicyFixtureResult[] = [];
    for (const body of POLICY_FIXTURE_CASES) {
      const rpc = await peers.request(coordinator.id, { method: 'POST', path: '/fixture/policy', body }, Math.min(timeout, 30_000));
      assert.equal(rpc.status, 200, 'The coordinator rejected the typed policy fixture.');
      const result = rpc.body as PolicyFixtureResult;
      assert.equal(result.name, body.name);
      assert.equal(result.allowed, body.name !== 'file');
      assert.deepEqual(result.response, { id: body.request.id, result: expectedResults[body.name] });
      assert.equal(result.nativeId, body.request.id);
      assert.ok(typeof result.approval.id === 'string' && result.approval.id.length > 0, 'The response must carry its Enough approval identity.');
      assert.equal(result.approval.runtime, 'codex');
      assert.equal(result.approval.action, body.request.method);
      assert.deepEqual(result.approval.arguments, body.request.params);
      assert.equal(result.approval.status, result.allowed ? 'allowed' : 'denied');
      for (const field of ['chatId', 'sessionId', 'attemptId', 'turnId', 'policyRevision'] as const) assert.equal(result.approval[field], body.binding[field]);
      assert.equal(result.ruleId, `fixture-${body.name === 'file' ? 'file-deny' : `${body.name}-allow`}`);
      assert.deepEqual(result.assertions, { automatic: true, requestIdentity: true, attemptBinding: true, policyRevision: true, exactMapping: true });
      assert.equal(result.scope, POLICY_FIXTURE_SCOPE);
      results.push(result);
    }
    assert.equal(new Set(results.map(result => result.approval.id)).size, results.length, 'Each request needs its own Enough approval identity.');
    return {
      ok: true, kind: 'distributed-policy-fixture', verifiedAt: new Date().toISOString(),
      workerId: peers.localDevice.id, coordinatorId: coordinator.id, connectionInfo,
      cases: results, scope: POLICY_FIXTURE_SCOPE,
    };
  } finally { await peers.stop(); }
}

// Environment guard works for both imported TS and a guest's bundled CJS file.
if (process.env.ENOUGHFACTORY_POLICY_WORKER === '1') {
  void runPolicyWorker().then(receipt => {
    process.stdout.write(JSON.stringify(receipt) + '\n', () => process.exit(0));
  }, () => {
    // Pairing inputs, runtime errors and private paths never enter the receipt.
    process.stdout.write(JSON.stringify({ ok: false, kind: 'distributed-policy-fixture', error: 'POLICY_FIXTURE_FAILED', scope: POLICY_FIXTURE_SCOPE }) + '\n', () => process.exit(1));
  });
}
