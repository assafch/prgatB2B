// Unit checks for the pure receipt payload builder. Run: node scripts/test-priority-receipts.mjs
import assert from 'node:assert/strict';
import { buildReceiptBody } from '../dist/server/priorityReceipts.js';

const cfg = { cashname: '020', ownerlogin: 'אורטל', ccPaymentcode: '13', terminal: null };
const base = { cardPaymentId: 'abcdef0123456789abcdef01', custname: '10184', amount: 188.33, cardLast4: '1234', confNum: 'A12345', ivdate: '2026-06-30' };

const r1 = buildReceiptBody({ ...base, ordname: 'SO26000123', invoiceRefs: null }, cfg);
assert.equal(r1.ACCNAME, '10184'); assert.equal(r1.CUSTNAME, '10184');
assert.equal(r1.CASHNAME, '020'); assert.equal(r1.OWNERLOGIN, 'אורטל');
assert.equal(r1.STATDES, 'סופית'); assert.equal(r1.FINAL, 'Y');
assert.equal(r1.CODE, 'ש"ח'); assert.equal(r1.FNCPATNAME, 'ק');
assert.equal(r1.TOTPRICE, 188.33);
assert.equal(r1.DETAILS, 'abcdef0123456789abcdef01');
assert.equal(r1.ORDNAME, 'SO26000123');
assert.ok(!r1.REFERENCE);
const line1 = r1.TPAYMENT2_SUBFORM[0];
assert.equal(line1.PAYMENTCODE, '13');
assert.equal(line1.QPRICE, 188.33); assert.equal(line1.FIRSTPAY, 188.33); assert.equal(line1.TOTPRICE, 188.33);
assert.equal(line1.CASHNAME, '020'); assert.equal(line1.CARDNUM, '1234'); assert.equal(line1.CONFNUM, 'A12345');

const r2 = buildReceiptBody({ ...base, ordname: null, invoiceRefs: ['T26000045', 'T26000046'] }, cfg);
assert.ok(!r2.ORDNAME);
assert.ok(r2.REFERENCE.includes('T26000045'));
assert.equal(r2.TOTPRICE, 188.33);

assert.equal(buildReceiptBody({ ...base, amount: 100, ordname: 'X', invoiceRefs: null }, cfg).TOTPRICE, 100);
console.log('priority-receipts builder: ALL PASS');
