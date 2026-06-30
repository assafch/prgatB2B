// Integration test for Priority receipts — runs ONLY against a Priority TEST company.
// Skips (exit 0) if TEST creds are absent, so it never touches the production company.
//
// Required env to run:
//   PRIORITY_TEST_BASE_URL   e.g. https://p.priority-connect.online/odata/Priority/tabp008h.ini
//   PRIORITY_TEST_COMPANY    the TEST company db (e.g. aXXXXXX)
//   PRIORITY_TEST_PAT        an API token for the TEST company
//   PRIORITY_TEST_CUSTNAME   an existing customer in the TEST company
// Optional: PRIORITY_TEST_CASHNAME (default 020), PRIORITY_TEST_OWNER (default אורטל),
//           PRIORITY_TEST_CC (default 13)
//
// Run: npm run build && node scripts/itest-priority-receipts.mjs
import assert from 'node:assert/strict';
import { buildReceiptBody } from '../dist/server/priorityReceipts.js';

const base = process.env.PRIORITY_TEST_BASE_URL;
const company = process.env.PRIORITY_TEST_COMPANY;
const pat = process.env.PRIORITY_TEST_PAT;
const cust = process.env.PRIORITY_TEST_CUSTNAME;
if (!base || !company || !pat || !cust) {
  console.log('SKIP: Priority TEST creds not set (set PRIORITY_TEST_BASE_URL/COMPANY/PAT/CUSTNAME to run). Never run against production.');
  process.exit(0);
}

const auth = 'Basic ' + Buffer.from(pat + ':PAT').toString('base64');
async function req(endpoint, method = 'GET', body = null) {
  const r = await fetch(`${base}/${company}/${endpoint}`, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${r.status}: ${t.slice(0, 300)}`);
  return d;
}

const cfg = {
  cashname: process.env.PRIORITY_TEST_CASHNAME || '020',
  ownerlogin: process.env.PRIORITY_TEST_OWNER || 'אורטל',
  ccPaymentcode: process.env.PRIORITY_TEST_CC || '13',
  terminal: null,
};
// deterministic, unique, <=24 chars
const id = ('itest' + Date.now().toString(16)).slice(0, 24);
const ivdate = new Date().toISOString().slice(0, 10);

// 1) On-account receipt (scenario 1 shape, no ORDNAME needed for the smoke test)
const body = buildReceiptBody(
  { cardPaymentId: id, custname: cust, amount: 1, cardLast4: '4242', confNum: 'ITEST', ivdate, ordname: null, invoiceRefs: null },
  cfg
);
const created = await req('TINVOICES', 'POST', body);
assert.ok(created.IVNUM, 'created receipt has IVNUM');
console.log('created on-account receipt:', created.IVNUM, '(amount 1, card 4242)');

// 2) Idempotency: the same DETAILS ref must already be found (so createReceipt would adopt it)
const safeId = id.replace(/'/g, "''");
const dup = await req(`TINVOICES?$filter=DETAILS eq '${safeId}'&$select=IVNUM&$top=1`);
assert.equal(dup.value?.[0]?.IVNUM, created.IVNUM, 'idempotency: found the same receipt by DETAILS');
console.log('idempotency OK: DETAILS lookup returns', dup.value[0].IVNUM);

// 3) Scenario 2 shape builds a REFERENCE hint (payload-level assertion; no second POST needed)
const r2 = buildReceiptBody(
  { cardPaymentId: id + 'x', custname: cust, amount: 1, cardLast4: '4242', confNum: 'ITEST', ivdate, ordname: null, invoiceRefs: ['T1', 'T2'] },
  cfg
);
assert.ok(String(r2.REFERENCE).includes('T1'), 'scenario 2 sets REFERENCE hint');

console.log('priority-receipts integration: ALL PASS (TEST company', company + ')');
