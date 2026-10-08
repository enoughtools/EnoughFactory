import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const nativeSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_BUILD_INPUTS = Object.freeze({
  macos: Object.freeze(['native/build-receipt.mjs', 'native/macos/build.mjs', 'native/macos/Info.plist', 'native/macos/InspectionHelper.swift']),
  'ios-simulator': Object.freeze(['native/build-receipt.mjs', 'native/ios/build-runner.sh', 'native/ios/EnoughNativeInspection.xcodeproj/project.pbxproj', 'native/ios/EnoughNativeInspection.xcodeproj/xcshareddata/xcschemes/EnoughNativeInspection.xcscheme', 'native/ios/prepare-run.mjs', 'native/ios/Sources/NativeInspectionRunner.swift', 'native/ios/Sources/WireProtocol.swift']),
});
export const NATIVE_ASSET_SOURCE_FILES = Object.freeze([...new Set([...NATIVE_BUILD_INPUTS.macos, ...NATIVE_BUILD_INPUTS['ios-simulator'], 'native/package-assets.mjs'])].sort());
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const keysEqual = (a, b) => JSON.stringify(Object.keys(a).sort()) === JSON.stringify([...b].sort());
function inputsFor(platform) { const files = NATIVE_BUILD_INPUTS[platform]; if (!files) throw new Error('Unknown native build platform.'); return files; }

export async function captureNativeInputs(platform, sourceRoot = nativeSourceRoot) {
  const canonicalRoot = await realpath(sourceRoot); const inputs = {};
  for (const path of inputsFor(platform)) {
    const file = join(canonicalRoot, path); const metadata = await lstat(file); const canonical = await realpath(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !canonical.startsWith(canonicalRoot + sep)) throw new Error(`Native build input is not an original contained file: ${path}`);
    inputs[path] = digest(await readFile(file));
  }
  return inputs;
}

/** Complete product inventory; external symlinks cannot become installed native dependencies. */
export async function inventoryNativeOutputs(outputRoot) {
  const root = await realpath(outputRoot); const entries = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name); const metadata = await lstat(path); const key = relative(root, path).split(sep).join('/');
      if (!key || key.startsWith('../') || key.startsWith('/')) throw new Error('Native output escaped its product root.');
      const base = { path: key, mode: metadata.mode & 0o777 };
      if (metadata.isSymbolicLink()) {
        const target = await readlink(path); const canonical = await realpath(path);
        if (canonical !== root && !canonical.startsWith(root + sep)) throw new Error(`Native output symlink escapes its product root: ${key}`);
        entries.push({ ...base, type: 'symlink', target });
      } else if (metadata.isDirectory()) { entries.push({ ...base, type: 'directory' }); await walk(path); }
      else if (metadata.isFile()) entries.push({ ...base, type: 'file', size: metadata.size, sha256: digest(await readFile(path)) });
      else throw new Error(`Unsupported native output entry: ${key}`);
    }
  }
  await walk(root); return entries;
}

export async function verifyNativeBuildReceipt(receipt, platform, sourceRoot, outputRoot) {
  const required = inputsFor(platform);
  if (!receipt || receipt.version !== 1 || receipt.kind !== 'enoughfactory-native-build' || receipt.platform !== platform
      || !receipt.inputs || typeof receipt.inputs !== 'object' || Array.isArray(receipt.inputs) || !keysEqual(receipt.inputs, required)
      || !Array.isArray(receipt.outputs) || !receipt.outputs.length
      || !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.completedAt)) || Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)
      || !receipt.toolchain || ['xcode', 'swift', 'simulatorSDK'].some(key => typeof receipt.toolchain[key] !== 'string' || !receipt.toolchain[key].trim())) throw new Error('Native build receipt is incomplete or has an unexpected input set.');
  const current = await captureNativeInputs(platform, sourceRoot);
  for (const path of required) if (!/^[a-f0-9]{64}$/.test(receipt.inputs[path]) || receipt.inputs[path] !== current[path]) throw new Error(`Native source changed since its recorded build: ${path}`);
  const outputs = await inventoryNativeOutputs(outputRoot);
  if (JSON.stringify(outputs) !== JSON.stringify(receipt.outputs)) throw new Error('Native product bytes or inventory differ from their successful build receipt.');
}

async function toolchain() {
  const run = async (file, args) => (await execute(file, args, { timeout: 30_000, maxBuffer: 256 * 1024 })).stdout.trim();
  return { xcode: await run('/usr/bin/xcodebuild', ['-version']), swift: await run('/usr/bin/xcrun', ['swiftc', '--version']), simulatorSDK: await run('/usr/bin/xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-version']) };
}
async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export const nativeBuildReceiptPath = buildRoot => join(resolve(buildRoot), 'native-build-receipt.json');
const pendingPath = buildRoot => join(resolve(buildRoot), 'native-build-inputs.pending.json');
const outputRootFor = (platform, buildRoot) => platform === 'macos' ? join(resolve(buildRoot), 'EnoughFactory Native Inspection.app') : join(resolve(buildRoot), 'Build/Products');

export async function beginNativeBuild(platform, buildRoot) {
  await mkdir(resolve(buildRoot), { recursive: true });
  const record = { version: 1, kind: 'enoughfactory-native-build', platform, startedAt: new Date().toISOString(), toolchain: await toolchain(), inputs: await captureNativeInputs(platform) };
  await atomicJSON(pendingPath(buildRoot), record); return record;
}
export async function finishNativeBuild(platform, buildRoot) {
  const pending = JSON.parse(await readFile(pendingPath(buildRoot), 'utf8'));
  if (pending.platform !== platform || !keysEqual(pending.inputs ?? {}, inputsFor(platform))) throw new Error('Native build input witness is missing or belongs to another build.');
  const inputs = await captureNativeInputs(platform);
  if (JSON.stringify(inputs) !== JSON.stringify(pending.inputs)) throw new Error('Native inputs changed while compilation was in progress.');
  const receipt = { ...pending, completedAt: new Date().toISOString(), outputs: await inventoryNativeOutputs(outputRootFor(platform, buildRoot)) };
  await verifyNativeBuildReceipt(receipt, platform, nativeSourceRoot, outputRootFor(platform, buildRoot));
  await atomicJSON(nativeBuildReceiptPath(buildRoot), receipt); await rm(pendingPath(buildRoot)); return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, platform, buildRoot] = process.argv.slice(2);
  if (!['begin', 'finish'].includes(operation) || !buildRoot) throw new Error('Use build-receipt.mjs begin|finish PLATFORM BUILD_ROOT.');
  if (operation === 'begin') await beginNativeBuild(platform, buildRoot); else await finishNativeBuild(platform, buildRoot);
}
