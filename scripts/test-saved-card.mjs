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
