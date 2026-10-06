import type { RepositoryChanges, RepositoryChangeFile } from '@enoughfactory/contracts';
import type { EnvmuxReady } from '@enoughfactory/envmux';
import { dockerInvocation, type DockerRuntimeEndpoint } from '@enoughfactory/runtime';
import { exec, HttpError } from './util.ts';

interface GitResult { code: number; stdout: string; stderr: string; }
export type RepositoryReader = (args: string[]) => Promise<GitResult>;
const diffLimit = 2 * 1024 * 1024;

/** Inspection runs as root because fully privileged agents may create private files. */
export function managedRepositoryReader(endpoint: DockerRuntimeEndpoint, ready: EnvmuxReady): RepositoryReader {
  if (ready.dockerHost !== endpoint.host) throw new HttpError(409, 'This environment belongs to a different container engine.');
  return async args => {
    const invocation = dockerInvocation(endpoint, ['exec', '--user', '0', '--workdir', ready.workdir, ready.instance,
      'git', '--no-optional-locks', '--no-pager', '--literal-pathspecs', '-c', 'safe.directory=*', ...args]);
    try {
      const result = await exec(invocation.command, invocation.args, { env: invocation.env, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      if (typeof result.code === 'number' && !result.killed) return { code: result.code, stdout: result.stdout || '', stderr: result.stderr || '' };
      throw new HttpError(502, 'The live repository could not be read. Reconnect the environment and try again.');
    }
  };
}

function filesFromStatus(output: string): RepositoryChangeFile[] {
  const fields = output.split('\0'), files: RepositoryChangeFile[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4 || field[2] !== ' ') continue;
    const indexStatus = field[0]!, workingTreeStatus = field[1]!;
    const originalPath = /[RC]/.test(indexStatus + workingTreeStatus) ? fields[++i] : undefined;
    files.push({ path: field.slice(3), indexStatus, workingTreeStatus, ...(originalPath ? { originalPath } : {}) });
  }
  return files;
}

/** Git status/diff only: never refresh the index, stage, commit or alter permissions. */
export async function readRepositoryChanges(run: RepositoryReader, selectedPath?: string): Promise<RepositoryChanges> {
  if (selectedPath !== undefined && (!selectedPath || selectedPath.length > 4096 || /[\0\\]/.test(selectedPath) || selectedPath.startsWith('/') || selectedPath.split('/').some(part => part === '..' || part === '.git'))) {
    throw new HttpError(400, 'Choose a relative changed-file path.');
  }
  const checked = async (args: string[]) => {
    const result = await run(args);
    // Git can exit successfully while omitting unreadable directories. Never call that clean.
    if (result.code !== 0 || result.stderr.trim()) throw new HttpError(422, (result.stderr || result.stdout || 'The repository could not be read.').slice(0, 2048));
    return result.stdout;
  };
  const status = await checked(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files = filesFromStatus(status);
  const file = selectedPath === undefined ? undefined : files.find(item => item.path === selectedPath);
  if (selectedPath !== undefined && !file) throw new HttpError(404, 'This file no longer has uncommitted changes.');
  const [head, branch] = await Promise.all([checked(['rev-parse', '--verify', 'HEAD']), checked(['branch', '--show-current'])]);
  const untracked = file?.indexStatus === '?' && file.workingTreeStatus === '?';
  const result = await run(['diff', '--no-ext-diff', '--no-textconv', '--color=never', ...(untracked ? ['--no-index', '--', '/dev/null', selectedPath!] : ['HEAD', '--', ...(selectedPath === undefined ? [] : [selectedPath])])]);
  if ((result.code !== 0 && !(untracked && result.code === 1)) || result.stderr.trim()) throw new HttpError(422, (result.stderr || result.stdout || 'The file diff could not be read.').slice(0, 2048));
  return { branch: branch.trim(), head: head.trim(), files, path: selectedPath,
    status: files.map(file => `${file.indexStatus}${file.workingTreeStatus} ${file.path}`).join('\n'),
    diff: result.stdout.slice(0, diffLimit), truncated: result.stdout.length > diffLimit };
}
