// DEV ONLY: seed a few past submitted orders for a user so the home dashboard,
// last-order card, and "usual basket" reorder have data to show locally without
// touching Priority. Idempotent-ish: tags seeded orders with details='SEED' and
// clears prior SEED orders for the user before inserting.
//
//   node scripts/seed-demo-orders.mjs <username>
//
import Database from 'better-sqlite3';
import path from 'node:path';

const username = process.argv[2] || 'smoketest';
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));

const user = db.prepare(`SELECT id, custname FROM users WHERE username = ?`).get(username);
if (!user) {
  console.error(`no such user: ${username}`);
  process.exit(1);
}

// Pick real catalog items (active + visible + priced) to make suggestions valid.
const parts = db
  .prepare(
    `SELECT partname, box_size FROM catalog_cache
     WHERE active = 1 AND b2b_visible = 1 AND list_price > 0
     ORDER BY b2b_sort_priority DESC, partname LIMIT 6`
  )
  .all();
if (parts.length < 3) {
  console.error('not enough priced catalog items to seed; run a catalog refresh first');
  process.exit(1);
}

// Clear previous seeds for this user.
const old = db.prepare(`SELECT id FROM orders_local WHERE user_id = ? AND details = 'SEED'`).all(user.id);
const delLines = db.prepare(`DELETE FROM order_lines WHERE order_id = ?`);
for (const o of old) delLines.run(o.id);
db.prepare(`DELETE FROM orders_local WHERE user_id = ? AND details = 'SEED'`).run(user.id);

const insOrder = db.prepare(
  `INSERT INTO orders_local (user_id, custname, priority_ordname, status, total, details, created_at, submitted_at)
   VALUES (?, ?, ?, 'submitted', ?, 'SEED', datetime('now', ?), datetime('now', ?))`
);
const insLine = db.prepare(
  `INSERT INTO order_lines (order_id, partname, pdes, quantity, price, is_promotion_freebie, promotion_id)
   VALUES (?, ?, ?, ?, ?, 0, NULL)`
);

// 3 past orders at -28d, -14d, -3d; the first 4 parts recur (→ "usual basket").
const schedule = [
  { ago: '-28 days', parts: parts.slice(0, 5) },
  { ago: '-14 days', parts: parts.slice(0, 4) },
  { ago: '-3 days', parts: parts.slice(0, 4) },
];

const priceOf = db.prepare(`SELECT list_price FROM catalog_cache WHERE partname = ?`);
const desOf = db.prepare(`SELECT partdes FROM catalog_cache WHERE partname = ?`);

let n = 0;
for (let i = 0; i < schedule.length; i++) {
  const s = schedule[i];
  let total = 0;
  const lines = s.parts.map((p) => {
    const price = priceOf.get(p.partname).list_price || 1;
    const qty = (p.box_size || 12) * (1 + (i % 2)); // vary quantities a bit
    total += price * qty;
    return { partname: p.partname, pdes: desOf.get(p.partname).partdes, qty, price };
  });
  const ordId = insOrder.run(
    user.id,
    user.custname,
    `DEMO-${1000 + i}`,
    Math.round(total * 100) / 100,
    s.ago,
    s.ago
  ).lastInsertRowid;
  for (const l of lines) insLine.run(ordId, l.partname, l.pdes, l.qty, l.price);
  n++;
}

console.log(`seeded ${n} demo orders for ${username} (custname ${user.custname}), ${parts.length} catalog items used`);
