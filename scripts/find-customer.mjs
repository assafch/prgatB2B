// Read-only: search Priority CUSTOMERS by a name fragment (matches CUSTDES or CUSTNAME).
//   node --env-file=.env scripts/find-customer.mjs "מ.נ.מ"
// Pulls all customers (paginated) and filters client-side — robust against OData
// quirks with Hebrew / punctuation in $filter.
const term = (process.argv[2] || '').trim();
if (!term) { console.error('Usage: node --env-file=.env scripts/find-customer.mjs "<name fragment>"'); process.exit(1); }

const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
if (!baseUrl || !company || !pat) { console.error('Missing PRIORITY_* env'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');

async function allCustomers() {
  const out = [];
  let skip = 0;
  const top = 500;
  while (true) {
    const url = `${baseUrl}/${company}/CUSTOMERS?$select=CUSTNAME,CUSTDES,PHONE,EMAIL,INACTIVEFLAG&$top=${top}&$skip=${skip}`;
    const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`CUSTOMERS ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const batch = json.value || [];
    out.push(...batch);
    if (batch.length < top) break;
    skip += top;
  }
  return out;
}

const customers = await allCustomers();
console.log(`Priority CUSTOMERS: ${customers.length} total`);

// Normalize for loose matching (strip dots/spaces) so "מ.נ.מ", "מנמ", "מ נ מ" all match.
const norm = (s) => String(s ?? '').replace(/[.\s]/g, '');
const needle = norm(term);
const hits = customers.filter(
  (c) => norm(c.CUSTDES).includes(needle) || norm(c.CUSTNAME).includes(needle)
);

console.log(`Matches for "${term}": ${hits.length}`);
for (const c of hits) {
  console.log(`  CUSTNAME=${c.CUSTNAME}  CUSTDES=${c.CUSTDES ?? ''}  PHONE=${c.PHONE ?? ''}  EMAIL=${c.EMAIL ?? ''}  ${c.INACTIVEFLAG ? '[INACTIVE]' : ''}`);
}
