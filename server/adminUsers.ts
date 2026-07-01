// Admin customer/login management: create a login directly (no invite), reset a
// password, enable/disable. All callers are behind requireAdmin in index.ts.

import { db } from './db.js';
import { hashPassword, validatePassword, validateUsername, revokeOtherSessions, clearFailedLogins } from './auth.js';

export interface AdminUserView {
  id: number;
  username: string;
  role: string;
  custname: string | null;
  cust_desc: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: string;
  last_login_at: string | null;
}

export function listAllUsers(): AdminUserView[] {
  return db
    .prepare(
      `SELECT id, username, role, custname, cust_desc, email, phone, status, created_at, last_login_at
         FROM users ORDER BY created_at DESC LIMIT 1000`
    )
    .all() as AdminUserView[];
}

export interface CreateLoginInput {
  username: string;
  password: string;
  custname: string;
  cust_desc?: string;
  email?: string;
  phone?: string;
  customerRole?: string;
}

/** Create a customer login directly (active immediately, no invite). */
export async function createCustomerLogin(
  input: CreateLoginInput
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const username = (input.username || '').trim();
  const uErr = validateUsername(username);
  if (uErr) return { ok: false, error: uErr };
  const pErr = validatePassword(input.password || '', username);
  if (pErr) return { ok: false, error: pErr };
  const custname = (input.custname || '').trim();
  if (!custname) return { ok: false, error: 'יש להזין מספר לקוח (custname)' };
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
  if (exists) return { ok: false, error: 'שם המשתמש כבר קיים' };
  const customerRole: 'owner' | 'orderer' =
    input.customerRole === 'orderer' ? 'orderer' : 'owner';
  const hash = await hashPassword(input.password);
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, custname, cust_desc, email, phone, status, customer_role)
       VALUES (?, ?, 'customer', ?, ?, ?, ?, 'active', ?)`
    )
    .run(username, hash, custname, input.cust_desc?.trim() || null, input.email?.trim() || null, input.phone?.trim() || null, customerRole);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** Reset a user's password: revokes their other sessions + deletes their passkeys
 *  (same hygiene as self-service change-password). Refuses to touch admins. */
export async function resetUserPassword(
  userId: number,
  newPassword: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId) as
    | { id: number; username: string; role: string }
    | undefined;
  if (!user) return { ok: false, error: 'משתמש לא נמצא' };
  if (user.role === 'admin') return { ok: false, error: 'אין לאפס סיסמת מנהל מכאן' };
  const pErr = validatePassword(newPassword || '', user.username);
  if (pErr) return { ok: false, error: pErr };
  const hash = await hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
  clearFailedLogins(userId);
  revokeOtherSessions(userId); // no keepSessionId → kill all of the target's sessions
  db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(userId);
  return { ok: true };
}

/** Enable/disable a customer login. Admins are never disabled via this path
 *  (prevents an admin locking out all admins / themselves). */
export function setUserStatus(userId: number, status: 'active' | 'disabled'): { ok: boolean; error?: string } {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: string } | undefined;
  if (!user) return { ok: false, error: 'משתמש לא נמצא' };
  if (user.role === 'admin') return { ok: false, error: 'לא ניתן לשנות סטטוס של מנהל' };
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, userId);
  if (status === 'disabled') revokeOtherSessions(userId); // kill active sessions now
  return { ok: true };
}

/** Update a customer login's Priority custname and business name. Refuses admins. */
export function updateCustomerDetails(id: number, custname: string, custDesc: string | null): { ok: true } | { ok: false; error: string } {
  const cn = (custname || '').trim();
  if (!cn) return { ok: false, error: 'יש להזין מספר לקוח (custname)' };
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined;
  if (!u) return { ok: false, error: 'המשתמש לא נמצא' };
  if (u.role === 'admin') return { ok: false, error: 'לא ניתן לערוך מנהל' };
  db.prepare("UPDATE users SET custname = ?, cust_desc = ? WHERE id = ? AND role = 'customer'").run(cn, (custDesc || '').trim() || null, id);
  return { ok: true };
}

/** Delete a customer login. Sessions and related data cascade via FK. Refuses admins. */
export function deleteCustomerUser(id: number): { ok: true } | { ok: false; error: string } {
  const u = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role: string } | undefined;
  if (!u) return { ok: false, error: 'המשתמש לא נמצא' };
  if (u.role === 'admin') return { ok: false, error: 'לא ניתן למחוק מנהל' };
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'customer'").run(id);
  return { ok: true };
}
