// Login-link module. Run: npm run build && DATA_DIR=/tmp/mll-test node scripts/test-login-link.mjs
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import crypto from 'node:crypto';
const { createLoginLink, redeemLoginLink } = await import('../dist/server/loginLinks.js');
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));

// Seed: one active customer user, one disabled, one admin
db.prepare("INSERT INTO users (username, password_hash, role, custname, status) VALUES ('mll-active','x','customer','C1','active')").run();
db.prepare("INSERT INTO users (username, password_hash, role, custname, status) VALUES ('mll-off','x','customer','C1','disabled')").run();
db.prepare("INSERT INTO users (username, password_hash, role, status) VALUES ('mll-admin','x','admin','active')").run();
const uid = (u) => db.prepare('SELECT id FROM users WHERE username=?').get(u).id;

// create + redeem (reusable)
const { token, expiresAt } = createLoginLink(uid('mll-active'), null);
assert.match(token, /^[0-9a-f]{32}$/);
assert.ok(new Date(expiresAt).getTime() > Date.now() + 13 * 86400_000);
assert.deepEqual(redeemLoginLink(token), { userId: uid('mll-active') });
assert.deepEqual(redeemLoginLink(token), { userId: uid('mll-active') }, 'reusable');
const row = db.prepare('SELECT * FROM login_links WHERE user_id=?').get(uid('mll-active'));
assert.equal(row.use_count, 2);
assert.ok(row.last_used_at, 'last_used_at set');
// plaintext never at rest
assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
assert.ok(!JSON.stringify(row).includes(token));

// replace revokes old
const second = createLoginLink(uid('mll-active'), null);
assert.equal(redeemLoginLink(token), null, 'old token dead after regenerate');
assert.ok(redeemLoginLink(second.token));
assert.equal(db.prepare('SELECT COUNT(*) c FROM login_links WHERE user_id=?').get(uid('mll-active')).c, 1);

// expiry rejects
db.prepare("UPDATE login_links SET expires_at = datetime('now','-1 hour') WHERE user_id=?").run(uid('mll-active'));
assert.equal(redeemLoginLink(second.token), null, 'expired');

// disabled user rejects; admin rejects at create-redeem level
const offLink = createLoginLink(uid('mll-off'), null);
assert.equal(redeemLoginLink(offLink.token), null, 'inactive user');
const admLink = createLoginLink(uid('mll-admin'), null);
assert.equal(redeemLoginLink(admLink.token), null, 'admin role never redeemable');

// junk token
assert.equal(redeemLoginLink('deadbeef'.repeat(4)), null);
assert.equal(redeemLoginLink(''), null);
console.log('login-link module: ALL PASS');
