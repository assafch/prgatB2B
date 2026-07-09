// Catalog: full refresh of LOGPART + FAMILY_LOG into catalog_cache.
// Customer-specific pricing: derived from their recent ORDERS history.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { db, getSettingBool } from './db.js';
import {
  getPriorityConfig,
  listProducts,
  listFamilies,
  getCustomerLastPrices,
  listProductImages,
} from './priority.js';
import { UPLOADS_DIR } from './products.js';
import { resolveDiscountPercent, applyDiscount } from './discounts.js';

/** Effective selling price for this customer: base list price minus their flat
 *  discount (flag-gated). Resolve the percent ONCE per request, not per row. */
function effectivePrice(listPrice: number | null, pct: number | null): number | null {
  return listPrice != null ? applyDiscount(listPrice, pct) : null;
}

export interface CatalogRow {
  partname: string;
  partdes: string | null;
  family: string | null;
  family_desc: string | null;
  barcode: string | null;
  list_price: number | null;
  stock: number | null;
  image_url: string | null;
  active: number;
  updated_at: string;
}

export interface ImageSyncResult {
  scanned: number; // parts Priority returned with an inline data: image
  written: number; // images newly transcoded + linked into catalog_cache
  unchanged: number; // already linked to the same image content
  failed: number; // decode / transcode errors (skipped)
}

export async function refreshCatalogFromPriority(): Promise<{
  products: number;
  families: number;
  images?: ImageSyncResult;
}> {
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');

  const products = await listProducts(config);
  // Families are only category labels — if FAMILY_LOG isn't API-enabled for the
  // API user it must not block the whole product sync (per-form degradation).
  let families: Awaited<ReturnType<typeof listFamilies>> = [];
  try {
    families = await listFamilies(config);
  } catch (err) {
    console.warn('[catalog] families (FAMILY_LOG) unavailable — products only:', err instanceof Error ? err.message : err);
  }
  const famMap = new Map<string, string>();
  for (const f of families) {
    famMap.set(String(f.FAMILYNAME || '').trim(), String(f.FAMILYDESC || '').trim());
  }

  const tx = db.transaction((items: typeof products) => {
    const upsert = db.prepare(`
      INSERT INTO catalog_cache (partname, partdes, family, family_desc, barcode, list_price, active, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(partname) DO UPDATE SET
        partdes = excluded.partdes,
        family = excluded.family,
        family_desc = excluded.family_desc,
        barcode = excluded.barcode,
        list_price = excluded.list_price,
        active = excluded.active,
        updated_at = datetime('now')
    `);
    for (const p of items) {
      const partname = String(p.PARTNAME || '').trim();
      if (!partname) continue;
      const family = String(p.FAMILYNAME || '').trim() || null;
      // Hebrew family name is on LOGPART.FAMILYDES directly (FAMILY_LOG is API-disabled).
      const familyDesc = String(p.FAMILYDES || '').trim() || (family ? famMap.get(family) || null : null);
      // Show only SELLABLE parts. Priority statuses on this tenant: "פעיל" (active),
      // "לא פעיל" (inactive), "אסור למכירה" (forbidden for sale) — hide anything that
      // isn't explicitly active. Keep an empty/unknown status visible so a future
      // form/permission change can't silently empty the whole catalog.
      const stat = String(p.STATDES || '').trim();
      const active = !stat || stat === 'פעיל' ? 1 : 0;
      upsert.run(
        partname,
        String(p.PARTDES || '').trim() || null,
        family,
        familyDesc,
        String(p.BARCODE || '').trim() || null,
        // Selling base price = מחיר מחירון בסיס (BASEPLPRICE, before VAT). LASTPRICE
        // is the last transaction price (near cost) and must NOT be shown to customers.
        typeof p.BASEPLPRICE === 'number' && p.BASEPLPRICE > 0 ? p.BASEPLPRICE : null,
        active
      );
    }
  });
  tx(products);

  // Pull product images too. Non-fatal: a failure here must not break the
  // (more important) price/description refresh.
  let images: ImageSyncResult | undefined;
  try {
    images = await syncProductImagesFromPriority();
  } catch (err) {
    console.error('[catalog] product image sync failed:', err);
  }

  return { products: products.length, families: families.length, images };
}

const DATA_URI_RE = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;

// Product images live inline on LOGPART.EXTFILENAME as base64 data URIs. Pull them,
// transcode each to a content-addressed WebP under /uploads (same pipeline as admin
// uploads — shrinks ~250KB PNGs dramatically), and point catalog_cache.image_url at it.
// Admin-uploaded images (b2b_image_path) still win in queryCatalog, so this never
// clobbers a manual override. Content-hashed filenames make re-runs cheap/idempotent.
export async function syncProductImagesFromPriority(): Promise<ImageSyncResult> {
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');

  const rows = await listProductImages(config);
  const result: ImageSyncResult = { scanned: rows.length, written: 0, unchanged: 0, failed: 0 };

  const getCur = db.prepare('SELECT image_url FROM catalog_cache WHERE partname = ?');
  const setUrl = db.prepare(
    `UPDATE catalog_cache SET image_url = ?, updated_at = datetime('now') WHERE partname = ?`
  );

  for (const row of rows) {
    const partname = String(row.PARTNAME || '').trim();
    if (!partname) continue;
    const m = DATA_URI_RE.exec(String(row.EXTFILENAME || '').trim());
    if (!m) continue;

    let buf: Buffer;
    try {
      buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    } catch {
      result.failed++;
      continue;
    }
    if (buf.length === 0) {
      result.failed++;
      continue;
    }

    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const safe = partname.replace(/[^A-Za-z0-9_-]/g, '_');
    const filename = `prio_${safe}_${hash}.webp`;
    const relative = `/uploads/${filename}`;
    const fullPath = path.join(UPLOADS_DIR, filename);

    const cur = (getCur.get(partname) as { image_url: string | null } | undefined)?.image_url ?? null;
    if (cur === relative && fs.existsSync(fullPath)) {
      result.unchanged++;
      continue;
    }

    try {
      if (!fs.existsSync(fullPath)) {
        await sharp(buf)
          .rotate()
          .resize({ width: 800, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toFile(fullPath);
      }
      const info = setUrl.run(relative, partname);
      if (info.changes > 0) {
        // Drop the part's previous Priority-sourced image (leave admin uploads alone).
        if (cur && cur !== relative && /\/uploads\/prio_/.test(cur)) {
          fs.promises.unlink(path.join(UPLOADS_DIR, path.basename(cur))).catch(() => {});
        }
        result.written++;
      } else {
        // Part isn't in catalog_cache (e.g. images synced before a catalog refresh).
        // Remove the orphan file we just wrote.
        fs.promises.unlink(fullPath).catch(() => {});
      }
    } catch {
      result.failed++;
    }
  }

  return result;
}

export async function refreshCustomerPricing(custname: string): Promise<number> {
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');
  const prices = await getCustomerLastPrices(config, custname);
  const tx = db.transaction(() => {
    const upsert = db.prepare(`
      INSERT INTO customer_pricing (custname, partname, price, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(custname, partname) DO UPDATE SET
        price = excluded.price,
        updated_at = datetime('now')
    `);
    for (const [partname, price] of Object.entries(prices)) {
      upsert.run(custname, partname, price);
    }
  });
  tx();
  return Object.keys(prices).length;
}

export interface CatalogQuery {
  q?: string;
  family?: string;
  page?: number;
  pageSize?: number;
  sort?: 'family';
}

export interface CatalogItem {
  partname: string;
  partdes: string | null;
  family: string | null;
  family_desc: string | null;
  barcode: string | null;
  list_price: number | null;
  price: number | null;
  image_url: string | null;
  box_size: number;
  min_qty: number;
  featured: number;
  description: string | null;
  /** true → "אזל מהמלאי": shown grayed, cannot be added to the cart. The customer
   *  never sees a numeric stock level — only this boolean. */
  outOfStock: boolean;
  /** true → admin flagged "מוצר חדש": shows the catalog pill + the home rail. */
  isNew: boolean;
}

/** Single source of truth for product availability. Today: the manual admin
 *  override only. FUTURE (out of scope): also treat Priority numeric `stock` <= 0
 *  as out of stock, with the manual override winning. Keep this the only place the
 *  rule lives — together with its SQL twin OOS_SQL below — so that change is local. */
export function isOutOfStock(row: { b2b_out_of_stock: number }): boolean {
  return row.b2b_out_of_stock === 1;
}

/** SQL twin of isOutOfStock() for ORDER BY in queryCatalog (catalog_cache alias `c`).
 *  Evaluates to 0/1 and must express the same rule — when the FUTURE numeric-stock
 *  clause lands in isOutOfStock(), OR it in here too, or sorting will silently
 *  disagree with what the product card shows. */
export const OOS_SQL = '(c.b2b_out_of_stock = 1)';

export function queryCatalog(
  custname: string | null,
  q: CatalogQuery
): { items: CatalogItem[]; total: number } {
  const page = Math.max(1, q.page || 1);
  const pageSize = Math.min(100, Math.max(10, q.pageSize || 50));
  const offset = (page - 1) * pageSize;
  // Per-customer pricing is OFF for now (admin choice): everyone sees the base
  // מחירון price. Flip the 'customer_pricing_enabled' setting to re-enable the
  // per-customer override later.
  const usePersonal = getSettingBool('customer_pricing_enabled', false);
  const discountPct = getSettingBool('discount_pricing_enabled', false) ? resolveDiscountPercent(custname) : null;

  const conds: string[] = ['c.active = 1', 'c.b2b_visible = 1'];
  const params: unknown[] = []; // WHERE params
  const scoreParams: unknown[] = []; // params for the relevance score in SELECT
  let scoreSelect = '';
  let orderPrefix = '';

  // One searchable haystack: description, name, B2B override, barcode, tags, family.
  const HAY =
    "(COALESCE(c.partdes,'') || ' ' || c.partname || ' ' || COALESCE(c.b2b_partdes_override,'') || ' ' || COALESCE(c.barcode,'') || ' ' || COALESCE(c.b2b_tags,'') || ' ' || COALESCE(c.family_desc,''))";

  if (q.q && q.q.trim()) {
    const words = q.q.trim().split(/\s+/).filter((w) => w.length >= 2);
    if (words.length) {
      // Match ANY word — natural-language descriptors that aren't in the catalog
      // text (e.g. "קטן", "שקוף") must not zero out a real product. Then rank by how
      // many words each product matches, so the closest hits come first.
      conds.push('(' + words.map(() => `${HAY} LIKE ?`).join(' OR ') + ')');
      for (const w of words) params.push(`%${w}%`);
      if (q.sort !== 'family') {
        scoreSelect = ', (' + words.map(() => `(CASE WHEN ${HAY} LIKE ? THEN 1 ELSE 0 END)`).join(' + ') + ') AS _score';
        for (const w of words) scoreParams.push(`%${w}%`);
        orderPrefix = '_score DESC, ';
      }
    } else {
      conds.push(`${HAY} LIKE ?`);
      params.push(`%${q.q.trim()}%`);
    }
  }
  if (q.family && q.family.trim()) {
    // Honor the B2B category override when set, else Priority family.
    conds.push('(c.family = ? OR c.b2b_category_override = ?)');
    params.push(q.family.trim(), q.family.trim());
  }

  const where = conds.join(' AND ');
  const totalRow = db
    .prepare(`SELECT COUNT(*) as c FROM catalog_cache c WHERE ${where}`)
    .get(...params) as { c: number };
  const total = totalRow.c;

  // "אזל מהמלאי" sinks to the end of its family group (grouped view) / the end of
  // the list (flat + family-filtered views). Placed after the family keys — including
  // the family CODE tiebreaker, which keeps codes contiguous even if two codes share
  // a description (the client groups by code) — and after the search score, so a
  // relevant-but-out-of-stock hit still shows near its match rank.
  const oosLast = getSettingBool('oos_sort_bottom_enabled', true) ? `${OOS_SQL} ASC, ` : '';

  const rows = db
    .prepare(
      `SELECT c.partname, c.partdes, c.family, c.family_desc, c.barcode, c.list_price, c.image_url, c.box_size,
              c.b2b_partdes_override, c.b2b_image_path, c.b2b_min_qty, c.b2b_featured, c.b2b_description,
              c.b2b_category_override, c.b2b_out_of_stock, c.b2b_is_new,
              p.price AS personal_price${scoreSelect}
       FROM catalog_cache c
       LEFT JOIN customer_pricing p ON p.partname = c.partname AND p.custname = ?
       WHERE ${where}
       ORDER BY ${orderPrefix}${q.sort === 'family' ? `c.family_desc IS NULL, c.family_desc COLLATE NOCASE ASC, c.family ASC, ${oosLast}c.partdes COLLATE NOCASE ASC` : `${oosLast}c.b2b_sort_priority DESC, c.partdes ASC`}
       LIMIT ? OFFSET ?`
    )
    .all(...scoreParams, custname, ...params, pageSize, offset) as Array<{
      partname: string;
      partdes: string | null;
      family: string | null;
      family_desc: string | null;
      barcode: string | null;
      list_price: number | null;
      image_url: string | null;
      box_size: number;
      b2b_partdes_override: string | null;
      b2b_image_path: string | null;
      b2b_min_qty: number | null;
      b2b_featured: number;
      b2b_description: string | null;
      b2b_category_override: string | null;
      b2b_out_of_stock: number;
      b2b_is_new: number;
      personal_price: number | null;
    }>;

  const items: CatalogItem[] = rows.map((r) => ({
    partname: r.partname,
    partdes: r.b2b_partdes_override || r.partdes,
    family: r.b2b_category_override || r.family,
    family_desc: r.family_desc,
    barcode: r.barcode,
    list_price: r.list_price,
    image_url: r.b2b_image_path || r.image_url,
    box_size: r.box_size,
    min_qty: r.b2b_min_qty ?? r.box_size,
    featured: r.b2b_featured,
    description: r.b2b_description,
    price: usePersonal ? r.personal_price ?? r.list_price : effectivePrice(r.list_price, discountPct),
    outOfStock: isOutOfStock(r),
    isNew: r.b2b_is_new === 1,
  }));

  return { items, total };
}

export function getProduct(partname: string, custname: string | null): CatalogItem | null {
  const row = db
    .prepare(
      `SELECT c.partname, c.partdes, c.family, c.family_desc, c.barcode, c.list_price, c.image_url, c.box_size,
              c.b2b_partdes_override, c.b2b_image_path, c.b2b_min_qty, c.b2b_featured, c.b2b_description,
              c.b2b_category_override, c.b2b_out_of_stock, c.b2b_is_new, c.b2b_visible, c.active,
              p.price AS personal_price
       FROM catalog_cache c
       LEFT JOIN customer_pricing p ON p.partname = c.partname AND p.custname = ?
       WHERE c.partname = ?`
    )
    .get(custname, partname) as
    | {
        partname: string;
        partdes: string | null;
        family: string | null;
        family_desc: string | null;
        barcode: string | null;
        list_price: number | null;
        image_url: string | null;
        box_size: number;
        b2b_partdes_override: string | null;
        b2b_image_path: string | null;
        b2b_min_qty: number | null;
        b2b_featured: number;
        b2b_description: string | null;
        b2b_category_override: string | null;
        b2b_out_of_stock: number;
        b2b_is_new: number;
        b2b_visible: number;
        active: number;
        personal_price: number | null;
      }
    | undefined;
  if (!row) return null;
  if (!row.active || !row.b2b_visible) return null;
  const usePersonal = getSettingBool('customer_pricing_enabled', false);
  const discountPct = getSettingBool('discount_pricing_enabled', false) ? resolveDiscountPercent(custname) : null;
  return {
    partname: row.partname,
    partdes: row.b2b_partdes_override || row.partdes,
    family: row.b2b_category_override || row.family,
    family_desc: row.family_desc,
    barcode: row.barcode,
    list_price: row.list_price,
    image_url: row.b2b_image_path || row.image_url,
    box_size: row.box_size,
    min_qty: row.b2b_min_qty ?? row.box_size,
    featured: row.b2b_featured,
    description: row.b2b_description,
    price: usePersonal ? row.personal_price ?? row.list_price : effectivePrice(row.list_price, discountPct),
    outOfStock: isOutOfStock(row),
    isNew: row.b2b_is_new === 1,
  };
}

/** Exact barcode lookup for the scanner. Returns the sellable product or null. */
export function findByBarcode(barcode: string, custname: string | null): CatalogItem | null {
  const code = (barcode || '').trim();
  if (!code) return null;
  const row = db.prepare('SELECT partname FROM catalog_cache WHERE barcode = ? LIMIT 1').get(code) as { partname: string } | undefined;
  return row ? getProduct(row.partname, custname) : null;
}

/** Same-family products (excluding the given one) for the "מוצרים דומים" rail. */
export function getSimilarProducts(partname: string, custname: string | null, limit = 8): CatalogItem[] {
  const row = db.prepare('SELECT family, b2b_category_override FROM catalog_cache WHERE partname = ?').get(partname) as
    | { family: string | null; b2b_category_override: string | null }
    | undefined;
  const fam = row?.b2b_category_override || row?.family;
  if (!fam) return [];
  const { items } = queryCatalog(custname, { family: fam, page: 1, pageSize: limit + 1 });
  return items.filter((i) => i.partname !== partname).slice(0, limit);
}

export function listFamiliesLocal(): Array<{ family: string; family_desc: string | null; count: number }> {
  return db
    .prepare(
      `SELECT family, family_desc, COUNT(*) as count
       FROM catalog_cache
       WHERE active = 1 AND b2b_visible = 1 AND family IS NOT NULL
       GROUP BY family, family_desc
       ORDER BY family_desc, family`
    )
    .all() as Array<{ family: string; family_desc: string | null; count: number }>;
}

/** Home-rail "מוצרים חדשים": admin-flagged products, newest stamp first. Runs each
 *  candidate through getProduct so pricing/visibility/OOS rules stay in ONE place.
 *  Scans all flagged candidates in order until limit eligible ones are found. The set
 *  of flagged products is admin-curated and small, so an unbounded candidate scan is fine. */
export function listNewProducts(custname: string | null, limit = 12): CatalogItem[] {
  const rows = db
    .prepare(
      `SELECT partname FROM catalog_cache
       WHERE b2b_is_new = 1 AND active = 1 AND b2b_visible = 1
       ORDER BY b2b_new_since DESC, updated_at DESC`
    )
    .all() as { partname: string }[];
  const out: CatalogItem[] = [];
  for (const r of rows) {
    const p = getProduct(r.partname, custname);
    if (!p || p.outOfStock || typeof p.price !== 'number' || p.price <= 0) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
