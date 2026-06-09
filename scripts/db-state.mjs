// Quick read-only snapshot of the local SQLite app state.
//   node scripts/db-state.mjs
import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = path.join(process.env.DATA_DIR || './data', 'app.db');
const db = new Database(dbPath, { readonly: true });

const q = (sql) => { try { return db.prepare(sql).get(); } catch (e) { return { err: e.message }; } };
const all = (sql) => { try { return db.prepare(sql).all(); } catch (e) { return [{ err: e.message }]; } };

console.log('users:', JSON.stringify(all(`SELECT id, username, role, custname, cust_desc, status FROM users`)));
console.log('catalog_cache count:', JSON.stringify(q(`SELECT COUNT(*) c, SUM(active) active, SUM(b2b_visible) visible FROM catalog_cache`)));
console.log('customer_pricing count:', JSON.stringify(q(`SELECT COUNT(*) c, COUNT(DISTINCT custname) custs FROM customer_pricing`)));
console.log('orders_local count:', JSON.stringify(q(`SELECT COUNT(*) c FROM orders_local`)));
console.log('invites count:', JSON.stringify(q(`SELECT COUNT(*) c FROM invites`)));
console.log('leads count:', JSON.stringify(q(`SELECT COUNT(*) c FROM leads`)));
console.log('families sample:', JSON.stringify(all(`SELECT DISTINCT family, family_desc FROM catalog_cache WHERE family IS NOT NULL LIMIT 8`)));
console.log('catalog sample:', JSON.stringify(all(`SELECT partname, partdes, list_price, b2b_visible, image_url, b2b_image_path FROM catalog_cache LIMIT 5`)));
db.close();
