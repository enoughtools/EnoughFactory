import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dockerInvocation, type DockerRuntimeEndpoint } from "@enoughfactory/runtime";
import { AgentError } from "./types.ts";

export type SpawnProcess = typeof spawn;
function requireEndpoint(endpoint?: DockerRuntimeEndpoint): DockerRuntimeEndpoint {
  if (!endpoint) throw new AgentError("EnoughFactory's managed container runtime is not configured.", "MANAGED_RUNTIME_UNCONFIGURED");
  return endpoint;
}
export function checkContainerId(containerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerId)) throw new AgentError("A Docker container identity is required.", "INVALID_CONTAINER");
}
export function quote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

interface TimeoutClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/** Budget active waiting time without expiring an entire command during host sleep. */
export function suspendAwareTimeout(callback: () => void, duration: number, clock: TimeoutClock = {
  now: () => performance.now(), setTimeout, clearTimeout,
}): () => void {
  let remaining = Number.isFinite(duration) && duration > 0 ? duration : 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    const slice = Math.min(1000, remaining);
    const started = clock.now();
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      const elapsed = Math.max(0, clock.now() - started);
      // A long event-loop gap can mean the laptop slept. Charge the scheduled
      // slice, retaining the remaining budget after resume rather than retrying
      // a command whose container-side effects may already have happened.
      remaining -= elapsed > slice + 5000 ? slice : elapsed;
      if (remaining <= 0) { stopped = true; callback(); }
      else schedule();
    }, slice);
  };
  schedule();
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) { clock.clearTimeout(timer); timer = undefined; }
  };
}

export class ContainerProcess {
  readonly process: ChildProcessWithoutNullStreams;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly processKey = randomUUID();
  private stderr = "";
  private stopped = false;
  private inputEnded = false;
  constructor(readonly containerId: string, args: string[], private endpoint?: DockerRuntimeEndpoint, private spawnProcess: SpawnProcess = spawn, cwd?: string, runtime?: "codex" | "claude" | "antigravity") {
    checkContainerId(containerId);
    this.endpoint = Object.freeze({ ...requireEndpoint(endpoint) });
    // A new process group lets interruption terminate the container process and its tools,
    // rather than merely disconnect the Docker client while commands continue invisibly.
    const providerFile = runtime ? `/root/.enoughfactory/providers/${runtime}.env` : undefined;
    const wrapper = `umask 077; export HOME=/root; export CODEX_HOME=/root/.codex; export CLAUDE_CONFIG_DIR=/root/.claude; export PATH=/opt/enoughfactory/node/bin:/root/.local/bin:$PATH; export IS_SANDBOX=1; ${providerFile ? `if [ -f ${quote(providerFile)} ]; then . ${quote(providerFile)}; fi;` : ""} exec setsid --wait sh -c 'echo $$ > "$1"; shift; exec "$@"' enough-agent /tmp/enoughfactory-${this.processKey}.pid "$@"`;
    const invocation = dockerInvocation(this.endpoint, ["exec", "-i", "--user", "0", ...(cwd ? ["--workdir", cwd] : []), containerId, "sh", "-c", wrapper, "enough-agent", ...args]);
    this.process = spawnProcess(invocation.command, invocation.args, { stdio: "pipe", env: invocation.env }) as ChildProcessWithoutNullStreams;
    this.process.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-16_384); });
    this.process.stdin.on("error", () => {});
    this.exit = new Promise((resolve, reject) => {
      this.process.once("error", (error) => reject(new AgentError(error.message, "RUNTIME_START_FAILED")));
      this.process.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Consumers can race completion with exit; avoid an unhandled spawn rejection before then.
    void this.exit.catch(() => {});
  }
  lines(callback: (line: string) => void): void {
    createInterface({ input: this.process.stdout }).on("line", callback);
  }
  write(value: unknown): void {
    if (this.stopped || this.inputEnded || this.process.stdin.destroyed) return;
    this.process.stdin.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  }
  end(): void { this.inputEnded = true; this.process.stdin.end(); }
  errorText(): string { return this.stderr.trim(); }
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const pidFile = `/tmp/enoughfactory-${this.processKey}.pid`;
    const invocation = dockerInvocation(requireEndpoint(this.endpoint), ["exec", "--user", "0", this.containerId, "sh", "-c",
      `p=$(cat ${quote(pidFile)} 2>/dev/null || true); case "$p" in ''|*[!0-9]*) ;; *) /bin/kill -TERM -- -"$p" 2>/dev/null || kill -TERM -"$p" 2>/dev/null || true; sleep 0.2; /bin/kill -KILL -- -"$p" 2>/dev/null || kill -KILL -"$p" 2>/dev/null || true;; esac; rm -f ${quote(pidFile)}`]);
    const cleanup = this.spawnProcess(invocation.command, invocation.args, { stdio: "ignore", env: invocation.env });
    await new Promise<void>((resolve) => {
      cleanup.once("close", () => resolve()); cleanup.once("error", () => resolve());
      const timeout = setTimeout(() => { cleanup.kill(); resolve(); }, 3_000); timeout.unref();
    });
    this.process.stdin.destroy(); this.process.kill("SIGTERM");
  }
}

export async function containerCommand(containerId: string, args: string[], options: { dockerEndpoint?: DockerRuntimeEndpoint; input?: string | Buffer; cwd?: string; timeout?: number; spawnProcess?: SpawnProcess; signal?: AbortSignal } = {}): Promise<string> {
  checkContainerId(containerId);
  if (options.signal?.aborted) throw new AgentError("Container command interrupted.", "INTERRUPTED");
  const invocation = dockerInvocation(requireEndpoint(options.dockerEndpoint), ["exec", "-i", "--user", "0", ...(options.cwd ? ["--workdir", options.cwd] : []), containerId, ...args]);
  const child = (options.spawnProcess ?? spawn)(invocation.command, invocation.args, { stdio: "pipe", env: invocation.env });
  let out = "", err = "";
  child.stdout?.on("data", (chunk) => { out = (out + chunk.toString()).slice(-1_000_000); });
  child.stderr?.on("data", (chunk) => { err = (err + chunk.toString()).slice(-8_000); });
  child.stdin?.on("error", () => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelTimer = () => {};
    const cleanup = (): void => { cancelTimer(); options.signal?.removeEventListener("abort", onAbort); };
    const fail = (error: AgentError, terminate = false): void => {
      if (settled) return;
      settled = true; cleanup();
      if (terminate) {
        child.stdin?.destroy();
        // Terminating the Docker client does not confirm the outcome of arbitrary
        // container effects. Callers must reconcile an uncertain timeout.
        try { child.kill("SIGTERM"); } catch { /* Preserve the original interruption or timeout. */ }
      }
      reject(error);
    };
    const onAbort = (): void => fail(new AgentError("Container command interrupted.", "INTERRUPTED"), true);
    child.once("error", (error) => fail(new AgentError(error.message, "CONTAINER_UNAVAILABLE")));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) { fail(new AgentError(err.trim() || `Container command exited with ${code}.`, "CONTAINER_COMMAND_FAILED")); return; }
      settled = true; cleanup(); resolve(out.trim());
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // The signal can have changed while the child was being spawned.
    if (options.signal?.aborted) { onAbort(); return; }
    cancelTimer = suspendAwareTimeout(() => fail(new AgentError("Container command timed out.", "RUNTIME_TIMEOUT"), true), options.timeout ?? 30_000);
    child.stdin?.end(options.input);
  });
}
