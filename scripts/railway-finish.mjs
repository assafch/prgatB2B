// After the first `railway up`: create the public domain and set APP_ORIGIN /
// APP_BASE_URL to it. Prints the live URL on the last stdout line.
//   RAILWAY_API_TOKEN=<workspace token> node scripts/railway-finish.mjs
import fs from 'node:fs';

const TOKEN = process.env.RAILWAY_API_TOKEN;
const API = 'https://backboard.railway.com/graphql/v2';
const d = JSON.parse(fs.readFileSync('.railway-deploy.json', 'utf8'));
const log = (...a) => console.error('[railway-finish]', ...a);

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(query.slice(0, 50) + ' → ' + JSON.stringify(json.errors));
  return json.data;
}

// Existing domains?
let domain;
const existing = await gql(
  `query($p:String!,$e:String!,$s:String!){ domains(projectId:$p, environmentId:$e, serviceId:$s){ serviceDomains{ domain } } }`,
  { p: d.projectId, e: d.environmentId, s: d.serviceId }
).catch((e) => {
  log('domains query failed (continuing to create):', e.message);
  return null;
});
domain = existing?.domains?.serviceDomains?.[0]?.domain;

if (!domain) {
  // App binds to process.env.PORT (Railway-provided); let Railway target it.
  const created = await gql(
    `mutation($input: ServiceDomainCreateInput!){ serviceDomainCreate(input:$input){ domain } }`,
    { input: { environmentId: d.environmentId, serviceId: d.serviceId } }
  );
  domain = created.serviceDomainCreate.domain;
  log('domain created');
}
const url = `https://${domain}`;
log('URL', url);

for (const name of ['APP_ORIGIN', 'APP_BASE_URL']) {
  await gql(`mutation($input: VariableUpsertInput!){ variableUpsert(input:$input) }`, {
    input: { projectId: d.projectId, environmentId: d.environmentId, serviceId: d.serviceId, name, value: url },
  });
  log('var set', name);
}

console.log(url);
