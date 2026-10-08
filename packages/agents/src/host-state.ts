import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AgentError, type TurnInput } from "./types.ts";
import type { HostCodexRuntime } from "./host-provision.ts";
import { codexToolConfiguration, validateToolEnvironment } from "./tool-config.ts";
import { reconcileHostProcesses } from "./host-process.ts";

export interface HostSessionState { homeDirectory: string; codexHome: string; processDirectory: string; cwd: string; environment: NodeJS.ProcessEnv; }
async function ownedDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory), parts = resolved.split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new AgentError("A host execution directory changed ownership or is a link.", "HOST_STORAGE_UNSAFE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}
async function privateFile(filename: string, content: string | Buffer): Promise<void> {
  try { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink()) throw new AgentError("A private provider file changed ownership.", "HOST_STORAGE_UNSAFE"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeFile(filename, content, { mode: 0o600 }); await chmod(filename, 0o600);
}
export async function prepareHostSession(input: TurnInput, runtime: HostCodexRuntime, options: { runtimeDirectory: string; workspaceRoots: string[]; copyHostAuth?: boolean; hostAuthDir?: string }): Promise<HostSessionState> {
  if (!input.cwd || !path.isAbsolute(input.cwd) || !input.sessionId || input.sessionId.length > 512) throw new AgentError("Host authoring requires an owned workspace and session identity.", "HOST_WORKSPACE_REQUIRED");
  const cwd = await realpath(input.cwd);
  const roots = await Promise.all(options.workspaceRoots.map(root => realpath(root)));
  if (!roots.some(root => !path.relative(root, cwd).startsWith(`..${path.sep}`) && path.relative(root, cwd) !== ".." && !path.isAbsolute(path.relative(root, cwd)))) throw new AgentError("Host authoring must use its private Factory workspace.", "HOST_WORKSPACE_REQUIRED");
  const rootDirectory = await realpath(options.runtimeDirectory), sessions = path.join(rootDirectory, "sessions");
  const sessionKey = createHash("sha256").update(input.sessionId).digest("hex");
  const homeDirectory = path.join(sessions, sessionKey), codexHome = path.join(homeDirectory, ".codex"), processDirectory = path.join(homeDirectory, "processes");
  await ownedDirectory(homeDirectory);
  const receiptPath = path.join(homeDirectory, "session.json");
  try {
    const info = await lstat(receiptPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new AgentError("The host session ownership record is invalid.", "HOST_STORAGE_UNSAFE");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { schemaVersion?: number; sessionId?: string; cwd?: string; retiredAt?: string };
    if (receipt.schemaVersion !== 1 || receipt.sessionId !== input.sessionId || receipt.cwd !== cwd) throw new AgentError("The host session belongs to another execution workspace.", "HOST_STORAGE_UNSAFE");
    if (receipt.retiredAt) throw new AgentError("This terminal verifier provider home was retired; its conversation and source are retained by the service.", "HOST_SESSION_RETIRED");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if ((await readdir(homeDirectory)).length) throw new AgentError("The host session has no verifiable ownership record.", "HOST_STORAGE_UNSAFE");
    await writeFile(receiptPath, JSON.stringify({ schemaVersion: 1, sessionId: input.sessionId, cwd, createdAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  }
  const incomplete = reconcileHostProcesses(processDirectory).find(record => record.state !== "exited");
  if (incomplete) throw new AgentError(incomplete.state === "active" ? "The previous host author process is still active. Reconcile it before resuming." : "The previous host author process outcome is unknown. Reconcile it before resuming.", incomplete.state === "active" ? "HOST_PROCESS_ACTIVE" : "HOST_PROCESS_UNKNOWN");
  await Promise.all([ownedDirectory(codexHome), ownedDirectory(processDirectory), ownedDirectory(path.join(homeDirectory, "tmp"))]);
  let hasAuthentication = false;
  try { const info = await lstat(path.join(codexHome, "auth.json")); if (!info.isFile() || info.isSymbolicLink()) throw new AgentError("The session authentication file ownership changed.", "HOST_STORAGE_UNSAFE"); hasAuthentication = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  // Keep refreshes made by this provider home when the thread resumes.
  if (options.copyHostAuth && !hasAuthentication) {
    const source = path.join(options.hostAuthDir ?? homedir(), ".codex", "auth.json");
    try {
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new AgentError("The selected Codex authentication file is not a regular credential file.", "INVALID_CREDENTIAL");
      await privateFile(path.join(codexHome, "auth.json"), await readFile(source));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  // Tool configuration belongs to the current thread's private RPC request.
  // A persisted provider home must not retain an old attempt's tool credential.
  await privateFile(path.join(codexHome, "config.toml"), codexToolConfiguration());
  const environment: NodeJS.ProcessEnv = {
    HOME: homeDirectory, CODEX_HOME: codexHome, TMPDIR: path.join(homeDirectory, "tmp"),
    PATH: `${path.dirname(runtime.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin:/Library/Apple/usr/bin`,
    LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
    // Xcode selection is a toolchain setting; no provider keys/config are inherited.
    ...(process.env.DEVELOPER_DIR ? { DEVELOPER_DIR: process.env.DEVELOPER_DIR } : {}),
    ...validateToolEnvironment(input.toolEnvironment),
  };
  await access(runtime.nodePath); await access(runtime.codexPath);
  return { homeDirectory, codexHome, processDirectory, cwd, environment };
}

/** Called only after the service has retained a terminal verifier's chat and source.
 * Keep its tiny ownership/process journal so retirement also fences later resume.
 */
export async function retireHostSessionState(sessionId: string, expectedCwd: string, runtimeDirectory: string): Promise<boolean> {
  if (!sessionId || sessionId.length > 512 || !path.isAbsolute(expectedCwd)) throw new AgentError("Invalid terminal host session identity.", "HOST_STORAGE_UNSAFE");
  const rootDirectory = await realpath(runtimeDirectory);
  const homeDirectory = path.join(rootDirectory, "sessions", createHash("sha256").update(sessionId).digest("hex"));
  let state: Awaited<ReturnType<typeof lstat>>;
  try { state = await lstat(homeDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!state.isDirectory() || state.isSymbolicLink() || await realpath(homeDirectory) !== homeDirectory) throw new AgentError("The retired host provider home is not an exact owned directory.", "HOST_STORAGE_UNSAFE");
  const receiptPath = path.join(homeDirectory, "session.json"), receiptState = await lstat(receiptPath);
  if (!receiptState.isFile() || receiptState.isSymbolicLink() || receiptState.size > 8192) throw new AgentError("The retired host provider receipt is invalid.", "HOST_STORAGE_UNSAFE");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { schemaVersion?: number; sessionId?: string; cwd?: string; retiredAt?: string };
  if (receipt.schemaVersion !== 1 || receipt.sessionId !== sessionId || receipt.cwd !== expectedCwd) throw new AgentError("The retired provider home belongs to another execution workspace.", "HOST_STORAGE_UNSAFE");
  const processes = reconcileHostProcesses(path.join(homeDirectory, "processes"));
  if (processes.some(record => record.sessionId !== sessionId || record.state !== "exited")) throw new AgentError("The host verifier provider still has active or unknown process ownership.", "HOST_PROCESS_UNKNOWN");
  if (!receipt.retiredAt) {
    const temporary = path.join(homeDirectory, ".session-retirement.json");
    await privateFile(temporary, JSON.stringify({ ...receipt, retiredAt: new Date().toISOString() }));
    await rename(temporary, receiptPath);
  }
  const remove = async (directory: string): Promise<void> => {
    const state = await lstat(directory);
    if (state.isDirectory() && !state.isSymbolicLink()) {
      await chmod(directory, (state.mode & 0o777) | 0o700);
      for (const name of await readdir(directory)) await remove(path.join(directory, name));
    }
    await rm(directory, { recursive: true, force: true });
  };
  for (const name of await readdir(homeDirectory)) if (name !== "session.json" && name !== "processes") await remove(path.join(homeDirectory, name));
  return true;
}
