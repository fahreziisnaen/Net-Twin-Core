import { describe, test, expect } from 'vitest';
import {
  base32Encode, base32Decode, totpCode, verifyTotp, timeStep, otpauthUrl,
  generateSecret, generateRecoveryCodes, normalizeCode, hashRecoveryCode,
} from './totp';

// RFC 6238 appendix B, SHA1, key "12345678901234567890". The RFC lists
// 8-digit values; authenticator apps show their last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
  [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
];
const T = 1_700_000_000_000; // 20 s into a 30 s step

describe('TOTP (RFC 6238)', () => {
  test('Base32 round-trips the RFC key and tolerates spaces, dashes, case and padding', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv-gy3tqojq gezdgnbvgy3tqojq====').toString('ascii')).toBe('12345678901234567890');
  });

  test('reproduces the RFC test vectors', () => {
    for (const [seconds, expected] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, seconds * 1000, 8)).toBe(expected);
      expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected.slice(-6));
    }
  });

  test('accepts one step of clock skew each way, not more', () => {
    const code = totpCode(RFC_SECRET, T);
    expect(verifyTotp(RFC_SECRET, code, T)).toBe(timeStep(T));
    expect(verifyTotp(RFC_SECRET, code, T + 29_000)).toBe(timeStep(T));
    expect(verifyTotp(RFC_SECRET, code, T - 29_000)).toBe(timeStep(T));
    expect(verifyTotp(RFC_SECRET, code, T + 61_000)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, T - 61_000)).toBeNull();
  });

  test('never accepts a code whose step was already used', () => {
    const code = totpCode(RFC_SECRET, T);
    const step = verifyTotp(RFC_SECRET, code, T)!;
    expect(verifyTotp(RFC_SECRET, code, T, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, T + 30_000, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, T + 30_000), T + 30_000, step)).toBe(step + 1);
  });

  test('rejects malformed codes', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 345']) expect(verifyTotp(RFC_SECRET, bad, T)).toBeNull();
  });

  test('secrets are fresh 160-bit Base32 strings', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateSecret()).not.toBe(s);
  });

  test('otpauth URI carries issuer, account and parameters', () => {
    expect(otpauthUrl('NetTwin Core', 'admin', 'ABC234'))
      .toBe('otpauth://totp/NetTwin%20Core:admin?secret=ABC234&issuer=NetTwin%20Core&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  test('10 unique xxxx-xxxx codes without look-alike characters', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
  });

  test('typed codes match regardless of case, spaces, dashes and newlines', () => {
    expect(normalizeCode(' AbCd-EfGh \n')).toBe('abcdefgh');
    expect(normalizeCode('123 456\n')).toBe('123456');
    expect(hashRecoveryCode('ABCD EFGH')).toBe(hashRecoveryCode('abcd-efgh'));
    expect(hashRecoveryCode('abcd-efgh')).toMatch(/^[0-9a-f]{64}$/);
  });
});
