import type { RpcRequest, RpcResponse, StreamEvent } from '@enoughfactory/contracts';

export interface IceServer { urls: string | string[]; username?: string; credential?: string }
export interface SignedEnvelope {
  v: 1; type: 'signal' | 'relay'; from: string; to: string; session: string;
  seq: number; at: number; payload: unknown; signature: string;
}
export interface StreamOptions { kind: 'terminal' | 'events' | 'preview-websocket' | string; path: string; body?: unknown; cursor?: number }
export interface ArtifactManifest { id: string; name: string; sha256: string; size: number; mime?: string; [key: string]: unknown }
export type Lane = 'control' | 'events' | 'bulk';
export type Frame = RpcRequest | RpcResponse | StreamEvent
  | { v: 1; type: 'fragment'; id: string; part: number; total: number; data: string }
  | { v: 1; type: 'stream-open'; id: string; options: StreamOptions }
  | { v: 1; type: 'stream-ready'; id: string }
  | { v: 1; type: 'stream-data'; id: string; data: string; binary: boolean; cursor?: number }
  | { v: 1; type: 'stream-close'; id: string; error?: string };
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value).filter(([,v]) => v !== undefined).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
}
export function signedPart(envelope: SignedEnvelope): Omit<SignedEnvelope,'signature'> {
  const { v, type, from, to, session, seq, at, payload } = envelope;
  return { v, type, from, to, session, seq, at, payload };
}
