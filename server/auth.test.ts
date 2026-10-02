import { describe, test, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { authenticate, signToken, verifyLogin, AuthedRequest, signChallenge, resolveChallenge, deriveKey } from './auth';
import jwt from 'jsonwebtoken';
import { Storage, UserRecord } from './storage';

// Minimal storage stub: authenticate only needs getUserById.
function storageWith(users: UserRecord[]): Storage {
  return { getUserById: async (id: number) => users.find(u => u.id === id) || null } as unknown as Storage;
}

async function run(storage: Storage, token: string | undefined): Promise<AuthedRequest> {
  const req = { headers: {}, cookies: token ? { nettwin_token: token } : {} } as unknown as AuthedRequest;
  await new Promise<void>((resolve, reject) =>
    authenticate(storage)(req, {} as any, (err?: unknown) => (err ? reject(err) : resolve()))
  );
  return req;
}

const alice: UserRecord = { id: 7, username: 'alice', role: 'admin', passwordHash: bcrypt.hashSync('secret-1', 4) };

describe('session authentication', () => {
  test('a valid token for an existing user authenticates', async () => {
    const req = await run(storageWith([alice]), signToken(alice));
    expect(req.user).toEqual({ id: 7, username: 'alice', role: 'admin' });
  });

  test('role changes apply immediately (role comes from storage, not the token)', async () => {
    const token = signToken(alice);
    const req = await run(storageWith([{ ...alice, role: 'viewer' }]), token);
    expect(req.user?.role).toBe('viewer');
  });

  test('a deleted user is no longer authenticated', async () => {
    const req = await run(storageWith([]), signToken(alice));
    expect(req.user).toBeUndefined();
  });

  test('changing the password invalidates earlier sessions', async () => {
    const token = signToken(alice);
    const changed = { ...alice, passwordHash: bcrypt.hashSync('secret-2', 4) };
    const req = await run(storageWith([changed]), token);
    expect(req.user).toBeUndefined();
  });

  test('garbage and missing tokens are ignored', async () => {
    expect((await run(storageWith([alice]), 'not-a-jwt')).user).toBeUndefined();
    expect((await run(storageWith([alice]), undefined)).user).toBeUndefined();
  });

  test('verifyLogin accepts the right password only, and never an unknown user', async () => {
    expect(await verifyLogin(alice, 'secret-1')).toBe(true);
    expect(await verifyLogin(alice, 'wrong')).toBe(false);
    expect(await verifyLogin(null, 'secret-1')).toBe(false);
  });
});

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
