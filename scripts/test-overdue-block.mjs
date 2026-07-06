// Pure overdue-block helpers. Run: npm run build && node scripts/test-overdue-block.mjs
import assert from 'node:assert/strict';
import { parseNetTermsDays, invoiceDueDate, overdueSum } from '../dist/server/paymentPolicy.js';

// --- parseNetTermsDays ---
assert.equal(parseNetTermsDays('שוטף'), 0);
assert.equal(parseNetTermsDays('שוטף+30'), 30);
assert.equal(parseNetTermsDays('שוטף +30'), 30);
assert.equal(parseNetTermsDays('שוטף + 60'), 60);
assert.equal(parseNetTermsDays('שוטף30'), 30);
assert.equal(parseNetTermsDays(null), 0);
assert.equal(parseNetTermsDays('מזומן'), 0);
assert.equal(parseNetTermsDays('גיבוב'), 0);

// --- invoiceDueDate: end of invoice month + N ---
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0), '2026-07-31');
assert.equal(invoiceDueDate('2026-07-15T00:00:00Z', 0), '2026-07-31');
assert.equal(invoiceDueDate('2026-02-11T00:00:00Z', 0), '2026-02-28'); // Feb non-leap
assert.equal(invoiceDueDate('2028-02-05T00:00:00Z', 0), '2028-02-29'); // Feb leap
assert.equal(invoiceDueDate('2026-01-31T00:00:00Z', 30), '2026-03-02'); // EOM Jan(31) + 30
assert.equal(invoiceDueDate('2026-12-10T00:00:00Z', 0), '2026-12-31');
assert.equal(invoiceDueDate('2026-12-10T00:00:00Z', 30), '2027-01-30'); // year rollover
// Explicit IVPAY dates win; latest one governs
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0, ['2026-08-15T00:00:00Z', '2026-07-20T00:00:00Z']), '2026-08-15');
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0, []), '2026-07-31'); // empty array → computed
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0, [null, undefined]), '2026-07-31');

// --- overdueSum: real 10184 fixture (spec §2) — today 2026-07-06, terms שוטף ---
const fixture = [
  { IVDATE: '2026-02-11T00:00:00Z', TOTPRICE: 10739 },
  { IVDATE: '2026-02-12T00:00:00Z', TOTPRICE: 14 },
  { IVDATE: '2026-03-15T00:00:00Z', TOTPRICE: 4894 },
  { IVDATE: '2026-04-29T00:00:00Z', TOTPRICE: 7884 },
  { IVDATE: '2026-05-06T00:00:00Z', TOTPRICE: 12887 },
  { IVDATE: '2026-07-01T00:00:00Z', TOTPRICE: 8564 }, // due 31/7 — NOT overdue on 6/7
];
assert.equal(overdueSum(fixture, 'שוטף', '2026-07-06'), 36418);
// On 1/8 the July invoice becomes overdue (due 31/7 < 1/8)
assert.equal(overdueSum(fixture, 'שוטף', '2026-08-01'), 44982);
// On 31/7 (the due date itself) it is NOT yet overdue (strictly past)
assert.equal(overdueSum(fixture, 'שוטף', '2026-07-31'), 36418);
// שוטף+30 discriminates on 15/6: May invoice due EOM-May+30 = 30/6 → NOT yet
// overdue; Feb–Apr (due 30/3, 30/4, 30/5) are. Under plain שוטף on the same day,
// May (due 31/5) IS overdue.
assert.equal(overdueSum(fixture, 'שוטף+30', '2026-06-15'), 10739 + 14 + 4894 + 7884);
assert.equal(overdueSum(fixture, 'שוטף', '2026-06-15'), 10739 + 14 + 4894 + 7884 + 12887);
// Rounding + junk rows ignored
assert.equal(overdueSum([{ IVDATE: undefined, TOTPRICE: 100 }, { IVDATE: '2026-01-05T00:00:00Z', TOTPRICE: undefined }], 'שוטף', '2026-07-06'), 0);
console.log('overdue-block pure helpers: ALL PASS');

// resolvePolicy picks up the new column; computeBlockingNetDebt fails open with no
// Priority config (getUnpaidInvoicesCached → null) for an overdue-only customer.
import Database from 'better-sqlite3';
import path from 'node:path';
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, allow_order_with_open_debt, enforced, block_overdue_only) VALUES ('C-OVERDUE','net',0,1,1)").run();
db.close();
const { resolvePolicy, computeBlockingNetDebt } = await import('../dist/server/paymentPolicy.js');
const pol = resolvePolicy('C-OVERDUE', 'שוטף');
assert.equal(pol.blockOverdueOnly, true);
assert.equal(resolvePolicy('NO-SUCH', 'שוטף').blockOverdueOnly, false);
// No PRIORITY_* env in this test run → accessor returns null → fail-open → 0
assert.equal(await computeBlockingNetDebt('C-OVERDUE', pol, 5000, 'שוטף'), 0);
// Standard mode unchanged: blocking = openTotal (no pending settlements in scratch DB)
assert.equal(await computeBlockingNetDebt('C-STD', resolvePolicy('NO-SUCH', 'שוטף'), 5000, 'שוטף'), 5000);
console.log('resolvePolicy + computeBlockingNetDebt: ALL PASS');
