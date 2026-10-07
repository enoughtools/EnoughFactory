import type { DevelopmentToolchainId, Project } from '@enoughfactory/contracts';
import { prepareToolchain, SWIFT_TOOLCHAIN, validatePreparedToolchain, verifyPreparedToolchain, type DockerRuntimeEndpoint, type PreparedToolchain, type ToolchainPreparationOptions } from '@enoughfactory/runtime';
import { exec, HttpError } from './util.ts';
import { lstat } from 'node:fs/promises';
import path from 'node:path';

export type FrozenDevelopmentToolchain = 'default' | PreparedToolchain;

export function parseDevelopmentToolchain(value: unknown): DevelopmentToolchainId | undefined {
  if (value === null || value === undefined || value === 'auto') return undefined;
  if (value === 'default' || value === SWIFT_TOOLCHAIN.id) return value;
  throw new HttpError(400, 'Development toolchain must be auto, default or swift-6.0.3.');
}

/** Inspect file names only: selecting a toolchain never executes a package manifest. */
export async function developmentToolchainChoice(project: Pick<Project, 'path' | 'developmentToolchain'>): Promise<DevelopmentToolchainId> {
  if (project.developmentToolchain !== undefined) return parseDevelopmentToolchain(project.developmentToolchain)!;
  let files: string[];
  try { files = (await exec('git', ['-C', project.path, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\0'); }
  catch {
    files = [];
    for (const name of ['Package.swift', '.swift-version']) {
      try { if ((await lstat(path.join(project.path, name))).isFile()) files.push(name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  return files.some(file => /(?:^|\/)(?:Package\.swift|\.swift-version)$/.test(file) || file.endsWith('.swift')) ? SWIFT_TOOLCHAIN.id : 'default';
}

export function validateFrozenDevelopmentToolchain(value: unknown): FrozenDevelopmentToolchain {
  return value === 'default' ? 'default' : validatePreparedToolchain(value);
}

/** Restart a frozen session only with its original image; a missing image is actionable. */
export async function prepareDevelopmentToolchain(endpoint: DockerRuntimeEndpoint, project: Pick<Project, 'path' | 'developmentToolchain'>, options: ToolchainPreparationOptions & { frozen?: FrozenDevelopmentToolchain } = {}): Promise<FrozenDevelopmentToolchain> {
  if (options.frozen !== undefined) {
    const frozen = validateFrozenDevelopmentToolchain(options.frozen);
    return frozen === 'default' ? frozen : verifyPreparedToolchain(endpoint, frozen, options);
  }
  const choice = await developmentToolchainChoice(project);
  return choice === 'default' ? choice : prepareToolchain(endpoint, choice, options);
}
