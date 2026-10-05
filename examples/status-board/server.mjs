// SPDX-License-Identifier: MIT
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const page = await readFile(new URL('./index.html', import.meta.url));

function probeCache(host, port) {
  return new Promise(resolveProbe => {
    const socket = createConnection({ host, port });
    let reply = '';
    let finished = false;
    const finish = connected => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolveProbe(connected);
    };
    socket.setTimeout(750, () => finish(false));
    socket.once('connect', () => socket.write('*1\r\n$4\r\nPING\r\n'));
    socket.on('data', chunk => {
      reply += chunk.toString('utf8');
      if (reply.includes('\r\n') || reply.length > 128) finish(reply === '+PONG\r\n');
    });
    socket.once('error', () => finish(false));
    socket.once('end', () => finish(false));
  });
}

export function createStatusServer({ cacheHost, cachePort = 6379 } = {}) {
  const started = Date.now();
  return createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end('Use GET');
      return;
    }
    if (pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page);
      return;
    }
    if (pathname === '/api/status' || pathname === '/health') {
      const connected = cacheHost ? await probeCache(cacheHost, cachePort) : false;
      const cache = !cacheHost ? 'not-configured' : connected ? 'connected' : 'unavailable';
      response.writeHead(cache === 'unavailable' ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        application: 'Enough status board',
        state: cache === 'unavailable' ? 'degraded' : 'ready',
        cache,
        uptimeSeconds: Math.floor((Date.now() - started) / 1000),
        checkedAt: new Date().toISOString(),
      }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Page not found');
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const port = Number(process.env.PORT ?? 3000);
  const cachePort = Number(process.env.CACHE_PORT ?? 6379);
  if (![port, cachePort].every(value => Number.isInteger(value) && value > 0 && value <= 65535)) {
    throw new Error('PORT and CACHE_PORT must be valid TCP ports');
  }
  const server = createStatusServer({ cacheHost: process.env.CACHE_HOST, cachePort });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
    console.log(`Status board ready at http://localhost:${port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
