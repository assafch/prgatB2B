// Remove catalog rows that do NOT exist in the live Priority LOGPART set
// (e.g. demo seed like COKE-15 / קוקה קולה). Compares against Priority — naming
// is not a reliable signal (real parts like PZ-58 also have dashes).
//   node --env-file=.env scripts/clean-nonpriority.mjs           # dry run: list only
//   node --env-file=.env scripts/clean-nonpriority.mjs --apply   # delete
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');
const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
if (!baseUrl || !company || !pat) { console.error('Missing PRIORITY_* env'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');

// 1. Pull the authoritative PARTNAME set from Priority (paginated).
async function priorityPartnames() {
  const set = new Set();
  let skip = 0;
  const top = 500;
  while (true) {
    const url = `${baseUrl}/${company}/LOGPART?$select=PARTNAME&$top=${top}&$skip=${skip}`;
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Priority LOGPART ${res.status}`);
    const json = await res.json();
    const batch = json.value || [];
    for (const r of batch) { const n = String(r.PARTNAME ?? '').trim(); if (n) set.add(n); }
    if (batch.length < top) break;
    skip += top;
  }
  return set;
}

const prio = await priorityPartnames();
console.log(`Priority LOGPART: ${prio.size} parts`);
// SAFETY: never wipe the catalog because of a bad/empty API response.
if (prio.size < 50) { console.error(`Refusing to proceed — Priority returned only ${prio.size} parts (looks wrong).`); process.exit(1); }

const dbPath = path.join(process.env.DATA_DIR || './data', 'app.db');
const db = new Database(dbPath);
db.pragma('busy_timeout = 8000');

const rows = db.prepare(`SELECT partname, partdes, image_url, b2b_image_path FROM catalog_cache`).all();
const orphans = rows.filter((r) => !prio.has(String(r.partname).trim()));

console.log(`catalog_cache: ${rows.length} rows | not in Priority: ${orphans.length}`);
console.log('--- rows that will be removed ---');
for (const o of orphans) console.log(`  ${o.partname}  —  ${o.partdes ?? ''}`);

if (!APPLY) {
  console.log(`\nDRY RUN. Re-run with --apply to delete these ${orphans.length} rows.`);
  db.close();
  process.exit(0);
}

// 2. Delete orphans + their customer_pricing; unlink any image files they own.
const delCatalog = db.prepare(`DELETE FROM catalog_cache WHERE partname = ?`);
const delPricing = db.prepare(`DELETE FROM customer_pricing WHERE partname = ?`);
let pricingDeleted = 0, filesUnlinked = 0;
const UPLOADS_DIR = path.join(process.env.DATA_DIR || './data', 'uploads');

const tx = db.transaction((list) => {
  for (const o of list) {
    pricingDeleted += delPricing.run(o.partname).changes;
    delCatalog.run(o.partname);
  }
});
tx(orphans);

// Unlink image files outside the txn (filesystem side-effects).
for (const o of orphans) {
  for (const p of [o.image_url, o.b2b_image_path]) {
    if (p && p.startsWith('/uploads/')) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(p))); filesUnlinked++; } catch { /* missing is fine */ }
    }
  }
}

const remaining = db.prepare(`SELECT COUNT(*) c FROM catalog_cache`).get().c;
console.log(`\nDELETED ${orphans.length} catalog rows, ${pricingDeleted} pricing rows, ${filesUnlinked} image files.`);
console.log(`catalog_cache now: ${remaining} rows.`);
db.close();
