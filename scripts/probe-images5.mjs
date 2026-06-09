// Zoom in on the 64 parts that have EXTFILENAME set — what are the filenames, and what's in the subform?
//   node --env-file=.env scripts/probe-images5.mjs
const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');
async function get(endpoint, raw = false) {
  const res = await fetch(`${baseUrl}/${company}/${endpoint}`, { headers: { Authorization: auth, Accept: raw ? '*/*' : 'application/json' } });
  if (raw) { const buf = Buffer.from(await res.arrayBuffer()); return { ok: res.ok, status: res.status, ctype: res.headers.get('content-type'), len: buf.length, head: buf.slice(0, 16).toString('hex') }; }
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const hr = (t) => console.log('\n===== ' + t + ' =====');

// All parts with EXTFILENAME set.
hr('Parts with EXTFILENAME set');
const r = await get(`LOGPART?$top=500&$select=PARTNAME,PARTDES,EXTFILENAME`);
const withName = (r.data?.value || []).filter(x => x.EXTFILENAME != null);
console.log(`  ${withName.length} parts have EXTFILENAME`);
console.log('  first 15:', JSON.stringify(withName.slice(0, 15), null, 1));
// Extension breakdown.
const exts = {};
for (const x of withName) { const m = /\.([a-z0-9]+)$/i.exec(x.EXTFILENAME || ''); const e = m ? m[1].toLowerCase() : '(none)'; exts[e] = (exts[e]||0)+1; }
console.log('  extension breakdown:', JSON.stringify(exts));

// Expand the attached-file subform on the first 6 parts that have a filename.
hr('PARTEXTFILE_SUBFORM by key for parts WITH a filename');
let subFields = null, firstFileRow = null, firstKey = null;
for (const x of withName.slice(0, 6)) {
  const k = x.PARTNAME.replace(/'/g, "''");
  const ex = await get(`LOGPART('${k}')?$expand=PARTEXTFILE_SUBFORM`);
  const sub = ex.data?.PARTEXTFILE_SUBFORM;
  if (Array.isArray(sub) && sub.length) {
    if (!subFields) { subFields = Object.keys(sub[0]); firstFileRow = sub[0]; firstKey = x.PARTNAME; }
    console.log(`  ${x.PARTNAME} (${x.EXTFILENAME}): ${sub.length} subform row(s)`);
    console.log('    row0:', JSON.stringify(sub[0]).slice(0, 400));
  } else console.log(`  ${x.PARTNAME} (${x.EXTFILENAME}): subform empty (status ${ex.status})`);
}
if (subFields) console.log('\n  subform fields:', subFields.join(','));

// What does EXTFILES (the file store) look like — can we read a row & is there a binary field/media link?
hr('EXTFILES entity at root + by sub-path');
for (const path of ['EXTFILES?$top=3', `LOGPART('${(firstKey||'').replace(/'/g,"''")}')/PARTEXTFILE_SUBFORM`]) {
  if (!path) continue;
  const er = await get(path);
  if (er.ok) {
    const rows = er.data?.value || [];
    console.log(`  ${path.split('?')[0]} -> OK, ${rows.length} rows`, rows[0] ? 'fields=' + Object.keys(rows[0]).join(',') : '');
    if (rows[0]) console.log('    row0:', JSON.stringify(rows[0]).slice(0, 400));
  } else console.log(`  ${path.split('?')[0]} -> ${er.status} ${JSON.stringify(er.data).slice(0,120)}`);
}
console.log('\n__DONE__');
