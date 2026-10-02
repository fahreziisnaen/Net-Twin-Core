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
