#!/usr/bin/env node
// Build the vscode-remote://dev-container+<hex>/… URI for a local folder
// (docs/vscode-remote.md §8.1) and optionally launch VS Code on it.
//
//   node launch.mjs C:\Users\Matt\envmux-demo            # print the URI
//   node launch.mjs C:\Users\Matt\envmux-demo --open     # and open it
//   node launch.mjs C:\Users\Matt\envmux-demo --decode <hex>

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--decode')) {
  console.log(Buffer.from(args[args.indexOf('--decode') + 1], 'hex').toString('utf8'));
  process.exit(0);
}

const hostPath = path.resolve(args[0] || process.cwd());
const configFile = path.join(hostPath, '.devcontainer', 'devcontainer.json');
if (!fs.existsSync(configFile)) { console.error(`no ${configFile}`); process.exit(1); }

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const inside = config.workspaceFolder || `/workspaces/${path.basename(hostPath)}`;

// A vscode.Uri as it serialises: lowercase drive in fsPath, forward slashes
// with a leading "/" in path.
const drive = configFile[0].toLowerCase();
const fsPath = drive + configFile.slice(1);
const uriPath = '/' + fsPath.replace(/\\/g, '/');
const authority = {
  hostPath,
  localDocker: false,
  configFile: { $mid: 1, fsPath, path: uriPath, scheme: 'file' },
};
const hex = Buffer.from(JSON.stringify(authority), 'utf8').toString('hex');
const uri = `vscode-remote://dev-container+${hex}${inside}`;

console.log(JSON.stringify(authority));
console.log(uri);

if (args.includes('--open')) {
  const code = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
    : 'code';
  const flags = args.includes('--no-trust') ? ['--disable-workspace-trust'] : [];
  const child = spawn(code, ['--new-window', ...flags, '--folder-uri', uri], { stdio: 'inherit', shell: false });
  child.on('exit', (c) => { console.log(`code exited ${c}`); process.exit(c ?? 0); });
}
