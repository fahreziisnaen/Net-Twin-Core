import crypto from 'crypto';

// TOTP (RFC 6238) as used by Google Authenticator and compatible apps:
// HMAC-SHA1, 6 digits, 30-second steps. Secrets travel as Base32 (RFC 4648).

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Accepts what people copy: any case, spaces, dashes and "=" padding.
export function base32Decode(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/[\s=-]/g, '')) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid Base32 character');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const timeStep = (timeMs: number) => Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);

export function totpCode(secret: string, timeMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secret), timeStep(timeMs), digits);
}

// The time step a code belongs to, or null. One step of clock skew is
// accepted either way, and only steps after `lastStep`: a code that was
// already used (or an older one) is never accepted again.
export function verifyTotp(secret: string, code: string, timeMs: number, lastStep = -1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secret);
  const now = timeStep(timeMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = `secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
  return `otpauth://totp/${label}?${params}`;
}

// Recovery codes read well off paper: no 0/o, 1/l/i.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const codes = new Set<string>();
  while (codes.size < count) {
    let s = '';
    for (let i = 0; i < 8; i++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    codes.add(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return [...codes];
}

// What users type: any case, with spaces, dashes or a trailing newline.
export function normalizeCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}
