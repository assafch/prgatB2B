// Broad sweep: across the WHOLE LOGPART catalog, does ANY part carry an attached file or web flag?
//   node --env-file=.env scripts/probe-images4.mjs
const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');
async function get(endpoint) {
  const res = await fetch(`${baseUrl}/${company}/${endpoint}`, { headers: { Authorization: auth, Accept: 'application/json' } });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const enc = encodeURIComponent;

// Total count.
const cnt = await get(`LOGPART/$count`);
console.log('LOGPART total:', typeof cnt.data === 'number' ? cnt.data : JSON.stringify(cnt.data).slice(0,80));

// Sweep pages of 500, selecting only the flags we care about. Count non-null; collect hits.
const PAGES = 12, SIZE = 500; // up to 6000 parts
let seen = 0, flag = 0, name = 0, web = 0, lvl = 0;
const hits = [];
for (let p = 0; p < PAGES; p++) {
  const r = await get(`LOGPART?$top=${SIZE}&$skip=${p*SIZE}&$select=PARTNAME,EXTFILEFLAG,EXTFILENAME,SHOWINWEB,WEBLEVEL`);
  if (!r.ok) { console.log(`  page ${p}: ERR ${r.status}`); break; }
  const rows = r.data?.value || [];
  if (!rows.length) { console.log(`  page ${p}: empty — end of catalog`); break; }
  for (const row of rows) {
    seen++;
    if (row.EXTFILEFLAG != null) { flag++; if (hits.length < 10) hits.push({ k: row.PARTNAME, flag: row.EXTFILEFLAG, name: row.EXTFILENAME }); }
    if (row.EXTFILENAME != null) name++;
    if (row.SHOWINWEB === 'Y') web++;
    if (row.WEBLEVEL != null) lvl++;
  }
  if (rows.length < SIZE) { console.log(`  swept ${seen} so far (last page ${p})`); break; }
}
console.log(`\nSwept ${seen} parts:`);
console.log(`  EXTFILEFLAG set : ${flag}`);
console.log(`  EXTFILENAME set : ${name}`);
console.log(`  SHOWINWEB = Y   : ${web}`);
console.log(`  WEBLEVEL set    : ${lvl}`);
if (hits.length) console.log('  sample hits:', JSON.stringify(hits, null, 1));

// If any part had a flag, expand its subform to see what's actually attached.
if (hits.length) {
  const k = hits[0].k.replace(/'/g, "''");
  const ex = await get(`LOGPART('${k}')?$expand=PARTEXTFILE_SUBFORM`);
  const sub = ex.data?.PARTEXTFILE_SUBFORM;
  console.log(`\nFirst hit ${hits[0].k} files:`, Array.isArray(sub) ? JSON.stringify(sub, null, 1).slice(0, 600) : ex.status);
}
console.log('\n__DONE__');
