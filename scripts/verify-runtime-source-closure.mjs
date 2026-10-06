#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultBaseline = '5252bd83a9082d7711e7e3dcbf426daef0abc165';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const nativeRoots = ['vendor/envmux/src', 'vendor/envmux/images/golden', 'vendor/envmux/skills', 'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'global.json', 'nuget.config', 'NuGet.Config', 'vendor/envmux/Directory.Build.props', 'vendor/envmux/Directory.Build.targets', 'vendor/envmux/Directory.Packages.props', 'vendor/envmux/global.json', 'vendor/envmux/nuget.config', 'vendor/envmux/NuGet.Config', 'scripts/envmux-build.mjs', 'scripts/prepare-container-runtime.mjs', 'runtime/container/pins.json', 'runtime/container/relink-kit'];
function changed(path) { const error = new Error(`Runtime reuse refused: source input changed, added or removed: ${path}`); error.code = 'RUNTIME_SOURCE_CHANGED'; return error; }

/** Compare the inputs to the reused compiled assets, not application version strings. */
export async function verifyRuntimeSourceClosure(group, baseline = defaultBaseline) {
  if (!['native-assets', 'ubuntu-source'].includes(group) || !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('Choose native-assets or ubuntu-source and a complete baseline commit.');
  git(['cat-file', '-e', `${baseline}^{commit}`]);
  const roots = group === 'native-assets' ? nativeRoots : ['runtime/container/os-source-kit', 'runtime/container/pins.json'];
  const selected = path => {
    if (path.startsWith('vendor/envmux/skills/')) return /^vendor\/envmux\/skills\/envmux-[^/]+\/SKILL\.md$/.test(path);
    if (path.startsWith('vendor/envmux/images/golden/')) return !path.split('/').some(part => part.startsWith('.'));
    return !/\.md$/i.test(path) && !path.startsWith('runtime/container/relink-kit/verification/');
  };
  const oldPaths = git(['ls-tree', '-r', '--name-only', '-z', baseline, '--', ...roots]).toString().split('\0').filter(path => path && selected(path));
  const currentPaths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...roots]).toString().split('\0').filter(path => path && selected(path));
  const paths = [...new Set([...oldPaths, ...currentPaths])].sort();
  if (paths.length === 0) throw new Error('The runtime source closure is empty.');
  const oldSet = new Set(oldPaths), currentSet = new Set(currentPaths);
  const files = {};
  for (const path of paths) {
    if (!oldSet.has(path) || !currentSet.has(path)) throw changed(path);
    const previous = git(['show', `${baseline}:${path}`]);
    const file = join(root, path);
    let metadata;
    try { metadata = await lstat(file); } catch (error) { if (error.code === 'ENOENT') throw changed(path); throw error; }
    const current = metadata.isFile() ? await readFile(file) : metadata.isSymbolicLink() ? Buffer.from(await readlink(file)) : undefined;
    if (!current) throw new Error(`Runtime reuse refused: unsupported source input: ${path}`);
    // Ubuntu correspondence depends on the guest images, independently of Docker's pins.
    const normalize = bytes => group === 'ubuntu-source' && path === 'runtime/container/pins.json' ? Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8')).images)) : bytes;
    const oldHash = digest(normalize(previous)), currentHash = digest(normalize(current));
    if (oldHash !== currentHash) throw changed(path);
    files[path] = currentHash;
  }
  return { group, baseline, evaluatedSourceCommit: git(['rev-parse', 'HEAD']).toString().trim(), sha256: digest(JSON.stringify(files)), files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const value = flag => { const index = process.argv.indexOf(flag); return index < 0 ? undefined : process.argv[index + 1]; };
  if (process.argv.includes('--help')) { console.log('Usage: node scripts/verify-runtime-source-closure.mjs --group native-assets|ubuntu-source [--baseline <commit>]'); process.exit(0); }
  try { console.log(JSON.stringify({ status: 'equal', ...await verifyRuntimeSourceClosure(value('--group'), value('--baseline') ?? defaultBaseline) })); }
  catch (error) { if (error.code !== 'RUNTIME_SOURCE_CHANGED') throw error; console.log(JSON.stringify({ status: 'changed', message: error.message })); process.exitCode = 2; }
}
