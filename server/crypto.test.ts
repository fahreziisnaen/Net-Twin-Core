import { describe, test, expect, beforeAll } from 'vitest';
import { encryptSecret, decryptSecret, encryptWithKey, decryptWithKey } from './crypto';

beforeAll(() => { process.env.CRED_KEY = 'test-master-key'; });

describe('credential encryption (AES-256-GCM)', () => {
  test('round-trips a secret', () => {
    const plain = 'sup3r-s3cret-p@ss';
    const enc = encryptSecret(plain);
    expect(enc).not.toContain(plain);          // never stored in the clear
    expect(decryptSecret(enc)).toBe(plain);
  });

  test('produces a different ciphertext each time (random IV)', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  test('handles empty and unicode', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('');
    expect(decryptSecret(encryptSecret('sandi-😀-ñ'))).toBe('sandi-😀-ñ');
  });

  test('tampering is detected (auth tag)', () => {
    const enc = encryptSecret('secret');
    const parts = enc.split('.');
    // flip a byte in the ciphertext segment
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString('base64');
    expect(() => decryptSecret(parts.join('.'))).toThrow();
  });

  test('rejects unknown cipher versions', () => {
    expect(() => decryptSecret('v9.aa.bb.cc')).toThrow(/version/i);
  });
});


describe('encryption with an explicit key', () => {
  const key = Buffer.alloc(32, 1);
  test('round-trips and fails with another key', () => {
    const blob = encryptWithKey('JBSWY3DPEHPK3PXP', key);
    expect(blob).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptWithKey(blob, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptWithKey(blob, Buffer.alloc(32, 2))).toThrow();
  });
});
