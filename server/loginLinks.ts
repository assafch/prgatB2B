// Magic login links — admin-generated, reusable-until-expiry, one per user.
// Token is 128-bit random, stored ONLY as sha256 (same posture as sessions):
// a DB leak must not yield working links. Spec: 2026-07-06-magic-login-link.
import crypto from 'node:crypto';
import { db } from './db.js';

const LINK_TTL_DAYS = 14;

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Create (or replace — regenerating revokes the previous link) a login link. */
export function createLoginLink(userId: number, createdBy: number | null): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 86400_000).toISOString();
  db.prepare(
    `INSERT INTO login_links (user_id, token_hash, created_by, expires_at, last_used_at, use_count)
     VALUES (?, ?, ?, ?, NULL, 0)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_by = excluded.created_by,
       created_at = datetime('now'), expires_at = excluded.expires_at, last_used_at = NULL, use_count = 0`
  ).run(userId, hash(token), createdBy, expiresAt);
  return { token, expiresAt };
}

/** Revoke a user's login link (if any). Called on password reset / user disable —
 *  a credential rotation must kill EVERY standing way into the account, and a live
 *  magic link is exactly that. */
export function revokeLoginLink(userId: number): void {
  db.prepare('DELETE FROM login_links WHERE user_id = ?').run(userId);
}

/** Redeem (NOT consumed — reusable until expiry). Null unless the link is live
 *  and its user is an active customer. Admin accounts never redeem. */
export function redeemLoginLink(token: string): { userId: number } | null {
  if (!/^[0-9a-f]{32}$/.test(token || '')) return null;
  const row = db
    .prepare(
      `SELECT l.user_id FROM login_links l
       JOIN users u ON u.id = l.user_id
       WHERE l.token_hash = ? AND datetime(l.expires_at) > datetime('now')
         AND u.status = 'active' AND u.role = 'customer'`
    )
    .get(hash(token)) as { user_id: number } | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE login_links SET use_count = use_count + 1, last_used_at = datetime('now') WHERE user_id = ?`
  ).run(row.user_id);
  return { userId: row.user_id };
}
