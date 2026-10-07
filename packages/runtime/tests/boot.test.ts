import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT_FILESYSTEM_BOOT_TOOLS_SCRIPT } from '../src/boot.ts';

const execute = promisify(execFile);
const tools = ['fsck', 'e2fsck', 'fsck.ext4', 'logsave'];
const completeListing = tools.map(name => `usr/sbin/${name}`).join('\n');

/** Run the actual provisioning shell with disposable boot files and command fixtures. */
async function fixture(listing: string, rebuiltListing = completeListing) {
  const directory = await mkdtemp(join(tmpdir(), 'enough-boot-tools-'));
  const bin = join(directory, 'bin'), boot = join(directory, 'boot');
  await Promise.all([mkdir(bin), mkdir(boot)]);
  await writeFile(join(directory, 'listing'), listing);
  await writeFile(join(directory, 'rebuilt-listing'), rebuiltListing);
  const kernel = '6.8.0-fixture', initrd = join(boot, `initrd.img-${kernel}`);
  await writeFile(initrd, 'original initrd');
  async function command(name: string, body: string) {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
    await chmod(path, 0o755);
  }
  await command('uname', `test "$1" = -r; printf '%s\\n' '${kernel}'`);
  await command('lsinitramfs', 'test "$1" = "$FIXTURE_INITRD"; cat "$FIXTURE_ROOT/listing"');
  await command('update-initramfs', `test "$#" = 3; test "$1" = -u; test "$2" = -k; test "$3" = '${kernel}'
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/rebuilds"
cp "$FIXTURE_ROOT/rebuilt-listing" "$FIXTURE_ROOT/listing"
printf 'rebuilt initrd' > "$FIXTURE_INITRD"`);
  for (const tool of tools) await command(tool, 'echo "Filesystem checking must never run during provisioning" >&2; exit 99');
  return {
    directory,
    run: () => execute('/bin/bash', ['-c', `set -eu\n${ROOT_FILESYSTEM_BOOT_TOOLS_SCRIPT.replace('"/boot/initrd.img-$enoughfactory_kernel"', '"$FIXTURE_BOOT/initrd.img-$enoughfactory_kernel"')}`], {
      env: { PATH: `${bin}:/usr/bin:/bin`, FIXTURE_ROOT: directory, FIXTURE_BOOT: boot, FIXTURE_INITRD: initrd }, timeout: 5_000,
    }),
    read: (name: string) => readFile(join(directory, name), 'utf8'),
    initrd: () => readFile(initrd, 'utf8'),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test('an already prepared current boot image is left unchanged', async () => {
  const context = await fixture(completeListing);
  try {
    await context.run();
    assert.equal(await context.initrd(), 'original initrd');
    await assert.rejects(context.read('rebuilds'), { code: 'ENOENT' });
  } finally { await context.close(); }
});

test('missing boot checking tools trigger one rebuild, then ordinary startup reuses it', async () => {
  const context = await fixture(`usr/lib/initramfs-tools/scripts/local-premount/fsck\n${tools.filter(name => name !== 'fsck').map(name => `usr/sbin/${name}`).join('\n')}`);
  try {
    await context.run();
    assert.equal(await context.initrd(), 'rebuilt initrd');
    assert.equal(await context.read('listing'), completeListing);
    await context.run();
    assert.equal(await context.read('rebuilds'), '-u -k 6.8.0-fixture\n');
  } finally { await context.close(); }
});

test('a successful rebuild cannot hide a required checking tool that is still missing', async () => {
  const context = await fixture('', `${tools.filter(name => name !== 'logsave').map(name => `usr/sbin/${name}`).join('\n')}\nusr/lib/logsave-helper`);
  try {
    await assert.rejects(context.run(), error => {
      assert.match((error as Error & { stderr: string }).stderr, /still lacks required filesystem checking tools/);
      return true;
    });
    assert.equal(await context.read('rebuilds'), '-u -k 6.8.0-fixture\n');
  } finally { await context.close(); }
});
