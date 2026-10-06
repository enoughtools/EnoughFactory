import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { verifyArchiveReceipt, verifyPublishedCatalog, verifyRuntimeJourney } from './verify-receipt.mjs';
import { hashBytes, verifyPublicAsset, verifySourceCatalog } from './source-companions.mjs';
import { verifyInstalledProofs, verifyPackagedServiceSmoke } from './verify-installed-proofs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const publicRoot = resolve(root, 'apps/marketing/public');
const manifest = verifyPublishedCatalog(JSON.parse(await readFile(resolve(publicRoot, 'downloads/manifest.json'), 'utf8')));
const pins = JSON.parse(await readFile(resolve(root, 'runtime/container/pins.json'), 'utf8'));
const receipts = [];
for (const artifact of manifest.artifacts) {
  const receipt = verifyArchiveReceipt(JSON.parse(await readFile(resolve(publicRoot, `.${artifact.verificationUrl}`), 'utf8')), { ...artifact, version: manifest.version }, pins);
  if (receipt.sourceCommit !== manifest.sourceCommit) throw new Error(`Package verification source differs from the catalog: ${artifact.filename}.`);
  verifyRuntimeJourney(receipt);
  if (receipt.componentQualification) {
    const proofs = {};
    for (const [name, suite] of [['service', 'service'], ['gui', 'gui'], ['smoke', 'packaged-service-smoke']]) {
      const expected = `/downloads/${manifest.version}/${artifact.platform}-${artifact.arch}.${suite}.verification.json`;
      if (artifact.verificationReceiptUrls?.[name] !== expected) throw new Error(`Qualified publication is missing the fresh ${name} evidence: ${artifact.filename}.`);
      proofs[name] = JSON.parse(await readFile(resolve(publicRoot, `.${expected}`), 'utf8'));
    }
    const screenshot = await readFile(resolve(publicRoot, `.${artifact.verificationReceiptUrls.gui}.png`));
    verifyInstalledProofs(receipt, proofs.service, proofs.gui, hashBytes(screenshot));
    verifyPackagedServiceSmoke(receipt, proofs.smoke);
  }
  receipts.push(receipt);
}
const indexBytes = await readFile(resolve(publicRoot, `downloads/${manifest.version}/Ubuntu-source-companion.json`));
const lockBytes = await readFile(resolve(root, 'runtime/container/os-source-kit/Ubuntu-sources.lock.json'));
const sources = verifySourceCatalog(manifest, receipts, pins, indexBytes, lockBytes);
for (const source of sources) {
  console.log(`Checking public runtime source: ${source.filename}`);
  await verifyPublicAsset(source);
}
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
