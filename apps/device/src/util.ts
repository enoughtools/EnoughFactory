import { randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const exec = promisify(execFile);
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomBytes(8).toString('hex')}`;
export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export class HttpError extends Error { constructor(readonly status: number, message: string, readonly code?: string, readonly details?: Record<string, unknown>) { super(message); } }
