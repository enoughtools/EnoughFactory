export type NativePlatform = 'macos' | 'ios-simulator';
export type NativeReadiness = { status: 'ready' | 'setup-required' | 'unsupported'; reasons: string[]; accessibility?: boolean; screenCapture?: boolean; guiSession?: boolean };

/** Supplied by the trusted build/fixture coordinator, never by an author tool argument. */
export interface NativeProduct {
  platform: NativePlatform;
  appPath: string;
  bundleIdentifier: string;
  /** SHA256 of canonical inventoryApp() output, captured from original extracted bytes. */
  inventorySha256: string;
  originalArtifactSha256: string;
  source: { kind: 'candidate' | 'integrated' | 'development-snapshot'; commit?: string; tree?: string; snapshotSha256?: string; candidateId?: string; reportSha256?: string };
  launchArguments: string[];
  /** Verification is a coordinator responsibility; HOME redirection is not isolation. */
  fixture: { kind: 'verified-isolated'; runId: string; evidenceSha256: string; expectedDataRoot?: string };
}

export interface NativeElement {
  id: string; type: string; identifier?: string; label?: string; value?: string;
  enabled: boolean; hittable?: boolean;
  frame: { x: number; y: number; w: number; h: number };
  actions?: string[];
}
export interface NativeScreenshot { path: string; mimeType: 'image/png'; sha256: string; width: number; height: number; }
export interface NativeObservation {
  sessionId: string; observationId: string; observedAt: string; appState: string;
  screenshot: NativeScreenshot; elements: NativeElement[]; truncated: boolean;
}
export type NativeAction =
  | { kind: 'click'; observationId: string; elementId: string }
  | { kind: 'type'; observationId: string; elementId: string; text: string; mode?: 'replace' | 'append' }
  | { kind: 'key'; observationId: string; key: 'enter' | 'backspace' | 'escape' | 'tab' | 'selectAll' }
  | { kind: 'scroll'; observationId: string; elementId: string; direction: 'up' | 'down' | 'left' | 'right' };
export interface NativeActionOutcome { performed: boolean; requiresObservation: true; }
export interface NativeSession {
  id: string; ownerAttemptId: string; platform: NativePlatform; product: NativeProduct;
  pid?: number; processStartedAt?: number; simulatorId?: string; startedAt: string; directory: string;
}
/** Stop-only reconciliation never retroactively changes unknown historical input outcomes. */
export interface NativeRecoveryResult { sessionId: string; status: 'stopped' | 'unknown'; originalProcessExited?: boolean; historicalActionsRemainUnknown: true; reason?: string; }
export interface NativeBackendOptions {
  directory: string;
  /** Stable signed helper bundle executable. Development build is ad-hoc signed. */
  macHelperExecutable?: string;
  iosXctestrunPath?: string;
  iosSimulatorRuntime?: string;
  iosSimulatorDeviceType?: string;
  commandTimeoutMs?: number;
}
export class NativeInspectionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'NativeInspectionError'; }
}
