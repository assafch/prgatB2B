// Security regression: a cheque whose amount was NOT OCR-verified must not
// auto-approve a held order (payHeldOrderByCheck), and confirmCheck must record
// amount_verified truthfully.
// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/checkAmountVerify.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from './db.js';
import { createCheckDraft, confirmCheck, getCheckForUser } from './payments.js';
import { payHeldOrderByCheck } from './orders.js';
import { pendingSettlement } from './paymentPolicy.js';

function seedUser() {
  db.exec('DELETE FROM payment_checks; DELETE FROM orders_local; DELETE FROM users;');
  db.prepare("INSERT INTO users (id, username, password_hash, role, custname) VALUES (1,'u1','x','customer','10001')").run();
}

function heldOrder(required: number): number {
  return db
    .prepare(
      "INSERT INTO orders_local (user_id, custname, status, payment_status, payment_required_amount, total) VALUES (1,'10001','pending_payment','pending_payment',?,?)"
    )
    .run(required, required).lastInsertRowid as number;
}

const img = Buffer.from('not-a-real-image'); // createCheckDraft encrypts bytes; content is irrelevant here

test('confirmCheck records amount_verified=0 when OCR read no amount', () => {
  seedUser();
  const { id } = createCheckDraft(1, '10001', img, null); // ai=null → no OCR amount
  assert.ok(confirmCheck(1, id, { amount: 500, checkDate: '2020-01-01' }));
  assert.equal(getCheckForUser(1, id)!.amount_verified, 0);
  assert.equal(getCheckForUser(1, id)!.amount, 500); // uncapped (nothing to cap against) — that's why it can't auto-approve
});

test('confirmCheck records amount_verified=1 and caps when OCR read an amount', () => {
  seedUser();
  const { id } = createCheckDraft(1, '10001', img, { is_check: true, amount: 300, amount_words_match: true, date: '2020-01-01', is_postdated: false, bank: null, branch: null, account: null, check_number: null, legible: true, confidence: 0.9, notes_he: null });
  assert.ok(confirmCheck(1, id, { amount: 9999, checkDate: '2020-01-01' })); // try to inflate
  assert.equal(getCheckForUser(1, id)!.amount_verified, 1);
  assert.equal(getCheckForUser(1, id)!.amount, 300); // capped to the OCR reading
});

test('payHeldOrderByCheck REJECTS an unverified-amount cheque (the bypass)', async () => {
  seedUser();
  const orderId = heldOrder(500);
  const { id } = createCheckDraft(1, '10001', img, null); // no OCR
  confirmCheck(1, id, { amount: 500, checkDate: '2020-01-01' }); // amount_verified=0, covers required, not postdated
  await assert.rejects(
    () => payHeldOrderByCheck(1, '10001', orderId, id),
    /לא אומת מהתמונה/,
    'unverified cheque must not auto-approve the held order'
  );
  // order stays held
  assert.equal((db.prepare('SELECT status FROM orders_local WHERE id = ?').get(orderId) as { status: string }).status, 'pending_payment');
});

test('payHeldOrderByCheck passes the verify guard for a verified cheque and claims the order', async () => {
  seedUser();
  const orderId = heldOrder(300);
  const { id } = createCheckDraft(1, '10001', img, { is_check: true, amount: 300, amount_words_match: true, date: '2020-01-01', is_postdated: false, bank: null, branch: null, account: null, check_number: null, legible: true, confidence: 0.9, notes_he: null });
  confirmCheck(1, id, { amount: 300, checkDate: '2020-01-01' }); // amount_verified=1
  // Gets PAST every guard and is claimed by approveOrder. Priority is unconfigured in
  // tests, so approveOrder marks the order 'failed' (payment taken, admin-recoverable)
  // and returns true — the point is it left pending_payment via the verified cheque.
  const result = await payHeldOrderByCheck(1, '10001', orderId, id);
  assert.equal(result, true);
  const status = (db.prepare('SELECT status FROM orders_local WHERE id = ?').get(orderId) as { status: string }).status;
  assert.notEqual(status, 'pending_payment'); // no longer held — the verified cheque claimed it
});

test('pendingSettlement (debt-block offset) counts only OCR-verified cheques', () => {
  seedUser();
  // Unverified cheque with a big typed amount must NOT offset debt (the debt-block bypass).
  const c0 = createCheckDraft(1, '10001', img, null).id;
  confirmCheck(1, c0, { amount: 20000, checkDate: '2020-01-01' }); // amount_verified=0
  assert.equal(pendingSettlement('10001'), 0, 'unverified cheque must not lift the debt block');
  // A verified cheque does count.
  const c1 = createCheckDraft(1, '10001', img, { is_check: true, amount: 500, amount_words_match: true, date: '2020-01-01', is_postdated: false, bank: null, branch: null, account: null, check_number: null, legible: true, confidence: 0.9, notes_he: null }).id;
  confirmCheck(1, c1, { amount: 500, checkDate: '2020-01-01' }); // amount_verified=1
  assert.equal(pendingSettlement('10001'), 500);
});
