// Read-only check that the exact finance queries (getCustomer, listOpenInvoices,
// listInvoices, getObligo) return real data for a given customer.
//   node --env-file=.env scripts/probe-10184.mjs [CUSTNAME]
const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
if (!baseUrl || !company || !pat) { console.error('Missing PRIORITY_* env'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');
const cust = (process.argv[2] || '10184').trim();
const safe = cust.replace(/'/g, "''");

async function get(endpoint) {
  const res = await fetch(`${baseUrl}/${company}/${endpoint}`, { headers: { Authorization: auth, Accept: 'application/json' } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

console.log('=== Customer', cust, '===');
const c = await get(`CUSTOMERS?$filter=CUSTNAME eq '${safe}'&$top=1&$select=CUSTNAME,CUSTDES,ADDRESS,STATE,ZIP,PHONE,EMAIL,VATNUM,PAYDES,AGENTNAME`);
console.log('CUSTOMERS:', c.ok ? JSON.stringify(c.data.value?.[0] ?? null) : `ERR ${c.status}`);

const open = await get(`OPENINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=CURDATE desc&$top=500&$select=CURDATE,TOTPRICE,DISPRICE,VAT,DOCNO,ORDNAME,REFERENCE`);
if (open.ok) {
  const rows = open.data.value || [];
  const total = rows.reduce((s, r) => s + (Number(r.TOTPRICE) || 0), 0);
  console.log(`OPENINVOICES: ${rows.length} rows, openTotal=${total.toFixed(2)}`);
  console.log('  sample:', JSON.stringify(rows.slice(0, 3)));
} else console.log('OPENINVOICES ERR', open.status, JSON.stringify(open.data).slice(0, 200));

const inv = await get(`AINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=IVDATE desc&$top=100&$select=IVNUM,IVDATE,TOTPRICE,QPRICE,VAT,STATDES,ORDNAME`);
if (inv.ok) {
  const rows = inv.data.value || [];
  const finalRows = rows.filter((r) => (r.STATDES || '').trim() === 'סופית');
  console.log(`AINVOICES: ${rows.length} rows (${finalRows.length} final), statuses=${[...new Set(rows.map(r => r.STATDES))].join('|')}`);
  console.log('  sample:', JSON.stringify(rows.slice(0, 3)));
} else console.log('AINVOICES ERR', inv.status, JSON.stringify(inv.data).slice(0, 200));

const ob = await get(`OBLIGO?$filter=CUSTNAME eq '${safe}'&$top=1&$select=OBLIGO,MAX_CREDIT,MAX_OBLIGO`);
console.log('OBLIGO:', ob.ok ? JSON.stringify(ob.data.value?.[0] ?? null) : `ERR ${ob.status}`);
console.log('__DONE__');
