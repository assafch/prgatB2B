// Unit checks for the pure payment-policy engine. Run: node scripts/test-payment-policy.mjs
import assert from 'node:assert/strict';
import { derivePolicyKind, decide } from '../dist/server/paymentPolicy.js';

// derivePolicyKind
assert.equal(derivePolicyKind('מזומן', ['מזומן']), 'cash');
assert.equal(derivePolicyKind('שוטף+30', ['מזומן']), 'net');
assert.equal(derivePolicyKind(null, ['מזומן']), 'net');
assert.equal(derivePolicyKind('תשלום מזומן בלבד', ['מזומן']), 'cash');

const net = { kind: 'net', requirePaymentBeforeApproval: false, blockOnOpenDebt: true, openDebtThreshold: 0, allowOrderWithOpenDebt: false };
const cash = { kind: 'cash', requirePaymentBeforeApproval: true, blockOnOpenDebt: false, openDebtThreshold: 0, allowOrderWithOpenDebt: false };

// cash → must pay the cart total VAT-inclusive (500 × 1.18 = 590 incl-VAT 18%), order allowed (held)
assert.deepEqual(decide(cash, 0, 500), { allowOrder: true, requiresPayment: true, amount: 590, reason: 'cash_payment_required' });
// net + open debt > 0 → blocked
assert.equal(decide(net, 120, 500).allowOrder, false);
assert.equal(decide(net, 120, 500).reason, 'open_debt');
// net + no debt → allowed
assert.equal(decide(net, 0, 500).allowOrder, true);
// net + exempt → allowed despite debt
assert.equal(decide({ ...net, allowOrderWithOpenDebt: true }, 9999, 500).allowOrder, true);
// net + debt under threshold → allowed
assert.equal(decide({ ...net, openDebtThreshold: 200 }, 120, 500).allowOrder, true);
console.log('payment-policy engine: ALL PASS');

// DB-backed resolve (runs against the temp DATA_DIR the runner sets)
import { resolvePolicy } from '../dist/server/paymentPolicy.js';
import Database from 'better-sqlite3';
import path from 'node:path';
const db2 = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db2.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt) VALUES ('C-EXEMPT','net',0,1)").run();
db2.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt) VALUES ('C-FORCECASH','cash',null,0)").run();
db2.close();
assert.equal(resolvePolicy('C-FORCECASH', 'שוטף').kind, 'cash');
assert.equal(resolvePolicy('C-EXEMPT', 'שוטף').allowOrderWithOpenDebt, true);
assert.equal(resolvePolicy('UNKNOWN', 'מזומן').kind, 'cash');
console.log('resolvePolicy: ALL PASS');
