import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve, sep } from "node:path";
import type { ArtifactStore } from "./artifacts.ts";
import type { ArtifactManifest, CheckExecutor, CommandResult } from "./types.ts";
import type { ProcessOutput } from "./process.ts";

export const APPLE_CHECK_PREFIX = "enoughfactory:apple-build";

/** This is a validation capability, never a route for native agent commands. */
export type AppleCheckProfile =
  | { tool: "swift"; package: string; action: "build" | "test" }
  | { tool: "xcodebuild"; project: string; scheme: string; platform: "macos" | "ios-simulator"; configuration: "Debug" | "Release" };

export function isAppleCheckCommand(command: string): boolean {
  return command === APPLE_CHECK_PREFIX || command.startsWith(`${APPLE_CHECK_PREFIX} `);
}

export function parseAppleCheckCommand(command: string): AppleCheckProfile {
  if (!isAppleCheckCommand(command)) throw new Error("Not an EnoughFactory Apple validation profile");
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(command.slice(APPLE_CHECK_PREFIX.length).trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
  } catch { throw new Error("Apple validation requires one JSON profile, not a shell command"); }
  if (value.tool === "swift") {
    exactKeys(value, ["tool", "package", "action"]);
    if (value.action !== "build" && value.action !== "test") throw new Error("Swift validation action must be build or test");
    return { tool: "swift", package: safeRelativePath(value.package, true), action: value.action };
  }
  if (value.tool === "xcodebuild") {
    exactKeys(value, ["tool", "project", "scheme", "platform", "configuration"]);
    const project = safeRelativePath(value.project);
    if (!/\.(xcodeproj|xcworkspace)$/.test(project)) throw new Error("Apple project must be an xcodeproj or xcworkspace in the captured source");
    if (typeof value.scheme !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,119}$/.test(value.scheme)) throw new Error("Invalid Apple build scheme");
    if (value.platform !== "macos" && value.platform !== "ios-simulator") throw new Error("Apple platform must be macos or ios-simulator");
    if (value.configuration !== undefined && value.configuration !== "Debug" && value.configuration !== "Release") throw new Error("Apple configuration must be Debug or Release");
    return { tool: "xcodebuild", project, scheme: value.scheme, platform: value.platform, configuration: value.configuration ?? "Debug" };
  }
  throw new Error("Apple validation supports only fixed swift or xcodebuild profiles");
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown Apple validation option; arbitrary native arguments are not supported");
}

function safeRelativePath(value: unknown, allowRoot = false): string {
  if (allowRoot && value === ".") return ".";
  if (typeof value !== "string" || !value || value.length > 512 || value.includes("\0") || value.includes("\\") || value.startsWith("/") || value.startsWith("-") || /[\r\n]/.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error("Apple validation paths must stay inside the captured source");
  return value;
}

type NativeRunner = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) => Promise<ProcessOutput>;

export interface AppleCheckOptions {
  /** WorkspaceManager's owned checks directory, never a project or personal folder. */
  checksRoot: string;
  artifacts?: ArtifactStore;
  /** Injection for focused verification; production uses a detached, cleaned-up process group. */
  execute?: NativeRunner;
  platform?: NodeJS.Platform;
}

export interface AppleCheckEvidence {
  version: 1;
  candidateId: string;
  candidateCommit: string;
  checkedCommit: string;
  profile: AppleCheckProfile;
  sandbox: "macos-seatbelt-deny-default";
  developerDirectory: string;
  workingDirectories: Array<{ containerPath: string; commit: string }>;
  products: ArtifactManifest[];
  result: CommandResult;
}

export interface AppleCheckResult extends CommandResult {
  appleValidation: Omit<AppleCheckEvidence, "result"> & { artifact?: ArtifactManifest };
}

export function appleCheckArtifacts(result: CommandResult): ArtifactManifest[] {
  const evidence = (result as Partial<AppleCheckResult>).appleValidation;
  return evidence ? [...evidence.products, ...evidence.artifact ? [evidence.artifact] : []] : [];
}

/**
 * Native Apple tools receive only immutable captured input and private writable build output.
 * No inherited secrets, network, signing, simulator, launchd build-service or personal-home
 * capability is granted. Unsupported host/toolchain behavior fails closed, with no Docker or
 * unsandboxed-host fallback. The ordinary CheckReport binds the returned output to its commit.
 */
export function appleCheckExecutor(options: AppleCheckOptions): CheckExecutor & ((context: Parameters<CheckExecutor>[0]) => Promise<AppleCheckResult>) {
  const execute = options.execute ?? runNativeGroup;
  return async context => {
    const profile = parseAppleCheckCommand(context.command);
    if ((options.platform ?? process.platform) !== "darwin") throw new Error("Apple validation requires a Mac with Xcode and the supported native sandbox");
    if (!/^[a-f0-9]{40,64}$/.test(context.commit) || !/^[a-f0-9]{40,64}$/.test(context.candidate.commit)) throw new Error("Apple validation requires exact captured Git commits");
    await mkdir(options.checksRoot, { recursive: true, mode: 0o700 });
    const checksRoot = await realpath(options.checksRoot);
    if (checksRoot !== resolve(options.checksRoot)) throw new Error("Apple validation checks root must not be a symlink");
    const parent = dirname(resolve(context.path));
    if (parent !== checksRoot && parent !== join(dirname(checksRoot), "integration")) throw new Error("Apple validation accepts only private check or integration snapshots");
    const source = await privateDirectory(context.path, await realpath(parent));
    const additional: string[] = [];
    for (const root of context.workingDirectories ?? []) {
      if (!/^\/workspaces\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$/.test(root.containerPath)) throw new Error("Invalid Apple validation secondary source destination");
      const directory = await realpath(`${source}-working-directories`);
      additional.push(await privateDirectory(root.path, directory));
    }
    const target = await realpath(join(source, profile.tool === "swift" ? profile.package : profile.project));
    if (target !== source && !target.startsWith(`${source}${sep}`)) throw new Error("Apple validation target escapes its immutable source snapshot");
    const developerDirectory = await realpath("/Applications/Xcode.app/Contents/Developer");
    if (developerDirectory !== "/Applications/Xcode.app/Contents/Developer") throw new Error("Apple validation requires the standard trusted Xcode installation");
    const installation = await lstat("/Applications/Xcode.app");
    if (installation.uid !== 0 || (installation.mode & 0o022) !== 0) throw new Error("Apple validation requires a root-owned Xcode installation without group/world write access");
    const scratch = await mkdtemp(join(checksRoot, "apple-"));
    const guard = await mkdtemp(join(checksRoot, "apple-denied-"));
    const startedAt = new Date().toISOString();
    let quarantine = false;
    try {
      for (const name of ["home", "tmp", "cache", "modules", "build", "config", "security", "packages"]) await mkdir(join(scratch, name), { mode: 0o700 });
      const environment = appleEnvironment(scratch, developerDirectory);
      if (profile.tool === "xcodebuild") {
        // Xcode's embedded SwiftPM forwards only SWIFT_EXEC(_MANIFEST) to its
        // manifest compiler. Restore our fixed private environment before the
        // Swift driver creates temporary files, without changing the app compiler.
        await mkdir(join(scratch, "tools"), { mode: 0o700 });
        environment.SWIFT_EXEC_MANIFEST = join(scratch, "tools", "swiftc-manifest");
        await writeFile(environment.SWIFT_EXEC_MANIFEST, appleManifestCompilerSource(scratch, developerDirectory), { mode: 0o500, flag: "wx" });
      }
      const policy = appleSandboxProfile({ sources: [source, ...additional], scratch, developerDirectory, validatorExecutable: await realpath(process.execPath) });
      await verifyBoundary({ execute, policy, scratch, guard, environment, signal: context.signal });
      const args = appleToolArguments(profile, source, scratch);
      const executable = profile.tool === "swift" ? join(developerDirectory, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "swift") : join(developerDirectory, "usr", "bin", "xcodebuild");
      const output = await execute("/usr/bin/sandbox-exec", ["-p", policy, executable, ...args.slice(1)], { cwd: source, env: environment, timeoutMs: context.timeoutMs, signal: context.signal });
      const result: CommandResult = { command: context.command, ...output, stdout: `EnoughFactory Apple validation: ${context.commit}\n${output.stdout}`, startedAt, endedAt: new Date().toISOString() };
      const products = output.exitCode === 0 && !output.timedOut && profile.tool === "xcodebuild" && options.artifacts
        ? await captureAppleProducts({ store: options.artifacts, execute, context, profile, source, scratch, policy, environment }) : [];
      const evidence: AppleCheckEvidence = { version: 1, candidateId: context.candidate.id, candidateCommit: context.candidate.commit, checkedCommit: context.commit, profile, sandbox: "macos-seatbelt-deny-default", developerDirectory, workingDirectories: (context.workingDirectories ?? []).map(({ containerPath, commit }) => ({ containerPath, commit })), products, result };
      let artifact: ArtifactManifest | undefined;
      if (options.artifacts) artifact = await options.artifacts.put(JSON.stringify(evidence), { name: `apple-check-${randomUUID()}.json`, mime: "application/json", goalId: context.candidate.goalId, taskId: context.candidate.taskId, attemptId: context.candidate.attemptId, metadata: { candidateId: context.candidate.id, commit: context.commit, profile } });
      const { result: _result, ...metadata } = evidence;
      return { ...result, appleValidation: { ...metadata, artifact } };
    } catch (error) {
      quarantine = error instanceof NativeTeardownError;
      throw error;
    } finally {
      if (!quarantine) await rm(scratch, { recursive: true, force: true });
      await rm(guard, { recursive: true, force: true });
    }
  };
}

async function privateDirectory(path: string, parent: string): Promise<string> {
  const actual = await realpath(path);
  if (actual !== resolve(path) || dirname(actual) !== parent || !(await lstat(actual)).isDirectory()) throw new Error("Apple validation accepts only this report's private snapshot directories");
  return actual;
}

export function appleEnvironment(scratch: string, developerDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", USER: "enoughfactory", LOGNAME: "enoughfactory", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
    HOME: join(scratch, "home"), CFFIXED_USER_HOME: join(scratch, "home"), TMPDIR: `${join(scratch, "tmp")}/`, TEMP: join(scratch, "tmp"), TMP: join(scratch, "tmp"),
    XDG_CACHE_HOME: join(scratch, "cache"), CCHROOT: join(scratch, "cache"), CLANG_MODULE_CACHE_PATH: join(scratch, "modules"), SWIFT_MODULECACHE_PATH: join(scratch, "modules"),
    DEVELOPER_DIR: developerDirectory, MACOSX_DEPLOYMENT_TARGET: "14.0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", CI: "1",
  };
}

/** The generated launcher is trusted service code and protected from build writes. */
export function appleManifestCompilerSource(scratch: string, developerDirectory: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const environment = appleEnvironment(scratch, developerDirectory);
  const compiler = join(developerDirectory, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin", "swiftc");
  return `#!/bin/sh\n${Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value!)}`).join("\n")}\nexec ${quote(compiler)} "$@"\n`;
}

export function appleToolArguments(profile: AppleCheckProfile, source: string, scratch: string): string[] {
  if (profile.tool === "swift") return ["swift", profile.action, "--triple", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`, "--package-path", join(source, profile.package), "--sdk", "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk", "--scratch-path", join(scratch, "build"), "--cache-path", join(scratch, "cache"), "--config-path", join(scratch, "config"), "--security-path", join(scratch, "security"), "--disable-sandbox", "-Xswiftc", "-disable-sandbox", "--disable-netrc", "--disable-keychain", "--disable-automatic-resolution", "--skip-update", "--disable-dependency-cache", "--build-system", "native", "--jobs", "2"];
  // Use the immutable JSON/log evidence: Xcode 27 traps while finalizing an explicit
  // -resultBundlePath inside this sandbox, despite successfully compiling the app.
  // The outer boundary has already passed its controls. A nested SwiftPM sandbox
  // cannot be applied here, and compiler macro servers have the same restriction.
  // Disable those inner layers while keeping the verified outer boundary inherited.
  return ["xcodebuild", profile.project.endsWith(".xcworkspace") ? "-workspace" : "-project", join(source, profile.project), "-scheme", profile.scheme, "-configuration", profile.configuration, "-sdk", profile.platform === "macos" ? "macosx" : "iphonesimulator", "-destination", profile.platform === "macos" ? "generic/platform=macOS" : "generic/platform=iOS Simulator", "-derivedDataPath", join(scratch, "build"), "-clonedSourcePackagesDirPath", join(scratch, "packages"), "-packageCachePath", join(scratch, "cache"), "-packageAuthorizationProvider", "netrc", "-IDEPackageSupportDisableManifestSandbox=YES", "OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox", "-disableAutomaticPackageResolution", "-skipPackageUpdates", "-disablePackageRepositoryCache", "-parallelizeTargets", "-jobs", "2", "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY=", "COMPILER_INDEX_STORE_ENABLE=NO", `OBJROOT=${join(scratch, "build", "Intermediates")}`, `SYMROOT=${join(scratch, "build", "Products")}`, `DSTROOT=${join(scratch, "build", "Install")}`, `SHARED_PRECOMPS_DIR=${join(scratch, "modules")}`, `MODULE_CACHE_DIR=${join(scratch, "modules")}`, "build"];
}

async function captureAppleProducts(input: {
  store: ArtifactStore; execute: NativeRunner; context: Parameters<CheckExecutor>[0];
  profile: Extract<AppleCheckProfile, { tool: "xcodebuild" }>; source: string; scratch: string;
  policy: string; environment: NodeJS.ProcessEnv;
}): Promise<ArtifactManifest[]> {
  const productsRoot = join(input.scratch, "build", "Products");
  // Traversal runs inside the build sandbox too. A racing untrusted symlink must
  // never make trusted service code enumerate or read outside the captured input.
  const validator = APPLE_PRODUCT_INVENTORY_SOURCE;
  const validated = await input.execute("/usr/bin/sandbox-exec", ["-p", input.policy, await realpath(process.execPath), "--jitless", "--max-old-space-size=96", "-e", validator, productsRoot], { cwd: input.source, env: input.environment, timeoutMs: 30_000, signal: input.context.signal });
  if (validated.exitCode !== 0 || validated.timedOut) throw new Error(`Could not validate Apple build products: ${validated.stderr.trim()}`);
  const applications: unknown = JSON.parse(validated.stdout);
  if (!Array.isArray(applications) || applications.length > 4 || applications.some(path => typeof path !== "string" || !path.startsWith(`${productsRoot}${sep}`) || !path.endsWith(".app"))) throw new Error("Invalid private Apple product inventory");
  const artifacts: ArtifactManifest[] = [];
  for (const application of applications) {
    const archive = join(input.scratch, `product-${randomUUID()}.zip`);
    // Packaging inherits the same source/read/write/network boundary as compilation.
    const result = await input.execute("/usr/bin/sandbox-exec", ["-p", input.policy, "/usr/bin/ditto", "-c", "-k", "--keepParent", application, archive], { cwd: input.source, env: input.environment, timeoutMs: 60_000, signal: input.context.signal });
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Could not retain unsigned Apple build product: ${result.stderr.trim()}`);
    const handle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024 * 1024) throw new Error("Apple product archive exceeds the 256 MiB validation limit");
      bytes = Buffer.alloc(info.size + 1);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== info.size) throw new Error("Apple product archive changed while it was captured");
      bytes = bytes.subarray(0, info.size);
    } finally { await handle.close(); }
    artifacts.push(await input.store.put(bytes, {
      name: `${application.split(sep).at(-1).replace(/[^a-zA-Z0-9._ -]/g, "_")}-${input.profile.platform}-${input.context.commit.slice(0, 12)}.zip`, mime: "application/zip",
      goalId: input.context.candidate.goalId, taskId: input.context.candidate.taskId, attemptId: input.context.candidate.attemptId,
      metadata: { candidateId: input.context.candidate.id, commit: input.context.commit, candidateCommit: input.context.candidate.commit, platform: input.profile.platform, scheme: input.profile.scheme, unsigned: true, format: "apple-app-zip" },
    }));
  }
  return artifacts;
}

/** Trusted validation code executes within the native sandbox, never in the service process. */
export const APPLE_PRODUCT_INVENTORY_SOURCE = String.raw`
const fs = require("node:fs/promises"), paths = require("node:path");
(async () => {
  const productsRoot = process.argv[1], applications = [];
  async function discover(directory, depth) {
    if (depth > 6) throw new Error("Apple product layout exceeds validation limits");
    const entries = await fs.readdir(directory, {withFileTypes: true}).catch(error => {
      if (error.code === "ENOENT") return []; throw error;
    });
    if (entries.length > 1000) throw new Error("Too many Apple products");
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = paths.join(directory, entry.name);
      if (entry.name.endsWith(".app")) applications.push(path);
      else await discover(path, depth + 1);
    }
  }
  await discover(productsRoot, 0);
  if (applications.length > 4) throw new Error("Too many Apple app products");
  for (const application of applications) {
    const root = await fs.realpath(application);
    if (root !== paths.resolve(application) || !(await fs.lstat(root)).isDirectory()) throw new Error("Apple product must be a private directory");
    let count = 0, size = 0;
    async function visit(path, depth) {
      if (++count > 20000 || depth > 32) throw new Error("Apple product exceeds file limits");
      const info = await fs.lstat(path);
      if (info.isSymbolicLink()) {
        const destination = await fs.realpath(path);
        if (destination !== root && !destination.startsWith(root + paths.sep)) throw new Error("Apple product contains a symlink escaping the captured app");
      } else if (info.isDirectory()) {
        for (const name of await fs.readdir(path)) await visit(paths.join(path, name), depth + 1);
      } else if (info.isFile()) {
        size += info.size;
        if (size > 256 * 1024 * 1024) throw new Error("Apple product exceeds 256 MiB");
      } else throw new Error("Apple product contains an unsupported file");
    }
    await visit(root, 0);
  }
  process.stdout.write(JSON.stringify(applications));
})().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
`;

/** Deliberately does not import system.sb/bsd.sb or grant any Mach/XPC service lookup. */
export function appleSandboxProfile(input: { sources: string[]; scratch: string; developerDirectory: string; validatorExecutable?: string }): string {
  const readRoots = ["/System/Library", "/System/iOSSupport", "/System/Volumes/Preboot/Cryptexes/App/System", "/System/Volumes/Preboot/Cryptexes/Incoming/OS", "/System/Volumes/Preboot/Cryptexes/OS", "/System/Volumes/Preboot/Cryptexes/Rosetta", "/System/Cryptexes/App", "/System/Cryptexes/OS", "/System/Cryptexes/Rosetta", "/Library/Developer/PrivateFrameworks", "/Library/Apple/System/Library", "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share", dirname(dirname(input.developerDirectory)), ...input.sources, input.scratch];
  const ancestors = new Set<string>(["/", "/Applications", "/Applications/Xcode.app", "/Applications/Xcode.app/Contents", "/private", "/private/var", "/dev"]);
  for (const root of readRoots) for (let parent = dirname(root); parent !== "/"; parent = dirname(parent)) ancestors.add(parent);
  const quoted = (value: string) => JSON.stringify(value);
  return [
    "(version 1)", "(deny default)", "(allow process-fork)",
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "sysctl.") (sysctl-name "kern.hostname" "kern.ostype" "kern.osrelease" "kern.osversion" "kern.version" "kern.osproductversion" "kern.osproductversioncompat" "kern.argmax" "kern.secure_kernel" "kern.ngroups" "kern.maxfilesperproc" "kern.osvariant_status"))',
    // Explicit dyld bootstrap operations, from Apple's dyld-support.sb. Importing
    // system.sb would also authorize host services and user preference access.
    '(allow syscall-unix (syscall-number SYS___mac_syscall SYS_getfsstat SYS_getfsstat64 SYS_map_with_linking_np SYS_open SYS_openat SYS_fstatat SYS_fstatat64 SYS_dup))',
    '(allow system-fcntl (fcntl-command F_ADDFILESIGS_RETURN F_CHECK_LV F_GETPATH))',
    '(allow system-mac-syscall (require-all (mac-policy-name "Sandbox") (mac-syscall-number 2)))',
    '(allow file-read* (literal "/"))',
    '(allow file-read* (literal "/private/var/select/sh") (literal "/Library/Preferences/com.apple.dt.Xcode.plist"))',
    `(allow process-exec file-map-executable ${readRoots.map(path => `(subpath ${quoted(path)})`).join(" ")})`,
    ...input.validatorExecutable ? [`(allow process-exec file-map-executable file-read* (literal ${quoted(input.validatorExecutable)}))`] : [],
    `(allow file-read* ${readRoots.map(path => `(subpath ${quoted(path)})`).join(" ")})`,
    `(allow file-read-metadata ${[...ancestors].map(path => `(literal ${quoted(path)})`).join(" ")})`,
    // Xcode's vendored SwiftPM checks the system temp directory even with a private
    // TMPDIR. Permit only that type check; contents and global temp writes stay denied.
    '(allow file-read-metadata (literal "/tmp") (literal "/private/tmp"))',
    `(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/zero") (literal "/dev/fd/0") (literal "/dev/fd/1") (literal "/dev/fd/2"))`,
    `(allow file-write* (subpath ${quoted(input.scratch)}))`,
    // Keep the scratch root itself anchored; untrusted children may change only its contents.
    `(deny file-write* (literal ${quoted(input.scratch)}))`,
    `(deny file-write* (subpath ${quoted(join(input.scratch, "tools"))}))`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/fd/1") (literal "/dev/fd/2"))',
  ].join("\n");
}

async function verifyBoundary(input: { execute: NativeRunner; policy: string; scratch: string; guard: string; environment: NodeJS.ProcessEnv; signal?: AbortSignal }): Promise<void> {
  const sentinel = join(input.guard, "read-sentinel");
  const forbiddenWrite = join(input.guard, "write-sentinel");
  await writeFile(sentinel, "enoughfactory-private-sentinel", { mode: 0o600 });
  await writeFile(join(input.scratch, "probe-input"), "enoughfactory", { mode: 0o600 });
  const alias = `/System/Volumes/Data${sentinel}`;
  const hasAlias = await lstat(alias).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
  await symlink(sentinel, join(input.scratch, "probe-forbidden-link"));
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not create the private Apple sandbox network probe");
    const connector = await input.execute("/usr/bin/nc", ["-z", "-G", "1", "127.0.0.1", String(address.port)], { cwd: input.scratch, env: input.environment, timeoutMs: 2_000, signal: input.signal });
    if (connector.exitCode !== 0 || connector.timedOut) throw new Error("The private Apple sandbox network probe could not establish its positive control");
    const script = 'set -eu; test "$(/bin/cat "$1")" = enoughfactory; printf allowed > "$2"; if /bin/cat "$3" >/dev/null 2>&1; then exit 91; fi; if /bin/sh -c \'printf denied > "$1"\' enoughfactory "$4" >/dev/null 2>&1; then exit 92; fi; if /usr/bin/nc -z -G 1 127.0.0.1 "$5" >/dev/null 2>&1; then exit 93; fi; if /bin/cat "$6" >/dev/null 2>&1; then exit 94; fi; if [ -n "$7" ] && /bin/cat "$7" >/dev/null 2>&1; then exit 95; fi; printf enoughfactory-boundary-verified';
    const result = await input.execute("/usr/bin/sandbox-exec", ["-p", input.policy, "/bin/sh", "-c", script, "enoughfactory-probe", join(input.scratch, "probe-input"), join(input.scratch, "probe-output"), sentinel, forbiddenWrite, String(address.port), join(input.scratch, "probe-forbidden-link"), hasAlias ? alias : ""], { cwd: input.scratch, env: input.environment, timeoutMs: 10_000, signal: input.signal });
    const untouched = await readFile(sentinel, "utf8");
    const escapedWrite = await lstat(forbiddenWrite).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    if (result.exitCode !== 0 || result.timedOut || result.stdout !== "enoughfactory-boundary-verified" || untouched !== "enoughfactory-private-sentinel" || escapedWrite || await readFile(join(input.scratch, "probe-output"), "utf8") !== "allowed") throw new Error(`Apple validation sandbox is unavailable or did not enforce its boundaries; native execution was not started. ${result.stderr.trim()}`);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

/** A failed teardown leaves its unique scratch directory quarantined for diagnosis. */
export class NativeTeardownError extends Error {}

/** Group cleanup covers ordinary compiler children; retained escaped pipes fail closed. */
export async function runNativeGroup(file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<ProcessOutput> {
  if (options.signal?.aborted) return { exitCode: 130, stdout: "", stderr: "Apple validation was canceled before execution", timedOut: false };
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, settled = false, canceled = false;
    const limit = 8 * 1024 * 1024;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString().slice(0, Math.max(0, limit - stdout.length)); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString().slice(0, Math.max(0, limit - stderr.length)); });
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); if (drainTimer) clearTimeout(drainTimer); options.signal?.removeEventListener("abort", abort); };
    const failTeardown = (cause: unknown) => {
      if (settled) return;
      settled = true; cleanup(); child.stdout.destroy(); child.stderr.destroy();
      reject(new NativeTeardownError("Native Apple validation could not confirm process-group termination or evidence-pipe closure; scratch was quarantined", { cause }));
    };
    const killGroup = (signal: NodeJS.Signals): boolean => {
      if (!child.pid) return true;
      try { process.kill(-child.pid, signal); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; failTeardown(error); return false; }
    };
    const waitForDrain = () => {
      drainTimer ??= setTimeout(() => failTeardown(new Error("Native process pipes remained open after group termination")), 1_500);
    };
    const cancel = () => {
      if (!killGroup("SIGTERM")) return;
      forceTimer ??= setTimeout(() => { if (killGroup("SIGKILL")) waitForDrain(); }, 1_000);
    };
    const abort = () => { canceled = true; cancel(); };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    // Kill at exit even when a descendant retained stdout/stderr; keep a bounded drain.
    child.once("exit", () => { if (!settled && killGroup("SIGKILL")) waitForDrain(); });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true; cleanup();
      canceled ||= options.signal?.aborted ?? false;
      resolve({ exitCode: canceled ? 130 : code ?? 130, stdout, stderr: canceled ? `${stderr}\nApple validation was canceled` : signal ? `${stderr}\nApple validation terminated by ${signal}` : stderr, timedOut });
    });
    if (options.signal?.aborted) abort();
  });
}
