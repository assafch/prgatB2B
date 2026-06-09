// Follow-up: how many parts have attached files, and what does PARTEXTFILE_SUBFORM expose?
//   node --env-file=.env scripts/probe-images2.mjs
const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');
async function get(endpoint) {
  const res = await fetch(`${baseUrl}/${company}/${endpoint}`, { headers: { Authorization: auth, Accept: 'application/json' } });
  const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const hr = (t) => console.log('\n===== ' + t + ' =====');

// How many parts carry the ext-file flag / a filename / are web-published?
hr('Coverage counts');
for (const [label, filt] of [
  ['EXTFILEFLAG ne null', `EXTFILEFLAG ne null`],
  ['EXTFILENAME ne null', `EXTFILENAME ne null`],
  ["SHOWINWEB eq 'Y'", `SHOWINWEB eq 'Y'`],
]) {
  const r = await get(`LOGPART?$filter=${encodeURIComponent(filt)}&$top=1&$count=true&$select=PARTNAME`);
  console.log(`  ${label}: ${r.ok ? (r.data['@odata.count'] ?? '?') + ' parts' : 'ERR ' + r.status}`);
}

// Sample parts that DO have a filename set.
hr('Sample parts with EXTFILENAME set');
const withName = await get(`LOGPART?$filter=${encodeURIComponent('EXTFILENAME ne null')}&$top=5&$select=PARTNAME,PARTDES,EXTFILEFLAG,EXTFILENAME`);
console.log(withName.ok ? JSON.stringify(withName.data.value, null, 1) : 'ERR ' + withName.status);

// Expand the attached-files subform on parts that have files.
hr('PARTEXTFILE_SUBFORM expanded (parts with files)');
const exp = await get(`LOGPART?$filter=${encodeURIComponent('EXTFILEFLAG ne null')}&$top=3&$select=PARTNAME&$expand=PARTEXTFILE_SUBFORM`);
if (exp.ok && exp.data?.value) {
  for (const p of exp.data.value) {
    const sub = p.PARTEXTFILE_SUBFORM || [];
    console.log(`  ${p.PARTNAME}: ${sub.length} file(s)`);
    if (sub.length) { console.log('    fields:', Object.keys(sub[0]).join(',')); console.log('    sample:', JSON.stringify(sub[0])); }
  }
} else console.log('ERR', exp.status, JSON.stringify(exp.data).slice(0, 200));

// Can we reach the EXTFILES entity set under different names?
hr('Reach extended-files entity set');
for (const ent of ['EXTFILES', 'EXTFILELINKS', 'PARTEXTFILE', 'SYSEXTFILES']) {
  const r = await get(`${ent}?$top=1`);
  if (r.ok && r.data?.value?.length) console.log(`  ${ent}: EXISTS fields=${Object.keys(r.data.value[0]).join(',')}\n    sample=${JSON.stringify(r.data.value[0]).slice(0,300)}`);
  else if (r.ok) console.log(`  ${ent}: EXISTS but empty`);
  else console.log(`  ${ent}: ${r.status}`);
}
console.log('\n__DONE__');
