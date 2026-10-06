export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  /** Credential expiry as UNIX milliseconds; STUN and static TURN omit this. */
  expiresAt?: number;
}

export interface RelayLimits { bytesPerSecond: number; messagesPerSecond: number }
/** Optional server-negotiated pacing; legacy signaling advertises no limits. */
export function negotiatedRelayLimits(value: unknown): RelayLimits | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { bytesPerSecond, messagesPerSecond } = value as Record<string, unknown>;
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 ||
    typeof messagesPerSecond !== 'number' || !Number.isFinite(messagesPerSecond) || messagesPerSecond <= 0) return;
  return { bytesPerSecond: Math.min(16 * 1024 * 1024, Math.max(1, bytesPerSecond)),
    messagesPerSecond: Math.min(1000, Math.max(1, messagesPerSecond)) };
}

export function iceCredentialExpiresAt(server: IceServer): number | undefined {
  if (Number.isSafeInteger(server.expiresAt) && server.expiresAt! > 0) return server.expiresAt;
  // Older signaling deployments expose coturn REST expiry only in the username.
  const legacy = server.username?.match(/^(\d{10,13}):/);
  const seconds = legacy ? Number(legacy[1]) : undefined;
  return seconds !== undefined && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
}

export function iceCredentialsNeedRefresh(servers: IceServer[], now = Date.now(), leadMs = 60_000): boolean {
  return servers.some(server => { const expiry = iceCredentialExpiresAt(server); return expiry !== undefined && expiry <= now + leadMs; });
}

/** Remove private lifetime metadata before handing configuration to browser RTC. */
export function liveRtcIceServers(servers: IceServer[], now = Date.now()): Array<Omit<IceServer, 'expiresAt'>> {
  return servers.filter(server => { const expiry = iceCredentialExpiresAt(server); return expiry === undefined || expiry > now; })
    .map(({ expiresAt: _expiry, ...server }) => server);
}
