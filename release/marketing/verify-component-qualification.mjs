import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { verifyArchiveReceipt, verifyRuntimeJourney } from './verify-receipt.mjs';
import { verifyPackagedServiceProof } from './verify-installed-proofs.mjs';

const known = JSON.parse(readFileSync(new URL('./component-baseline-0.1.2.json', import.meta.url), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = isDeepStrictEqual;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const componentQualificationScope = Object.freeze(['private-container-runtime', 'native-envmux-local-integration', 'unchanged-agent-workspace-implementation']);
export const receiptBytes = receipt => `${JSON.stringify(receipt, null, 2)}\n`;
export const qualificationSourceRoots = Object.freeze(['packages/runtime/src', 'packages/envmux/src', 'packages/agents/src', 'packages/workspaces/src', 'runtime/agents', 'runtime/workspaces', 'vendor/envmux/src', 'vendor/envmux/images/golden', 'vendor/envmux/skills']);
const sourceFiles = ['package.json', 'apps/device/src/sessions.ts', 'apps/device/src/store.ts', 'apps/device/src/util.ts', 'apps/device/src/chats.ts', 'apps/device/build.mjs', 'tsconfig.base.json', 'pnpm-workspace.yaml', '.npmrc', 'scripts/envmux-build.mjs', 'scripts/prepare-container-runtime.mjs', 'scripts/check-mac-runtime.ts', 'scripts/check-linux-runtime.ts', 'runtime/container/pins.json', ...['runtime', 'envmux', 'agents', 'workspaces'].flatMap(name => [`packages/${name}/package.json`, `packages/${name}/tsconfig.json`]), ...['', 'vendor/', 'vendor/envmux/'].flatMap(prefix => ['Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'global.json', 'nuget.config', 'NuGet.Config'].map(name => `${prefix}${name}`))];
export function qualificationSourcePaths(paths) {
  return [...new Set(paths)].filter(path => sourceFiles.includes(path) || qualificationSourceRoots.some(root => path.startsWith(`${root}/`) && !/\.test\.[^/]+$/.test(path) && (root !== 'vendor/envmux/skills' || /^vendor\/envmux\/skills\/envmux-[^/]+\/SKILL\.md$/.test(path)) && (root !== 'vendor/envmux/images/golden' || !path.slice(root.length + 1).split('/').some(part => part.startsWith('.'))))).sort();
}

/** Only product package versions are metadata; every other byte/JSON field remains an input. */
export function qualificationSourceInput(path, bytes) {
  if (path === 'package.json') {
    const value = JSON.parse(bytes.toString('utf8'));
    return hash(JSON.stringify({ type: value.type, packageManager: value.packageManager, engines: value.engines, pnpm: value.pnpm,
      devDependencies: Object.fromEntries(['esbuild', 'tsx', 'typescript', '@types/node'].map(name => [name, value.devDependencies?.[name]])) }));
  }
  if (/^packages\/(runtime|envmux|agents|workspaces)\/package\.json$/.test(path)) {
    const value = JSON.parse(bytes.toString('utf8'));
    if (!/^0\.1\.(2|3)$/.test(value.version)) throw new Error(`Unsupported component package version: ${path}`);
    value.version = '<product-version>';
    return hash(JSON.stringify(value));
  }
  return hash(bytes);
}

function section(text, heading) {
  const lines = text.split('\n'), start = lines.indexOf(`${heading}:`);
  if (start < 0 || lines.filter(line => line === `${heading}:`).length !== 1) throw new Error(`Missing or duplicated lockfile section: ${heading}`);
  let end = start + 1;
  while (end < lines.length && !/^\S/.test(lines[end])) end++;
  return lines.slice(start + 1, end).join('\n');
}
function entry(text, key) {
  const lines = text.split('\n');
  const selected = line => line === `  ${key}:` || line === `  '${key}':` || line === `  ${key}: {}`;
  const index = lines.findIndex(selected);
  if (index < 0 || lines.filter(selected).length !== 1) throw new Error(`Missing or duplicated locked component dependency: ${key}`);
  let end = index + 1;
  while (end < lines.length && !/^  \S/.test(lines[end])) end++;
  return `${lines.slice(index, end).join('\n').trimEnd()}\n`;
}

/** Fixed runtime/build dependency subgraph; hosted-worker and React dependencies are separate. */
export function qualificationDependencyInputs(lockText) {
  if (!/^lockfileVersion: '9\.0'$/m.test(lockText)) throw new Error('Unsupported component lockfile version.');
  const result = {};
  result['lock-settings'] = hash(section(lockText, 'settings'));
  const importers = section(lockText, 'importers');
  for (const key of ['apps/device', 'packages/runtime', 'packages/envmux', 'packages/agents', 'packages/workspaces']) result[`importer:${key}`] = hash(entry(importers, key));
  const root = entry(importers, '.').split('\n').slice(2).map(line => line.slice(4)).join('\n');
  for (const key of ['esbuild', 'tsx', 'typescript']) result[`root-build-tool:${key}`] = hash(entry(root, key));
  for (const group of ['packages', 'snapshots']) {
    const text = section(lockText, group);
    const keys = text.split('\n').filter(line => /^  \S/.test(line)).map(line => line.slice(2).replace(/:.*$/, '').replace(/^'|'$/g, ''));
    for (const key of keys.filter(key => /^(?:esbuild@(?:0\.25\.12|0\.28\.2)|@esbuild\/.+@(?:0\.25\.12|0\.28\.2)|tsx@4\.23\.15|fsevents@2\.3\.3|ws@8\.22\.0|typescript@5\.9\.3)$/.test(key)).sort()) result[`${group}:${key}`] = hash(entry(text, key));
  }
  return result;
}

export function componentAssetPaths(receipt) {
  const manifest = receipt.resources?.manifest ?? {};
  const selected = Object.keys(manifest).filter(path => path === 'runtime/node' || path.startsWith('envmux/') || path.startsWith('agents/') || path.startsWith('workspaces/') || path.startsWith('device/node_modules/') || path.startsWith('runtime/container/') && !['runtime/container/provenance.json', 'runtime/container/engine-provenance.json'].includes(path) && !path.startsWith('runtime/container/sources/')).sort();
  const result = Object.fromEntries(selected.map(path => [path, path]));
  const companion = receipt.containerRuntime?.engineSourceBuild?.sourceCompanion;
  if (!companion?.file || !companion.receiptFile) throw new Error('Missing component source companion paths.');
  result['container-source-archive'] = `runtime/container/${companion.file}`;
  result['container-source-receipt'] = `runtime/container/${companion.receiptFile}`;
  return result;
}

export function componentQualificationRequirements(platform, arch) {
  const target = known.targets[`${platform}-${arch}`];
  if (!target) throw new Error('No reviewed component baseline exists for this target.');
  return structuredClone({ formatVersion: 1, version: known.version, sourceCommit: known.sourceCommit, scope: componentQualificationScope, baseline: target.baseline, sources: known.sources, dependencies: known.dependencies, assets: target.assets });
}

function equalMap(actual, expected, label) {
  if (!actual || Array.isArray(actual) || typeof actual !== 'object' || !same(Object.keys(actual).sort(), Object.keys(expected).sort()) || Object.entries(expected).some(([key, value]) => !digest(value) || actual[key] !== value)) throw new Error(`Component qualification changed or omitted a mandatory ${label} input.`);
}

export function verifyComponentQualification(receipt, proof = receipt.componentQualification) {
  const required = componentQualificationRequirements(receipt.platform, receipt.arch);
  const current = { version: receipt.version, sourceCommit: receipt.sourceCommit, platform: receipt.platform, arch: receipt.arch, bundleProvenanceSha256: receipt.resources?.bundleProvenanceSha256 };
  if (proof?.formatVersion !== 1 || proof.product !== 'EnoughFactory' || proof.kind !== 'unchanged-runtime-components' || proof.status !== 'qualified' || receipt.version !== '0.1.3' || !/^[a-f0-9]{40}$/.test(current.sourceCommit ?? '') || !digest(current.bundleProvenanceSha256) || !same(proof.scope, componentQualificationScope) || !Number.isFinite(Date.parse(proof.qualifiedAt)) || !same(proof.current, current) || proof.baseline?.version !== known.version || proof.baseline.sourceCommit !== known.sourceCommit || receipt.runtimeJourney) throw new Error('Component qualification has unsupported scope, identity or fresh-runtime claims.');
  for (const name of ['archive', 'runtime', ...(receipt.platform === 'darwin' ? ['api'] : [])]) {
    const evidence = proof.baseline[name], pin = required.baseline[name];
    const expectedSha = name === 'archive' ? pin.receiptSha256 : pin.sha256;
    const expectedUrl = name === 'archive' ? pin.receiptUrl : pin.url;
    if (evidence?.url !== expectedUrl || evidence.sha256 !== expectedSha || hash(receiptBytes(evidence.receipt)) !== expectedSha) throw new Error(`The original ${name} evidence does not match its pinned baseline receipt bytes.`);
  }
  if (receipt.platform !== 'darwin' && proof.baseline.api !== undefined) throw new Error('Unsupported historical API evidence for this target.');
  const baseline = proof.baseline.archive.receipt;
  verifyArchiveReceipt(baseline, { ...required.baseline.archive, version: known.version, platform: receipt.platform, arch: receipt.arch }, known.pins);
  verifyRuntimeJourney(baseline);
  if (!same(baseline.runtimeJourney, proof.baseline.runtime.receipt)) throw new Error('The original runtime evidence differs from its pinned archive.');
  if (receipt.platform === 'darwin') verifyPackagedServiceProof(baseline, proof.baseline.api.receipt);
  equalMap(proof.unchanged?.sources, required.sources, 'source');
  equalMap(proof.unchanged?.dependencies, required.dependencies, 'dependency');
  equalMap(proof.unchanged?.assets, required.assets, 'asset');
  const paths = componentAssetPaths(receipt);
  equalMap(Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, receipt.resources.manifest[path]])), required.assets, 'packaged asset');
  if (receipt.containerRuntime?.dockerVersion !== baseline.containerRuntime.dockerVersion || receipt.containerRuntime.limaVersion !== baseline.containerRuntime.limaVersion || !same(receipt.containerRuntime.archivePins, baseline.containerRuntime.archivePins) || !same(receipt.containerRuntime.engineSourceBuild?.components, baseline.containerRuntime.engineSourceBuild.components)) throw new Error('Component qualification changed the runtime behavior configuration.');
  return proof;
}
