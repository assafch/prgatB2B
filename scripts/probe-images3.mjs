// Surgical follow-up: scan raw rows, expand PARTEXTFILE_SUBFORM BY KEY, read metadata shape.
//   node --env-file=.env scripts/probe-images3.mjs
const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');
async function get(endpoint, raw = false) {
  const res = await fetch(`${baseUrl}/${company}/${endpoint}`, { headers: { Authorization: auth, Accept: raw ? 'application/xml' : 'application/json' } });
  const text = await res.text(); if (raw) return { ok: res.ok, status: res.status, text };
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const hr = (t) => console.log('\n===== ' + t + ' =====');
const enc = encodeURIComponent;

// 1. Raw scan: do ANY of the first 50 parts carry EXTFILEFLAG / EXTFILENAME / SHOWINWEB / WEBLEVEL?
hr('Raw scan of 50 rows for file/web flags');
const scan = await get(`LOGPART?$top=50&$select=PARTNAME,PARTDES,EXTFILEFLAG,EXTFILENAME,SHOWINWEB,WEBLEVEL`);
let keys = [];
if (scan.ok && scan.data?.value) {
  const rows = scan.data.value;
  const withFlag = rows.filter(r => r.EXTFILEFLAG != null);
  const withName = rows.filter(r => r.EXTFILENAME != null);
  const inWeb = rows.filter(r => r.SHOWINWEB === 'Y');
  const lvl = rows.filter(r => r.WEBLEVEL != null);
  console.log(`  of ${rows.length}: EXTFILEFLAG set=${withFlag.length}, EXTFILENAME set=${withName.length}, SHOWINWEB=Y=${inWeb.length}, WEBLEVEL set=${lvl.length}`);
  if (withName.length) console.log('  EXTFILENAME samples:', JSON.stringify(withName.slice(0,3)));
  if (inWeb.length) console.log('  SHOWINWEB samples:', JSON.stringify(inWeb.slice(0,3)));
  keys = rows.map(r => r.PARTNAME);
  console.log('  first 5 PARTNAMEs:', keys.slice(0,5).join(', '));
} else console.log('  ERR', scan.status, JSON.stringify(scan.data).slice(0,200));

// 2. Expand PARTEXTFILE_SUBFORM BY KEY (single entity) — avoids the collection-level 500.
hr('Expand PARTEXTFILE_SUBFORM by key');
for (const k of keys.slice(0, 5)) {
  const r = await get(`LOGPART('${k.replace(/'/g, "''")}')?$expand=PARTEXTFILE_SUBFORM`);
  if (r.ok) {
    const sub = r.data?.PARTEXTFILE_SUBFORM;
    if (Array.isArray(sub) && sub.length) {
      console.log(`  ${k}: ${sub.length} file(s) — fields: ${Object.keys(sub[0]).join(',')}`);
      console.log('    sample:', JSON.stringify(sub[0]).slice(0, 400));
    } else console.log(`  ${k}: 0 files`);
  } else console.log(`  ${k}: ERR ${r.status} ${JSON.stringify(r.data).slice(0,120)}`);
}

// 3. Sub-path navigation: LOGPART('key')/PARTEXTFILE_SUBFORM
hr('Sub-path navigation on first key');
if (keys[0]) {
  const r = await get(`LOGPART('${keys[0].replace(/'/g, "''")}')/PARTEXTFILE_SUBFORM`);
  console.log(`  status ${r.status};`, r.ok ? `rows=${r.data?.value?.length ?? '?'} ${r.data?.value?.[0] ? 'fields='+Object.keys(r.data.value[0]).join(',') : ''}` : JSON.stringify(r.data).slice(0,160));
}

// 4. Metadata: PARTEXTFILE entity type properties + the nav target type.
hr('Metadata shape of PARTEXTFILE_SUBFORM target');
const meta = await get('$metadata', true);
if (meta.ok) {
  const xml = meta.text;
  const navM = xml.match(/<NavigationProperty[^>]*Name="PARTEXTFILE_SUBFORM"[^>]*Type="([^"]+)"/);
  const target = navM ? navM[1].replace(/^Collection\(|\)$/g, '').replace(/^[^.]*\./, '') : null;
  console.log('  nav target type:', target || '(not found)');
  if (target) {
    const blk = xml.match(new RegExp(`<EntityType[^>]*Name="${target}"[\\s\\S]*?</EntityType>`));
    if (blk) {
      const props = [...blk[0].matchAll(/<Property[^>]*Name="([^"]+)"[^>]*Type="([^"]+)"/g)].map(m => `${m[1]}:${m[2].replace('Edm.','')}`);
      console.log('  properties:', props.join(', '));
    }
  }
  // Also: EXTFILES entity type props (the actual file store)
  const ef = xml.match(/<EntityType[^>]*Name="EXTFILES"[\s\S]*?<\/EntityType>/);
  if (ef) {
    const props = [...ef[0].matchAll(/<Property[^>]*Name="([^"]+)"[^>]*Type="([^"]+)"/g)].map(m => `${m[1]}:${m[2].replace('Edm.','')}`);
    console.log('  EXTFILES properties:', props.join(', '));
  }
}
console.log('\n__DONE__');
