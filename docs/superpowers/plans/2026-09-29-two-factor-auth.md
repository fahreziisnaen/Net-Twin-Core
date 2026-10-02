# 2FA Google Authenticator (TOTP) — Rencana Implementasi

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Setiap user bisa mengaktifkan 2FA berbasis aplikasi authenticator; akun ber-2FA hanya bisa login dengan password + kode 6 digit (atau kode cadangan).

**Architecture:** Algoritma TOTP murni di `server/totp.ts`; logika 2FA (daftar, verifikasi, matikan, reset) di layanan `server/twoFactor.ts` yang hanya bergantung pada `Storage` dan fungsi kunci, sehingga bisa diuji tanpa HTTP. `server.ts` hanya menambah rute tipis. Login dua langkah memakai token "challenge" 5 menit (`typ: "2fa"`) yang tidak bisa dipakai sebagai sesi. Frontend: langkah kode di `LoginView`, kartu baru `TwoFactorCard` di Settings, serta tanda & tombol reset di tabel user.

**Tech Stack:** Node 22 `crypto` (HMAC-SHA1, AES-256-GCM, SHA-256), Express 4, jsonwebtoken, mysql2, React 19, Vite, Vitest, paket `qrcode` (frontend saja).

**Spec:** `docs/superpowers/specs/2026-09-29-two-factor-auth-design.md`

## Global Constraints

- 2FA **opsional per user**; tidak ada kewajiban per role.
- TOTP: HMAC-SHA1, **6 digit**, periode **30 detik**, toleransi **±1 periode**, secret **20 byte** acak dikodekan **Base32**.
- URI: `otpauth://totp/NetTwin%20Core:<username>?secret=<BASE32>&issuer=NetTwin%20Core&algorithm=SHA1&digits=6&period=30`.
- Kode yang sudah dipakai tidak boleh diterima lagi (`lastStep`).
- Kode cadangan: **10** buah, format `xxxx-xxxx`, huruf kecil + angka tanpa `0/o/1/l/i`, disimpan **SHA-256**, sekali pakai; input diterima tanpa peduli huruf besar/kecil, spasi, atau `-`.
- Challenge: JWT HS256 kunci `JWT_SECRET`, umur **5 menit**, `typ: "2fa"`; token sesi membawa `typ: "session"`; token sesi lama tanpa `typ` tetap diterima.
- Kode salah dihitung ke batas login yang sama: **10 kegagalan per IP per 15 menit**.
- MySQL: tabel **baru** `user_two_factor` (FK ke `users(id)` `ON DELETE CASCADE`); tabel `users` **tidak diubah**. Mode file: `data/two-factor.json`.
- Secret TOTP dienkripsi AES-256-GCM dengan kunci turunan `JWT_SECRET`.
- **Tidak ada dependency runtime server baru**; QR dibuat di browser dengan `qrcode` (devDependency, dibundel Vite).
- Teks UI tersedia dalam Inggris dan Indonesia (`src/i18n.tsx`); pesan error server berbahasa Inggris seperti yang lain.
- Semua konfirmasi memakai modal in-app (`useDialog`); `alert/confirm/prompt` bawaan dilarang (dijaga `src/noNativeDialogs.test.ts`).
- **Jangan commit** — user yang melakukan commit.

## Review Focus

1. Kode diketik dengan spasi (`123 456`), ditempel dengan baris baru, atau kode cadangan dalam huruf besar → harus diterima. (Task 1 `normalizeCode`, Task 4 verifikasi `"123 456"`.)
2. Tombol Verifikasi diklik dua kali sehingga kode yang sama terkirim bersamaan → tepat satu yang berhasil. (Task 4, test paralel.)
3. User memindai QR lalu meninggalkan pendaftaran (status *pending*) → login tetap cukup dengan password. (Task 4 `isEnabled` saat pending; Task 5 smoke.)
4. User ber-2FA dihapus lalu dibuat user baru yang mendapat id yang sama → tidak mewarisi 2FA. (Task 3 FileStorage `deleteUser`, DDL MySQL `ON DELETE CASCADE`.)
5. Cookie sesi dari sebelum upgrade (tanpa `typ`) → tetap login, tidak ter-logout. (Task 2.)

---

### Task 1: Primitif TOTP & kode cadangan

**Files:**
- Create: `server/totp.ts`
- Test: `server/totp.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `base32Encode(data: Buffer): string`, `base32Decode(input: string): Buffer`
  - `generateSecret(): string`
  - `hotp(key: Buffer, counter: number, digits?: number): string`
  - `timeStep(timeMs: number): number`
  - `totpCode(secret: string, timeMs: number, digits?: number): string`
  - `verifyTotp(secret: string, code: string, timeMs: number, lastStep?: number): number | null` (mengembalikan time step yang cocok)
  - `otpauthUrl(issuer: string, account: string, secret: string): string`
  - `generateRecoveryCodes(count?: number): string[]`, `normalizeCode(input: string): string`, `hashRecoveryCode(code: string): string`

- [ ] **Step 1: Tulis test yang gagal** — `server/totp.test.ts`

```ts
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
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/totp.test.ts`
Expected: FAIL — `Failed to resolve import "./totp"`.

- [ ] **Step 3: Implementasi** — `server/totp.ts`

```ts
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
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/totp.test.ts`
Expected: PASS (9 test).

---

### Task 2: Enkripsi dengan kunci turunan & token login dua langkah

**Files:**
- Modify: `server/crypto.ts` (fungsi `encryptSecret`/`decryptSecret`)
- Modify: `server/auth.ts` (`signToken`, `verifyToken`, tambah `deriveKey`, `signChallenge`, `resolveChallenge`)
- Test: `server/crypto.test.ts`, `server/auth.test.ts`

**Interfaces:**
- Consumes: `Storage.getUserById`, `UserRecord` (sudah ada)
- Produces:
  - `encryptWithKey(plaintext: string, key: Buffer): string`, `decryptWithKey(blob: string, key: Buffer): string` (dari `server/crypto.ts`)
  - `deriveKey(purpose: string): Buffer` (32 byte)
  - `signChallenge(user: UserRecord): string`
  - `resolveChallenge(storage: Storage, token: string): Promise<UserRecord | null>`

- [ ] **Step 1: Tulis test yang gagal**

Tambahkan di akhir `server/crypto.test.ts`:

```ts
import { encryptWithKey, decryptWithKey } from './crypto';

describe('encryption with an explicit key', () => {
  const key = Buffer.alloc(32, 1);
  test('round-trips and fails with another key', () => {
    const blob = encryptWithKey('JBSWY3DPEHPK3PXP', key);
    expect(blob).not.toContain('JBSWY3DPEHPK3PXP');
    expect(decryptWithKey(blob, key)).toBe('JBSWY3DPEHPK3PXP');
    expect(() => decryptWithKey(blob, Buffer.alloc(32, 2))).toThrow();
  });
});
```

Tambahkan di akhir `server/auth.test.ts` (dan perluas import di baris atas menjadi
`import { authenticate, signToken, verifyLogin, AuthedRequest, signChallenge, resolveChallenge, deriveKey } from './auth';`
serta `import jwt from 'jsonwebtoken';`):

```ts
describe('two-step login tokens', () => {
  test('a 2FA challenge is not a session', async () => {
    expect((await run(storageWith([alice]), signChallenge(alice))).user).toBeUndefined();
  });

  test('a session token is not a challenge', async () => {
    expect(await resolveChallenge(storageWith([alice]), signToken(alice))).toBeNull();
  });

  test('a challenge resolves to its user', async () => {
    expect((await resolveChallenge(storageWith([alice]), signChallenge(alice)))?.username).toBe('alice');
  });

  test('a challenge dies with a password change', async () => {
    const changed = { ...alice, passwordHash: bcrypt.hashSync('secret-2', 4) };
    expect(await resolveChallenge(storageWith([changed]), signChallenge(alice))).toBeNull();
  });

  test('garbage is not a challenge', async () => {
    expect(await resolveChallenge(storageWith([alice]), 'x.y.z')).toBeNull();
  });

  test('sessions issued before the upgrade (no typ claim) still work', async () => {
    const { pv } = jwt.decode(signToken(alice)) as { pv: string };
    const legacy = jwt.sign({ sub: '7', pv }, process.env.JWT_SECRET || 'nettwin-dev-secret-change-me', { algorithm: 'HS256', expiresIn: 60 });
    expect((await run(storageWith([alice]), legacy)).user?.username).toBe('alice');
  });

  test('derived keys are 32 bytes and differ per purpose', () => {
    expect(deriveKey('a')).toHaveLength(32);
    expect(deriveKey('a').equals(deriveKey('a'))).toBe(true);
    expect(deriveKey('a').equals(deriveKey('b'))).toBe(false);
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/crypto.test.ts server/auth.test.ts`
Expected: FAIL — `encryptWithKey` / `signChallenge` bukan export.

- [ ] **Step 3: Implementasi**

`server/crypto.ts` — ganti `encryptSecret` dan `decryptSecret` dengan:

```ts
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
```

`server/auth.ts`:

1. Ganti `signToken` dan `verifyToken`:

```ts
export function signToken(user: UserRecord): string {
  return jwt.sign(
    { sub: String(user.id), pv: passwordStamp(user.passwordHash), typ: 'session' },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL_SECONDS, algorithm: 'HS256' }
  );
}

// Session tokens only: a 2FA login challenge must never pass as a session.
// Tokens from before the `typ` claim existed count as sessions.
export function verifyToken(token: string): { id: number; pv: string } | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload.typ !== undefined && payload.typ !== 'session') return null;
    const id = parseInt(String(payload.sub), 10);
    if (!Number.isInteger(id) || typeof payload.pv !== 'string') return null;
    return { id, pv: payload.pv };
  } catch {
    return null;
  }
}
```

2. Tambahkan setelah `verifyToken`:

```ts
// Keys for other secrets kept at rest (e.g. 2FA seeds), one per purpose,
// derived from JWT_SECRET so no extra configuration is needed.
export function deriveKey(purpose: string): Buffer {
  return crypto.createHash('sha256').update(`${purpose}\0${JWT_SECRET}`).digest();
}

// After the password step of an account with 2FA: proves the password was
// right, for 5 minutes, and is only accepted by the second login step.
const CHALLENGE_TTL_SECONDS = 5 * 60;

export function signChallenge(user: UserRecord): string {
  return jwt.sign(
    { sub: String(user.id), pv: passwordStamp(user.passwordHash), typ: '2fa' },
    JWT_SECRET,
    { expiresIn: CHALLENGE_TTL_SECONDS, algorithm: 'HS256' }
  );
}

// The user a login challenge belongs to — null when it is invalid, expired,
// not a challenge, or the password changed since it was issued.
export async function resolveChallenge(storage: Storage, token: string): Promise<UserRecord | null> {
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload.typ !== '2fa') return null;
    const id = parseInt(String(payload.sub), 10);
    if (!Number.isInteger(id)) return null;
    const user = await storage.getUserById(id);
    return user && passwordStamp(user.passwordHash) === payload.pv ? user : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/crypto.test.ts server/auth.test.ts`
Expected: PASS.

---

### Task 3: Penyimpanan 2FA (MySQL & file)

**Files:**
- Modify: `server/storage.ts`
- Test: `server/storage.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `interface TwoFactorRecord { secretEnc: string; enabled: boolean; recoveryHashes: string[]; lastStep: number }`
  - Pada `Storage`: `getTwoFactor(userId: number): Promise<TwoFactorRecord | null>`, `saveTwoFactor(userId: number, record: TwoFactorRecord | null): Promise<void>`, `listTwoFactorEnabled(): Promise<number[]>`

- [ ] **Step 1: Tulis test yang gagal**

Di `server/storage.test.ts`, ubah import menjadi
`import { FileStorage, MySqlStorage, TwinState, TwoFactorRecord } from './storage';`,
lalu tambahkan di dalam `describe('FileStorage', ...)`:

```ts
  const rec = (enabled: boolean): TwoFactorRecord => ({ secretEnc: 'v1.a.b.c', enabled, recoveryHashes: ['h1'], lastStep: 5 });

  test('two-factor records round-trip and enabled users are listed', async () => {
    const { storage } = tempStorage();
    await storage.init();
    await storage.saveTwoFactor(1, rec(true));
    await storage.saveTwoFactor(2, rec(false));
    expect(await storage.getTwoFactor(1)).toEqual(rec(true));
    expect(await storage.getTwoFactor(3)).toBeNull();
    expect(await storage.listTwoFactorEnabled()).toEqual([1]);
    await storage.saveTwoFactor(1, null);
    expect(await storage.getTwoFactor(1)).toBeNull();
  });

  test('a deleted user does not pass 2FA on to a new user with the same id', async () => {
    const { storage } = tempStorage();
    await storage.init();
    const first = await storage.createUser('alice', 'hash', 'viewer');
    await storage.saveTwoFactor(first.id, rec(true));
    await storage.deleteUser(first.id);
    const second = await storage.createUser('bob', 'hash', 'viewer');
    expect(second.id).toBe(first.id);
    expect(await storage.getTwoFactor(second.id)).toBeNull();
  });
```

Tambahkan blok baru di akhir file:

```ts
describe('MySqlStorage two-factor', () => {
  // Fake pool: records every query, answers from canned rows keyed by SQL fragment.
  function recordingPool(rows: Record<string, unknown[]> = {}) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        const key = Object.keys(rows).find(k => sql.includes(k));
        return [key ? rows[key] : []];
      },
      getConnection: async () => ({ release() {} }),
    };
    return { calls, pool };
  }
  const withPool = (rows?: Record<string, unknown[]>) => {
    const storage = new MySqlStorage();
    const fake = recordingPool(rows);
    (storage as any).pool = fake.pool;
    return { storage, calls: fake.calls };
  };
  const rec: TwoFactorRecord = { secretEnc: 'v1.a.b.c', enabled: true, recoveryHashes: ['h1'], lastStep: 7 };

  test('init creates the table with a cascading foreign key, leaving users untouched', async () => {
    const { storage, calls } = withPool();
    await storage.init();
    const ddl = calls.map(c => c.sql).find(sql => sql.includes('user_two_factor'))!;
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS user_two_factor/);
    expect(ddl).toMatch(/REFERENCES users\(id\) ON DELETE CASCADE/);
    expect(calls.some(c => /ALTER TABLE users/i.test(c.sql))).toBe(false);
  });

  test('save writes JSON, null deletes, get parses string columns', async () => {
    const { storage, calls } = withPool({ 'FROM user_two_factor WHERE': [{ data: JSON.stringify(rec) }] });
    await storage.saveTwoFactor(3, rec);
    expect(calls.at(-1)!.sql).toMatch(/REPLACE INTO user_two_factor/);
    expect(calls.at(-1)!.params).toEqual([3, JSON.stringify(rec)]);
    await storage.saveTwoFactor(3, null);
    expect(calls.at(-1)!.sql).toMatch(/DELETE FROM user_two_factor WHERE user_id = \?/);
    expect(await storage.getTwoFactor(3)).toEqual(rec);
  });

  test('lists only users with 2FA enabled', async () => {
    const { storage } = withPool({
      'SELECT user_id, data FROM user_two_factor': [
        { user_id: 1, data: rec },
        { user_id: 2, data: JSON.stringify({ ...rec, enabled: false }) },
      ],
    });
    expect(await storage.listTwoFactorEnabled()).toEqual([1]);
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/storage.test.ts`
Expected: FAIL — `saveTwoFactor is not a function` / `TwoFactorRecord` tidak ada.

- [ ] **Step 3: Implementasi** — `server/storage.ts`

1. Setelah `interface UserRecord`, tambahkan:

```ts
// Per-user 2FA state; server/twoFactor.ts owns its meaning.
export interface TwoFactorRecord {
  secretEnc: string;        // TOTP secret, AES-256-GCM encrypted
  enabled: boolean;         // false while enrollment awaits its first code
  recoveryHashes: string[]; // SHA-256 of the unused recovery codes
  lastStep: number;         // last accepted TOTP time step (replay guard)
}
```

2. Di `interface Storage`, setelah `deleteUser`, tambahkan:

```ts
  getTwoFactor(userId: number): Promise<TwoFactorRecord | null>;
  saveTwoFactor(userId: number, record: TwoFactorRecord | null): Promise<void>;
  listTwoFactorEnabled(): Promise<number[]>;
```

3. `FileStorage`: tambahkan field `private twoFactorFile = path.join(this.dataDir, 'two-factor.json');` di bawah `connectionsFile`, ganti `deleteUser`, dan tambahkan metode 2FA:

```ts
  async deleteUser(id: number): Promise<void> {
    this.writeUsers(this.readUsers().filter(u => u.id !== id));
    // Ids are reused (max + 1), so a later user must not inherit this 2FA.
    await this.saveTwoFactor(id, null);
  }

  private readTwoFactor(): Record<string, TwoFactorRecord> {
    const raw = readJsonFile(this.twoFactorFile);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, TwoFactorRecord>) : {};
  }

  async getTwoFactor(userId: number): Promise<TwoFactorRecord | null> {
    const all = this.readTwoFactor();
    return Object.prototype.hasOwnProperty.call(all, String(userId)) ? all[String(userId)] : null;
  }

  async saveTwoFactor(userId: number, record: TwoFactorRecord | null): Promise<void> {
    const all = this.readTwoFactor();
    if (record) all[String(userId)] = record;
    else delete all[String(userId)];
    writeJsonAtomic(this.twoFactorFile, all);
  }

  async listTwoFactorEnabled(): Promise<number[]> {
    return Object.entries(this.readTwoFactor()).filter(([, r]) => r.enabled).map(([id]) => Number(id));
  }
```

4. `MySqlStorage.init()`: tambahkan statement terakhir di array `ddl`:

```ts
      // Separate table so upgrading a live database never alters `users`.
      `CREATE TABLE IF NOT EXISTS user_two_factor (
        user_id INT PRIMARY KEY,
        data JSON NOT NULL,
        CONSTRAINT fk_user_two_factor_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
```

5. `MySqlStorage`: tambahkan setelah `deleteUser`:

```ts
  async getTwoFactor(userId: number): Promise<TwoFactorRecord | null> {
    const [rows] = await this.pool.query('SELECT data FROM user_two_factor WHERE user_id = ?', [userId]);
    const row = (rows as { data: unknown }[])[0];
    return row ? MySqlStorage.parseData<TwoFactorRecord>(row.data) : null;
  }

  async saveTwoFactor(userId: number, record: TwoFactorRecord | null): Promise<void> {
    if (!record) {
      await this.pool.query('DELETE FROM user_two_factor WHERE user_id = ?', [userId]);
      return;
    }
    await this.pool.query('REPLACE INTO user_two_factor (user_id, data) VALUES (?, ?)', [userId, JSON.stringify(record)]);
  }

  async listTwoFactorEnabled(): Promise<number[]> {
    const [rows] = await this.pool.query('SELECT user_id, data FROM user_two_factor');
    return (rows as { user_id: number; data: unknown }[])
      .filter(r => MySqlStorage.parseData<TwoFactorRecord>(r.data).enabled)
      .map(r => r.user_id);
  }
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/storage.test.ts && npx tsc --noEmit`
Expected: PASS; tsc 0 error.

---

### Task 4: Layanan 2FA

**Files:**
- Create: `server/twoFactor.ts`
- Test: `server/twoFactor.test.ts`

**Interfaces:**
- Consumes: `Storage`/`TwoFactorRecord` (Task 3); `encryptWithKey`/`decryptWithKey` (Task 2); semua fungsi `server/totp.ts` (Task 1)
- Produces:
  - `class TwoFactorError extends Error { status: number }`
  - `createTwoFactorService(storage: Storage, key: () => Buffer, now?: () => number)` → objek dengan:
    `status(userId): Promise<{ enabled; pending; recoveryCodesLeft }>`, `isEnabled(userId): Promise<boolean>`,
    `setup(userId, username): Promise<{ secret; otpauthUrl }>`, `enable(userId, code): Promise<string[]>`,
    `verify(userId, code): Promise<{ ok; usedRecoveryCode?; recoveryCodesLeft?; unreadableSecret? }>`,
    `disable(userId, code): Promise<boolean>`, `reset(userId): Promise<void>`, `enabledUserIds(): Promise<Set<number>>`
  - `type TwoFactorService = ReturnType<typeof createTwoFactorService>`

- [ ] **Step 1: Tulis test yang gagal** — `server/twoFactor.test.ts`

```ts
import { describe, test, expect } from 'vitest';
import { createTwoFactorService, TwoFactorError } from './twoFactor';
import { Storage, TwoFactorRecord } from './storage';
import { totpCode } from './totp';

function memoryStorage() {
  const records = new Map<number, TwoFactorRecord>();
  const storage = {
    getTwoFactor: async (id: number) => (records.has(id) ? structuredClone(records.get(id)!) : null),
    saveTwoFactor: async (id: number, rec: TwoFactorRecord | null) => { if (rec) records.set(id, structuredClone(rec)); else records.delete(id); },
    listTwoFactorEnabled: async () => [...records].filter(([, r]) => r.enabled).map(([id]) => id),
  } as unknown as Storage;
  return { storage, records };
}

// Each test gets its own clock so replay protection can be exercised step by step.
function setupService(key = Buffer.alloc(32, 7)) {
  const clock = { now: 1_700_000_000_000 };
  const mem = memoryStorage();
  const svc = createTwoFactorService(mem.storage, () => key, () => clock.now);
  return { svc, clock, ...mem };
}

async function enrolled() {
  const env = setupService();
  const { secret } = await env.svc.setup(1, 'alice');
  const codes = await env.svc.enable(1, totpCode(secret, env.clock.now));
  env.clock.now += 30_000; // next step, so login codes differ from the enrollment code
  return { ...env, secret, codes };
}

describe('enrollment', () => {
  test('setup is pending until confirmed, and pending does not require a code at login', async () => {
    const { svc } = setupService();
    const { otpauthUrl } = await svc.setup(1, 'alice');
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/NetTwin%20Core:alice\?secret=[A-Z2-7]{32}&issuer=NetTwin%20Core/);
    expect(await svc.status(1)).toEqual({ enabled: false, pending: true, recoveryCodesLeft: 0 });
    expect(await svc.isEnabled(1)).toBe(false);
  });

  test('the secret is stored encrypted', async () => {
    const { svc, records } = setupService();
    const { secret } = await svc.setup(1, 'alice');
    expect(records.get(1)!.secretEnc).not.toContain(secret);
  });

  test('a wrong first code is refused; the right one enables and yields 10 recovery codes', async () => {
    const { svc, clock } = setupService();
    const { secret } = await svc.setup(1, 'alice');
    await expect(svc.enable(1, '000000')).rejects.toMatchObject({ status: 401 });
    const codes = await svc.enable(1, totpCode(secret, clock.now));
    expect(codes).toHaveLength(10);
    expect(await svc.status(1)).toEqual({ enabled: true, pending: false, recoveryCodesLeft: 10 });
  });

  test('setup is refused while 2FA is on; enable without setup is refused', async () => {
    const { svc } = await enrolled();
    await expect(svc.setup(1, 'alice')).rejects.toBeInstanceOf(TwoFactorError);
    await expect(svc.setup(1, 'alice')).rejects.toMatchObject({ status: 409 });
    await expect(svc.enable(2, '123456')).rejects.toMatchObject({ status: 400 });
  });
});

describe('verification at login', () => {
  test('a current code works once', async () => {
    const { svc, secret, clock } = await enrolled();
    const code = totpCode(secret, clock.now);
    expect(await svc.verify(1, code)).toEqual({ ok: true });
    expect(await svc.verify(1, code)).toEqual({ ok: false });
  });

  test('codes typed with a space or newline are accepted', async () => {
    const { svc, secret, clock } = await enrolled();
    const code = totpCode(secret, clock.now);
    expect((await svc.verify(1, `${code.slice(0, 3)} ${code.slice(3)}\n`)).ok).toBe(true);
  });

  test('the same code submitted twice at once succeeds only once', async () => {
    const { svc, secret, clock } = await enrolled();
    const code = totpCode(secret, clock.now);
    const results = await Promise.all([svc.verify(1, code), svc.verify(1, code)]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
  });

  test('a recovery code works once, in any case, and is counted down', async () => {
    const { svc, codes } = await enrolled();
    expect(await svc.verify(1, codes[0].toUpperCase())).toEqual({ ok: true, usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect((await svc.verify(1, codes[0])).ok).toBe(false);
    expect((await svc.status(1)).recoveryCodesLeft).toBe(9);
  });

  test('users without 2FA never verify', async () => {
    const { svc } = setupService();
    expect(await svc.verify(5, '123456')).toEqual({ ok: false });
  });

  test('when the secret can no longer be decrypted, TOTP says so but recovery codes still work', async () => {
    const { secret, clock, codes, storage } = await enrolled();
    const rekeyed = createTwoFactorService(storage, () => Buffer.alloc(32, 9), () => clock.now);
    expect(await rekeyed.verify(1, totpCode(secret, clock.now))).toEqual({ ok: false, unreadableSecret: true });
    expect((await rekeyed.verify(1, codes[1])).ok).toBe(true);
  });
});

describe('turning 2FA off', () => {
  test('disable needs a valid code', async () => {
    const { svc, codes } = await enrolled();
    expect(await svc.disable(1, '000000')).toBe(false);
    expect(await svc.isEnabled(1)).toBe(true);
    expect(await svc.disable(1, codes[0])).toBe(true);
    expect(await svc.status(1)).toEqual({ enabled: false, pending: false, recoveryCodesLeft: 0 });
  });

  test('admin reset removes 2FA without a code; enabled users are listed', async () => {
    const { svc } = await enrolled();
    expect(await svc.enabledUserIds()).toEqual(new Set([1]));
    await svc.reset(1);
    expect(await svc.isEnabled(1)).toBe(false);
    expect(await svc.enabledUserIds()).toEqual(new Set());
  });
});
```

- [ ] **Step 2: Jalankan, pastikan gagal**

Run: `npx vitest run server/twoFactor.test.ts`
Expected: FAIL — `Failed to resolve import "./twoFactor"`.

- [ ] **Step 3: Implementasi** — `server/twoFactor.ts`

```ts
import { Storage } from './storage';
import { encryptWithKey, decryptWithKey } from './crypto';
import {
  generateSecret, verifyTotp, otpauthUrl, generateRecoveryCodes, hashRecoveryCode, normalizeCode,
} from './totp';

export const TOTP_ISSUER = 'NetTwin Core';
export const RECOVERY_CODE_COUNT = 10;

// Carries the HTTP status the API answers with.
export class TwoFactorError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface TwoFactorStatus {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
}

export interface VerifyResult {
  ok: boolean;
  usedRecoveryCode?: boolean;
  recoveryCodesLeft?: number;
  unreadableSecret?: boolean; // the TOTP secret can't be decrypted (JWT_SECRET changed)
}

// 2FA for one account at a time. `key` supplies the at-rest encryption key;
// `now` is injectable for tests.
export function createTwoFactorService(storage: Storage, key: () => Buffer, now: () => number = Date.now) {
  // One operation per user at a time: the same code (or recovery code)
  // submitted twice in parallel can only succeed once.
  const locks = new Map<number, Promise<unknown>>();
  function exclusive<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const run = (locks.get(userId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(userId, tail);
    void tail.then(() => {
      if (locks.get(userId) === tail) locks.delete(userId);
    });
    return run;
  }

  async function status(userId: number): Promise<TwoFactorStatus> {
    const rec = await storage.getTwoFactor(userId);
    return {
      enabled: !!rec?.enabled,
      pending: !!rec && !rec.enabled,
      recoveryCodesLeft: rec?.enabled ? rec.recoveryHashes.length : 0,
    };
  }

  // Pending enrollments don't count: login stays password-only until confirmed.
  async function isEnabled(userId: number): Promise<boolean> {
    return !!(await storage.getTwoFactor(userId))?.enabled;
  }

  // Start (or restart) enrollment with a fresh secret, pending until confirmed.
  function setup(userId: number, username: string): Promise<{ secret: string; otpauthUrl: string }> {
    return exclusive(userId, async () => {
      if (await isEnabled(userId)) {
        throw new TwoFactorError(409, 'Two-factor authentication is already on. Turn it off first to enroll again.');
      }
      const secret = generateSecret();
      await storage.saveTwoFactor(userId, { secretEnc: encryptWithKey(secret, key()), enabled: false, recoveryHashes: [], lastStep: -1 });
      return { secret, otpauthUrl: otpauthUrl(TOTP_ISSUER, username, secret) };
    });
  }

  // Confirm enrollment with a first code. Returns the recovery codes, which
  // exist only in this response (they are stored hashed).
  function enable(userId: number, code: string): Promise<string[]> {
    return exclusive(userId, async () => {
      const rec = await storage.getTwoFactor(userId);
      if (!rec || rec.enabled) throw new TwoFactorError(400, 'Start two-factor setup first.');
      let secret: string;
      try {
        secret = decryptWithKey(rec.secretEnc, key());
      } catch {
        throw new TwoFactorError(400, 'Two-factor setup expired. Start again.');
      }
      const step = verifyTotp(secret, normalizeCode(code), now(), rec.lastStep);
      if (step === null) throw new TwoFactorError(401, 'Invalid code. Check that the time on your phone is correct and enter the current code.');
      const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
      await storage.saveTwoFactor(userId, { ...rec, enabled: true, lastStep: step, recoveryHashes: recoveryCodes.map(hashRecoveryCode) });
      return recoveryCodes;
    });
  }

  // A login code: the current authenticator code, or a recovery code (used up).
  function verify(userId: number, code: string): Promise<VerifyResult> {
    return exclusive(userId, async () => {
      const rec = await storage.getTwoFactor(userId);
      if (!rec?.enabled) return { ok: false };
      const input = normalizeCode(code);
      if (/^\d{6}$/.test(input)) {
        let secret: string;
        try {
          secret = decryptWithKey(rec.secretEnc, key());
        } catch {
          return { ok: false, unreadableSecret: true };
        }
        const step = verifyTotp(secret, input, now(), rec.lastStep);
        if (step === null) return { ok: false };
        await storage.saveTwoFactor(userId, { ...rec, lastStep: step });
        return { ok: true };
      }
      const hash = hashRecoveryCode(input);
      if (!rec.recoveryHashes.includes(hash)) return { ok: false };
      const recoveryHashes = rec.recoveryHashes.filter(h => h !== hash);
      await storage.saveTwoFactor(userId, { ...rec, recoveryHashes });
      return { ok: true, usedRecoveryCode: true, recoveryCodesLeft: recoveryHashes.length };
    });
  }

  // Turn 2FA off after proving possession of the authenticator or a recovery code.
  async function disable(userId: number, code: string): Promise<boolean> {
    if (!(await verify(userId, code)).ok) return false;
    await exclusive(userId, () => storage.saveTwoFactor(userId, null));
    return true;
  }

  // Admin reset for a lost phone: no code needed.
  function reset(userId: number): Promise<void> {
    return exclusive(userId, () => storage.saveTwoFactor(userId, null));
  }

  async function enabledUserIds(): Promise<Set<number>> {
    return new Set(await storage.listTwoFactorEnabled());
  }

  return { status, isEnabled, setup, enable, verify, disable, reset, enabledUserIds };
}

export type TwoFactorService = ReturnType<typeof createTwoFactorService>;
```

- [ ] **Step 4: Jalankan, pastikan lulus**

Run: `npx vitest run server/twoFactor.test.ts && npx tsc --noEmit`
Expected: PASS (12 test); tsc 0 error.

---

### Task 5: Rute HTTP

**Files:**
- Modify: `server.ts`

**Interfaces:**
- Consumes: `signChallenge`, `resolveChallenge`, `deriveKey` (Task 2); `createTwoFactorService`, `TwoFactorError` (Task 4); `UserRecord` (storage)
- Produces (kontrak untuk Task 6–7):
  - `POST /api/auth/login` → akun ber-2FA: `200 { twoFactorRequired: true, challenge }` tanpa cookie
  - `POST /api/auth/login/2fa { challenge, code }` → `200 { user, recoveryCodesLeft? }` + cookie; `401 { error, restart? }`; `429`
  - `GET /api/auth/2fa` → `{ enabled, pending, recoveryCodesLeft }`
  - `POST /api/auth/2fa/setup { password }` → `{ secret, otpauthUrl }`; `401` password salah; `409` sudah aktif
  - `POST /api/auth/2fa/enable { code }` → `{ recoveryCodes }`; `401` kode salah
  - `POST /api/auth/2fa/disable { password, code }` → `{ success }`; `401`
  - `GET /api/users` → tiap user `{ id, username, role, twoFactorEnabled }`
  - `DELETE /api/users/:id/2fa` → `{ success }`; `400` diri sendiri; `404`

- [ ] **Step 1: Import & layanan**

Perluas import dari `./server/auth` dengan `signChallenge, resolveChallenge, deriveKey,`. Tambahkan:

```ts
import { createTwoFactorService, TwoFactorError } from './server/twoFactor';
```

Ubah `import { createStorage, TwinState } from './server/storage';` menjadi `import { createStorage, TwinState, UserRecord } from './server/storage';`.

Tepat setelah `const storage = createStorage();` tambahkan:

```ts
// Two-factor authentication; TOTP secrets are encrypted with a key derived from JWT_SECRET.
const twoFactor = createTwoFactorService(storage, () => deriveKey('nettwin-totp'));
```

- [ ] **Step 2: Login dua langkah**

Di rute `POST /api/auth/login`, ganti baris `loginAttempts.delete(ip);` dan setelahnya (sampai akhir handler) dengan:

```ts
  // Password is right; with 2FA on, the session waits for the second step.
  if (await twoFactor.isEnabled(user.id)) {
    return res.json({ twoFactorRequired: true, challenge: signChallenge(user) });
  }
  loginAttempts.delete(ip);
  res.cookie(AUTH_COOKIE, signToken(user), authCookieOptions(req));
  res.json({ user: { id: user.id, username: user.username, role: user.role } });
}));
```

Tambahkan setelah rute `GET /api/auth/me`:

```ts
// Second login step for accounts with 2FA. Wrong codes count toward the same
// per-IP limit as wrong passwords.
app.post('/api/auth/login/2fa', asyncRoute(async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (loginBlocked(ip)) {
    return res.status(429).json({ error: 'Too many failed login attempts. Try again in a few minutes.' });
  }
  const { challenge, code } = req.body || {};
  if (typeof challenge !== 'string' || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ error: 'challenge and code are required' });
  }
  const user = await resolveChallenge(storage, challenge);
  if (!user) return res.status(401).json({ error: 'Sign-in expired. Enter your password again.', restart: true });
  const result = await twoFactor.verify(user.id, code);
  if (!result.ok) {
    noteLoginFailure(ip);
    return res.status(401).json({
      error: result.unreadableSecret
        ? 'This authenticator can no longer be verified because the server key changed. Use a recovery code, or ask an admin to reset two-factor authentication.'
        : 'Invalid code.',
    });
  }
  loginAttempts.delete(ip);
  if (result.usedRecoveryCode) {
    console.log(`[AUDIT] 2FA recovery code used by "${user.username}" (${result.recoveryCodesLeft} left)`);
  }
  res.cookie(AUTH_COOKIE, signToken(user), authCookieOptions(req));
  res.json({
    user: { id: user.id, username: user.username, role: user.role },
    ...(result.usedRecoveryCode ? { recoveryCodesLeft: result.recoveryCodesLeft } : {}),
  });
}));

// ---- Account security: the signed-in user's own 2FA -----------------------

// Re-check the signed-in user's password before a 2FA change. Wrong
// passwords count toward the login limit like any other guess.
async function confirmPassword(req: AuthedRequest, res: Response): Promise<UserRecord | null> {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (loginBlocked(ip)) {
    res.status(429).json({ error: 'Too many failed login attempts. Try again in a few minutes.' });
    return null;
  }
  const password = req.body?.password;
  const user = await storage.getUserById(req.user!.id);
  if (typeof password !== 'string' || !user || !(await verifyLogin(user, password))) {
    noteLoginFailure(ip);
    res.status(401).json({ error: 'Incorrect password.' });
    return null;
  }
  return user;
}

app.get('/api/auth/2fa', requireAction('read'), asyncRoute(async (req, res) => {
  res.json(await twoFactor.status(req.user!.id));
}));

app.post('/api/auth/2fa/setup', requireAction('read'), asyncRoute(async (req, res) => {
  const user = await confirmPassword(req, res);
  if (!user) return;
  res.json(await twoFactor.setup(user.id, user.username));
}));

app.post('/api/auth/2fa/enable', requireAction('read'), asyncRoute(async (req, res) => {
  const code = req.body?.code;
  if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ error: 'code is required' });
  const recoveryCodes = await twoFactor.enable(req.user!.id, code);
  console.log(`[AUDIT] 2FA enabled by "${req.user!.username}"`);
  res.json({ recoveryCodes });
}));

app.post('/api/auth/2fa/disable', requireAction('read'), asyncRoute(async (req, res) => {
  const user = await confirmPassword(req, res);
  if (!user) return;
  const code = req.body?.code;
  if (typeof code !== 'string' || !(await twoFactor.disable(user.id, code))) {
    noteLoginFailure(req.ip || req.socket.remoteAddress || 'unknown');
    return res.status(401).json({ error: 'Invalid code.' });
  }
  console.log(`[AUDIT] 2FA disabled by "${user.username}"`);
  res.json({ success: true });
}));
```

- [ ] **Step 3: Admin — daftar & reset**

Ganti handler `GET /api/users` dengan:

```ts
app.get('/api/users', requireAction('manage-users'), asyncRoute(async (req, res) => {
  const [users, withTwoFactor] = await Promise.all([storage.listUsers(), twoFactor.enabledUserIds()]);
  res.json(users.map(u => ({ id: u.id, username: u.username, role: u.role, twoFactorEnabled: withTwoFactor.has(u.id) })));
}));
```

Tambahkan setelah rute `DELETE /api/users/:id`:

```ts
// Lost phone: an admin turns 2FA off for another user (no code needed).
app.delete('/api/users/:id/2fa', requireAction('manage-users'), asyncRoute(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (req.user!.id === id) {
    return res.status(400).json({ error: 'Turn off your own two-factor authentication under Account Security (it needs a code).' });
  }
  const target = await storage.getUserById(id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  await twoFactor.reset(id);
  console.log(`[AUDIT] 2FA reset for "${target.username}" by "${req.user!.username}"`);
  res.json({ success: true });
}));
```

Di `errorHandler`, setelah baris `ValidationError`, tambahkan:

```ts
  if (err instanceof TwoFactorError) return res.status(err.status).json({ error: err.message });
```

- [ ] **Step 4: Typecheck & unit test**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 0 error; semua test PASS.

- [ ] **Step 5: Verifikasi HTTP pada build produksi**

Run: `npm run build`, lalu simpan skrip berikut sebagai file sementara di luar repo (mis. `$TEMP/2fa-smoke.sh`) dan jalankan dari root repo: `bash "$TEMP/2fa-smoke.sh"`.

```bash
#!/usr/bin/env bash
# 2FA end-to-end over HTTP against the production bundle. Run from the repo root.
set -u
PROJ="$(pwd)"; WORK="$(mktemp -d)"; PORT=3993; BASE="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
check(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  PASS  $1"; else FAIL=$((FAIL+1)); echo "  FAIL  $1 (got: $2)"; fi; }
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }
json(){ node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)'"$1"';console.log(typeof v==="object"?JSON.stringify(v):v)})'; }
# Independent RFC 6238 implementation to cross-check the server's.
totp(){ node -e '
const c=require("crypto"),A="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";let b=0,v=0,k=[];
for(const ch of process.argv[1]){v=(v<<5)|A.indexOf(ch);b+=5;if(b>=8){k.push((v>>>(b-8))&255);b-=8;}}
const m=Buffer.alloc(8);m.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
const h=c.createHmac("sha1",Buffer.from(k)).update(m).digest(),o=h[19]&15;
console.log(String((((h[o]&127)<<24)|(h[o+1]<<16)|(h[o+2]<<8)|h[o+3])%1e6).padStart(6,"0"));' "$1"; }
next_step(){ node -e 'setTimeout(()=>{},30000-Date.now()%30000+500)'; }
login(){ curl -s -c "$3" -X POST -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}" $BASE/api/auth/login; }
post(){ curl -s "$@"; }
J='Content-Type: application/json'

cp -r "$PROJ/dist" "$WORK/dist"; cd "$WORK"
NODE_ENV=production JWT_SECRET=3f9c1a7be2d04c55a1e8b6d7c9f0a2b4 ADMIN_PASSWORD='Adm1n-pass!' PORT=$PORT node "$PROJ/dist-server/server.cjs" > server.log 2>&1 &
SRV=$!; for i in $(seq 1 40); do curl -s $BASE/api/health >/dev/null && break; sleep 0.5; done
login admin 'Adm1n-pass!' admin.jar >/dev/null; A="-b admin.jar -c admin.jar"
post $A -X POST -H "$J" -d '{"username":"bob","password":"bob-pass-1","role":"operator"}' $BASE/api/users >/dev/null
post $A -X POST -H "$J" -d '{"username":"carl","password":"carl-pass-1","role":"viewer"}' $BASE/api/users >/dev/null
ADMIN_ID=$(post $A $BASE/api/users | json '.find(u=>u.username==="admin").id')
BOB_ID=$(post $A $BASE/api/users | json '.find(u=>u.username==="bob").id')
CARL_ID=$(post $A $BASE/api/users | json '.find(u=>u.username==="carl").id')

echo "== enrollment"
login bob bob-pass-1 bob.jar >/dev/null; B="-b bob.jar -c bob.jar"
check "status off" "$(post $B $BASE/api/auth/2fa)" '{"enabled":false,"pending":false,"recoveryCodesLeft":0}'
check "setup needs the right password" "$(code $B -X POST -H "$J" -d '{"password":"nope"}' $BASE/api/auth/2fa/setup)" 401
SETUP=$(post $B -X POST -H "$J" -d '{"password":"bob-pass-1"}' $BASE/api/auth/2fa/setup)
SECRET=$(echo "$SETUP" | json '.secret')
check "otpauth URL" "$(echo "$SETUP" | json '.otpauthUrl' | grep -c "^otpauth://totp/NetTwin%20Core:bob?secret=$SECRET&issuer=NetTwin%20Core&algorithm=SHA1&digits=6&period=30$")" 1
check "pending: login still password-only" "$(login bob bob-pass-1 tmp.jar | json '.user.username')" bob
check "wrong first code -> 401" "$(code $B -X POST -H "$J" -d '{"code":"000000"}' $BASE/api/auth/2fa/enable)" 401
ENABLE=$(post $B -X POST -H "$J" -d "{\"code\":\"$(totp $SECRET)\"}" $BASE/api/auth/2fa/enable)
check "10 recovery codes" "$(echo "$ENABLE" | json '.recoveryCodes.length')" 10
RC() { echo "$ENABLE" | json ".recoveryCodes[$1]"; }
check "status on" "$(post $B $BASE/api/auth/2fa | json '.enabled')" true
check "setup again while on -> 409" "$(code $B -X POST -H "$J" -d '{"password":"bob-pass-1"}' $BASE/api/auth/2fa/setup)" 409
check "admin sees the 2FA flag" "$(post $A $BASE/api/users | json '.find(u=>u.username==="bob").twoFactorEnabled')" true

echo "== login"
R=$(login bob bob-pass-1 b2.jar); CH=$(echo "$R" | json '.challenge')
check "password alone -> challenge" "$(echo "$R" | json '.twoFactorRequired')" true
check "no session cookie yet" "$(cat b2.jar 2>/dev/null | grep -c nettwin_token)" 0
check "challenge is not a session" "$(code -H "Authorization: Bearer $CH" $BASE/api/auth/me)" 401
next_step
check "wrong code -> 401" "$(code -X POST -H "$J" -d "{\"challenge\":\"$CH\",\"code\":\"000000\"}" $BASE/api/auth/login/2fa)" 401
NOW=$(totp $SECRET)
check "code with a space -> session" "$(code -c b2.jar -X POST -H "$J" -d "{\"challenge\":\"$CH\",\"code\":\"${NOW:0:3} ${NOW:3}\"}" $BASE/api/auth/login/2fa)" 200
check "session works" "$(code -b b2.jar $BASE/api/auth/me)" 200
CH2=$(login bob bob-pass-1 b3.jar | json '.challenge')
check "same code again -> 401 (replay)" "$(code -X POST -H "$J" -d "{\"challenge\":\"$CH2\",\"code\":\"$NOW\"}" $BASE/api/auth/login/2fa)" 401
R=$(post -X POST -H "$J" -d "{\"challenge\":\"$CH2\",\"code\":\"$(RC 0 | tr a-z A-Z)\"}" $BASE/api/auth/login/2fa)
check "recovery code (upper case) -> 9 left" "$(echo "$R" | json '.recoveryCodesLeft')" 9
check "same recovery code again -> 401" "$(code -X POST -H "$J" -d "{\"challenge\":\"$CH2\",\"code\":\"$(RC 0)\"}" $BASE/api/auth/login/2fa)" 401
check "garbage challenge -> 401" "$(code -X POST -H "$J" -d '{"challenge":"x.y.z","code":"123456"}' $BASE/api/auth/login/2fa)" 401

echo "== password change voids open challenges"
CH3=$(login bob bob-pass-1 b4.jar | json '.challenge')
post $A -X PUT -H "$J" -d '{"password":"bob-pass-2"}' $BASE/api/users/$BOB_ID >/dev/null
check "old challenge -> 401" "$(code -X POST -H "$J" -d "{\"challenge\":\"$CH3\",\"code\":\"$(RC 1)\"}" $BASE/api/auth/login/2fa)" 401

echo "== disable"
CH4=$(login bob bob-pass-2 b5.jar | json '.challenge')
post -c b5.jar -X POST -H "$J" -d "{\"challenge\":\"$CH4\",\"code\":\"$(RC 1)\"}" $BASE/api/auth/login/2fa >/dev/null
check "disable with a wrong code -> 401" "$(code -b b5.jar -X POST -H "$J" -d '{"password":"bob-pass-2","code":"000000"}' $BASE/api/auth/2fa/disable)" 401
check "disable with password + recovery code -> 200" "$(code -b b5.jar -X POST -H "$J" -d "{\"password\":\"bob-pass-2\",\"code\":\"$(RC 2)\"}" $BASE/api/auth/2fa/disable)" 200
check "bob signs in with password only again" "$(login bob bob-pass-2 b6.jar | json '.user.username')" bob

echo "== admin reset"
login carl carl-pass-1 c.jar >/dev/null; C="-b c.jar -c c.jar"
CS=$(post $C -X POST -H "$J" -d '{"password":"carl-pass-1"}' $BASE/api/auth/2fa/setup | json '.secret')
post $C -X POST -H "$J" -d "{\"code\":\"$(totp $CS)\"}" $BASE/api/auth/2fa/enable >/dev/null
check "carl now needs a code" "$(login carl carl-pass-1 c2.jar | json '.twoFactorRequired')" true
check "viewer cannot reset others -> 403" "$(code $C -X DELETE $BASE/api/users/$BOB_ID/2fa)" 403
check "admin cannot reset own 2FA here -> 400" "$(code $A -X DELETE $BASE/api/users/$ADMIN_ID/2fa)" 400
check "admin resets carl -> 200" "$(code $A -X DELETE $BASE/api/users/$CARL_ID/2fa)" 200
check "carl signs in with password only" "$(login carl carl-pass-1 c3.jar | json '.user.username')" carl

echo "== wrong codes are throttled"
BS=$(post -b b6.jar -X POST -H "$J" -d '{"password":"bob-pass-2"}' $BASE/api/auth/2fa/setup | json '.secret')
post -b b6.jar -X POST -H "$J" -d "{\"code\":\"$(totp $BS)\"}" $BASE/api/auth/2fa/enable >/dev/null
CH5=$(login bob bob-pass-2 b7.jar | json '.challenge')
for i in $(seq 1 10); do curl -s -o /dev/null -X POST -H "$J" -d "{\"challenge\":\"$CH5\",\"code\":\"000000\"}" $BASE/api/auth/login/2fa; done
check "11th wrong code -> 429" "$(code -X POST -H "$J" -d "{\"challenge\":\"$CH5\",\"code\":\"000000\"}" $BASE/api/auth/login/2fa)" 429

kill $SRV 2>/dev/null
echo; grep -E "AUDIT.*2FA|ERROR" server.log
echo "RESULT: $PASS passed, $FAIL failed"
cd / && rm -rf "$WORK"
```

Expected: `RESULT: 29 passed, 0 failed`; log berisi baris `[AUDIT] 2FA enabled/disabled/reset/recovery code used`, tanpa `ERROR`.

---

### Task 6: Login dua langkah di frontend

**Files:**
- Modify: `src/components/LoginView.tsx` (ganti seluruh isi)
- Modify: `src/i18n.tsx`

**Interfaces:**
- Consumes: kontrak `POST /api/auth/login` & `POST /api/auth/login/2fa` (Task 5); `useDialog` (`src/components/DialogProvider.tsx`)
- Produces: tidak ada API baru; `onLogin(user)` tetap sama.

- [ ] **Step 1: Ganti `src/components/LoginView.tsx`**

```tsx
import React, { useState } from 'react';
import { Network, LogIn, RefreshCw, AlertCircle, ShieldCheck, Smartphone, ArrowLeft } from 'lucide-react';
import { useLang } from '../i18n';
import { useDialog } from './DialogProvider';

export interface AuthUser {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
}

interface LoginViewProps {
  onLogin: (user: AuthUser) => void;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export default function LoginView({ onLogin }: LoginViewProps) {
  const { t, lang, setLang } = useLang();
  const dialog = useDialog();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Set once the password was accepted for an account with 2FA.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitPassword = async () => {
    const res = await post('/api/auth/login', { username, password });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${t('Login failed')} (HTTP ${res.status})`);
    if (data.twoFactorRequired) {
      setChallenge(data.challenge);
      setCode('');
      return;
    }
    onLogin(data.user);
  };

  const submitCode = async () => {
    const res = await post('/api/auth/login/2fa', { challenge, code });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.restart) back();
      throw new Error(data.error || `${t('Login failed')} (HTTP ${res.status})`);
    }
    if (typeof data.recoveryCodesLeft === 'number') {
      await dialog.alert(t('You signed in with a recovery code. {n} left — each works only once.', { n: data.recoveryCodesLeft }), {
        title: t('Recovery code used'),
      });
    }
    onLogin(data.user);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await (challenge ? submitCode() : submitPassword());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Back to the password step (also after the challenge expired).
  const back = () => {
    setChallenge(null);
    setCode('');
    setPassword('');
  };

  const field = 'w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-slate-100 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/20">
            <Network size={22} />
          </div>
          <div>
            <h1 className="font-display font-bold text-xl text-white tracking-tight">NetTwin Core</h1>
            <p className="text-[10px] text-slate-500 font-mono tracking-wider uppercase font-bold">{t('Control Plane Twin')}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-slate-800/60 border border-slate-700 rounded-2xl p-6 space-y-4 shadow-xl">
          <div className="flex items-center justify-between gap-2 text-slate-300 pb-2 border-b border-slate-700">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-emerald-400" />
              <span className="font-display font-bold text-sm">{t('Sign in to Digital Twin Console')}</span>
            </div>
            <div className="flex gap-1">
              {(['en', 'id'] as const).map(l => (
                <button key={l} type="button" onClick={() => setLang(l)}
                  className={`px-2 py-0.5 rounded font-bold uppercase text-[9px] tracking-wider transition ${lang === l ? 'bg-blue-600 text-white' : 'bg-slate-900 text-slate-500 hover:bg-slate-700'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          {!challenge ? (
            <>
              <div>
                <label className="block text-slate-400 font-semibold mb-1.5 uppercase tracking-wider text-[10px]">{t('Username')}</label>
                <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                  autoFocus autoComplete="username" className={field} required />
              </div>
              <div>
                <label className="block text-slate-400 font-semibold mb-1.5 uppercase tracking-wider text-[10px]">{t('Password')}</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password" className={field} required />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-slate-300 text-xs flex items-start gap-2 leading-relaxed">
                <Smartphone size={15} className="text-blue-400 shrink-0 mt-0.5" />
                {t('Enter the 6-digit code from your authenticator app, or a recovery code.')}
              </p>
              <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
                autoFocus placeholder="123456" aria-label={t('Authentication code')}
                className={`${field} font-mono text-lg text-center tracking-widest`} required />
            </div>
          )}

          {error && (
            <div className="p-2.5 bg-rose-500/10 border border-rose-500/30 text-rose-300 rounded-lg text-xs font-semibold flex items-center gap-2">
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition shadow-md flex items-center justify-center gap-2 text-sm">
            {loading ? <RefreshCw size={15} className="animate-spin" /> : <LogIn size={15} />}
            {challenge ? t('Verify') : t('Sign In')}
          </button>

          {challenge && (
            <button type="button" onClick={() => { back(); setError(null); }}
              className="w-full text-slate-400 hover:text-slate-200 text-xs font-semibold flex items-center justify-center gap-1.5">
              <ArrowLeft size={13} /> {t('Back')}
            </button>
          )}
        </form>

        <p className="text-center text-[11px] text-slate-600 mt-4 font-mono">
          RBAC: admin • operator • viewer
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Terjemahan** — tambahkan ke map `ID` di `src/i18n.tsx` (sebelum `};` penutup):

```ts
  // --- two-factor login ---
  'Enter the 6-digit code from your authenticator app, or a recovery code.': 'Masukkan kode 6 digit dari aplikasi authenticator, atau kode cadangan.',
  'Authentication code': 'Kode autentikasi',
  'Verify': 'Verifikasi',
  'Back': 'Kembali',
  'You signed in with a recovery code. {n} left — each works only once.': 'Anda masuk dengan kode cadangan. Tersisa {n} — tiap kode hanya berlaku sekali.',
  'Recovery code used': 'Kode cadangan terpakai',
```

- [ ] **Step 3: Verifikasi**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 0 error (termasuk tidak ada key i18n ganda — `TS1117`); semua test PASS.

---

### Task 7: Kartu "Keamanan Akun" & kontrol admin

**Files:**
- Create: `src/clipboard.ts`
- Create: `src/components/TwoFactorCard.tsx`
- Modify: `src/components/SettingsTab.tsx`
- Modify: `src/i18n.tsx`
- Modify: `package.json`, `package-lock.json` (via npm)

**Interfaces:**
- Consumes: `GET /api/auth/2fa`, `POST /api/auth/2fa/{setup,enable,disable}`, `GET /api/users` (`twoFactorEnabled`), `DELETE /api/users/:id/2fa` (Task 5); `useDialog`
- Produces: `copyText(text: string): Promise<boolean>`; komponen `TwoFactorCard({ username }: { username: string })`

- [ ] **Step 1: Dependency QR (frontend saja)**

Run: `npm install --save-dev qrcode @types/qrcode && npm audit`
Expected: terpasang di `devDependencies`; `found 0 vulnerabilities`.

- [ ] **Step 2: `src/clipboard.ts`**

```ts
// Clipboard API only exists in secure contexts (HTTPS / localhost); fall back
// to a hidden textarea when the app is served over plain HTTP on the LAN.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: `src/components/TwoFactorCard.tsx`**

```tsx
import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ShieldCheck, ShieldOff, Smartphone, Copy, Download, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useLang } from '../i18n';
import { copyText } from '../clipboard';

interface Status {
  enabled: boolean;
  pending: boolean;
  recoveryCodesLeft: number;
}

type Step = 'idle' | 'password' | 'scan' | 'codes' | 'disable';

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Account Security: any signed-in user turns authenticator-app two-factor
// authentication on or off for their own account.
export default function TwoFactorCard({ username }: { username: string }) {
  const { t } = useLang();
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    const res = await fetch('/api/auth/2fa').catch(() => null);
    if (res?.ok) setStatus(await res.json());
  };
  useEffect(() => { void load(); }, []);

  const goTo = (next: Step) => {
    setStep(next);
    setPassword('');
    setCode('');
    setError(null);
  };

  // One API call; the server's error message is shown in the card.
  const run = async (call: () => Promise<Response>, onOk: (data: any) => Promise<void> | void) => {
    setBusy(true);
    setError(null);
    try {
      const res = await call();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('Request failed (HTTP {status}).', { status: res.status }));
        return;
      }
      await onOk(data);
    } catch {
      setError(t('Cannot reach the server. Check your connection and try again.'));
    } finally {
      setBusy(false);
    }
  };

  const startSetup = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => post('/api/auth/2fa/setup', { password }), async data => {
      setSecret(data.secret);
      setQr(await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 200 }));
      goTo('scan');
    });
  };

  const confirmSetup = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => post('/api/auth/2fa/enable', { code }), async data => {
      setRecoveryCodes(data.recoveryCodes);
      setSecret('');
      setQr('');
      goTo('codes');
      await load();
    });
  };

  const turnOff = (e: React.FormEvent) => {
    e.preventDefault();
    void run(() => post('/api/auth/2fa/disable', { password, code }), async () => {
      goTo('idle');
      await load();
    });
  };

  const codesText = () => `NetTwin Core — ${t('recovery codes for')} ${username}\n\n${recoveryCodes.join('\n')}\n`;
  const copyCodes = async () => {
    if (await copyText(codesText())) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const downloadCodes = () => {
    const url = URL.createObjectURL(new Blob([codesText()], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `nettwin-recovery-codes-${username}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const input = 'w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:ring-1 focus:ring-blue-500';
  const label = 'block font-bold text-slate-500 text-[9px] uppercase tracking-wider mb-1';
  const secondary = 'px-4 py-2 bg-white hover:bg-slate-100 border border-slate-200 text-slate-700 font-semibold rounded-lg transition flex items-center gap-1.5';
  const primary = 'px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 text-white font-semibold rounded-lg transition flex items-center gap-1.5';
  const danger = 'px-4 py-2 bg-rose-600 hover:bg-rose-700 disabled:bg-slate-300 text-white font-semibold rounded-lg transition flex items-center gap-1.5';

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-6 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-display font-bold text-slate-800 text-sm flex items-center gap-1.5">
            <Smartphone size={16} className="text-blue-500" /> {t('Account Security (2FA)')}
          </h3>
          <p className="text-slate-500 text-[11px] mt-0.5">
            {t('Protect your account with a 6-digit code from Google Authenticator or a compatible app.')}
          </p>
        </div>
        {status && (
          <span className={`text-[10px] px-2 py-1 rounded-full font-bold uppercase shrink-0 border ${
            status.enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-100' : 'bg-slate-100 text-slate-500 border-slate-200'
          }`}>
            {status.enabled ? t('2FA on') : t('2FA off')}
          </span>
        )}
      </div>

      {error && (
        <div className="p-2.5 bg-rose-50 border border-rose-100 text-rose-800 rounded-lg font-semibold flex items-center gap-2">
          <AlertCircle size={14} /> {error}
        </div>
      )}

      {step === 'idle' && status && (status.enabled ? (
        <div className="space-y-3">
          {status.recoveryCodesLeft <= 3 && (
            <div className="p-2.5 bg-amber-50 border border-amber-100 text-amber-800 rounded-lg text-[11px]">
              {t('Only {n} recovery codes left. Turn two-factor authentication off and on again to get new ones.', { n: status.recoveryCodesLeft })}
            </div>
          )}
          <p className="text-slate-600">{t('{n} unused recovery codes.', { n: status.recoveryCodesLeft })}</p>
          <button onClick={() => goTo('disable')} className="px-4 py-2 bg-white hover:bg-rose-50 border border-rose-300 text-rose-700 font-semibold rounded-lg transition flex items-center gap-1.5">
            <ShieldOff size={14} /> {t('Turn off 2FA')}
          </button>
        </div>
      ) : (
        <button onClick={() => goTo('password')} className={primary}>
          <ShieldCheck size={14} /> {t('Turn on 2FA')}
        </button>
      ))}

      {step === 'password' && (
        <form onSubmit={startSetup} className="space-y-3 max-w-sm">
          <div>
            <label className={label}>{t('Current password')}</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus required className={input} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => goTo('idle')} className={secondary}>{t('Cancel')}</button>
            <button type="submit" disabled={busy || !password} className={primary}>
              {busy && <RefreshCw size={14} className="animate-spin" />} {t('Continue')}
            </button>
          </div>
        </form>
      )}

      {step === 'scan' && (
        <form onSubmit={confirmSetup} className="grid md:grid-cols-2 gap-5 items-start">
          <div className="space-y-2">
            <p className="text-slate-600">{t('1. Scan this QR code with Google Authenticator (or add the key manually).')}</p>
            {qr && <img src={qr} alt={t('QR code for the authenticator app')} className="w-48 h-48 border border-slate-200 rounded-lg" />}
            <div data-testid="totp-secret" className="font-mono text-[11px] bg-slate-50 border border-slate-200 rounded-lg p-2 break-all select-all">
              {secret.match(/.{1,4}/g)?.join(' ')}
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <label className={label}>{t('2. Enter the 6-digit code shown in the app.')}</label>
              <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code"
                placeholder="123456" autoFocus required className={`${input} font-mono text-base text-center tracking-widest`} />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => goTo('idle')} className={secondary}>{t('Cancel')}</button>
              <button type="submit" disabled={busy || !code.trim()} className={primary}>
                {busy && <RefreshCw size={14} className="animate-spin" />} {t('Verify & turn on')}
              </button>
            </div>
          </div>
        </form>
      )}

      {step === 'codes' && (
        <div className="space-y-3">
          <div className="p-2.5 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-lg font-semibold flex items-center gap-2">
            <CheckCircle2 size={14} /> {t('Two-factor authentication is on.')}
          </div>
          <p className="text-slate-600">{t('Save these recovery codes somewhere safe. Each works once if you lose your phone. They will not be shown again.')}</p>
          <div data-testid="recovery-codes" className="grid grid-cols-2 gap-1.5 font-mono text-sm bg-slate-50 border border-slate-200 rounded-lg p-3 max-w-sm">
            {recoveryCodes.map(c => <span key={c}>{c}</span>)}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={copyCodes} className={secondary}><Copy size={13} /> {copied ? t('Copied') : t('Copy')}</button>
            <button onClick={downloadCodes} className={secondary}><Download size={13} /> {t('Download .txt')}</button>
            <button onClick={() => { setRecoveryCodes([]); goTo('idle'); }} className={primary}>{t('Done')}</button>
          </div>
        </div>
      )}

      {step === 'disable' && (
        <form onSubmit={turnOff} className="space-y-3 max-w-sm">
          <div>
            <label className={label}>{t('Current password')}</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" autoFocus required className={input} />
          </div>
          <div>
            <label className={label}>{t('Authenticator code or recovery code')}</label>
            <input value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" required className={`${input} font-mono`} />
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => goTo('idle')} className={secondary}>{t('Cancel')}</button>
            <button type="submit" disabled={busy || !password || !code.trim()} className={danger}>
              {busy && <RefreshCw size={14} className="animate-spin" />} {t('Turn off 2FA')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 4: `src/components/SettingsTab.tsx`**

1. Import: tambahkan `import TwoFactorCard from './TwoFactorCard';` dan `ShieldOff` ke import `lucide-react`.
2. `interface ManagedUser`: tambahkan `twoFactorEnabled?: boolean;`.
3. Setelah `handleDeleteUser`, tambahkan:

```tsx
  const handleResetTwoFactor = async (user: ManagedUser) => {
    const ok = await dialog.confirm(
      t('Turn off two-factor authentication for "{name}"? They can sign in with their password only until they set it up again.', { name: user.username }),
      { title: t('Reset 2FA'), tone: 'danger', confirmLabel: t('Reset 2FA') },
    );
    if (!ok) return;
    try {
      const res = await fetch(`/api/users/${user.id}/2fa`, { method: 'DELETE' });
      const data = await bodyOf(res);
      if (!res.ok) throw new Error(data.error || t('Failed to reset 2FA'));
      flash('ok', t('Two-factor authentication for "{name}" was reset.', { name: user.username }));
      await loadUsers();
    } catch (err: any) {
      flash('error', err.message);
    }
  };
```

4. Di JSX, tepat setelah blok `{message && (...)}`, tambahkan `<TwoFactorCard username={currentUser.username} />`.
5. Di sel username tabel user, setelah badge "You", tambahkan:

```tsx
                      {u.twoFactorEnabled && (
                        <span className="ml-2 text-[9px] bg-emerald-50 text-emerald-700 border border-emerald-100 px-1.5 py-0.5 rounded-full font-bold uppercase">2FA</span>
                      )}
```

6. Di sel aksi, sebelum tombol ganti password, tambahkan:

```tsx
                      {u.twoFactorEnabled && u.id !== currentUser.id && (
                        <button
                          onClick={() => handleResetTwoFactor(u)}
                          className="p-1.5 text-amber-600 hover:text-amber-700 hover:bg-amber-50 rounded transition"
                          title={t('Reset 2FA')}
                        >
                          <ShieldOff size={13} />
                        </button>
                      )}
```

- [ ] **Step 5: Terjemahan** — tambahkan ke map `ID` di `src/i18n.tsx` (sebelum `};` penutup). Jika tsc melaporkan `TS1117` (key ganda), hapus baris baru yang duplikat.

```ts
  // --- account security (2FA) ---
  'Account Security (2FA)': 'Keamanan Akun (2FA)',
  'Protect your account with a 6-digit code from Google Authenticator or a compatible app.': 'Lindungi akun Anda dengan kode 6 digit dari Google Authenticator atau aplikasi sejenis.',
  '2FA on': '2FA aktif',
  '2FA off': '2FA nonaktif',
  'Only {n} recovery codes left. Turn two-factor authentication off and on again to get new ones.': 'Kode cadangan tinggal {n}. Matikan lalu aktifkan lagi 2FA untuk mendapat kode baru.',
  '{n} unused recovery codes.': '{n} kode cadangan belum terpakai.',
  'Turn off 2FA': 'Matikan 2FA',
  'Turn on 2FA': 'Aktifkan 2FA',
  'Current password': 'Password saat ini',
  'Continue': 'Lanjut',
  '1. Scan this QR code with Google Authenticator (or add the key manually).': '1. Pindai QR code ini dengan Google Authenticator (atau masukkan kuncinya secara manual).',
  'QR code for the authenticator app': 'QR code untuk aplikasi authenticator',
  '2. Enter the 6-digit code shown in the app.': '2. Masukkan kode 6 digit yang tampil di aplikasi.',
  'Verify & turn on': 'Verifikasi & aktifkan',
  'Two-factor authentication is on.': '2FA sudah aktif.',
  'Save these recovery codes somewhere safe. Each works once if you lose your phone. They will not be shown again.': 'Simpan kode cadangan ini di tempat aman. Tiap kode berlaku sekali bila HP Anda hilang. Kode ini tidak akan ditampilkan lagi.',
  'recovery codes for': 'kode cadangan untuk',
  'Copied': 'Tersalin',
  'Copy': 'Salin',
  'Download .txt': 'Unduh .txt',
  'Done': 'Selesai',
  'Authenticator code or recovery code': 'Kode authenticator atau kode cadangan',
  'Reset 2FA': 'Reset 2FA',
  'Turn off two-factor authentication for "{name}"? They can sign in with their password only until they set it up again.': 'Matikan 2FA untuk "{name}"? User ini bisa masuk hanya dengan password sampai mendaftarkannya lagi.',
  'Failed to reset 2FA': 'Gagal mereset 2FA',
  'Request failed (HTTP {status}).': 'Permintaan gagal (HTTP {status}).',
  'Cannot reach the server. Check your connection and try again.': 'Server tidak dapat dihubungi. Periksa koneksi lalu coba lagi.',
  'Two-factor authentication for "{name}" was reset.': '2FA untuk "{name}" sudah direset.',
```

- [ ] **Step 6: Verifikasi**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc 0 error; semua test PASS (termasuk `src/noNativeDialogs.test.ts`); build sukses dan `dist-server/server.cjs` **tidak** berisi `qrcode` (`grep -c qrcode dist-server/server.cjs` → `0`).

---

### Task 8: Dokumentasi & verifikasi menyeluruh

**Files:**
- Modify: `README.md`, `TUTORIAL.md`

**Interfaces:**
- Consumes: seluruh fitur Task 1–7
- Produces: —

- [ ] **Step 1: README** — di bagian "Keamanan (yang sudah & yang perlu Anda lakukan)", tambahkan `2FA opsional (Google Authenticator/TOTP) dengan kode cadangan` ke daftar "Sudah ada", lalu tambahkan subbagian berikut tepat setelah bagian tersebut:

````markdown
### 2FA (Google Authenticator)

Setiap user dapat mengaktifkan 2FA di **Settings → Keamanan Akun (2FA)**: masukkan password, pindai QR code dengan Google Authenticator (atau aplikasi TOTP lain), masukkan kode 6 digit, lalu simpan **10 kode cadangan** yang hanya ditampilkan sekali. Setelah aktif, login meminta kode 6 digit (atau kode cadangan) setelah password. Admin dapat melihat siapa yang memakai 2FA dan **me-reset 2FA** user lain yang kehilangan HP (tabel User Management).

- Secret 2FA dienkripsi dengan kunci turunan `JWT_SECRET`. **Jika `JWT_SECRET` diganti**, user ber-2FA harus login memakai **kode cadangan** (atau minta admin me-reset), lalu mendaftar ulang.
- **Pemulihan darurat** (admin satu-satunya kehilangan HP dan semua kode cadangan):
  ```bash
  docker compose exec -T db mysql -unettwin -p'<DB_PASSWORD>' nettwin \
    -e "DELETE FROM user_two_factor WHERE user_id = (SELECT id FROM users WHERE username = 'admin');"
  ```
  Mode file (tanpa MySQL): hapus entri user tersebut dari `data/two-factor.json`, lalu restart.
````

Ubah juga baris "Development" menjadi: `npm test        # unit test (vitest): engine simulasi, parser, auth/sesi & 2FA, validasi, storage, RBAC, i18n`.

- [ ] **Step 2: TUTORIAL** — di bagian **2. Login & peran**, setelah paragraf tentang password awal, tambahkan:

```markdown
Jika akun Anda memakai **2FA**, setelah password akan muncul isian **kode 6 digit** dari aplikasi authenticator. Kehilangan HP? Masukkan salah satu **kode cadangan** (sekali pakai) atau minta admin me-reset 2FA Anda.
```

Di bagian **12. Settings**, tambahkan poin:

```markdown
- **Keamanan Akun (2FA)** — semua role. Aktifkan: masukkan password → pindai QR code (Google Authenticator dsb.) → masukkan kode 6 digit → simpan 10 kode cadangan (salin/unduh; hanya tampil sekali). Matikan: password + kode (atau kode cadangan). Peringatan muncul bila kode cadangan tinggal ≤ 3.
- **User Management → Reset 2FA** (admin) — untuk user lain yang kehilangan HP; user tersebut lalu login dengan password saja dan bisa mendaftar ulang.
```

Di tabel **14. Troubleshooting**, tambahkan baris:

```markdown
| Kode 2FA selalu ditolak | Pastikan jam HP otomatis/akurat (toleransi ±30 detik) dan pakai kode yang sedang tampil; kode yang sudah dipakai tidak diterima lagi. Kalau `JWT_SECRET` baru saja diganti, pakai kode cadangan lalu daftar ulang. |
| Kehilangan HP 2FA | Login dengan kode cadangan, atau minta admin **Reset 2FA**. Admin tunggal tanpa kode cadangan: lihat "Pemulihan darurat" di README. |
```

- [ ] **Step 3: Verifikasi menyeluruh**

Run berurutan:
1. `npx tsc --noEmit` → 0 error
2. `npx vitest run` → semua PASS
3. `npm audit` → 0 vulnerabilities
4. `npm run build` → sukses
5. Skrip HTTP dari Task 5 Step 5 → `29 passed, 0 failed`
6. Uji browser (Edge headless via `puppeteer-core`; simpan di luar repo, jalankan dengan server produksi di port 3997 dan `ADMIN_PASSWORD='Adm1n-pass!'`):

```js
// 2fa-ui.cjs — enroll through the UI, sign in with a code and a recovery code, admin reset.
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const BASE = 'http://127.0.0.1:3997';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (n, c, x = '') => { results.push(!!c); console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  ' + x}`); };
const totp = secret => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let b = 0, v = 0; const k = [];
  for (const ch of secret.replace(/\s/g, '')) { v = (v << 5) | A.indexOf(ch); b += 5; if (b >= 8) { k.push((v >>> (b - 8)) & 255); b -= 8; } }
  const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac('sha1', Buffer.from(k)).update(m).digest(), o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, '0');
};
const nextStep = () => sleep(30000 - (Date.now() % 30000) + 500);

(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  let native = 0; const errors = [];
  page.on('dialog', d => { native++; d.accept(); });
  page.on('pageerror', e => errors.push(String(e)));
  const text = () => page.evaluate(() => document.body.innerText);
  const click = label => page.evaluate(l => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(l) && !x.disabled); b?.click(); return !!b; }, label);
  const login = async (u, p) => {
    await page.goto(BASE, { waitUntil: 'networkidle0' });
    await page.type('input[autocomplete="username"]', u);
    await page.type('input[type="password"]', p);
    await page.click('button[type="submit"]');
    await sleep(800);
  };
  const logout = async () => { await page.evaluate(() => document.querySelector('button[title="Logout"]')?.click()); await sleep(800); };

  await login('admin', process.env.ADMIN_PW);
  await page.evaluate(() => fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dina', password: 'dina-pass-1', role: 'operator' }) }));
  await logout();

  // Enroll dina through the Settings card.
  await login('dina', 'dina-pass-1');
  await click('Simulator Settings');
  check('Account Security card is shown to non-admins', /Account Security \(2FA\)/.test(await text()));
  await click('Turn on 2FA');
  await page.type('input[autocomplete="current-password"]', 'dina-pass-1');
  await click('Continue');
  await page.waitForSelector('[data-testid="totp-secret"]');
  check('QR code is rendered', await page.evaluate(() => /^data:image\/png/.test(document.querySelector('img[alt]')?.getAttribute('src') || '')));
  const secret = await page.$eval('[data-testid="totp-secret"]', el => el.textContent.replace(/\s/g, ''));
  await page.type('input[autocomplete="one-time-code"]', totp(secret));
  await click('Verify & turn on');
  await page.waitForSelector('[data-testid="recovery-codes"]');
  const codes = await page.$$eval('[data-testid="recovery-codes"] span', els => els.map(e => e.textContent));
  check('10 recovery codes are shown', codes.length === 10, String(codes.length));
  await click('Done');
  await sleep(300);
  check('card reports 2FA on', /2FA on/i.test(await text()));
  await logout();

  // Sign in with a code.
  await nextStep();
  await login('dina', 'dina-pass-1');
  check('password step leads to the code step', /Enter the 6-digit code/.test(await text()));
  await page.type('input[autocomplete="one-time-code"]', totp(secret));
  await page.click('button[type="submit"]');
  await sleep(1000);
  check('code signs in', await page.evaluate(() => !!document.querySelector('nav')));
  await logout();

  // Sign in with a recovery code.
  await login('dina', 'dina-pass-1');
  await page.type('input[autocomplete="one-time-code"]', codes[0]);
  await page.click('button[type="submit"]');
  await sleep(800);
  check('recovery-code sign-in shows an in-app notice', /9 left/.test(await text()));
  await page.keyboard.press('Enter');
  await sleep(800);
  check('recovery code signs in', await page.evaluate(() => !!document.querySelector('nav')));
  await logout();

  // Admin resets dina's 2FA.
  await login('admin', process.env.ADMIN_PW);
  await click('Simulator Settings');
  await sleep(500);
  check('user table shows the 2FA badge', await page.evaluate(() => [...document.querySelectorAll('tr')].some(r => r.textContent.includes('dina') && r.textContent.includes('2FA'))));
  await page.evaluate(() => [...document.querySelectorAll('tr')].find(r => r.textContent.includes('dina'))?.querySelector('button[title="Reset 2FA"]')?.click());
  await sleep(300);
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Reset 2FA')?.click());
  await sleep(800);
  check('reset confirmed', /was reset/.test(await text()));
  await logout();
  await login('dina', 'dina-pass-1');
  check('dina signs in with password only after the reset', await page.evaluate(() => !!document.querySelector('nav')));

  check('no native browser dialog appeared', native === 0, String(native));
  check('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  const failed = results.filter(r => !r).length;
  console.log(`RESULT: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('CRASHED', e); process.exit(2); });
```

Expected: `RESULT: 13 passed, 0 failed`.

7. Regresi: skrip HTTP umum dan UI umum yang dipakai sebelumnya tetap lulus (fitur lama tidak berubah untuk akun tanpa 2FA).
