import type { ArtifactManifest } from '@enoughfactory/workspaces';
import type { PreparedBrowserImage } from './image.ts';

/** Source identity is supplied by the owner; screenshots alone do not prove acceptance. */
export interface BrowserSourceIdentity { commit?: string; snapshotSha256?: string; dirty?: boolean; }
export interface BrowserSessionIdentity {
  id: string; sessionId: string; attemptId?: string; goalId?: string; taskId?: string;
  authorContainerId: string; authorityGeneration: number; source?: BrowserSourceIdentity;
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
