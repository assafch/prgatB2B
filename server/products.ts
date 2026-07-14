// Admin product control panel — CRUD over catalog_cache overrides, image upload, CSV import/export.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { db } from './db.js';
import multer from 'multer';
import sharp from 'sharp';
import Papa from 'papaparse';
import { fireStockAlerts } from './stockAlerts.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB
});

// Restocks discovered by patchProduct while a transaction is open (batchUpdate)
// can't fire push right away — the row could still roll back. They're queued
// here and drained by the caller once the transaction has actually committed.
const pendingRestocks: string[] = [];

export interface AdminProductRow {
  partname: string;
  partdes: string | null;
  family: string | null;
  family_desc: string | null;
  barcode: string | null;
  list_price: number | null;
  box_size: number;
  active: number;
  b2b_visible: number;
  b2b_partdes_override: string | null;
  b2b_description: string | null;
  b2b_image_path: string | null;
  b2b_tags: string | null;
  b2b_min_qty: number | null;
  b2b_sort_priority: number;
  b2b_featured: number;
  b2b_category_override: string | null;
  b2b_out_of_stock: number;
  b2b_is_new: number;
  b2b_new_since: string | null;
  updated_at: string;
}

export interface ListQuery {
  q?: string;
  family?: string;
  status?: 'all' | 'visible' | 'hidden' | 'no_image' | 'inactive';
  page?: number;
  pageSize?: number;
}

export function listProductsAdmin(q: ListQuery): { items: AdminProductRow[]; total: number } {
  const page = Math.max(1, q.page || 1);
  const pageSize = Math.min(200, Math.max(20, q.pageSize || 50));
  const offset = (page - 1) * pageSize;

  const conds: string[] = [];
  const params: unknown[] = [];

  if (q.q && q.q.trim()) {
    const words = q.q.trim().split(/\s+/);
    for (const w of words) {
      conds.push(
        '(partdes LIKE ? OR partname LIKE ? OR barcode LIKE ? OR b2b_partdes_override LIKE ? OR b2b_tags LIKE ?)'
      );
      const like = `%${w}%`;
      params.push(like, like, like, like, like);
    }
  }
  if (q.family && q.family.trim()) {
    conds.push('family = ?');
    params.push(q.family.trim());
  }
  switch (q.status || 'all') {
    case 'visible':
      conds.push('b2b_visible = 1 AND active = 1');
      break;
    case 'hidden':
      conds.push('b2b_visible = 0');
      break;
    case 'no_image':
      conds.push('(b2b_image_path IS NULL OR b2b_image_path = "")');
      break;
    case 'inactive':
      conds.push('active = 0');
      break;
  }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM catalog_cache ${where}`).get(...params) as {
    c: number;
  }).c;

  const items = db
    .prepare(
      `SELECT partname, partdes, family, family_desc, barcode, list_price, box_size, active,
              b2b_visible, b2b_partdes_override, b2b_description, b2b_image_path, b2b_tags,
              b2b_min_qty, b2b_sort_priority, b2b_featured, b2b_category_override, b2b_out_of_stock,
              b2b_is_new, b2b_new_since, updated_at
       FROM catalog_cache
       ${where}
       ORDER BY b2b_sort_priority DESC, partdes ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset) as AdminProductRow[];

  return { items, total };
}

export function getProductAdmin(partname: string): AdminProductRow | null {
  return (db
    .prepare(
      `SELECT partname, partdes, family, family_desc, barcode, list_price, box_size, active,
              b2b_visible, b2b_partdes_override, b2b_description, b2b_image_path, b2b_tags,
              b2b_min_qty, b2b_sort_priority, b2b_featured, b2b_category_override, b2b_out_of_stock,
              b2b_is_new, b2b_new_since, updated_at
       FROM catalog_cache WHERE partname = ?`
    )
    .get(partname) as AdminProductRow | undefined) ?? null;
}

const PATCHABLE_COLUMNS = new Set([
  'b2b_visible',
  'b2b_partdes_override',
  'b2b_description',
  'b2b_tags',
  'b2b_min_qty',
  'b2b_sort_priority',
  'b2b_featured',
  'b2b_category_override',
  'b2b_out_of_stock',
  'b2b_is_new',
  'box_size',
]);

export function patchProduct(partname: string, patch: Record<string, unknown>): AdminProductRow | null {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE_COLUMNS.has(k)) continue;
    cols.push(`${k} = ?`);
    // Normalize booleans → 0/1; empty strings → NULL for nullable columns.
    if (typeof v === 'boolean') {
      vals.push(v ? 1 : 0);
    } else if (v === '' || v === undefined) {
      vals.push(null);
    } else {
      vals.push(v);
    }
  }
  // Flipping b2b_is_new manages its companion stamp: 0→1 stamps b2b_new_since
  // (orders the home rail newest-first), 1→0 clears it. Same-value saves leave
  // the stamp alone so an edited product doesn't jump to the front of the rail.
  if ('b2b_is_new' in patch) {
    const cur = db.prepare('SELECT b2b_is_new FROM catalog_cache WHERE partname = ?').get(partname) as
      | { b2b_is_new: number } | undefined;
    const next = patch.b2b_is_new ? 1 : 0;
    if (cur && cur.b2b_is_new !== next) {
      cols.push(next ? "b2b_new_since = datetime('now')" : 'b2b_new_since = NULL');
    }
  }
  // b2b_out_of_stock 1→0 is a restock: fire back-in-stock alerts after the write.
  let restocked = false;
  if ('b2b_out_of_stock' in patch && !patch.b2b_out_of_stock) {
    const cur = db.prepare('SELECT b2b_out_of_stock FROM catalog_cache WHERE partname = ?').get(partname) as
      | { b2b_out_of_stock: number } | undefined;
    restocked = !!cur?.b2b_out_of_stock;
  }
  if (cols.length === 0) return getProductAdmin(partname);
  cols.push("updated_at = datetime('now')");
  vals.push(partname);
  db.prepare(`UPDATE catalog_cache SET ${cols.join(', ')} WHERE partname = ?`).run(...vals);
  // Mid-transaction (batchUpdate), don't push yet — the row could still roll
  // back. Queue it; the transaction owner fires only after commit.
  if (restocked) {
    if (db.inTransaction) {
      pendingRestocks.push(partname);
    } else {
      fireStockAlerts([partname]);
    }
  }
  return getProductAdmin(partname);
}

/** Apply per-row edits to many products in ONE transaction. Each item is
 *  { partname, ...patch } where patch is filtered by the same PATCHABLE_COLUMNS
 *  whitelist + normalization as patchProduct. Used by the inline-edit table's
 *  batch save. Returns how many rows carried a whitelisted change. */
export function batchUpdate(items: Array<Record<string, unknown>>): number {
  if (!Array.isArray(items)) return 0;
  let changed = 0;
  const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const partname = typeof row?.partname === 'string' ? row.partname.trim() : '';
      if (!partname) continue;
      const { partname: _ignore, ...patch } = row;
      if (!Object.keys(patch).some((k) => PATCHABLE_COLUMNS.has(k))) continue;
      patchProduct(partname, patch);
      changed++;
    }
  });
  // Fire restock alerts only once the transaction has committed. On failure
  // (e.g. a later row's malformed value throws a bind error and the whole
  // batch rolls back) drop the queue instead — no push for changes that
  // never landed.
  let committed = false;
  try {
    tx(items.slice(0, 2000)); // backstop cap
    committed = true;
  } finally {
    const parts = pendingRestocks.splice(0);
    if (committed && parts.length) fireStockAlerts(parts);
  }
  return changed;
}

export async function saveImage(
  partname: string,
  buffer: Buffer
): Promise<{ image_path: string }> {
  // Validate input is a real image; transcode to webp at ~800px wide.
  const safe = partname.replace(/[^A-Za-z0-9_-]/g, '_');
  const hash = crypto.randomBytes(4).toString('hex');
  const filename = `${safe}_${hash}.webp`;
  const fullPath = path.join(UPLOADS_DIR, filename);
  await sharp(buffer).rotate().resize({ width: 800, withoutEnlargement: true }).webp({ quality: 82 }).toFile(fullPath);

  // Remove previous image if any
  const prev = (db.prepare('SELECT b2b_image_path FROM catalog_cache WHERE partname = ?').get(partname) as
    | { b2b_image_path: string | null }
    | undefined)?.b2b_image_path;
  if (prev) {
    const prevFull = path.join(UPLOADS_DIR, path.basename(prev));
    fs.promises.unlink(prevFull).catch(() => {});
  }

  const relative = `/uploads/${filename}`;
  db.prepare(
    `UPDATE catalog_cache SET b2b_image_path = ?, updated_at = datetime('now') WHERE partname = ?`
  ).run(relative, partname);
  return { image_path: relative };
}

export function deleteImage(partname: string): void {
  const row = db
    .prepare('SELECT b2b_image_path FROM catalog_cache WHERE partname = ?')
    .get(partname) as { b2b_image_path: string | null } | undefined;
  if (row?.b2b_image_path) {
    const fullPath = path.join(UPLOADS_DIR, path.basename(row.b2b_image_path));
    fs.promises.unlink(fullPath).catch(() => {});
  }
  db.prepare(
    `UPDATE catalog_cache SET b2b_image_path = NULL, updated_at = datetime('now') WHERE partname = ?`
  ).run(partname);
}

/** Promotion card image: same transcode pipeline as product images, but
 *  content-addressed and not tied to a product row — the URL lives in the
 *  promotion's params.imageUrl. Re-uploading identical content is a no-op. */
export async function savePromoImage(buffer: Buffer): Promise<{ url: string }> {
  const out = await sharp(buffer)
    .rotate()
    .resize({ width: 800, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const hash = crypto.createHash('sha1').update(out).digest('hex').slice(0, 16);
  const filename = `promo_${hash}.webp`;
  await fs.promises.writeFile(path.join(UPLOADS_DIR, filename), out);
  return { url: `/uploads/${filename}` };
}

export interface BulkPayload {
  partnames: string[];
  action: 'hide' | 'show' | 'set_box_size' | 'set_min_qty' | 'feature' | 'unfeature' | 'mark_out_of_stock' | 'mark_in_stock' | 'mark_new' | 'unmark_new';
  value?: number;
}

export function bulkUpdate(payload: BulkPayload): number {
  if (!Array.isArray(payload.partnames) || payload.partnames.length === 0) return 0;
  const placeholders = payload.partnames.map(() => '?').join(',');
  // Snapshot which products are actually restocking so alerts fire once, post-update.
  const restocking: string[] =
    payload.action === 'mark_in_stock'
      ? (db
          .prepare(`SELECT partname FROM catalog_cache WHERE partname IN (${placeholders}) AND b2b_out_of_stock = 1`)
          .all(...payload.partnames) as Array<{ partname: string }>).map((r) => r.partname)
      : [];
  let setClause = '';
  const setVals: unknown[] = [];
  switch (payload.action) {
    case 'hide':
      setClause = 'b2b_visible = 0';
      break;
    case 'show':
      setClause = 'b2b_visible = 1';
      break;
    case 'feature':
      setClause = 'b2b_featured = 1';
      break;
    case 'unfeature':
      setClause = 'b2b_featured = 0';
      break;
    case 'mark_out_of_stock':
      setClause = 'b2b_out_of_stock = 1';
      break;
    case 'mark_in_stock':
      setClause = 'b2b_out_of_stock = 0';
      break;
    case 'mark_new':
      setClause = "b2b_is_new = 1, b2b_new_since = datetime('now')";
      break;
    case 'unmark_new':
      setClause = 'b2b_is_new = 0, b2b_new_since = NULL';
      break;
    case 'set_box_size':
      if (!Number.isFinite(payload.value) || (payload.value ?? 0) <= 0) return 0;
      setClause = 'box_size = ?';
      setVals.push(payload.value);
      break;
    case 'set_min_qty':
      if (!Number.isFinite(payload.value) || (payload.value ?? 0) < 0) return 0;
      setClause = 'b2b_min_qty = ?';
      setVals.push(payload.value);
      break;
    default:
      return 0;
  }
  const result = db
    .prepare(
      `UPDATE catalog_cache SET ${setClause}, updated_at = datetime('now')
       WHERE partname IN (${placeholders})`
    )
    .run(...setVals, ...payload.partnames);
  if (restocking.length > 0) fireStockAlerts(restocking);
  return result.changes;
}

const CSV_COLUMNS = [
  'partname',
  'partdes',
  'family',
  'family_desc',
  'barcode',
  'list_price',
  'box_size',
  'b2b_visible',
  'b2b_partdes_override',
  'b2b_description',
  'b2b_image_path',
  'b2b_tags',
  'b2b_min_qty',
  'b2b_sort_priority',
  'b2b_featured',
  'b2b_category_override',
  'b2b_out_of_stock',
];

export function exportCsv(): string {
  const rows = db.prepare(`SELECT ${CSV_COLUMNS.join(',')} FROM catalog_cache ORDER BY partname`).all();
  return Papa.unparse(rows as object[], { columns: CSV_COLUMNS });
}

export interface ImportResult {
  updated: number;
  skipped: number;
  errors: string[];
}

export function importCsv(text: string, dryRun: boolean): ImportResult {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const errors = parsed.errors.map((e) => `${e.row ?? '?'}: ${e.message}`).slice(0, 20);
  let updated = 0;
  let skipped = 0;

  const exists = db.prepare('SELECT 1 FROM catalog_cache WHERE partname = ?');

  const run = db.transaction((rows: Record<string, string>[]) => {
    for (const row of rows) {
      const partname = String(row.partname || '').trim();
      if (!partname) {
        skipped++;
        continue;
      }
      if (!exists.get(partname)) {
        skipped++;
        continue;
      }
      const patch: Record<string, unknown> = {};
      // A non-numeric cell (e.g. "6 יח", "1,5") used to become NaN → SQLite binds it as
      // NULL: silently clearing b2b_min_qty, or blowing up box_size's NOT NULL only on the
      // real run (never in the dry run). Reject a bad number here so it's reported in BOTH
      // passes and the rest of the import isn't aborted. `badNum` is true → skip the row.
      let badNum = false;
      const numCell = (raw: string, label: string): number | undefined => {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          if (errors.length < 50) errors.push(`${partname}: ערך לא מספרי בעמודה ${label}: "${raw}"`);
          badNum = true;
          return undefined;
        }
        return n;
      };
      if ('box_size' in row && row.box_size !== '') patch.box_size = numCell(row.box_size, 'box_size');
      if ('b2b_visible' in row && row.b2b_visible !== '')
        patch.b2b_visible = ['1', 'true', 'yes', 'y'].includes(row.b2b_visible.toLowerCase()) ? 1 : 0;
      if ('b2b_partdes_override' in row) patch.b2b_partdes_override = row.b2b_partdes_override || null;
      if ('b2b_description' in row) patch.b2b_description = row.b2b_description || null;
      if ('b2b_tags' in row) patch.b2b_tags = row.b2b_tags || null;
      if ('b2b_min_qty' in row && row.b2b_min_qty !== '') patch.b2b_min_qty = numCell(row.b2b_min_qty, 'b2b_min_qty');
      if ('b2b_sort_priority' in row && row.b2b_sort_priority !== '')
        patch.b2b_sort_priority = numCell(row.b2b_sort_priority, 'b2b_sort_priority');
      if (badNum) {
        skipped++;
        continue;
      }
      if ('b2b_featured' in row && row.b2b_featured !== '')
        patch.b2b_featured = ['1', 'true', 'yes', 'y'].includes(row.b2b_featured.toLowerCase()) ? 1 : 0;
      if ('b2b_category_override' in row) patch.b2b_category_override = row.b2b_category_override || null;
      if ('b2b_out_of_stock' in row && row.b2b_out_of_stock !== '')
        patch.b2b_out_of_stock = ['1', 'true', 'yes', 'y'].includes(row.b2b_out_of_stock.toLowerCase()) ? 1 : 0;

      if (Object.keys(patch).length === 0) {
        skipped++;
        continue;
      }
      const cols = Object.keys(patch).map((k) => `${k} = ?`);
      const vals = Object.values(patch);
      if (!dryRun) {
        db.prepare(
          `UPDATE catalog_cache SET ${cols.join(', ')}, updated_at = datetime('now') WHERE partname = ?`
        ).run(...vals, partname);
      }
      updated++;
    }
  });
  run(parsed.data);
  return { updated, skipped, errors };
}

export { UPLOADS_DIR };
