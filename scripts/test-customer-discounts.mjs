// Unit checks for the customer-discount engine. Run: node scripts/test-customer-discounts.mjs
import assert from 'node:assert/strict';
import { applyDiscount, deriveDominantPercent } from '../dist/server/discounts.js';

// applyDiscount — rounding and guard rails
assert.equal(applyDiscount(14.5, 15), 12.33);   // 14.5 × 0.85 = 12.325 → 12.33
assert.equal(applyDiscount(15.5, 10), 13.95);
assert.equal(applyDiscount(14.5, null), 14.5);  // no discount
assert.equal(applyDiscount(14.5, 0), 14.5);     // zero = none
assert.equal(applyDiscount(14.5, 61), 14.5);    // out of sanity range (>60) = ignored
assert.equal(applyDiscount(14.5, -5), 14.5);    // negative = ignored
assert.equal(applyDiscount(14.5, 100), 14.5);   // never free

// deriveDominantPercent — most frequent valid percent wins
assert.equal(deriveDominantPercent([{ percent: 15 }, { percent: 15 }, { percent: 0 }]), 15);
assert.equal(deriveDominantPercent([{ percent: 10 }, { percent: 15 }, { percent: 10 }]), 10);
assert.equal(deriveDominantPercent([{ percent: 0 }, { percent: 0 }]), null);   // no real discount
assert.equal(deriveDominantPercent([]), null);
assert.equal(deriveDominantPercent([{ percent: 90 }]), null);                  // out of range
assert.equal(deriveDominantPercent([{ percent: 15 }, { percent: 10 }]), 15);   // tie → first-seen (newest lines first)
console.log('discount engine: ALL PASS');

// DB-backed resolve (runs against the temp DATA_DIR the runner sets)
import { resolveDiscountPercent } from '../dist/server/discounts.js';
import Database from 'better-sqlite3';
import path from 'node:path';
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('C-15','15','orders')").run();
db.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('C-MANUAL','7.5','manual')").run();
db.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('C-BAD','95','orders')").run();
db.close();
assert.equal(resolveDiscountPercent('C-15'), 15);
assert.equal(resolveDiscountPercent('C-MANUAL'), 7.5);
assert.equal(resolveDiscountPercent('C-BAD'), null);    // out-of-range stored value is ignored
assert.equal(resolveDiscountPercent('NOBODY'), null);
assert.equal(resolveDiscountPercent(null), null);
console.log('resolveDiscountPercent: ALL PASS');
