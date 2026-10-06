import type { IceServer } from './protocol.ts';

export interface CloudflareTurnConfig { keyId: string; apiToken: string; ttlSeconds: number }
export interface CloudflareTurnDependencies { fetch?: typeof fetch; now?: () => number }

/** Issue a device's temporary credentials using a server-held Realtime TURN key.
 * Official API: https://developers.cloudflare.com/realtime/turn/generate-credentials/
 * Cloudflare omits TTL in its response; expiry is bounded from request start.
 * Admission and per-device caching belong to the authenticated signaling service. */
export async function generateCloudflareIceServers(config: CloudflareTurnConfig, deviceId: string,
  dependencies: CloudflareTurnDependencies = {}): Promise<IceServer[]> {
  if (!/^[a-f0-9]{32}$/.test(deviceId)) throw new Error('Invalid device identity for TURN issuance.');
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(config.keyId) || !config.apiToken?.trim() || config.apiToken.length > 4096)
    throw new Error('Cloudflare TURN requires a server-held key ID and API token.');
  if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds < 60 || config.ttlSeconds > 172800)
    throw new Error('Cloudflare TURN credential TTL must be between 60 and 172800 seconds.');
  const issuedAt = (dependencies.now ?? Date.now)();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await (dependencies.fetch ?? fetch)(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: config.ttlSeconds }), signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
    if (!response.ok) throw new Error(`Cloudflare TURN credential issuance failed (${response.status}).`);
    const text = await response.text();
    if (text.length > 64 * 1024) throw new Error('Cloudflare TURN returned an oversized credential response.');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('Cloudflare TURN returned an invalid credential response.'); }
    const entries = value && typeof value === 'object' && !Array.isArray(value) ? (value as { iceServers?: unknown }).iceServers : undefined;
    if (!Array.isArray(entries) || !entries.length || entries.length > 16) throw new Error('Cloudflare TURN returned no valid ICE servers.');
    let hasTurn = false;
    const servers: IceServer[] = entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Cloudflare TURN returned an invalid ICE server.');
      const fields = entry as Record<string, unknown>;
      const urls = typeof fields.urls === 'string' ? [fields.urls] : fields.urls;
      if (!Array.isArray(urls) || !urls.length || urls.length > 24 || urls.some(url => typeof url !== 'string' || url.length > 512 || !/^(?:stun|stuns|turn|turns):[^\s]+$/.test(url)))
        throw new Error('Cloudflare TURN returned invalid ICE URLs.');
      const turn = urls.some(url => /^turns?:/.test(url));
      if (turn && (typeof fields.username !== 'string' || !fields.username || fields.username.length > 4096 ||
        typeof fields.credential !== 'string' || !fields.credential || fields.credential.length > 4096))
        throw new Error('Cloudflare TURN returned incomplete temporary credentials.');
      if (turn) hasTurn = true;
      return { urls, ...(turn ? { username: fields.username as string, credential: fields.credential as string,
        expiresAt: issuedAt + config.ttlSeconds * 1000 } : {}) };
    });
    if (!hasTurn) throw new Error('Cloudflare TURN returned no temporary relay credentials.');
    if (servers.some(server => server.expiresAt !== undefined && server.expiresAt <= (dependencies.now ?? Date.now)()))
      throw new Error('Cloudflare TURN returned expired temporary credentials.');
    return servers;
  } finally { clearTimeout(timeout); }
}
