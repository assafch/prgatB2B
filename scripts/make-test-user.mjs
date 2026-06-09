// Dev-only: upsert a customer login mapped to a real Priority CUSTNAME, so we can
// verify the live finance views end-to-end.
//   node scripts/make-test-user.mjs [username] [password] [custname] [cust_desc]
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';

const username = process.argv[2] || 'test10184';
const password = process.argv[3] || 'test1234';
const custname = process.argv[4] || '10184';
const custDesc = process.argv[5] || 'בדיקה ' + custname;

const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
const hash = bcrypt.hashSync(password, 12);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare(
    `UPDATE users SET password_hash=?, role='customer', custname=?, cust_desc=?, status='active' WHERE username=?`
  ).run(hash, custname, custDesc, username);
  console.log(`updated user "${username}" -> custname ${custname} (${custDesc})`);
} else {
  db.prepare(
    `INSERT INTO users (username, password_hash, role, custname, cust_desc, status) VALUES (?, ?, 'customer', ?, ?, 'active')`
  ).run(username, hash, custname, custDesc);
  console.log(`created user "${username}" -> custname ${custname} (${custDesc})`);
}
db.close();
