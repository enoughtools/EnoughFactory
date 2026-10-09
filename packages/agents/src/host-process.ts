import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, type Stats } from "node:fs";
import { uptime } from "node:os";
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
  boot?: HostBootIdentity;
}
export interface HostBootIdentity {
  schemaVersion: 1; platform: "darwin" | "linux"; machineId: string; bootId: string;
  startedAt: string; observedAt: string; uptimeMs: number;
}
/** Positive process termination evidence. This never asserts a successful agent turn. */
interface HostProcessTerminationBase {
  schemaVersion: 2; observedAt: string; currentBoot: HostBootIdentity;
  previousStatus: HostProcessRecord["status"]; previousUpdatedAt: string; priorRecordSha256: string;
}
export interface HostKernelRebootTermination extends HostProcessTerminationBase {
  kind: "host-reboot"; evidence: "boot-identity-change"; previousBoot: HostBootIdentity;
}
export interface HostRebootWitness { path: string; sha256: string; content: string; }
export interface HostOperatorRebootTermination extends HostProcessTerminationBase {
  kind: "operator-attested-reboot"; evidence: "operator-observed-os-restart";
  actor: string; verificationRunId: string; chatId: string; sessionId: string; cwd: string; processKey: string;
  beforeWitness: HostRebootWitness; afterWitness: HostRebootWitness;
}
export interface HostSupervisedTermination extends HostProcessTerminationBase {
  kind: "supervised-termination"; evidence: "complete-owned-teardown";
  processKey: string; sessionId: string; cwd: string; inventoryComplete: true;
  supervisor: { pid: number; identity: string; path: string };
  children: Array<{ pid: number; identity: string }>; exitCode: null; exitSignal: "SIGKILL";
}
export type HostProcessTermination = HostKernelRebootTermination | HostOperatorRebootTermination | HostSupervisedTermination;
export interface HostObservedRebootInput {
  processKey: string; sessionId: string; cwd: string; priorRecordSha256: string; currentBootId: string;
  actor: string; verificationRunId: string; chatId: string;
  beforeWitness: { path: string; sha256: string }; afterWitness: { path: string; sha256: string };
}
export interface HostProcessState {
  processKey: string; sessionId: string; pid?: number; createdAt?: string; cwd?: string;
  state: "active" | "exited" | "unknown"; recordPath: string; termination?: HostProcessTermination;
}
/** Trusted OS probes may be injected by process recovery tests; no request data belongs here. */
export interface HostProcessRecoveryProbes { readBoot?: () => HostBootIdentity | undefined; processIdentity?: (pid: number) => string | undefined; }
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

const statuses = ["starting", "running", "cancellation-requested", "outcome-unknown", "exited"] as const;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}
function validBoot(value: unknown): value is HostBootIdentity {
  const boot = value as HostBootIdentity | undefined;
  return !!boot && boot.schemaVersion === 1 && ["darwin", "linux"].includes(boot.platform) && /^[a-f0-9]{64}$/.test(boot.machineId) && uuid.test(boot.bootId) && timestamp(boot.startedAt) !== undefined && timestamp(boot.observedAt) !== undefined && Number.isFinite(boot.uptimeMs) && boot.uptimeMs >= 0;
}
/** Read identifiers supplied by the kernel, rather than a saved service PID or wall clock alone. */
export function readHostBootIdentity(): HostBootIdentity | undefined {
  try {
    let bootId: string, machineId: string, startedAt: number;
    if (process.platform === "darwin") {
      bootId = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", timeout: 10_000 }).trim().toLowerCase();
      const bootTime = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 10_000 });
      const match = /^\{ sec = (\d+), usec = (\d+) \}/.exec(bootTime);
      if (!match || Number(match[2]) >= 1_000_000) return undefined;
      startedAt = Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000);
      const hardware = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 10_000 });
      const hardwareId = /"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i.exec(hardware)?.[1];
      if (!hardwareId || !uuid.test(hardwareId)) return undefined;
      machineId = createHash("sha256").update(hardwareId.toLowerCase()).digest("hex");
    } else if (process.platform === "linux") {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
      const hardwareId = readFileSync("/etc/machine-id", "utf8").trim().toLowerCase();
      if (!/^[a-f0-9]{32}$/.test(hardwareId)) return undefined;
      machineId = createHash("sha256").update(hardwareId).digest("hex");
      const match = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
      if (!match) return undefined;
      startedAt = Number(match[1]) * 1000;
    } else return undefined;
    const boot: HostBootIdentity = { schemaVersion: 1, platform: process.platform, bootId, machineId, startedAt: new Date(startedAt).toISOString(), observedAt: new Date().toISOString(), uptimeMs: uptime() * 1000 };
    return validBoot(boot) ? boot : undefined;
  } catch { return undefined; }
}

function privateOwnedFile(filename: string): Stats | undefined {
  try {
    const stat = lstatSync(filename);
    return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 ? stat : undefined;
  } catch { return undefined; }
}
function privateOwnedDirectory(directory: string): boolean {
  try { const stat = lstatSync(directory); return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0; }
  catch { return false; }
}
function ownedReceipt(directory: string, filename: string, record: HostProcessRecord): boolean {
  if (timestamp(record.createdAt) === undefined || timestamp(record.updatedAt) === undefined || timestamp(record.updatedAt)! < timestamp(record.createdAt)! || !path.isAbsolute(record.cwd)) return false;
  if (!privateOwnedDirectory(directory) || !privateOwnedFile(filename) || !privateOwnedFile(record.supervisorPath)) return false;
  try { return readFileSync(record.supervisorPath, "utf8") === supervisor; } catch { return false; }
}
function validTermination(value: unknown, record: HostProcessRecord, digest: string): value is HostProcessTermination {
  const proof = value as HostProcessTermination | undefined;
  if (!proof || proof.schemaVersion !== 2 || timestamp(proof.observedAt) === undefined || proof.observedAt !== proof.currentBoot?.observedAt || !validBoot(proof.currentBoot) || proof.priorRecordSha256 !== digest || proof.previousStatus !== record.status || proof.previousUpdatedAt !== record.updatedAt) return false;
  if (proof.kind === "host-reboot") return proof.evidence === "boot-identity-change" && validBoot(proof.previousBoot) && JSON.stringify(proof.previousBoot) === JSON.stringify(record.boot) && proof.previousBoot.machineId === proof.currentBoot.machineId && proof.previousBoot.platform === proof.currentBoot.platform && proof.previousBoot.bootId !== proof.currentBoot.bootId;
  return proof.kind === "operator-attested-reboot" && proof.evidence === "operator-observed-os-restart" && !record.boot && proof.processKey === record.processKey && proof.sessionId === record.sessionId && proof.cwd === record.cwd && operatorIdentity(proof) && validWitness(proof.beforeWitness, "before", proof) && validWitness(proof.afterWitness, "after", proof);
}

function operatorIdentity(input: Pick<HostObservedRebootInput, "actor" | "verificationRunId" | "chatId">): boolean {
  return [input.actor, input.verificationRunId, input.chatId].every(value => typeof value === "string" && /^[a-zA-Z0-9_./:@-]{1,256}$/.test(value));
}
function validWitness(witness: HostRebootWitness, phase: "before" | "after", proof: HostOperatorRebootTermination): boolean {
  if (!witness || !path.isAbsolute(witness.path) || !/^[a-f0-9]{64}$/.test(witness.sha256) || typeof witness.content !== "string" || Buffer.byteLength(witness.content) > 131072 || createHash("sha256").update(witness.content).digest("hex") !== witness.sha256) return false;
  try {
    const manifest = JSON.parse(witness.content) as Record<string, unknown>;
    if (manifest.schemaVersion !== 1 || manifest.kind !== `operator-observed-reboot-${phase}` || timestamp(manifest.observedAt) === undefined || typeof manifest.observation !== "string" || manifest.observation.length < 20 || manifest.observation.length > 4096) return false;
    for (const field of ["actor", "verificationRunId", "chatId", "sessionId", "cwd", "processKey", "priorRecordSha256"] as const) if (manifest[field] !== proof[field]) return false;
    return phase === "before" ? manifest.executionObserved === "running" : manifest.executionObserved === "os-restarted" && manifest.currentBootId === proof.currentBoot.bootId;
  } catch { return false; }
}
function ownedSessionReceipt(directory: string, record: HostProcessRecord): boolean {
  const home = path.dirname(directory), sessionPath = path.join(home, "session.json");
  if (path.basename(directory) !== "processes" || path.basename(home) !== createHash("sha256").update(record.sessionId).digest("hex") || !privateOwnedDirectory(home) || !privateOwnedFile(sessionPath)) return false;
  try {
    const session = JSON.parse(readFileSync(sessionPath, "utf8")) as { schemaVersion?: number; sessionId?: string; cwd?: string; createdAt?: string };
    return session.schemaVersion === 1 && session.sessionId === record.sessionId && session.cwd === record.cwd && timestamp(session.createdAt) !== undefined && realpathSync(directory) === path.resolve(directory);
  } catch { return false; }
}

/** Privileged local operator migration for pre-boot-UUID journals only. Never
 * exposed to an author, model tool or automatic recovery. The caller explicitly
 * attests their observed OS restart; this is not historical kernel UUID proof. */
export function attestLegacyHostReboot(directory: string, input: HostObservedRebootInput): HostOperatorRebootTermination {
  if (!operatorIdentity(input) || !uuid.test(input.processKey) || !uuid.test(input.currentBootId) || !/^[a-f0-9]{64}$/.test(input.priorRecordSha256) || !input.sessionId || !path.isAbsolute(input.cwd)) throw new AgentError("The operator reboot attestation identity is invalid.", "HOST_REBOOT_ATTESTATION_INVALID");
  const selected = records(directory).find(entry => entry.record.processKey === input.processKey);
  if (!selected) throw new AgentError("The exact original host process receipt is unavailable.", "HOST_REBOOT_ATTESTATION_INVALID");
  const { record, filename } = selected;
  const original = readFileSync(filename), digest = createHash("sha256").update(original).digest("hex");
  if (record.boot || record.status === "exited" || digest !== input.priorRecordSha256 || record.sessionId !== input.sessionId || record.cwd !== input.cwd || !ownedReceipt(directory, filename, record) || !ownedSessionReceipt(directory, record)) throw new AgentError("The original legacy host process ownership changed.", "HOST_REBOOT_ATTESTATION_INVALID");
  const boot = readHostBootIdentity();
  if (!boot || boot.bootId !== input.currentBootId.toLowerCase()) throw new AgentError("The current host boot no longer matches the operator observation.", "HOST_REBOOT_ATTESTATION_INVALID");
  if (record.pid && ownedIdentity(record, processIdentity(record.pid)) || (record.children ?? []).some(child => processIdentity(child.pid) === child.identity)) throw new AgentError("The original host process still has a matching live owner.", "HOST_PROCESS_ACTIVE");
  const readWitness = (reference: HostObservedRebootInput["beforeWitness"]): HostRebootWitness => {
    if (!reference || !path.isAbsolute(reference.path) || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new AgentError("The reboot observation witness is invalid.", "HOST_REBOOT_ATTESTATION_INVALID");
    const stat = lstatSync(reference.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 131072) throw new AgentError("The reboot observation witness ownership changed.", "HOST_REBOOT_ATTESTATION_INVALID");
    return { ...reference, content: readFileSync(reference.path, "utf8") };
  };
  const proof: HostOperatorRebootTermination = { schemaVersion: 2, kind: "operator-attested-reboot", evidence: "operator-observed-os-restart", actor: input.actor, verificationRunId: input.verificationRunId, chatId: input.chatId, sessionId: input.sessionId, cwd: input.cwd, processKey: input.processKey, observedAt: boot.observedAt, currentBoot: boot, previousStatus: record.status, previousUpdatedAt: record.updatedAt, priorRecordSha256: digest, beforeWitness: readWitness(input.beforeWitness), afterWitness: readWitness(input.afterWitness) };
  if (!validTermination(proof, record, digest)) throw new AgentError("The reboot observations do not match this original execution.", "HOST_REBOOT_ATTESTATION_INVALID");
  const proofPath = path.join(directory, `${record.processKey}.operator-reboot.json`);
  try {
    const stat = lstatSync(proofPath);
    if (!privateOwnedFile(proofPath) || stat.size > 524288) throw new AgentError("The previous reboot attestation is not an owned receipt.", "HOST_REBOOT_ATTESTATION_INVALID");
    const existing: unknown = JSON.parse(readFileSync(proofPath, "utf8"));
    if (validTermination(existing, record, digest) && existing.kind === "operator-attested-reboot" && existing.currentBoot.bootId === boot.bootId && existing.actor === proof.actor && existing.verificationRunId === proof.verificationRunId && existing.chatId === proof.chatId && existing.beforeWitness.sha256 === proof.beforeWitness.sha256 && existing.afterWitness.sha256 === proof.afterWitness.sha256) return existing;
    throw new AgentError("A different reboot attestation already exists for this process.", "HOST_REBOOT_ATTESTATION_INVALID");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (createHash("sha256").update(readFileSync(filename)).digest("hex") !== digest || record.pid && ownedIdentity(record, processIdentity(record.pid)) || (record.children ?? []).some(child => processIdentity(child.pid) === child.identity) || readHostBootIdentity()?.bootId !== boot.bootId) throw new AgentError("Host ownership changed while recording the reboot observation.", "HOST_PROCESS_UNKNOWN");
  writeFileSync(proofPath, JSON.stringify(proof), { flag: "wx", mode: 0o600 });
  return proof;
}

function rebootTermination(directory: string, filename: string, record: HostProcessRecord, boot: HostBootIdentity | undefined, identity: string | undefined, probeIdentity: (pid: number) => string | undefined): HostProcessTermination | undefined {
  if (!boot || !validBoot(boot) || ownedIdentity(record, identity) || !ownedReceipt(directory, filename, record)) return undefined;
  const digest = createHash("sha256").update(readFileSync(filename)).digest("hex"), proofPath = path.join(directory, `${record.processKey}.reboot.json`);
  try { if ((record.children ?? []).some(child => probeIdentity(child.pid) === child.identity)) return undefined; }
  catch { return undefined; }
  let automaticProofExists = false;
  for (const candidate of [proofPath, path.join(directory, `${record.processKey}.operator-reboot.json`)]) {
    try {
      const stat = lstatSync(candidate);
      if (candidate === proofPath) automaticProofExists = true;
      if (!privateOwnedFile(candidate) || stat.size > 524288) continue;
      const proof: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (validTermination(proof, record, digest) && proof.currentBoot.machineId === boot.machineId && proof.currentBoot.platform === boot.platform && (proof.kind !== "operator-attested-reboot" || ownedSessionReceipt(directory, record))) return proof;
    } catch { /* Invalid or old proofs remain available for diagnosis, never authorizing a retry. */ }
  }
  if (automaticProofExists) return undefined;
  // An old wall timestamp cannot replace a historical boot UUID: a clock step
  // can also move kern.boottime past that timestamp without ending any process.
  if (!validBoot(record.boot) || record.boot.machineId !== boot.machineId || record.boot.platform !== boot.platform || record.boot.bootId === boot.bootId) return undefined;
  const proof: HostKernelRebootTermination = { schemaVersion: 2, kind: "host-reboot", evidence: "boot-identity-change", observedAt: boot.observedAt, currentBoot: boot, previousBoot: record.boot, previousStatus: record.status, previousUpdatedAt: record.updatedAt, priorRecordSha256: digest };
  // Keep the original running/unknown receipt byte-for-byte for audit. The
  // separate positive termination proof fences retries without fabricating EOF.
  try { writeFileSync(proofPath, JSON.stringify(proof), { flag: "wx", mode: 0o600 }); }
  catch { return undefined; }
  return proof;
}

/** The durable cancellation receipt is written only after a frozen, complete
 * child inventory and positive owned-process teardown. Transport EOF alone,
 * missing PIDs or an idle conversation cannot create this evidence. */
function supervisedTermination(directory: string, filename: string, record: HostProcessRecord, boot: HostBootIdentity | undefined, probeIdentity: (pid: number) => string | undefined): HostSupervisedTermination | undefined {
  if (record.status !== "exited" || record.inventoryComplete !== true || record.exitCode !== null || record.exitSignal !== "SIGKILL" || !record.pid || !record.identity || !ownedIdentity(record, record.identity) || !Array.isArray(record.children) || !validBoot(record.boot) || !boot || !validBoot(boot) || record.boot.machineId !== boot.machineId || record.boot.platform !== boot.platform || !ownedReceipt(directory, filename, record)) return undefined;
  if (ownedIdentity(record, probeIdentity(record.pid)) || record.children.some(child => probeIdentity(child.pid) === child.identity)) return undefined;
  return {
    schemaVersion: 2, kind: "supervised-termination", evidence: "complete-owned-teardown", observedAt: record.updatedAt,
    currentBoot: boot, previousStatus: "exited", previousUpdatedAt: record.updatedAt,
    priorRecordSha256: createHash("sha256").update(readFileSync(filename)).digest("hex"),
    processKey: record.processKey, sessionId: record.sessionId, cwd: record.cwd, inventoryComplete: true,
    supervisor: { pid: record.pid, identity: record.identity, path: record.supervisorPath }, children: structuredClone(record.children), exitCode: null, exitSignal: "SIGKILL",
  };
}

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
      if (record.schemaVersion !== 1 || `${record.processKey}.json` !== name || record.supervisorPath !== path.join(directory, `${record.processKey}.cjs`) || !record.sessionId || !statuses.includes(record.status) || record.boot !== undefined && !validBoot(record.boot) || record.pid !== undefined && (!Number.isSafeInteger(record.pid) || record.pid < 2) || record.children !== undefined && (!Array.isArray(record.children) || record.children.length > 2048 || record.children.some(child => !child || !Number.isSafeInteger(child.pid) || child.pid < 2 || typeof child.identity !== "string" || !child.identity || child.identity.length > 65536))) throw new AgentError("Host process record is invalid.", "HOST_STORAGE_UNSAFE");
      return { filename, record };
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Reconcile without interpreting a missing transport as successful task completion. */
export function reconcileHostProcesses(directory: string, probes: HostProcessRecoveryProbes = {}): HostProcessState[] {
  let boot: HostBootIdentity | undefined, bootRead = false;
  const probeIdentity = probes.processIdentity ?? processIdentity;
  return records(directory).map(({ filename, record }) => {
    const state = { processKey: record.processKey, sessionId: record.sessionId, pid: record.pid, createdAt: record.createdAt, cwd: record.cwd, recordPath: filename };
    if (record.status === "exited") {
      if (record.inventoryComplete !== true) return { ...state, state: "exited" };
      if (!bootRead) { bootRead = true; boot = (probes.readBoot ?? readHostBootIdentity)(); }
      try {
        if (record.pid && ownedIdentity(record, probeIdentity(record.pid)) || (record.children ?? []).some(child => probeIdentity(child.pid) === child.identity)) return { ...state, state: "unknown" };
        const termination = supervisedTermination(directory, filename, record, boot, probeIdentity);
        return { ...state, state: "exited", ...(termination ? { termination } : {}) };
      } catch { return { ...state, state: "unknown" }; }
    }
    if (!bootRead) { bootRead = true; boot = (probes.readBoot ?? readHostBootIdentity)(); }
    let identity: string | undefined;
    try { if (record.pid) identity = probeIdentity(record.pid); } catch { return { ...state, state: "unknown" }; }
    const termination = rebootTermination(directory, filename, record, boot, identity, probeIdentity);
    if (termination) return { ...state, state: "exited", termination };
    return { ...state, state: ownedIdentity(record, identity) ? "active" : "unknown" };
  });
}

/** Cancel only a currently verified owned group. Recovery never signals an arbitrary saved PID. */
export async function cancelHostProcess(directory: string, processKey: string): Promise<boolean> {
  if (reconcileHostProcesses(directory).find(record => record.processKey === processKey)?.state === "exited") return false;
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
    const boot = readHostBootIdentity();
    if (!boot) throw new AgentError("The host boot identity cannot be verified yet.", "HOST_BOOT_UNAVAILABLE");
    mkdirSync(options.processDirectory, { recursive: true, mode: 0o700 });
    const status = lstatSync(options.processDirectory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new AgentError("Host process storage ownership changed.", "HOST_STORAGE_UNSAFE");
    this.recordPath = path.join(options.processDirectory, `${this.processKey}.json`);
    const supervisorPath = path.join(options.processDirectory, `${this.processKey}.cjs`);
    writeFileSync(supervisorPath, supervisor, { flag: "wx", mode: 0o600 });
    this.record = { schemaVersion: 1, processKey: this.processKey, sessionId: options.sessionId, supervisorPath, cwd: options.cwd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "starting", boot };
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
