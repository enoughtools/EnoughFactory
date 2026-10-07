import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnvmuxEngine, type StartOptions } from '../src/index.ts';

const goldenImage = `sha256:${'a'.repeat(64)}`;
const otherImage = `sha256:${'b'.repeat(64)}`;

interface Invocation {
  event: 'invocation' | 'signal' | 'exit';
  args: string[];
  pid: number;
  goldenImage?: string;
  signal?: string;
}

async function fixture(t: TestContext, options: {
  managedGoldenImage?: boolean;
  receipt?: string | null;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ef-golden-adapter-'));
  const binary = join(directory, 'fake-envmux.mjs');
  const log = join(directory, 'invocations.jsonl');
  const dockerHost = `unix://${join(directory, 'owned.sock')}`;
  const capabilities = {
    protocolVersion: 1,
    managedDocker: true,
    ...(options.managedGoldenImage === false ? {} : { managedGoldenImage: true }),
  };
  await writeFile(binary, `#!${process.execPath}
import { appendFileSync, writeSync } from 'node:fs';
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const record = event => appendFileSync(log, JSON.stringify({
  args, pid: process.pid, goldenImage: process.env.ENVMUX_MANAGED_GOLDEN_IMAGE, ...event,
}) + '\\n');
record({ event: 'invocation' });
if (args.includes('--factory-capabilities')) {
  console.log(JSON.stringify(${JSON.stringify(capabilities)}));
} else if (args.includes('--version')) {
  console.log('fake-envmux');
} else if (args.includes('info')) {
  console.log('fake-docker');
} else if (args.includes('validate')) {
  process.exitCode = 0;
} else if (args.includes('sessions')) {
  console.log('[]');
} else if (args.includes('--headless')) {
  process.on('exit', () => record({ event: 'exit' }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    record({ event: 'signal', signal });
    process.exit(0);
  });
  const receipt = ${JSON.stringify(options.receipt === undefined ? 'environment' : options.receipt)};
  writeSync(Number(process.env.ENVMUX_BOOTSTRAP_FD), JSON.stringify({
    type: 'ready', version: 1, endpoint: 'http://127.0.0.1:43210', token: 'fake-private-token',
    project: 'project', session: args[2], instance: 'fake-' + args[2],
    workdir: '/workspace', user: 'root', branch: 'fake-branch',
    dockerHost: ${JSON.stringify(dockerHost)},
    goldenImage: receipt === null ? undefined : receipt === 'environment'
      ? process.env.ENVMUX_MANAGED_GOLDEN_IMAGE : receipt,
  }) + '\\n');
  setTimeout(() => process.exit(0), 5000);
} else {
  throw new Error('Unexpected fake engine command: ' + args.join(' '));
}
`, { mode: 0o755 });

  const records = async (): Promise<Invocation[]> => {
    try {
      return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line) as Invocation);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  t.after(async () => {
    const events = await records();
    for (const event of events.filter(event => event.event === 'invocation' && event.args.includes('--headless'))) {
      if (events.some(other => other.pid === event.pid && other.event === 'exit')) continue;
      try { process.kill(event.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    // Wait until the owned fake children have closed before deleting their log.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const remaining = (await records()).filter(event => event.event === 'invocation' && event.args.includes('--headless'));
      const current = await records();
      if (remaining.every(event => current.some(other => other.pid === event.pid && other.event === 'exit'))) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    await rm(directory, { recursive: true, force: true });
  });

  const engine = new EnvmuxEngine({ binary, dockerRuntime: {
    host: dockerHost, cliPath: binary, configDirectory: join(directory, 'private-config'),
  } });
  const start = (options: Omit<StartOptions, 'projectPath'>) => engine.start({
    ...options, projectPath: directory, startupTimeoutMs: 2000,
  });
  return { engine, start, directory, records };
}

test('managed golden image rejects mutable references and malformed image IDs before launching', async t => {
  const fake = await fixture(t);
  for (const image of ['', 'alpine:latest', `sha256:${'a'.repeat(63)}`,
    `sha256:${'A'.repeat(64)}`, `sha256:${'g'.repeat(64)}`, `${goldenImage}\n`]) {
    await assert.rejects(fake.start({ name: 'invalid', goldenImage: image }), /golden.*image|sha256/i);
  }
  assert.equal((await fake.records()).filter(event => event.args.includes('--headless')).length, 0);
});

test('managed golden image clears ambient overrides and passes an explicit image to only its start process', async t => {
  const fake = await fixture(t);
  const previous = process.env.ENVMUX_MANAGED_GOLDEN_IMAGE;
  process.env.ENVMUX_MANAGED_GOLDEN_IMAGE = otherImage;
  try {
    const detected = await fake.engine.detect();
    assert.equal(detected.available, true, detected.error);
    assert.equal(detected.docker.available, true, detected.docker.error);
    assert.deepEqual(await fake.engine.validate(fake.directory), { valid: true });
    assert.deepEqual(await fake.engine.discover(fake.directory), []);
    await fake.start({ name: 'default-before' });
    const selected = await fake.start({ name: 'selected', goldenImage });
    assert.equal(selected.ready.goldenImage, goldenImage);
    assert.deepEqual(await fake.engine.validate(fake.directory), { valid: true });
    assert.deepEqual(await fake.engine.discover(fake.directory), []);
    await fake.start({ name: 'default-after' });

    const calls = (await fake.records()).filter(event => event.event === 'invocation');
    assert.deepEqual(calls.filter(event => event.args.includes('--headless')).map(event => event.goldenImage), [
      '', goldenImage, '',
    ]);
    for (const call of calls) {
      assert.equal(call.goldenImage, call.args.includes('selected') ? goldenImage : '', call.args.join(' '));
    }
  } finally {
    if (previous === undefined) delete process.env.ENVMUX_MANAGED_GOLDEN_IMAGE;
    else process.env.ENVMUX_MANAGED_GOLDEN_IMAGE = previous;
  }
});

test('managed golden image requires capability support even after a default start caches the engine probe', async t => {
  const fake = await fixture(t, { managedGoldenImage: false });
  await fake.start({ name: 'default' });
  await assert.rejects(fake.start({ name: 'unsupported', goldenImage }), /golden.*image|golden.*capabilit/i);
  const starts = (await fake.records()).filter(event => event.event === 'invocation' && event.args.includes('--headless'));
  assert.equal(starts.length, 1);
  assert.equal(starts[0]?.goldenImage, '');
});

for (const [description, receipt] of [['different image', otherImage], ['missing image', null]] as const) {
  test(`managed golden image rejects a readiness receipt with a ${description} and stops the child`, async t => {
    const fake = await fixture(t, { receipt });
    await assert.rejects(fake.start({ name: 'mismatch', goldenImage }), /golden.*image|image.*match|image.*receipt/i);
    const deadline = Date.now() + 2000;
    let events = await fake.records();
    while (!events.some(event => event.event === 'signal' && event.signal === 'SIGINT') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      events = await fake.records();
    }
    assert.ok(events.some(event => event.event === 'signal' && event.signal === 'SIGINT'),
      'The rejected fake engine must receive the adapter stop signal');
  });
}
