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

// cash → must pay the cart total, order allowed (held)
assert.deepEqual(decide(cash, 0, 500), { allowOrder: true, requiresPayment: true, amount: 500, reason: 'cash_payment_required' });
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
