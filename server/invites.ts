// Invite tokens — admin creates, customer accepts to set username/password.

import crypto from 'node:crypto';
import { db } from './db.js';
import { hashPassword } from './auth.js';

const INVITE_TTL_DAYS = 14;

// Tokens are stored ONLY as sha256 (same posture as sessions and login links): a DB
// leak must not yield working invites — an unused invite mints credentials for its
// custname. The raw token exists only in the URL returned at creation time, so the
// admin list cannot re-display old links (create a fresh invite instead).
const sha256 = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

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
    sha256(token),
    params.custname,
    params.cust_desc ?? null,
    params.email ?? null,
    params.phone ?? null,
    params.created_by ?? null,
    expiresAt
  );
  const row = db.prepare('SELECT * FROM invites WHERE token = ?').get(sha256(token)) as InviteRow;
  // The caller builds the invite URL from `token` — return the RAW one (its only copy).
  return { ...row, token };
}

export function getInvite(token: string): InviteRow | null {
  const row = db
    .prepare(
      `SELECT * FROM invites WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')`
    )
    .get(sha256(token)) as InviteRow | undefined;
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

  // bcrypt yields the event loop, so do it BEFORE the atomic section (no side effects).
  const hash = await hashPassword(password);

  // Claim the invite and create the user in ONE synchronous transaction so two
  // requests racing the same token can't both create an account. The conditional
  // UPDATE (used_at IS NULL) is the single-use gate: only the claimer with
  // changes===1 proceeds; if the INSERT then fails (e.g. username taken) the whole
  // transaction rolls back and the invite stays usable.
  const tokenHash = sha256(token);
  const claimAndCreate = db.transaction(() => {
    const claimed = db
      .prepare(`UPDATE invites SET used_at = datetime('now') WHERE token = ? AND used_at IS NULL`)
      .run(tokenHash);
    if (claimed.changes !== 1) throw new Error('ההזמנה כבר נוצלה');
    const result = db
      .prepare(
        `INSERT INTO users (username, password_hash, role, custname, cust_desc, email, phone, status)
         VALUES (?, ?, 'customer', ?, ?, ?, ?, 'active')`
      )
      .run(username, hash, invite.custname, invite.cust_desc, invite.email, invite.phone);
    return result.lastInsertRowid as number;
  });

  return { userId: claimAndCreate(), custname: invite.custname };
}

/** Admin list — token hashes are deliberately NOT returned (they'd be useless for
 *  link-building anyway; the raw token is shown once, at creation). */
export function listInvites(): Omit<InviteRow, 'token'>[] {
  return db
    .prepare(
      'SELECT custname, cust_desc, email, phone, created_at, expires_at, used_at FROM invites ORDER BY created_at DESC LIMIT 200'
    )
    .all() as Omit<InviteRow, 'token'>[];
}
