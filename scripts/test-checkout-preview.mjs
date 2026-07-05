// Unit checks for the checkout-preview math. Run: npm run build && node scripts/test-checkout-preview.mjs
import assert from 'node:assert/strict';
import { vatBreakdown, withVat } from '../dist/server/money.js';

// The walkthrough numbers: 513.60 pre-VAT → 606.05 payable, 92.45 VAT.
assert.deepEqual(vatBreakdown(513.6), { vatRate: 0.18, vatAmount: 92.45, payable: 606.05 });
// Components must sum exactly (display rows must reconcile).
for (const v of [0, 0.01, 99.99, 513.6, 1234.56]) {
  const b = vatBreakdown(v);
  assert.equal(Math.round((v + b.vatAmount) * 100) / 100, b.payable, `sum mismatch for ${v}`);
  assert.equal(b.payable, withVat(v), `withVat mismatch for ${v}`);
}
assert.deepEqual(vatBreakdown(0), { vatRate: 0.18, vatAmount: 0, payable: 0 });
console.log('vatBreakdown: ALL PASS');
