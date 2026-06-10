// One-shot Railway provisioning via the GraphQL API (the workspace token the CLI
// rejects works fine here as a Bearer token). Creates project + service + volume +
// env vars, then mints a PROJECT token the CLI *does* accept for `railway up`.
//
//   RAILWAY_API_TOKEN=<workspace token> node --env-file=.env scripts/railway-deploy.mjs
//
// Reads app secrets (PRIORITY_*, ADMIN_BOOTSTRAP_*) from .env. Prints IDs + the
// project token as JSON on the last line for the deploy step to consume.
import fs from 'node:fs';

const TOKEN = process.env.RAILWAY_API_TOKEN;
const API = 'https://backboard.railway.com/graphql/v2';
const PROJECT_NAME = process.env.RW_PROJECT_NAME || 'orgat-b2b';
const SERVICE_NAME = 'web';
if (!TOKEN) throw new Error('RAILWAY_API_TOKEN missing');

async function gql(query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(query.slice(0, 40) + ' → ' + JSON.stringify(json.errors));
  return json.data;
}

const log = (...a) => console.error('[railway-deploy]', ...a);

// 1. Project (+ its default production environment)
const proj = await gql(
  `mutation($input: ProjectCreateInput!){ projectCreate(input:$input){ id name environments{ edges{ node{ id name } } } } }`,
  { input: { name: PROJECT_NAME } }
);
const projectId = proj.projectCreate.id;
const envs = proj.projectCreate.environments.edges.map((e) => e.node);
const prodEnv = envs.find((e) => e.name === 'production') || envs[0];
const environmentId = prodEnv.id;
log('project', projectId, '| env', prodEnv.name, environmentId);

// 2. Service (empty — code is uploaded by `railway up`)
const svc = await gql(
  `mutation($input: ServiceCreateInput!){ serviceCreate(input:$input){ id name } }`,
  { input: { projectId, name: SERVICE_NAME } }
);
const serviceId = svc.serviceCreate.id;
log('service', serviceId);

// 3. Env vars (secrets sourced from .env). APP_ORIGIN/APP_BASE_URL set after the
//    domain is known (a later step), so omitted here.
const vars = {
  NODE_ENV: 'production',
  DATA_DIR: '/data',
  PAYMENTS_ENABLED: 'false',
  PRIORITY_BASE_URL: process.env.PRIORITY_BASE_URL || 'https://p.priority-connect.online/odata/Priority/tabp008h.ini',
  PRIORITY_COMPANY: process.env.PRIORITY_COMPANY || 'a051014',
  PRIORITY_PAT: process.env.PRIORITY_PAT,
  ADMIN_BOOTSTRAP_USERNAME: process.env.ADMIN_BOOTSTRAP_USERNAME || 'orgat-admin',
  ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD,
};
for (const [name, value] of Object.entries(vars)) {
  if (value == null || value === '') {
    log('WARN skipping empty var', name);
    continue;
  }
  await gql(
    `mutation($input: VariableUpsertInput!){ variableUpsert(input:$input) }`,
    { input: { projectId, environmentId, serviceId, name, value } }
  );
  log('var set', name);
}

// 4. Persistent volume for the SQLite DB at /data
try {
  await gql(
    `mutation($input: VolumeCreateInput!){ volumeCreate(input:$input){ id } }`,
    { input: { projectId, environmentId, serviceId, mountPath: '/data' } }
  );
  log('volume /data created');
} catch (e) {
  log('volume create error (may already exist):', e.message);
}

// 5. Project token the CLI accepts for `railway up`
const tokenData = await gql(
  `mutation($input: ProjectTokenCreateInput!){ projectTokenCreate(input:$input) }`,
  { input: { projectId, environmentId, name: 'cli-deploy' } }
);
const projectToken = tokenData.projectTokenCreate;
log('project token minted');

// Last stdout line = machine-readable result for the next step.
console.log(JSON.stringify({ projectId, environmentId, serviceId, serviceName: SERVICE_NAME, projectName: PROJECT_NAME, projectToken }));
