import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function ensureElectron() {
  const require = createRequire(import.meta.url);
  const directory = dirname(require.resolve('electron/package.json'));
  const binary = process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? 'electron.exe' : 'electron';
  try {
    await Promise.all([access(join(directory, 'path.txt')), access(join(directory, 'dist', binary)), access(join(directory, 'dist', 'LICENSES.chromium.html'))]);
  } catch {
    console.log('Preparing the pinned Electron runtime from its official release.');
    execFileSync(process.execPath, [join(directory, 'install.js')], {
      stdio: 'inherit', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '' },
    });
    await Promise.all([access(join(directory, 'path.txt')), access(join(directory, 'dist', binary)), access(join(directory, 'dist', 'LICENSES.chromium.html'))]);
  }
  return join(directory, 'dist');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await ensureElectron();
