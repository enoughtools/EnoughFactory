import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import test, { type TestContext } from 'node:test';
import { createHostInspectionBridge, inspectionMcpHandler, type InspectionMcpBridge, type McpRequest } from './inspection-mcp.ts';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
interface RpcResponse { id: string | number | null; result?: unknown; error?: { code: number; message: string }; }
function client(t: TestContext, bridge: InspectionMcpBridge, environment?: Record<string, string>) {
  assert('command' in bridge.server, 'The private host bridge must use stdio');
  const command = bridge.server.command;
  const child: ChildProcessWithoutNullStreams = spawn(command, bridge.server.args ?? [], { env: { ...process.env, ...bridge.server.env, ...environment }, stdio: 'pipe' });
  child.stdin.on('error', () => {});
  const waiting = new Map<string | number, (response: RpcResponse) => void>();
  const output = createInterface({ input: child.stdout });
  output.on('line', line => {
    const response = JSON.parse(line) as RpcResponse;
    if (response.id !== null) { waiting.get(response.id)?.(response); waiting.delete(response.id); }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  t.after(async () => { child.stdin.end(); child.kill('SIGTERM'); await exited; output.close(); });
  return {
    child, exited, stderr: () => stderr,
    send(request: McpRequest): Promise<RpcResponse> {
      assert(request.id !== undefined && request.id !== null);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(request.id!); reject(new Error('MCP test response timed out')); }, 3000);
        waiting.set(request.id!, response => { clearTimeout(timer); resolve(response); });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
  };
}
const rpc = (id: number, method: string, params?: Record<string, unknown>): McpRequest => ({ jsonrpc: '2.0', id, method, params });
const stringSchema = { type: 'string' };
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const advertisedTools = [
  { name: 'factory_native_build', description: 'Build a configured native profile', inputSchema: objectSchema({ profileId: stringSchema, requestId: stringSchema }, ['profileId', 'requestId']) },
  { name: 'factory_job_status', description: 'Poll a durable job', inputSchema: objectSchema({ jobId: stringSchema, waitSeconds: { type: 'integer', minimum: 0, maximum: 30 } }, ['jobId']) },
  { name: 'factory_native_action', description: 'Perform a native action', inputSchema: objectSchema({ sessionId: stringSchema, observationId: stringSchema, requestId: stringSchema, action: { type: 'object' } }, ['sessionId', 'observationId', 'requestId', 'action']) },
  { name: 'factory_quality_submit', description: 'Submit a quality report', inputSchema: objectSchema({ report: { type: 'object' } }, ['report']) },
  { name: 'factory_assert', description: 'Assert an observed condition', inputSchema: objectSchema({ sessionId: stringSchema, absent: { type: 'boolean' } }, ['sessionId', 'absent']) },
  { name: 'job_batch', description: 'Operate on known jobs', inputSchema: objectSchema({ requestId: stringSchema, jobIds: { type: 'array', items: stringSchema } }, ['requestId', 'jobIds']) },
  { name: 'configured_action', description: 'Use an explicitly structured argument', inputSchema: objectSchema({
    requestId: stringSchema,
    configuration: objectSchema({ mode: { type: 'string', enum: ['quick', 'complete'] }, entries: { type: 'array', items: objectSchema({ jobId: stringSchema, enabled: { type: 'boolean' } }, ['jobId', 'enabled']) } }, ['mode', 'entries']),
  }, ['requestId', 'configuration']) },
];
const actionArguments = () => ({ sessionId: 'session-1', observationId: 'observation-1', requestId: 'request-1', action: {} });

test('private host MCP client performs a real subprocess handshake and preserves image content', { timeout: 8000 }, async t => {
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' };
  const handler = inspectionMcpHandler([{ name: 'observe', description: 'Inspect the owned test app', inputSchema: { type: 'object' } }], async () => ({ content: [{ type: 'text', text: 'Original observation' }, image] }));
  const bridge = await createHostInspectionBridge('scoped-test-token', handler);
  t.after(() => bridge.close());
  const provider = client(t, bridge);
  const initialized = await provider.send(rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'factory-test', version: '1' } }));
  assert.equal((initialized.result as { serverInfo: { name: string } }).serverInfo.name, 'enoughfactory-inspection');
  const listed = await provider.send(rpc(2, 'tools/list'));
  assert.equal((listed.result as { tools: Array<{ name: string }> }).tools[0]!.name, 'observe');
  const observed = await provider.send(rpc(3, 'tools/call', { name: 'observe', arguments: {} }));
  assert.deepEqual((observed.result as { content: unknown[] }).content[1], image);
  assert.equal(provider.stderr(), '');
});

test('a client without the scoped token cannot call the host inspection handler', { timeout: 8000 }, async t => {
  let calls = 0;
  const bridge = await createHostInspectionBridge('right-token', async () => { calls++; return {}; });
  t.after(() => bridge.close());
  const unauthorized = client(t, bridge, { ENOUGHFACTORY_INSPECTION_TOKEN: 'wrong-token' });
  const response = await unauthorized.send(rpc(1, 'tools/call', { name: 'observe', arguments: {} }));
  assert.equal(response.error?.code, -32001);
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(response), /right-token/);
});

test('requests serialize per client and simultaneous client responses retain their identities', { timeout: 8000 }, async t => {
  const entered = deferred(), release = deferred();
  const order: string[] = [];
  const bridge = await createHostInspectionBridge('test-token', async request => {
    const label = String(request.params?.label);
    order.push(`start-${label}`);
    if (label === 'first') { entered.resolve(); await release.promise; }
    order.push(`end-${label}`);
    return { label };
  });
  t.after(() => bridge.close());
  const firstClient = client(t, bridge), secondClient = client(t, bridge);
  const first = firstClient.send(rpc(1, 'test', { label: 'first' }));
  const second = firstClient.send(rpc(2, 'test', { label: 'second' }));
  await entered.promise;
  const other = await secondClient.send(rpc(1, 'test', { label: 'other-client' }));
  assert.deepEqual(other.result, { label: 'other-client' });
  assert.deepEqual(order, ['start-first', 'start-other-client', 'end-other-client']);
  release.resolve();
  assert.deepEqual((await first).result, { label: 'first' });
  assert.deepEqual((await second).result, { label: 'second' });
  assert.deepEqual(order.slice(-3), ['end-first', 'start-second', 'end-second']);
});

test('closing the bridge prevents queued calls from acquiring authority', { timeout: 8000 }, async t => {
  const entered = deferred(), release = deferred(), finished = deferred();
  const calls: string[] = [];
  const bridge = await createHostInspectionBridge('test-token', async request => {
    calls.push(request.method!);
    entered.resolve(); await release.promise; finished.resolve(); return {};
  });
  t.after(() => bridge.close());
  const provider = client(t, bridge);
  // No response is expected after closing; avoid creating pending response promises.
  provider.child.stdin.write(`${JSON.stringify(rpc(1, 'in-flight'))}\n${JSON.stringify(rpc(2, 'queued'))}\n`);
  await entered.promise;
  await bridge.close();
  release.resolve(); await finished.promise;
  await provider.exited;
  assert.deepEqual(calls, ['in-flight']);
});

test('advertised argument schemas reject malformed subprocess calls before any inspection effect', { timeout: 12000 }, async t => {
  const effects: Array<{ name: string; args: Record<string, unknown> }> = [];
  const handler = inspectionMcpHandler(advertisedTools, async (name, args) => { effects.push({ name, args }); return { performed: true }; });
  const bridge = await createHostInspectionBridge('schema-test-token', handler);
  t.after(() => bridge.close());
  const provider = client(t, bridge);
  const malformed: Array<{ label: string; name: string; args?: unknown }> = [
    { label: 'missing requestId', name: 'factory_native_build', args: { profileId: 'mail-macos' } },
    { label: 'missing profileId', name: 'factory_native_build', args: { requestId: 'request-1' } },
    { label: 'missing arguments cannot bypass required fields', name: 'factory_native_build' },
    { label: 'missing jobIds', name: 'job_batch', args: { requestId: 'request-1' } },
    { label: 'string argument has the wrong type', name: 'factory_native_build', args: { profileId: false, requestId: 'request-1' } },
    { label: 'requestId has the wrong type', name: 'factory_native_build', args: { profileId: 'mail-macos', requestId: 123 } },
    { label: 'integer argument is a string', name: 'factory_job_status', args: { jobId: 'job-1', waitSeconds: '1' } },
    { label: 'integer argument is a boolean', name: 'factory_job_status', args: { jobId: 'job-1', waitSeconds: true } },
    { label: 'fractional wait', name: 'factory_job_status', args: { jobId: 'job-1', waitSeconds: 1.5 } },
    { label: 'negative wait', name: 'factory_job_status', args: { jobId: 'job-1', waitSeconds: -1 } },
    { label: 'excessive wait', name: 'factory_job_status', args: { jobId: 'job-1', waitSeconds: 31 } },
    { label: 'boolean argument is a string', name: 'factory_assert', args: { sessionId: 'session-1', absent: 'false' } },
    { label: 'object argument is an array', name: 'factory_native_action', args: { ...actionArguments(), action: [] } },
    { label: 'object argument is null', name: 'factory_quality_submit', args: { report: null } },
    { label: 'array argument is an object', name: 'job_batch', args: { requestId: 'request-1', jobIds: { id: 'job-1' } } },
    { label: 'array item has the wrong type', name: 'job_batch', args: { requestId: 'request-1', jobIds: ['job-1', 12] } },
    { label: 'unadvertised top-level property', name: 'factory_native_build', args: { profileId: 'mail-macos', requestId: 'request-1', command: 'arbitrary' } },
    { label: 'unadvertised nested property', name: 'configured_action', args: { requestId: 'request-1', configuration: { mode: 'quick', entries: [], command: 'arbitrary' } } },
    { label: 'unadvertised array-item property', name: 'configured_action', args: { requestId: 'request-1', configuration: { mode: 'quick', entries: [{ jobId: 'job-1', enabled: true, extra: true }] } } },
    { label: 'nested required property missing', name: 'configured_action', args: { requestId: 'request-1', configuration: { mode: 'quick', entries: [{ jobId: 'job-1' }] } } },
    { label: 'nested property has the wrong type', name: 'configured_action', args: { requestId: 'request-1', configuration: { mode: 'quick', entries: [{ jobId: 'job-1', enabled: 1 }] } } },
    { label: 'nested enum is not advertised', name: 'configured_action', args: { requestId: 'request-1', configuration: { mode: 'invented', entries: [] } } },
    { label: 'blank requestId', name: 'factory_native_build', args: { profileId: 'mail-macos', requestId: ' \t\n' } },
    { label: 'blank profileId', name: 'factory_native_build', args: { profileId: '', requestId: 'request-1' } },
    { label: 'blank ID array member', name: 'job_batch', args: { requestId: 'request-1', jobIds: ['job-1', '  '] } },
    { label: 'blank nested ID', name: 'configured_action', args: { requestId: 'request-1', configuration: { mode: 'quick', entries: [{ jobId: '\t', enabled: true }] } } },
    { label: 'excessive ID length', name: 'factory_native_build', args: { profileId: 'mail-macos', requestId: 'r'.repeat(513) } },
    { label: 'excessive opaque string uses UTF-8 bytes', name: 'factory_quality_submit', args: { report: { details: 'é'.repeat(32769) } } },
  ];
  for (const [index, entry] of malformed.entries()) {
    const response = await provider.send(rpc(index + 1, 'tools/call', { name: entry.name, ...(entry.args === undefined ? {} : { arguments: entry.args }) }));
    assert.equal(response.error?.code, -32000, entry.label);
    assert.equal(response.result, undefined, entry.label);
    assert.equal(effects.length, 0, `${entry.label} reached the effect handler`);
  }
  const accepted = await provider.send(rpc(100, 'tools/call', { name: 'factory_native_build', arguments: { profileId: 'mail-macos', requestId: 'request-1' } }));
  assert.deepEqual(accepted.result, { performed: true });
  assert.deepEqual(effects, [{ name: 'factory_native_build', args: { profileId: 'mail-macos', requestId: 'request-1' } }]);
  assert.equal(provider.stderr(), '');
});

test('advertised schemas preserve valid opaque action and report payloads through the real subprocess', { timeout: 8000 }, async t => {
  const received: Array<{ name: string; args: Record<string, unknown> }> = [];
  const bridge = await createHostInspectionBridge('schema-valid-token', inspectionMcpHandler(advertisedTools, async (name, args) => { received.push({ name, args }); return { accepted: true }; }));
  t.after(() => bridge.close());
  const provider = client(t, bridge);
  const valid = [
    { name: 'factory_job_status', args: { jobId: 'job-1', waitSeconds: 0 } },
    { name: 'factory_job_status', args: { jobId: 'job-1', waitSeconds: 30 } },
    { name: 'factory_assert', args: { sessionId: 'session-1', absent: false } },
    { name: 'job_batch', args: { requestId: 'request-1', jobIds: ['job-1', 'job-2'] } },
    { name: 'configured_action', args: { requestId: 'request-1', configuration: { mode: 'complete', entries: [{ jobId: 'job-1', enabled: true }] } } },
    { name: 'factory_native_action', args: { ...actionArguments(), action: { type: 'click', target: { elementId: 'element-1', coordinate: { x: 1.5, y: 12 } }, flags: [true, null, 'unadvertised action details'] } } },
    { name: 'factory_quality_submit', args: { report: { version: 1, workflows: [{ title: 'Draft persists', observations: ['screen-1'], metadata: { arbitrary: { status: 'observed', value: null } } }], visualReview: { findings: [], accepted: true }, providerDetails: { requestId: 123, sessionId: '  ', unusualIds: [null, false] } } } },
  ];
  for (const [index, entry] of valid.entries()) {
    const response = await provider.send(rpc(index + 1, 'tools/call', { name: entry.name, arguments: entry.args }));
    assert.equal(response.error, undefined, entry.name);
    assert.deepEqual(response.result, { accepted: true }, entry.name);
  }
  assert.deepEqual(received, valid, 'Validation must preserve original payloads rather than normalize or drop arbitrary nested fields');
});

test('schema string and numeric bounds apply before the direct handler runs', async () => {
  let effects = 0;
  const handler = inspectionMcpHandler([{ name: 'bounded', description: 'Bounded schema', inputSchema: objectSchema({
    label: { type: 'string', minLength: 2, maxLength: 5 },
    ratio: { type: 'number', minimum: 0, maximum: 1 },
    values: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 2 },
  }, ['label', 'ratio']) }], async () => { effects++; return {}; });
  const invalid = [{ label: 'a', ratio: 0 }, { label: 'abcdef', ratio: 0 }, { label: 'valid', ratio: -0.1 }, { label: 'valid', ratio: 1.1 }, { label: 'valid', ratio: '0.5' }, { label: 'valid', ratio: 0, values: [] }, { label: 'valid', ratio: 0, values: [1, 2, 3] }];
  for (const args of invalid) {
    await assert.rejects(handler(rpc(1, 'tools/call', { name: 'bounded', arguments: args })));
    assert.equal(effects, 0);
  }
  await handler(rpc(2, 'tools/call', { name: 'bounded', arguments: { label: 'ok', ratio: 0.5, values: [1, 1.5] } }));
  assert.equal(effects, 1, 'A fractional number is valid when the schema advertises number rather than integer');
});

test('opaque nested payloads retain resource limits before reaching the effect handler', async () => {
  let effects = 0;
  const handler = inspectionMcpHandler(advertisedTools, async () => { effects++; return {}; });
  let deep: Record<string, unknown> = { value: 'leaf' };
  for (let depth = 0; depth < 35; depth++) deep = { child: deep };
  const oversized = [
    { label: 'nested depth', report: deep },
    { label: 'node count', report: { values: Array.from({ length: 30001 }, () => null) } },
    { label: 'nested string bytes', report: { child: { text: 'x'.repeat(65537) } } },
    { label: 'nested property key bytes', report: { ['k'.repeat(513)]: true } },
  ];
  for (const entry of oversized) {
    await assert.rejects(handler(rpc(1, 'tools/call', { name: 'factory_quality_submit', arguments: { report: entry.report } })), /Invalid inspection arguments/, entry.label);
    assert.equal(effects, 0, `${entry.label} reached the effect handler`);
  }
});
