// Per-store staff logins: an OWNER creates/manages additional 'orderer' logins
// bound to the owner's own custname. Orderers can browse + order but never reach
// finance/payments (requireOwner). All scoped to the owner's custname.

import { db } from './db.js';
import { hashPassword, validateUsername, validatePassword, revokeOtherSessions, clearFailedLogins } from './auth.js';

export interface StaffView {
  id: number;
  username: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
}

export function listStaff(custname: string): StaffView[] {
  return db
    .prepare(
      `SELECT id, username, status, created_at, last_login_at
         FROM users WHERE custname = ? AND role = 'customer' AND customer_role = 'orderer'
        ORDER BY created_at DESC`
    )
    .all(custname) as StaffView[];
}

export async function createStaff(
  custname: string,
  custDesc: string | null,
  username: string,
  password: string
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const u = (username || '').trim();
  const uErr = validateUsername(u);
  if (uErr) return { ok: false, error: uErr };
  const pErr = validatePassword(password || '', u);
  if (pErr) return { ok: false, error: pErr };
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(u)) return { ok: false, error: 'שם המשתמש כבר קיים' };
  const hash = await hashPassword(password);
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, customer_role, custname, cust_desc, status)
       VALUES (?, ?, 'customer', 'orderer', ?, ?, 'active')`
    )
    .run(u, hash, custname, custDesc);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/** Guarded so an owner can only touch staff under their OWN custname. */
function ownStaff(custname: string, id: number): { role: string; customer_role: string } | undefined {
  return db
    .prepare(`SELECT role, customer_role FROM users WHERE id = ? AND custname = ? AND customer_role = 'orderer'`)
    .get(id, custname) as { role: string; customer_role: string } | undefined;
}

export function setStaffStatus(custname: string, id: number, status: 'active' | 'disabled'): boolean {
  if (!ownStaff(custname, id)) return false;
  db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, id);
  if (status === 'disabled') revokeOtherSessions(id);
  return true;
}

export async function resetStaffPassword(custname: string, id: number, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const staff = ownStaff(custname, id);
  if (!staff) return { ok: false, error: 'משתמש לא נמצא' };
  const username = (db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string }).username;
  const pErr = validatePassword(newPassword || '', username);
  if (pErr) return { ok: false, error: pErr };
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), id);
  clearFailedLogins(id);
  revokeOtherSessions(id);
  return { ok: true };
}
