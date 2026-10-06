import assert from 'node:assert/strict';
import { test } from 'node:test';
import { iceCredentialExpiresAt, iceCredentialsNeedRefresh, liveRtcIceServers } from '../src/types.ts';

test('opaque managed TURN usernames refresh through explicit expiry while legacy coturn remains compatible', () => {
  const now = 1_700_000_000_000;
  const opaque = { urls: 'turn:turn.cloudflare.com:3478', username: 'opaque-user', credential: 'short-lived', expiresAt: now + 45_000 };
  assert.equal(iceCredentialExpiresAt(opaque), now + 45_000);
  assert.equal(iceCredentialsNeedRefresh([opaque], now), true);
  const legacy = { urls: 'turn:relay.example:3478', username: `${(now + 3600_000) / 1000}:fixture-device`, credential: 'legacy-coturn' };
  assert.equal(iceCredentialExpiresAt(legacy), now + 3600_000);
  assert.equal(iceCredentialsNeedRefresh([legacy], now), false);
  assert.equal(iceCredentialsNeedRefresh([legacy], now + 3570_000), true);
});

test('expired temporary TURN is excluded from new RTC configuration without removing STUN/static TURN', () => {
  const now = 1_700_000_000_000;
  const stun = { urls: 'stun:stun.cloudflare.com:3478' };
  const staticTurn = { urls: 'turn:relay.example:3478', username: 'static-user', credential: 'static-fixture' };
  const expired = { urls: 'turn:turn.cloudflare.com:3478', username: 'opaque-old', credential: 'expired', expiresAt: now - 1 };
  const refreshed = { urls: 'turn:turn.cloudflare.com:3478', username: 'opaque-new', credential: 'fresh', expiresAt: now + 3600_000 };
  assert.deepEqual(liveRtcIceServers([stun, staticTurn, expired, refreshed], now), [stun, staticTurn,
    { urls: refreshed.urls, username: refreshed.username, credential: refreshed.credential }]);
  assert.equal(iceCredentialsNeedRefresh([stun, staticTurn], now), false);
});
