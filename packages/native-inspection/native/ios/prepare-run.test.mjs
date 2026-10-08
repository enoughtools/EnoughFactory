import assert from 'node:assert/strict';
import test from 'node:test';
import { configureTestRun, prepareRunnerConfiguration } from './prepare-run.mjs';

const configuration = {
  brokerUrl: 'http://127.0.0.1:41391',
  brokerToken: 'x'.repeat(64),
  sessionId: 'session-owning-this-device',
  bundleIdentifier: 'tools.enough.mail.ios',
  launchArguments: ['--production-fixture', 'native-ui-isolated'],
};

const template = {
  __xctestrun_metadata__: { FormatVersion: 2 },
  TestConfigurations: [{ TestTargets: [{
    ProductModuleName: 'EnoughNativeInspection',
    UseUITargetAppProvidedByTests: true,
    TestHostPath: '__TESTROOT__/Debug-iphonesimulator/EnoughNativeInspection-Runner.app',
    TestBundlePath: '__TESTHOST__/PlugIns/EnoughNativeInspection.xctest',
    TestingEnvironmentVariables: { DYLD_LIBRARY_PATH: '__TESTROOT__/Debug-iphonesimulator:__PLATFORMS__/iPhoneSimulator.platform/Developer/usr/lib' },
  }] }],
};

test('relocating a session preserves original built runner identity and private launch configuration', () => {
  const configured = configureTestRun(template, '/owned/cache/Products', configuration);
  const target = configured.TestConfigurations[0].TestTargets[0];
  assert.equal(target.TestHostPath, '/owned/cache/Products/Debug-iphonesimulator/EnoughNativeInspection-Runner.app');
  assert.equal(target.TestBundlePath, '__TESTHOST__/PlugIns/EnoughNativeInspection.xctest');
  assert.equal(target.TestingEnvironmentVariables.DYLD_LIBRARY_PATH, '/owned/cache/Products/Debug-iphonesimulator:__PLATFORMS__/iPhoneSimulator.platform/Developer/usr/lib');
  assert.equal(target.EnvironmentVariables.ENOUGH_IOS_SESSION_ID, configuration.sessionId);
  assert.deepEqual(JSON.parse(target.EnvironmentVariables.ENOUGH_IOS_LAUNCH_ARGUMENTS_JSON), configuration.launchArguments);
  assert.equal(target.UseUITargetAppProvidedByTests, true);
  assert.equal(target.UITargetAppPath, undefined);
  assert.equal(template.TestConfigurations[0].TestTargets[0].EnvironmentVariables, undefined);
});

test('broker credentials cannot be sent to a remote, redirected or ambiguous origin', () => {
  for (const brokerUrl of ['https://127.0.0.1:41391', 'http://example.com:41391', 'http://127.0.0.1', 'http://user@127.0.0.1:41391', 'http://127.0.0.1:41391/path', 'http://127.0.0.1:41391/?token=secret']) {
    assert.throws(() => prepareRunnerConfiguration({ ...configuration, brokerUrl }));
  }
  assert.throws(() => prepareRunnerConfiguration({ ...configuration, brokerToken: 'short' }));
});

test('session and fixture boundaries remain explicit and bounded', () => {
  assert.throws(() => prepareRunnerConfiguration({ ...configuration, sessionId: '../another-session' }));
  assert.throws(() => prepareRunnerConfiguration({ ...configuration, launchArguments: undefined }));
  assert.throws(() => prepareRunnerConfiguration({ ...configuration, launchArguments: ['\0'] }));
  assert.throws(() => prepareRunnerConfiguration({ ...configuration, maximumDurationSeconds: Infinity }));
  assert.throws(() => prepareRunnerConfiguration({ ...configuration, launchEnvironment: { 'KEY=OTHER': 'value' } }));
});

test('preparing an arbitrary project test run cannot silently rebuild or launch a different target', () => {
  const target = template.TestConfigurations[0].TestTargets[0];
  assert.throws(() => configureTestRun({ TestConfigurations: [{ TestTargets: [{ ...target, ProductModuleName: 'OtherTests' }] }] }, '/owned/cache/Products', configuration));
  assert.throws(() => configureTestRun({ TestConfigurations: [{ TestTargets: [{ ...target, UseUITargetAppProvidedByTests: false }] }] }, '/owned/cache/Products', configuration));
  assert.throws(() => configureTestRun({ TestConfigurations: [{ TestTargets: [target, target] }] }, '/owned/cache/Products', configuration));
});
