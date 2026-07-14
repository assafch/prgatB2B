// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/stockAlerts.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, setSettingBool } from './db.js';
import {
  requestAlert, cancelAlert, listAlerts, markSeen, listWaiters, fireStockAlerts,
} from './stockAlerts.js';

function seed() {
  db.exec('DELETE FROM stock_alerts; DELETE FROM users; DELETE FROM catalog_cache;');
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, custname, cust_desc) VALUES (1,'u1','x','customer','10001','לקוח א'),(2,'u2','x','customer','10001','לקוח א')"
  ).run();
  db.prepare(
    "INSERT INTO catalog_cache (partname, partdes, b2b_visible, b2b_out_of_stock) VALUES ('P1','מוצר בדיקה',1,1),('P2','מוצר נסתר',0,1),('P3','מוצר במלאי',1,0)"
  ).run();
  setSettingBool('stock_alerts_enabled', true);
}

test('request → arm; listAlerts reflects it; cancel removes', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  assert.equal(listAlerts(1).length, 1);
  assert.equal(listAlerts(1)[0].notified_at, null);
  assert.ok(cancelAlert(1, 'P1'));
  assert.equal(listAlerts(1).length, 0);
});

test('request rejects in-stock and hidden products', () => {
  seed();
  assert.throws(() => requestAlert(1, '10001', 'P3')); // in stock
  assert.throws(() => requestAlert(1, '10001', 'P2')); // hidden
  assert.throws(() => requestAlert(1, '10001', 'NOPE')); // unknown
});

test('fire is one-shot, per-user, and skips hidden products', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  requestAlert(2, '10001', 'P1');
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  assert.equal(fireStockAlerts(['P1']), 2); // both users
  assert.equal(fireStockAlerts(['P1']), 0); // one-shot: nothing left
  // hidden product never fires even with a pending alert
  db.prepare("INSERT INTO stock_alerts (user_id, custname, partname) VALUES (1,'10001','P2')").run();
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P2'").run();
  assert.equal(fireStockAlerts(['P2']), 0);
});

test('flag off → fire is a no-op', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  setSettingBool('stock_alerts_enabled', false);
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  assert.equal(fireStockAlerts(['P1']), 0);
});

test('re-request after fulfillment re-arms the same row', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  fireStockAlerts(['P1']);
  assert.ok(listAlerts(1)[0].notified_at);
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 1 WHERE partname = 'P1'").run();
  requestAlert(1, '10001', 'P1'); // re-arm
  const row = listAlerts(1)[0];
  assert.equal(row.notified_at, null);
  assert.equal(listAlerts(1).length, 1); // same row, not a duplicate
});

test('markSeen stamps only fulfilled alerts; listWaiters counts pending only', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  markSeen(1, 'P1'); // not fulfilled yet → no-op
  assert.equal(listAlerts(1)[0].seen_at, null);
  assert.equal(listWaiters('P1').length, 1);
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  fireStockAlerts(['P1']);
  assert.equal(listWaiters('P1').length, 0); // fulfilled → no longer waiting
  markSeen(1, 'P1');
  assert.ok(listAlerts(1)[0].seen_at);
});
