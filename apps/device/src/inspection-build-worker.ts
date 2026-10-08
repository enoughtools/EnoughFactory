import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativeInspectionBackend } from '@enoughfactory/native-inspection';
import { ArtifactStore, verifyInspectionSnapshotContents } from '@enoughfactory/workspaces';
import { NativeInspectionAdapter, type NativeInspectionBuild } from './inspection-native.ts';
import {
  assertPrivateDirectory, nativeBuildProcessIdentity, readPrivateBytes, readPrivateJson, validateRegisteredSnapshot, writeNativeBuildRecord,
  type NativeBuildCompletion, type NativeBuildOwner, type NativeBuildRequest,
} from './inspection-build-runner.ts';

/** The fixed worker owns compilation and teardown even if the device service disappears. */
export async function runNativeBuildWorker(options: {
  /** Focused child-process verification seam, unavailable to author tool requests. */
  build?: (request: NativeBuildRequest, signal: AbortSignal) => Promise<NativeInspectionBuild>;
} = {}): Promise<void> {
  process.umask(0o077);
  const [directory, key] = process.argv.slice(-2);
  if (!directory || directory !== resolve(directory) || !/^[a-f0-9-]{36}$/.test(key ?? '')) throw new Error('Invalid private native worker invocation.');
  await assertPrivateDirectory(directory);
  const requestBytes = await readPrivateBytes(join(directory, 'request.json'));
  const request = JSON.parse(requestBytes.toString()) as NativeBuildRequest;
  const requestSha256 = createHash('sha256').update(requestBytes).digest('hex');
  const initialOwner = await readPrivateJson<NativeBuildOwner>(join(directory, 'owner.json'));
  if (request.version !== 1 || request.key !== key || initialOwner.version !== 1 || initialOwner.key !== key || initialOwner.jobId !== request.jobId
    || initialOwner.requestSha256 !== requestSha256 || initialOwner.status !== 'registered'
    || directory !== join(request.dataDir, 'native-build-runs', request.jobId)) throw new Error('Native worker request does not match its private owner record.');
  await assertPrivateDirectory(request.dataDir);
  await validateRegisteredSnapshot(request.snapshot, request.dataDir, request.verifierOwnedSnapshot);
  const identity = await nativeBuildProcessIdentity(process.pid);
  if (!identity?.includes(key)) throw new Error('Native worker could not establish its process birth identity.');
  const controller = new AbortController();
  let started = false, stopping = false, stopReason: string | undefined;
  let resolveGate!: (start: boolean) => void;
  const gate = new Promise<boolean>(resolveStart => { resolveGate = resolveStart; });
  const stop = (reason: string) => {
    if (stopping) return; stopping = true; stopReason = reason; controller.abort(new Error(reason)); resolveGate(false);
  };
  const term = () => stop('Native build was canceled by its service owner.');
  const interrupt = () => stop('Native build was interrupted.');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inputBytes = 0;
  input.on('line', line => {
    inputBytes += Buffer.byteLength(line);
    if (inputBytes > 64 * 1024) { stop('Native build control transport exceeded its bound.'); return; }
    void (async () => {
      try {
        const message = JSON.parse(line) as { type: string; key: string; requestSha256?: string };
        if (message.key !== key) throw new Error('Native build control owner changed.');
        if (message.type === 'CANCEL') { stop('Native build was canceled by its service owner.'); return; }
        if (message.type !== 'START' || message.requestSha256 !== requestSha256 || started || stopping) throw new Error('Invalid native build start gate.');
        const owner = await readPrivateJson<NativeBuildOwner>(join(directory, 'owner.json'));
        if (owner.key !== key || owner.requestSha256 !== requestSha256 || owner.status !== 'running' || owner.startAuthorized !== true
          || owner.pid !== process.pid || owner.identity !== identity) throw new Error('Native build execution was not durably authorized.');
        if (stopping) return;
        started = true; resolveGate(true);
      } catch (error) { stop(messageOf(error)); }
    })();
  });
  input.once('close', () => stop('The native build service transport closed; its worker canceled and retained the original outcome.'));
  await writeNativeBuildRecord(join(directory, 'ready.json'), { version: 1, key, jobId: request.jobId, pid: process.pid, identity, readyAt: new Date().toISOString() });
  // Readiness itself grants no compiler access. START follows the parent journal fsync/rename.
  process.stdout.write(JSON.stringify({ ready: key, pid: process.pid }) + '\n');
  let build: NativeInspectionBuild | undefined, error: string | undefined, teardownConfirmed = true;
  const backend = new NativeInspectionBackend({ directory: join(request.dataDir, 'native-build-worker-sessions') });
  try {
    if (await gate) {
      const artifacts = new ArtifactStore(request.artifactsRoot, request.deviceId);
      const adapter = new NativeInspectionAdapter({ dataDir: request.dataDir, artifacts, backend,
        ...(request.verifierOwnedSnapshot ? { verifySnapshot: async (snapshot, signal) => {
          // Parent registrations grant only canonical private copies. Verify every original root
          // without rewriting preview/candidate identities to match a manager's storage layout.
          await validateRegisteredSnapshot(snapshot, request.dataDir, request.verifierOwnedSnapshot);
          await verifyInspectionSnapshotContents(snapshot, signal);
        } } : {}),
      });
      build = await (options.build ? options.build(request, controller.signal) : adapter.build(request.snapshot, request.profile, { authority: request.authority, signal: controller.signal }));
      teardownConfirmed = !build.report.cleanupErrors?.length && !build.report.commands.some(command => command.cleanupErrors?.length);
    } else error = stopReason ?? 'Native build was canceled before the execution gate opened.';
  } catch (cause) {
    error = messageOf(cause);
    // A typed unknown outcome survives serialization; never turn a lost compiler into a failed check.
    teardownConfirmed = !(cause && typeof cause === 'object' && ('outcomeUnknown' in cause && cause.outcomeUnknown === true || cause.constructor?.name === 'NativeTeardownError'));
  } finally {
    try { await backend.closeTransport(); } catch (cause) { teardownConfirmed = false; error = `${error ?? ''} Native worker transport teardown was not confirmed: ${messageOf(cause)}`.trim(); }
    const completion: NativeBuildCompletion = { version: 1, key, jobId: request.jobId, requestSha256, pid: process.pid, identity,
      started, teardownConfirmed, canceled: controller.signal.aborted, completedAt: new Date().toISOString(),
      ...(build ? { build } : {}), ...(error ? { error } : {}) };
    await writeNativeBuildRecord(join(directory, 'completion.json'), completion);
    input.close(); process.stdin.destroy();
    process.off('SIGTERM', term); process.off('SIGINT', interrupt);
  }
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runNativeBuildWorker().catch(error => { process.stderr.write(`${messageOf(error)}\n`); process.exitCode = 1; process.stdin.destroy(); });
}
