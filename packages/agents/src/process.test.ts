import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { containerCommand, suspendAwareTimeout, type SpawnProcess } from "./process.ts";

const dockerEndpoint = { cliPath: "/managed/runtime/bin/docker", host: "unix:///managed/runtime/docker.sock", configDirectory: "/managed/runtime/config" };

function fakeClock() {
  let now = 0, sequence = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  let cleared = 0;
  const clock = {
    now: () => now,
    setTimeout(callback: () => void, delay: number) {
      const id = ++sequence; pending.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) {
      if (pending.delete(timer as unknown as number)) cleared++;
    },
  };
  return {
    clock,
    fire(elapsed?: number) {
      const [id, timer] = [...pending][0]!;
      assert.ok(timer, "A timeout should be pending");
      pending.delete(id); now += elapsed ?? timer.delay; timer.callback();
    },
    pending: () => pending.size,
    cleared: () => cleared,
    nextDelay: () => [...pending.values()][0]?.delay,
  };
}

function fakeProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: (signal: string) => boolean;
  };
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  const kills: string[] = []; let spawned = 0;
  child.kill = signal => { kills.push(signal); return true; };
  const spawnProcess = (() => { spawned++; return child; }) as unknown as SpawnProcess;
  return { child, kills, spawnProcess, spawned: () => spawned };
}

test("a sleep gap retains the remaining command budget while a normal 30 second wait expires", () => {
  const time = fakeClock(); let expired = 0;
  suspendAwareTimeout(() => { expired++; }, 30_000, time.clock);
  for (let index = 0; index < 10; index++) time.fire();
  time.fire(3_600_000);
  assert.equal(expired, 0, "Returning from host sleep must not expire all remaining command time");
  assert.equal(time.nextDelay(), 1000);
  for (let index = 0; index < 18; index++) time.fire();
  assert.equal(expired, 0);
  time.fire();
  assert.equal(expired, 1, "The original budget should still expire after 30 charged slices");
  assert.equal(time.pending(), 0);

  const normal = fakeClock(); let normalExpired = false;
  suspendAwareTimeout(() => { normalExpired = true; }, 30_000, normal.clock);
  for (let index = 0; index < 29; index++) normal.fire();
  assert.equal(normalExpired, false);
  normal.fire(); assert.equal(normalExpired, true);
});

test("ordinary event-loop lateness consumes real elapsed time and cancellation clears one timer", () => {
  const time = fakeClock(); let expired = false;
  suspendAwareTimeout(() => { expired = true; }, 2500, time.clock);
  time.fire(1300);
  time.fire(1100);
  assert.equal(time.nextDelay(), 100);
  time.fire(); assert.equal(expired, true);

  const cancelled = fakeClock();
  const cancel = suspendAwareTimeout(() => assert.fail("A cancelled budget cannot expire"), 30_000, cancelled.clock);
  cancel(); cancel();
  assert.equal(cancelled.pending(), 0);
  assert.equal(cancelled.cleared(), 1);
});

test("a pre-aborted preparation command never starts and in-flight abort kills its Docker client once", async () => {
  const before = fakeProcess(); const preAborted = new AbortController(); preAborted.abort();
  await assert.rejects(containerCommand("container-a", ["prepare"], { dockerEndpoint, spawnProcess: before.spawnProcess, signal: preAborted.signal }), { code: "INTERRUPTED" });
  assert.equal(before.spawned(), 0);

  const live = fakeProcess(); const controller = new AbortController();
  const result = containerCommand("container-a", ["prepare"], { dockerEndpoint, spawnProcess: live.spawnProcess, signal: controller.signal });
  controller.abort(); controller.abort();
  await assert.rejects(result, { code: "INTERRUPTED" });
  assert.deepEqual(live.kills, ["SIGTERM"]);
  assert.equal(live.child.stdin.destroyed, true);
  live.child.emit("close", 0); live.child.emit("error", new Error("Late disconnect"));
  assert.deepEqual(live.kills, ["SIGTERM"]);
});

test("command completion removes the abort hook and timeout retains uncertain classification", async () => {
  const completed = fakeProcess(); const controller = new AbortController();
  const result = containerCommand("container-a", ["prepare"], { dockerEndpoint, spawnProcess: completed.spawnProcess, signal: controller.signal });
  completed.child.stdout.write(" ready \n"); completed.child.emit("close", 0);
  assert.equal(await result, "ready");
  controller.abort(); assert.deepEqual(completed.kills, []);

  const timedOut = fakeProcess();
  await assert.rejects(containerCommand("container-a", ["change-state"], { dockerEndpoint, spawnProcess: timedOut.spawnProcess, timeout: 5 }), { code: "RUNTIME_TIMEOUT" });
  assert.deepEqual(timedOut.kills, ["SIGTERM"]);
  timedOut.child.emit("close", 0);
  assert.equal(timedOut.spawned(), 1, "A generic timed-out command must never be retried implicitly");
});
