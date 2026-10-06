import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCloudflareIceServers } from '../src/ice.ts';

const deviceId = 'a'.repeat(32);
const config = { keyId: 'fixture-turn-key', apiToken: 'server-only-fixture-token', ttlSeconds: 3600 };

test('managed TURN issues temporary ICE credentials with explicit expiry, never its server token', async () => {
  const issuedAt = 1_700_000_000_000;
  const servers = await generateCloudflareIceServers(config, deviceId, {
    now: () => issuedAt,
    fetch: (async (url, init) => {
      assert.equal(url, 'https://rtc.live.cloudflare.com/v1/turn/keys/fixture-turn-key/credentials/generate-ice-servers');
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${config.apiToken}`);
      assert.deepEqual(JSON.parse(String(init?.body)), { ttl: 3600 });
      assert.equal(init?.redirect, 'error');
      return new Response(JSON.stringify({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'opaque-short-lived-user', credential: 'temporary-fixture-credential' },
      ] }), { status: 201 });
    }) as typeof fetch,
  });
  assert.deepEqual(servers, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'opaque-short-lived-user', credential: 'temporary-fixture-credential', expiresAt: issuedAt + 3600_000 },
  ]);
  assert.equal(JSON.stringify(servers).includes(config.apiToken), false);
});

test('managed TURN rejects incomplete credentials and does not echo provider error bodies', async () => {
  await assert.rejects(generateCloudflareIceServers(config, deviceId, {
    fetch: (async () => new Response(JSON.stringify({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'opaque-user' }] }), { status: 201 })) as typeof fetch,
  }), /incomplete temporary credentials/);
  await assert.rejects(generateCloudflareIceServers(config, deviceId, {
    fetch: (async () => new Response(`Sensitive upstream body: ${config.apiToken}`, { status: 403 })) as typeof fetch,
  }), error => error instanceof Error && error.message === 'Cloudflare TURN credential issuance failed (403).');
});

test('managed TURN rejects credentials that expire before issuance finishes', async () => {
  let now = 1_700_000_000_000;
  await assert.rejects(generateCloudflareIceServers({ ...config, ttlSeconds: 60 }, deviceId, {
    now: () => now,
    fetch: (async () => {
      now += 60_000;
      return new Response(JSON.stringify({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'opaque-user', credential: 'expired-fixture' }] }), { status: 201 });
    }) as typeof fetch,
  }), /expired temporary credentials/);
});
