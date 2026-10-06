import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRepositoryChanges, type RepositoryReader } from './repository-changes.ts';
const exec = promisify(execFile);

test('live changes include new files and their patch without staging or changing the repository', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'enoughfactory-changes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args: string[]) => exec('git', ['--no-optional-locks', '--no-pager', '--literal-pathspecs', ...args], { cwd: directory });
  await git(['init', '-q']);
  await writeFile(path.join(directory, 'tracked.txt'), 'before\n');
  await git(['add', 'tracked.txt']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Baseline']);
  await writeFile(path.join(directory, 'tracked.txt'), 'after\n');
  const filename = 'new :literal\nfile.md';
  await writeFile(path.join(directory, filename), '# Generated architecture\n');
  const before = await readFile(path.join(directory, '.git', 'index'));
  const run: RepositoryReader = async args => {
    try { const r = await git(args); return { code: 0, stdout: r.stdout, stderr: r.stderr }; }
    catch (error) { const r = error as { code: number; stdout: string; stderr: string }; return r; }
  };
  const changes = await readRepositoryChanges(run);
  assert.deepEqual(changes.files?.map(file => [file.path, file.indexStatus + file.workingTreeStatus]), [['tracked.txt', ' M'], [filename, '??']]);
  assert.match(changes.diff, /\+after/);
  const generated = await readRepositoryChanges(run, filename);
  assert.match(generated.diff, /\+# Generated architecture/);
  assert.equal(generated.path, filename);
  assert.equal(generated.truncated, false);
  await assert.rejects(readRepositoryChanges(run, '../secret'), /relative changed-file path/);
  await assert.rejects(readRepositoryChanges(run, '.git/config'), /relative changed-file path/);
  await assert.rejects(readRepositoryChanges(run, 'missing.txt'), /no longer has uncommitted changes/);
  await assert.rejects(readRepositoryChanges(async () => ({ code: 0, stdout: '', stderr: "warning: could not open directory 'docs/': Permission denied" })), /Permission denied/);
  assert.deepEqual(await readFile(path.join(directory, '.git', 'index')), before, 'inspection must not refresh or stage the index');
  assert.equal((await git(['diff', '--cached'])).stdout, '');
  assert.equal(await readFile(path.join(directory, filename), 'utf8'), '# Generated architecture\n');
});
