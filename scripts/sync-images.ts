// Dev helper: pull product images from Priority into catalog_cache.image_url.
//   node --env-file=.env --import tsx scripts/sync-images.ts
import { db } from '../server/db.js';
import { syncProductImagesFromPriority } from '../server/catalog.js';

db.pragma('busy_timeout = 8000'); // tolerate the dev server holding the same DB

const t0 = Date.now();
const r = await syncProductImagesFromPriority();
console.log('image sync result:', JSON.stringify(r, null, 2));

const linked = db
  .prepare("SELECT COUNT(*) c FROM catalog_cache WHERE image_url LIKE '/uploads/prio_%'")
  .get() as { c: number };
console.log(`catalog_cache rows now linked to a Priority image: ${linked.c}`);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(0);
