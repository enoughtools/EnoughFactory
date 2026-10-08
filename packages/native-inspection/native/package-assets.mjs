import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_ASSET_SOURCE_FILES, nativeBuildReceiptPath, verifyNativeBuildReceipt } from './build-receipt.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptLocations = Object.freeze({ macos: { path: 'build-receipts/macos.json', outputRoot: 'macos/EnoughFactory Native Inspection.app' }, 'ios-simulator': { path: 'build-receipts/ios-simulator.json', outputRoot: 'ios/Products' } });
async function containedFile(root, path) {
  const file = join(root, path); const metadata = await lstat(file); const canonical = await realpath(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !canonical.startsWith(root + sep)) throw new Error(`Native asset is not an original contained file: ${path}`);
  return readFile(file);
}

/** Validate complete source sets plus successful build-time source/output witnesses, including after relocation. */
export async function verifyPackagedNativeInspectionAssets(destination) {
  const output = await realpath(resolve(destination)); const manifest = JSON.parse(await containedFile(output, 'manifest.json'));
  if (manifest.version !== 2 || manifest.helperBundleIdentifier !== 'tools.enough.factory.native-inspection'
    || manifest.macHelper !== 'macos/EnoughFactory Native Inspection.app/Contents/MacOS/EnoughNativeInspection' || manifest.iosPrepareRunScript !== 'ios/prepare-run.mjs'
    || !manifest.sources || JSON.stringify(Object.keys(manifest.sources).sort()) !== JSON.stringify([...NATIVE_ASSET_SOURCE_FILES].sort())
    || !manifest.buildReceipts || JSON.stringify(Object.keys(manifest.buildReceipts).sort()) !== JSON.stringify(Object.keys(receiptLocations).sort())) throw new Error('Native asset manifest is incomplete or has an unexpected source/receipt set.');
  for (const path of NATIVE_ASSET_SOURCE_FILES) if (manifest.sources[path] !== hash(await readFile(join(root, path)))) throw new Error(`Native package source differs from its manifest: ${path}`);
  for (const [platform, expected] of Object.entries(receiptLocations)) {
    const reference = manifest.buildReceipts[platform];
    if (!reference || reference.path !== expected.path || reference.outputRoot !== expected.outputRoot || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new Error('Native asset receipt reference is invalid.');
    const bytes = await containedFile(output, expected.path); if (hash(bytes) !== reference.sha256) throw new Error('Native build receipt bytes differ from their package manifest.');
    const productRoot = await realpath(join(output, expected.outputRoot)); if (!productRoot.startsWith(output + sep)) throw new Error('Packaged native product root escapes its installed assets.');
    await verifyNativeBuildReceipt(JSON.parse(bytes), platform, root, productRoot);
  }
  if (manifest.sources['native/ios/prepare-run.mjs'] !== hash(await containedFile(output, manifest.iosPrepareRunScript))) throw new Error('Packaged runner preparation script differs from its recorded source.');
  const testRuns = (await readdir(join(output, 'ios/Products'))).filter(x => x.endsWith('.xctestrun'));
  if (testRuns.length !== 1 || manifest.iosXctestrun !== `ios/Products/${testRuns[0]}`) throw new Error('Packaged iOS test runner identity does not match its manifest.');
  return manifest;
}
export async function packageNativeInspectionAssets(destination) {
  // Verify the compiler-produced witness before replacing any installed asset tree.
  const macRoot = join(root, '.build'); const iosRoot = join(root, 'native/ios/.build');
  const receipts = { macos: JSON.parse(await readFile(nativeBuildReceiptPath(macRoot), 'utf8')), 'ios-simulator': JSON.parse(await readFile(nativeBuildReceiptPath(iosRoot), 'utf8')) };
  await verifyNativeBuildReceipt(receipts.macos, 'macos', root, join(macRoot, 'EnoughFactory Native Inspection.app'));
  await verifyNativeBuildReceipt(receipts['ios-simulator'], 'ios-simulator', root, join(iosRoot, 'Build/Products'));
  const output = resolve(destination); await mkdir(output, { recursive: true });
  for (const name of ['macos', 'ios']) await rm(join(output, name), { recursive: true, force: true });
  await mkdir(join(output, 'macos'), { recursive: true });
  await cp(join(root, '.build/EnoughFactory Native Inspection.app'), join(output, 'macos/EnoughFactory Native Inspection.app'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const products = join(root, 'native/ios/.build/Build/Products');
  await cp(products, join(output, 'ios/Products'), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  await cp(join(root, 'native/ios/prepare-run.mjs'), join(output, 'ios/prepare-run.mjs'));
  const testRuns = (await readdir(products)).filter(x => x.endsWith('.xctestrun'));
  if (testRuns.length !== 1) throw new Error('Expected one pinned native iOS runner build.');
  const sources = {};
  for (const path of NATIVE_ASSET_SOURCE_FILES) sources[path] = hash(await readFile(join(root, path)));
  await mkdir(join(output, 'build-receipts'), { recursive: true }); const buildReceipts = {};
  for (const [platform, expected] of Object.entries(receiptLocations)) {
    const buildRoot = platform === 'macos' ? macRoot : iosRoot; const bytes = await readFile(nativeBuildReceiptPath(buildRoot));
    await writeFile(join(output, expected.path), bytes, { mode: 0o600 }); buildReceipts[platform] = { ...expected, sha256: hash(bytes) };
  }
  const manifest = { version: 2, helperBundleIdentifier: 'tools.enough.factory.native-inspection', macHelper: 'macos/EnoughFactory Native Inspection.app/Contents/MacOS/EnoughNativeInspection', iosXctestrun: `ios/Products/${testRuns[0]}`, iosPrepareRunScript: 'ios/prepare-run.mjs', sources, buildReceipts };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n'); await verifyPackagedNativeInspectionAssets(output); return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2]; if (!target) throw new Error('Pass native asset output directory.');
  await packageNativeInspectionAssets(target); console.log(resolve(target));
}
