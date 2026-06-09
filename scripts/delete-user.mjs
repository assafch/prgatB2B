// Safely delete a portal login by username.
//   node scripts/delete-user.mjs <username>           # dry run: show what would be removed
//   node scripts/delete-user.mjs <username> --apply    # delete
//
// Refuses to delete an admin unless --force is also passed (guards the only admin).
// sessions + cart_lines cascade automatically (ON DELETE CASCADE). orders_local has
// NO cascade, so we refuse if the user has any orders — those are business records.
import Database from 'better-sqlite3';
import path from 'node:path';

const username = process.argv[2];
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
if (!username || username.startsWith('--')) {
  console.error('Usage: node scripts/delete-user.mjs <username> [--apply] [--force]');
  process.exit(1);
}

const dbPath = path.join(process.env.DATA_DIR || './data', 'app.db');
const db = new Database(dbPath);
db.pragma('busy_timeout = 8000');
db.pragma('foreign_keys = ON');

const user = db.prepare('SELECT id, username, role, custname, status FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No user with username "${username}".`);
  db.close();
  process.exit(1);
}

const sessions = db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(user.id).c;
const cartLines = db.prepare('SELECT COUNT(*) c FROM cart_lines WHERE user_id = ?').get(user.id).c;
const orders = db.prepare('SELECT COUNT(*) c FROM orders_local WHERE user_id = ?').get(user.id).c;

console.log('Target user:', JSON.stringify(user));
console.log(`Cascade: ${sessions} session(s), ${cartLines} cart line(s) will be removed with it.`);
console.log(`orders_local rows: ${orders}`);

if (user.role === 'admin' && !FORCE) {
  console.error('Refusing to delete an ADMIN user without --force.');
  db.close();
  process.exit(1);
}
if (orders > 0) {
  console.error(`Refusing: user has ${orders} order(s) in orders_local (business records, no cascade).`);
  db.close();
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDRY RUN. Re-run with --apply to delete this user.');
  db.close();
  process.exit(0);
}

const info = db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
console.log(`\nDELETED ${info.changes} user ("${username}").`);
db.close();
