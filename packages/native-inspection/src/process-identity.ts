import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { NativeInspectionError } from './types.js';

const execute = promisify(execFile);
const probeTimeoutMs = 2_000;
const terminateGraceMs = 2_500;
const killGraceMs = 1_500;
const pollIntervalMs = 75;
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Persist only process identity, never arbitrary arguments or credentials. */
export interface OwnedProcessIdentity {
  pid: number;
  pgid: number;
  /** Canonical UTC representation of ps lstart (second precision). */
  startedAt: string;
  commandSha256: string;
}

function ownershipUnknown(): NativeInspectionError {
  // Child-process errors can contain argv/stdout. Never wrap or expose them.
  return new NativeInspectionError('ownership-unknown', 'The native runner process identity could not be confirmed; no unverified process was signaled.');
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
}

function validIdentity(identity: OwnedProcessIdentity): boolean {
  return validPid(identity.pid) && validPid(identity.pgid)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(identity.startedAt)
    && /^[0-9a-f]{64}$/.test(identity.commandSha256);
}

/** Capture exactly one PID through ps; absent is distinct from an unreadable probe. */
export async function captureProcessIdentity(pid: number): Promise<OwnedProcessIdentity | undefined> {
  if (!validPid(pid)) throw ownershipUnknown();
  let stdout: string;
  try {
    const result = await execute('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command='], {
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
      encoding: 'utf8', timeout: probeTimeoutMs, maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: unknown; stderr?: unknown };
    // Darwin and Linux ps return 1 with no output when the requested PID is gone.
    if (failure.code === 1 && typeof failure.stdout === 'string' && !failure.stdout.trim()
      && typeof failure.stderr === 'string' && !failure.stderr.trim()) return undefined;
    throw ownershipUnknown();
  }
  if (!stdout.trim()) return undefined;
  const match = /^\s*(\d+)\s+(\d+)\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})[ \t]+([\s\S]*?)\r?\n?$/.exec(stdout);
  if (!match || Number(match[1]) !== pid || !validPid(Number(match[2]))) throw ownershipUnknown();
  const month = months.indexOf(match[3]!);
  const day = Number(match[4]); const hour = Number(match[5]);
  const minute = Number(match[6]); const second = Number(match[7]); const year = Number(match[8]);
  const start = new Date(Date.UTC(year, month, day, hour, minute, second));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month || start.getUTCDate() !== day
    || start.getUTCHours() !== hour || start.getUTCMinutes() !== minute || start.getUTCSeconds() !== second || !match[9]) throw ownershipUnknown();
  return {
    pid,
    pgid: Number(match[2]),
    startedAt: start.toISOString(),
    commandSha256: createHash('sha256').update(match[9], 'utf8').digest('hex'),
  };
}

export function matchesProcessIdentity(expected: OwnedProcessIdentity, actual: OwnedProcessIdentity | undefined): boolean {
  return Boolean(actual && validIdentity(expected) && validIdentity(actual)
    && expected.pid === actual.pid && expected.pgid === actual.pgid
    && expected.startedAt === actual.startedAt && expected.commandSha256 === actual.commandSha256);
}

function originalExited(expected: OwnedProcessIdentity, actual: OwnedProcessIdentity | undefined): boolean {
  // A different birth time proves PID reuse. Mutable argv/group changes alone
  // do not prove exit, so retain uncertainty rather than killing a replacement.
  return actual === undefined || actual.startedAt !== expected.startedAt;
}

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function waitForOriginalExit(identity: OwnedProcessIdentity, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  do {
    const current = await captureProcessIdentity(identity.pid);
    if (originalExited(identity, current)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

function signalOwnedPid(identity: OwnedProcessIdentity, signal: NodeJS.Signals): void {
  try {
    // Never use a negative PID. Other children in the group have not acquired
    // their own verified identities; simulator teardown owns their lifecycle.
    process.kill(identity.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw ownershipUnknown();
    // Reconcile after ESRCH rather than assuming the outcome of a racing exit.
  }
}

/**
 * Stop one coordinator-recorded PID. Caller must capture this identity directly
 * from its own spawn, not accept an arbitrary client-supplied identity.
 * ps has second precision, and validation/signaling cannot be atomic on macOS;
 * rechecking the full tuple is a conservative fence, not a kernel process handle.
 */
export async function stopOwnedProcess(identity: OwnedProcessIdentity): Promise<{ originalProcessExited: true; alreadyExited: boolean }> {
  if (!validIdentity(identity) || identity.pid <= 1 || identity.pid === process.pid) throw ownershipUnknown();
  const initial = await captureProcessIdentity(identity.pid);
  if (originalExited(identity, initial)) return { originalProcessExited: true, alreadyExited: true };
  if (!matchesProcessIdentity(identity, initial)) throw ownershipUnknown();
  signalOwnedPid(identity, 'SIGTERM');
  if (await waitForOriginalExit(identity, terminateGraceMs)) return { originalProcessExited: true, alreadyExited: false };

  // The PID may have exited or been reused during the grace period. Check its
  // exact identity again immediately before any escalation.
  const beforeKill = await captureProcessIdentity(identity.pid);
  if (originalExited(identity, beforeKill)) return { originalProcessExited: true, alreadyExited: false };
  if (!matchesProcessIdentity(identity, beforeKill)) throw ownershipUnknown();
  signalOwnedPid(identity, 'SIGKILL');
  if (await waitForOriginalExit(identity, killGraceMs)) return { originalProcessExited: true, alreadyExited: false };
  throw ownershipUnknown();
}
