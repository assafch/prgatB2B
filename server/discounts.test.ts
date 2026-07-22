// Per-part discount derivation: a customer whose Priority PERCENT differs per part
// (real case: 10822, order SO26000208 — 5% on two lines, 0% on four) must NOT get a
// blanket dominant percent applied to the whole catalog.
// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/discounts.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { db } from './db.js';
import { deriveDiscountProfile, applyDerivedDiscount, resolveDiscount } from './discounts.js';

function wipe() {
  db.exec('DELETE FROM customer_discounts; DELETE FROM customer_part_discounts;');
}

test('deriveDiscountProfile: uniform lines → uniform profile', () => {
  const p = deriveDiscountProfile([
    { partname: 'A', percent: 5 },
    { partname: 'B', percent: 5 },
  ]);
  assert.equal(p.dominant, 5);
  assert.equal(p.uniform, true);
});

test('deriveDiscountProfile: mixed lines → per-part map, newest-first wins per part', () => {
  const p = deriveDiscountProfile([
    { partname: 'PU001', percent: 5 },   // newest
    { partname: 'HA04', percent: 0 },
    { partname: 'PU001', percent: 3 },   // older line for same part — must lose
  ]);
  assert.equal(p.dominant, 5);
  assert.equal(p.uniform, false);
  assert.equal(p.perPart.get('PU001'), 5);
  assert.equal(p.perPart.get('HA04'), 0);
});

test('applyDerivedDiscount: non-uniform stores part rows + uniform=0', () => {
  wipe();
  applyDerivedDiscount('10822', [
    { partname: 'PU001', percent: 5 },
    { partname: 'HA04', percent: 0 },
  ]);
  const head = db.prepare('SELECT percent, uniform FROM customer_discounts WHERE custname = ?').get('10822') as { percent: number; uniform: number };
  assert.equal(head.percent, 5);
  assert.equal(head.uniform, 0);
  const parts = db.prepare('SELECT partname, percent FROM customer_part_discounts WHERE custname = ? ORDER BY partname').all('10822');
  assert.deepEqual(parts, [ { partname: 'HA04', percent: 0 }, { partname: 'PU001', percent: 5 } ]);
});

test('applyDerivedDiscount: uniform clears any stale part rows', () => {
  wipe();
  applyDerivedDiscount('10822', [ { partname: 'PU001', percent: 5 }, { partname: 'HA04', percent: 0 } ]);
  applyDerivedDiscount('10822', [ { partname: 'PU001', percent: 5 }, { partname: 'HA04', percent: 5 } ]);
  const head = db.prepare('SELECT uniform FROM customer_discounts WHERE custname = ?').get('10822') as { uniform: number };
  assert.equal(head.uniform, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM customer_part_discounts WHERE custname = ?').get('10822') !== undefined
    ? (db.prepare('SELECT COUNT(*) c FROM customer_part_discounts WHERE custname = ?').get('10822') as { c: number }).c : 0, 0);
});

test('applyDerivedDiscount: all-zero lines → discount revoked, everything cleared', () => {
  wipe();
  applyDerivedDiscount('10822', [ { partname: 'PU001', percent: 5 }, { partname: 'HA04', percent: 0 } ]);
  applyDerivedDiscount('10822', [ { partname: 'PU001', percent: 0 }, { partname: 'HA04', percent: 0 } ]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM customer_discounts WHERE custname = ?').get('10822') && (db.prepare('SELECT COUNT(*) c FROM customer_discounts WHERE custname = ?').get('10822') as { c: number }).c, 0);
  assert.equal((db.prepare('SELECT COUNT(*) c FROM customer_part_discounts WHERE custname = ?').get('10822') as { c: number }).c, 0);
});

test('applyDerivedDiscount: manual override is never touched, part rows not written', () => {
  wipe();
  db.prepare("INSERT INTO customer_discounts (custname, percent, source) VALUES ('10822', 7, 'manual')").run();
  applyDerivedDiscount('10822', [ { partname: 'PU001', percent: 5 }, { partname: 'HA04', percent: 0 } ]);
  const head = db.prepare('SELECT percent, source FROM customer_discounts WHERE custname = ?').get('10822') as { percent: number; source: string };
  assert.equal(head.percent, 7);
  assert.equal(head.source, 'manual');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM customer_part_discounts WHERE custname = ?').get('10822') as { c: number }).c, 0);
});

test('resolveDiscount: uniform customer → blanket everywhere', () => {
  wipe();
  applyDerivedDiscount('C1', [ { partname: 'A', percent: 5 }, { partname: 'B', percent: 5 } ]);
  const r = resolveDiscount('C1');
  assert.equal(r.forPart('A'), 5);
  assert.equal(r.forPart('NEVER-SEEN'), 5);
});

test('resolveDiscount: non-uniform → per part; 0%-parts and unseen parts get null (base price)', () => {
  wipe();
  applyDerivedDiscount('C2', [ { partname: 'PU001', percent: 5 }, { partname: 'HA04', percent: 0 } ]);
  const r = resolveDiscount('C2');
  assert.equal(r.forPart('PU001'), 5);
  assert.equal(r.forPart('HA04'), null);
  assert.equal(r.forPart('NEVER-SEEN'), null);
});

test('resolveDiscount: manual override → blanket everywhere regardless of part rows', () => {
  wipe();
  db.prepare("INSERT INTO customer_discounts (custname, percent, source, uniform) VALUES ('C3', 10, 'manual', 0)").run();
  db.prepare("INSERT INTO customer_part_discounts (custname, partname, percent) VALUES ('C3', 'A', 5)").run();
  const r = resolveDiscount('C3');
  assert.equal(r.forPart('A'), 10);
  assert.equal(r.forPart('B'), 10);
});

test('resolveDiscount: unknown customer → no discount', () => {
  wipe();
  assert.equal(resolveDiscount('NOBODY').forPart('A'), null);
  assert.equal(resolveDiscount(null).forPart('A'), null);
});
