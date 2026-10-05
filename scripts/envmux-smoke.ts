import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { EnvmuxEngine } from '../packages/envmux/src/index.ts';
import { ManagedRuntimeManager } from '../packages/runtime/src/index.ts';

function run(program: string, args: string[], cwd?: string): string {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

// One real source-retention journey. This intentionally creates an isolated
// fixture, not a session in a contributor's own working repository.
const directory = await mkdtemp(join(tmpdir(), 'enoughfactory-engine-'));
run('git', ['init'], directory);
run('git', ['config', 'user.name', 'EnoughFactory'], directory);
run('git', ['config', 'user.email', 'factory@enoughtools.com'], directory);
await writeFile(join(directory, 'README.md'), 'Engine source-retention fixture\n');
await writeFile(join(directory, '.envmux.json'), JSON.stringify({
  name: `ef-engine-${basename(directory).split('-').at(-1)?.toLowerCase()}`, portal: { open: false }, tools: {},
  tasks: { proof: { command: 'printf "factory-runtime-ready\\n"', kind: 'once' } },
}));
run('git', ['add', '.'], directory); run('git', ['commit', '-m', 'Fixture'], directory);

const runtime = new ManagedRuntimeManager({ dataDir: process.env.ENOUGHFACTORY_DATA_DIR ?? join(homedir(), '.enoughfactory') });
await runtime.ensureReady();
const engine = new EnvmuxEngine({ dockerRuntime: runtime.endpoint, containerHostAddress: runtime.bridgeHostAddress() });
const detected = await engine.detect();
assert.equal(detected.available, true, detected.error);
assert.equal(detected.docker.available, true, detected.docker.error);
assert.equal((await engine.validate(directory)).valid, true);
let phaseSeen = false;
const session = await engine.start({ projectPath: directory, name: 'workbench',
  onEvent(event) { if (event.type === 'phase') phaseSeen = true; },
});
try {
  const state = await session.state(); assert.equal(state.ready, true);
  assert.equal(phaseSeen, true);
  assert.equal(JSON.stringify(state).includes(session.ready.token), false, 'UI state contains a bootstrap token');
  assert.equal((await engine.discover(directory)).some(item => item.instance === session.id), true);
  const stream = new AbortController();
  for await (const event of session.events(stream.signal)) {
    assert.equal(event.instanceName, session.id); stream.abort(); break;
  }
  const exec = (...args: string[]) => run(runtime.endpoint.cliPath, ['--host', runtime.endpoint.host,
    '--config', runtime.endpoint.configDirectory, 'exec', '-u', 'root', '--workdir', session.ready.workdir, session.ready.instance, ...args]);
  exec('bash', '-lc', 'printf "Recovered from a real container\\n" > RESULT.txt');
  assert.equal((await session.repositoryStatus()).entries.some(entry => entry.path === 'RESULT.txt'), true);
  assert.match((await session.repositoryDiff('RESULT.txt')).diff, /Recovered from a real container/);
  exec('git', 'add', 'RESULT.txt');
  exec('git', '-c', 'user.name=EnoughFactory', '-c', 'user.email=factory@enoughtools.com', 'commit', '-m', 'Recovered engine work');
  const attached = await engine.attach({ ready: session.ready, projectPath: directory, pid: session.process?.pid });
  assert.equal((await attached.state()).instanceName, session.id);
} finally { await session.stop(); }
assert.equal(run('git', ['log', 'envmux/workbench', '-1', '--format=%s'], directory), 'Recovered engine work');
console.log(`Engine journey passed; recovered source remains at ${directory} on envmux/workbench.`);
