// A cheque dated more than 6 months in the past is not bankable (Israeli banking
// practice) — it must not auto-approve a held order and must not count as money in
// flight for the debt block. Real case: 10822 uploaded a cheque dated 2025-07-22 on
// 2026-07-22; only its short amount stopped it from releasing the order.
// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/staleCheck.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from './db.js';
import { createCheckDraft, confirmCheck, isStaleCheckDate, STALE_CHECK_DAYS } from './payments.js';
import { payHeldOrderByCheck, OrderError } from './orders.js';
import { pendingSettlement } from './paymentPolicy.js';

function seed() {
  db.exec('DELETE FROM payment_checks; DELETE FROM orders_local; DELETE FROM users;');
  db.prepare("INSERT INTO users (id, username, password_hash, role, custname) VALUES (1,'u1','x','customer','10001')").run();
}

function heldOrder(required: number): number {
  return db.prepare(
    "INSERT INTO orders_local (user_id, custname, status, payment_status, payment_required_amount, total) VALUES (1,'10001','pending_payment','pending_payment',?,?)"
  ).run(required, required).lastInsertRowid as number;
}

const img = Buffer.from('not-a-real-image');
const ymdDaysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

function submittedCheck(dateYmd: string, amount: number): string {
  const { id } = createCheckDraft(1, '10001', img, {
    is_check: true, amount, amount_words_match: true, date: dateYmd, is_postdated: false,
    bank: null, branch: null, account: null, check_number: null, legible: true, confidence: 0.9, notes_he: null,
  });
  assert.ok(confirmCheck(1, id, { amount, checkDate: dateYmd }));
  return id;
}

test('isStaleCheckDate: boundary', () => {
  assert.equal(isStaleCheckDate(ymdDaysAgo(STALE_CHECK_DAYS + 5)), true);
  assert.equal(isStaleCheckDate(ymdDaysAgo(30)), false);
  assert.equal(isStaleCheckDate(null), false);       // unknown date → other guards decide
  assert.equal(isStaleCheckDate('garbage'), false);
});

test('stale cheque cannot approve a held order', async () => {
  seed();
  const orderId = heldOrder(500);
  const chk = submittedCheck(ymdDaysAgo(365), 500);
  await assert.rejects(() => payHeldOrderByCheck(1, '10001', orderId, chk), (e: unknown) => e instanceof OrderError && /6 חודשים/.test((e as Error).message));
});

test('fresh cheque still approves', async () => {
  seed();
  const orderId = heldOrder(500);
  const chk = submittedCheck(ymdDaysAgo(3), 500);
  assert.equal(await payHeldOrderByCheck(1, '10001', orderId, chk), true);
});

test('pendingSettlement excludes stale cheques', () => {
  seed();
  submittedCheck(ymdDaysAgo(365), 1426); // stale — must not count
  submittedCheck(ymdDaysAgo(3), 200);    // fresh — counts
  assert.equal(pendingSettlement('10001'), 200);
});
