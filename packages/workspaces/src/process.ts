import { spawn } from "node:child_process";

export interface ProcessOutput { exitCode: number; stdout: string; stderr: string; timedOut: boolean }

export async function run(file: string, args: string[], options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv; inheritEnv?: boolean } = {}): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.inheritEnv === false ? options.env : { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    // Evidence stays bounded; commands can create larger files as separate artifacts.
    const limit = 8 * 1024 * 1024;
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString().slice(0, limit - stdout.length); });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < limit) stderr += chunk.toString().slice(0, limit - stderr.length); });
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; cancel(); }, options.timeoutMs) : undefined;
    child.once("error", (error) => { if (timer) clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); options.signal?.removeEventListener("abort", cancel); reject(error); });
    child.once("close", (code) => { if (timer) clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); options.signal?.removeEventListener("abort", cancel); resolve({ exitCode: code ?? 130, stdout, stderr, timedOut }); });
    if (options.signal?.aborted) cancel();
  });
}

export async function git(path: string, ...args: string[]): Promise<string> {
  const result = await run("git", ["-C", path, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args]);
  if (result.exitCode !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

export function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value)) throw new Error("Invalid workspace identifier");
  return value;
}
