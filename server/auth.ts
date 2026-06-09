// bcrypt + cookie-session auth. Two roles: customer | admin.
//
// Sessions: the cookie carries a random 256-bit token; the DB stores only
// sha256(token), so a leaked DB file or backup cannot be replayed as live
// sessions. Each session has an absolute expiry AND a role-dependent idle
// timeout (customers 14d/3d, admins 12h/30min).

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import * as cookie from 'cookie';
import type { Request, Response, NextFunction } from 'express';
import { db, type UserRow } from './db.js';

const COOKIE_NAME = 'prgat_session';
const BCRYPT_COST = 12;

const CUSTOMER_ABSOLUTE_DAYS = 14;
const CUSTOMER_IDLE = '-3 days';
const ADMIN_ABSOLUTE_HOURS = 12;
const ADMIN_IDLE = '-30 minutes';
// last_seen_at is bumped lazily, at most once per 5 minutes, to keep writes cheap.
const LAST_SEEN_GRANULARITY = '-5 minutes';

export interface AuthedRequest extends Request {
  user?: UserRow;
  sessionId?: number;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

// A throwaway bcrypt hash (of a random value) computed once at startup. When a
// login arrives for a username that doesn't exist, we still run a compare against
// this so the response takes the same time as a real password check — otherwise
// timing differences would let an attacker enumerate valid usernames.
const DUMMY_HASH = bcrypt.hashSync('x' + crypto.randomBytes(16).toString('hex'), BCRYPT_COST);

export async function equalizeLoginTiming(plain: string): Promise<void> {
  try {
    await bcrypt.compare(plain || '', DUMMY_HASH);
  } catch {
    /* ignore */
  }
}

// ---------- Credential policy ----------

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// Worst offenders only — the length floor does most of the work.
const COMMON_PASSWORDS = new Set([
  '1234567890',
  '0123456789',
  'qwertyuiop',
  'password12',
  'password123',
  '1q2w3e4r5t',
  'aa123456789',
  '0987654321',
]);

export function validateUsername(username: string): string | null {
  if (!USERNAME_RE.test(username)) return 'שם משתמש: 3–32 תווים, אותיות לטיניות/ספרות/נקודה/מקף בלבד';
  return null;
}

export function validatePassword(password: string, username?: string): string | null {
  if (typeof password !== 'string' || password.length < 10) return 'סיסמה: לפחות 10 תווים';
  if (password.length > 128) return 'סיסמה ארוכה מדי';
  if (/^(.)\1+$/.test(password)) return 'סיסמה חלשה מדי';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'הסיסמה הזו נפוצה מדי — בחרו אחרת';
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'הסיסמה לא יכולה להכיל את שם המשתמש';
  }
  return null;
}

// ---------- Login backoff (per-account, anti credential-stuffing) ----------

const LOCK_THRESHOLD = 5;
const LOCK_CAP_MINUTES = 60;

/** Seconds until the account unlocks, or 0 when not locked. */
export function accountLockSeconds(user: Pick<UserRow, 'locked_until'>): number {
  if (!user.locked_until) return 0;
  const row = db
    .prepare(`SELECT CAST((julianday(?) - julianday('now')) * 86400 AS INTEGER) AS s`)
    .get(user.locked_until) as { s: number };
  return Math.max(0, row.s);
}

export function recordFailedLogin(userId: number): void {
  const row = db
    .prepare(`UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins`)
    .get(userId) as { failed_logins: number };
  if (row.failed_logins >= LOCK_THRESHOLD) {
    // Exponential: 5th failure → 1 min, 6th → 2, 7th → 4 ... capped at 60.
    const minutes = Math.min(LOCK_CAP_MINUTES, 2 ** (row.failed_logins - LOCK_THRESHOLD));
    db.prepare(`UPDATE users SET locked_until = datetime('now', '+' || ? || ' minutes') WHERE id = ?`).run(
      minutes,
      userId
    );
  }
}

export function clearFailedLogins(userId: number): void {
  db.prepare(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?`).run(userId);
}

// ---------- Sessions ----------

function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(
  userId: number,
  role: 'customer' | 'admin',
  ip?: string,
  ua?: string
): string {
  const token = newToken();
  const expiresAt =
    role === 'admin'
      ? new Date(Date.now() + ADMIN_ABSOLUTE_HOURS * 3600_000).toISOString()
      : new Date(Date.now() + CUSTOMER_ABSOLUTE_DAYS * 86400_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(hashToken(token), userId, expiresAt, ip ?? null, ua ?? null);
  return token;
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroySessionById(userId: number, sessionId: number): boolean {
  const info = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(sessionId, userId);
  return info.changes > 0;
}

export function revokeOtherSessions(userId: number, keepSessionId?: number): number {
  const info = keepSessionId
    ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, keepSessionId)
    : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return info.changes;
}

export interface SessionInfo {
  id: number;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
}

export function listSessions(userId: number, currentSessionId?: number): SessionInfo[] {
  const rows = db
    .prepare(
      `SELECT id, created_at, last_seen_at, ip, user_agent
       FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC`
    )
    .all(userId) as Array<Omit<SessionInfo, 'current'>>;
  return rows.map((r) => ({ ...r, current: r.id === currentSessionId }));
}

/** Delete sessions that are past their absolute expiry or their role's idle timeout. */
export function sweepSessions(): number {
  const info = db
    .prepare(
      `DELETE FROM sessions WHERE id IN (
         SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE datetime(s.expires_at) <= datetime('now')
            OR (u.role = 'admin'  AND datetime(s.last_seen_at) <= datetime('now', ?))
            OR (u.role <> 'admin' AND datetime(s.last_seen_at) <= datetime('now', ?))
       )`
    )
    .run(ADMIN_IDLE, CUSTOMER_IDLE);
  return info.changes;
}

interface SessionLookup {
  user: UserRow;
  sessionId: number;
}

export function userFromSession(token: string): SessionLookup | null {
  // Explicit column list — deliberately excludes password_hash so the hash never
  // travels on req.user (defense-in-depth against accidentally serializing it).
  // Absolute expiry and role-dependent idle timeout are both enforced here.
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.custname, u.cust_desc, u.email, u.phone,
              u.status, u.created_at, u.last_login_at,
              s.id AS session_id
       FROM users u
       JOIN sessions s ON s.user_id = u.id
       WHERE s.token_hash = ?
         AND datetime(s.expires_at) > datetime('now')
         AND ((u.role = 'admin'  AND datetime(s.last_seen_at) > datetime('now', ?))
           OR (u.role <> 'admin' AND datetime(s.last_seen_at) > datetime('now', ?)))
         AND u.status = 'active'`
    )
    .get(token ? hashToken(token) : '', ADMIN_IDLE, CUSTOMER_IDLE) as
    | (UserRow & { session_id: number })
    | undefined;
  if (!row) return null;
  // Lazy idle-tracking: one write per session per 5 minutes at most.
  db.prepare(
    `UPDATE sessions SET last_seen_at = datetime('now')
     WHERE id = ? AND datetime(last_seen_at) <= datetime('now', ?)`
  ).run(row.session_id, LAST_SEEN_GRANULARITY);
  const { session_id, ...user } = row;
  return { user: user as UserRow, sessionId: session_id };
}

export function setSessionCookie(res: Response, token: string, role: 'customer' | 'admin'): void {
  const secure = process.env.NODE_ENV === 'production';
  const maxAge =
    role === 'admin' ? ADMIN_ABSOLUTE_HOURS * 3600 : CUSTOMER_ABSOLUTE_DAYS * 86400;
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge,
    })
  );
}

export function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, '', {
      httpOnly: true,
      path: '/',
      maxAge: 0,
    })
  );
}

export function tokenFromRequest(req: Request): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const parsed = cookie.parse(raw);
  return parsed[COOKIE_NAME] ?? null;
}

export function loadUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = tokenFromRequest(req);
  if (token) {
    const found = userFromSession(token);
    if (found) {
      req.user = found.user;
      req.sessionId = found.sessionId;
    }
  }
  next();
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

export function requireCustomer(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.user.role !== 'customer' || !req.user.custname) {
    res.status(403).json({ error: 'customer_only' });
    return;
  }
  next();
}

export async function bootstrapAdmin(): Promise<void> {
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  if (count > 0) return;
  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!username || !password) {
    console.warn(
      '[auth] users table empty and ADMIN_BOOTSTRAP_* env vars missing — no admin user created. Set them and restart.'
    );
    return;
  }
  const hash = await hashPassword(password);
  db.prepare(
    `INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, 'admin', 'active')`
  ).run(username, hash);
  console.log(`[auth] bootstrap admin "${username}" created.`);
}

export const COOKIE = COOKIE_NAME;
