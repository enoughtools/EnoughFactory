import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from './protocol.js';
export interface Identity { id: string; publicKey: string; privateKey: string }
export function identityId(publicKey: string): string {
  return createHash('sha256').update(createPublicKey(publicKey).export({type:'spki',format:'der'})).digest('hex').slice(0,32);
}
export async function loadIdentity(dataDir: string): Promise<Identity> {
  await mkdir(dataDir,{recursive:true,mode:0o700});
  try { const identity = JSON.parse(await readFile(join(dataDir,'identity.json'),'utf8')) as Identity;
    if (identityId(identity.publicKey) !== identity.id || !verifyValue(identity.publicKey,'test',signValue(identity.privateKey,'test'))) throw new Error('Invalid device identity');
    return identity;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const {publicKey,privateKey} = generateKeyPairSync('ed25519');
  const pem = publicKey.export({type:'spki',format:'pem'}).toString();
  const identity = {id:identityId(pem), publicKey:pem, privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString()};
  await writeFile(join(dataDir,'identity.json'),JSON.stringify(identity),{mode:0o600,flag:'wx'});
  return identity;
}
export async function saveJson(path: string, value: unknown): Promise<void> {
  const temp = path+'.'+randomBytes(6).toString('hex')+'.tmp';
  await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600}); await rename(temp,path);
}
export function signValue(privateKey: string,value: unknown): string { return sign(null,Buffer.from(canonical(value)),privateKey).toString('base64'); }
export function verifyValue(publicKey: string,value: unknown, signature: string): boolean {
  try { return verify(null,Buffer.from(canonical(value)),publicKey,Buffer.from(signature,'base64')); } catch { return false; }
}
export interface Ciphertext { nonce: string; data: string; tag: string }
export function encrypt(key: Buffer, value: unknown, aad: string): Ciphertext {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(aad)); const data = Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return {nonce:nonce.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function decrypt<T>(key: Buffer, value: Ciphertext, aad: string): T {
  const cipher = createDecipheriv('aes-256-gcm',key,Buffer.from(value.nonce,'base64'));
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(Buffer.from(value.tag,'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,'base64')),cipher.final()]).toString()) as T;
}
export function secretKey(secret: string): Buffer { return createHash('sha256').update(secret).digest(); }
