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
