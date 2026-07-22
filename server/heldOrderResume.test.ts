// Duplicate-basket guard: a customer whose held (pending_payment) order failed to get
// paid, and who then re-submits the SAME basket, must be routed back to the existing
// held order — not given a second one (real case: 10822 orders #9/#10, 2026-07-22).
// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/heldOrderResume.test.ts
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from './db.js';
import { findResumableHeldOrder } from './orders.js';

function wipe() {
  db.exec('DELETE FROM order_lines; DELETE FROM orders_local; DELETE FROM users;');
  db.prepare("INSERT INTO users (id, username, password_hash, role, custname) VALUES (1,'u1','x','customer','10822')").run();
}

function heldOrder(opts: { amount?: number; fast?: number; status?: string; createdAgo?: string; user?: number } = {}): number {
  const id = db.prepare(
    `INSERT INTO orders_local (user_id, custname, status, payment_status, payment_required_amount, total, fast_track, created_at)
     VALUES (?, '10822', ?, 'pending_payment', ?, 100, ?, datetime('now', ?))`
  ).run(opts.user ?? 1, opts.status ?? 'pending_payment', opts.amount ?? 118, opts.fast ?? 0, opts.createdAgo ?? '-1 hours').lastInsertRowid as number;
  db.prepare("INSERT INTO order_lines (order_id, partname, pdes, quantity, price, is_promotion_freebie) VALUES (?, 'PU001', 'x', 24, 12.16, 0)").run(id);
  db.prepare("INSERT INTO order_lines (order_id, partname, pdes, quantity, price, is_promotion_freebie) VALUES (?, 'HA04', 'x', 30, 12, 0)").run(id);
  return id;
}

const SAME = [ { partname: 'PU001', quantity: 24, free: false }, { partname: 'HA04', quantity: 30, free: false } ];

// Leave no orders_local rows behind: user_id has a non-CASCADE FK to users, so a later
// test file sharing this DATA_DIR would fail its `DELETE FROM users` seed otherwise.
after(() => { db.exec('DELETE FROM order_lines; DELETE FROM orders_local; DELETE FROM users;'); });

test('identical basket → existing held order is returned', () => {
  wipe();
  const id = heldOrder();
  const hit = findResumableHeldOrder(1, '10822', false, SAME);
  assert.deepEqual(hit, { id, amount: 118 });
});

test('different quantity → no match', () => {
  wipe();
  heldOrder();
  assert.equal(findResumableHeldOrder(1, '10822', false, [ { partname: 'PU001', quantity: 25, free: false }, { partname: 'HA04', quantity: 30, free: false } ]), null);
});

test('extra line → no match', () => {
  wipe();
  heldOrder();
  assert.equal(findResumableHeldOrder(1, '10822', false, [...SAME, { partname: 'NEW1', quantity: 1, free: false }]), null);
});

test('already-paid / non-pending order → no match', () => {
  wipe();
  heldOrder({ status: 'submitted' });
  assert.equal(findResumableHeldOrder(1, '10822', false, SAME), null);
});

test('older than 48h (sweep horizon) → no match', () => {
  wipe();
  heldOrder({ createdAgo: '-49 hours' });
  assert.equal(findResumableHeldOrder(1, '10822', false, SAME), null);
});

test('fast-track mismatch → no match (amounts differ by the prepay discount)', () => {
  wipe();
  heldOrder({ fast: 0 });
  assert.equal(findResumableHeldOrder(1, '10822', true, SAME), null);
});

test('different user, same company → no match', () => {
  wipe();
  heldOrder();
  assert.equal(findResumableHeldOrder(2, '10822', false, SAME), null);
});
