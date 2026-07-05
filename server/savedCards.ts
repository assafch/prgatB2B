// Saved-card vault (Phase 1: one PayPlus token per user, captured on consent).
// The raw PSP token never leaves this module unencrypted — callers only ever see
// the non-secret display fields (brand/four digits/expiry).
import crypto from 'node:crypto';
import { db } from './db.js';
import { encryptToken } from './tokenVault.js';

export interface SavedCardRow {
  id: string;
  brand: string | null;
  four_digits: string | null;
  expiry_month: string | null;
  expiry_year: string | null;
  created_at: string;
}

/** Replace this user's saved card (one per user) with the card used on `tx`. Always
 *  clears the old row first — even when the new token can't be stored — so a stale
 *  card is never left behind. Skips the insert (warns) when `encryptToken` can't
 *  produce ciphertext (vault key not configured / tx has no tokenUid): a plaintext
 *  token must never be persisted. */
export function upsertSavedCard(
  userId: number,
  custname: string,
  tx: { tokenUid: string | null; brand: string | null; fourDigits: string | null; expiryMonth: string | null; expiryYear: string | null }
): void {
  db.prepare('DELETE FROM saved_cards WHERE user_id = ?').run(userId);
  if (!tx.tokenUid) {
    console.warn('[savedCards] no tokenUid on tx — skipping save for user', userId);
    return;
  }
  const encrypted = encryptToken(tx.tokenUid);
  if (!encrypted) {
    console.warn('[savedCards] encryptToken returned null (vault key not configured) — skipping save for user', userId);
    return;
  }
  const id = crypto.randomBytes(12).toString('hex');
  db.prepare(
    `INSERT INTO saved_cards (id, user_id, custname, token, brand, four_digits, expiry_month, expiry_year, consented_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(id, userId, custname, encrypted, tx.brand, tx.fourDigits, tx.expiryMonth, tx.expiryYear);
}

/** The user's saved card — display fields only, never the token. */
export function getSavedCard(userId: number): SavedCardRow | null {
  return (
    (db
      .prepare(`SELECT id, brand, four_digits, expiry_month, expiry_year, created_at FROM saved_cards WHERE user_id = ?`)
      .get(userId) as SavedCardRow | undefined) ?? null
  );
}

export function deleteSavedCard(userId: number): void {
  db.prepare('DELETE FROM saved_cards WHERE user_id = ?').run(userId);
}
