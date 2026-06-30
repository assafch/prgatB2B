# Priority Receipts (TINVOICES) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. TDD: write the failing check first.

**Goal:** When an in-app card charge succeeds, create one on-account receipt (`TINVOICES`, `IVTYPE='T'`) in Priority — fully decoupled so a receipt failure NEVER blocks the customer, fails the order, or refunds. Scenario 1 (order paid) sets `ORDNAME`; scenario 2 (invoices paid) sets `REFERENCE` = chosen IVNUMs. Off by default behind `priority_receipts_enabled`.

**Architecture:** New `server/priorityReceipts.ts` = a PURE `buildReceiptBody()` (unit-testable, no IO) + an IO `createReceipt()` (load card_payment → idempotency check → POST → record) + non-throwing `enqueueReceipt()` (called from `returnPaidCard`) + `sweepPendingReceipts()` (background, mirrors the order-resend sweep). New `priority_receipts` table. Config + flag in settings. Spec: `docs/superpowers/specs/2026-06-30-priority-receipts-design.md`.

**Tech Stack:** TS Express, better-sqlite3, Priority OData (`priorityRequest` helper). No test runner → unit via a node assertion script under node@24 (`/opt/homebrew/opt/node@24/bin/node`) against `dist/`; integration via a script GATED on `PRIORITY_TEST_*` env (skips if absent — never touches production). Branch `feat/payment-policy`. **Do NOT deploy, do NOT flip the flag.**

**Verified Priority facts (live, read-only):** `TINVOICES` API-enabled; header constants `STATDES='סופית'`, `FINAL='Y'`, `CODE='ש"ח'`, `FNCPATNAME='ק'`; card line in `TPAYMENT2_SUBFORM` with live credit-card `PAYMENTCODE="13"`; amount in `QPRICE`/`FIRSTPAY`/`TOTPRICE`; card fields `CARDNUM`/`CONFNUM`/`SHVA_TERMINALNAME`; `DETAILS` 24-char (idempotency); 0/100 receipts use `IVRECON` (on-account only).

**Existing hooks:** `server/priority.ts` `priorityRequest(config,endpoint,method,body)` + `getPriorityConfig()`. `server/cardPayments.ts` `returnPaidCard(id)` is the single paid-card success point (already calls `approveOrder` for order_payment); `CardRow` has `id,custname,amount,kind,paid_items,order_id` + card detail cols (read the file for the exact last-4 / confirmation field names, e.g. `four_digits`,`confirmation_code`). `server/orders.ts` `orders_local(linked_payment_id, priority_ordname)`. `server/db.ts` `getSetting/getSettingBool/getSettingInt` + the `ensureColumn` block (~349). `server/index.ts` sweep schedule (~1585) + `/api/admin/orders/stuck` (~1511).

---

### Task 1: DB — `priority_receipts` table + settings keys (inert)

**Files:** Modify `server/db.ts`

- [ ] **Step 1:** After the `customer_policies` CREATE TABLE block, add:
```sql
CREATE TABLE IF NOT EXISTS priority_receipts (
  card_payment_id TEXT PRIMARY KEY,
  receipt_ivnum TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | created | failed
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_priority_receipts_status ON priority_receipts(status);
```

- [ ] **Step 2:** Verify on a fresh DB:
```bash
rm -rf /tmp/pr-test && mkdir -p /tmp/pr-test
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=/tmp/pr-test npx tsx -e "import('./server/db.js').then(()=>{const D=require('better-sqlite3');const db=new D('/tmp/pr-test/app.db');console.log('cols:', db.prepare('PRAGMA table_info(priority_receipts)').all().map(c=>c.name).join(','))})"
```
Expected: `cols: card_payment_id,receipt_ivnum,status,error,attempts,created_at,updated_at`.

- [ ] **Step 3:** `npm run typecheck && npm run build` (pass). Commit:
```bash
git add server/db.ts && git commit -m "feat(receipts): priority_receipts table (inert)"
```

---

### Task 2: Pure payload builder + unit tests (TDD)

**Files:** Create `server/priorityReceipts.ts`; Create `scripts/test-priority-receipts.mjs`

- [ ] **Step 1: Write the failing unit test** `scripts/test-priority-receipts.mjs`:
```js
// Unit checks for the pure receipt payload builder. Run: node scripts/test-priority-receipts.mjs
import assert from 'node:assert/strict';
import { buildReceiptBody } from '../dist/server/priorityReceipts.js';

const cfg = { cashname: '020', ownerlogin: 'אורטל', ccPaymentcode: '13', terminal: null };
const base = { cardPaymentId: 'abcdef0123456789abcdef01', custname: '10184', amount: 188.33, cardLast4: '1234', confNum: 'A12345', ivdate: '2026-06-30' };

// Scenario 1: order payment → ORDNAME set, no REFERENCE
const r1 = buildReceiptBody({ ...base, ordname: 'SO26000123', invoiceRefs: null }, cfg);
assert.equal(r1.ACCNAME, '10184'); assert.equal(r1.CUSTNAME, '10184');
assert.equal(r1.CASHNAME, '020'); assert.equal(r1.OWNERLOGIN, 'אורטל');
assert.equal(r1.STATDES, 'סופית'); assert.equal(r1.FINAL, 'Y');
assert.equal(r1.CODE, 'ש"ח'); assert.equal(r1.FNCPATNAME, 'ק');
assert.equal(r1.TOTPRICE, 188.33);             // VAT-inclusive PSP amount, NOT re-taxed
assert.equal(r1.DETAILS, 'abcdef0123456789abcdef01'); // idempotency ref (≤24 chars)
assert.equal(r1.ORDNAME, 'SO26000123');
assert.ok(!r1.REFERENCE);
const line1 = r1.TPAYMENT2_SUBFORM[0];
assert.equal(line1.PAYMENTCODE, '13');
assert.equal(line1.QPRICE, 188.33); assert.equal(line1.FIRSTPAY, 188.33); assert.equal(line1.TOTPRICE, 188.33);
assert.equal(line1.CASHNAME, '020'); assert.equal(line1.CARDNUM, '1234'); assert.equal(line1.CONFNUM, 'A12345');

// Scenario 2: invoice payment → REFERENCE set (IVNUMs), no ORDNAME
const r2 = buildReceiptBody({ ...base, ordname: null, invoiceRefs: ['T26000045', 'T26000046'] }, cfg);
assert.ok(!r2.ORDNAME);
assert.ok(r2.REFERENCE.includes('T26000045'));  // hint for the office
assert.equal(r2.TOTPRICE, 188.33);

// Amount is never re-VAT'd: a round 100 stays 100
assert.equal(buildReceiptBody({ ...base, amount: 100, ordname: 'X', invoiceRefs: null }, cfg).TOTPRICE, 100);
console.log('priority-receipts builder: ALL PASS');
```

- [ ] **Step 2: Run it — verify it FAILS** (module/function missing):
```bash
npm run build 2>/dev/null; node scripts/test-priority-receipts.mjs || echo "FAILED AS EXPECTED"
```

- [ ] **Step 3: Implement the pure builder** in `server/priorityReceipts.ts`:
```ts
// Priority receipt (TINVOICES) creation. The customer flow is NEVER blocked by this:
// enqueue is fire-and-forget, creation runs only in the background sweep, failures are
// left for manual handling. Spec: 2026-06-30-priority-receipts.
export interface ReceiptConfig {
  cashname: string; ownerlogin: string; ccPaymentcode: string; terminal: string | null;
}
export interface ReceiptInput {
  cardPaymentId: string; custname: string; amount: number;
  cardLast4: string | null; confNum: string | null; ivdate: string;
  ordname: string | null;            // scenario 1
  invoiceRefs: string[] | null;      // scenario 2 (IVNUMs)
}

/** PURE: build the TINVOICES body. No DB/network. Amount is the exact VAT-inclusive
 *  PSP charge — never re-apply VAT. */
export function buildReceiptBody(inp: ReceiptInput, cfg: ReceiptConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ACCNAME: inp.custname,
    CUSTNAME: inp.custname,
    CASHNAME: cfg.cashname,
    IVDATE: inp.ivdate,
    STATDES: 'סופית',
    FINAL: 'Y',
    OWNERLOGIN: cfg.ownerlogin,
    CODE: 'ש"ח',
    FNCPATNAME: 'ק',
    TOTPRICE: inp.amount,
    DETAILS: inp.cardPaymentId.slice(0, 24), // idempotency ref (field is 24 chars)
    TPAYMENT2_SUBFORM: [
      {
        PAYMENTCODE: cfg.ccPaymentcode,
        QPRICE: inp.amount,
        FIRSTPAY: inp.amount,
        TOTPRICE: inp.amount,
        CASHNAME: cfg.cashname,
        ...(inp.cardLast4 ? { CARDNUM: inp.cardLast4 } : {}),
        ...(inp.confNum ? { CONFNUM: inp.confNum } : {}),
        ...(cfg.terminal ? { SHVA_TERMINALNAME: cfg.terminal } : {}),
      },
    ],
  };
  if (inp.ordname) body.ORDNAME = inp.ordname;
  if (inp.invoiceRefs && inp.invoiceRefs.length) body.REFERENCE = inp.invoiceRefs.join(',').slice(0, 25);
  return body;
}
```

- [ ] **Step 4: Build + run — verify PASS:**
```bash
npm run build && node scripts/test-priority-receipts.mjs
```
Expected: `priority-receipts builder: ALL PASS`.

- [ ] **Step 5:** `npm run typecheck` (pass). Commit:
```bash
git add server/priorityReceipts.ts scripts/test-priority-receipts.mjs
git commit -m "feat(receipts): pure TINVOICES payload builder + unit tests (TDD)"
```

---

### Task 3: `createReceipt` (IO) + config readers + idempotency

**Files:** Modify `server/priorityReceipts.ts`

- [ ] **Step 1:** Append (import `db`, `getSetting` from './db.js'; `getPriorityConfig`, `priorityRequest` from './priority.js'):
```ts
import { db, getSetting } from './db.js';
import { getPriorityConfig, priorityRequest } from './priority.js';

function receiptConfig(): ReceiptConfig {
  return {
    cashname: getSetting('priority_receipt_cashname') || '',
    ownerlogin: getSetting('priority_receipt_ownerlogin') || '',
    ccPaymentcode: getSetting('priority_receipt_cc_paymentcode') || '13',
    terminal: getSetting('priority_receipt_terminal') || null,
  };
}

/** Create (or adopt, if already created) the Priority receipt for a paid card payment.
 *  Throws on failure — the caller (sweep) records 'failed' and retries; it is NEVER
 *  called inside a customer request. */
export async function createReceipt(cardPaymentId: string): Promise<string> {
  const cfg = receiptConfig();
  if (!cfg.cashname || !cfg.ownerlogin) throw new Error('receipt config missing (cashname/ownerlogin)');
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');
  const cp = db.prepare(
    "SELECT id, custname, amount, kind, paid_items, order_id, four_digits, confirmation_code FROM card_payments WHERE id = ? AND status = 'paid'"
  ).get(cardPaymentId) as { id: string; custname: string; amount: number; kind: string; paid_items: string | null; order_id: string | null; four_digits: string | null; confirmation_code: string | null } | undefined;
  if (!cp) throw new Error('paid card payment not found: ' + cardPaymentId);

  // Idempotency: a receipt with our DETAILS ref already exists? adopt it.
  const existing = await priorityRequest(config, `TINVOICES?$filter=DETAILS eq '${cardPaymentId}'&$select=IVNUM&$top=1`);
  const found = (existing.value as Array<{ IVNUM: string }> | undefined)?.[0];
  if (found?.IVNUM) return found.IVNUM;

  // Resolve linkage. order_payment → the approved order's ORDNAME (best-effort, on-account
  // either way). debt/debt_partial → the chosen IVNUMs as a REFERENCE hint.
  let ordname: string | null = null;
  let invoiceRefs: string[] | null = null;
  if (cp.kind === 'order_payment' && cp.order_id) {
    const o = db.prepare('SELECT priority_ordname FROM orders_local WHERE id = ?').get(Number(cp.order_id)) as { priority_ordname: string | null } | undefined;
    ordname = o?.priority_ordname ?? null;
  } else if (cp.paid_items) {
    try { const arr = JSON.parse(cp.paid_items); if (Array.isArray(arr) && arr.length) invoiceRefs = arr.map(String); } catch { /* ignore */ }
  }

  const body = buildReceiptBody(
    { cardPaymentId, custname: cp.custname, amount: cp.amount, cardLast4: cp.four_digits, confNum: cp.confirmation_code, ivdate: new Date().toISOString().slice(0, 10), ordname, invoiceRefs },
    cfg
  );
  const res = await priorityRequest(config, 'TINVOICES', 'POST', body);
  const ivnum = (res.IVNUM as string) || '';
  if (!ivnum) throw new Error('receipt POST returned no IVNUM');
  return ivnum;
}
```
NOTE: confirm the real `card_payments` last-4 / confirmation column names by reading `cardPayments.ts` `CardRow` + the table (likely `four_digits`, `confirmation_code`); adjust the SELECT + the `four_digits`/`confirmation_code` reads if they differ. Confirm `priorityRequest`'s OData filter URL form matches existing GET calls in `priority.ts` (e.g. encoding) — mirror an existing query.

- [ ] **Step 2:** `npm run typecheck && npm run build` (pass). Commit:
```bash
git add server/priorityReceipts.ts && git commit -m "feat(receipts): createReceipt — load card payment, idempotency check, POST TINVOICES"
```

---

### Task 4: Non-throwing enqueue + wire into `returnPaidCard`

**Files:** Modify `server/priorityReceipts.ts`, `server/cardPayments.ts`

- [ ] **Step 1:** Add to `server/priorityReceipts.ts` (import `getSettingBool`):
```ts
import { getSettingBool } from './db.js';

/** Is the receipt pipeline active for this customer? Off by default; an optional
 *  single-test-customer allowlist lets it be enabled for one custname first. */
export function receiptsEnabledFor(custname: string): boolean {
  if (!getSettingBool('priority_receipts_enabled', false)) return false;
  const only = getSetting('priority_receipts_test_custname');
  return !only || only.trim() === custname;
}

/** Fire-and-forget, NON-THROWING: enqueue a receipt for a paid card. Any failure here is
 *  logged and swallowed — it must never propagate into the customer flow. */
export function enqueueReceipt(cardPaymentId: string, custname: string): void {
  try {
    if (!receiptsEnabledFor(custname)) return;
    db.prepare(
      "INSERT INTO priority_receipts (card_payment_id, status) VALUES (?, 'pending') ON CONFLICT(card_payment_id) DO NOTHING"
    ).run(cardPaymentId);
  } catch (err) {
    console.warn('[receipts] enqueue failed (non-blocking):', err);
  }
}
```

- [ ] **Step 2:** In `server/cardPayments.ts` `returnPaidCard(id)`, after the existing order-approval hook and BEFORE `return getCardAny(id)`, add a non-throwing enqueue. Read the card's custname for the gate:
```ts
  try {
    const { enqueueReceipt } = await import('./priorityReceipts.js'); // dynamic import avoids load cycle
    const row = db.prepare('SELECT custname FROM card_payments WHERE id = ?').get(id) as { custname: string } | undefined;
    if (row) enqueueReceipt(id, row.custname);
  } catch (err) { console.warn('[receipts] enqueue hook failed (non-blocking):', err); }
```
This runs for EVERY paid card (order_payment + debt). The `try/catch` + the non-throwing `enqueueReceipt` guarantee the customer flow is never affected.

- [ ] **Step 3:** `npm run typecheck && npm run build` (pass). Curl sanity — with the flag OFF, a paid card enqueues NOTHING (inert):
```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev > /tmp/t4.log 2>&1 & sleep 8
/opt/homebrew/opt/node@24/bin/node -e "const D=require('better-sqlite3');const db=new D('./data-qa/app.db');console.log('receipts rows (flag off → expect 0 new):', db.prepare('SELECT COUNT(*) n FROM priority_receipts').get().n)"
pkill -f "tsx watch server/index.ts" 2>/dev/null; pkill -f "node_modules/.bin/vite" 2>/dev/null
```

- [ ] **Step 4:** Commit:
```bash
git add server/priorityReceipts.ts server/cardPayments.ts
git commit -m "feat(receipts): non-throwing enqueue from returnPaidCard (flag-gated, inert off)"
```

---

### Task 5: Background sweep + schedule

**Files:** Modify `server/priorityReceipts.ts`, `server/index.ts`

- [ ] **Step 1:** Add to `server/priorityReceipts.ts`:
```ts
/** Background worker: create receipts for pending/failed rows. Never runs in a request. */
export async function sweepPendingReceipts(): Promise<void> {
  if (!getSettingBool('priority_receipts_enabled', false)) return;
  const rows = db.prepare(
    "SELECT card_payment_id FROM priority_receipts WHERE status IN ('pending','failed') AND attempts < 20 ORDER BY created_at LIMIT 25"
  ).all() as { card_payment_id: string }[];
  for (const r of rows) {
    try {
      const ivnum = await createReceipt(r.card_payment_id);
      db.prepare("UPDATE priority_receipts SET status='created', receipt_ivnum=?, error=NULL, updated_at=datetime('now') WHERE card_payment_id=?").run(ivnum, r.card_payment_id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare("UPDATE priority_receipts SET status='failed', error=?, attempts=attempts+1, updated_at=datetime('now') WHERE card_payment_id=?").run(msg, r.card_payment_id);
      console.warn('[receipts] create failed (left for manual handling):', r.card_payment_id, msg);
    }
  }
}

/** Admin recovery queue: receipts that have not been created. */
export function listFailedReceipts(): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT card_payment_id, status, error, attempts, created_at FROM priority_receipts WHERE status='failed' ORDER BY created_at DESC LIMIT 100"
  ).all();
}
export function failedReceiptCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM priority_receipts WHERE status='failed'").get() as { n: number }).n;
}
```

- [ ] **Step 2:** In `server/index.ts`, next to the `sweepPendingOrders` schedule (~1585), import `sweepPendingReceipts` from `./priorityReceipts.js` and add:
```ts
  sweepPendingReceipts().catch(() => {});
  setInterval(() => { sweepPendingReceipts().catch(() => {}); }, 5 * 60_000).unref();
```

- [ ] **Step 3:** `npm run typecheck && npm run build` (pass). Commit:
```bash
git add server/priorityReceipts.ts server/index.ts
git commit -m "feat(receipts): background sweep (create + retry) scheduled at boot + 5-min"
```

---

### Task 6: Admin config + failed-receipt alert

**Files:** Modify `server/index.ts`, `src/pages/adminSettings.ts`

- [ ] **Step 1:** `server/index.ts` — add the settings keys to `SETTABLE`: `priority_receipts_enabled` (also in `BOOL_SETTINGS`), `priority_receipt_cashname`, `priority_receipt_ownerlogin`, `priority_receipt_cc_paymentcode`, `priority_receipt_terminal`, `priority_receipts_test_custname`. Add an admin endpoint near `/api/admin/orders/stuck` (import `listFailedReceipts`, `failedReceiptCount`):
```ts
app.get('/api/admin/receipts/failed', requireAdmin, (req, res) => { res.json({ count: failedReceiptCount(), receipts: listFailedReceipts() }); });
```

- [ ] **Step 2:** `src/pages/adminSettings.ts` — add a "קבלות אוטומטיות (Priority)" section (mirror the existing settings-field + #s-save pattern): checkbox `priority_receipts_enabled`; text inputs `priority_receipt_cashname`, `priority_receipt_ownerlogin`, `priority_receipt_cc_paymentcode` (default "13"), `priority_receipt_terminal`, `priority_receipts_test_custname` (single test customer); and a read-only line that fetches `/api/admin/receipts/failed` and shows "קבלות שנכשלו: N" (alert when N>0) — reuse the stuck-orders fetch/render style. Include the new keys in the PATCH body.

- [ ] **Step 3:** `npm run typecheck && npm run build` (pass). Curl: PATCH the settings + GET them back (200, values persist); GET `/api/admin/receipts/failed` → `{count:0,receipts:[]}`. Commit:
```bash
git add server/index.ts src/pages/adminSettings.ts
git commit -m "feat(admin): receipts config settings + failed-receipt counter/alert"
```

---

### Task 7: Gated integration test + final verify (NO deploy, NO flag)

**Files:** Create `scripts/itest-priority-receipts.mjs`

- [ ] **Step 1:** Create the integration script that SKIPS unless TEST creds are present (never touches production):
```js
// Integration test — runs ONLY against a Priority TEST company. Skips if creds absent.
// Env: PRIORITY_TEST_BASE_URL, PRIORITY_TEST_COMPANY, PRIORITY_TEST_PAT, PRIORITY_TEST_CUSTNAME
import assert from 'node:assert/strict';
import { buildReceiptBody } from '../dist/server/priorityReceipts.js';
const { PRIORITY_TEST_BASE_URL: base, PRIORITY_TEST_COMPANY: company, PRIORITY_TEST_PAT: pat, PRIORITY_TEST_CUSTNAME: cust } = process.env;
if (!base || !company || !pat || !cust) { console.log('SKIP: Priority TEST creds not set (set PRIORITY_TEST_* to run)'); process.exit(0); }
const auth = 'Basic ' + Buffer.from(pat + ':PAT').toString('base64');
const req = async (endpoint, method='GET', body=null) => {
  const r = await fetch(`${base}/${company}/${endpoint}`, { method, headers: { Authorization: auth, 'Content-Type':'application/json', Accept:'application/json' }, body: body?JSON.stringify(body):undefined });
  const t = await r.text(); let d; try{d=JSON.parse(t)}catch{d=t} if(!r.ok) throw new Error(`${r.status}: ${t.slice(0,300)}`); return d;
};
const cfg = { cashname: process.env.PRIORITY_TEST_CASHNAME||'020', ownerlogin: process.env.PRIORITY_TEST_OWNER||'אורטל', ccPaymentcode: process.env.PRIORITY_TEST_CC||'13', terminal: null };
const id = 'itest' + Date.now().toString(16).padStart(19,'0');  // ≤24 chars, unique
// on-account receipt
const body = buildReceiptBody({ cardPaymentId: id, custname: cust, amount: 1, cardLast4:'4242', confNum:'ITEST', ivdate: new Date().toISOString().slice(0,10), ordname:null, invoiceRefs:null }, cfg);
const created = await req('TINVOICES', 'POST', body);
assert.ok(created.IVNUM, 'created receipt has IVNUM'); console.log('created', created.IVNUM);
// idempotency: same DETAILS already exists
const dup = await req(`TINVOICES?$filter=DETAILS eq '${id}'&$select=IVNUM&$top=1`);
assert.equal(dup.value[0].IVNUM, created.IVNUM, 'idempotency: found the same receipt by DETAILS');
console.log('priority-receipts integration: ALL PASS (TEST company)');
```

- [ ] **Step 2:** Final gate (no deploy): `npm run typecheck && npm run build && node scripts/test-priority-receipts.mjs` (unit ALL PASS); `node scripts/itest-priority-receipts.mjs` (prints SKIP unless TEST creds set); reset data-qa + boot + `qa/run-auth.sh` → 21/21 (receipts off = no change). Commit the integration script.

- [ ] **Step 3:** STOP. Produce for the owner: (a) the Priority config values needed (`priority_receipt_cashname`, `priority_receipt_ownerlogin`, `priority_receipt_cc_paymentcode`=13, optional terminal; + the single test custname); (b) how to run the tests (the two node commands + the `PRIORITY_TEST_*` env for integration); (c) the manual end-to-end steps: set the config + `priority_receipts_test_custname` to one test customer, flip `priority_receipts_enabled` on, make one small real card payment, confirm the `RC…`/`TINVOICES` receipt appears with the right amount + card line, then decide on broader rollout. Do NOT flip the flag or deploy.

---

## Self-Review notes
- **Spec coverage:** TINVOICES on-account both scenarios (Task 2 builder; Task 3 linkage) ✓ · VAT-inclusive amount, no re-tax (Task 2 unit) ✓ · idempotency via DETAILS check-before-create (Task 3) ✓ · NEVER blocks customer — non-throwing enqueue + background-only creation (Task 4,5) ✓ · failure → failed + sweep retry + admin alert/manual handling (Task 5,6) ✓ · flag off + single-test-customer (Task 4,6) ✓ · config in settings, no constants (Task 3,6) ✓ · TEST-only integration, never production (Task 7) ✓ · ORDER unchanged (no task touches createOrder) ✓.
- **Types:** `ReceiptConfig`/`ReceiptInput`/`buildReceiptBody`/`createReceipt`/`enqueueReceipt`/`receiptsEnabledFor`/`sweepPendingReceipts` consistent across tasks.
- **Flagged for implementer:** confirm `card_payments` last-4/confirmation column names (`four_digits`/`confirmation_code`) + the OData filter URL form against existing `priority.ts` GETs; the `IVDATE` format Priority expects (mirror how `createOrder`/existing reads format dates).
- **No deploy / no flag flip** (explicit owner instruction).
