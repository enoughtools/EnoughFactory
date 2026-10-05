import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MacRuntime } from "../packages/runtime/src/mac.ts";
import { dockerInvocation } from "../packages/runtime/src/docker.ts";
import { EnvmuxEngine } from "../packages/envmux/src/index.ts";

assert.equal(process.platform, "darwin", "Run this real container journey on Mac.");
const args = process.argv.slice(2);
const assets = resolve(value("--assets") ?? ".cache/container-runtime/darwin-" + process.arch);
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
  assert.equal(manifest.platform, "darwin");
  assert.equal(manifest.arch, process.arch);
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  const resources = dirname(manifestPath);
  assert.equal(assets, join(resources, "runtime", "container"), "Smoke assets must be the installed bundle's private runtime.");
  assert.equal(process.version, `v${manifest.nodeVersion}`, "Run the installed journey with the bundle's pinned Node runtime.");
  assert.equal(await realpath(process.execPath), await realpath(join(resources, "runtime/node")), "The journey must execute the installed bundle's Node binary.");
  assert(nativeEngine, "A bundle receipt requires its installed native envmux adapter.");
  assert.equal(resolve(nativeEngine), join(resources, "envmux", "envmux"));
  for (const relative of ["envmux/envmux", "runtime/node", "runtime/container/provenance.json",
    "runtime/container/pins.json", "runtime/container/docker/bin/docker", "runtime/container/docker/guest-engine.tgz",
    "runtime/container/lima/bin/limactl", "runtime/container/images/guest.img"]) {
    assert.match(manifest.files[relative], /^[a-f0-9]{64}$/);
    assert.equal(await digest(join(resources, relative)), manifest.files[relative], `Installed resource hash differs: ${relative}`);
  }
  bundle = { manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    sourceCommit: manifest.sourceCommit, version: manifest.version, platform: manifest.platform, arch: manifest.arch };
  checks.push("installed resource hashes match bundle provenance");
}

const provenance = JSON.parse(await readFile(join(assets, "provenance.json"), "utf8"));
const pins = JSON.parse(await readFile(join(assets, "pins.json"), "utf8"));
assert.equal(provenance.platform, "darwin");
assert.equal(provenance.arch, process.arch);
assert.equal(provenance.dockerVersion, "29.8.2");
assert.equal(provenance.limaVersion, "2.2.1");
assert.equal(provenance.guestImage.bundled, true);
assert.equal(provenance.guestImage.path, "images/guest.img");
assert.equal(provenance.guestImage.sha256, pins.images[process.arch].sha256);
assert.equal(await digest(join(assets, "images/guest.img")), pins.images[process.arch].sha256);
checks.push("bundled verified Ubuntu guest image");

// A fresh, short private directory proves that this bundle boots its own image,
// and avoids macOS's Unix socket path limit without borrowing another VM.
const proof = await mkdtemp("/private/tmp/efm-");
const stateDirectory = join(proof, "state");
console.log(`Private Mac runtime proof state: ${proof}`);
const userDockerConfiguration = join(homedir(), ".docker", "config.json");
const originalConfiguration = await digest(userDockerConfiguration);
// None of these developer preferences may redirect private runtime calls.
process.env.DOCKER_CONTEXT = "enoughfactory-must-ignore-this-context";
process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
process.env.DOCKER_TLS = "1";
process.env.DOCKER_TLS_VERIFY = "1";
process.env.DOCKER_CERT_PATH = "/enoughfactory-must-not-read-user-certificates";
process.env.DOCKER_CONFIG = join(proof, "unrelated-user-docker-config");
process.env.DOCKER_BUILDKIT = "1";
const runtime = new MacRuntime({ stateDirectory, assetsDirectory: assets,
  onProgress: event => console.log(event.message) });
const endpoint = runtime.endpoint();
assert.equal(endpoint.host, `unix://${join(stateDirectory, "container/lima/factory/sock/docker.sock")}`);
assert.equal(endpoint.cliPath, join(assets, "docker/bin/docker"));
assert.equal(endpoint.configDirectory, join(stateDirectory, "docker/config"));
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
  assert.equal((await runtime.status()).phase, "stopped");
  await runtime.start();
  assert.equal((await runtime.status()).phase, "ready");
  const info = JSON.parse(await docker("info", "--format", "{{json .}}"));
  const owner = createHash("sha256").update(stateDirectory).digest("hex").slice(0, 24);
  assert.equal(info.DockerRootDir, "/var/lib/enoughfactory/docker");
  assert.equal(info.Labels.includes("enoughfactory.managed=true"), true);
  assert.equal(info.Labels.includes(`enoughfactory.owner=${owner}`), true);
  assert.equal(info.ServerVersion, "29.8.2");
  checks.push("private socket, labeled daemon and data root", "Docker Engine 29.8.2");
  assert.match(await command(join(assets, "lima/bin/limactl"), ["--version"]), /\b2\.2\.1\b/);
  const configuration = JSON.parse(await readFile(join(stateDirectory, "container/lima/factory/lima.yaml"), "utf8"));
  assert.equal(configuration.vmType, "vz");
  assert.equal(configuration.images[0].location, join(assets, "images/guest.img"));
  assert.equal(configuration.images[0].digest, `sha256:${pins.images[process.arch].sha256}`);
  checks.push("private Lima 2.2.1 with Apple Virtualization");

  const shared = join(stateDirectory, "container/shared/proof");
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, "source"), "owned-workspace");
  await runtime.prepareWorkspace(shared);
  await docker("run", "--detach", "--name", container, "--publish", "127.0.0.1::8080",
    "--volume", `${volume}:/proof`, "--mount", `type=bind,source=${shared},target=/input,readonly`,
    "--add-host", "host.docker.internal:192.168.5.2", "busybox:1.37.0", "sh", "-ec",
    "test \"$(id -u)\" = 0; test \"$(cat /input/source)\" = owned-workspace; printf retained > /proof/marker; mkdir -p /root/tool-install /www; printf installed > /root/tool-install/proof; printf private-engine > /www/index.html; exec httpd -f -p 8080 -h /www");
  assert.equal(await docker("exec", container, "id", "-u"), "0");
  assert.equal(await docker("exec", container, "cat", "/root/tool-install/proof"), "installed");
  checks.push("container uid0 and root filesystem writes");
  assert.equal(await docker("exec", container, "cat", "/input/source"), "owned-workspace");
  await assert.rejects(docker("exec", container, "sh", "-ec", "printf forbidden > /input/source"));
  assert.equal(await readFile(join(shared, "source"), "utf8"), "owned-workspace");
  checks.push("narrow read-only input mount");
  assert.equal(await docker("exec", container, "wget", "-qO-", `http://host.docker.internal:${bridgeAddress.port}/`), "owned-app-loopback-bridge");
  checks.push("container reaches the device service host loopback bridge");
  const inspected = JSON.parse(await docker("inspect", container))[0];
  const port = Number(inspected.NetworkSettings.Ports["8080/tcp"][0].HostPort);
  let response = "";
  for (let attempt = 0; attempt < 40 && response !== "private-engine"; attempt++) {
    response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }).then(result => result.text()).catch(() => "");
    if (response !== "private-engine") await new Promise(accept => setTimeout(accept, 250));
  }
  assert.equal(response, "private-engine");
  checks.push("container HTTP port forwarding");
  const reconnected = new MacRuntime({ stateDirectory, assetsDirectory: assets });
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
    await writeFile(join(project, "README.md"), "Private Mac runtime workbench proof\n");
    await writeFile(join(project, ".envmux.json"), JSON.stringify({
      name: "enoughfactory-owned-engine", portal: { open: false }, tools: {},
      tasks: { proof: { command: "printf 'private-engine-workbench-ready\\n'", kind: "once" } },
    }));
    await command("git", ["add", "."], project);
    await command("git", ["commit", "-m", "Source fixture"], project);
    const engine = new EnvmuxEngine({ binary: resolve(nativeEngine), dockerRuntime: endpoint, containerHostAddress: "192.168.5.2" });
    const detected = await engine.detect();
    assert.equal(detected.available, true, detected.error);
    assert.equal(detected.docker.available, true, detected.docker.error);
    workbench = await engine.start({ projectPath: project, name: "private-proof", startupTimeoutMs: 15 * 60_000,
      onEvent: event => { if (event.type === "phase") console.log(`Private workbench: ${event.phase}`); } });
    assert.equal((await workbench.state()).ready, true);
    assert.equal(workbench.ready.dockerHost, endpoint.host);
    checks.push("native envmux workbench readiness");
    await docker("exec", "-u", "root", "--workdir", workbench.ready.workdir, workbench.ready.instance,
      "bash", "-lc", "test \"$(id -u)\" = 0; printf 'Recovered private runtime work\\n' > RESULT.txt; printf installed > /root/owned-runtime-tool");
    assert.equal(await docker("exec", "-u", "root", workbench.ready.instance, "cat", "/root/owned-runtime-tool"), "installed");
    assert.equal((await workbench.repositoryStatus()).entries.some(entry => entry.path === "RESULT.txt"), true);
    checks.push("native envmux full root execution");
    await docker("exec", "-u", "root", "--workdir", workbench.ready.workdir, workbench.ready.instance,
      "bash", "-lc", "git add RESULT.txt && git -c user.name=EnoughFactory -c user.email=factory@enoughtools.com commit -m 'Recover private runtime work'");
    const expectedCommit = await docker("exec", "-u", "root", "--workdir", workbench.ready.workdir, workbench.ready.instance, "git", "rev-parse", "HEAD");
    await workbench.stop(); workbench = undefined;
    assert.equal(await command("git", ["rev-parse", "envmux/private-proof"], project), expectedCommit);
    assert.equal(await command("git", ["show", "envmux/private-proof:RESULT.txt"], project), "Recovered private runtime work");
    checks.push("native envmux stop returns exact source commit");
    console.log(`Private Mac runtime returned exact source commit ${expectedCommit}.`);
  }

  await docker("rm", "--force", container);
  await runtime.stop();
  assert.equal((await runtime.status()).phase, "stopped");
  await runtime.start();
  assert.equal(await docker("run", "--rm", "--volume", `${volume}:/proof`, "busybox:1.37.0", "cat", "/proof/marker"), "retained");
  checks.push("private engine stop and restart retain named volume contents");
  await docker("volume", "rm", volume);
} finally {
  await new Promise<void>((resolveClose, reject) => bridge.close(error => error ? reject(error) : resolveClose()));
  await workbench?.stop().catch(error => console.error("Workbench stop:", error));
  if ((await runtime.status()).phase === "ready") {
    await docker("rm", "--force", container).catch(() => {});
  }
  // This VM belongs only to the fresh proof directory, even on failure.
  await runtime.stop();
}
assert.equal(await digest(userDockerConfiguration), originalConfiguration, "The user's Docker configuration changed.");
checks.push("inherited user Docker context and TLS settings ignored", "user Docker configuration unchanged");
console.log(`Private Mac runtime journey passed. Proof state retained at ${proof}.`);

if (receiptPath) {
  await mkdir(dirname(resolve(receiptPath)), { recursive: true });
  await writeFile(resolve(receiptPath), JSON.stringify({ formatVersion: 1, product: "EnoughFactory", suite: "private-mac-runtime",
    status: "passed", startedAt, completedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    nodeVersion: process.version, dockerVersion: "29.8.2", bundle,
    runtimeProvenanceSha256: await digest(join(assets, "provenance.json")),
    envmuxSha256: nativeEngine ? await digest(resolve(nativeEngine)) : undefined,
    checks, proofDirectory: proof,
  }, null, 2) + "\n");
}

function value(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  assert(args[index + 1] && !args[index + 1].startsWith("--"), `${name} requires a value`);
  return args[index + 1];
}
async function digest(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function command(program: string, arguments_: string[], cwd?: string, env = process.env): Promise<string> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, arguments_, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${program} did not finish within five minutes`)); }, 300_000);
    child.stdout.on("data", data => { stdout = (stdout + data.toString()).slice(-100_000); });
    child.stderr.on("data", data => { stderr = (stderr + data.toString()).slice(-16_000); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolveCommand(stdout.trim());
      else reject(new Error(`${program} ${arguments_.slice(0, 3).join(" ")} failed (${code}): ${stderr}`));
    });
  });
}
