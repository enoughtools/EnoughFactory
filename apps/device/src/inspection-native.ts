import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import type { InspectionAuthority } from '@enoughfactory/contracts';
import {
  inventoryApp, NativeInspectionError, sha256, verifyNativeProduct,
  type NativeAction, type NativeBackendOptions, type NativeInspectionBackend,
  type NativePlatform, type NativeProduct,
} from '@enoughfactory/native-inspection';
import {
  APPLE_CHECK_PREFIX, appleCheckArtifacts, appleCheckExecutor, InspectionSnapshotManager, NativeTeardownError,
  parseAppleCheckCommand, type AppleCheckProfile, type AppleCheckResult, type ArtifactManifest,
  type ArtifactStore, type Candidate, type CheckExecutor, type CheckReport,
  type CommandResult, type InspectionSnapshot, type InspectionSnapshotManifest, type WorkingDirectoryCapture,
} from '@enoughfactory/workspaces';

const execute = promisify(execFile);
const hash = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxArchive = 256 * 1024 * 1024;

/** Service-configured and authenticated; never accept this object from an author's tool call. */
export interface NativeFixtureProfile {
  id: string;
  build: AppleCheckProfile;
  /** Fixed arguments with a mandatory {runId} substitution, not a shell command. */
  launchArguments: string[];
  fixtureEvidenceSha256: string;
  /** Original coordinator-audited fixture source receipt; required before compilation. */
  receipt?: ArtifactManifest;
  fixtureExpectedDataRoot?: string;
  /** Required when a scheme produces several applications. */
  bundleIdentifier?: string;
}

export interface NativeInspectionBuild {
  id: string;
  status: 'passed' | 'failed' | 'canceled';
  product?: NativeProduct;
  candidate: Candidate;
  report: CheckReport;
  reportArtifact: ArtifactManifest;
  evidenceArtifacts: ArtifactManifest[];
  productArtifacts: ArtifactManifest[];
  snapshotArtifact: ArtifactManifest;
  fixtureReceiptArtifact: ArtifactManifest;
  fixtureProfileId: string;
  preparationArtifact: ArtifactManifest;
  error?: string;
}

export interface NativeInspectionAdapterOptions {
  dataDir: string;
  artifacts: ArtifactStore;
  backend: NativeInspectionBackend;
  /** Focused verification injection; production always uses the fixed Apple checker. */
  checkExecutor?: CheckExecutor;
  /** Trusted service seam for registered verifier-owned copies; never selected by tool arguments. */
  verifySnapshot?: (snapshot: InspectionSnapshot, signal?: AbortSignal) => Promise<void>;
}

interface FixtureSourceReceipt {
  version: 1;
  kind: 'native-fixture-source-audit';
  profileId: string;
  launchArguments: string[];
  build: AppleCheckProfile;
  bundleIdentifier?: string;
  fixtureExpectedDataRoot?: string;
  roots: Array<{ name: string; entries: Array<{ path: string; sha256: string }>;
    protectedSourceDirectories?: string[]; allowedPaths?: string[] }>;
}
interface NativePreparation extends Omit<NativeInspectionBuild, 'preparationArtifact'> {
  version: 1;
  kind: 'native-inspection-build';
  previewOnly: true;
  fixtureProfile: NativeFixtureProfile;
  sourceIdentity: { snapshotId: string; sha256: string; previewOnly: true;
    roots: Array<{ id: string; name: string; sha256: string; originalSourceCommit?: string; checkedPreviewCommit: string }> };
}

/** Resolve explicit installed assets; a bundled service must not guess a developer checkout. */
export function nativeInspectionBackendOptions(dataDir: string, environment: NodeJS.ProcessEnv = process.env): NativeBackendOptions {
  const absolute = (key: string): string | undefined => {
    const value = environment[key];
    if (value !== undefined && (!isAbsolute(value) || value.includes('\0'))) throw new Error(`${key} must be an absolute installed asset path`);
    return value;
  };
  return {
    directory: resolve(dataDir, 'native-sessions'),
    macHelperExecutable: absolute('ENOUGHFACTORY_NATIVE_MAC_HELPER'),
    iosXctestrunPath: absolute('ENOUGHFACTORY_NATIVE_IOS_XCTESTRUN'),
    iosSimulatorRuntime: environment.ENOUGHFACTORY_NATIVE_IOS_RUNTIME,
    iosSimulatorDeviceType: environment.ENOUGHFACTORY_NATIVE_IOS_DEVICE_TYPE,
  };
}

/** Build and prepare immutable previews. The job owner still owns leases, policy and authority fencing. */
export class NativeInspectionAdapter {
  private readonly root: string;
  private readonly snapshots: InspectionSnapshotManager;
  private readonly productOperations = new Map<string, Promise<unknown>>();
  constructor(private readonly options: NativeInspectionAdapterOptions) {
    this.root = resolve(options.dataDir, 'native-products');
    this.snapshots = new InspectionSnapshotManager({ dataDir: options.dataDir, artifacts: options.artifacts });
  }

  async build(snapshot: InspectionSnapshot, profile: NativeFixtureProfile, input: { authority: InspectionAuthority; signal?: AbortSignal }): Promise<NativeInspectionBuild> {
    profile = structuredClone(profile);
    const build = parseAppleCheckCommand(`${APPLE_CHECK_PREFIX} ${JSON.stringify(profile.build)}`);
    if (build.tool !== 'xcodebuild') throw new NativeInspectionError('invalid-profile', 'Native application inspection requires an xcodebuild application profile.');
    profile.build = build;
    if (!identifier.test(profile.id) || !hash.test(profile.fixtureEvidenceSha256)
      || !Array.isArray(profile.launchArguments) || !profile.launchArguments.length || profile.launchArguments.length > 32
      || profile.launchArguments.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
      || !profile.launchArguments.some(arg => arg.includes('{runId}'))
      || (profile.fixtureExpectedDataRoot !== undefined && (!isAbsolute(profile.fixtureExpectedDataRoot) || !profile.fixtureExpectedDataRoot.includes('{runId}') || profile.fixtureExpectedDataRoot.includes('\0')))
      || (profile.bundleIdentifier !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(profile.bundleIdentifier))) {
      throw new NativeInspectionError('fixture-required', 'Select a trusted isolated fixture profile with a unique run namespace.');
    }
    for (const value of [input.authority.goalId, input.authority.taskId, input.authority.attemptId]) {
      if (!identifier.test(value)) throw new NativeInspectionError('invalid-owner', 'Native inspection requires exact owning goal, task and attempt identities.');
    }
    input.signal?.throwIfAborted();
    await this.verifySnapshot(snapshot, input.signal);
    const originalReceipt = profile.receipt;
    if (!originalReceipt || originalReceipt.sha256 !== profile.fixtureEvidenceSha256) throw new NativeInspectionError('fixture-required', 'The fixture requires its original source audit receipt and matching evidence hash.');
    await this.verifyFixtureReceipt(originalReceipt, profile, snapshot.manifest);
    await privateDirectory(this.root);
    const id = randomUUID(), directory = join(this.root, id), runId = `native-${id}`;
    await mkdir(directory, { mode: 0o700 });
    try {
    const context = { goalId: input.authority.goalId, taskId: input.authority.taskId, attemptId: input.authority.attemptId };
    // The immutable coordinator receipt remains original provenance. Its exact same
    // bytes receive a current-attempt manifest so normal evidence ownership holds.
    const fixtureReceiptArtifact = originalReceipt.deviceId === this.options.artifacts.deviceId && originalReceipt.goalId === context.goalId
      && originalReceipt.taskId === context.taskId && originalReceipt.attemptId === context.attemptId ? originalReceipt
      : await this.options.artifacts.put(await this.options.artifacts.read(originalReceipt), { ...context,
        name: `fixture-source-audit-${profile.id}.json`, mime: 'application/json', metadata: { originalReceipt, profileId: profile.id, purpose: 'native-fixture-source-audit' } });
    const fixtureAudit = await this.verifyFixtureReceipt(fixtureReceiptArtifact, profile, snapshot.manifest);
    const snapshotArtifact = snapshot.manifestArtifact ?? await this.options.artifacts.put(JSON.stringify(snapshot.manifest), {
      ...context, name: `inspection-source-${snapshot.id}.json`, mime: 'application/json',
      metadata: { sourceDigest: snapshot.sourceDigest, previewOnly: true, purpose: 'development-inspection' },
    });
    await this.authenticate(snapshotArtifact);
    if (!same(JSON.parse((await this.options.artifacts.read(snapshotArtifact)).toString()), snapshot.manifest)) throw new NativeInspectionError('source-changed', 'Inspection manifest artifact does not describe this exact snapshot.');
    const candidate = await this.previewCandidate(snapshot, directory, context, input.signal);
    const command = `${APPLE_CHECK_PREFIX} ${JSON.stringify(build)}`;
    const report: CheckReport = {
      id: randomUUID(), candidateId: candidate.id, commit: candidate.commit, status: 'passed',
      commands: [], logArtifact: undefined as unknown as ArtifactManifest, createdAt: new Date().toISOString(),
    };
    const checker = this.options.checkExecutor ?? appleCheckExecutor({ checksRoot: snapshot.path, artifacts: this.options.artifacts });
    let reason: string | undefined;
    let sourceAudit: { verified: boolean; error?: string } = { verified: false };
    try {
      const result = await checker({ path: snapshot.roots[0]!.path, commit: candidate.commit, candidate,
        command, timeoutMs: 15 * 60 * 1000, signal: input.signal,
        workingDirectories: snapshot.roots.slice(1).map(({ path, containerPath, commit }) => ({ path, containerPath, commit })),
      });
      report.commands.push(result);
      if (result.cleanupErrors?.length) report.cleanupErrors = [...result.cleanupErrors];
      if (result.exitCode !== 0 || result.timedOut || result.cleanupErrors?.length) {
        report.status = input.signal?.aborted ? 'canceled' : 'failed';
        reason = result.stderr.trim().slice(-4000) || `Native check exited with status ${result.exitCode}${result.timedOut ? ' after its time limit' : ''}.`;
      }
    } catch (error) {
      reason = message(error); report.status = input.signal?.aborted ? 'canceled' : 'failed';
      const cleanupErrors = error instanceof NativeTeardownError ? [reason] : undefined;
      if (cleanupErrors) report.cleanupErrors = cleanupErrors;
      report.commands.push({ command, exitCode: input.signal?.aborted ? 130 : 1, stdout: '', stderr: reason,
        startedAt: report.createdAt, endedAt: new Date().toISOString(), ...(cleanupErrors ? { cleanupErrors } : {}) });
    }
    try { await checker.release?.(snapshot.roots[0]!.path); }
    catch (error) { report.cleanupErrors = [...report.cleanupErrors ?? [], message(error)]; report.status = 'failed'; reason = `Native check release was not confirmed: ${message(error)}`; }
    if (!report.cleanupErrors?.length) {
      try { await this.verifySnapshot(snapshot); sourceAudit = { verified: true }; }
      catch (error) { sourceAudit = { verified: false, error: message(error) }; reason = message(error); report.status = 'failed'; }
    }
    let evidenceArtifacts: ArtifactManifest[] = [fixtureReceiptArtifact], productArtifacts: ArtifactManifest[] = [];
    let prepared: { appPath: string; bundleIdentifier: string; inventorySha256: string; artifact: ArtifactManifest } | undefined;
    try {
      for (const result of report.commands) {
        const native = (result as Partial<AppleCheckResult>).appleValidation;
        for (const artifact of appleCheckArtifacts(result)) await this.authenticate(artifact);
        if (native?.artifact) evidenceArtifacts.push(native.artifact);
        if (native) productArtifacts.push(...native.products);
      }
      if (report.status === 'passed') {
        const result = report.commands[0] as AppleCheckResult, native = result.appleValidation;
        if (!native?.artifact || native.candidateId !== candidate.id || native.candidateCommit !== candidate.commit
          || native.checkedCommit !== candidate.commit || native.sandbox !== 'macos-seatbelt-deny-default' || !same(native.profile, build)
          || !same(native.workingDirectories, snapshot.roots.slice(1).map(({ containerPath, commit }) => ({ containerPath, commit })))) {
          throw new NativeInspectionError('invalid-evidence', 'Native checker did not attest this exact preview source and fixed build profile.');
        }
        const { artifact: _artifact, ...inline } = native;
        const { appleValidation: _validation, ...originalResult } = result;
        if (!same(JSON.parse((await this.options.artifacts.read(native.artifact)).toString()), { ...inline, result: originalResult })) {
          throw new NativeInspectionError('invalid-evidence', 'Original native evidence differs from the whole check report.');
        }
        if (!productArtifacts.length || productArtifacts.length > 4) throw new NativeInspectionError('product-missing', 'Native check did not retain a bounded application product.');
        for (const artifact of productArtifacts) {
          const metadata = artifact.metadata;
          if (artifact.mime !== 'application/zip' || metadata?.format !== 'apple-app-zip' || metadata.unsigned !== true
            || metadata.candidateId !== candidate.id || metadata.commit !== candidate.commit || metadata.candidateCommit !== candidate.commit
            || metadata.platform !== build.platform || metadata.scheme !== build.scheme) {
            throw new NativeInspectionError('invalid-product', 'Product archive does not match the original native check identity.');
          }
        }
        if (productArtifacts.length > 1 && !profile.bundleIdentifier) throw new NativeInspectionError('product-ambiguous', 'Configure the intended bundle identity for this multi-application scheme.');
        for (const [index, artifact] of productArtifacts.entries()) {
          input.signal?.throwIfAborted();
          const extracted = await this.extract(artifact, join(directory, `product-${index}`), build.platform, input.signal);
          if (!profile.bundleIdentifier || profile.bundleIdentifier === extracted.bundleIdentifier) {
            if (prepared) throw new NativeInspectionError('product-ambiguous', 'Several native products share the configured bundle identity.');
            prepared = { ...extracted, artifact };
          }
        }
        if (!prepared) throw new NativeInspectionError('product-missing', 'No original product matches the configured bundle identity.');
      }
    } catch (error) { reason = message(error); report.status = input.signal?.aborted ? 'canceled' : 'failed'; prepared = undefined; }
    if (input.signal?.aborted) { report.status = 'canceled'; prepared = undefined; reason = 'Native preview preparation was canceled.'; }
    const sourceIdentity = {
      snapshotId: snapshot.id, sha256: snapshot.sourceDigest, previewOnly: true,
      roots: snapshot.roots.map(({ id: rootId, name, sourceDigest, sourceCommit, commit }) => ({ id: rootId, name, sha256: sourceDigest, originalSourceCommit: sourceCommit, checkedPreviewCommit: commit })),
    };
    const reportArtifact = await this.options.artifacts.put(JSON.stringify({ ...report, logArtifact: undefined,
      purpose: 'development-inspection', previewOnly: true, sourceIdentity, sourceAudit, preparationError: reason,
      originalCommandCount: report.commands.length, evidenceArtifacts, productArtifacts, fixtureAudit,
    }), { ...context, name: `native-inspection-checks-${report.id}.json`, mime: 'application/json',
      metadata: { previewOnly: true, sourceDigest: snapshot.sourceDigest, candidateId: candidate.id, commit: candidate.commit, profileId: profile.id },
    });
    report.logArtifact = reportArtifact;
    let product: NativeProduct | undefined;
    if (prepared && report.status === 'passed') {
      product = { platform: build.platform, appPath: prepared.appPath, bundleIdentifier: prepared.bundleIdentifier,
        inventorySha256: prepared.inventorySha256, originalArtifactSha256: prepared.artifact.sha256,
        source: { kind: 'development-snapshot', commit: candidate.commit, snapshotSha256: snapshot.sourceDigest, candidateId: candidate.id, reportSha256: reportArtifact.sha256 },
        launchArguments: profile.launchArguments.map(arg => arg.replaceAll('{runId}', runId)),
        fixture: { kind: 'verified-isolated', runId, evidenceSha256: profile.fixtureEvidenceSha256,
          ...profile.fixtureExpectedDataRoot ? { expectedDataRoot: profile.fixtureExpectedDataRoot.replaceAll('{runId}', runId) } : {} },
      };
    }
    const value = { id, status: report.status as NativeInspectionBuild['status'], product, candidate, report, reportArtifact,
      evidenceArtifacts, productArtifacts, snapshotArtifact, fixtureReceiptArtifact, fixtureProfileId: profile.id, error: reason };
    const preparationArtifact = await this.options.artifacts.put(JSON.stringify({ version: 1, kind: 'native-inspection-build', previewOnly: true, sourceIdentity, fixtureProfile: profile, ...value }), {
      ...context, name: `native-inspection-product-${id}.json`, mime: 'application/json', metadata: { previewOnly: true, sourceDigest: snapshot.sourceDigest, profileId: profile.id, status: report.status },
    });
    await writeFile(join(directory, 'record.json'), JSON.stringify({ id, preparationArtifact }), { flag: 'wx', mode: 0o600 });
    return { ...value, preparationArtifact };
    } catch (error) {
      // Build never launches a native process. Without a durable preparation
      // pointer this newly created extraction cache has no possible session owner.
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** Only products prepared under this service's private directory can reach the backend. */
  async product(id: string): Promise<NativeProduct> {
    return this.exclusive(id, () => this.productUnlocked(id));
  }

  /** Caller has fenced every author job/lease; native unknown or active sessions still prevent deletion. */
  async retirePreparedProduct(id: string, input: { releaseConfirmed: true }): Promise<void> {
    return this.exclusive(id, async () => {
      if (input.releaseConfirmed !== true) throw new NativeInspectionError('native-busy', 'Product retirement requires confirmed release of its jobs and leases.');
      const pointer = await this.pointer(id);
      await this.preparation(id, pointer.preparationArtifact, false);
      await this.confirmNoSessions(id);
      await rm(join(this.root, id), { recursive: true });
    });
  }

  /** Restore only the original archive and fixture identity; never build, launch or adopt fixture data. */
  async restorePreparedProduct(id: string, preparationArtifact: ArtifactManifest): Promise<NativeProduct> {
    return this.exclusive(id, async () => {
      await privateDirectory(this.root);
      const saved = await this.preparation(id, preparationArtifact), product = saved.product!;
      await this.confirmNoSessions(id);
      const directory = join(this.root, id);
      let exists = false;
      try { await lstat(directory); exists = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (exists) {
        const pointer = await this.pointer(id);
        if (!same(pointer.preparationArtifact, preparationArtifact)) throw new NativeInspectionError('invalid-product', 'Existing product has a different original preparation record.');
        return await this.productUnlocked(id);
      }
      const staging = join(this.root, `.restore-${id}-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        const index = saved.productArtifacts.findIndex(artifact => artifact.sha256 === product.originalArtifactSha256);
        const extracted = await this.extract(saved.productArtifacts[index]!, join(staging, `product-${index}`), product.platform);
        if (extracted.appPath.replace(staging + '/', directory + '/') !== product.appPath || extracted.bundleIdentifier !== product.bundleIdentifier || extracted.inventorySha256 !== product.inventorySha256) {
          throw new NativeInspectionError('invalid-product', 'Restored application differs from its original prepared identity.');
        }
        await verifyNativeProduct({ ...product, appPath: extracted.appPath });
        await writeFile(join(staging, 'record.json'), JSON.stringify({ id, preparationArtifact }), { flag: 'wx', mode: 0o600 });
        await rename(staging, directory);
        return structuredClone(product);
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    });
  }

  private async productUnlocked(id: string): Promise<NativeProduct> {
    const pointer = await this.pointer(id);
    const saved = await this.preparation(id, pointer.preparationArtifact);
    await verifyNativeProduct(saved.product!);
    return structuredClone(saved.product!);
  }

  private async pointer(id: string): Promise<{ id: string; preparationArtifact: ArtifactManifest }> {
    if (!uuid.test(id)) throw new NativeInspectionError('invalid-product', 'Invalid prepared native product identity.');
    await privateDirectory(this.root);
    const directory = join(this.root, id);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || await realpath(directory) !== directory) throw new NativeInspectionError('invalid-product', 'Prepared product directory changed.');
    const pointerPath = join(directory, 'record.json');
    if (!(await lstat(pointerPath)).isFile()) throw new NativeInspectionError('invalid-product', 'Prepared product pointer is not a regular service record.');
    const pointer = JSON.parse(await readFile(pointerPath, 'utf8')) as { id: string; preparationArtifact: ArtifactManifest };
    if (pointer.id !== id) throw new NativeInspectionError('invalid-product', 'Prepared product identity changed.');
    return pointer;
  }

  private async preparation(id: string, artifact: ArtifactManifest, requireProduct = true): Promise<NativePreparation> {
    if (!uuid.test(id)) throw new NativeInspectionError('invalid-product', 'Invalid prepared native product identity.');
    await this.authenticate(artifact);
    const saved = JSON.parse((await this.options.artifacts.read(artifact)).toString()) as NativePreparation;
    const product = saved.product, directory = join(this.root, id);
    if (saved.id !== id || saved.kind !== 'native-inspection-build' || saved.previewOnly !== true || !['passed', 'failed', 'canceled'].includes(saved.status)
      || (requireProduct && (saved.status !== 'passed' || !product))) {
      throw new NativeInspectionError('product-unavailable', 'This native build has no authenticated successful preview product.');
    }
    await this.authenticate(saved.reportArtifact);
    await this.authenticate(saved.snapshotArtifact);
    for (const reference of [...saved.evidenceArtifacts, ...saved.productArtifacts, saved.candidate.bundleArtifact, saved.candidate.diffArtifact,
      ...(saved.candidate.workingDirectories ?? []).flatMap(root => [root.bundleArtifact, root.diffArtifact])]) await this.authenticate(reference);
    const manifest = JSON.parse((await this.options.artifacts.read(saved.snapshotArtifact)).toString()) as InspectionSnapshotManifest;
    const expectedIdentity = { snapshotId: manifest.id, sha256: manifest.sourceDigest, previewOnly: true,
      roots: manifest.roots.map(root => ({ id: root.id, name: root.name, sha256: root.sourceDigest, originalSourceCommit: root.sourceCommit, checkedPreviewCommit: root.commit })) };
    if (manifest.purpose !== 'development-inspection' || manifest.previewOnly !== true || !same(expectedIdentity, saved.sourceIdentity)
      || saved.candidate.workspaceId !== manifest.id || saved.candidate.commit !== manifest.roots[0]?.commit
      || saved.report.status !== saved.status || saved.report.commit !== saved.candidate.commit || saved.report.candidateId !== saved.candidate.id
      || saved.fixtureProfileId !== saved.fixtureProfile.id || !saved.fixtureProfile.receipt
      || (!same(saved.fixtureReceiptArtifact, saved.fixtureProfile.receipt) && !same(saved.fixtureReceiptArtifact.metadata?.originalReceipt, saved.fixtureProfile.receipt))
      || saved.fixtureReceiptArtifact.sha256 !== saved.fixtureProfile.fixtureEvidenceSha256) {
      throw new NativeInspectionError('invalid-evidence', 'Prepared source, fixture or whole report identities changed.');
    }
    const fixtureAudit = await this.verifyFixtureReceipt(saved.fixtureReceiptArtifact, saved.fixtureProfile, manifest);
    await this.verifyFixtureReceipt(saved.fixtureProfile.receipt!, saved.fixtureProfile, manifest);
    const whole = JSON.parse((await this.options.artifacts.read(saved.reportArtifact)).toString());
    for (const key of ['id', 'candidateId', 'commit', 'status', 'commands', 'cleanupErrors', 'createdAt'] as const) {
      if (!same(whole[key], saved.report[key])) throw new NativeInspectionError('invalid-evidence', 'Prepared check differs from its original whole report.');
    }
    if (!same(whole.evidenceArtifacts, saved.evidenceArtifacts) || !same(whole.productArtifacts, saved.productArtifacts)
      || !same(whole.sourceIdentity, saved.sourceIdentity) || !same(whole.fixtureAudit, fixtureAudit)
      || whole.originalCommandCount !== saved.report.commands.length || !same(saved.report.logArtifact, saved.reportArtifact)) throw new NativeInspectionError('invalid-evidence', 'Original report source or retained references changed.');
    if (!saved.evidenceArtifacts.some(reference => same(reference, saved.fixtureReceiptArtifact))) throw new NativeInspectionError('invalid-evidence', 'Original fixture audit is absent from the retained report.');
    if (saved.status !== 'passed') {
      if (product) throw new NativeInspectionError('invalid-product', 'An unsuccessful build cannot retain a launchable product.');
      return saved;
    }
    if (!product || !product.appPath.startsWith(directory + '/') || product.source.kind !== 'development-snapshot'
      || product.source.reportSha256 !== saved.reportArtifact.sha256 || product.source.snapshotSha256 !== saved.sourceIdentity.sha256
      || product.source.commit !== saved.candidate.commit || product.source.candidateId !== saved.candidate.id || whole.sourceAudit?.verified !== true
      || product.fixture.evidenceSha256 !== saved.fixtureReceiptArtifact.sha256 || product.fixture.runId !== `native-${id}`
      || !same(product.launchArguments, saved.fixtureProfile.launchArguments.map(arg => arg.replaceAll('{runId}', product.fixture.runId)))
      || product.fixture.expectedDataRoot !== saved.fixtureProfile.fixtureExpectedDataRoot?.replaceAll('{runId}', product.fixture.runId)) throw new NativeInspectionError('invalid-product', 'Prepared product source or fixture identity changed.');
    const nativeArtifacts: ArtifactManifest[] = [];
    for (const result of saved.report.commands) {
      const native = (result as Partial<AppleCheckResult>).appleValidation;
      if (!native?.artifact || result.exitCode !== 0 || result.timedOut || result.cleanupErrors?.length
        || native.candidateId !== saved.candidate.id || native.candidateCommit !== saved.candidate.commit || native.checkedCommit !== saved.candidate.commit
        || native.sandbox !== 'macos-seatbelt-deny-default' || !same(native.profile, saved.fixtureProfile.build)
        || !same(native.workingDirectories, (saved.candidate.workingDirectories ?? []).map(({ containerPath, commit }) => ({ containerPath, commit })))) throw new NativeInspectionError('invalid-evidence', 'Native evidence does not bind the exact preview source.');
      await this.authenticate(native.artifact);
      const { artifact: _artifact, ...inline } = native;
      const { appleValidation: _validation, ...originalResult } = result as AppleCheckResult;
      if (!same(JSON.parse((await this.options.artifacts.read(native.artifact)).toString()), { ...inline, result: originalResult })) throw new NativeInspectionError('invalid-evidence', 'Native evidence differs from its original whole report.');
      nativeArtifacts.push(...native.products);
    }
    if (!saved.report.commands.length || !same(nativeArtifacts, saved.productArtifacts)
      || !saved.evidenceArtifacts.some(reference => same(reference, saved.fixtureReceiptArtifact))) throw new NativeInspectionError('invalid-evidence', 'Original retained fixture or native products are missing.');
    const index = saved.productArtifacts.findIndex(reference => reference.sha256 === product.originalArtifactSha256);
    const selected = saved.productArtifacts[index];
    const build = parseAppleCheckCommand(`${APPLE_CHECK_PREFIX} ${JSON.stringify(saved.fixtureProfile.build)}`);
    if (build.tool !== 'xcodebuild') throw new NativeInspectionError('invalid-product', 'Prepared native build profile changed.');
    if (!selected || product.platform !== build.platform
      || selected.metadata?.candidateId !== saved.candidate.id || selected.metadata.commit !== saved.candidate.commit
      || selected.metadata.candidateCommit !== saved.candidate.commit || selected.metadata.platform !== product.platform
      || selected.metadata.scheme !== build.scheme || selected.metadata.format !== 'apple-app-zip' || selected.metadata.unsigned !== true
      || selected.mime !== 'application/zip') throw new NativeInspectionError('invalid-product', 'Original native archive is absent or has different source identity.');
    const inspected = inspectNativeAppZip(await this.options.artifacts.read(selected));
    if (product.appPath !== join(directory, `product-${index}`, 'extracted', inspected.appName)) throw new NativeInspectionError('invalid-product', 'Prepared application path differs from its original archive.');
    return saved;
  }

  readiness(platform: NativePlatform) { return this.options.backend.readiness(platform); }
  requestMacPermissions() { return this.options.backend.requestMacPermissions(); }
  async start(productId: string, ownerAttemptId: string, sessionId?: string) { return this.exclusive(productId, async () => this.options.backend.start(await this.productUnlocked(productId), ownerAttemptId, sessionId)); }
  observe(sessionId: string) { return this.options.backend.observe(sessionId); }
  act(sessionId: string, action: NativeAction) { return this.options.backend.act(sessionId, action); }
  async restart(sessionId: string, observationId?: string) {
    const session = (await this.options.backend.discover()).find(session => session.id === sessionId);
    const id = session?.product.appPath.startsWith(this.root + '/') ? session.product.appPath.slice(this.root.length + 1).split('/')[0] : undefined;
    if (!id || !uuid.test(id)) throw new NativeInspectionError('invalid-product', 'Native restart requires an authenticated product owned by this service.');
    return this.exclusive(id, async () => {
      if (!same(await this.productUnlocked(id), session!.product)) throw new NativeInspectionError('invalid-product', 'Active native product differs from its original preparation.');
      return this.options.backend.restart(sessionId, observationId);
    });
  }
  stop(sessionId: string) { return this.options.backend.stop(sessionId); }
  recoverStop(sessionId: string) { return this.options.backend.recoverStop(sessionId); }
  discover() { return this.options.backend.discover(); }
  closeTransport() { this.options.backend.closeTransport(); }

  private verifySnapshot(snapshot: InspectionSnapshot, signal?: AbortSignal) {
    return this.options.verifySnapshot ? this.options.verifySnapshot(snapshot, signal) : this.snapshots.verify(snapshot, signal);
  }

  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.productOperations.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    this.productOperations.set(id, next);
    try { return await next; }
    finally { if (this.productOperations.get(id) === next) this.productOperations.delete(id); }
  }

  private async confirmNoSessions(id: string): Promise<void> {
    const directory = join(this.root, id);
    if ((await this.options.backend.discover()).some(session => session.product?.appPath === directory || session.product?.appPath.startsWith(directory + '/'))) {
      throw new NativeInspectionError('native-busy', 'An active or unknown native session still owns this product.');
    }
  }

  private async verifyFixtureReceipt(artifact: ArtifactManifest, profile: NativeFixtureProfile, manifest: InspectionSnapshotManifest) {
    await this.authenticate(artifact);
    if (artifact.size > 1024 * 1024 || artifact.mime !== 'application/json' || artifact.sha256 !== profile.fixtureEvidenceSha256) throw new NativeInspectionError('fixture-required', 'Invalid original fixture audit receipt.');
    const receipt = JSON.parse((await this.options.artifacts.read(artifact)).toString()) as FixtureSourceReceipt;
    if (receipt.version !== 1 || receipt.kind !== 'native-fixture-source-audit' || receipt.profileId !== profile.id
      || !same(receipt.launchArguments, profile.launchArguments) || !same(receipt.build, profile.build)
      || receipt.bundleIdentifier !== profile.bundleIdentifier || receipt.fixtureExpectedDataRoot !== profile.fixtureExpectedDataRoot
      || !Array.isArray(receipt.roots) || receipt.roots.length !== manifest.roots.length) {
      throw new NativeInspectionError('fixture-required', 'Fixture audit does not authorize this exact profile and source roots.');
    }
    const roots = new Set<string>(); let matchedEntries = 0;
    for (const audit of receipt.roots) {
      const root = manifest.roots.find(root => root.name === audit.name);
      if (!root || roots.has(audit.name) || !Array.isArray(audit.entries) || !audit.entries.length || audit.entries.length > 30_000) throw new NativeInspectionError('fixture-required', 'Invalid fixture audit source root.');
      roots.add(audit.name);
      const entries = new Map(root.entries.map(entry => [entry.path, entry])), audited = new Set<string>();
      for (const entry of audit.entries) {
        const original = entries.get(entry.path);
        if (!safeRelative(entry.path) || !hash.test(entry.sha256) || audited.has(entry.path) || original?.kind !== 'file' || original.sha256 !== entry.sha256) throw new NativeInspectionError('fixture-source-changed', `Fixture audited source changed or is missing: ${entry.path}`);
        audited.add(entry.path); matchedEntries++;
      }
      const scopes = audit.protectedSourceDirectories ?? [], allowed = audit.allowedPaths ?? [];
      if (!Array.isArray(scopes) || scopes.length > 1024 || scopes.some(path => typeof path !== 'string' || !safeRelative(path.replace(/\/$/, '')))
        || !Array.isArray(allowed) || allowed.length > 1024 || allowed.some(path => !safeRelative(path) || audited.has(path))) throw new NativeInspectionError('fixture-required', 'Invalid protected fixture source scope.');
      const protectedPath = (path: string) => scopes.some(scope => path === scope.replace(/\/$/, '') || path.startsWith(scope.replace(/\/$/, '') + '/'));
      if (allowed.some(path => !protectedPath(path))) throw new NativeInspectionError('fixture-required', 'Fixture audit exception is outside its protected source scope.');
      for (const entry of root.entries) {
        if (entry.kind !== 'directory' && scopes.some(scope => scope.replace(/\/$/, '') === entry.path || scope.replace(/\/$/, '').startsWith(entry.path + '/'))) throw new NativeInspectionError('fixture-source-changed', `Protected fixture directory became a file or link: ${entry.path}`);
        if (entry.kind !== 'directory' && protectedPath(entry.path) && !allowed.includes(entry.path) && !audited.has(entry.path)) throw new NativeInspectionError('fixture-source-changed', `Unaudited file in protected fixture source: ${entry.path}`);
      }
    }
    return { receiptArtifact: artifact, profileId: profile.id, matchedEntries };
  }

  private async authenticate(artifact: ArtifactManifest): Promise<void> {
    const original = await this.options.artifacts.get(artifact.id);
    if (!same(original, artifact)) throw new NativeInspectionError('invalid-evidence', 'Artifact manifest differs from the original retained identity.');
    await this.options.artifacts.path(original);
  }

  private async previewCandidate(snapshot: InspectionSnapshot, directory: string, context: { goalId: string; taskId: string; attemptId: string }, signal?: AbortSignal): Promise<Candidate> {
    const captures: Array<{ bundleArtifact: ArtifactManifest; diffArtifact: ArtifactManifest }> = [];
    for (const [index, root] of snapshot.roots.entries()) {
      const bundle = join(directory, `source-${index}.bundle`);
      await git(root.path, ['-c', 'pack.threads=1', '-c', 'core.compression=6', 'bundle', 'create', bundle, 'HEAD'], signal);
      captures.push({
        bundleArtifact: await this.options.artifacts.putFile(bundle, { ...context, name: `inspection-source-${root.id}.bundle`, mime: 'application/x-git-bundle', metadata: { previewOnly: true, sourceDigest: root.sourceDigest, checkedPreviewCommit: root.commit, originalSourceCommit: root.sourceCommit } }),
        diffArtifact: await this.options.artifacts.put('', { ...context, name: `inspection-source-${root.id}.patch`, mime: 'text/x-patch', metadata: { previewOnly: true, baseCommit: root.commit, commit: root.commit } }),
      });
      await rm(bundle);
    }
    const primary = snapshot.roots[0]!;
    const workingDirectories: WorkingDirectoryCapture[] = snapshot.roots.slice(1).map((root, index) => ({ id: root.id, name: root.name, kind: root.kind, containerPath: root.containerPath, baseCommit: root.commit, commit: root.commit, ...captures[index + 1]! }));
    return { id: randomUUID(), workspaceId: snapshot.id, ...context, deviceId: this.options.artifacts.deviceId,
      baseCommit: primary.commit, commit: primary.commit, branch: `refs/enoughfactory/inspection/${snapshot.id}`,
      ...captures[0]!, createdAt: new Date().toISOString(), workingDirectories,
    };
  }

  private async extract(artifact: ArtifactManifest, directory: string, platform: NativePlatform, signal?: AbortSignal) {
    if (artifact.size > maxArchive) throw new NativeInspectionError('invalid-product', 'Native archive exceeds the extraction limit.');
    const bytes = await this.options.artifacts.read(artifact);
    if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) throw new NativeInspectionError('invalid-product', 'Native archive changed before extraction.');
    const inspected = inspectNativeAppZip(bytes);
    await mkdir(directory, { mode: 0o700 });
    await reserveNativeNames(inspected.entries, join(directory, 'names'));
    const archive = join(directory, 'original.zip'), destination = join(directory, 'extracted');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o400 });
    await mkdir(destination, { mode: 0o700 });
    // The complete central/local names, links, expansion and CRCs were checked before
    // ditto applies Apple's retained metadata. No author supplied process or arguments run.
    try { await execute('/usr/bin/ditto', ['-x', '-k', archive, destination], { timeout: 60_000, signal, maxBuffer: 1024 * 1024 }); }
    finally { await rm(archive, { force: true }); } // The authenticated original remains in ArtifactStore.
    const appPath = join(destination, inspected.appName);
    if (await realpath(appPath) !== appPath) throw new NativeInspectionError('invalid-product', 'Extracted application is not canonical.');
    const infoPath = join(appPath, platform === 'macos' ? 'Contents/Info.plist' : 'Info.plist');
    if (!(await lstat(infoPath)).isFile()) throw new NativeInspectionError('invalid-product', 'Application has no regular Info.plist.');
    const { stdout } = await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPath], { timeout: 10_000, signal, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout);
    if (typeof info.CFBundleIdentifier !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(info.CFBundleIdentifier)
      || typeof info.CFBundleExecutable !== 'string' || !/^[^/\\\x00-\x1f]+$/.test(info.CFBundleExecutable) || ['.', '..'].includes(info.CFBundleExecutable)
      || !Array.isArray(info.CFBundleSupportedPlatforms) || !info.CFBundleSupportedPlatforms.includes(platform === 'macos' ? 'MacOSX' : 'iPhoneSimulator')) {
      throw new NativeInspectionError('invalid-product', 'Application bundle identity or platform is invalid.');
    }
    const executable = await lstat(join(appPath, platform === 'macos' ? 'Contents/MacOS' : '', info.CFBundleExecutable));
    if (!executable.isFile() || !(executable.mode & 0o111)) throw new NativeInspectionError('invalid-product', 'Application executable is missing or not a regular executable.');
    const inventory = await inventoryApp(appPath);
    const expected = new Map<string, { type: 'directory' | 'file' | 'symlink'; mode?: number; sha256?: string; target?: string }>();
    expected.set('', { type: 'directory' });
    for (const entry of inspected.entries) {
      if (!entry.path.startsWith(inspected.appName + '/') && entry.path !== inspected.appName) continue;
      if (appleMetadata(entry)) continue;
      const path = entry.path.slice(inspected.appName.length).replace(/^\//, '').normalize('NFC');
      const type = entry.kind === 0o120000 ? 'symlink' : entry.name.endsWith('/') ? 'directory' : 'file';
      expected.set(path, { type, ...entry.mode ? { mode: entry.mode & 0o777 } : {},
        ...type === 'file' ? { sha256: sha256(entry.bytes) } : {},
        ...type === 'symlink' ? { target: entry.bytes.toString('utf8') } : {},
      });
      const parts = path.split('/');
      for (let index = 1; index < parts.length; index++) {
        const parent = parts.slice(0, index).join('/');
        if (!expected.has(parent)) expected.set(parent, { type: 'directory' });
      }
    }
    if (inventory.length !== expected.size) throw new NativeInspectionError('invalid-product', 'Extracted application has missing, colliding or unlisted members.');
    for (const entry of inventory) {
      const original = expected.get(entry.path.normalize('NFC'));
      if (!original || entry.type !== original.type || (original.mode !== undefined && entry.mode !== original.mode)
        || (original.sha256 !== undefined && entry.sha256 !== original.sha256) || (original.target !== undefined && entry.target !== original.target)) {
        throw new NativeInspectionError('invalid-product', 'Extracted application differs from original archive members.');
      }
    }
    return { appPath, bundleIdentifier: info.CFBundleIdentifier as string, inventorySha256: sha256(JSON.stringify(inventory)) };
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new NativeInspectionError('invalid-storage', 'Native product storage must be a private service-owned directory.');
}
async function git(path: string, args: string[], signal?: AbortSignal): Promise<string> {
  const { stdout } = await execute('/usr/bin/git', ['-C', path, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    timeout: 60_000, signal, maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function safeRelative(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\\\x00-\x1f:]/.test(path) && !path.startsWith('/')
    && path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
}
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }

interface ZipEntry { name: string; path: string; kind: number; mode: number; bytes: Buffer; start: number; end: number; }
/** Preflight every interpretation-relevant ZIP field before the fixed system extractor. */
export function validateNativeAppZip(bytes: Buffer): { appName: string; expandedBytes: number; entryCount: number } {
  const { appName, expandedBytes, entryCount } = inspectNativeAppZip(bytes);
  return { appName, expandedBytes, entryCount };
}
function inspectNativeAppZip(bytes: Buffer): { appName: string; expandedBytes: number; entryCount: number; entries: ZipEntry[] } {
  const fail = (text: string): never => { throw new NativeInspectionError('invalid-product', `Unsafe native archive: ${text}`); };
  if (bytes.length < 22 || bytes.length > maxArchive) fail('archive size');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) fail('split or missing directory');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), offset = bytes.readUInt32LE(end + 16);
  if (!count || count > 30_000 || count !== bytes.readUInt16LE(end + 8) || offset + size !== end) fail('directory bounds');
  const entries: ZipEntry[] = [], seen = new Map<string, ZipEntry>(), apps = new Set<string>();
  let at = offset, expandedBytes = 0;
  const safePath = (name: string): string => {
    const path = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!path || path.length > 4096 || /[\\\x00-\x1f:]/.test(path) || path.startsWith('/') || path.split('/').length > 64 || path.split('/').some(p => !p || p === '.' || p === '..')) fail('entry path');
    return path;
  };
  const extras = (start: number, length: number): void => {
    const stop = start + length;
    while (start < stop) {
      if (start + 4 > stop) fail('extra field bounds');
      const id = bytes.readUInt16LE(start), size = bytes.readUInt16LE(start + 2);
      // Timestamp/UID metadata only. Unicode path overrides, ZIP64 and alternate
      // filename/link interpretations are deliberately outside this bounded format.
      if (![0x5455, 0x5855, 0x7855, 0x7875].includes(id) || start + 4 + size > stop) fail('unsupported extra field');
      start += 4 + size;
    }
  };
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) fail('central entry');
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20), expanded = bytes.readUInt32LE(at + 24);
    const nameSize = bytes.readUInt16LE(at + 28), extraSize = bytes.readUInt16LE(at + 30), commentSize = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42), mode = bytes.readUInt32LE(at + 38) >>> 16;
    // ditto stores directories with explicit sizes and deflates payloads. Refuse
    // stored entries with a streaming descriptor, whose end is ambiguous to readers.
    if (flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || (method === 0 && (flags & 8)) || bytes.readUInt16LE(at + 34) || at + 46 + nameSize + extraSize + commentSize > end || expanded > maxArchive) fail('unsupported entry');
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameSize), name = nameBytes.toString('utf8'), path = safePath(name);
    // The fixed ditto producer uses UTF-8 even when it omits bit 0x800.
    if (!Buffer.from(name, 'utf8').equals(nameBytes)) fail('filename encoding');
    const kind = mode & 0o170000;
    if (![0, 0o100000, 0o040000, 0o120000].includes(kind) || mode & 0o6000 || ((kind === 0o040000) !== name.endsWith('/') && kind !== 0)) fail('special file or inconsistent directory');
    const folded = path.normalize('NFC').toLowerCase();
    if (seen.has(folded)) fail('duplicate or colliding entry');
    extras(at + 46 + nameSize, extraSize);
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail('local header');
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameSize + localExtraSize;
    if (start + compressed > offset || localNameSize !== nameSize || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(nameBytes)) fail('local filename or size');
    extras(local + 30 + localNameSize, localExtraSize);
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== expanded)) fail('local integrity fields');
    expandedBytes += expanded;
    if (expandedBytes > maxArchive) fail('expanded size limit');
    let content: Buffer;
    try {
      if (method === 0) content = Buffer.from(bytes.subarray(start, start + compressed));
      else {
        const inflated = inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, expanded), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
        if (inflated.engine.bytesWritten !== compressed) fail('trailing compressed bytes');
        content = inflated.buffer;
      }
    }
    catch { return fail('invalid compression or expanded size'); }
    if (content.length !== expanded || crc32(content) !== crc || (name.endsWith('/') && content.length)) fail('entry CRC or size');
    let entryEnd = start + compressed;
    if (flags & 8) {
      if (entryEnd + 12 > offset) fail('data descriptor bounds');
      if (bytes.readUInt32LE(entryEnd) === 0x08074b50) entryEnd += 4;
      if (entryEnd + 12 > offset || bytes.readUInt32LE(entryEnd) !== crc || bytes.readUInt32LE(entryEnd + 4) !== compressed || bytes.readUInt32LE(entryEnd + 8) !== expanded) fail('data descriptor');
      entryEnd += 12;
    }
    const entry: ZipEntry = { name, path, kind, mode, bytes: content, start: local, end: entryEnd };
    entries.push(entry); seen.set(folded, entry);
    const root = path.split('/')[0]!;
    if (root !== '__MACOSX') { if (!root.endsWith('.app')) fail('non-application root'); apps.add(root); }
    else if (kind === 0o120000) fail('metadata symlink');
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== end || apps.size !== 1) fail('require one complete application');
  const appName = [...apps][0]!;
  const ranges = [...entries].sort((a, b) => a.start - b.start);
  if (ranges[0]!.start !== 0 || ranges.at(-1)!.end !== offset) fail('unreferenced archive bytes');
  for (let index = 1; index < ranges.length; index++) if (ranges[index]!.start !== ranges[index - 1]!.end) fail('overlapping or unreferenced entries');
  for (const entry of entries) {
    const parts = entry.path.split('/');
    if (parts[0] === '__MACOSX' && parts.length > 1 && ![appName, '._' + appName].includes(parts[1]!)) fail('unrelated Apple metadata');
    if (appleMetadata(entry)) {
      const normalPath = entry.path.replace(/^__MACOSX\//, '');
      const target = posix.join(posix.dirname(normalPath), posix.basename(normalPath).slice(2));
      if (!seen.has(target.normalize('NFC').toLowerCase())) fail('metadata without original member');
    }
    for (let index = 1; index < parts.length; index++) {
      const parent = seen.get(parts.slice(0, index).join('/').normalize('NFC').toLowerCase());
      if (parent && !parent.name.endsWith('/')) fail('non-directory ancestor');
    }
    if (entry.kind === 0o120000) {
      const target = entry.bytes.toString('utf8');
      if (!Buffer.from(target).equals(entry.bytes) || !target || target.startsWith('/') || /[\\\x00-\x1f:]/.test(target) || target.split('/').some(p => p === '..')) fail('unsafe symlink');
      const resolved = posix.normalize(posix.join(posix.dirname(entry.path), target));
      if (resolved !== appName && !resolved.startsWith(appName + '/')) fail('escaping symlink');
      if (!seen.has(resolved.normalize('NFC').toLowerCase()) && !entries.some(x => x.path.startsWith(resolved + '/'))) fail('dangling symlink');
    }
  }
  return { appName, expandedBytes, entryCount: count, entries };
}

/** Reserve only empty files/directories, never links, on the actual target filesystem. */
async function reserveNativeNames(entries: ZipEntry[], directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  const created = new Set<string>([directory]);
  try {
    for (const entry of entries) {
      const parts = entry.path.split('/');
      const directories = entry.name.endsWith('/') ? parts : parts.slice(0, -1);
      let parent = directory;
      for (const part of directories) {
        parent = join(parent, part);
        if (!created.has(parent)) { await mkdir(parent, { mode: 0o700 }); created.add(parent); }
      }
      if (!entry.name.endsWith('/')) await writeFile(join(directory, ...parts), '', { flag: 'wx', mode: 0o600 });
    }
  } catch (error) {
    throw new NativeInspectionError('invalid-product', `Archive paths collide on this filesystem: ${message(error)}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function appleMetadata(entry: ZipEntry): boolean {
  if (!posix.basename(entry.path).startsWith('._') || entry.bytes.length < 26 || entry.bytes.readUInt32BE(0) !== 0x00051607) return false;
  if (entry.bytes.readUInt32BE(4) !== 0x00020000) throw new NativeInspectionError('invalid-product', 'Unsupported Apple metadata version.');
  const count = entry.bytes.readUInt16BE(24);
  if (count > 16 || 26 + 12 * count > entry.bytes.length) throw new NativeInspectionError('invalid-product', 'Invalid Apple metadata directory.');
  for (let index = 0; index < count; index++) {
    const at = 26 + 12 * index, id = entry.bytes.readUInt32BE(at), offset = entry.bytes.readUInt32BE(at + 4), size = entry.bytes.readUInt32BE(at + 8);
    if (![2, 9].includes(id) || offset < 26 + 12 * count || offset + size > entry.bytes.length) throw new NativeInspectionError('invalid-product', 'Unsupported Apple metadata entry.');
  }
  return true;
}

const crcTable = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  crcTable[value] = crc >>> 0;
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
