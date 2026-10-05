import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LinuxRuntime, LINUX_BRIDGE_HOST } from "../packages/runtime/src/linux.ts";
import { dockerInvocation } from "../packages/runtime/src/docker.ts";
import { EnvmuxEngine } from "../packages/envmux/src/index.ts";

assert.equal(process.platform, "linux", "Run this real container journey on Linux.");
const args = process.argv.slice(2);
const assets = resolve(value("--assets") ?? "apps/desktop/resources/runtime/container");
const nativeEngine = value("--envmux");
const receiptPath = value("--receipt");
const bundleProvenancePath = value("--bundle-provenance");
const checks: string[] = [];
const startedAt = new Date().toISOString();
let bundle: { manifestSha256: string; sourceCommit: string; version: string; platform: string; arch: string } | undefined;
if (bundleProvenancePath) {
  const manifestPath = resolve(bundleProvenancePath);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.product, "EnoughFactory");
  assert.equal(manifest.platform, "linux");
  assert.equal(manifest.arch, process.arch);
  const resources = dirname(manifestPath);
  assert.equal(assets, join(resources, "runtime", "container"), "Smoke assets must be the installed bundle's private runtime.");
  assert(nativeEngine, "A bundle receipt requires its installed native envmux adapter.");
  assert.equal(resolve(nativeEngine), join(resources, "envmux", "envmux"));
  for (const relative of ["envmux/envmux", "runtime/node", "runtime/container/provenance.json",
    ...["docker", "dockerd", "containerd", "runc", "rootlesskit", "dockerd-rootless.sh"].map(name => `runtime/container/docker/bin/${name}`)]) {
    assert.equal(await digest(join(resources, relative)), manifest.files[relative], `Installed resource hash differs: ${relative}`);
    assert.match(manifest.files[relative], /^[a-f0-9]{64}$/);
  }
  bundle = { manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    sourceCommit: manifest.sourceCommit, version: manifest.version, platform: manifest.platform, arch: manifest.arch };
  checks.push("installed resource hashes match bundle provenance");
}
const cache = join(homedir(), ".cache");
await mkdir(cache, { recursive: true });
const proof = await mkdtemp(join(cache, "ef-"));
const userDockerConfiguration = join(homedir(), ".docker", "config.json");
const originalConfiguration = await digest(userDockerConfiguration);
// These values must not redirect EnoughFactory's private client calls.
process.env.DOCKER_CONTEXT = "enoughfactory-must-ignore-this-context";
process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
process.env.DOCKER_TLS_VERIFY = "1";
process.env.DOCKER_CERT_PATH = "/enoughfactory-must-not-read-user-certificates";
process.env.DOCKER_CONFIG = join(proof, "unrelated-user-docker-config");
process.env.DOCKER_BUILDKIT = "1";
const runtime = new LinuxRuntime({ stateDirectory: join(proof, "state"), assetsDirectory: assets,
  onProgress: event => console.log(event.message), });
const endpoint = runtime.endpoint();
assert.match(endpoint.host, /^unix:\/\/\/.+\/ef-/);
assert.equal(endpoint.host.endsWith("/docker/run/docker.sock"), true);
assert.notEqual(endpoint.configDirectory, process.env.DOCKER_CONFIG);

async function docker(...commands: string[]): Promise<string> {
  const call = dockerInvocation(endpoint, commands);
  return command(call.command, call.args, undefined, call.env);
}
const container = "enoughfactory-runtime-proof";
const volume = "enoughfactory-runtime-proof-data";
const bridge = createServer((_request, response) => response.end("owned-app-loopback-bridge"));
await new Promise<void>((resolveListen, reject) => { bridge.once("error", reject); bridge.listen(0, "127.0.0.1", resolveListen); });
const bridgeAddress = bridge.address();
assert(bridgeAddress && typeof bridgeAddress !== "string");
let workbench: Awaited<ReturnType<EnvmuxEngine["start"]>> | undefined;
try {
  const before = await runtime.status();
  assert.equal(before.phase, "stopped", before.prerequisites?.join("\n") ?? before.message);
  await runtime.start();
  const info = JSON.parse(await docker("info", "--format", "{{json .}}"));
  assert.equal(info.DockerRootDir, join(proof, "state", "docker", "data"));
  assert.equal(info.SecurityOptions.some((option: string) => option.includes("rootless")), true);
  assert.match(info.ServerVersion, /^29\.8\.2$/);
  checks.push("private socket, labeled daemon and data root", "rootless Engine 29.8.2");
  await docker("run", "--detach", "--name", container,
    "--publish", "127.0.0.1::8080", "--volume", `${volume}:/proof`, "busybox:1.37.0",
    "sh", "-ec", "test \"$(id -u)\" = 0; printf retained > /proof/marker; mkdir -p /root/tool-install /www; printf private-engine > /www/index.html; exec httpd -f -p 8080 -h /www");
  assert.equal(await docker("exec", container, "id", "-u"), "0");
  assert.equal(await docker("exec", container, "cat", "/proof/marker"), "retained");
  checks.push("container uid0 and root filesystem writes");
  assert.equal(await docker("exec", container, "wget", "-qO-", `http://${LINUX_BRIDGE_HOST}:${bridgeAddress.port}/`), "owned-app-loopback-bridge");
  checks.push("container reaches the device service host loopback bridge");
  const inspected = JSON.parse(await docker("inspect", container))[0];
  const port = Number(inspected.NetworkSettings.Ports["8080/tcp"][0].HostPort);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "private-engine");
  checks.push("container HTTP port forwarding");
  // A new service instance must reconnect to the same private daemon and state.
  const reconnected = new LinuxRuntime({ stateDirectory: join(proof, "state"), assetsDirectory: assets });
  assert.equal((await reconnected.status()).phase, "ready");
  assert.equal((await reconnected.start()).host, endpoint.host);
  assert.equal(await docker("exec", container, "cat", "/proof/marker"), "retained");
  checks.push("service reconnect adopts the existing owned engine");

  if (nativeEngine) {
    const project = join(proof, "source");
    await mkdir(project);
    await command("git", ["init"], project);
    await command("git", ["config", "user.name", "EnoughFactory"], project);
    await command("git", ["config", "user.email", "factory@enoughtools.com"], project);
    await writeFile(join(project, "README.md"), "Private Engine workbench proof\n");
    await writeFile(join(project, ".envmux.json"), JSON.stringify({
      name: "enoughfactory-owned-engine", portal: { open: false }, tools: {},
      tasks: { proof: { command: "printf 'private-engine-workbench-ready\\n'", kind: "once" } },
    }));
    await command("git", ["add", "."], project);
    await command("git", ["commit", "-m", "Source fixture"], project);
    const engine = new EnvmuxEngine({ binary: resolve(nativeEngine), dockerRuntime: endpoint, containerHostAddress: LINUX_BRIDGE_HOST });
    assert.equal((await engine.detect()).docker.available, true);
    workbench = await engine.start({ projectPath: project, name: "private-proof", startupTimeoutMs: 180_000,
      onEvent: event => { if (event.type === "phase") console.log(`Private workbench: ${event.phase}`); }, });
    assert.equal((await workbench.state()).ready, true);
    assert.equal(workbench.ready.dockerHost, endpoint.host);
    await docker("exec", "-u", "root", "--workdir", workbench.ready.workdir, workbench.ready.instance,
      "bash", "-lc", "printf 'Recovered private runtime work\\n' > RESULT.txt; printf installed > /root/owned-runtime-tool");
    assert.equal((await workbench.repositoryStatus()).entries.some(entry => entry.path === "RESULT.txt"), true);
    await docker("exec", "-u", "root", "--workdir", workbench.ready.workdir, workbench.ready.instance,
      "bash", "-lc", "git add RESULT.txt && git -c user.name=EnoughFactory -c user.email=factory@enoughtools.com commit -m 'Recover private runtime work'");
    await workbench.stop(); workbench = undefined;
    assert.equal(await command("git", ["log", "envmux/private-proof", "-1", "--format=%s"], project), "Recover private runtime work");
    checks.push("native envmux workbench readiness", "native envmux full root execution", "native envmux stop returns exact source commit");
    console.log("Private Engine envmux source-retention journey passed.");
  }

  await docker("rm", "--force", container);
  await runtime.stop();
  assert.equal((await runtime.status()).phase, "stopped");
  await runtime.start();
  assert.equal(await docker("run", "--rm", "--volume", `${volume}:/proof`, "busybox:1.37.0", "cat", "/proof/marker"), "retained");
  checks.push("private engine stop and restart retain named volume contents");
  await docker("volume", "rm", volume);
  assert.equal(await digest(userDockerConfiguration), originalConfiguration, "The user's Docker configuration changed.");
  checks.push("inherited user Docker context and TLS settings ignored", "user Docker configuration unchanged");
  console.log(`Private Linux Engine journey passed. Proof state retained at ${proof}.`);
} finally {
  await new Promise<void>((resolveClose, reject) => bridge.close(error => error ? reject(error) : resolveClose()));
  await workbench?.stop().catch(error => console.error("Workbench stop:", error));
  if ((await runtime.status()).phase === "ready") {
    await docker("rm", "--force", container).catch(() => {});
    await runtime.stop();
  }
}
if (receiptPath) {
  await mkdir(dirname(resolve(receiptPath)), { recursive: true });
  await writeFile(resolve(receiptPath), JSON.stringify({ formatVersion: 1, product: "EnoughFactory", suite: "private-linux-runtime",
    status: "passed", startedAt, completedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    nodeVersion: process.version, dockerVersion: "29.8.2", bundle,
    runtimeProvenanceSha256: await digest(join(assets, "provenance.json")),
    envmuxSha256: nativeEngine ? await digest(resolve(nativeEngine)) : undefined,
    checks, proofDirectory: proof,
  }, null, 2) + "\n");
}

function value(name: string): string | undefined { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
async function digest(path: string): Promise<string | null> {
  try { return createHash("sha256").update(await readFile(path)).digest("hex"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function command(program: string, arguments_: string[], cwd?: string, env = process.env): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, arguments_, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.stdout.on("data", data => { stdout += data.toString(); });
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-16_000); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolveCommand(stdout.trim());
      else reject(new Error(`${program} ${arguments_.slice(0, 3).join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
