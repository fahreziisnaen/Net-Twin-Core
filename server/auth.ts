import { Request, Response, NextFunction, CookieOptions } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Role, Action, canAccess, ROLES } from '../src/rbac';
import { Storage, UserRecord } from './storage';
import { isWeakSecret } from './secrets';

export const AUTH_COOKIE = 'nettwin_token';
const TOKEN_TTL_SECONDS = 12 * 3600;
const IS_PROD = process.env.NODE_ENV === 'production';

// In production a real secret is mandatory: refuse to boot with a missing or
// placeholder secret, otherwise anyone could forge an admin session token.
if (IS_PROD && isWeakSecret(process.env.JWT_SECRET)) {
  console.error('FATAL: JWT_SECRET must be a strong random value (16+ chars, not a placeholder) in production. Generate one with: openssl rand -hex 32');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'nettwin-dev-secret-change-me';
if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set — using an insecure development secret. Set JWT_SECRET in production.');
}

// `secure` (HTTPS-only) follows COOKIE_SECURE when set explicitly; otherwise it
// is on whenever the request itself arrived over HTTPS (req.secure honours
// TRUST_PROXY behind a TLS-terminating proxy). Browsers drop a secure cookie
// set over plain HTTP, which would make login impossible there.
function cookieSecure(req: Request): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  return req.secure;
}

export function authCookieOptions(req: Request): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    path: '/',
    maxAge: TOKEN_TTL_SECONDS * 1000,
  };
}

// Express 4 lets maxAge override the expiry clearCookie sets, so drop it.
export function clearAuthCookie(req: Request, res: Response) {
  const { maxAge: _maxAge, ...options } = authCookieOptions(req);
  res.clearCookie(AUTH_COOKIE, options);
}

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}

// Express request augmented by the authenticate middleware
export interface AuthedRequest extends Request {
  user?: AuthUser;
}

export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

// Compared against when the username doesn't exist, so a login attempt takes
// the same time either way and doesn't reveal which usernames are valid.
const DUMMY_HASH = bcrypt.hashSync('nettwin-timing-equaliser', 10);

export async function verifyLogin(user: UserRecord | null, password: string): Promise<boolean> {
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  return ok && !!user;
}

// Ties a token to the password it was issued under: changing a password
// invalidates every session issued before the change.
function passwordStamp(passwordHash: string): string {
  return crypto.createHash('sha256').update(passwordHash).digest('base64url').slice(0, 16);
}

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
// Attach req.user from the auth cookie (or Bearer header for API clients).
// The user is re-read from storage on every request, so deleting a user or
// changing their role takes effect immediately rather than at token expiry.
export function authenticate(storage: Storage) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    try {
      const bearer = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined;
      const token = (req as any).cookies?.[AUTH_COOKIE] || bearer;
      const claims = token ? verifyToken(token) : null;
      if (claims) {
        const user = await storage.getUserById(claims.id);
        if (user && ROLES.includes(user.role) && passwordStamp(user.passwordHash) === claims.pv) {
          req.user = { id: user.id, username: user.username, role: user.role };
        }
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Route guard: 401 without a valid session, 403 when the role lacks the action
export function requireAction(action: Action) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required. Please log in first.' });
    }
    if (!canAccess(req.user.role, action)) {
      return res.status(403).json({ error: `Access denied: role "${req.user.role}" lacks the "${action}" permission.` });
    }
    next();
  };
}

// Guarantee an admin account exists on first boot. Without ADMIN_PASSWORD a
// production install gets a random password (printed once) instead of a
// well-known default.
export async function ensureAdminSeed(storage: Storage): Promise<void> {
  const users = await storage.listUsers();
  if (users.length > 0) return;
  let password = process.env.ADMIN_PASSWORD;
  let shown = '(from ADMIN_PASSWORD env)';
  if (!password) {
    password = IS_PROD ? crypto.randomBytes(12).toString('base64url') : 'admin123';
    shown = `${password}  <-- CHANGE THIS after logging in`;
  }
  await storage.createUser('admin', await hashPassword(password), 'admin');
  console.log('==========================================================');
  console.log('  First boot: created default admin account');
  console.log(`  username: admin   password: ${shown}`);
  console.log('==========================================================');
}
