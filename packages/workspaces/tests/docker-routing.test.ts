import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDockerRuntime, runManagedDocker, ArtifactFsWorkspaceProvider } from "../src/index.ts";

test("workspace Docker routing requires Enough's explicit descriptor and removes inherited user contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "enough-docker-routing-"));
  const cliPath = join(root, "bundled docker");
  const endpoint = { cliPath, host: `unix://${join(root, "owned.sock")}`, configDirectory: join(root, "private config") };
  const keys = ["ENOUGHFACTORY_DOCKER_HOST", "ENOUGHFACTORY_DOCKER_CLI", "ENOUGHFACTORY_DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.DOCKER_HOST = "unix:///do-not-touch-user.sock";
    process.env.DOCKER_CONTEXT = "user-context";
    process.env.DOCKER_TLS = "1"; process.env.DOCKER_TLS_VERIFY = "1"; process.env.DOCKER_CERT_PATH = "/user/certs";
    assert.throws(() => resolveDockerRuntime(), /managed container runtime is not configured/);
    await writeFile(cliPath, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),host:process.env.DOCKER_HOST,config:process.env.DOCKER_CONFIG,context:process.env.DOCKER_CONTEXT,tls:process.env.DOCKER_TLS,verify:process.env.DOCKER_TLS_VERIFY,cert:process.env.DOCKER_CERT_PATH}));\n`);
    await chmod(cliPath, 0o700);
    const result = await runManagedDocker(endpoint, ["info"]);
    assert.equal(result.exitCode, 0);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.args, ["--host", endpoint.host, "--config", endpoint.configDirectory, "info"]);
    assert.equal(observed.host, endpoint.host); assert.equal(observed.config, endpoint.configDirectory);
    for (const key of ["context", "tls", "verify", "cert"]) assert.equal(observed[key], undefined);
  } finally {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await rm(root, { recursive: true, force: true });
  }
});

test("ArtifactFS diagnoses rootless mounts before creating privileged resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "enough-rootless-afs-"));
  const cliPath = join(root, "bundled-docker"); const calls = join(root, "calls.jsonl");
  try {
    await writeFile(cliPath, `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(JSON.stringify({OSType:'linux',SecurityOptions:['name=rootless']}));\n`);
    await chmod(cliPath, 0o700);
    const provider = new ArtifactFsWorkspaceProvider({ rootDirectory: root, dockerRuntime: { cliPath, host: `unix://${join(root, "owned.sock")}`, configDirectory: join(root, "config") } });
    const result = await provider.available(); assert.equal(result.available, false); assert.match(result.reason!, /rootless.*Git workspaces/i);
    const observed = (await readFile(calls, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(observed.length, 1); assert.deepEqual(observed[0].slice(4), ["info", "--format", "{{json .}}"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
