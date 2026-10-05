import { useCallback, useEffect, useState } from 'react';
import type { DeviceClient } from './api';

export function useResource<T>(client: DeviceClient, path: string | null, interval = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    if (!path) return;
    try { setData(await client.get<T>(path)); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [client, path]);
  useEffect(() => {
    setData(null); setError(null); setLoading(Boolean(path));
    let active = true;
    if (path) void client.get<T>(path).then(value => { if (active) { setData(value); setError(null); } }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (active) setLoading(false); });
    const timer = interval > 0 ? setInterval(() => void refresh(), interval) : null;
    return () => { active = false; if (timer) clearInterval(timer); };
  }, [client, path, interval, refresh]);
  return { data, error, loading, refresh };
}

export function relativeTime(value: string) {
  const distance = Date.now() - Date.parse(value);
  if (!Number.isFinite(distance)) return '—';
  if (distance < 60_000) return 'just now';
  if (distance < 3_600_000) return `${Math.floor(distance / 60_000)}m ago`;
  if (distance < 86_400_000) return `${Math.floor(distance / 3_600_000)}h ago`;
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
