// Dev runner: create a first-time onboarding invite for a customer and print the link.
//   node --env-file=.env --import tsx scripts/make-invite.ts <custname> ["cust_desc"]
import { db } from '../server/db.js';
import { createInvite } from '../server/invites.js';

const custname = process.argv[2];
const custDesc = process.argv[3];
if (!custname) {
  console.error('Usage: node --env-file=.env --import tsx scripts/make-invite.ts <custname> ["cust_desc"]');
  process.exit(1);
}

db.pragma('busy_timeout = 8000');
const inv = createInvite({ custname, cust_desc: custDesc });
const base = process.env.APP_BASE_URL || 'http://localhost:5175';
console.log(`Invite created for ${custname}${custDesc ? ` (${custDesc})` : ''}`);
console.log(`URL:     ${base}/#invite/${inv.token}`);
console.log(`Expires: ${inv.expires_at}`);
db.close();
