// Customer-facing order totals must be VAT-inclusive (house rule 6). orders_local.total
// is pre-VAT, which leaked into the home card / orders list / order detail and made a
// customer believe she overpaid (real case: order #10 showed ₪1,251.06 while her cheque
// was ₪1,476.25 — the same order, incl. VAT).
// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/customerDisplayTotal.test.ts
import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { db } from './db.js';
import { customerDisplayTotal, listLocalOrders, getLocalOrder } from './orders.js';

function wipe() {
  db.exec('DELETE FROM order_lines; DELETE FROM orders_local; DELETE FROM users;');
  db.prepare("INSERT INTO users (id, username, password_hash, role, custname) VALUES (1,'u1','x','customer','10001')").run();
}

after(() => { db.exec('DELETE FROM order_lines; DELETE FROM orders_local; DELETE FROM users;'); });

test('customerDisplayTotal: paid amount wins when a payment was required', () => {
  assert.equal(customerDisplayTotal({ total: 1251.06, payment_required_amount: 1476.25 }), 1476.25);
});

test('customerDisplayTotal: plain order grosses up pre-VAT total (18%)', () => {
  assert.equal(customerDisplayTotal({ total: 1251.06, payment_required_amount: null }), 1476.25);
  assert.equal(customerDisplayTotal({ total: 100 }), 118);
});

test('customerDisplayTotal: null total stays null', () => {
  assert.equal(customerDisplayTotal({ total: null, payment_required_amount: null }), null);
});

test('listLocalOrders and getLocalOrder expose total_incl_vat', () => {
  wipe();
  const held = db.prepare(
    "INSERT INTO orders_local (user_id, custname, status, payment_status, total, payment_required_amount) VALUES (1,'10001','submitted','approved',1251.06,1476.25)"
  ).run().lastInsertRowid as number;
  const plain = db.prepare(
    "INSERT INTO orders_local (user_id, custname, status, total) VALUES (1,'10001','submitted',100)"
  ).run().lastInsertRowid as number;
  const list = listLocalOrders(1);
  assert.equal(list.find((o) => o.id === held)!.total_incl_vat, 1476.25);
  assert.equal(list.find((o) => o.id === plain)!.total_incl_vat, 118);
  assert.equal(getLocalOrder(1, held)!.total_incl_vat, 1476.25);
  assert.equal(getLocalOrder(1, plain)!.total_incl_vat, 118);
});
