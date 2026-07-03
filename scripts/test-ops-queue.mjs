// Ops-queue unit test — seeds a scratch DB, checks rail counts/sums + activity.
// Run: npm run build && node scripts/test-ops-queue.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = '/tmp/opsq-test';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;

const { db } = await import('../dist/server/db.js');
const { getOpsQueues, getRecentActivity } = await import('../dist/server/opsQueue.js');

// Empty DB → all zeros
let q = getOpsQueues();
assert.equal(q.stuckOrders.count, 0);
assert.equal(q.failedReceipts.count, 0);
assert.equal(q.pendingChecks.count, 0);
assert.equal(q.newLeads.count, 0);

// FK integrity (foreign_keys=ON): one customer user everything hangs off
db.prepare(`INSERT INTO users (username, password_hash, role, custname) VALUES ('t', 'x', 'customer', '10001')`).run();
const uid = db.prepare(`SELECT id FROM users WHERE username = 't'`).get().id;

// 2 stuck orders (paid, never reached Priority) + 1 healthy submitted one
const ins = db.prepare(`INSERT INTO orders_local (user_id, custname, status, total, payment_status, payment_required_amount, priority_ordname)
  VALUES (?, '10001', ?, ?, ?, ?, ?)`);
ins.run(uid, 'failed', 100, 'approved', 117, null);
ins.run(uid, 'failed', 200, 'approved', 234, null);
ins.run(uid, 'submitted', 50, 'approved', 58.5, 'SO25000001');

// 1 cheque awaiting approval + 1 draft (must be excluded)
db.prepare(`INSERT INTO payment_checks (id, user_id, custname, amount, status, submitted_at) VALUES ('chk1', ?, '10001', 500, 'submitted', datetime('now'))`).run(uid);
db.prepare(`INSERT INTO payment_checks (id, user_id, custname, amount, status) VALUES ('chk2', ?, '10001', 999, 'draft')`).run(uid);

// 1 failed receipt joined to a paid card payment
db.prepare(`INSERT INTO card_payments (id, user_id, custname, amount, status) VALUES ('cp1', ?, '10001', 350, 'paid')`).run(uid);
db.prepare(`INSERT INTO priority_receipts (card_payment_id, status, attempts) VALUES ('cp1', 'failed', 20)`).run();

// 2 new leads + 1 already handled
db.prepare(`INSERT INTO leads (business_name, status) VALUES ('עסק א', 'new')`).run();
db.prepare(`INSERT INTO leads (business_name, status) VALUES ('עסק ב', 'new')`).run();
db.prepare(`INSERT INTO leads (business_name, status) VALUES ('עסק ג', 'contacted')`).run();

q = getOpsQueues();
assert.equal(q.stuckOrders.count, 2);
assert.equal(q.stuckOrders.sum, 351);        // 117 + 234 — the CHARGED amounts, not item totals
assert.equal(q.pendingChecks.count, 1);      // draft excluded
assert.equal(q.pendingChecks.sum, 500);
assert.ok(q.pendingChecks.oldest != null);
assert.equal(q.failedReceipts.count, 1);
assert.equal(q.failedReceipts.sum, 350);
assert.equal(q.newLeads.count, 2);
assert.equal(q.newLeads.latestName, 'עסק ב');

const acts = getRecentActivity(20);
assert.ok(acts.length >= 7);                 // 3 orders + 1 non-draft cheque + 1 paid card + 3 leads (draft cheque excluded → 8)
for (const a of acts) assert.ok(['order', 'check', 'card', 'lead'].includes(a.kind));
assert.ok(acts.some(a => a.kind === 'card' && a.amount === 350));
assert.ok(!acts.some(a => a.kind === 'check' && a.amount === 999)); // drafts never appear

console.log('test-ops-queue: ALL PASS');
