#!/usr/bin/env node
import { readFile, realpath, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

const index = process.argv.indexOf('--executable');
if (process.argv.includes('--help')) {
  console.log('Usage: sudo <bundled-node> configure-linux-desktop-sandbox.mjs --executable <extracted EnoughFactory executable>\nAllows this installed executable to create Chromium sandbox namespaces on AppArmor hosts. Does not disable the sandbox or change global namespace policy.');
  process.exit(0);
}
if (process.platform !== 'linux' || process.getuid?.() !== 0 || index < 0 || !process.argv[index + 1]) throw new Error('Run this setup as the host administrator on Linux and select the extracted EnoughFactory executable.');
const executable = await realpath(resolve(process.argv[index + 1]));
if (basename(executable) !== 'enoughfactory' || /[\n\r"\\*?\[\]{}]/.test(executable)) throw new Error('Select the actual installed enoughfactory executable at an ordinary absolute path.');
const header = (await readFile(executable)).subarray(0, 4);
if (!header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('The selected file is not the native Linux desktop executable.');
const provenance = JSON.parse(await readFile(join(dirname(executable), 'resources/bundle-provenance.json'), 'utf8'));
if (provenance.product !== 'EnoughFactory' || provenance.platform !== 'linux') throw new Error('The selected executable has no matching EnoughFactory Linux bundle.');
await access('/etc/apparmor.d');
const identity = createHash('sha256').update(executable).digest('hex').slice(0, 20);
const profile = `enoughfactory-desktop-${identity}`;
const path = join('/etc/apparmor.d', profile);
const text = `# Managed by EnoughFactory for this installed executable only.\nabi <abi/4.0>,\ninclude <tunables/global>\nprofile ${profile} "${executable}" flags=(unconfined) {\n  userns,\n}\n`;
try {
  const existing = await readFile(path, 'utf8');
  if (!existing.startsWith('# Managed by EnoughFactory for this installed executable only.\n')) throw new Error('An administrator-owned profile already occupies this path. It was preserved.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await writeFile(path, text, { mode: 0o644 });
execFileSync('apparmor_parser', ['-r', path], { stdio: 'inherit' });
console.log(`Chromium sandbox namespace permission installed for ${executable}. Keep this extracted application at this path; repeat setup if you move it.`);
