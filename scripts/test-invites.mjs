// Unit checks for invite-token hashing + login-link revocation on credential events.
// Run: npm run build && DATA_DIR=<scratch> node scripts/test-invites.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createInvite, getInvite, acceptInvite, listInvites } from '../dist/server/invites.js';
import { createLoginLink, redeemLoginLink } from '../dist/server/loginLinks.js';
import { resetUserPassword, setUserStatus } from '../dist/server/adminUsers.js';
import { db } from '../dist/server/db.js';

const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');

// --- invite tokens hashed at rest ---
const inv = createInvite({ custname: 'C-INV' });
assert.equal(inv.token.length, 32, 'raw token returned to the caller');
const stored = db.prepare('SELECT token FROM invites').get().token;
assert.equal(stored, sha256(inv.token), 'DB stores only the sha256');
assert.ok(getInvite(inv.token), 'lookup by raw token works');
assert.equal(getInvite(stored), null, 'the stored hash itself is NOT a working token');
assert.ok(!('token' in listInvites()[0]), 'admin list carries no token');

// accept marks used and creates the user
const acc = await acceptInvite(inv.token, 'inv-user', 'Str0ngPass!9');
assert.equal(acc.custname, 'C-INV');
assert.equal(getInvite(inv.token), null, 'used invite no longer valid');
console.log('invite hashing: PASS');

// --- legacy plaintext invite migration (the db.ts boot UPDATE, same statement) ---
const raw = crypto.randomBytes(16).toString('hex');
db.prepare("INSERT INTO invites (token, custname, expires_at) VALUES (?, 'C-LEG', datetime('now','+7 days'))").run(raw);
const legacy = db.prepare('SELECT token FROM invites WHERE length(token) = 32').all();
for (const r of legacy) db.prepare('UPDATE invites SET token = ? WHERE token = ?').run(sha256(r.token), r.token);
assert.ok(getInvite(raw), 'legacy raw link still redeems after migration');
console.log('legacy invite migration: PASS');

// --- password reset / disable revoke the magic login link ---
const uid = acc.userId;
let { token: link } = createLoginLink(uid, null);
assert.ok(redeemLoginLink(link), 'link works before reset');
assert.deepEqual(await resetUserPassword(uid, 'An0therPass!9'), { ok: true });
assert.equal(redeemLoginLink(link), null, 'password reset revokes the login link');

({ token: link } = createLoginLink(uid, null));
assert.ok(redeemLoginLink(link), 'fresh link works');
assert.deepEqual(setUserStatus(uid, 'disabled'), { ok: true });
assert.equal(redeemLoginLink(link), null, 'disable revokes the login link');
console.log('login-link revocation: PASS');
