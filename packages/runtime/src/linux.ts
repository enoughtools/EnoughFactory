import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { delimiter, join, resolve } from "node:path";
import { userInfo } from "node:os";
import type { DockerRuntimeEndpoint, RuntimeOptions, RuntimeStatus } from "./types.ts";

/** RootlessKit's bundled gvisor driver maps this gateway to the host loopback. */
export const LINUX_BRIDGE_HOST = "10.0.2.1";

interface DaemonIdentity {
  version: 1;
  pid: number;
  processStart: string;
  bootId: string;
  stateDirectory: string;
}

interface EngineInfo {
  DockerRootDir?: string;
  SecurityOptions?: string[];
  Labels?: string[];
  ServerVersion?: string;
}

/** A private, rootless Engine. No setup tool, Docker context or system service is changed. */
export class LinuxRuntime {
  private readonly directory: string;
  private readonly binaries: string;
  private readonly runDirectory: string;
  private readonly dataDirectory: string;
  private readonly configDirectory: string;
  private readonly socket: string;
  private readonly label: string;
  private starting?: Promise<DockerRuntimeEndpoint>;
  private startupError?: string;

  constructor(private readonly options: RuntimeOptions) {
    this.directory = resolve(options.stateDirectory, "docker");
    this.binaries = resolve(options.assetsDirectory, "docker", "bin");
    this.runDirectory = privateRunDirectory(this.directory);
    this.dataDirectory = join(this.directory, "data");
    this.configDirectory = join(this.directory, "config");
    this.socket = join(this.runDirectory, "docker.sock");
    this.label = `enoughfactory.runtime=${createHash("sha256").update(this.directory).digest("hex")}`;
  }

  endpoint(): DockerRuntimeEndpoint {
    return { host: `unix://${this.socket}`, cliPath: join(this.binaries, "docker"), configDirectory: this.configDirectory };
  }

  async status(): Promise<RuntimeStatus> {
    const base = { kind: "rootless-docker" as const, managed: true as const };
    if (process.platform !== "linux") return { ...base, phase: "unsupported", message: "The Linux runtime requires Linux." };
    const missing = await this.missingBinaries();
    if (missing.length) return { ...base, phase: "missing", message: "The bundled container runtime is missing.", prerequisites: missing };
    const engine = await this.engineInfo();
    if (engine) { this.startupError = undefined; return { ...base, phase: "ready", message: "EnoughFactory's private container runtime is ready.", endpoint: this.endpoint(), version: engine.ServerVersion }; }
    if (await this.ownedProcess()) return { ...base, phase: "starting", message: "EnoughFactory's private container runtime is starting.", endpoint: this.endpoint() };
    const requirements = await this.prerequisites();
    if (this.startupError) return { ...base, phase: "error", message: "EnoughFactory's private container runtime could not start.", error: this.startupError,
      endpoint: this.endpoint(), prerequisites: this.startupError.includes("user namespaces") ? [...requirements, `Allow EnoughFactory's bundled rootlesskit to create user namespaces in the host AppArmor policy. The Linux runtime setup guide provides a profile scoped to the application's private runtime installation.`] : requirements.length ? requirements : undefined };
    return { ...base, phase: "stopped", message: requirements.length ? "Linux needs a one-time container runtime setup." : "EnoughFactory's private container runtime is stopped.", endpoint: this.endpoint(), prerequisites: requirements.length ? requirements : undefined };
  }

  start(): Promise<DockerRuntimeEndpoint> {
    if (!this.starting) {
      this.startupError = undefined;
      this.starting = this.startDaemon().catch(error => {
        this.startupError = (error instanceof Error ? error.message : String(error)).slice(-10_000);
        this.options.onProgress?.({ phase: "error", message: "EnoughFactory's private container runtime could not start. Open its setup details to continue." });
        throw error;
      }).finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => undefined);
    const owned = await this.ownedProcess();
    if (!owned) {
      if (await this.engineInfo()) throw new Error("The private Docker engine has no matching process identity; refusing to stop an unverified process.");
      this.startupError = undefined;
      return;
    }
    this.options.onProgress?.({ phase: "stopping", message: "Stopping EnoughFactory's private container runtime." });
    // RootlessKit owns the daemon's lifetime; it forwards termination to its child.
    try { process.kill(owned.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && await this.ownedProcess()) await delay(250);
    if (await this.ownedProcess()) throw new Error("The private container runtime has not stopped. Its files and process are retained for diagnosis.");
    await rm(join(this.directory, "daemon.json"), { force: true });
    this.startupError = undefined;
    this.options.onProgress?.({ phase: "stopped", message: "EnoughFactory's private container runtime is stopped." });
  }

  async prepareWorkspace(_path: string): Promise<void> {
    // Ordinary Git workspaces are copied through the Engine API on Linux.
  }

  private async startDaemon(): Promise<DockerRuntimeEndpoint> {
    if (process.platform !== "linux") throw new Error("The Linux runtime requires Linux.");
    const missing = await this.missingBinaries();
    if (missing.length) throw new Error(missing.join("\n"));
    if (await this.engineInfo()) return this.endpoint();
    // A listening endpoint at our intended address must identify itself as ours.
    // A stale socket with no listener is safe to replace after an interrupted boot.
    let foreign = false;
    try { await socketJson(this.socket, "/info"); foreign = true; } catch { /* no active Engine */ }
    if (foreign) throw new Error("Another Docker engine is listening at EnoughFactory's private socket. Its process and socket were left untouched.");
    const prerequisites = await this.prerequisites();
    if (prerequisites.length) throw new Error(prerequisites.join("\n"));
    const longestSocket = join(this.runDirectory, "rootlesskit", "gvisortapvsock", "tap.sock");
    if (Buffer.byteLength(longestSocket) > 100) throw new Error("The app data path is too long for the private Linux networking sockets. Select an EnoughFactory data directory with a shorter path.");
    for (const path of [this.directory, this.runDirectory, this.dataDirectory, this.configDirectory]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const owner = await lstat(path);
      if (!owner.isDirectory() || owner.isSymbolicLink() || owner.uid !== process.getuid?.()) throw new Error(`EnoughFactory's private runtime directory has unexpected ownership: ${path}`);
      await chmod(path, 0o700);
    }
    const configFile = join(this.configDirectory, "daemon.json");
    await writeFile(configFile, JSON.stringify({
      "data-root": this.dataDirectory,
      "exec-root": join(this.runDirectory, "exec"),
      hosts: [this.endpoint().host],
      pidfile: join(this.runDirectory, "dockerd.pid"),
      labels: [this.label],
      // The proxy avoids requiring a privileged host br_netfilter module setup.
      "userland-proxy": true,
      // Envmux's pinned Engine adapter uses the classic /build API.
      features: { "containerd-snapshotter": false },
    }, null, 2) + "\n", { mode: 0o600 });
    this.options.onProgress?.({ phase: "starting", message: "Starting EnoughFactory's private container runtime." });
    let owned = await this.ownedProcess();
    if (!owned) {
      // Only this private namespace is reset; no system Docker state is inspected or removed.
      await rm(join(this.runDirectory, "rootlesskit"), { recursive: true, force: true });
      await rm(this.socket, { force: true });
      await rm(join(this.runDirectory, "dockerd.pid"), { force: true });
      const log = await open(join(this.directory, "daemon.log"), "a", 0o600);
      try {
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (key === "DOCKERD" || key.startsWith("DOCKER_") || key.startsWith("DOCKERD_") || key.startsWith("_DOCKERD_") || key.startsWith("ROOTLESSKIT_") || key.startsWith("CONTAINERD_ROOTLESS_")) delete env[key];
        }
        // runc otherwise derives the user bus from XDG_RUNTIME_DIR, which is
        // deliberately private here. Never let it fall back to the system bus.
        delete env.DBUS_SESSION_BUS_ADDRESS;
        const bus = await userSessionBus();
        if (bus) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
        const child = spawn(join(this.binaries, "dockerd-rootless.sh"), ["--config-file", configFile], {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: {
            ...env,
            PATH: `${this.binaries}${delimiter}${env.PATH ?? "/usr/bin:/bin"}`,
            XDG_RUNTIME_DIR: this.runDirectory,
            DOCKER_CONFIG: this.configDirectory,
            DOCKERD: join(this.binaries, "dockerd"),
            DOCKERD_ROOTLESS_ROOTLESSKIT_STATE_DIR: join(this.runDirectory, "rootlesskit"),
            DOCKERD_ROOTLESS_ROOTLESSKIT_NET: "gvisor-tap-vsock",
            DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER: "builtin",
            // Envmux's authenticated room/chef bridge listens on host loopback.
            // This is TCP access; the host filesystem and Docker socket stay unmounted.
            DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK: "false",
          },
        });
        await new Promise<void>((resolveSpawn, reject) => { child.once("spawn", resolveSpawn); child.once("error", reject); });
        child.unref();
        owned = { version: 1, pid: child.pid!, processStart: await processStart(child.pid!), bootId: await bootId(), stateDirectory: this.directory };
        const temporary = join(this.directory, `daemon.${process.pid}.tmp`);
        await writeFile(temporary, JSON.stringify(owned) + "\n", { mode: 0o600 });
        await rename(temporary, join(this.directory, "daemon.json"));
      } finally { await log.close(); }
    }
    const deadline = Date.now() + 90_000;
    const minimumStartup = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (await this.engineInfo()) {
        this.options.onProgress?.({ phase: "ready", message: "EnoughFactory's private container runtime is ready." });
        return this.endpoint();
      }
      if (Date.now() > minimumStartup && !await this.ownedProcess()) break;
      await delay(300);
    }
    const log = await readFile(join(this.directory, "daemon.log"), "utf8").catch(() => "");
    const tail = log.slice(-8_000);
    const advice = /operation not permitted|apparmor/i.test(tail)
      ? `\nThe host may restrict user namespaces. See the Linux runtime setup guide to allow ${join(this.binaries, "rootlesskit")} in AppArmor.` : "";
    throw new Error(`EnoughFactory's private container runtime did not become ready.${advice}\n${tail}`);
  }

  private async missingBinaries(): Promise<string[]> {
    const missing: string[] = [];
    for (const name of ["docker", "dockerd", "containerd", "runc", "dockerd-rootless.sh", "rootlesskit"]) {
      try { await access(join(this.binaries, name), constants.X_OK); }
      catch { missing.push(`Bundled runtime executable is missing: ${join(this.binaries, name)}`); }
    }
    return missing;
  }

  private async prerequisites(): Promise<string[]> {
    const requirements: string[] = [];
    const account = userInfo();
    if (account.uid === 0) requirements.push("Run the EnoughFactory Linux device service as your regular user. Its private Engine uses a user namespace; containers still have root access inside that namespace.");
    const path = process.env.PATH ?? "/usr/bin:/bin";
    for (const name of ["newuidmap", "newgidmap", "iptables", "nsenter", "sysctl"]) {
      if (!await executableInPath(name, path)) requirements.push(`Install the Linux prerequisite ${name}. Debian/Ubuntu: sudo apt install uidmap iptables util-linux procps. Fedora: sudo dnf install shadow-utils iptables util-linux procps-ng.`);
    }
    for (const file of ["/etc/subuid", "/etc/subgid"]) {
      const ranges = await readFile(file, "utf8").catch(() => "");
      const sufficient = ranges.split("\n").some(line => {
        const [owner, , count] = line.trim().split(":");
        return (owner === account.username || owner === String(account.uid)) && Number(count) >= 65_536;
      });
      if (!sufficient) requirements.push(`Allocate at least 65,536 subordinate ${file.endsWith("subuid") ? "user" : "group"} IDs for ${account.username} in ${file}. The Linux runtime guide explains how to choose a non-overlapping range.`);
    }
    const allowed = await readFile("/proc/sys/kernel/unprivileged_userns_clone", "utf8").catch(() => "1");
    if (allowed.trim() === "0") requirements.push("This Linux host disables unprivileged user namespaces. Enable them for EnoughFactory before starting the private runtime.");
    const namespaceLimit = await readFile("/proc/sys/user/max_user_namespaces", "utf8").catch(() => "1");
    if (Number(namespaceLimit.trim()) === 0) requirements.push("This Linux host allows no user namespaces. Ask the administrator to configure a non-zero user.max_user_namespaces limit.");
    if (await usesSystemdCgroupV2() && !await userSessionBus()) requirements.push('This Linux host needs a user D-Bus session to manage private container cgroups. Install dbus-user-session (Debian/Ubuntu) or dbus-daemon (Fedora), then sign into your regular user session. For a headless device service, the administrator can enable the user manager with: sudo loginctl enable-linger "$USER".');
    return requirements;
  }

  private async engineInfo(): Promise<EngineInfo | undefined> {
    try {
      const socket = await stat(this.socket);
      if (!socket.isSocket() || socket.uid !== process.getuid?.()) return undefined;
      const value = await socketJson<EngineInfo>(this.socket, "/info");
      if (value.DockerRootDir !== this.dataDirectory || !value.Labels?.includes(this.label) || !value.SecurityOptions?.some(option => option.includes("rootless"))) return undefined;
      return value;
    } catch { return undefined; }
  }

  private async ownedProcess(): Promise<DaemonIdentity | undefined> {
    try {
      const identity = JSON.parse(await readFile(join(this.directory, "daemon.json"), "utf8")) as DaemonIdentity;
      if (identity.version !== 1 || identity.stateDirectory !== this.directory || !Number.isSafeInteger(identity.pid) || identity.pid < 2 || identity.bootId !== await bootId()) return undefined;
      if (identity.processStart !== await processStart(identity.pid)) return undefined;
      const command = await readFile(`/proc/${identity.pid}/cmdline`, "utf8");
      const executable = await readlink(`/proc/${identity.pid}/exe`);
      if (executable !== join(this.binaries, "rootlesskit") && !command.includes(join(this.binaries, "dockerd-rootless.sh"))) return undefined;
      if (!command.includes(join(this.runDirectory, "rootlesskit")) && !command.includes(join(this.configDirectory, "daemon.json"))) return undefined;
      return identity;
    } catch { return undefined; }
  }
}

async function socketJson<T>(socketPath: string, path: string): Promise<T> {
  return new Promise((resolveResponse, reject) => {
    const call = request({ socketPath, path, method: "GET", timeout: 3_000 }, response => {
      const parts: Buffer[] = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) call.destroy(new Error("Private Docker response exceeded its limit."));
        else parts.push(Buffer.from(chunk));
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`Private Docker returned ${response.statusCode}.`));
        try { resolveResponse(JSON.parse(Buffer.concat(parts).toString("utf8")) as T); }
        catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    call.on("timeout", () => call.destroy(new Error("Private Docker did not answer.")));
    call.on("error", reject);
    call.end();
  });
}

async function executableInPath(name: string, path: string): Promise<boolean> {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try { await access(join(directory, name), constants.X_OK); return true; }
    catch { /* try the next directory */ }
  }
  return false;
}

async function processStart(pid: number): Promise<string> {
  const contents = await readFile(`/proc/${pid}/stat`, "utf8");
  // A process name may contain spaces and parentheses; fields begin after its final ')'.
  const fields = contents.slice(contents.lastIndexOf(")") + 2).trim().split(/\s+/);
  const start = fields[19];
  if (!start) throw new Error("Cannot establish the private Docker process identity.");
  return start;
}

async function bootId(): Promise<string> { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); }
async function delay(ms: number): Promise<void> { await new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }

async function userSessionBus(): Promise<string | undefined> {
  const path = join("/run/user", String(process.getuid?.() ?? 0), "bus");
  try { const socket = await lstat(path); if (socket.isSocket() && socket.uid === process.getuid?.()) return path; }
  catch { /* A user login or administrator setup must establish this bus. */ }
  return undefined;
}

async function usesSystemdCgroupV2(): Promise<boolean> {
  try { await access("/run/systemd/system"); await access("/sys/fs/cgroup/cgroup.controllers"); return true; }
  catch { return false; }
}

function privateRunDirectory(directory: string): string {
  const usual = join(directory, "run");
  if (Buffer.byteLength(join(usual, "rootlesskit", "gvisortapvsock", "tap.sock")) <= 100) return usual;
  const uid = process.getuid?.() ?? 0;
  const name = `enoughfactory-${uid}-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`;
  const userRuntime = join("/run/user", String(uid));
  try {
    const parent = lstatSync(userRuntime);
    if (parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === uid && (parent.mode & 0o077) === 0) return join(userRuntime, name);
  } catch { /* No user runtime directory exists on this host. */ }
  // The final directory is checked for symlinks and ownership before any socket
  // is opened. Its 0700 permissions prevent other users replacing contents.
  return join("/tmp", name);
}
