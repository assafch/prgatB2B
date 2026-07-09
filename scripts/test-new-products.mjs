// Unit checks for the new-products rail data layer.
// Run: npm run build && DATA_DIR=<scratch> node scripts/test-new-products.mjs
import assert from 'node:assert/strict';
import { listNewProducts, getProduct } from '../dist/server/catalog.js';
import { patchProduct } from '../dist/server/products.js';
import Database from 'better-sqlite3';
import path from 'node:path';

const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
const seed = db.prepare(
  `INSERT INTO catalog_cache (partname, partdes, list_price, active) VALUES (?, ?, ?, ?)`
);
seed.run('N-OK', 'חדש תקין', 50, 1);
seed.run('N-HIDDEN', 'חדש מוסתר', 50, 1);
seed.run('N-INACTIVE', 'חדש לא פעיל', 50, 0);
seed.run('N-OOS', 'חדש אזל', 50, 1);
seed.run('N-NOPRICE', 'חדש בלי מחיר', null, 1);
seed.run('N-OLD', 'ישן', 50, 1);
db.prepare("UPDATE catalog_cache SET b2b_visible = 0 WHERE partname = 'N-HIDDEN'").run();
db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 1 WHERE partname = 'N-OOS'").run();
db.close();

// patchProduct flips the flag and stamps b2b_new_since
for (const p of ['N-OK', 'N-HIDDEN', 'N-INACTIVE', 'N-OOS', 'N-NOPRICE']) patchProduct(p, { b2b_is_new: true });
const db2 = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
const since = db2.prepare("SELECT b2b_new_since FROM catalog_cache WHERE partname = 'N-OK'").get().b2b_new_since;
assert.ok(since, 'b2b_new_since stamped on 0→1');

// re-saving the SAME value must NOT restamp (no jumping to the front)
patchProduct('N-OK', { b2b_is_new: true, b2b_description: 'עודכן' });
assert.equal(
  db2.prepare("SELECT b2b_new_since FROM catalog_cache WHERE partname = 'N-OK'").get().b2b_new_since,
  since,
  'unchanged flag keeps its stamp'
);

// unflagging clears the stamp
patchProduct('N-NOPRICE', { b2b_is_new: false });
assert.equal(db2.prepare("SELECT b2b_new_since FROM catalog_cache WHERE partname = 'N-NOPRICE'").get().b2b_new_since, null);
patchProduct('N-NOPRICE', { b2b_is_new: true }); // back on (still excluded below — no price)

// isNew surfaces on CatalogItem
assert.equal(getProduct('N-OK', null).isNew, true);
assert.equal(getProduct('N-OLD', null).isNew, false);

// the rail query: only visible+active+in-stock+priced flagged products
const rail = listNewProducts(null);
assert.deepEqual(rail.map((p) => p.partname), ['N-OK'], 'hidden/inactive/OOS/unpriced/unflagged all excluded');

// ordering: explicit stamps, newest first. Dated in 2030 (not 2026) so these
// override stamps stay "newest" relative to the real datetime('now') stamps
// still sitting on N-OOS/N-NOPRICE from the flagging loop above — otherwise the
// limit*2 over-fetch window below could exhaust itself on real-clock-stamped
// junk rows before ever reaching N-OK/N-OLD.
db2.prepare("UPDATE catalog_cache SET b2b_is_new = 1, b2b_new_since = '2030-01-01 00:00:00' WHERE partname = 'N-OLD'").run();
db2.prepare("UPDATE catalog_cache SET b2b_new_since = '2030-02-01 00:00:00' WHERE partname = 'N-OK'").run();
db2.close();
assert.deepEqual(listNewProducts(null).map((p) => p.partname), ['N-OK', 'N-OLD'], 'ordered b2b_new_since DESC');
assert.deepEqual(listNewProducts(null, 1).map((p) => p.partname), ['N-OK'], 'limit respected');

console.log('new-products data layer: ALL PASS');
