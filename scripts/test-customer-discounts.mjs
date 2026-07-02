// Unit checks for the customer-discount engine. Run: node scripts/test-customer-discounts.mjs
import assert from 'node:assert/strict';
import { applyDiscount, deriveDominantPercent, applyDerivedDiscount } from '../dist/server/discounts.js';

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

// Catalog integration: flag ON + percent stored → price is discounted, list_price untouched
import { getProduct } from '../dist/server/catalog.js';
import { setSettingBool } from '../dist/server/db.js';
const db4 = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db4.prepare(`INSERT OR REPLACE INTO catalog_cache (partname, partdes, list_price, active, b2b_visible, box_size)
             VALUES ('TEST-D1','מוצר בדיקה',14.5,1,1,1)`).run();
db4.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('C-15','15','orders')").run();
db4.close();
setSettingBool('discount_pricing_enabled', false);
assert.equal(getProduct('TEST-D1', 'C-15').price, 14.5);          // flag off → base price
setSettingBool('discount_pricing_enabled', true);
assert.equal(getProduct('TEST-D1', 'C-15').price, 12.33);         // flag on → discounted
assert.equal(getProduct('TEST-D1', 'C-15').list_price, 14.5);     // base always intact
assert.equal(getProduct('TEST-D1', 'NOBODY').price, 14.5);        // no discount row → base
setSettingBool('discount_pricing_enabled', false);
console.log('catalog discount integration: ALL PASS');

// applyDerivedDiscount — upsert / revocation / hiccup-guard / manual-protection semantics
const db5 = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));

// upsert: fresh customer, valid dominant percent → row created, resolves to it
db5.prepare("DELETE FROM customer_discounts WHERE custname = 'AD-UPSERT'").run();
assert.equal(applyDerivedDiscount('AD-UPSERT', [{ percent: 10 }, { percent: 10 }]), 10);
assert.equal(resolveDiscountPercent('AD-UPSERT'), 10);

// revocation: real recent lines exist but none carries a valid discount → 'orders' row deleted
db5.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('AD-REVOKE','15','orders')").run();
assert.equal(applyDerivedDiscount('AD-REVOKE', [{ percent: 0 }, { percent: 0 }]), null);
assert.equal(resolveDiscountPercent('AD-REVOKE'), null);

// hiccup guard: empty lines (no orders / API hiccup) → existing 'orders' row left untouched
db5.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('AD-HICCUP','15','orders')").run();
assert.equal(applyDerivedDiscount('AD-HICCUP', []), null);
assert.equal(resolveDiscountPercent('AD-HICCUP'), 15);

// manual protection: a 'manual' row must never be overwritten or deleted by derived sync
db5.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('AD-MANUAL','7.5','manual')").run();
applyDerivedDiscount('AD-MANUAL', [{ percent: 10 }]);
assert.equal(resolveDiscountPercent('AD-MANUAL'), 7.5);
const manualRow = db5.prepare("SELECT percent, source FROM customer_discounts WHERE custname = 'AD-MANUAL'").get();
assert.equal(manualRow.source, 'manual');
assert.equal(manualRow.percent, 7.5);

// manual zero: a pinned 'manual' 0 row resolves to "no discount" (isValidPercent rejects 0)
db5.prepare("INSERT OR REPLACE INTO customer_discounts (custname, percent, source) VALUES ('AD-MANUAL-ZERO','0','manual')").run();
assert.equal(resolveDiscountPercent('AD-MANUAL-ZERO'), null);

db5.close();
console.log('applyDerivedDiscount: ALL PASS');
