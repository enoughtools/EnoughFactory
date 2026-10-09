import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appInventorySha256, NativeInspectionBackend, NativeSessionNotAllocatedError, type NativeBackendOptions, type NativeProduct } from './index.js';

const sessionId = '11111111-2222-4333-8444-555555555555';
const phone16 = { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro', name: 'iPhone 16 Pro', productFamily: 'iPhone', minRuntimeVersionString: '18.0.0' };
const phone18 = { identifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro', name: 'iPhone 18 Pro', productFamily: 'iPhone', minRuntimeVersionString: '27.0.0' };
const runtime18 = { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-6', version: '18.6', isAvailable: true, supportedDeviceTypes: [phone16] };
const runtime27 = { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', version: '27.0', isAvailable: true, supportedDeviceTypes: [phone18] };
const macOnly = { skip: process.platform !== 'darwin' };

async function fixture(overrides: Partial<NativeBackendOptions> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'enough-ios-readiness-')));
  const app = join(root, 'Original.app'); await mkdir(app); await writeFile(join(app, 'original'), 'exact original product bytes');
  const runner = join(root, 'Runner.xctestrun'); await writeFile(runner, 'existing isolated test runner');
  const directory = join(root, 'sessions');
  const backend = new NativeInspectionBackend({ directory, iosXctestrunPath: runner, ...overrides });
  const calls: string[] = []; let runtimeInventory: unknown = { runtimes: [runtime18, runtime27] }; let typeInventory: unknown = { devicetypes: [phone16, phone18] };
  // Existing backend tests replace private transports to keep native lifecycle operations out of fixtures.
  (backend as any).iosInventory = async (kind: string) => { calls.push(kind); return structuredClone(kind === 'runtimes' ? runtimeInventory : typeInventory); };
  const product: NativeProduct = { platform: 'ios-simulator', appPath: app, bundleIdentifier: 'tools.enough.fixture', inventorySha256: await appInventorySha256(app), originalArtifactSha256: 'a'.repeat(64), source: { kind: 'integrated', commit: 'a'.repeat(40) }, launchArguments: ['--fixture', 'isolated'], fixture: { kind: 'verified-isolated', runId: 'isolated', evidenceSha256: 'a'.repeat(64) } };
  return { root, app, runner, directory, backend, product, calls, inventory: (runtimes: unknown, types: unknown = typeInventory) => { runtimeInventory = runtimes; typeInventory = types; } };
}

for (const scenario of [
  { name: 'latest available compatible default', options: {}, expected: { runtimeIdentifier: runtime27.identifier, deviceTypeIdentifier: phone18.identifier } },
  { name: 'installed configured runtime and iPhone', options: { iosSimulatorRuntime: runtime18.identifier, iosSimulatorDeviceType: phone16.identifier }, expected: { runtimeIdentifier: runtime18.identifier, deviceTypeIdentifier: phone16.identifier } },
  { name: 'an older available runtime compatible with the configured iPhone', options: { iosSimulatorDeviceType: phone16.identifier }, expected: { runtimeIdentifier: runtime18.identifier, deviceTypeIdentifier: phone16.identifier } },
]) {
  test(`iOS readiness and fresh start use the ${scenario.name} selection`, macOnly, async () => {
    const f = await fixture(scenario.options); let launched = 0;
    try {
      assert.deepEqual(await f.backend.readiness('ios-simulator'), { status: 'ready', reasons: [] });
      const inventory = (f.backend as any).iosInventory;
      (f.backend as any).iosInventory = async (kind: string) => {
        await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
        return await inventory(kind);
      };
      (f.backend as any).startIOS = async (running: any, selection: unknown) => {
        launched++;
        assert.deepEqual(selection, scenario.expected);
        assert.equal(running.session.id, sessionId);
        const owner = JSON.parse(await readFile(join(running.session.directory, 'session-owner.json'), 'utf8'));
        assert.equal(owner.productInventorySha256, f.product.inventorySha256);
        assert.equal(owner.originalArtifactSha256, f.product.originalArtifactSha256);
      };
      const session = await f.backend.start(f.product, 'attempt-ios-selection', sessionId);
      assert.equal(launched, 1);
      assert.deepEqual(f.calls, ['runtimes', 'devicetypes', 'runtimes', 'devicetypes']);
      assert.deepEqual(session.product, f.product);
      assert.equal(await appInventorySha256(f.app), f.product.inventorySha256);
      assert.equal(JSON.parse(await readFile(join(session.directory, 'session.json'), 'utf8')).status, 'running');
      await f.backend.stop(session.id);
    } finally { f.backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
  });
}

const failures = [
  { name: 'empty runtime inventory', runtimes: { runtimes: [] }, reason: /Install an available iOS Simulator runtime/ },
  { name: 'unavailable iOS runtimes', runtimes: { runtimes: [{ ...runtime18, isAvailable: false }] }, reason: /Install an available iOS Simulator runtime/ },
  { name: 'available non-iOS runtimes', runtimes: { runtimes: [{ ...runtime18, identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0' }] }, reason: /Install an available iOS Simulator runtime/ },
  { name: 'missing runtime inventory', runtimes: {}, reason: /runtime inventory is incomplete/ },
  { name: 'malformed runtime inventory', runtimes: { runtimes: [null] }, reason: /runtime inventory is incomplete/ },
  { name: 'missing runtime availability', runtimes: { runtimes: [{ ...runtime18, isAvailable: undefined }] }, reason: /runtime inventory is incomplete/ },
  { name: 'malformed runtime version', runtimes: { runtimes: [{ ...runtime18, version: 'unknown' }] }, reason: /runtime inventory is incomplete/ },
  { name: 'empty device type inventory', types: { devicetypes: [] }, reason: /No iPhone Simulator device type is installed/ },
  { name: 'missing device type inventory', types: {}, reason: /device type inventory is incomplete/ },
  { name: 'malformed device type inventory', types: { devicetypes: [{ identifier: phone16.identifier }] }, reason: /device type inventory is incomplete/ },
  { name: 'only iPad device types', types: { devicetypes: [{ identifier: 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M4', name: 'iPad Pro' }] }, reason: /No iPhone Simulator device type is installed/ },
  { name: 'no installed compatible iPhone', runtimes: { runtimes: [runtime18] }, types: { devicetypes: [phone18] }, reason: /No installed iPhone device type is compatible/ },
  { name: 'missing supported device inventory', runtimes: { runtimes: [{ ...runtime18, supportedDeviceTypes: undefined }] }, reason: /did not report compatible device types/ },
  { name: 'malformed supported device inventory', runtimes: { runtimes: [{ ...runtime18, supportedDeviceTypes: [null] }] }, reason: /did not report compatible device types/ },
  { name: 'missing configured runtime', options: { iosSimulatorRuntime: 'com.apple.CoreSimulator.SimRuntime.iOS-17-0' }, reason: /configured iOS Simulator runtime/ },
  { name: 'unavailable configured runtime', options: { iosSimulatorRuntime: runtime18.identifier }, runtimes: { runtimes: [{ ...runtime18, isAvailable: false }, runtime27] }, reason: /configured iOS Simulator runtime/ },
  { name: 'configured non-iOS runtime', options: { iosSimulatorRuntime: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0' }, runtimes: { runtimes: [{ ...runtime18, identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-11-0' }] }, reason: /configured iOS Simulator runtime/ },
  { name: 'missing configured iPhone', options: { iosSimulatorDeviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-15' }, reason: /configured iPhone Simulator device type/ },
  { name: 'incompatible configured runtime and iPhone', options: { iosSimulatorRuntime: runtime18.identifier, iosSimulatorDeviceType: phone18.identifier }, reason: /No installed iPhone device type is compatible/ },
];
for (const scenario of failures) {
  test(`iOS ${scenario.name} is actionable before any session allocation`, macOnly, async () => {
    const f = await fixture(scenario.options);
    f.inventory(scenario.runtimes ?? { runtimes: [runtime18, runtime27] }, scenario.types ?? { devicetypes: [phone16, phone18] });
    let launched = false; (f.backend as any).startIOS = async () => { launched = true; };
    try {
      const readiness = await f.backend.readiness('ios-simulator');
      assert.equal(readiness.status, 'setup-required'); assert.match(readiness.reasons.join(' '), scenario.reason);
      await assert.rejects(f.backend.start(f.product, 'attempt-ios-unavailable', sessionId), (error: unknown) => {
        assert.ok(error instanceof NativeSessionNotAllocatedError);
        assert.equal(error.reasonCode, 'setup-required'); assert.equal(error.sessionId, sessionId);
        assert.match(error.message, scenario.reason); return true;
      });
      assert.equal(launched, false);
      await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
      assert.deepEqual(await f.backend.discover(), []);
      assert.equal(await appInventorySha256(f.app), f.product.inventorySha256);
    } finally { f.backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test('iOS inventory is rechecked between advertised readiness and start without allocating a failed session', macOnly, async () => {
  const f = await fixture(); let launched = false; (f.backend as any).startIOS = async () => { launched = true; };
  try {
    assert.equal((await f.backend.readiness('ios-simulator')).status, 'ready');
    f.inventory({ runtimes: [] });
    await assert.rejects(f.backend.start(f.product, 'attempt-ios-inventory-flip', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeSessionNotAllocatedError); assert.equal(error.reasonCode, 'setup-required'); return true;
    });
    assert.deepEqual(f.calls, ['runtimes', 'devicetypes', 'runtimes']); assert.equal(launched, false);
    await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
  } finally { f.backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});

test('an unavailable iOS UI runner still blocks readiness and allocation after compatible inventory', macOnly, async () => {
  const f = await fixture(); let launched = false; (f.backend as any).startIOS = async () => { launched = true; };
  try {
    await rm(f.runner);
    assert.equal((await f.backend.readiness('ios-simulator')).status, 'setup-required');
    await assert.rejects(f.backend.start(f.product, 'attempt-ios-runner-missing', sessionId), (error: unknown) => {
      assert.ok(error instanceof NativeSessionNotAllocatedError); assert.equal(error.reasonCode, 'setup-required'); return true;
    });
    assert.equal(launched, false); await assert.rejects(readdir(f.directory), { code: 'ENOENT' });
  } finally { f.backend.closeTransport(); await rm(f.root, { recursive: true, force: true }); }
});
