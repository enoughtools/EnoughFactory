interface FactoryEventsOptions {
  url: string;
  headers?: HeadersInit;
  onChange(): void;
  onDisconnect?(): void;
  fetch?: typeof fetch;
  retryDelayMs?: number;
}

/** Keep a single authenticated event stream through service restarts. */
export function connectFactoryEvents(options: FactoryEventsOptions): { reconnect(): void; close(): void } {
  const request = options.fetch ?? globalThis.fetch;
  const initialDelay = options.retryDelayMs ?? 1000;
  let delay = initialDelay;
  let closed = false;
  let active: AbortController | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reconnectRequested = false;
  const clearRetry = () => { if (retry !== undefined) clearTimeout(retry); retry = undefined; };
  const schedule = (wait: number) => {
    if (closed || active || retry !== undefined) return;
    retry = setTimeout(() => { retry = undefined; void subscribe(); }, wait);
  };
  async function subscribe() {
    if (closed || active) return;
    const controller = new AbortController();
    active = controller;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelReader = () => { void reader?.cancel().catch(() => {}); };
    controller.signal.addEventListener('abort', cancelReader, { once: true });
    try {
      const response = await request(options.url, { signal: controller.signal, headers: options.headers });
      if (!response.ok || !response.body) throw new Error('The device event stream is unavailable.');
      reader = response.body.getReader();
      if (controller.signal.aborted) cancelReader();
      while (!controller.signal.aborted) {
        const result = await reader.read();
        if (result.done) break;
        delay = initialDelay;
        options.onChange();
      }
    } catch { /* The catalog refresh reports availability; the stream retries independently. */ }
    finally {
      controller.signal.removeEventListener('abort', cancelReader);
      reader?.releaseLock();
      active = undefined;
      if (!closed) {
        options.onDisconnect?.();
        const wait = reconnectRequested ? 0 : delay;
        reconnectRequested = false;
        delay = Math.min(delay * 2, 10_000);
        schedule(wait);
      }
    }
  }
  void subscribe();
  return {
    reconnect() {
      if (closed) return;
      clearRetry();
      if (active) { reconnectRequested = true; active.abort(); }
      else schedule(0);
    },
    close() { closed = true; clearRetry(); active?.abort(); },
  };
}

/** Browser timers may be suspended while a desktop window is in the background. */
export function onFactoryForeground(windowTarget: EventTarget, documentTarget: EventTarget & { visibilityState: string }, onActive: () => void): () => void {
  const activate = () => { if (documentTarget.visibilityState === 'visible') onActive(); };
  windowTarget.addEventListener('focus', activate);
  windowTarget.addEventListener('online', activate);
  documentTarget.addEventListener('visibilitychange', activate);
  return () => {
    windowTarget.removeEventListener('focus', activate);
    windowTarget.removeEventListener('online', activate);
    documentTarget.removeEventListener('visibilitychange', activate);
  };
}
