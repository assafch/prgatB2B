// Step-0 probe (UPGRADE_PLAN P0): verify, READ-ONLY, how receipts (קבלות) can be
// recorded in this Priority tenant before any payment code is written.
//
//   node --env-file=.env --import tsx scripts/probe-tinvoices.ts
//
// Answers, with live evidence:
//   1. Is TINVOICES API-enabled? (precedent: the PAY form 400s with "API cannot
//      be activated for this form" — TINVOICES may need the Priority admin to
//      tick it under Limited Access/API Forms)
//   2. Its real subform names (payment-means lines, invoice matching) — the
//      TPAYMENT*/TFNCITEMS names are inferred from EINVOICES, never verified.
//   3. PAYMENTDEF payment-means codes (check vs credit card).
//   4. Does $filter=BOOKNUM eq '…' work? (P3's webhook-dedupe lookup; some
//      $filter expressions 500 on this tenant)
//
// NEVER add POST/PATCH here. This script must stay read-only.

const BASE =
  process.env.PRIORITY_BASE_URL ||
  'https://p.priority-connect.online/odata/Priority/tabp008h.ini';
const COMPANY = process.env.PRIORITY_COMPANY || 'a051014';
const PAT = process.env.PRIORITY_PAT;

if (!PAT) {
  console.error('PRIORITY_PAT missing from .env');
  process.exit(1);
}

const AUTH = 'Basic ' + Buffer.from(`${PAT}:PAT`).toString('base64');

async function get(pathname: string): Promise<{ status: number; body: string }> {
  const url = `${BASE}/${COMPANY}/${pathname}`;
  console.log(`\n→ GET ${url}`);
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: 'application/json' } });
  const body = await res.text();
  return { status: res.status, body };
}

function show(label: string, r: { status: number; body: string }, maxChars = 1800): void {
  console.log(`   [${label}] HTTP ${r.status}`);
  const trimmed = r.body.length > maxChars ? r.body.slice(0, maxChars) + ' …(truncated)' : r.body;
  console.log(
    trimmed
      .split('\n')
      .map((l) => '   ' + l)
      .join('\n')
  );
}

async function main(): Promise<void> {
  // 0. Auth sanity — fail fast with a clear message on a dead PAT.
  const sanity = await get('CUSTOMERS?$top=1&$select=CUSTNAME');
  if (sanity.status === 401) {
    console.error(
      '\n✗ PAT rejected (401). Issue a fresh PAT in Priority (ideally on a dedicated' +
        '\n  portal API user) and update .env, then re-run this probe.'
    );
    process.exit(1);
  }
  show('auth sanity', sanity, 300);

  // 1. TINVOICES — exists? rows? top-level fields?
  const tinv = await get('TINVOICES?$top=2');
  show('TINVOICES top 2', tinv);

  // 2. Candidate subform names, one expand at a time (a bad name 400s the whole query).
  for (const sub of [
    'TPAYMENT_SUBFORM',
    'TPAYMENT2_SUBFORM',
    'TFNCITEMS_SUBFORM',
    'FNCITEMS_SUBFORM',
    'TINVOICESFNCITEMS_SUBFORM',
  ]) {
    const r = await get(`TINVOICES?$top=1&$expand=${sub}`);
    console.log(`   expand ${sub}: HTTP ${r.status}${r.status === 200 ? '  ✓' : ''}`);
    if (r.status === 200) show(`TINVOICES + ${sub}`, r);
  }

  // 3. Payment-means definitions.
  const paydef = await get('PAYMENTDEF?$top=30');
  show('PAYMENTDEF', paydef, 2500);

  // 4. BOOKNUM filter (P3 webhook dedupe depends on this working).
  const m = /"BOOKNUM"\s*:\s*"([^"]+)"/.exec(tinv.body);
  if (m) {
    const r = await get(`TINVOICES?$filter=BOOKNUM eq '${m[1]}'&$top=1`);
    show(`BOOKNUM filter (eq '${m[1]}')`, r, 600);
  } else {
    console.log('\n   (no BOOKNUM value found in TINVOICES sample — filter test skipped)');
  }

  // 5. Receipt-relevant fields via $select probing (cheap shape check).
  const sel = await get('TINVOICES?$top=1&$select=IVNUM,IVDATE,CUSTNAME,TOTPRICE,STATDES,BOOKNUM');
  show('TINVOICES field select', sel, 600);

  console.log(
    '\nDone. Paste this output into the payments design review. If TINVOICES 400s' +
      "\nwith 'API cannot be activated', ask the Priority admin to enable the form" +
      '\nfor the API user, then re-run.'
  );
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exit(1);
});
