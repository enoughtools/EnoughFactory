import type { PreparedToolchain } from "@enoughfactory/runtime";

export type WorkspaceProvider = "git" | "artifactfs";
export type DevelopmentToolchain = PreparedToolchain;

/** Coordinator-selected check configuration frozen before the attempt starts. */
export interface FrozenCheckInputs {
  configurationRevision: number;
  workingDirectoryIds: string[];
  environment: Record<string, string>;
}

export interface ArtifactManifest {
  id: string;
  name: string;
  mime: string;
  sha256: string;
  size: number;
  deviceId: string;
  createdAt: string;
  goalId?: string;
  taskId?: string;
  attemptId?: string;
  metadata?: Record<string, unknown>;
}

/** A user-selected source. Its files are read only; agents receive a private snapshot. */
export interface WorkingDirectoryConfig {
  id: string;
  name: string;
  path: string;
}

export interface WorkingDirectorySource {
  id: string;
  name: string;
  kind: "git" | "folder";
  containerPath: string;
  baseCommit: string;
  sourceCommit?: string;
  sourceArtifact: ArtifactManifest;
}

/** The local private path is never part of the transferred source contract. */
export interface WorkingDirectorySnapshot extends WorkingDirectorySource {
  path: string;
}

export interface WorkingDirectoryCapture {
  id: string;
  name: string;
  kind: "git" | "folder";
  containerPath: string;
  baseCommit: string;
  commit: string;
  bundleArtifact: ArtifactManifest;
  diffArtifact: ArtifactManifest;
}

export interface WorkspaceRecord {
  id: string;
  goalId: string;
  taskId: string;
  attemptId: string;
  deviceId: string;
  projectPath: string;
  path: string;
  provider: WorkspaceProvider;
  baseCommit: string;
  branch: string;
  createdAt: string;
  providerState?: Record<string, unknown>;
  fallbackReason?: string;
  repairConflicts?: string[];
  developmentToolchain?: DevelopmentToolchain;
  checkInputs?: FrozenCheckInputs;
  /** Frozen placement; omitted legacy records retain container semantics. */
  executionTargetKind?: "container" | "host-macos";
}

export interface Candidate {
  id: string;
  workspaceId: string;
  goalId: string;
  taskId: string;
  attemptId: string;
  deviceId: string;
  baseCommit: string;
  commit: string;
  branch: string;
  bundleArtifact: ArtifactManifest;
  diffArtifact: ArtifactManifest;
  createdAt: string;
  repairConflicts?: string[];
  workingDirectories?: WorkingDirectoryCapture[];
  developmentToolchain?: DevelopmentToolchain;
  checkInputs?: FrozenCheckInputs;
  /** Captured with the immutable source evidence, never inferred from command text. */
  executionTargetKind?: "container" | "host-macos";
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  endedAt: string;
  timedOut?: boolean;
  executionTargetKind?: "container" | "host-macos";
  /** Native host execution is explicit full access, not container confinement. */
  hostPermissions?: "full-host";
  /** Structured application checker result; never parsed from command output. */
  factoryQuality?: unknown;
  /** Actual checker image, which can differ from the author device's architecture. */
  developmentToolchain?: DevelopmentToolchain;
  /** An explicit check-container compatibility layer; separate from the frozen compiler image. */
  runtimeCompatibility?: CheckCompatibilityEvidence;
  /** Resource cleanup failures do not replace the command's output or original status. */
  cleanupErrors?: string[];
}

export interface CheckCompatibilityEvidence {
  id: "swift-foundation-provenance-v1";
  helperSha256: string;
  sourceSha256: string;
  compiledSha256: string;
  scope: "check-command-and-descendants; suppress-only-EOPNOTSUPP/ENOTSUP-for-com.apple.provenance-on-real-directories";
}

export interface CheckContext {
  path: string;
  commit: string;
  candidate: Candidate;
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
  workingDirectories?: Array<{ path: string; containerPath: string; commit: string }>;
  executionTargetKind?: "container" | "host-macos";
  /** Application-owned verification authority bound to this exact checked tree. */
  verification?: unknown;
}

export interface CheckExecutor {
  (context: CheckContext): Promise<CommandResult>;
  release?(path: string): Promise<void>;
}

export interface CheckReport {
  id: string;
  candidateId: string;
  commit: string;
  baseCommit?: string;
  developmentToolchain?: DevelopmentToolchain;
  candidateDevelopmentToolchain?: DevelopmentToolchain;
  status: "passed" | "failed" | "not-configured" | "canceled";
  commands: CommandResult[];
  logArtifact: ArtifactManifest;
  createdAt: string;
  /** Application-owned frozen authority and contract binding, absent on legacy reports. */
  verificationSha256?: string;
  /** Post-release audit outcome remains distinct from command or UI evidence status. */
  sourceIntegrity?: "verified" | "failed" | "unconfirmed";
  /** A failed release keeps the private snapshots available for diagnosis. */
  cleanupErrors?: string[];
}

export interface IntegrationResult {
  status: "integrated" | "conflict" | "checks-failed" | "stale" | "target-dirty" | "target-moved";
  candidateId: string;
  targetBranch: string;
  previousCommit: string;
  commit?: string;
  report?: CheckReport;
  conflicts?: string[];
  message?: string;
}

/** Mounting belongs to the trusted manager; agent runtimes receive only its workspace. */
export interface ManagedWorkspaceProvider {
  prepare(record: WorkspaceRecord): Promise<Record<string, unknown>>;
  capture?(record: WorkspaceRecord): Promise<{ repositoryPath?: string; reference?: string; bundlePath?: string; commit?: string }>;
  promotePreviousCandidate?(record: WorkspaceRecord, candidate: Candidate, bundlePath: string): Promise<{ commit?: string; conflicts: string[]; message?: string }>;
  dispose?(record: WorkspaceRecord): Promise<void>;
}
