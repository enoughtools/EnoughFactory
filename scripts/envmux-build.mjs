import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localSdk = join(homedir(), '.local/share/enoughfactory/dotnet/dotnet');
const dotnet = process.env.ENOUGHFACTORY_DOTNET ?? (existsSync(localSdk) ? localSdk : 'dotnet');
const requested = process.argv.slice(2);
const hostRid = `${process.platform === 'darwin' ? 'osx' : process.platform}-${process.arch}`;
const targets = requested.length ? requested : [hostRid];
for (const rid of targets) {
  if (!['osx-arm64', 'osx-x64', 'linux-x64', 'linux-arm64'].includes(rid)) throw new Error(`Unsupported Envmux target: ${rid}`);
  const args = ['publish', join(root, 'vendor/envmux/src/Envmux/Envmux.csproj'), '-c', 'Release', '-r', rid,
    '--self-contained', 'true', '-p:BuildPortal=false', '-p:PublishAot=false', '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true', '-o', join(root, 'artifacts/envmux', rid), '--nologo'];
  const code = await new Promise((accept, reject) => {
    const child = spawn(dotnet, args, { cwd: root, stdio: 'inherit', env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
    child.once('error', reject); child.once('exit', accept);
  });
  if (code !== 0) process.exit(code ?? 1);
}
