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
      const familyDesc = family ? famMap.get(family) || null : null;
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
}

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

  const conds: string[] = ['c.active = 1', 'c.b2b_visible = 1'];
  const params: unknown[] = [];

  if (q.q && q.q.trim()) {
    const words = q.q.trim().split(/\s+/);
    for (const w of words) {
      conds.push(
        '(c.partdes LIKE ? OR c.partname LIKE ? OR c.barcode LIKE ? OR c.b2b_partdes_override LIKE ? OR c.b2b_tags LIKE ?)'
      );
      const like = `%${w}%`;
      params.push(like, like, like, like, like);
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

  const rows = db
    .prepare(
      `SELECT c.partname, c.partdes, c.family, c.family_desc, c.barcode, c.list_price, c.image_url, c.box_size,
              c.b2b_partdes_override, c.b2b_image_path, c.b2b_min_qty, c.b2b_featured, c.b2b_description,
              c.b2b_category_override,
              p.price AS personal_price
       FROM catalog_cache c
       LEFT JOIN customer_pricing p ON p.partname = c.partname AND p.custname = ?
       WHERE ${where}
       ORDER BY c.b2b_sort_priority DESC, c.partdes ASC
       LIMIT ? OFFSET ?`
    )
    .all(custname, ...params, pageSize, offset) as Array<{
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
    price: usePersonal ? r.personal_price ?? r.list_price : r.list_price,
  }));

  return { items, total };
}

export function getProduct(partname: string, custname: string | null): CatalogItem | null {
  const row = db
    .prepare(
      `SELECT c.partname, c.partdes, c.family, c.family_desc, c.barcode, c.list_price, c.image_url, c.box_size,
              c.b2b_partdes_override, c.b2b_image_path, c.b2b_min_qty, c.b2b_featured, c.b2b_description,
              c.b2b_category_override, c.b2b_visible, c.active,
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
        b2b_visible: number;
        active: number;
        personal_price: number | null;
      }
    | undefined;
  if (!row) return null;
  if (!row.active || !row.b2b_visible) return null;
  const usePersonal = getSettingBool('customer_pricing_enabled', false);
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
    price: usePersonal ? row.personal_price ?? row.list_price : row.list_price,
  };
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
