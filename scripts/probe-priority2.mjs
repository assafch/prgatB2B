// Read-only probe #2 — focus on accounts-receivable / open-invoice / balance entities.
//   node --env-file=.env scripts/probe-priority2.mjs

const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');

async function get(endpoint) {
  const url = `${baseUrl}/${company}/${endpoint}`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const line = (s = '') => console.log(s);
const hr = (t) => console.log('\n========== ' + t + ' ==========');

const candidates = [
  'OPENINVOICES', 'ACCOUNTS_RECEIVABLE', 'OBLIGO', 'AGEDEBTS_WORKAREA',
  'FNCCUST', 'FNCTRANS', 'ORDFNCBALSINGLE', 'CUSTSTATS',
];

for (const entity of candidates) {
  hr(entity);
  const r = await get(`${entity}?$top=2`);
  if (!r.ok) { line(`status=${r.status} ${typeof r.data === 'string' ? r.data.slice(0,160) : JSON.stringify(r.data).slice(0,260)}`); continue; }
  const rows = r.data?.value || [];
  if (!rows.length) { line('EXISTS but returned 0 rows.'); continue; }
  const fields = Object.keys(rows[0]).sort();
  line('Fields: ' + fields.join(', '));
  const hasCust = fields.includes('CUSTNAME');
  line('hasCUSTNAME=' + hasCust);
  // print finance-ish values of first row
  line('First row finance values:');
  for (const k of fields) {
    if (/(price|sum|bal|rem|debit|credit|debt|due|date|cust|cdes|ivnum|ivtype|fnc|oblig|amount|total|open|qprice|paid|days|age)/i.test(k)) {
      line(`  ${k} = ${JSON.stringify(rows[0][k])}`);
    }
  }
}

// Now: find a customer that actually has an open invoice, then show their open items.
hr('OPENINVOICES — sample rows to find a real debtor');
const oi = await get(`OPENINVOICES?$top=5`);
if (oi.ok && oi.data?.value?.length) {
  for (const row of oi.data.value) {
    const cust = row.CUSTNAME ?? row.ACCNAME ?? '?';
    line(`CUSTNAME=${cust} :: ` + JSON.stringify(
      Object.fromEntries(Object.entries(row).filter(([k]) => /(ivnum|ivtype|cust|cdes|date|price|sum|rem|bal|debit|due|open|qprice)/i.test(k)))
    ));
  }
  const debtor = oi.data.value[0].CUSTNAME;
  if (debtor) {
    hr(`OPENINVOICES filtered by CUSTNAME='${debtor}'`);
    const safe = String(debtor).replace(/'/g, "''");
    const r = await get(`OPENINVOICES?$filter=CUSTNAME eq '${safe}'&$top=20`);
    if (r.ok) {
      const rows = r.data.value || [];
      line(`rows=${rows.length}`);
      let totalOpen = 0;
      for (const row of rows) {
        const amt = Number(row.SUM ?? row.REMPRICE ?? row.QPRICE ?? row.TOTPRICE ?? row.DEBIT ?? 0);
        line(JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => /(ivnum|ivtype|date|price|sum|rem|bal|debit|credit|due|fnc)/i.test(k)))));
      }
    } else line(`status=${r.status} ${JSON.stringify(r.data).slice(0,300)}`);

    // AINVOICES for that same debtor (tax invoices history), valid select only
    hr(`AINVOICES filtered by CUSTNAME='${debtor}' (valid fields)`);
    const a = await get(`AINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=IVDATE desc&$top=8&$select=IVNUM,IVTYPE,CUSTNAME,CDES,IVDATE,DISTRDATE,TOTPRICE,QPRICE,VAT,DISCOUNT,ORDNAME,STATDES,FNCNUM`);
    if (a.ok) line(JSON.stringify(a.data.value, null, 2));
    else line(`status=${a.status} ${JSON.stringify(a.data).slice(0,300)}`);
  }
}

line('\n__PROBE2_DONE__');
