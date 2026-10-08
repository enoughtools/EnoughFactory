import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { captureProcessIdentity, matchesProcessIdentity, stopOwnedProcess, type OwnedProcessIdentity } from './process-identity.js';
import { NativeInspectionError } from './types.js';

async function childRunner(options: { detached?: boolean; ignoreTerm?: boolean } = {}): Promise<{ child: ChildProcess; identity: OwnedProcessIdentity; exited: Promise<unknown[]> }> {
  const code = `${options.ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}process.stdout.write("ready\\n");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code, '--', 'private-runner-argument-must-not-be-durable'], {
    detached: options.detached ?? true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const exited = once(child, 'exit');
  assert.ok(child.pid);
  await Promise.race([once(child.stdout!, 'data'), exited.then(() => { throw new Error('Owned test child exited before readiness.'); })]);
  const identity = await captureProcessIdentity(child.pid);
  assert.ok(identity);
  return { child, identity, exited };
}

async function cleanupChild(child: ChildProcess, identity: OwnedProcessIdentity): Promise<void> {
  const current = await captureProcessIdentity(identity.pid);
  if (matchesProcessIdentity(identity, current)) child.kill('SIGKILL');
}

test('captured identity is stable, canonical and retains no raw process arguments', async () => {
  const { child, identity, exited } = await childRunner();
  try {
    const second = await captureProcessIdentity(identity.pid);
    assert.equal(matchesProcessIdentity(identity, second), true);
    assert.equal(identity.pgid, identity.pid);
    assert.match(identity.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    assert.match(identity.commandSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(identity).sort(), ['commandSha256', 'pgid', 'pid', 'startedAt']);
    assert.equal(JSON.stringify(identity).includes('private-runner-argument'), false);
    assert.deepEqual(await stopOwnedProcess(identity), { originalProcessExited: true, alreadyExited: false });
    await exited;
    assert.equal(await captureProcessIdentity(identity.pid), undefined);
    assert.deepEqual(await stopOwnedProcess(identity), { originalProcessExited: true, alreadyExited: true });
  } finally { await cleanupChild(child, identity); }
});

test('an inherited process group does not cause parent or sibling signaling', async () => {
  const { child, identity, exited } = await childRunner({ detached: false });
  try {
    assert.notEqual(identity.pgid, identity.pid);
    assert.deepEqual(await stopOwnedProcess(identity), { originalProcessExited: true, alreadyExited: false });
    await exited;
    assert.ok(await captureProcessIdentity(process.pid));
  } finally { await cleanupChild(child, identity); }
});

test('a changed birth identity never kills the process occupying that PID', async () => {
  const { child, identity, exited } = await childRunner();
  try {
    const differentBirth = { ...identity, startedAt: '2000-01-01T00:00:00.000Z' };
    assert.deepEqual(await stopOwnedProcess(differentBirth), { originalProcessExited: true, alreadyExited: true });
    assert.equal(matchesProcessIdentity(identity, await captureProcessIdentity(identity.pid)), true);
    await stopOwnedProcess(identity); await exited;
  } finally { await cleanupChild(child, identity); }
});

test('same-birth command or group mismatch remains unknown and is not signaled', async () => {
  const { child, identity, exited } = await childRunner();
  try {
    for (const changed of [{ ...identity, commandSha256: '0'.repeat(64) }, { ...identity, pgid: identity.pgid + 1 }]) {
      await assert.rejects(stopOwnedProcess(changed), (error: unknown) => error instanceof NativeInspectionError && error.code === 'ownership-unknown');
      assert.equal(matchesProcessIdentity(identity, await captureProcessIdentity(identity.pid)), true);
    }
    await assert.rejects(stopOwnedProcess({ ...identity, pid: process.pid }), (error: unknown) => error instanceof NativeInspectionError && error.code === 'ownership-unknown');
    await stopOwnedProcess(identity); await exited;
  } finally { await cleanupChild(child, identity); }
});

test('an owned child that ignores TERM is revalidated and stopped with bounded escalation', async () => {
  const { child, identity, exited } = await childRunner({ ignoreTerm: true });
  try {
    const began = Date.now();
    assert.deepEqual(await stopOwnedProcess(identity), { originalProcessExited: true, alreadyExited: false });
    await exited;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.ok(Date.now() - began < 10_000);
  } finally { await cleanupChild(child, identity); }
});

test('matching requires every captured field and invalid IDs never reach a kill', async () => {
  const base: OwnedProcessIdentity = { pid: 1234, pgid: 1234, startedAt: '2026-10-08T00:00:00.000Z', commandSha256: 'a'.repeat(64) };
  assert.equal(matchesProcessIdentity(base, structuredClone(base)), true);
  assert.equal(matchesProcessIdentity(base, undefined), false);
  for (const changed of [{ ...base, pid: 1235 }, { ...base, pgid: 1235 }, { ...base, startedAt: '2026-10-08T00:00:01.000Z' }, { ...base, commandSha256: 'b'.repeat(64) }]) {
    assert.equal(matchesProcessIdentity(base, changed), false);
  }
  await assert.rejects(captureProcessIdentity(-1), (error: unknown) => error instanceof NativeInspectionError && error.code === 'ownership-unknown');
  await assert.rejects(stopOwnedProcess({ ...base, pid: 1 }), (error: unknown) => error instanceof NativeInspectionError && error.code === 'ownership-unknown');
});
