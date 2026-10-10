import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { requestLocalService } from './local-service-request.ts';
import { probeDeviceConnection } from './service-connection.ts';

async function localServer(context: TestContext, listener: RequestListener) {
  const server = createServer(listener);
  context.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('authenticated local JSON avoids both global fetch and the faulty socket QoS path', async context => {
  context.mock.method(globalThis, 'fetch', async () => assert.fail('Desktop local IPC cannot enter bundled Undici'));
  const prior = Object.getOwnPropertyDescriptor(Socket.prototype, 'setTypeOfService');
  let qosCalls = 0;
  Object.defineProperty(Socket.prototype, 'setTypeOfService', { configurable: true, value() {
    qosCalls++;
    throw Object.assign(new Error('setTypeOfService EINVAL'), { code: 'EINVAL' });
  } });
  context.after(() => { if (prior) Object.defineProperty(Socket.prototype, 'setTypeOfService', prior); else Reflect.deleteProperty(Socket.prototype, 'setTypeOfService'); });
  const body = JSON.stringify({ reason: 'Résumé ready' });
  const address = await localServer(context, async (incoming, response) => {
    assert.equal(incoming.method, 'POST');
    assert.equal(incoming.url, '/api/service/shutdown');
    assert.equal(incoming.headers.authorization, 'Bearer inert-test-token');
    assert.equal(incoming.headers['content-length'], String(Buffer.byteLength(body)));
    let actual = '';
    for await (const chunk of incoming) actual += chunk;
    assert.equal(actual, body);
    response.writeHead(201, { 'Content-Type': 'application/json', 'X-Factory-Result': 'accepted' });
    response.end(JSON.stringify({ accepted: true }));
  });
  const response = await requestLocalService(`${address.replace('127.0.0.1', 'localhost')}/api/service/shutdown`, {
    method: 'POST', headers: { Authorization: 'Bearer inert-test-token', 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-factory-result'), 'accepted');
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(qosCalls, 0);
});

test('local errors, empty replies and invalid JSON retain their HTTP meanings', async context => {
  const address = await localServer(context, (incoming, response) => {
    if (incoming.url === '/busy') { response.writeHead(409, { 'Content-Type': 'application/json' }); response.end('{"error":"Current work is active"}'); }
    else if (incoming.url === '/empty') { response.writeHead(204); response.end(); }
    else { response.end('invalid JSON'); }
  });
  const busy = await requestLocalService(`${address}/busy`);
  assert.equal(busy.ok, false);
  assert.equal(busy.status, 409);
  assert.deepEqual(await busy.json(), { error: 'Current work is active' });
  const empty = await requestLocalService(`${address}/empty`);
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
  const invalid = await requestLocalService(`${address}/invalid`);
  await assert.rejects(invalid.json(), SyntaxError);
});

test('local tokens cannot follow redirects or leave the loopback HTTP transport', async context => {
  let redirected = 0;
  const address = await localServer(context, (incoming, response) => {
    if (incoming.url === '/target') redirected++;
    response.writeHead(302, { Location: '/target' }); response.end('redirect');
  });
  const response = await requestLocalService(`${address}/redirect`, { headers: { Authorization: 'Bearer inert-test-token' } });
  assert.equal(response.status, 302);
  assert.equal(redirected, 0);
  for (const url of ['https://127.0.0.1/', 'http://example.com/', 'http://user:password@127.0.0.1/']) {
    await assert.rejects(requestLocalService(url), /loopback HTTP/);
  }
  await assert.rejects(requestLocalService(new Request(`${address}/`)), /local service address/);
  await assert.rejects(requestLocalService(`${address}/`, { body: new Uint8Array([1]) }), /JSON text/);
});

test('cancellation covers a stalled body and preserves the caller abort reason', async context => {
  let bodyStarted!: () => void;
  const started = new Promise<void>(done => { bodyStarted = done; });
  const address = await localServer(context, (_incoming, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
    bodyStarted();
  });
  const controller = new AbortController();
  const reason = new Error('The local check was canceled');
  const response = await requestLocalService(`${address}/`, { signal: controller.signal });
  const pending = response.json();
  const rejected = assert.rejects(pending, error => error === reason);
  await started;
  controller.abort(reason);
  await rejected;
  await assert.rejects(requestLocalService(`${address}/`, { signal: controller.signal }), error => error === reason);
});

test('a service reset rejects normally and a new connection can recover its identity', async context => {
  let reset = true;
  const address = await localServer(context, (incoming, response) => {
    if (reset) { incoming.socket.destroy(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, product: 'EnoughFactory', version: '0.1.6', runtime: {
      kind: 'lima', stateDirectory: '/owned/factory', socketPath: '/owned/factory/docker.sock',
    } }));
  });
  const connection = { url: address, token: 'inert-test-token' };
  const options = { serviceVersion: '0.1.6', stateDirectory: '/owned/factory', request: requestLocalService };
  assert.equal(await probeDeviceConnection(connection, options), undefined);
  reset = false;
  assert.deepEqual(await probeDeviceConnection(connection, options), { ...connection, version: '0.1.6' });
});

test('truncated responses and body timeouts cannot become successful local replies', async context => {
  const address = await localServer(context, (incoming, response) => {
    response.writeHead(200, { 'Content-Length': '100' });
    response.write('{');
    if (incoming.url === '/truncated') setImmediate(() => response.socket?.destroy());
  });
  const truncated = await requestLocalService(`${address}/truncated`, { signal: AbortSignal.timeout(1_000) });
  await assert.rejects(truncated.json(), /aborted|socket hang up/);
  const stalled = await requestLocalService(`${address}/timeout`, { signal: AbortSignal.timeout(25) });
  await assert.rejects(stalled.json(), error => error instanceof DOMException && error.name === 'TimeoutError');
});

test('status-only shutdown sees accepted or busy headers before a stalled body', { timeout: 2_000 }, async context => {
  let connectionsClosed = 0;
  let allClosed!: () => void;
  const closed = new Promise<void>(done => { allClosed = done; });
  const address = await localServer(context, (incoming, response) => {
    incoming.socket.once('close', () => { if (++connectionsClosed === 2) allClosed(); });
    response.writeHead(incoming.url === '/busy' ? 409 : 200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  for (const [path, status] of [['/busy', 409], ['/accepted', 200]] as const) {
    const response = await requestLocalService(`${address}${path}`, { method: 'POST', signal: AbortSignal.timeout(1_000) });
    assert.equal(response.status, status);
    await response.body!.cancel();
  }
  await closed;
  assert.equal(connectionsClosed, 2);
});

test('legacy probes retain compatibility with large state catalogs', async context => {
  const paths: string[] = [];
  const runtime = { kind: 'lima', stateDirectory: '/owned/factory', socketPath: '/owned/factory/docker.sock' };
  const address = await localServer(context, (incoming, response) => {
    paths.push(incoming.url!);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(incoming.url === '/api/health'
      ? { ok: true, product: 'EnoughFactory', version: '0.1.3' }
      : { diagnostics: { containerRuntime: runtime }, retainedCatalog: 'x'.repeat(16 * 1024 * 1024 + 1) }));
  });
  const connection = { url: address, token: 'inert-test-token' };
  assert.deepEqual(await probeDeviceConnection(connection, {
    serviceVersion: '0.1.6', stateDirectory: runtime.stateDirectory, request: requestLocalService,
  }), { ...connection, version: '0.1.3' });
  assert.deepEqual(paths, ['/api/health', '/api/state']);
});
