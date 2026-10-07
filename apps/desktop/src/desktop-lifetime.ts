interface QuitEvent { preventDefault(): void }

/** The desktop may leave; an already accepted independent service handoff must finish first. */
export function createDesktopQuitController(options: {
  prepareQuit(): Promise<unknown> | undefined;
  closePreview(): Promise<void>;
  quit(): void;
  exit(): void;
}) {
  let phase: 'running' | 'draining' | 'quitting' = 'running';
  let disposed = false;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    beforeQuit(event: QuitEvent): void {
      if (phase === 'quitting') return;
      event.preventDefault();
      if (phase === 'draining') return;
      phase = 'draining';
      const handoff = options.prepareQuit();
      void (async () => {
        // This critical wait intentionally precedes the GUI deadline: exiting
        // before its detached successor launches could strand an accepted update.
        if (handoff) await handoff.catch(() => {});
        if (disposed) return;
        // Keep this timer referenced until actual quit. app.quit() can otherwise
        // wait indefinitely for an unresponsive renderer's unload handlers.
        exitTimer = setTimeout(() => { phase = 'quitting'; options.exit(); }, 5_000);
        await new Promise<void>(done => {
          cleanupTimer = setTimeout(done, 3_000);
          void Promise.resolve().then(options.closePreview).then(done, done);
        });
        clearTimeout(cleanupTimer);
        cleanupTimer = undefined;
        if (disposed) return;
        phase = 'quitting';
        options.quit();
      })();
    },
    dispose(): void {
      disposed = true;
      clearTimeout(cleanupTimer);
      clearTimeout(exitTimer);
    },
  };
}
