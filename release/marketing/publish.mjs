import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(await readFile(resolve(root, 'apps/marketing/public/downloads/manifest.json'), 'utf8'));
if (manifest.status !== 'published') throw new Error('Prepare the actual published product release catalog before deploying the launch site.');
const execute = promisify(execFile);
const commands = [
  ['pnpm', ['--filter', '@enoughfactory/marketing', 'build']],
  [process.execPath, ['release/marketing/stage-browser-app.mjs']],
  ['pnpm', ['--filter', '@enoughfactory/marketing', 'exec', 'wrangler', 'deploy']]
];
for (const [command, args] of commands) {
  const { stdout, stderr } = await execute(command, args, { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  if (stdout.trim()) console.log(stdout.trim());
  if (stderr.trim()) console.error(stderr.trim());
}
for (const path of ['/', '/docs', '/downloads', '/downloads/manifest.json', '/app']) {
  const response = await fetch(`https://factory.enoughtools.com${path}`, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Published route did not succeed: ${path} (${response.status})`);
  if (path.endsWith('.json')) {
    const value = await response.json();
    if (value.status !== 'published' || value.version !== manifest.version) throw new Error('The public release catalog does not match the released version.');
  } else if (!(await response.text()).includes('EnoughFactory')) throw new Error(`Published page does not contain EnoughFactory: ${path}`);
}
console.log(`Verified EnoughFactory ${manifest.version} at https://factory.enoughtools.com.`);
