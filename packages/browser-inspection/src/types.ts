import type { ArtifactManifest } from '@enoughfactory/workspaces';
import type { PreparedBrowserImage } from './image.ts';

/** Source identity is supplied by the owner; screenshots alone do not prove acceptance. */
export interface BrowserSourceIdentity { commit?: string; snapshotSha256?: string; dirty?: boolean; }
export interface BrowserViewport { width: number; height: number; }
export const BROWSER_VIEWPORT_MAX_DIMENSION = 4096;
/** Validate launch input before allocating a browser; copy it across async ownership boundaries. */
export function validateBrowserViewport(value: unknown): BrowserViewport | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'width') || !Object.hasOwn(value, 'height')) {
    throw new BrowserInspectionError('Browser viewport must contain only width and height.', 'INVALID_VIEWPORT');
  }
  const { width, height } = value as Record<string, unknown>;
  if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > BROWSER_VIEWPORT_MAX_DIMENSION || height > BROWSER_VIEWPORT_MAX_DIMENSION) {
    throw new BrowserInspectionError(`Browser viewport width and height must be integers between 1 and ${BROWSER_VIEWPORT_MAX_DIMENSION}.`, 'INVALID_VIEWPORT');
  }
  return { width, height };
}
export interface BrowserSessionIdentity {
  id: string; sessionId: string; attemptId?: string; goalId?: string; taskId?: string;
  authorContainerId: string; authorityGeneration: number; source?: BrowserSourceIdentity;
  /** Requested initial CSS viewport, applied before any page is created; observations retain actual pixels. */
  viewport?: BrowserViewport;
}
export type BrowserLeaseState = 'preparing' | 'ready' | 'busy' | 'unknown' | 'retiring' | 'retired' | 'failed';
export interface BrowserLease extends BrowserSessionIdentity {
  version: 1; name: string; authorContainerId: string; containerId?: string;
  image: PreparedBrowserImage; port: number; endpoint: string; state: BrowserLeaseState;
  createdAt: string; updatedAt: string; lastUsedAt: string; idleDeadline: string;
  mcpSessionId?: string; protocolVersion?: string; reason?: string;
  operation?: { id: string; tool: string; startedAt: string };
  artifacts: ArtifactManifest[];
}
export interface BrowserToolContent {
  type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown;
}
export interface BrowserToolResult {
  content: BrowserToolContent[]; isError?: boolean; structuredContent?: unknown;
  [key: string]: unknown;
}
export interface BrowserObservation {
  lease: BrowserLease; result: BrowserToolResult; artifacts: ArtifactManifest[];
  /** Safe to persist. The original result above retains actual image bytes for the provider. */
  event: { tool: string; operationId: string; content: BrowserToolContent[]; isError?: boolean; artifactIds: string[] };
}
export interface BrowserToolDefinition { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; }
export interface BrowserCallOptions { signal?: AbortSignal; assertCurrent?: () => void; timeoutMs?: number; source?: BrowserSourceIdentity; }
export class BrowserInspectionError extends Error {
  constructor(message: string, readonly code: string, readonly outcomeUnknown = false) { super(message); this.name = 'BrowserInspectionError'; }
}
