// bcrypt + cookie-session auth. Two roles: customer | admin.

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import * as cookie from 'cookie';
import type { Request, Response, NextFunction } from 'express';
import { db, type UserRow } from './db.js';

const COOKIE_NAME = 'prgat_session';
const SESSION_TTL_DAYS = 30;
const BCRYPT_COST = 12;

export interface AuthedRequest extends Request {
  user?: UserRow;
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

function newToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function createSession(userId: number, ip?: string, ua?: string): string {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  db.prepare(
    'INSERT INTO sessions (token, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(token, userId, expiresAt, ip ?? null, ua ?? null);
  return token;
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function userFromSession(token: string): UserRow | null {
  // Explicit column list — deliberately excludes password_hash so the hash never
  // travels on req.user (defense-in-depth against accidentally serializing it).
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.custname, u.cust_desc, u.email, u.phone,
              u.status, u.created_at, u.last_login_at
       FROM users u
       JOIN sessions s ON s.user_id = u.id
       WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND u.status = 'active'`
    )
    .get(token) as UserRow | undefined;
  return row ?? null;
}

export function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader(
    'Set-Cookie',
    cookie.serialize(COOKIE_NAME, token, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_DAYS * 86400,
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

export function loadUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const raw = req.headers.cookie;
  if (raw) {
    const parsed = cookie.parse(raw);
    const token = parsed[COOKIE_NAME];
    if (token) {
      const user = userFromSession(token);
      if (user) req.user = user;
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
