import type { Chat, Session } from '@enoughfactory/contracts';
import type { FactoryStore } from '@enoughfactory/factory';

export const terminalSessionCleanupBucket = 'session-environment-cleanup';

class EnvironmentCleanupDeferredError extends Error {}

export interface TerminalSessionCleanupRecord {
  id: string;
  identity: string;
  status: 'queued' | 'preserving' | 'removed' | 'deferred';
  attempts: number;
  updatedAt: string;
  nextAttemptAt?: string;
  exhausted?: boolean;
  reason?: string;
  removedAt?: string;
}

export interface TerminalSessionCleanupOptions {
  store: Pick<FactoryStore, 'list' | 'get' | 'set'>;
  sessions: {
    record(sessionId: string): Session;
    owns(sessionId: string): boolean;
    canRetireEnvironment(sessionId: string): boolean;
  };
  runtimeReady(): boolean;
  /** Factory ownership and terminal execution state can further restrict cleanup. */
  eligible?(session: Session): boolean;
  busy?(sessionId: string): boolean;
  /** The retirement primitive owns preservation, its idle lease, and Docker checks. */
  retire(sessionId: string, assertCurrent: () => void): Promise<void>;
  /** Include the launch generation when a session can reuse a container name. */
  identity?(session: Session): string;
  retryMs?: number;
  reconcileMs?: number;
  maxAttempts?: number;
  now?: () => number;
  onError?(error: unknown): void;
}

/** Durable cleanup scheduling changes no session, chat, or provider outcome. */
export class TerminalSessionCleanup {
  private readonly pending = new Set<string>();
  private readonly retryMs: number;
  private readonly reconcileMs: number;
  private readonly maxAttempts: number;
  private readonly clock: () => number;
  private running?: Promise<void>;
  private active?: { id: string; identity: string };
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;

  constructor(private readonly options: TerminalSessionCleanupOptions) {
    this.retryMs = options.retryMs ?? 30_000;
    this.reconcileMs = options.reconcileMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.clock = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.retryMs) || this.retryMs <= 0
      || !Number.isSafeInteger(this.reconcileMs) || this.reconcileMs <= 0
      || !Number.isSafeInteger(this.maxAttempts) || this.maxAttempts <= 0)
      throw new Error('Environment cleanup requires positive retry, reconciliation, and attempt limits.');
  }

  start(): void {
    if (this.closed || this.started) return;
    this.started = true;
    this.reconcile();
    this.timer = setInterval(() => {
      try { this.reconcile(); } catch (error) { this.options.onError?.(error); }
    }, this.reconcileMs);
    this.timer.unref();
  }

  /** Startup and periodic scans also replay a preservation interrupted by restart. */
  reconcile(): void {
    if (this.closed) return;
    for (const session of this.options.store.list<Session>('sessions')) this.enqueue(session, false);
    this.kick();
  }

  /** A lifecycle event or explicit retry starts a fresh bounded retry budget. */
  request(sessionId: string): void {
    if (this.closed) return;
    this.enqueue(this.options.sessions.record(sessionId), true);
    this.kick();
  }

  /** Waits for queued work; future retry timers are deliberately not awaited. */
  async drain(): Promise<void> {
    for (;;) {
      this.kick();
      const running = this.running;
      if (!running) return;
      await running;
    }
  }

  /** Finish preservation already in progress before the store/runtime close. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear();
    await this.running;
  }

  private eligible(session: Session): boolean {
    return this.options.eligible?.(session) ?? ['stopped', 'failed', 'unknown'].includes(session.status);
  }

  private identity(session: Session): string {
    const identity = this.options.identity?.(session) ?? JSON.stringify([session.containerId ?? null, session.createdAt]);
    if (!identity) throw new Error('Environment cleanup requires a stable environment identity.');
    return identity;
  }

  private enqueue(session: Session, explicit: boolean): void {
    if (!this.options.sessions.owns(session.id) || !this.eligible(session)) return;
    const identity = this.identity(session);
    const previous = this.options.store.get<TerminalSessionCleanupRecord>(terminalSessionCleanupBucket, session.id);
    const same = previous?.identity === identity;
    if (same && previous.status === 'removed') return;
    if (this.active?.id === session.id && this.active.identity === identity) return;
    if (same && this.pending.has(session.id)) return;
    if (same && !explicit && (previous.exhausted || previous.nextAttemptAt && Date.parse(previous.nextAttemptAt) > this.clock())) return;
    if (same && !explicit && previous.attempts >= this.maxAttempts) {
      this.defer(previous, 'Preservation reached its retry limit before completion was confirmed. Retry cleanup to reconcile the retained environment.', true);
      return;
    }
    this.options.store.set(terminalSessionCleanupBucket, {
      id: session.id, identity, status: 'queued', attempts: same && !explicit ? previous.attempts : 0,
      updatedAt: this.timestamp(),
    } satisfies TerminalSessionCleanupRecord);
    this.pending.add(session.id);
  }

  private kick(): void {
    if (this.closed || this.running || !this.pending.size) return;
    // Do not enter an injected retire callback until this.running is installed;
    // lifecycle callbacks may synchronously request another cleanup.
    const running = Promise.resolve().then(() => this.run());
    this.running = running;
    void running.then(() => {
      if (this.running === running) this.running = undefined;
      this.kick();
    }, error => {
      if (this.running === running) this.running = undefined;
      this.options.onError?.(error);
    });
  }

  private async run(): Promise<void> {
    while (!this.closed && this.pending.size) {
      const sessionId = this.pending.values().next().value!;
      this.pending.delete(sessionId);
      const saved = this.options.store.get<TerminalSessionCleanupRecord>(terminalSessionCleanupBucket, sessionId);
      if (!saved || saved.status === 'removed') continue;
      this.active = { id: sessionId, identity: saved.identity };
      try {
        const session = this.options.sessions.record(sessionId);
        if (this.identity(session) !== saved.identity) { this.enqueue(session, false); continue; }
        const reason = this.blocker(session);
        if (reason) { this.defer(saved, reason, false); continue; }
        const preserving: TerminalSessionCleanupRecord = {
          id: sessionId, identity: saved.identity, status: 'preserving', attempts: saved.attempts + 1,
          updatedAt: this.timestamp(),
        };
        this.options.store.set(terminalSessionCleanupBucket, preserving);
        const assertCurrent = () => {
          const current = this.options.store.get<TerminalSessionCleanupRecord>(terminalSessionCleanupBucket, sessionId);
          if (current?.identity !== saved.identity || current.status !== 'preserving')
            throw new EnvironmentCleanupDeferredError('A newer environment cleanup replaced this operation.');
          const currentSession = this.options.sessions.record(sessionId);
          if (this.identity(currentSession) !== saved.identity) throw new EnvironmentCleanupDeferredError('The environment identity changed during preservation.');
          const currentReason = this.blocker(currentSession);
          if (currentReason) throw new EnvironmentCleanupDeferredError(currentReason);
        };
        try {
          await this.options.retire(sessionId, assertCurrent);
          // Retirement may itself clear runtime ownership. Its receipt belongs
          // to this generation, regardless of a later session launch.
          const current = this.options.store.get<TerminalSessionCleanupRecord>(terminalSessionCleanupBucket, sessionId);
          if (current?.identity === saved.identity && current.status === 'preserving') {
            const removedAt = this.timestamp();
            this.options.store.set(terminalSessionCleanupBucket, {
              ...preserving, status: 'removed', updatedAt: removedAt, removedAt,
            } satisfies TerminalSessionCleanupRecord);
          }
        } catch (error) {
          const deferred = error instanceof EnvironmentCleanupDeferredError;
          this.defer(deferred ? saved : preserving, this.errorText(error), !deferred);
        }
      } catch (error) { this.defer({ ...saved, attempts: saved.attempts + 1 }, this.errorText(error), true); }
      finally { this.active = undefined; }
    }
  }

  private blocker(session: Session): string | undefined {
    if (!this.options.sessions.owns(session.id)) return 'This environment is no longer owned by this device runtime.';
    if (!this.eligible(session)) return 'This environment still belongs to unfinished work.';
    if (session.status === 'starting' || session.status === 'stopping') return 'An environment lifecycle operation is still active.';
    if (!this.options.runtimeReady()) return 'The private container runtime is not ready.';
    if (this.options.busy?.(session.id)) return 'Factory work or evidence capture is still active.';
    if (this.options.store.list<Chat>('chats').some(chat => chat.sessionId === session.id && ['running', 'waiting'].includes(chat.status)))
      return 'An agent conversation is still running or waiting for input.';
    if (!this.options.sessions.canRetireEnvironment(session.id)) return 'The environment has not confirmed that execution is idle.';
    return undefined;
  }

  private defer(previous: TerminalSessionCleanupRecord, reason: string, failed: boolean): void {
    const current = this.options.store.get<TerminalSessionCleanupRecord>(terminalSessionCleanupBucket, previous.id);
    if (current?.identity !== previous.identity || current.status === 'removed') return;
    const attempts = failed ? Math.max(previous.attempts, current.attempts) : previous.attempts;
    const exhausted = failed && attempts >= this.maxAttempts;
    const delay = Math.min(15 * 60_000, this.retryMs * 2 ** Math.min(Math.max(attempts - 1, 0), 16));
    this.options.store.set(terminalSessionCleanupBucket, {
      id: previous.id, identity: previous.identity, status: 'deferred', attempts,
      updatedAt: this.timestamp(), reason: reason.slice(0, 2048),
      ...(exhausted ? { exhausted: true } : { nextAttemptAt: new Date(this.clock() + delay).toISOString() }),
    } satisfies TerminalSessionCleanupRecord);
  }

  private timestamp(): string { return new Date(this.clock()).toISOString(); }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
