import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface DeviceMetadata {
  deviceId: string;
  publicKey: string;
  name: string;
  platform: string;
  arch: string;
}
export interface Auth extends DeviceMetadata {
  v: 1;
  type: 'auth';
  nonce: string;
  signature: string;
}
export interface Envelope {
  v: 1;
  type: 'signal' | 'relay';
  from: string;
  to: string;
  session: string;
  seq: number;
  at: number;
  payload: Json;
  signature: string;
}
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Recursively sorted JSON is the signed wire representation, not raw message JSON. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  throw new Error('Signed values must contain only JSON values.');
}

export function authPayload(auth: Auth): Omit<Auth, 'signature'> {
  return {
    v: 1, type: 'auth', deviceId: auth.deviceId, publicKey: auth.publicKey,
    name: auth.name, platform: auth.platform, arch: auth.arch, nonce: auth.nonce,
  };
}

export function envelopePayload(envelope: Envelope): Omit<Envelope, 'signature'> {
  return {
    v: 1, type: envelope.type, from: envelope.from, to: envelope.to,
    session: envelope.session, seq: envelope.seq, at: envelope.at, payload: envelope.payload,
  };
}

export function identity(publicKey: string | KeyObject): { key: KeyObject; deviceId: string } {
  const key = typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey;
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Device keys must use Ed25519.');
  const der = key.export({ type: 'spki', format: 'der' });
  return { key, deviceId: createHash('sha256').update(der).digest('hex').slice(0, 32) };
}
