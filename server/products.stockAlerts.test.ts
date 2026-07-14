// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/products.stockAlerts.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, setSettingBool } from './db.js';
import { requestAlert, listAlerts } from './stockAlerts.js';
import { patchProduct, bulkUpdate } from './products.js';

function seed() {
  db.exec('DELETE FROM stock_alerts; DELETE FROM users; DELETE FROM catalog_cache;');
  db.prepare("INSERT INTO users (id, username, password_hash, role, custname) VALUES (1,'u1','x','customer','10001')").run();
  db.prepare(
    "INSERT INTO catalog_cache (partname, partdes, b2b_visible, b2b_out_of_stock) VALUES ('P1','א',1,1),('P2','ב',1,1)"
  ).run();
  setSettingBool('stock_alerts_enabled', true);
}

test('patchProduct 1→0 fires; same-value save does not', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  patchProduct('P1', { b2b_out_of_stock: true }); // same value — must NOT fire
  assert.equal(listAlerts(1)[0].notified_at, null);
  patchProduct('P1', { b2b_out_of_stock: false }); // restock — fires
  assert.ok(listAlerts(1)[0].notified_at);
});

test('bulkUpdate mark_in_stock fires only for rows that were OOS', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  requestAlert(1, '10001', 'P2');
  patchProduct('P2', { b2b_out_of_stock: false }); // P2 already restocked+fired
  const before = listAlerts(1).find((a) => a.partname === 'P2')!.notified_at;
  bulkUpdate({ partnames: ['P1', 'P2'], action: 'mark_in_stock' });
  assert.ok(listAlerts(1).find((a) => a.partname === 'P1')!.notified_at); // P1 fired now
  assert.equal(listAlerts(1).find((a) => a.partname === 'P2')!.notified_at, before); // P2 untouched
});
