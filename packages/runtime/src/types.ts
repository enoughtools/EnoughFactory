export interface DockerRuntimeEndpoint { host: string; cliPath: string; configDirectory: string }
export type RuntimePhase = 'missing' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'error' | 'unsupported';
export interface RuntimeProgress { phase: RuntimePhase; message: string }
export interface RuntimeLimits { cpuCount: number; memoryGiB: number; diskGiB: number }
export interface RuntimeOptions {
  /** The device service's private application directory, never the user's home. */
  stateDirectory: string;
  /** Directory containing docker/bin and, on Mac, lima/{bin,share}. */
  assetsDirectory: string;
  cpuCount?: number; memoryGiB?: number; diskGiB?: number;
  onProgress?: (event: RuntimeProgress) => void;
}
export interface RuntimeStatus extends RuntimeProgress {
  kind: 'lima-vz' | 'rootless-docker'; managed: true;
  endpoint?: DockerRuntimeEndpoint; version?: string; prerequisites?: string[]; error?: string;
}
export interface ContainerRuntimeStatus {
  kind: 'lima' | 'rootless'; state: 'unavailable' | 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';
  version?: string; dockerVersion?: string; socketPath: string; dataDirectory: string;
  cpus?: number; memoryGiB?: number; diskGiB?: number; phase?: string; error?: string;
  requiredActions?: Array<{ label: string; detail: string; command?: string }>;
  artifactFsSupported: boolean;
}
