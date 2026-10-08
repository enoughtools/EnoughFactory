import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentProcess, SpawnProcess } from "./process.ts";
import { AgentError } from "./types.ts";

interface HostProcessRecord {
  schemaVersion: 1; processKey: string; sessionId: string; pid?: number; identity?: string;
  supervisorPath: string; cwd: string; createdAt: string; updatedAt: string;
  status: "starting" | "running" | "cancellation-requested" | "outcome-unknown" | "exited";
  exitCode?: number | null; exitSignal?: NodeJS.Signals | null;
  children?: Array<{ pid: number; identity: string }>;
  inventoryComplete?: boolean;
}
export interface HostProcessState { processKey: string; sessionId: string; pid?: number; state: "active" | "exited" | "unknown"; recordPath: string; }
export interface HostProcessOptions {
  cwd: string; environment: NodeJS.ProcessEnv; processDirectory: string; sessionId: string;
  spawnProcess?: SpawnProcess;
}

// The supervisor keeps a stable, uniquely identifiable group leader while Codex
// and its children run. Neither recovery nor cancellation trusts a recycled PID.
const supervisor = `const { spawn } = require('node:child_process');
process.umask(0o077);
process.stdout.write(JSON.stringify({ enoughfactorySupervisorReady: process.argv[2], pid: process.pid }) + '\\n');
const child = spawn(process.argv[3], process.argv.slice(4), { stdio: 'inherit', env: process.env });
const terminate = signal => { try { child.kill(signal); } catch {} };
process.on('SIGTERM', () => terminate('SIGTERM'));
process.on('SIGINT', () => terminate('SIGINT'));
child.on('error', error => { console.error(error.message); process.exit(127); });
child.on('close', (code, signal) => {
  // Remain identifiable until the group is gone, including a tool that ignores TERM.
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(typeof code === 'number' ? code : 1); } }, 300);
});
`;

function processIdentity(pid: number): string | undefined {
  try { return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 10_000 }).trim(); }
  catch (error) {
    if ((error as { status?: number }).status === 1) return undefined;
    throw new AgentError("The host process owner cannot be reconciled yet.", "HOST_PROCESS_UNKNOWN");
  }
}
function ownedIdentity(record: HostProcessRecord, identity: string | undefined): boolean {
  return !!identity && (!record.identity || identity === record.identity) && identity.includes(record.supervisorPath) && identity.includes(record.processKey);
}
function childIdentities(rootPid: number): Array<{ pid: number; identity: string }> {
  let rows: string;
  try { rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 10_000 }); }
  catch { throw new AgentError("Owned host tools cannot be reconciled yet.", "HOST_PROCESS_UNKNOWN"); }
  const descendants: number[] = [], parents = new Set([rootPid]);
  const processes = rows.trim().split("\n").map(row => row.trim().split(/\s+/).map(Number));
  for (let index = 0; index < processes.length; index++) {
    let changed = false;
    for (const [pid, parent] of processes) if (pid && pid !== rootPid && parents.has(parent!) && !parents.has(pid)) { parents.add(pid); descendants.push(pid); changed = true; }
    if (!changed) break;
  }
  return descendants.reverse().flatMap(pid => { const identity = processIdentity(pid); return identity ? [{ pid, identity }] : []; });
}
function signalOwnedChild(child: { pid: number; identity: string }, signal: NodeJS.Signals): boolean {
  if (processIdentity(child.pid) !== child.identity) return false;
  try { process.kill(child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  return true;
}
function signalSupervisor(record: HostProcessRecord, signal: NodeJS.Signals): boolean {
  if (!record.pid || !ownedIdentity(record, processIdentity(record.pid))) return false;
  // Every descendant is handled independently above. Signal the verified PID,
  // avoiding a group identity race as the supervisor tears its group down.
  try { process.kill(record.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM" && !ownedIdentity(record, processIdentity(record.pid))) return false;
    throw error;
  }
  return true;
}
function unionChildren(...lists: Array<Array<{ pid: number; identity: string }>>): Array<{ pid: number; identity: string }> {
  const entries = new Map<string, { pid: number; identity: string }>();
  for (const child of lists.flat()) if (processIdentity(child.pid) === child.identity) entries.set(`${child.pid}:${child.identity}`, child);
  return [...entries.values()];
}
function writeRecord(filename: string, record: HostProcessRecord): void {
  const stage = `${filename}.${randomUUID()}.tmp`;
  writeFileSync(stage, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  renameSync(stage, filename);
}
function records(directory: string): Array<{ filename: string; record: HostProcessRecord }> {
  try {
    const dir = lstatSync(directory);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new AgentError("Host process storage ownership changed.", "HOST_STORAGE_UNSAFE");
    return readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
      const filename = path.join(directory, name), stat = lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new AgentError("Host process record ownership changed.", "HOST_STORAGE_UNSAFE");
      const record = JSON.parse(readFileSync(filename, "utf8")) as HostProcessRecord;
      if (record.schemaVersion !== 1 || `${record.processKey}.json` !== name || record.supervisorPath !== path.join(directory, `${record.processKey}.cjs`) || !record.sessionId || !["starting", "running", "cancellation-requested", "outcome-unknown", "exited"].includes(record.status) || record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid < 2) || record.children !== undefined && (!Array.isArray(record.children) || record.children.length > 2048 || record.children.some(child => !child || !Number.isSafeInteger(child.pid) || child.pid < 2 || typeof child.identity !== "string" || !child.identity || child.identity.length > 65536))) throw new AgentError("Host process record is invalid.", "HOST_STORAGE_UNSAFE");
      return { filename, record };
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Reconcile without interpreting a missing transport as successful task completion. */
export function reconcileHostProcesses(directory: string): HostProcessState[] {
  return records(directory).map(({ filename, record }) => {
    if (record.status === "exited") return { processKey: record.processKey, sessionId: record.sessionId, pid: record.pid, state: "exited", recordPath: filename };
    let identity: string | undefined;
    try { if (record.pid) identity = processIdentity(record.pid); } catch { /* Unreadable ownership stays unknown. */ }
    return { processKey: record.processKey, sessionId: record.sessionId, pid: record.pid, state: ownedIdentity(record, identity) ? "active" : "unknown", recordPath: filename };
  });
}

/** Cancel only a currently verified owned group. Recovery never signals an arbitrary saved PID. */
export async function cancelHostProcess(directory: string, processKey: string): Promise<boolean> {
  const selected = records(directory).find(entry => entry.record.processKey === processKey);
  if (!selected || selected.record.status === "exited") return false;
  const { record, filename } = selected;
  const leaderOwned = !!record.pid && ownedIdentity(record, processIdentity(record.pid));
  record.status = "cancellation-requested"; record.updatedAt = new Date().toISOString(); writeRecord(filename, record);
  if (!leaderOwned) {
    // A lost leader does not authorize signalling its recycled PID. Known tool
    // identities can still be retired, while completeness remains unknown.
    for (const child of unionChildren(record.children ?? [])) signalOwnedChild(child, "SIGKILL");
    record.status = "outcome-unknown"; record.updatedAt = new Date().toISOString(); writeRecord(filename, record);
    throw new AgentError("The host process outcome is unknown; reconcile it before starting a replacement.", "HOST_PROCESS_UNKNOWN");
  }
  // Freeze and rescan before termination. A single live-tree scan can miss a
  // tool that forks while its parent is being interrupted, including new groups.
  if (!signalSupervisor(record, "SIGSTOP")) throw new AgentError("Host process ownership changed during cancellation.", "HOST_PROCESS_UNKNOWN");
  let children = unionChildren(record.children ?? []), stable = false;
  for (let round = 0; round < 6; round++) {
    const observed = childIdentities(record.pid!);
    const known = new Set(children.map(child => `${child.pid}:${child.identity}`));
    children = unionChildren(children, observed);
    for (const child of children) signalOwnedChild(child, "SIGSTOP");
    if (observed.every(child => known.has(`${child.pid}:${child.identity}`))) { stable = true; break; }
  }
  record.children = children; record.inventoryComplete = stable; record.updatedAt = new Date().toISOString(); writeRecord(filename, record);
  if (!stable) throw new AgentError("Host tools are still changing during cancellation; their ownership remains reserved.", "HOST_PROCESS_UNKNOWN");
  // All owned parents are now stopped, so they cannot spawn another tool between
  // the final inventory and termination. Do not resume them into new effects.
  for (const child of children) signalOwnedChild(child, "SIGKILL");
  signalSupervisor(record, "SIGKILL");
  const deadline = Date.now() + 3000;
  while (ownedIdentity(record, processIdentity(record.pid!)) || unionChildren(children).length) {
    if (Date.now() >= deadline) throw new AgentError("Owned host processes have not confirmed termination yet.", "HOST_PROCESS_UNKNOWN");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  record.status = "exited"; record.exitCode = null; record.exitSignal = "SIGKILL"; record.updatedAt = new Date().toISOString(); writeRecord(filename, record);
  return true;
}

export class HostProcess implements AgentProcess {
  readonly processKey = randomUUID();
  readonly process: ChildProcessWithoutNullStreams;
  readonly exit: AgentProcess["exit"];
  readonly ready: Promise<void>;
  private stderr = "";
  private stopped = false;
  private stopping?: Promise<void>;
  private inputEnded = false;
  private record: HostProcessRecord;
  private recordPath: string;
  private observeTimer?: ReturnType<typeof setInterval>;
  private listeners = new Set<(line: string) => void>();
  private isReady = false;
  private pendingWrites: unknown[] = [];
  constructor(command: string, args: string[], private options: HostProcessOptions) {
    mkdirSync(options.processDirectory, { recursive: true, mode: 0o700 });
    const status = lstatSync(options.processDirectory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new AgentError("Host process storage ownership changed.", "HOST_STORAGE_UNSAFE");
    this.recordPath = path.join(options.processDirectory, `${this.processKey}.json`);
    const supervisorPath = path.join(options.processDirectory, `${this.processKey}.cjs`);
    writeFileSync(supervisorPath, supervisor, { flag: "wx", mode: 0o600 });
    this.record = { schemaVersion: 1, processKey: this.processKey, sessionId: options.sessionId, supervisorPath, cwd: options.cwd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "starting" };
    writeRecord(this.recordPath, this.record);
    this.process = (options.spawnProcess ?? spawn)(command, [supervisorPath, this.processKey, command, ...args], { cwd: options.cwd, env: options.environment, stdio: "pipe", detached: true }) as ChildProcessWithoutNullStreams;
    this.record.pid = this.process.pid;
    // Fake transports used by protocol tests do not have a PID. Real transports must.
    if (this.process.pid) {
      try { const identity = processIdentity(this.process.pid); if (ownedIdentity(this.record, identity)) this.record.identity = identity; } catch { /* Keep unknown, fenced ownership. */ }
    }
    this.record.updatedAt = new Date().toISOString(); writeRecord(this.recordPath, this.record);
    this.process.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString()).slice(-16384); });
    this.process.stdin.on("error", () => {});
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    this.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }); void this.ready.catch(() => {});
    createInterface({ input: this.process.stdout }).on("line", line => {
      if (!this.isReady) {
        let value: { enoughfactorySupervisorReady?: string; pid?: number };
        try { value = JSON.parse(line); } catch { readyReject(new AgentError("Host supervisor readiness was malformed.", "RUNTIME_START_FAILED")); return; }
        if (value.enoughfactorySupervisorReady !== this.processKey || value.pid !== this.process.pid) { readyReject(new AgentError("Host supervisor readiness did not match its owner.", "RUNTIME_START_FAILED")); return; }
        try {
          const identity = processIdentity(this.process.pid!);
          if (!ownedIdentity(this.record, identity)) throw new AgentError("Host supervisor ownership could not be established.", "HOST_PROCESS_UNKNOWN");
          this.record.identity = identity; this.record.status = "running"; this.record.updatedAt = new Date().toISOString();
          this.record.children = unionChildren(this.record.children ?? [], childIdentities(this.process.pid!)); writeRecord(this.recordPath, this.record);
          this.isReady = true; readyResolve();
          const pending = this.pendingWrites.splice(0); for (const entry of pending) this.write(entry);
        } catch (error) { readyReject(error instanceof Error ? error : new Error(String(error))); }
        return;
      }
      for (const listener of this.listeners) listener(line);
    });
    this.observeTimer = setInterval(() => {
      if (this.stopped || !this.isReady || this.record.status !== "running" || !this.process.pid) return;
      try { this.record.children = unionChildren(this.record.children ?? [], childIdentities(this.process.pid)); this.record.updatedAt = new Date().toISOString(); writeRecord(this.recordPath, this.record); }
      catch { /* An incomplete probe is not termination or a reason to dispatch a replacement. */ }
    }, 2000); this.observeTimer.unref();
    let failedToSpawn = false;
    this.exit = new Promise((resolve, reject) => {
      this.process.once("error", error => {
        failedToSpawn = true; if (this.observeTimer) clearInterval(this.observeTimer);
        this.record.status = "exited"; this.record.updatedAt = new Date().toISOString(); writeRecord(this.recordPath, this.record);
        readyReject(new AgentError(error.message, "RUNTIME_START_FAILED"));
        reject(new AgentError(error.message, "RUNTIME_START_FAILED"));
      });
      this.process.once("close", (code, signal) => {
        if (this.observeTimer) clearInterval(this.observeTimer);
        if (!this.isReady) readyReject(new AgentError("Host supervisor ended before establishing ownership.", "RUNTIME_START_FAILED"));
        this.record.exitCode = code; this.record.exitSignal = signal; this.record.updatedAt = new Date().toISOString();
        if (!this.stopped && !failedToSpawn) { this.record.status = "outcome-unknown"; writeRecord(this.recordPath, this.record); }
        resolve({ code, signal });
      });
    });
    void this.exit.catch(() => {});
  }
  lines(callback: (line: string) => void): void { this.listeners.add(callback); }
  write(value: unknown): void {
    if (this.stopped || this.inputEnded || this.process.stdin.destroyed) return;
    if (!this.isReady) { this.pendingWrites.push(value); return; }
    this.process.stdin.write(typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
  }
  end(): void { this.inputEnded = true; this.process.stdin.end(); }
  errorText(): string { return this.stderr.trim(); }
  stop(): Promise<void> {
    if (!this.stopping) this.stopping = this.stopOwned();
    return this.stopping;
  }
  private async stopOwned(): Promise<void> {
    this.stopped = true;
    if (this.observeTimer) clearInterval(this.observeTimer);
    if (!this.process.pid) { this.process.kill("SIGTERM"); return; }
    if (this.record.status === "exited") return;
    // Capture ownership while the app-server's stdin is still open. Closing it
    // first can let Codex exit and reparent detached tools before reconciliation.
    await cancelHostProcess(this.options.processDirectory, this.processKey);
    this.record.status = "exited";
    this.process.stdin.destroy();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.exit, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new AgentError("The host author process has not confirmed its exit yet.", "HOST_PROCESS_UNKNOWN")), 3000); })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
}
