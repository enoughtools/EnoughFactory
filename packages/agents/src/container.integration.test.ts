import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ContainerProcess, containerCommand, quote } from "./process.ts";

const containerId = process.env.ENOUGHFACTORY_AGENT_CONTAINER;
test("Docker keeps a live agent connection and interruption terminates its tools", { skip: !containerId }, async () => {
  const file = `/tmp/enoughfactory-tool-${randomUUID()}.pid`;
  const child = new ContainerProcess(containerId!, ["sh", "-c", `sleep 120 & echo $! > ${quote(file)}; printf 'ready\\n'; wait`]);
  let terminated = false;
  void child.exit.then(() => { terminated = true; });
  const ready = new Promise<void>((resolve) => child.lines((line) => { if (line === "ready") resolve(); }));
  const timer = setTimeout(() => { void child.stop(); }, 5_000);
  try {
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(terminated, false, "setsid must wait for its child, retaining the Docker connection");
    const toolPid = await containerCommand(containerId!, ["cat", file]);
    await child.stop(); await child.exit;
    const alive = await containerCommand(containerId!, ["sh", "-c", `if kill -0 ${toolPid} 2>/dev/null; then ps -o stat= -p ${toolPid}; fi; rm -f ${quote(file)}`]);
    assert.equal(alive.replace(/Z\S*/g, "").trim(), "", "An interrupted tool must not remain running");
  } finally { clearTimeout(timer); await child.stop(); }
});
