// Iron-rule validation (Discount Pricing board §E): the app's net price
// (BASEPLPRICE × (1 − derived customer discount)) must equal the Priority
// invoice net line (DISPRICE) for recent real invoices.
// Run: node --env-file=.env scripts/validate-discount-invoices.mjs   (build first)
import { getPriorityConfig, priorityRequest, getCustomerRecentDiscountLines } from '../dist/server/priority.js';
import { deriveDominantPercent, applyDiscount } from '../dist/server/discounts.js';

const config = getPriorityConfig();
if (!config) { console.error('PRIORITY_* env missing'); process.exit(1); }

const round2 = (n) => Math.round(n * 100) / 100;

// 1. Last 20 FINAL invoices (headers only — expanding lines across many headers times out).
const heads = (await priorityRequest(
  config,
  `AINVOICES?$filter=FINAL eq 'Y'&$orderby=IVDATE desc&$top=20&$select=IVNUM,CUSTNAME,IVDATE`
)).value || [];
console.log(`validating ${heads.length} invoices...`);

const pctCache = new Map(); // custname -> derived percent (the app's mechanism)
async function customerPct(custname) {
  if (!pctCache.has(custname)) {
    try {
      pctCache.set(custname, deriveDominantPercent(await getCustomerRecentDiscountLines(config, custname)));
    } catch { pctCache.set(custname, null); }
  }
  return pctCache.get(custname);
}

const baseCache = new Map(); // partname -> current BASEPLPRICE
async function basePrice(partname) {
  if (!baseCache.has(partname)) {
    const safe = partname.replace(/'/g, "''");
    const r = (await priorityRequest(config, `LOGPART?$filter=PARTNAME eq '${safe}'&$select=PARTNAME,BASEPLPRICE`)).value || [];
    baseCache.set(partname, typeof r[0]?.BASEPLPRICE === 'number' ? r[0].BASEPLPRICE : null);
  }
  return baseCache.get(partname);
}

let lines = 0, ok = 0;
const mismatches = [];
for (const h of heads) {
  let inv;
  try {
    // NOTE: a $select INSIDE the expand gets 'terminated' by this Priority tenant —
    // the bare expand works (larger payload, but one invoice per call).
    inv = (await priorityRequest(
      config,
      `AINVOICES?$filter=IVNUM eq '${h.IVNUM}'&$expand=AINVOICEITEMS_SUBFORM`
    )).value?.[0];
  } catch (err) {
    console.warn(`  ${h.IVNUM}: line fetch failed (${err.message}) — skipped`);
    continue;
  }
  const pct = await customerPct(h.CUSTNAME);
  for (const ln of inv?.AINVOICEITEMS_SUBFORM || []) {
    if (!(ln.PRICE > 0)) continue; // freebies / zero lines are out of scope
    lines++;
    const base = await basePrice(ln.PARTNAME);
    const appNet = base != null ? applyDiscount(base, pct) : null;
    const prioNet = round2(ln.DISPRICE ?? ln.PRICE * (1 - (ln.PERCENT || 0) / 100));
    if (appNet != null && Math.abs(appNet - prioNet) <= 0.01) { ok++; continue; }
    mismatches.push({
      iv: h.IVNUM, cust: h.CUSTNAME, part: ln.PARTNAME,
      appNet, prioNet, base, derivedPct: pct, linePrice: ln.PRICE, linePct: ln.PERCENT,
      why: base == null ? 'no BASEPLPRICE' : ln.PRICE !== base ? `line PRICE ${ln.PRICE} != current base ${base} (list drift or per-cust price)` : `PERCENT ${ln.PERCENT} != derived ${pct ?? '—'}`,
    });
  }
}

console.log(`\nlines checked: ${lines}, matching: ${ok} (${lines ? Math.round((ok / lines) * 100) : 0}%)`);
if (mismatches.length) {
  console.log(`mismatches (${mismatches.length}):`);
  for (const m of mismatches) console.log(` ${m.iv} cust ${m.cust} ${m.part}: app ₪${m.appNet} vs invoice ₪${m.prioNet} — ${m.why}`);
}
