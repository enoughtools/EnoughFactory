import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { ContainerProcess, containerCommand, quote } from "./process.ts";
import type { DockerRuntimeEndpoint } from "@enoughfactory/runtime";

const containerId = process.env.ENOUGHFACTORY_AGENT_CONTAINER;
const explicitTestEndpoint = process.env.ENOUGHFACTORY_AGENT_TEST_ENDPOINT;
const endpoint: DockerRuntimeEndpoint | undefined = process.env.ENOUGHFACTORY_AGENT_TEST_DOCKER_HOST && process.env.ENOUGHFACTORY_AGENT_TEST_DOCKER_CLI && process.env.ENOUGHFACTORY_AGENT_TEST_DOCKER_CONFIG ? {
  host: process.env.ENOUGHFACTORY_AGENT_TEST_DOCKER_HOST,
  cliPath: process.env.ENOUGHFACTORY_AGENT_TEST_DOCKER_CLI,
  configDirectory: process.env.ENOUGHFACTORY_AGENT_TEST_DOCKER_CONFIG,
} : undefined;
// Existing developer Docker fixtures are never selected implicitly. Managed runtime
// fixtures use the same explicit descriptor and endpoint-kind selection.
test("Docker keeps a live agent connection and interruption terminates its tools", { skip: !containerId || !endpoint || !["managed", "external-development"].includes(explicitTestEndpoint ?? "") }, async () => {
  const file = `/tmp/enoughfactory-tool-${randomUUID()}.pid`;
  const child = new ContainerProcess(containerId!, ["sh", "-c", `sleep 120 & echo $! > ${quote(file)}; printf 'ready\\n'; wait`], endpoint);
  let terminated = false;
  void child.exit.then(() => { terminated = true; });
  const ready = new Promise<void>((resolve) => child.lines((line) => { if (line === "ready") resolve(); }));
  const timer = setTimeout(() => { void child.stop(); }, 5_000);
  try {
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(terminated, false, "setsid must wait for its child, retaining the Docker connection");
    const toolPid = await containerCommand(containerId!, ["cat", file], { dockerEndpoint: endpoint });
    await child.stop(); await child.exit;
    const alive = await containerCommand(containerId!, ["sh", "-c", `if kill -0 ${toolPid} 2>/dev/null; then ps -o stat= -p ${toolPid}; fi; rm -f ${quote(file)}`], { dockerEndpoint: endpoint });
    assert.equal(alive.replace(/Z\S*/g, "").trim(), "", "An interrupted tool must not remain running");
  } finally { clearTimeout(timer); await child.stop(); }
});
