import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const identity = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function prepareRunnerConfiguration(configuration) {
  const brokerToken = configuration.brokerToken ?? configuration.token;
  const broker = new URL(configuration.brokerUrl);
  if (broker.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(broker.hostname)
    || !broker.port || broker.username || broker.password || broker.search || broker.hash
    || broker.pathname !== '/') throw new Error('Broker must be an explicit loopback HTTP origin.');
  if (typeof brokerToken !== 'string' || brokerToken.length < 32
    || brokerToken.length > 512 || /\s/.test(brokerToken)) throw new Error('Invalid broker token.');
  if (!identity.test(configuration.sessionId ?? '')) throw new Error('Invalid session identity.');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/.test(configuration.bundleIdentifier ?? '')) throw new Error('Invalid application bundle identifier.');
  const args = configuration.launchArguments;
  if (!Array.isArray(args) || args.length > 128 || !args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    || Buffer.byteLength(JSON.stringify(args)) > 32768) throw new Error('Invalid launch arguments.');
  const environment = configuration.launchEnvironment ?? {};
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)
    || Object.keys(environment).length > 128 || !Object.entries(environment).every(([key, value]) => key && !/[=\0]/.test(key)
      && typeof value === 'string' && !value.includes('\0'))
    || Buffer.byteLength(JSON.stringify(environment)) > 32768) throw new Error('Invalid launch environment.');
  const duration = configuration.maximumDurationSeconds ?? configuration.maxDurationSeconds ?? 900;
  if (!Number.isFinite(duration) || duration < 10 || duration > 3600) throw new Error('Invalid session duration.');
  return {
    ENOUGH_IOS_BROKER_URL: broker.origin,
    ENOUGH_IOS_BROKER_TOKEN: brokerToken,
    ENOUGH_IOS_SESSION_ID: configuration.sessionId,
    ENOUGH_IOS_AUT_BUNDLE_ID: configuration.bundleIdentifier,
    ENOUGH_IOS_LAUNCH_ARGUMENTS_JSON: JSON.stringify(args),
    ENOUGH_IOS_LAUNCH_ENVIRONMENT_JSON: JSON.stringify(environment),
    ENOUGH_IOS_MAX_DURATION_SECONDS: String(duration),
  };
}

export function configureTestRun(template, productsDirectory, configuration) {
  if (!isAbsolute(productsDirectory)) throw new Error('The build products directory must be absolute.');
  // Relocated xctestrun files resolve __TESTROOT__ against their new directory.
  // Preserve the immutable runner build, not an accidentally missing/new runner.
  const relocate = (value) => {
    if (typeof value === 'string') return value.replaceAll('__TESTROOT__', productsDirectory).replaceAll('__DERIVEDDATA__', resolve(productsDirectory, '../..'));
    if (Array.isArray(value)) return value.map(relocate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, relocate(child)]));
    return value;
  };
  const result = relocate(template);
  const targets = result.TestConfigurations
    ? result.TestConfigurations.flatMap((entry) => entry.TestTargets ?? [])
    : Object.values(result).filter((entry) => entry && typeof entry === 'object' && entry.TestBundlePath);
  if (targets.length !== 1 || targets[0].ProductModuleName !== 'EnoughNativeInspection'
    || targets[0].UseUITargetAppProvidedByTests !== true) throw new Error('Expected the standalone EnoughNativeInspection test target.');
  const environment = prepareRunnerConfiguration(configuration);
  const target = targets[0];
  target.EnvironmentVariables = { ...target.EnvironmentVariables, ...environment };
  target.OnlyTestIdentifiers = ['NativeInspectionRunner/testInteractiveSession'];
  target.TestTimeoutsEnabled = true;
  target.DefaultTestExecutionTimeAllowance = Number(environment.ENOUGH_IOS_MAX_DURATION_SECONDS) + 60;
  target.MaximumTestExecutionTimeAllowance = Number(environment.ENOUGH_IOS_MAX_DURATION_SECONDS) + 60;
  target.ParallelizationEnabled = false;
  target.PreferredScreenCaptureFormat = 'screenshots';
  target.SystemAttachmentLifetime = 'deleteOnSuccess';
  target.UserAttachmentLifetime = 'keepAlways';
  return result;
}

function plutil(args, input) {
  const result = spawnSync('/usr/bin/plutil', args, { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Could not convert the test-run configuration.');
  return result.stdout;
}

export function prepareRun(templatePath, sessionDirectory, configurationPath) {
  const configurationStat = lstatSync(configurationPath);
  if (!configurationStat.isFile() || (configurationStat.mode & 0o077) !== 0) {
    throw new Error('The private runner configuration must be a regular file with mode 0600.');
  }
  const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  const template = JSON.parse(plutil(['-convert', 'json', '-o', '-', resolve(templatePath)]));
  const configured = configureTestRun(template, dirname(resolve(templatePath)), configuration);
  mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(sessionDirectory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error('The native session directory must be a private directory with mode 0700.');
  }
  const xml = plutil(['-convert', 'xml1', '-o', '-', '-'], JSON.stringify(configured));
  const output = join(resolve(sessionDirectory), 'inspection.xctestrun');
  writeFileSync(output, xml, { mode: 0o600, flag: 'wx' });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let output;
    if (process.argv.length === 3) {
      const configurationPath = process.argv[2];
      const configurationStat = lstatSync(configurationPath);
      if (!configurationStat.isFile() || (configurationStat.mode & 0o077) !== 0) throw new Error('Runner configuration must be a private 0600 file.');
      const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
      if (typeof configuration.sourceXctestrunPath !== 'string' || typeof configuration.outputDirectory !== 'string') {
        throw new Error('Runner configuration must declare sourceXctestrunPath and outputDirectory.');
      }
      output = prepareRun(configuration.sourceXctestrunPath, configuration.outputDirectory, configurationPath);
    } else if (process.argv.length === 5) {
      output = prepareRun(...process.argv.slice(2));
    } else {
      throw new Error('Usage: node prepare-run.mjs PRIVATE_CONFIGURATION.json');
    }
    process.stdout.write(`${output}\n`);
  } catch {
    // Do not serialize the configuration, token, subprocess output or URL here.
    process.stderr.write('Could not prepare native runner; check the private configuration, file permissions and runner build.\n');
    process.exitCode = 1;
  }
}
