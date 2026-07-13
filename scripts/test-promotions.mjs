// Unit checks for the promotions engine — bogo/percent interaction and gift math.
// Run: npm run build && DATA_DIR=<scratch> node scripts/test-promotions.mjs
import assert from 'node:assert/strict';
import { applyPromotions } from '../dist/server/promotions.js';
import { db } from '../dist/server/db.js';

const promo = db.prepare('INSERT INTO promotions (name, type, params, active) VALUES (?, ?, ?, 1)');
promo.run('1+1 על P1', 'bogo', JSON.stringify({ partname: 'P1', buy: 1, free: 1 }));
promo.run('10% על ההזמנה', 'percent', JSON.stringify({ percent: 10, scope: 'order' }));

const lines = [
  { partname: 'P1', partdes: 'מוצר 1', quantity: 2, price: 10, line_total: 20 },
  { partname: 'P2', partdes: 'מוצר 2', quantity: 1, price: 30, line_total: 30 },
];

// bogo frees 1 unit of P1 (value 10). The 10% promo must discount only the PAID
// value (50 − 10 = 40 → 4), not the gross 50 (→ 5, the old bug).
const r = applyPromotions(lines, 'C-TEST');
assert.equal(r.subtotal, 50);
const bogo = r.applied.find((a) => a.type === 'bogo');
const pct = r.applied.find((a) => a.type === 'percent');
assert.equal(bogo.savings, 10);
assert.equal(pct.savings, 4, 'percent must apply to the net-of-bogo base');
assert.equal(r.discount, 14);
assert.equal(r.total, 36);
console.log('bogo+percent interaction: PASS');

// product-scope percent on the bogo SKU itself: base is the PAID part of the line only
promo.run('20% על P1', 'percent', JSON.stringify({ percent: 20, scope: 'product', target: 'P1' }));
const r2 = applyPromotions(lines, 'C-TEST');
const pct20 = r2.applied.find((a) => a.savings === 2); // 20% of paid 10, not of gross 20
assert.ok(pct20, 'product-scope percent uses the paid line value');
console.log('product-scope net base: PASS');

// gift: savings recorded as received value, NOT deducted from the total
db.prepare('DELETE FROM promotions').run();
promo.run('מתנה מעל 40', 'gift', JSON.stringify({ minSubtotal: 40, giftPartname: 'GIFT-1', giftQty: 2 }));
db.prepare("INSERT INTO catalog_cache (partname, partdes, list_price, active) VALUES ('GIFT-1','מתנה',5,1)").run();
const r3 = applyPromotions(lines, 'C-TEST');
assert.equal(r3.applied.find((a) => a.type === 'gift').savings, 10); // 2 × 5 gift value
assert.equal(r3.discount, 0, 'gift value must not reduce the payable total');
assert.equal(r3.total, 50);
assert.deepEqual(r3.gifts.map((g) => g.partname), ['GIFT-1']);
console.log('gift value not deducted: PASS');
