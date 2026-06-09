// Invite tokens — admin creates, customer accepts to set username/password.

import crypto from 'node:crypto';
import { db } from './db.js';
import { hashPassword } from './auth.js';

const INVITE_TTL_DAYS = 14;

export interface InviteRow {
  token: string;
  custname: string;
  cust_desc: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export function createInvite(params: {
  custname: string;
  cust_desc?: string;
  email?: string;
  phone?: string;
  created_by?: number;
}): InviteRow {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86400_000).toISOString();
  db.prepare(
    `INSERT INTO invites (token, custname, cust_desc, email, phone, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    token,
    params.custname,
    params.cust_desc ?? null,
    params.email ?? null,
    params.phone ?? null,
    params.created_by ?? null,
    expiresAt
  );
  return db.prepare('SELECT * FROM invites WHERE token = ?').get(token) as InviteRow;
}

export function getInvite(token: string): InviteRow | null {
  const row = db
    .prepare(
      `SELECT * FROM invites WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
    )
    .get(token) as InviteRow | undefined;
  return row ?? null;
}

export async function acceptInvite(
  token: string,
  username: string,
  password: string
): Promise<{ userId: number; custname: string }> {
  const invite = getInvite(token);
  if (!invite) throw new Error('הזמנה לא תקפה או שפג תוקפה');

  // username uniqueness
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) throw new Error('שם משתמש כבר קיים');

  const hash = await hashPassword(password);
  const result = db
    .prepare(
      `INSERT INTO users (username, password_hash, role, custname, cust_desc, email, phone, status)
       VALUES (?, ?, 'customer', ?, ?, ?, ?, 'active')`
    )
    .run(username, hash, invite.custname, invite.cust_desc, invite.email, invite.phone);

  db.prepare(`UPDATE invites SET used_at = datetime('now') WHERE token = ?`).run(token);

  return { userId: result.lastInsertRowid as number, custname: invite.custname };
}

export function listInvites(): InviteRow[] {
  return db
    .prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200')
    .all() as InviteRow[];
}
