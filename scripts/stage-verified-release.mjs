#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadBaselineUbuntu, github, repository, verifyAssetMetadata, verifyBaselineRelease } from './download-verified-baseline.mjs';
import { verifyRuntimeSourceClosure } from './verify-runtime-source-closure.mjs';
import { engineSourceRequirements, hashBytes, hashFile } from '../release/marketing/source-companions.mjs';
import { verifyArchiveReceipt, verifyRuntimeJourney } from '../release/marketing/verify-receipt.mjs';
import { verifyInstalledProofs } from '../release/marketing/verify-installed-proofs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const delivery = Object.freeze({ version: '0.1.2', sourceCommit: 'c71a3a91861c3dd3bd11ab90b9edbc740aa0f12e', runId: 37396429671, releaseId: 404207020, serviceSha256: 'a1e0efdfc322fcfd46cbc42a1d7649f5b92052128d9494d7aa6ed40181756bd7', artifactIds: { arm64: 11384465049, x64: 11384120421 } });

export function verifyRunEvidence(run, jobs, artifacts) {
  assert.equal(run.id, delivery.runId);
  assert.equal(run.head_sha, delivery.sourceCommit, 'Native run source differs from the frozen product.');
  assert.equal(run.path, '.github/workflows/desktop-release.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.run_attempt, 1);
  const requiredSteps = ['Verify installed runtime on its native architecture', 'Verify the native Linux desktop with its Chromium sandbox', 'Verify native Linux login service installation and removal', 'Verify the bundled private Linux engine and source retention', 'Verify the exact downloadable archives', 'Upload desktop artifacts'];
  for (const arch of ['arm64', 'x64']) {
    const selected = jobs.filter(job => job.name === `linux ${arch}`);
    assert.equal(selected.length, 1, 'A unique successful native job is required.');
    const job = selected[0];
    assert.equal(job.head_sha, delivery.sourceCommit);
    assert.equal(job.status, 'completed');
    assert.equal(job.conclusion, 'success');
    for (const name of requiredSteps) {
      const step = job.steps.find(step => step.name === name);
      assert.equal(step?.status, 'completed', `Native proof step did not complete: ${name}.`);
      assert.equal(step.conclusion, 'success', `Native proof step did not pass: ${name}.`);
    }
    const assets = artifacts.filter(artifact => artifact.name === `EnoughFactory-linux-${arch}`);
    assert.equal(assets.length, 1);
    const artifact = assets[0];
    assert.equal(artifact.id, delivery.artifactIds[arch]);
    assert.equal(artifact.expired, false);
    assert.equal(artifact.workflow_run.id, delivery.runId);
    assert.equal(artifact.workflow_run.head_sha, delivery.sourceCommit);
  }
}

export async function verifyNativeRun() {
  const [run, jobPage, artifactPage] = await Promise.all([
    github(`/repos/${repository}/actions/runs/${delivery.runId}`),
    github(`/repos/${repository}/actions/runs/${delivery.runId}/jobs?per_page=100`),
    github(`/repos/${repository}/actions/runs/${delivery.runId}/artifacts?per_page=100`),
  ]);
  assert.equal(jobPage.jobs.length, jobPage.total_count, 'Unexpected native job pagination.');
  assert.equal(artifactPage.artifacts.length, artifactPage.total_count, 'Unexpected artifact pagination.');
  verifyRunEvidence(run, jobPage.jobs, artifactPage.artifacts);
  console.log(`Verified completed native Linux run ${delivery.runId} at ${delivery.sourceCommit}.`);
  return { runId: run.id, sourceCommit: run.head_sha, jobs: jobPage.jobs.filter(job => job.name.startsWith('linux ')).map(job => ({ id: job.id, name: job.name, conclusion: job.conclusion })), artifacts: artifactPage.artifacts.filter(artifact => artifact.name.startsWith('EnoughFactory-linux-')).map(artifact => ({ id: artifact.id, name: artifact.name })) };
}

export function verifyDraftIdentity(release) {
  assert.equal(release.id, delivery.releaseId);
  assert.equal(release.tag_name, 'v0.1.2');
  assert.equal(release.draft, true, 'Staging requires the existing release to remain a draft.');
  assert.equal(release.prerelease, false);
  assert.equal(release.target_commitish, delivery.sourceCommit, 'The draft targets another source revision.');
}
async function draft() {
  const release = await github(`/repos/${repository}/releases/${delivery.releaseId}`);
  verifyDraftIdentity(release);
  return release;
}

async function verifiedFile(directory, filename, expected = undefined) {
  assert.match(filename, /^[a-zA-Z0-9._-]+$/);
  const path = join(directory, filename);
  const metadata = await lstat(path);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0, 'Only nonempty ordinary release files are allowed.');
  const actual = await hashFile(path);
  if (expected?.sha256) assert.equal(actual.sha256, expected.sha256, `Actual file digest differs: ${filename}.`);
  if (expected?.bytes) assert.equal(actual.bytes, expected.bytes, `Actual file size differs: ${filename}.`);
  return { filename, path, ...actual };
}

async function linuxInputs(directory) {
  const pins = JSON.parse(await readFile(join(root, 'runtime/container/pins.json'), 'utf8'));
  const files = [], receipts = [];
  for (const arch of ['arm64', 'x64']) {
    const target = join(directory, `linux-${arch}`);
    const prefix = `linux-${arch}`;
    const serviceBytes = await readFile(join(target, `${prefix}.service.verification.json`));
    const guiBytes = await readFile(join(target, `${prefix}.gui.verification.json`));
    const screenshotBytes = await readFile(join(target, `${prefix}.gui.verification.json.png`));
    const installed = JSON.parse(await readFile(join(target, `${prefix}.installed.verification.json`)));
    const runtime = JSON.parse(await readFile(join(target, `${prefix}.runtime.verification.json`)));
    const service = JSON.parse(serviceBytes), gui = JSON.parse(guiBytes);
    const bundles = new Set();
    for (const format of ['AppImage', 'tar.gz']) {
      const filename = `EnoughFactory-${delivery.version}-linux-${arch}.${format}`;
      const receipt = JSON.parse(await readFile(join(target, `${filename}.verification.json`)));
      const artifact = await verifiedFile(target, filename, receipt.artifact);
      verifyArchiveReceipt(receipt, { ...artifact, version: delivery.version, platform: 'linux', arch, format }, pins);
      assert.equal(receipt.sourceCommit, delivery.sourceCommit);
      assert.equal(receipt.resources.manifest['device/service.cjs'], delivery.serviceSha256, 'The final service differs from the real distributed journey.');
      verifyRuntimeJourney(receipt);
      assert.deepEqual(runtime, receipt.runtimeJourney, 'The separate runtime receipt differs from the archive-bound journey.');
      verifyInstalledProofs(receipt, service, gui, hashBytes(screenshotBytes));
      for (const [key, expected] of Object.entries({ formatVersion: 1, product: 'EnoughFactory', version: delivery.version, platform: 'linux', arch, sourceCommit: delivery.sourceCommit, verificationScope: 'installed-desktop-resources' })) assert.equal(installed[key], expected, 'Installed-resource receipt identity differs.');
      assert.equal(installed.resources.bundleProvenanceSha256, receipt.resources.bundleProvenanceSha256);
      assert.equal(installed.resources.hashesVerified, true);
      assert.equal(installed.resources.fileCount, receipt.resources.fileCount);
      assert.deepEqual(installed.resources.manifest, receipt.resources.manifest);
      assert.deepEqual(installed.native, receipt.native);
      bundles.add(receipt.resources.bundleProvenanceSha256);
      files.push(artifact, await verifiedFile(target, `${filename}.verification.json`));
      receipts.push(receipt);
    }
    assert.equal(bundles.size, 1, 'The two target archives must contain the same exact bundle.');
    for (const requirement of engineSourceRequirements(receipts.at(-1))) files.push(await verifiedFile(target, requirement.filename, requirement));
    for (const suffix of ['installed.verification.json', 'runtime.verification.json', 'service.verification.json', 'gui.verification.json', 'gui.verification.json.png']) files.push(await verifiedFile(target, `${prefix}.${suffix}`));
  }
  assert.equal(files.length, 22);
  return { files, receipts };
}

async function upload(release, asset, token) {
  const existing = release.assets.filter(value => value.name === asset.filename);
  assert.ok(existing.length <= 1, 'Duplicate draft asset names are not allowed.');
  if (existing.length) { verifyAssetMetadata(existing[0], asset); console.log(`Already staged exact bytes: ${asset.filename}`); return 'already-present'; }
  const base = release.upload_url.replace(/\{.*$/, '');
  assert.equal(base, `https://uploads.github.com/repos/${repository}/releases/${delivery.releaseId}/assets`);
  const url = new URL(base); url.searchParams.set('name', asset.filename);
  console.log(`Staging verified draft asset: ${asset.filename} (${asset.bytes} bytes)`);
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.bytes) }, body: createReadStream(asset.path), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(1_200_000) });
  if (!response.ok) throw new Error(`Draft upload failed without replacing any existing asset: ${asset.filename} (${response.status}).`);
  verifyAssetMetadata(await response.json(), asset);
  return 'uploaded';
}

async function stage(directory, reportPath) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  assert.ok(token, 'A GitHub token is required for authorized draft staging.');
  assert.equal(process.env.GITHUB_REPOSITORY, repository, 'Run draft staging in the EnoughFactory repository workflow.');
  const startedAt = new Date().toISOString();
  const runEvidence = await verifyNativeRun();
  await draft();
  for (const file of ['runtime/container/pins.json', 'runtime/container/os-source-kit/Ubuntu-sources.lock.json']) {
    const frozen = execFileSync('git', ['show', `${delivery.sourceCommit}:${file}`], { cwd: root });
    assert.equal(hashBytes(await readFile(join(root, file))), hashBytes(frozen), 'Delivery inputs differ from the frozen package revision.');
  }
  const sourceClosure = await verifyRuntimeSourceClosure('ubuntu-source');
  const { files } = await linuxInputs(directory);
  const baselineRelease = await verifyBaselineRelease();
  const ubuntuDirectory = join(directory, 'ubuntu');
  const ubuntu = await downloadBaselineUbuntu(ubuntuDirectory, baselineRelease);
  execFileSync('python3', [join(root, 'runtime/container/os-source-kit/prepare-source-companion.py'), 'verify', '--output', ubuntuDirectory], { cwd: root, stdio: 'inherit', timeout: 1_200_000 });
  files.push(...ubuntu);
  assert.equal(files.length, 29);
  assert.equal(new Set(files.map(file => file.filename)).size, 29);
  const initialDraft = await draft();
  for (const asset of files) {
    const existing = initialDraft.assets.filter(value => value.name === asset.filename);
    assert.ok(existing.length <= 1);
    if (existing.length) verifyAssetMetadata(existing[0], asset);
  }
  const staged = [];
  for (const asset of files) staged.push({ filename: asset.filename, sha256: asset.sha256, bytes: asset.bytes, result: await upload(await draft(), asset, token) });
  const final = await draft();
  for (const asset of files) verifyAssetMetadata(final.assets.find(value => value.name === asset.filename), asset);
  const report = { formatVersion: 1, product: 'EnoughFactory', verificationScope: 'verified-draft-staging', status: 'passed', version: delivery.version, sourceCommit: delivery.sourceCommit, releaseId: delivery.releaseId, releaseRemainsDraft: true, deliveryWorkflowCommit: process.env.GITHUB_SHA, startedAt, completedAt: new Date().toISOString(), nativeRun: runEvidence, ubuntuBaseline: { releaseId: baselineRelease.id, sourceClosureSha256: sourceClosure.sha256, indexSha256: '70aae28ae71172ff64897506285cf2fd6963fe52bf648c430073ff7e7b63c81b' }, assets: staged };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Staged ${staged.length} verified Linux/Ubuntu assets. Release ${delivery.releaseId} remains a draft; no application build or publication occurred.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--verify-run') { await verifyNativeRun(); await draft(); }
  else if (args.length === 4 && args[0] === '--stage' && args[1] && args[2] === '--report' && args[3]) await stage(resolve(args[1]), resolve(args[3]));
  else throw new Error('Usage: node scripts/stage-verified-release.mjs --verify-run | --stage <directory> --report <receipt.json>');
}
