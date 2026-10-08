import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { NativeInspectionError, type NativeProduct } from './types.js';

export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export interface AppInventoryEntry { path: string; type: 'file' | 'directory' | 'symlink'; mode: number; size?: number; sha256?: string; target?: string; }
export async function inventoryApp(appPath: string): Promise<AppInventoryEntry[]> {
  const root = await realpath(appPath);
  if (!isAbsolute(appPath) || root !== resolve(appPath) || !(await lstat(root)).isDirectory() || !root.endsWith('.app')) throw new NativeInspectionError('invalid-product', 'App path must be a canonical application directory.');
  const entries: AppInventoryEntry[] = [];
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path); const name = relative(root, path); const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      const target = await realpath(path);
      if (target !== root && !target.startsWith(root + sep)) throw new NativeInspectionError('invalid-product', 'App symlink escapes the product.');
      entries.push({ path: name, type: 'symlink', mode, target: await readlink(path) });
    } else if (stat.isDirectory()) {
      entries.push({ path: name, type: 'directory', mode });
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
    } else if (stat.isFile()) {
      if (stat.size > 512 * 1024 * 1024) throw new NativeInspectionError('invalid-product', 'App file exceeds inspection limit.');
      const bytes = await readFile(path);
      entries.push({ path: name, type: 'file', mode, size: bytes.length, sha256: sha256(bytes) });
    } else throw new NativeInspectionError('invalid-product', 'Unsupported app file type.');
    if (entries.length > 30_000) throw new NativeInspectionError('invalid-product', 'App inventory exceeds inspection limit.');
  }
  await visit(root); return entries;
}
export const appInventorySha256 = async (appPath: string): Promise<string> => sha256(JSON.stringify(await inventoryApp(appPath)));
export async function verifyNativeProduct(product: NativeProduct): Promise<void> {
  const hash = /^[a-f0-9]{64}$/;
  if (!['macos', 'ios-simulator'].includes(product.platform) || !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(product.bundleIdentifier) || !hash.test(product.inventorySha256) || !hash.test(product.originalArtifactSha256)) throw new NativeInspectionError('invalid-product', 'Product identity is incomplete.');
  if (product.fixture?.kind !== 'verified-isolated' || !/^[A-Za-z0-9-]{1,64}$/.test(product.fixture.runId) || !hash.test(product.fixture.evidenceSha256)) throw new NativeInspectionError('fixture-required', 'A verified isolated fixture profile is required.');
  if (!Array.isArray(product.launchArguments) || product.launchArguments.length > 32 || product.launchArguments.some(x => typeof x !== 'string' || x.length > 4096 || x.includes('\0'))) throw new NativeInspectionError('invalid-product', 'Invalid launch arguments.');
  if (!product.source || !['candidate', 'integrated', 'development-snapshot'].includes(product.source.kind) || (product.source.kind === 'development-snapshot' ? !hash.test(product.source.snapshotSha256 ?? '') : !/^[a-f0-9]{40,64}$/.test(product.source.commit ?? ''))) throw new NativeInspectionError('invalid-product', 'Exact source provenance is required.');
  if (await appInventorySha256(product.appPath) !== product.inventorySha256) throw new NativeInspectionError('product-changed', 'App bytes differ from the original verified product.');
}
