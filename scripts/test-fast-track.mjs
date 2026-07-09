// Unit checks for fast-track checkout. Run: npm run build && DATA_DIR=<scratch> node scripts/test-fast-track.mjs
import assert from 'node:assert/strict';
import { fastTrackAmounts, fastTrackCustomerEligible, fastTrackQualifies } from '../dist/server/fastTrack.js';
import { setSettingBool } from '../dist/server/db.js';
import Database from 'better-sqlite3';
import path from 'node:path';

// --- pure discount math (VAT 18%) ---
// 3% off a 1000₪ pre-VAT cart: 970 pre-VAT → 1144.60 incl VAT; full 1180 → saving 35.40
assert.deepEqual(fastTrackAmounts(1000, 3), { discountPct: 3, discountedTotal: 970, payable: 1144.6, saving: 35.4 });
// 0% — no change, zero saving
assert.deepEqual(fastTrackAmounts(500, 0), { discountPct: 0, discountedTotal: 500, payable: 590, saving: 0 });
// rounding: 33.33 × 0.97 = 32.3301 → 32.33 → payable 38.15; full 39.33 → saving 1.18
const r = fastTrackAmounts(33.33, 3);
assert.equal(r.discountedTotal, 32.33);
assert.equal(r.payable, 38.15);
assert.equal(r.saving, 1.18);
console.log('fastTrackAmounts: ALL PASS');

// --- DB-backed eligibility (mirrors test-payment-policy.mjs style) ---
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, fast_track) VALUES ('C-OUT','auto',0)").run();
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, fast_track) VALUES ('C-IN','auto',1)").run();
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind) VALUES ('C-NULL','auto')").run();
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind) VALUES ('C-NETOVR','net')").run();
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind) VALUES ('C-CASHOVR','cash')").run();
db.close();
assert.equal(fastTrackCustomerEligible('C-OUT'), false);
assert.equal(fastTrackCustomerEligible('C-IN'), true);
assert.equal(fastTrackCustomerEligible('C-NULL'), true); // NULL column = eligible
assert.equal(fastTrackCustomerEligible('NO-ROW'), true); // no row at all = eligible
console.log('fastTrackCustomerEligible: ALL PASS');

// --- שוטף-only qualification (flag + opt-out + net-terms gate) ---
assert.equal(await fastTrackQualifies('C-NETOVR'), false); // flag off → never
setSettingBool('fast_track_enabled', true);
assert.equal(await fastTrackQualifies('C-NETOVR'), true);   // explicit net override
assert.equal(await fastTrackQualifies('C-CASHOVR'), false); // explicit cash override
assert.equal(await fastTrackQualifies('C-OUT'), false);     // opted out
// auto kind + Priority unreachable in the scratch env → terms unknown → NO discount
assert.equal(await fastTrackQualifies('C-NULL'), false);
setSettingBool('fast_track_enabled', false);
assert.equal(await fastTrackQualifies('C-NETOVR'), false); // flag back off
console.log('fastTrackQualifies: ALL PASS');

// --- patchCustomer round-trip: opt out, back in, and preservation ---
import { patchCustomer } from '../dist/server/customers.js';
const db2 = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
patchCustomer('C-RT', { fast_track: false });
assert.equal(db2.prepare("SELECT fast_track FROM customer_policies WHERE custname='C-RT'").get().fast_track, 0);
assert.equal(fastTrackCustomerEligible('C-RT'), false);
patchCustomer('C-RT', { fast_track: true });
assert.equal(fastTrackCustomerEligible('C-RT'), true);
// patching an unrelated field must PRESERVE the opt-out (read-merge-write)
patchCustomer('C-RT2', { fast_track: false });
patchCustomer('C-RT2', { enforced: true });
assert.equal(fastTrackCustomerEligible('C-RT2'), false);
assert.equal(db2.prepare("SELECT enforced FROM customer_policies WHERE custname='C-RT2'").get().enforced, 1);
db2.close();
console.log('patchCustomer fast_track: ALL PASS');
