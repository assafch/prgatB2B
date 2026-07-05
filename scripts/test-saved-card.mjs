// Run: npm run build && CARD_TOKEN_KEY=<64-hex> DATA_DIR=/tmp/scv-test node scripts/test-saved-card.mjs
import assert from 'node:assert/strict';
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
