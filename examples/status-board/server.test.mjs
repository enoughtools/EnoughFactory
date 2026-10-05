// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { createStatusServer } from './server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function close(server) {
  return new Promise(resolveClose => server.close(resolveClose));
}

test('HTTP status distinguishes standalone mode from a failed configured cache', async () => {
  const standalone = createStatusServer();
  const standalonePort = await listen(standalone);
  const broken = createStatusServer({ cacheHost: '127.0.0.1', cachePort: 0 });
  const brokenPort = await listen(broken);
  try {
    const local = await fetch(`http://127.0.0.1:${standalonePort}/health`);
    assert.equal(local.status, 200);
    assert.equal((await local.json()).cache, 'not-configured');
    const failed = await fetch(`http://127.0.0.1:${brokenPort}/health`);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).state, 'degraded');
  } finally {
    await Promise.all([close(standalone), close(broken)]);
  }
});

test('HTTP status verifies a cache PONG over a real TCP connection', async () => {
  let command;
  const cache = createTcpServer(socket => {
    socket.once('data', bytes => {
      command = bytes.toString();
      socket.write('+PO');
      setImmediate(() => socket.end('NG\r\n'));
    });
  });
  const cachePort = await listen(cache);
  const app = createStatusServer({ cacheHost: '127.0.0.1', cachePort });
  const appPort = await listen(app);
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/status`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).cache, 'connected');
    assert.equal(command, '*1\r\n$4\r\nPING\r\n');
  } finally {
    await Promise.all([close(app), close(cache)]);
  }
});
