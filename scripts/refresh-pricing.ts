// Dev runner: pull a customer's last-known prices from Priority into customer_pricing.
//   node --env-file=.env --import tsx scripts/refresh-pricing.ts <custname>
import { db } from '../server/db.js';
import { refreshCustomerPricing } from '../server/catalog.js';

const custname = process.argv[2];
if (!custname) {
  console.error('Usage: node --env-file=.env --import tsx scripts/refresh-pricing.ts <custname>');
  process.exit(1);
}

// Shared connection (same file the dev server uses) — wait out any brief write lock.
db.pragma('busy_timeout = 8000');

const n = await refreshCustomerPricing(custname);
console.log(`Refreshed ${n} personal price(s) for customer ${custname}.`);
db.close();
