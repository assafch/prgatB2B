// Check-photo payments: a customer photographs a cheque, the app records a
// promise-to-pay (amount + possibly-post-dated date), and the office deposits it
// digitally via the Chex app. This moves no money itself.
//
// Data protection: the cheque image is the sensitive artifact (it carries the
// full bank-account + CMC-7 MICR line), so the NORMALISED image (EXIF/GPS
// stripped) is AES-256-GCM encrypted at rest on the volume and NEVER web-served —
// only streamed to the owning customer or an admin via an auth-gated route. We
// deliberately do NOT persist the full account number or the raw AI JSON in the
// (plaintext) SQLite DB / backups — only a masked last-4 — so a DB/backup leak
// never exposes account numbers. The full number lives solely in the encrypted
// image. Abandoned drafts (and their image files) are swept after a short TTL,
// and cancelling a cheque erases its image.

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { db } from './db.js';
import type { CheckExtraction } from './checkOcr.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const CHECKS_DIR = path.join(DATA_DIR, 'checks');
fs.mkdirSync(CHECKS_DIR, { recursive: true });

const DRAFT_TTL_HOURS = 48;

/** Israeli cheques are presentable for 6 months from their written date; older ones
 *  banks may refuse. Such a photo is a debt promise for the office, never an
 *  auto-approval instrument. */
export const STALE_CHECK_DAYS = 180;

export function isStaleCheckDate(checkDate: string | null): boolean {
  if (!checkDate || !/^\d{4}-\d{2}-\d{2}$/.test(checkDate)) return false;
  const t = Date.parse(checkDate + 'T00:00:00Z');
  return isFinite(t) && Date.now() - t > STALE_CHECK_DAYS * 86400_000;
}

function imageKey(): Buffer | null {
  const hex = (process.env.CHECK_IMAGE_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null; // require exactly 32 bytes of hex
  return Buffer.from(hex, 'hex');
}

/** True when a valid image-encryption key is configured. */
export function imageStorageEnabled(): boolean {
  return imageKey() !== null;
}

/** Keep only the last 4 digits of the account for reconciliation hints; the full
 *  number is never stored in the DB (it lives only in the encrypted image). */
function maskAccount(account: string | null | undefined): string | null {
  if (!account) return null;
  const digits = account.replace(/\D/g, '');
  return digits.length >= 4 ? '****' + digits.slice(-4) : null;
}

function encryptToFile(id: string, plain: Buffer): string | null {
  const key = imageKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const file = path.join(CHECKS_DIR, `${id}.enc`);
  fs.writeFileSync(file, Buffer.concat([iv, tag, enc])); // [12 iv][16 tag][ciphertext]
  return file;
}

export function decryptCheckImage(imagePath: string): Buffer | null {
  const key = imageKey();
  if (!key || !fs.existsSync(imagePath)) return null;
  try {
    const blob = fs.readFileSync(imagePath);
    const iv = blob.subarray(0, 12);
    const tag = blob.subarray(12, 28);
    const enc = blob.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (err) {
    // Corrupted/truncated blob or a rotated/wrong key → treat as "not available".
    console.warn('[payments] decrypt failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

function unlinkImage(imagePath: string | null): void {
  if (!imagePath) return;
  try {
    fs.unlinkSync(imagePath);
  } catch {
    /* already gone */
  }
}

export interface CheckRow {
  id: string;
  user_id: number;
  custname: string;
  amount: number | null;
  check_date: string | null;
  is_postdated: number;
  bank: string | null;
  branch: string | null;
  account: string | null;
  check_number: string | null;
  note: string | null;
  image_path: string | null;
  ai_raw: string | null;
  ai_confidence: number | null;
  amount_verified: number; // 1 iff the confirmed amount was capped against a real OCR reading
  status: string;
  created_at: string;
  submitted_at: string | null;
}

/** Store the NORMALISED image (encrypted) + a draft row prefilled from AI
 *  extraction. Returns imageStored=false if no storage key is configured (the
 *  caller should treat that as a hard error — we must retain the deposit image). */
export function createCheckDraft(
  userId: number,
  custname: string,
  imageBuffer: Buffer,
  ai: CheckExtraction | null
): { id: string; imageStored: boolean } {
  const id = crypto.randomBytes(12).toString('hex');
  const imagePath = encryptToFile(id, imageBuffer);
  db.prepare(
    `INSERT INTO payment_checks
       (id, user_id, custname, amount, check_date, is_postdated, bank, branch, account, check_number,
        image_path, ai_raw, ai_confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'draft')`
  ).run(
    id,
    userId,
    custname,
    ai?.amount ?? null,
    ai?.date ?? null,
    ai?.is_postdated ? 1 : 0,
    ai?.bank ?? null,
    ai?.branch ?? null,
    maskAccount(ai?.account), // masked last-4 only; full number never hits the DB
    ai?.check_number ?? null,
    imagePath,
    ai?.confidence ?? null
  );
  return { id, imageStored: imagePath !== null };
}

export interface ConfirmInput {
  amount: number;
  checkDate: string;
  bank?: string;
  branch?: string;
  account?: string;
  checkNumber?: string;
  note?: string;
}

const localToday = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });

/** Customer confirms the (human-verified) details → promise-to-pay recorded.
 *  The confirmed amount/date are NOT taken on trust: the draft row still holds
 *  the AI-extracted values (createCheckDraft prefilled amount/check_date/
 *  is_postdated from OCR, and this UPDATE is the first thing to overwrite them),
 *  so we read that OCR baseline first and let the customer only CORRECT a misread
 *  DOWNWARD — never inflate the cheque beyond what the photo shows, nor downgrade
 *  an OCR-asserted post-dated cheque to current-dated, nor re-date an OCR-stale
 *  cheque forward into freshness. is_postdated is always derived server-side
 *  (never trusted from the client) and account is re-masked. */
export function confirmCheck(userId: number, id: string, input: ConfirmInput): boolean {
  const draft = db
    .prepare(
      `SELECT amount AS aiAmount, check_date AS aiDate, is_postdated AS aiPostdated
         FROM payment_checks WHERE id = ? AND user_id = ? AND status = 'draft'`
    )
    .get(id, userId) as { aiAmount: number | null; aiDate: string | null; aiPostdated: number } | undefined;
  if (!draft) return false;

  const today = localToday();

  // Date: if OCR already read a stale date (>6 months old), the customer cannot
  // re-date the cheque forward by editing the prefilled field — that's the same
  // "typed input beats the photo" hole the amount-cap closes for amount. A cheque
  // that photographs as stale stays stale no matter what the confirm form says.
  // If OCR read no date (aiDate null), there is nothing to pin against, so the
  // customer-entered date is used as before.
  const checkDate = draft.aiDate != null && isStaleCheckDate(draft.aiDate) ? draft.aiDate : input.checkDate;

  // Amount: cap to the AI-extracted value. At/below the extracted amount is a
  // legitimate correction; above it is treated as inflation and clamped down to
  // what the photo shows — so a ₪1 (or illegible) cheque photo can never drive a
  // ₪12,000 auto-approval / debt-offset. If OCR read no amount (aiAmount null),
  // there is nothing to cap against (see follow-up note in the report).
  let amount = input.amount;
  // amountVerified is 1 only when OCR extracted a real amount to cap against. When it's
  // 0 (OCR read nothing / non-cheque image / OCR unavailable) the amount is unverified
  // client input — still fine to record as a debt promise, but payHeldOrderByCheck must
  // refuse to auto-approve a held order from such a cheque.
  const amountVerified = draft.aiAmount != null && draft.aiAmount > 0 ? 1 : 0;
  if (amountVerified && amount > draft.aiAmount! + 0.01) {
    amount = draft.aiAmount!;
  }

  // Post-dated: derive from the confirmed date, but never let the client clear an
  // OCR-asserted post-dated flag (or a future date the model read). A post-dated
  // cheque presented as current-dated must stay flagged so it can't cover a held
  // order or offset an overdue-debt block.
  const aiPostdated = draft.aiPostdated === 1 || (draft.aiDate != null && draft.aiDate > today);
  const isPostdated = checkDate > today || aiPostdated ? 1 : 0;

  const info = db
    .prepare(
      `UPDATE payment_checks
         SET amount = ?, check_date = ?, is_postdated = ?, amount_verified = ?,
             bank = COALESCE(?, bank), branch = COALESCE(?, branch),
             account = COALESCE(?, account), check_number = COALESCE(?, check_number),
             note = ?, status = 'submitted', submitted_at = datetime('now')
       WHERE id = ? AND user_id = ? AND status = 'draft'`
    )
    .run(
      amount,
      checkDate,
      isPostdated,
      amountVerified,
      input.bank?.slice(0, 80) ?? null,
      input.branch?.slice(0, 40) ?? null,
      maskAccount(input.account),
      input.checkNumber?.slice(0, 40) ?? null,
      (input.note ?? '').slice(0, 500) || null,
      id,
      userId
    );
  return info.changes > 0;
}

// Customer-facing list: hide abandoned drafts AND cancelled/void cheques (a
// cancelled payment is a resolved non-event — only admins keep it for audit).
// The status filter is applied BEFORE the LIMIT so real cheques can't be pushed
// out of the window.
export function listChecksForUser(userId: number): CheckRow[] {
  return db
    .prepare(
      `SELECT * FROM payment_checks WHERE user_id = ? AND status NOT IN ('draft', 'cancelled')
        ORDER BY created_at DESC LIMIT 200`
    )
    .all(userId) as CheckRow[];
}

export function getCheckForUser(userId: number, id: string): CheckRow | null {
  return (
    (db.prepare(`SELECT * FROM payment_checks WHERE id = ? AND user_id = ?`).get(id, userId) as CheckRow) ?? null
  );
}

// --- admin (reconciliation) ---
export function listAllChecks(status?: string): CheckRow[] {
  if (status) {
    return db
      .prepare(`SELECT * FROM payment_checks WHERE status = ? ORDER BY created_at DESC LIMIT 500`)
      .all(status) as CheckRow[];
  }
  return db
    .prepare(`SELECT * FROM payment_checks WHERE status != 'draft' ORDER BY created_at DESC LIMIT 500`)
    .all() as CheckRow[];
}

export function getCheckAny(id: string): CheckRow | null {
  return (db.prepare(`SELECT * FROM payment_checks WHERE id = ?`).get(id) as CheckRow) ?? null;
}

const ADMIN_STATUSES = new Set(['received', 'deposited', 'bounced', 'cancelled', 'submitted']);
export function setCheckStatus(id: string, status: string): boolean {
  if (!ADMIN_STATUSES.has(status)) return false;
  // Only reconcilable (already-submitted) cheques can be transitioned — never a
  // never-confirmed draft (whose amount is the untrusted AI value).
  const info = db.prepare(`UPDATE payment_checks SET status = ? WHERE id = ? AND status != 'draft'`).run(status, id);
  if (info.changes > 0 && status === 'cancelled') {
    // Data minimisation: erase the image once the cheque is cancelled.
    const row = db.prepare(`SELECT image_path FROM payment_checks WHERE id = ?`).get(id) as { image_path: string | null } | undefined;
    unlinkImage(row?.image_path ?? null);
    db.prepare(`UPDATE payment_checks SET image_path = NULL WHERE id = ?`).run(id);
  }
  return info.changes > 0;
}

/** Sweep abandoned drafts: delete rows older than the TTL and unlink their image
 *  files. Mirrors the session/challenge sweeps. */
export function sweepDraftChecks(): number {
  const stale = db
    .prepare(
      `SELECT id, image_path FROM payment_checks
        WHERE status = 'draft' AND created_at < datetime('now', ?)`
    )
    .all(`-${DRAFT_TTL_HOURS} hours`) as Array<{ id: string; image_path: string | null }>;
  for (const r of stale) unlinkImage(r.image_path);
  if (stale.length) {
    const del = db.prepare(`DELETE FROM payment_checks WHERE id = ?`);
    const tx = db.transaction((rows: typeof stale) => rows.forEach((r) => del.run(r.id)));
    tx(stale);
  }
  return stale.length;
}
