import assert from 'node:assert/strict';
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  NATIVE_BUILD_INPUTS,
  captureNativeInputs,
  inventoryNativeOutputs,
  verifyNativeBuildReceipt,
} from './build-receipt.mjs';

// These deliberately synthetic receipts exercise verification only. They are
// not build evidence and never invoke a compiler, code signer, or simulator.
async function fixture(t, platform = 'macos') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'enough-native-receipt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  const outputRoot = join(root, 'outputs');
  const inputPaths = NATIVE_BUILD_INPUTS[platform];
  assert.ok(Array.isArray(inputPaths) && inputPaths.length > 0);
  for (const path of inputPaths) {
    const source = join(sourceRoot, path);
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, `Synthetic ${platform} source: ${path}\n`, { mode: 0o644 });
  }
  const executable = join(outputRoot, 'Fixture.app/Contents/MacOS/Fixture');
  const metadata = join(outputRoot, 'Fixture.app/Contents/Info.plist');
  await mkdir(dirname(executable), { recursive: true });
  await writeFile(executable, 'synthetic native executable bytes\n', { mode: 0o755 });
  await writeFile(metadata, 'synthetic bundle metadata\n', { mode: 0o644 });
  const receipt = {
    version: 1,
    kind: 'enoughfactory-native-build',
    platform,
    startedAt: '2026-10-08T00:00:00.000Z',
    completedAt: '2026-10-08T00:00:01.000Z',
    toolchain: { xcode: 'Synthetic Xcode fixture', swift: 'Synthetic Swift fixture', simulatorSDK: 'Synthetic SDK fixture' },
    inputs: await captureNativeInputs(platform, sourceRoot),
    outputs: await inventoryNativeOutputs(outputRoot),
  };
  return { root, sourceRoot, outputRoot, executable, metadata, inputPaths, receipt };
}

test('exact native input and output receipts survive output relocation', async t => {
  for (const platform of ['macos', 'ios-simulator']) {
    await t.test(platform, async t => {
      const f = await fixture(t, platform);
      await verifyNativeBuildReceipt(f.receipt, platform, f.sourceRoot, f.outputRoot);
      const relocated = join(f.root, 'relocated outputs');
      await cp(f.outputRoot, relocated, { recursive: true, preserveTimestamps: true });
      assert.deepEqual(await inventoryNativeOutputs(relocated), f.receipt.outputs);
      await verifyNativeBuildReceipt(f.receipt, platform, f.sourceRoot, relocated);
      assert.equal(JSON.stringify(f.receipt.outputs).includes(f.outputRoot), false);
    });
  }
});

test('relative symlinks within a product retain their identity after relocation', async t => {
  const f = await fixture(t);
  await symlink('MacOS/Fixture', join(f.outputRoot, 'Fixture.app/Contents/FixtureLink'));
  f.receipt.outputs = await inventoryNativeOutputs(f.outputRoot);
  const relocated = join(f.root, 'relocated linked product');
  await cp(f.outputRoot, relocated, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  assert.deepEqual(await inventoryNativeOutputs(relocated), f.receipt.outputs);
  await verifyNativeBuildReceipt(f.receipt, 'macos', f.sourceRoot, relocated);
});

test('receipts reject current source bytes changed after input capture', async t => {
  const f = await fixture(t);
  const source = join(f.sourceRoot, f.inputPaths[0]);
  await writeFile(source, `${await readFile(source, 'utf8')}changed after capture\n`);
  await assert.rejects(verifyNativeBuildReceipt(f.receipt, 'macos', f.sourceRoot, f.outputRoot));
});

test('receipts require the exact configured input key set and platform', async t => {
  const f = await fixture(t);
  const missing = structuredClone(f.receipt);
  delete missing.inputs[f.inputPaths[0]];
  await assert.rejects(verifyNativeBuildReceipt(missing, 'macos', f.sourceRoot, f.outputRoot));
  const extra = structuredClone(f.receipt);
  extra.inputs['unexpected-source.swift'] = 'a'.repeat(64);
  await assert.rejects(verifyNativeBuildReceipt(extra, 'macos', f.sourceRoot, f.outputRoot));
  await assert.rejects(verifyNativeBuildReceipt(f.receipt, 'ios-simulator', f.sourceRoot, f.outputRoot));
});

test('receipts reject changed output bytes, executable mode, and additional entries', async t => {
  for (const change of ['bytes', 'mode', 'extra']) {
    await t.test(change, async t => {
      const f = await fixture(t);
      if (change === 'bytes') await writeFile(f.executable, 'different synthetic executable bytes\n');
      if (change === 'mode') await chmod(f.executable, 0o644);
      if (change === 'extra') await writeFile(join(f.outputRoot, 'unrecorded-output'), 'extra output\n');
      await assert.rejects(verifyNativeBuildReceipt(f.receipt, 'macos', f.sourceRoot, f.outputRoot));
    });
  }
});

test('source capture and receipt verification reject a source symlink escaping its root', async t => {
  const f = await fixture(t);
  const external = join(f.root, 'outside-source');
  await writeFile(external, 'outside source bytes\n');
  const source = join(f.sourceRoot, f.inputPaths[0]);
  await rm(source);
  await symlink(external, source);
  await assert.rejects(captureNativeInputs('macos', f.sourceRoot));
  await assert.rejects(verifyNativeBuildReceipt(f.receipt, 'macos', f.sourceRoot, f.outputRoot));
});

test('source directories cannot redirect configured inputs outside their root', async t => {
  const f = await fixture(t);
  const topLevelDirectory = f.inputPaths[0].split('/')[0];
  const original = join(f.sourceRoot, topLevelDirectory);
  const external = join(f.root, 'outside-source-directory');
  await rename(original, external);
  await symlink(external, original);
  await assert.rejects(captureNativeInputs('macos', f.sourceRoot));
  await assert.rejects(verifyNativeBuildReceipt(f.receipt, 'macos', f.sourceRoot, f.outputRoot));
});

test('output inventory and receipt verification reject symlinks escaping the output root', async t => {
  const f = await fixture(t);
  const external = join(f.root, 'outside-output');
  await writeFile(external, 'outside output bytes\n');
  await symlink(external, join(f.outputRoot, 'escaped-output'));
  await assert.rejects(inventoryNativeOutputs(f.outputRoot));
  await assert.rejects(verifyNativeBuildReceipt(f.receipt, 'macos', f.sourceRoot, f.outputRoot));
});

test('receipt paths cannot reach outside the declared source or output root', async t => {
  const f = await fixture(t);
  for (const path of ['../outside', '/absolute-output', 'Fixture.app/../../outside']) {
    const invalidOutput = structuredClone(f.receipt);
    assert.ok(invalidOutput.outputs.length > 0);
    invalidOutput.outputs[0].path = path;
    await assert.rejects(verifyNativeBuildReceipt(invalidOutput, 'macos', f.sourceRoot, f.outputRoot));
    const invalidInput = structuredClone(f.receipt);
    invalidInput.inputs[path] = invalidInput.inputs[f.inputPaths[0]];
    delete invalidInput.inputs[f.inputPaths[0]];
    await assert.rejects(verifyNativeBuildReceipt(invalidInput, 'macos', f.sourceRoot, f.outputRoot));
  }
});
