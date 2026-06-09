// Read-only discovery: does Priority expose product images for LOGPART, and how?
//   node --env-file=.env scripts/probe-images.mjs
const baseUrl = (process.env.PRIORITY_BASE_URL || '').trim().replace(/\/+$/, '');
const company = (process.env.PRIORITY_COMPANY || '').trim();
const pat = (process.env.PRIORITY_PAT || '').trim();
if (!baseUrl || !company || !pat) { console.error('Missing PRIORITY_* env'); process.exit(1); }
const auth = 'Basic ' + Buffer.from(`${pat}:PAT`).toString('base64');

async function get(endpoint, raw = false) {
  const res = await fetch(`${baseUrl}/${company}/${endpoint}`, { headers: { Authorization: auth, Accept: raw ? 'application/xml' : 'application/json' } });
  const text = await res.text();
  if (raw) return { ok: res.ok, status: res.status, text };
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}
const hr = (t) => console.log('\n===== ' + t + ' =====');

// 1. One LOGPART row, ALL fields — look for image-ish columns.
hr('LOGPART — all fields on one row');
const one = await get('LOGPART?$top=1');
if (one.ok && one.data?.value?.length) {
  const row = one.data.value[0];
  const keys = Object.keys(row).sort();
  console.log('ALL fields:', keys.join(', '));
  console.log('\nImage/file-ish fields + values:');
  for (const k of keys) if (/(image|img|pictur|photo|foto|file|doc|url|link|pic)/i.test(k)) console.log(`  ${k} = ${JSON.stringify(row[k])}`);
} else console.log('LOGPART failed', one.status, JSON.stringify(one.data).slice(0,200));

// 2. $metadata — find LOGPART navigation properties + file/image entity sets.
hr('$metadata — LOGPART navProps + file/image entities');
const meta = await get('$metadata', true);
if (meta.ok) {
  const xml = meta.text;
  // EntityType LOGPART block
  const block = xml.match(/<EntityType[^>]*Name="LOGPART"[\s\S]*?<\/EntityType>/i);
  if (block) {
    const navs = [...block[0].matchAll(/<NavigationProperty[^>]*Name="([^"]+)"[^>]*(?:Type="([^"]+)")?/g)].map(m => `${m[1]} -> ${m[2]||'?'}`);
    console.log('LOGPART NavigationProperties:', navs.length ? navs.join(' | ') : '(none)');
  } else console.log('LOGPART EntityType not found in metadata');
  // Entity sets / types whose name hints at files/images/docs
  const types = [...xml.matchAll(/<EntityType[^>]*Name="([^"]+)"/g)].map(m => m[1]);
  const hits = types.filter(n => /(ext.*file|file|image|pictur|photo|doc|attach|media)/i.test(n));
  console.log('File/image-ish EntityTypes:', hits.length ? [...new Set(hits)].join(', ') : '(none)');
} else console.log('metadata failed', meta.status);

// 3. Try expanding plausible extended-file navs on a real part.
hr('Try $expand on LOGPART for extended files');
for (const nav of ['EXTFILES_SUBFORM', 'PARTEXTFILES_SUBFORM', 'EXTFILES', 'PART_EXTFILES', 'LOGPARTEXT_SUBFORM']) {
  const r = await get(`LOGPART?$top=1&$expand=${nav}`);
  if (r.ok) {
    const sub = r.data?.value?.[0]?.[nav];
    console.log(`  ${nav}: OK`, Array.isArray(sub) ? `(${sub.length} rows) ${sub.length ? 'fields=' + Object.keys(sub[0]).join(',') : ''}` : JSON.stringify(sub));
    if (Array.isArray(sub) && sub.length) console.log('     sample:', JSON.stringify(sub[0]).slice(0, 300));
  } else {
    console.log(`  ${nav}: ${r.status} ${(typeof r.data === 'string' ? r.data : JSON.stringify(r.data)).slice(0,120)}`);
  }
}

// 4. Probe standalone extended-file entity sets.
hr('Probe standalone file/image entity sets');
for (const ent of ['EXTFILES', 'EXTFILEDEF', 'PARTEXTFILES', 'DOCUMENTS']) {
  const r = await get(`${ent}?$top=1`);
  if (r.ok && r.data?.value?.length) console.log(`  ${ent}: EXISTS fields=${Object.keys(r.data.value[0]).join(',')}`);
  else if (r.ok) console.log(`  ${ent}: EXISTS but empty`);
  else console.log(`  ${ent}: ${r.status}`);
}
console.log('\n__DONE__');
