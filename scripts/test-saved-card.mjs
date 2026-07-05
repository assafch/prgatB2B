// Run: npm run build && CARD_TOKEN_KEY=<64-hex> DATA_DIR=/tmp/scv-test node scripts/test-saved-card.mjs
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import { encryptToken, decryptToken } from '../dist/server/tokenVault.js';
import { parseTxForTest } from '../dist/server/payplus.js'; // export parseTx as parseTxForTest

const tok = 'pp-token-1234567890abcdef';
const enc = encryptToken(tok);
assert.ok(enc && enc !== tok, 'encrypts');
assert.equal(decryptToken(enc), tok, 'round-trip');
assert.notEqual(encryptToken(tok), enc, 'fresh iv per call');
assert.equal(decryptToken('garbage'), null, 'corrupt → null');
console.log('tokenVault: ALL PASS');

const tx = { status_code: '000', transaction_uid: 'u1', amount: 504.1, more_info: 'REF1',
  number_of_payments: 3, card_information: { four_digits: '4580', token_uid: 'tok_abc', brand_name: 'Visa', expiry_month: '08', expiry_year: '28' } };
const p = parseTxForTest(tx, 'REF1');
assert.equal(p.tokenUid, 'tok_abc');
assert.equal(p.paymentsCount, 3);
assert.equal(p.brand, 'Visa');
assert.equal(p.expiryMonth, '08');
console.log('parseTx token/payments: ALL PASS');

// Import cardPayments.js first — its db.js side effect creates the schema
// (including `settings`) in the fresh DATA_DIR db before we write into it directly.
const { installmentsFor } = await import('../dist/server/cardPayments.js');
const sdb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
sdb
  .prepare(
    "INSERT OR REPLACE INTO settings (key,value) VALUES ('installments_enabled','true'),('installments_min_amount','1000'),('installments_max','4')"
  )
  .run();
sdb.close();
assert.equal(installmentsFor(999.99), null);
assert.equal(installmentsFor(1000), 4);
assert.equal(installmentsFor(50000), 4);
console.log('installmentsFor: ALL PASS');

// A blank installments_min_amount (admin cleared the input) must fall back to the
// 1000 default, not Number('') === 0 — otherwise installments would apply to every
// payment amount >= 0.
{
  const bdb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
  bdb.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('installments_min_amount','')").run();
  bdb.close();
  assert.equal(installmentsFor(1), null, 'blank min falls back to 1000, not 0');
  assert.equal(installmentsFor(1000), 4, 'blank min still honors the 1000 fallback boundary');
  const rdb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
  rdb.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('installments_min_amount','1000')").run();
  rdb.close();
}
console.log('installmentsFor blank-min fallback: ALL PASS');

// --- Saved card (Phase 1 token capture) upsert/read/delete round-trip -----------
const { upsertSavedCard, getSavedCard, deleteSavedCard } = await import('../dist/server/savedCards.js');

// Fake user row — saved_cards.user_id has a FK to users(id) with foreign_keys = ON.
const udb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
udb
  .prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role, custname) VALUES (1, 'u1', 'x', 'customer', 'CUST1')")
  .run();
udb.close();

const fakeTx1 = { tokenUid: 'tok-aaa', brand: 'Visa', fourDigits: '1111', expiryMonth: '01', expiryYear: '29' };
upsertSavedCard(1, 'CUST1', fakeTx1);

const rawDb1 = new Database(path.join(process.env.DATA_DIR, 'app.db'));
const rawRow1 = rawDb1.prepare('SELECT token FROM saved_cards WHERE user_id = ?').get(1);
assert.ok(rawRow1 && rawRow1.token !== fakeTx1.tokenUid, 'stored token is encrypted, not plaintext');
rawDb1.close();

let saved = getSavedCard(1);
assert.ok(saved, 'saved card exists after upsert');
assert.equal(saved.brand, 'Visa');
assert.equal(saved.four_digits, '1111');
assert.equal(saved.expiry_month, '01');
assert.equal(saved.expiry_year, '29');
assert.ok(!('token' in saved), 'getSavedCard never exposes the token');

// Second upsert (different card) replaces the first — one row per user.
const fakeTx2 = { tokenUid: 'tok-bbb', brand: 'Mastercard', fourDigits: '2222', expiryMonth: '05', expiryYear: '30' };
upsertSavedCard(1, 'CUST1', fakeTx2);
saved = getSavedCard(1);
assert.equal(saved.brand, 'Mastercard');
assert.equal(saved.four_digits, '2222');

const countDb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
const count = countDb.prepare('SELECT COUNT(*) AS c FROM saved_cards WHERE user_id = ?').get(1);
assert.equal(count.c, 1, 'single row after two upserts');
countDb.close();

deleteSavedCard(1);
assert.equal(getSavedCard(1), null, 'null after delete');
console.log('savedCards upsert/read/delete: ALL PASS');

// --- Task 6: derivation-parity — the extracted helpers must enforce the exact same
// guards the hosted creators enforced before the refactor (order/debt/partial). -----

// getSavedCardToken: the encrypted-token accessor the one-tap charge path needs.
const { getSavedCardToken } = await import('../dist/server/savedCards.js');
upsertSavedCard(1, 'CUST1', fakeTx1);
const tokenRow = getSavedCardToken(1);
assert.ok(tokenRow && tokenRow.token && tokenRow.token !== fakeTx1.tokenUid, 'getSavedCardToken returns the encrypted blob, not plaintext');
assert.equal(decryptToken(tokenRow.token), fakeTx1.tokenUid, 'getSavedCardToken round-trips to the original PSP token');
deleteSavedCard(1);
console.log('getSavedCardToken: ALL PASS');

// --- Order-mode helper (deriveOrderCharge): pure DB guards, no Priority I/O -----
const { deriveOrderCharge, deriveDebtCharge, derivePartialCharge } = await import('../dist/server/cardPayments.js');

const odb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
odb.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role, custname) VALUES (2, 'u2', 'x', 'customer', 'CUST1')").run();
const insOrder = odb.prepare(
  `INSERT INTO orders_local (id, user_id, custname, status, total, payment_required_amount)
   VALUES (?, ?, ?, ?, ?, ?)`
);
insOrder.run(101, 1, 'CUST1', 'pending_payment', 590, 590);
insOrder.run(102, 1, 'CUST1', 'approved', 590, 590); // not awaiting payment
insOrder.run(103, 1, 'CUST1', 'pending_payment', 590, null); // amount unavailable
insOrder.run(104, 1, 'CUST1', 'pending_payment', 590, 250);
odb.prepare("INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp, order_id) VALUES ('paid-104', 1, 'CUST1', 'order_payment', 250, 'paid', 'payplus', '104')").run();
odb.close();

// Happy path — same amount + label the hosted createCardOrderIntent would derive.
{
  const out = deriveOrderCharge(1, 'CUST1', 101);
  assert.deepEqual(out, { amount: 590, label: 'תשלום הזמנה #101' });
}
// Foreign user — order belongs to user 1, not user 2.
assert.throws(() => deriveOrderCharge(2, 'CUST1', 101), /order not found/, 'foreign user rejected');
// Not pending — status is 'approved'.
assert.throws(() => deriveOrderCharge(1, 'CUST1', 102), /order not awaiting payment/, 'non-pending order rejected');
// Missing amount.
assert.throws(() => deriveOrderCharge(1, 'CUST1', 103), /order amount unavailable/, 'missing amount rejected');
// Already paid (duplicate tab / race) — same M1 guard the hosted path enforced.
assert.throws(() => deriveOrderCharge(1, 'CUST1', 104), /order already paid/, 'already-paid order rejected');
// Unknown order id.
assert.throws(() => deriveOrderCharge(1, 'CUST1', 9999), /order not found/, 'unknown order rejected');
console.log('deriveOrderCharge: ALL PASS');

// --- Debt/partial helpers (deriveDebtCharge / derivePartialCharge): these call
// getAccountSummary/getUnpaidInvoices, which hit Priority over HTTP. Point them at a
// fake config and stub global.fetch so the cap/selection math runs against known
// fixtures instead of a real tenant. -----------------------------------------------
process.env.PRIORITY_BASE_URL = 'http://priority.invalid';
process.env.PRIORITY_COMPANY = 'test-co';
process.env.PRIORITY_PAT = 'test-pat';

const origFetch = global.fetch;
const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
global.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/OBLIGO')) return jsonRes({ value: [{ ACC_DEBIT: 300, OBLIGO: 300, MAX_CREDIT: 1000 }] });
  if (u.includes('/OPENINVOICES')) return jsonRes({ value: [] });
  if (u.includes('/AINVOICES')) {
    return jsonRes({
      value: [
        { IVNUM: 'INV-1', TOTPRICE: 120, IVDATE: '2026-01-01', STATDES: 'סופית', IVRECONDATE: null },
        { IVNUM: 'INV-2', TOTPRICE: 200, IVDATE: '2026-01-02', STATDES: 'סופית', IVRECONDATE: null },
      ],
    });
  }
  if (u.includes('/CUSTOMERS')) return jsonRes({ value: [{ CUSTNAME: 'CUST1', CUSTDES: 'Test Ltd', EMAIL: 'x@test.com' }] });
  return jsonRes({ value: [] });
};

// deriveDebtCharge — whole-balance fallback (no selection): amount = ACC_DEBIT (300).
{
  const out = await deriveDebtCharge('CUST1', {});
  assert.equal(out.amount, 300);
  assert.equal(out.label, 'תשלום חוב — CUST1');
}
// deriveDebtCharge — single selected invoice under the cap: itemized label + payplusItems kept.
{
  const out = await deriveDebtCharge('CUST1', { invoices: ['INV-1'] });
  assert.equal(out.amount, 120);
  assert.equal(out.label, 'חשבונית מס׳ INV-1');
  assert.deepEqual(out.paidItems, ['INV-1']);
  assert.ok(out.payplusItems && out.payplusItems.length === 1);
}
// deriveDebtCharge — selection sum (320) exceeds the payable cap once a recent
// unreconciled debt payment (250, within RECON_WINDOW) deflates it to 50: amount is
// clamped to the cap and the itemization is dropped (can't reconcile 50 to 2 invoices).
const cardDb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
cardDb.prepare(
  "INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp) VALUES ('deflate-1', 1, 'CUST1', 'debt', 250, 'pending', 'payplus')"
).run();
cardDb.close();
{
  const out = await deriveDebtCharge('CUST1', { invoices: ['INV-1', 'INV-2'] });
  assert.equal(out.amount, 50, 'clamped to the deflated payable cap, not the itemized sum (320)');
  assert.equal(out.label, 'תשלום חוב — CUST1', 'itemization dropped once capped below the selected sum');
  assert.equal(out.payplusItems, undefined);
}
console.log('deriveDebtCharge: ALL PASS');

// derivePartialCharge — same deflated payable (50): a request under the cap succeeds,
// at/over the cap is rejected with the same message createCardPartialIntent used.
{
  const out = await derivePartialCharge('CUST1', 30);
  assert.equal(out.amount, 30);
}
await assert.rejects(
  () => derivePartialCharge('CUST1', 100),
  /הסכום חורג מהיתרה לתשלום \(₪50\.00\)/,
  'partial helper enforces the same payable cap as the hosted /intent route'
);
await assert.rejects(() => derivePartialCharge('CUST1', 0), /יש להזין סכום תקין/, 'zero amount rejected');
await assert.rejects(() => derivePartialCharge('CUST1', -5), /יש להזין סכום תקין/, 'negative amount rejected');
await assert.rejects(() => derivePartialCharge('CUST1', NaN), /יש להזין סכום תקין/, 'NaN amount rejected');
console.log('derivePartialCharge: ALL PASS');

// Cleanup the fetch stub + fixtures so it can't leak into anything appended after this file.
global.fetch = origFetch;
const cleanupDb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
cleanupDb.prepare("DELETE FROM card_payments WHERE id IN ('paid-104','deflate-1')").run();
cleanupDb.prepare('DELETE FROM orders_local WHERE id IN (101,102,103,104)').run();
cleanupDb.close();
