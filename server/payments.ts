// Check-photo payments: a customer photographs a cheque, the app records a
// promise-to-pay (amount + possibly-post-dated date), and the office reconciles
// it when the physical cheque arrives with the driver. This is NOT remote deposit
// capture and moves no money — the cheque is still collected and deposited
// normally. Cheque images contain bank-account numbers, so they are encrypted at
// rest (AES-256-GCM) on the volume and NEVER web-served — only streamed to the
// owning customer or an admin through an auth-gated route.

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { db } from './db.js';
import type { CheckExtraction } from './checkOcr.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const CHECKS_DIR = path.join(DATA_DIR, 'checks');
fs.mkdirSync(CHECKS_DIR, { recursive: true });

function imageKey(): Buffer | null {
  const hex = process.env.CHECK_IMAGE_KEY;
  if (!hex || hex.length < 64) return null;
  return Buffer.from(hex.slice(0, 64), 'hex');
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
  const blob = fs.readFileSync(imagePath);
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
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
  status: string;
  created_at: string;
  submitted_at: string | null;
}

/** Store the image (encrypted) + a draft row prefilled from AI extraction. */
export function createCheckDraft(
  userId: number,
  custname: string,
  imageBuffer: Buffer,
  ai: CheckExtraction | null
): { id: string; ai: CheckExtraction | null } {
  const id = crypto.randomBytes(12).toString('hex');
  const imagePath = encryptToFile(id, imageBuffer);
  db.prepare(
    `INSERT INTO payment_checks
       (id, user_id, custname, amount, check_date, is_postdated, bank, branch, account, check_number,
        image_path, ai_raw, ai_confidence, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`
  ).run(
    id,
    userId,
    custname,
    ai?.amount ?? null,
    ai?.date ?? null,
    ai?.is_postdated ? 1 : 0,
    ai?.bank ?? null,
    ai?.branch ?? null,
    ai?.account ?? null,
    ai?.check_number ?? null,
    imagePath,
    ai ? JSON.stringify(ai) : null,
    ai?.confidence ?? null
  );
  return { id, ai };
}

export interface ConfirmInput {
  amount: number;
  checkDate: string;
  isPostdated?: boolean;
  bank?: string;
  branch?: string;
  account?: string;
  checkNumber?: string;
  note?: string;
}

/** Customer confirms the (human-verified) details → promise-to-pay recorded. */
export function confirmCheck(userId: number, id: string, input: ConfirmInput): boolean {
  const info = db
    .prepare(
      `UPDATE payment_checks
         SET amount = ?, check_date = ?, is_postdated = ?, bank = ?, branch = ?, account = ?,
             check_number = ?, note = ?, status = 'submitted', submitted_at = datetime('now')
       WHERE id = ? AND user_id = ? AND status = 'draft'`
    )
    .run(
      input.amount,
      input.checkDate,
      input.isPostdated ? 1 : 0,
      input.bank ?? null,
      input.branch ?? null,
      input.account ?? null,
      input.checkNumber ?? null,
      (input.note ?? '').slice(0, 500) || null,
      id,
      userId
    );
  return info.changes > 0;
}

export function listChecksForUser(userId: number): CheckRow[] {
  return db
    .prepare(`SELECT * FROM payment_checks WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`)
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
  return db.prepare(`SELECT * FROM payment_checks ORDER BY created_at DESC LIMIT 500`).all() as CheckRow[];
}

export function getCheckAny(id: string): CheckRow | null {
  return (db.prepare(`SELECT * FROM payment_checks WHERE id = ?`).get(id) as CheckRow) ?? null;
}

const ADMIN_STATUSES = new Set(['received', 'deposited', 'bounced', 'cancelled', 'submitted']);
export function setCheckStatus(id: string, status: string): boolean {
  if (!ADMIN_STATUSES.has(status)) return false;
  return db.prepare(`UPDATE payment_checks SET status = ? WHERE id = ?`).run(status, id).changes > 0;
}
