import crypto from 'crypto';
import { isWeakSecret } from './secrets';

// AES-256-GCM encryption for device credentials at rest. The master key comes
// from CRED_KEY (env). In production a strong key is mandatory: without one the
// SSH feature stays disabled rather than encrypting with a guessable key.
const IS_PROD = process.env.NODE_ENV === 'production';

function masterKey(): Buffer {
  const secret = process.env.CRED_KEY || (IS_PROD ? '' : 'nettwin-dev-cred-key-change-me');
  if (IS_PROD && isWeakSecret(secret)) throw new Error('CRED_KEY is not set to a strong value');
  // Derive a fixed 32-byte key from the secret.
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

// Blob format: v1.<iv b64>.<tag b64>.<ciphertext b64>
export function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptWithKey(blob: string, key: Buffer): string {
  const parts = String(blob).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported credential cipher version');
  }
  const [, ivB, tagB, ctB] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

// Device credentials use the CRED_KEY master key.
export function encryptSecret(plaintext: string): string {
  return encryptWithKey(plaintext, masterKey());
}

export function decryptSecret(blob: string): string {
  return decryptWithKey(blob, masterKey());
}

// True when a usable key is configured (used to gate the SSH feature cleanly).
export function credKeyConfigured(): boolean {
  return !IS_PROD || !isWeakSecret(process.env.CRED_KEY);
}
