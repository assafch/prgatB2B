// Read-only probe of the live Priority OData API to discover invoice + financial
// (accounts-receivable) entities for the B2B portal. GET requests only.
//
//   node --env-file=.env scripts/probe-priority.mjs
//
// Prints: service-root entity list (filtered to finance-relevant names), a sample
// invoice with all fields, invoices for one customer, and a full customer record.

const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();

if (!baseUrl || !company || !pat) {
  console.error('Missing PRIORITY_* env vars'); process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');

async function get(endpoint) {
  const url = `${baseUrl}/${company}/${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    return { ok: false, status: res.status, data };
  }
  return { ok: true, status: res.status, data };
}

function line(s = '') { console.log(s); }
function hr(t) { console.log('\n========== ' + t + ' =========='); }

// 1. Service root — list entity sets, highlight finance-relevant ones.
hr('SERVICE ROOT (entity sets)');
const root = await get('');
if (root.ok && root.data && Array.isArray(root.data.value)) {
  const names = root.data.value.map((e) => e.name || e.url).filter(Boolean);
  const rx = /(invoice|invo|fnc|finan|balance|oblig|debit|debt|recei|payment|pay|cash|ledg|account|kart|iv)/i;
  const finance = names.filter((n) => rx.test(n));
  line(`Total entity sets: ${names.length}`);
  line('Finance-relevant entity sets:');
  for (const n of finance.sort()) line('  - ' + n);
  line('\nALL entity sets:');
  line('  ' + names.sort().join(', '));
} else {
  line('Service root failed: ' + JSON.stringify(root).slice(0, 500));
}

// 2. Sample one AINVOICES (tax invoice) row — all fields.
for (const entity of ['AINVOICES', 'EINVOICES']) {
  hr(`${entity} — one sample row (all fields)`);
  const r = await get(`${entity}?$top=1`);
  if (r.ok && r.data?.value?.length) {
    const row = r.data.value[0];
    line('Field names: ' + Object.keys(row).sort().join(', '));
    line('\nSample values (finance fields):');
    for (const k of Object.keys(row).sort()) {
      if (/(price|sum|vat|rem|cal|debit|paid|pay|date|cust|cdes|ivnum|ivtype|status|stat|booknum|ordname|disc|balance|total)/i.test(k)) {
        line(`  ${k} = ${JSON.stringify(row[k])}`);
      }
    }
    line('\n__SAMPLE_CUSTNAME__=' + (row.CUSTNAME ?? ''));
    line('__SAMPLE_ENTITY__=' + entity);
  } else {
    line(`${entity} probe: status=${r.status} ${typeof r.data === 'string' ? r.data.slice(0,200) : JSON.stringify(r.data).slice(0,300)}`);
  }
}

// 3. Invoices for one customer, recent first, with the fields that matter for AR.
hr('AINVOICES for a sample customer (recent, AR fields)');
const sampleCust = await get(`AINVOICES?$top=1&$orderby=IVDATE desc`);
let custForProbe = '';
if (sampleCust.ok && sampleCust.data?.value?.length) {
  custForProbe = sampleCust.data.value[0].CUSTNAME || '';
}
if (custForProbe) {
  const safe = String(custForProbe).replace(/'/g, "''");
  const r = await get(
    `AINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=IVDATE desc&$top=8` +
    `&$select=IVNUM,IVTYPE,DEBIT,CUSTNAME,CDES,IVDATE,PAYDATE,TOTPRICE,QPRICE,VAT,REMPRICE,CALQPRICE,PAYCODE,PAYDES,STATDES,BOOKNUM,ORDNAME`
  );
  line('Customer probed: ' + custForProbe);
  if (r.ok) {
    line(JSON.stringify(r.data.value, null, 2));
  } else {
    line(`status=${r.status} ${JSON.stringify(r.data).slice(0,400)}`);
  }

  // 4. Full customer record — discover balance/obligo fields.
  hr('CUSTOMERS — full record for that customer (balance/obligo fields)');
  const c = await get(`CUSTOMERS?$filter=CUSTNAME eq '${safe}'&$top=1`);
  if (c.ok && c.data?.value?.length) {
    const row = c.data.value[0];
    line('All field names: ' + Object.keys(row).sort().join(', '));
    line('\nFinance-relevant fields:');
    for (const k of Object.keys(row).sort()) {
      if (/(balance|oblig|debit|debt|credit|total|sum|pay|cash|iv|due|max|cust|cdes|phone|email|address|addres|state|city|zip|vat|hoknum|family|terms)/i.test(k)) {
        line(`  ${k} = ${JSON.stringify(row[k])}`);
      }
    }
  } else {
    line(`CUSTOMERS probe: status=${c.status} ${JSON.stringify(c.data).slice(0,300)}`);
  }
}

// 5. Probe likely financial/ledger entities (open items / כרטסת).
for (const entity of ['FNCITEMS', 'FNCITEMS1', 'CUSTFNCITEMS', 'ACCOUNTS', 'TFNCITEMS']) {
  hr(`PROBE ${entity}`);
  const r = await get(`${entity}?$top=1`);
  if (r.ok && r.data?.value?.length) {
    line('EXISTS. Field names: ' + Object.keys(r.data.value[0]).sort().join(', '));
  } else if (r.ok) {
    line('EXISTS but empty.');
  } else {
    line(`status=${r.status} ${typeof r.data === 'string' ? r.data.slice(0,150) : JSON.stringify(r.data).slice(0,200)}`);
  }
}

line('\n__PROBE_DONE__');
