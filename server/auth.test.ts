import { describe, test, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { authenticate, signToken, verifyLogin, AuthedRequest } from './auth';
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
