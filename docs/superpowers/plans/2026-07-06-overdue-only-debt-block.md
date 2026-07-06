# Overdue-Only Debt Block (שוטף-aware) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-customer opt-in debt block that counts only unpaid invoices whose payment due date (computed from the customer's תנאי תשלום) has passed — so a שוטף customer can keep ordering all month while current-month invoices are open.

**Architecture:** Pure due-date/overdue helpers in `server/paymentPolicy.ts` (unit-tested, no IO) + a cached unpaid-invoice accessor in `server/finance.ts` + one shared async `computeBlockingNetDebt` used by BOTH `evaluate()` (order submit / checkout preview) and `server/home.ts` (which today duplicates the netDebt math inline). One additive `customer_policies.block_overdue_only` column, surfaced as a toggle on the admin customer card. Default 0 → byte-identical behavior.

**Tech Stack:** Express + better-sqlite3 TS ESM; assert scripts in `scripts/` run with node against `dist/` (no test framework).

**Spec:** `docs/superpowers/specs/2026-07-06-overdue-only-debt-block-design.md`

## Global Constraints

- Default off: `block_overdue_only = 0` (and any fetch failure) must produce byte-identical decisions to today (`netDebt = max(0, openTotal − pendingSettlement)`).
- Fail-open (spec §4.2): if the unpaid list is unavailable AND uncached, the overdue refinement resolves to blocking debt 0 (skip the block) with a `[policy]` console.warn — mirroring the existing M2 fail-open. Never fail-closed.
- Due-date formula (spec §3): `endOfMonth(IVDATE) + N days`; `N` from PAYDES (`שוטף`→0, `שוטף+30`→30, unparseable/null→0); explicit `IVPAY_SUBFORM` PAYDATE preferred when present. Overdue ⇔ `dueDate < today` (Asia/Jerusalem calendar dates).
- Cap: `blockingDebt = min(overdueSum, openTotal)`; then `netDebt = max(0, blockingDebt − pendingSettlement)`; threshold comparison via the UNCHANGED pure `decide()`.
- Date math must be timezone-safe: IVDATE strings are date-only (`2026-07-01T00:00:00Z`) — parse y/m/d from the string, never through local Date parsing; "today" via `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' })`.
- `$expand=IVPAY_SUBFORM` must be bare — NO inner `$select` (tenant drops the connection otherwise; documented quirk in priority.ts:442).
- The pay-by-card invoice picker keeps its existing UNCACHED `listUnpaidInvoices` call (payment amounts must be fresh); only the policy path uses the cache.
- Priority side untouched: no changes to order creation, approveOrder, receipts, `decide()`, cash-policy behavior.
- Hebrew copy verbatim as written in each task. `npm run typecheck` passes after every task.
- Existing `scripts/test-payment-policy.mjs` must pass unmodified.

---

### Task 1: Pure overdue helpers in paymentPolicy.ts

**Files:**
- Modify: `server/paymentPolicy.ts` (append pure helpers; touch nothing existing)
- Test: `scripts/test-overdue-block.mjs` (new)

**Interfaces:**
- Consumes: nothing (pure).
- Produces (exact signatures, consumed by Task 3):
  - `parseNetTermsDays(paydes: string | null): number`
  - `invoiceDueDate(ivdate: string, extraDays: number, ivpayDates?: (string | null | undefined)[]): string` — returns `YYYY-MM-DD`
  - `overdueSum(invoices: { IVDATE?: string; TOTPRICE?: number; IVPAY_SUBFORM?: { PAYDATE?: string | null }[] }[], paydes: string | null, todayYmd: string): number`
  - `israelTodayYmd(): string` — `YYYY-MM-DD` in Asia/Jerusalem

- [ ] **Step 1: Write the failing test** — create `scripts/test-overdue-block.mjs`:

```js
// Pure overdue-block helpers. Run: npm run build && node scripts/test-overdue-block.mjs
import assert from 'node:assert/strict';
import { parseNetTermsDays, invoiceDueDate, overdueSum } from '../dist/server/paymentPolicy.js';

// --- parseNetTermsDays ---
assert.equal(parseNetTermsDays('שוטף'), 0);
assert.equal(parseNetTermsDays('שוטף+30'), 30);
assert.equal(parseNetTermsDays('שוטף +30'), 30);
assert.equal(parseNetTermsDays('שוטף + 60'), 60);
assert.equal(parseNetTermsDays('שוטף30'), 30);
assert.equal(parseNetTermsDays(null), 0);
assert.equal(parseNetTermsDays('מזומן'), 0);
assert.equal(parseNetTermsDays('גיבוב'), 0);

// --- invoiceDueDate: end of invoice month + N ---
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0), '2026-07-31');
assert.equal(invoiceDueDate('2026-07-15T00:00:00Z', 0), '2026-07-31');
assert.equal(invoiceDueDate('2026-02-11T00:00:00Z', 0), '2026-02-28'); // Feb non-leap
assert.equal(invoiceDueDate('2028-02-05T00:00:00Z', 0), '2028-02-29'); // Feb leap
assert.equal(invoiceDueDate('2026-01-31T00:00:00Z', 30), '2026-03-02'); // EOM Jan(31) + 30
assert.equal(invoiceDueDate('2026-12-10T00:00:00Z', 0), '2026-12-31');
assert.equal(invoiceDueDate('2026-12-10T00:00:00Z', 30), '2027-01-30'); // year rollover
// Explicit IVPAY dates win; latest one governs
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0, ['2026-08-15T00:00:00Z', '2026-07-20T00:00:00Z']), '2026-08-15');
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0, []), '2026-07-31'); // empty array → computed
assert.equal(invoiceDueDate('2026-07-01T00:00:00Z', 0, [null, undefined]), '2026-07-31');

// --- overdueSum: real 10184 fixture (spec §2) — today 2026-07-06, terms שוטף ---
const fixture = [
  { IVDATE: '2026-02-11T00:00:00Z', TOTPRICE: 10739 },
  { IVDATE: '2026-02-12T00:00:00Z', TOTPRICE: 14 },
  { IVDATE: '2026-03-15T00:00:00Z', TOTPRICE: 4894 },
  { IVDATE: '2026-04-29T00:00:00Z', TOTPRICE: 7884 },
  { IVDATE: '2026-05-06T00:00:00Z', TOTPRICE: 12887 },
  { IVDATE: '2026-07-01T00:00:00Z', TOTPRICE: 8564 }, // due 31/7 — NOT overdue on 6/7
];
assert.equal(overdueSum(fixture, 'שוטף', '2026-07-06'), 36418);
// On 1/8 the July invoice becomes overdue (due 31/7 < 1/8)
assert.equal(overdueSum(fixture, 'שוטף', '2026-08-01'), 44982);
// On 31/7 (the due date itself) it is NOT yet overdue (strictly past)
assert.equal(overdueSum(fixture, 'שוטף', '2026-07-31'), 36418);
// שוטף+30 discriminates on 15/6: May invoice due EOM-May+30 = 30/6 → NOT yet
// overdue; Feb–Apr (due 30/3, 30/4, 30/5) are. Under plain שוטף on the same day,
// May (due 31/5) IS overdue.
assert.equal(overdueSum(fixture, 'שוטף+30', '2026-06-15'), 10739 + 14 + 4894 + 7884);
assert.equal(overdueSum(fixture, 'שוטף', '2026-06-15'), 10739 + 14 + 4894 + 7884 + 12887);
// Rounding + junk rows ignored
assert.equal(overdueSum([{ IVDATE: undefined, TOTPRICE: 100 }, { IVDATE: '2026-01-05T00:00:00Z', TOTPRICE: undefined }], 'שוטף', '2026-07-06'), 0);
console.log('overdue-block pure helpers: ALL PASS');
```

- [ ] **Step 2: Run to verify it fails** — `npm run build && node scripts/test-overdue-block.mjs` → export-missing SyntaxError.

- [ ] **Step 3: Implement** — append to `server/paymentPolicy.ts` (below the existing pure section, above the DB-backed section):

```ts
// ---------- Overdue-only block: PURE due-date helpers (no DB/IO — unit-tested) ----------
// Spec: 2026-07-06-overdue-only-debt-block. The tenant does not expose a per-invoice
// due date (IVPAY_SUBFORM verified empty on final invoices), so we compute it the way
// Priority displays it: end of invoice month + N days from the customer's PAYDES.

/** "שוטף" → 0, "שוטף+30"/"שוטף +30"/"שוטף30" → 30. Anything else (מזומן, null,
 *  unparseable) → 0 — strictest common terms; matches plain שוטף. */
export function parseNetTermsDays(paydes: string | null): number {
  const m = (paydes || '').match(/שוטף\s*\+?\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/** yyyy-mm-dd string for a UTC-midnight Date (IVDATE strings are date-only, so all
 *  math happens on calendar days — no timezone drift). */
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** Due date for an invoice: the latest explicit IVPAY payment date when present
 *  (future-proofing — this tenant never populates it), else end of the invoice's
 *  calendar month + extraDays. Returns yyyy-mm-dd. */
export function invoiceDueDate(
  ivdate: string,
  extraDays: number,
  ivpayDates?: (string | null | undefined)[]
): string {
  const explicit = (ivpayDates || []).filter((s): s is string => typeof s === 'string' && s.length >= 10);
  if (explicit.length) return explicit.map((s) => s.slice(0, 10)).sort().at(-1)!;
  const y = Number(ivdate.slice(0, 4));
  const m = Number(ivdate.slice(5, 7)); // 1-based
  // Date.UTC(y, m, 0) = last day of month m; + extraDays via UTC ms arithmetic.
  const due = new Date(Date.UTC(y, m, 0) + extraDays * 86_400_000);
  return ymd(due);
}

/** Sum of unpaid invoices strictly past their due date. `todayYmd` is a yyyy-mm-dd
 *  string (Asia/Jerusalem); comparison is lexicographic (safe for ISO dates). */
export function overdueSum(
  invoices: { IVDATE?: string; TOTPRICE?: number; IVPAY_SUBFORM?: { PAYDATE?: string | null }[] }[],
  paydes: string | null,
  todayYmd: string
): number {
  const extra = parseNetTermsDays(paydes);
  let sum = 0;
  for (const iv of invoices) {
    if (!iv.IVDATE || typeof iv.TOTPRICE !== 'number' || !(iv.TOTPRICE > 0)) continue;
    const due = invoiceDueDate(iv.IVDATE, extra, iv.IVPAY_SUBFORM?.map((p) => p.PAYDATE));
    if (due < todayYmd) sum += iv.TOTPRICE;
  }
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

/** Today's calendar date in Israel as yyyy-mm-dd ('en-CA' locale formats ISO-style). */
export function israelTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}
```

- [ ] **Step 4: Run to verify pass** — `npm run build && node scripts/test-overdue-block.mjs` → `overdue-block pure helpers: ALL PASS`. Also `node scripts/test-payment-policy.mjs` still passes (needs its DATA_DIR harness; if it wasn't runnable standalone before, confirm via typecheck + no edits to existing functions).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add server/paymentPolicy.ts scripts/test-overdue-block.mjs
git commit -m "feat(policy): pure due-date helpers for overdue-only block (שוטף-aware)"
```

---

### Task 2: Data layer — IVPAY expand, cached unpaid accessor, schema column

**Files:**
- Modify: `server/priority.ts:407-421` (`listUnpaidInvoices`)
- Modify: `server/finance.ts` (new cached accessor near getAccountSummary)
- Modify: `server/db.ts:407` area (ensureColumn)

**Interfaces:**
- Consumes: existing `memo`/`tryGet` in finance.ts (lines ~89/189), `getPriorityConfig`.
- Produces (consumed by Task 3):
  - `PriorityUnpaidInvoice` gains `IVPAY_SUBFORM?: { PAYDATE?: string | null }[]`
  - `getUnpaidInvoicesCached(custname: string): Promise<PriorityUnpaidInvoice[] | null>` exported from `server/finance.ts` — null means "unavailable and uncached" (caller fails open)
  - `customer_policies.block_overdue_only INTEGER NOT NULL DEFAULT 0`

- [ ] **Step 1: Extend `listUnpaidInvoices`** — in `server/priority.ts`, add the interface field and the bare expand (keep everything else identical):

```ts
export interface PriorityUnpaidInvoice {
  IVNUM?: string;
  TOTPRICE?: number;
  IVDATE?: string;
  STATDES?: string;
  IVRECONDATE?: string | null; // reconciliation date — null = still unpaid
  /** Explicit payment schedule (תאריך תשלום). Empty on this tenant today; when
   *  Priority populates it, the due-date logic prefers it (spec §3). */
  IVPAY_SUBFORM?: { PAYDATE?: string | null }[];
}
```

and change the query string to (NOTE: `$expand` bare — an inner `$select` drops the connection on this tenant, see the comment at getInvoiceWithItems):

```ts
    `AINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=IVDATE desc&$top=${top}` +
      `&$select=IVNUM,TOTPRICE,IVDATE,STATDES,IVRECONDATE&$expand=IVPAY_SUBFORM`
```

- [ ] **Step 2: Cached accessor** — in `server/finance.ts`, next to the other accessors (after getAccountSummary), add:

```ts
/** Unpaid invoices for the POLICY path — memoized + persisted like the balance
 *  fetches, so a Priority blip serves the last snapshot instead of failing. The
 *  pay-by-card picker deliberately does NOT use this (amounts must be fresh).
 *  Returns null only when the fetch fails AND no snapshot exists → caller fails open. */
export async function getUnpaidInvoicesCached(custname: string): Promise<PriorityUnpaidInvoice[] | null> {
  const config = getPriorityConfig();
  if (!config) return null;
  return tryGet(`unpaid:${custname}`, () => memo(`unpaid:${custname}`, () => listUnpaidInvoices(config, custname)));
}
```

(Add `listUnpaidInvoices` + `PriorityUnpaidInvoice` to the existing import from `./priority.js` if absent.)

- [ ] **Step 3: Schema** — in `server/db.ts`, directly under the existing line 407 `ensureColumn('customer_policies', 'enforced', ...)`:

```ts
ensureColumn('customer_policies', 'block_overdue_only', 'INTEGER NOT NULL DEFAULT 0');
```

- [ ] **Step 4: Verify** — `npm run typecheck && npm run build`; then one live read-only smoke via the app's client (same as the probe used in design): 

```bash
node --input-type=module -e "
import 'dotenv/config';
import { getUnpaidInvoicesCached } from './dist/server/finance.js';
const rows = await getUnpaidInvoicesCached('10184');
console.log('rows:', rows === null ? 'null' : rows.length, '| first has IVPAY array:', rows && Array.isArray(rows[0]?.IVPAY_SUBFORM));
" 2>&1 | grep -v '^\[Priority\]'
```

Expected: `rows: 6 | first has IVPAY array: true` (count may drift with live data; must be non-null).

- [ ] **Step 5: Commit**

```bash
git add server/priority.ts server/finance.ts server/db.ts
git commit -m "feat(policy-data): IVPAY expand on unpaid invoices, cached policy accessor, block_overdue_only column"
```

---

### Task 3: Policy integration — shared blocking-debt computation, evaluate + home

**Files:**
- Modify: `server/paymentPolicy.ts` (resolvePolicy, evaluate, new computeBlockingNetDebt)
- Modify: `server/home.ts:108-115` and `:174`
- Test: extend `scripts/test-overdue-block.mjs`

**Interfaces:**
- Consumes: Task 1 helpers, Task 2 `getUnpaidInvoicesCached`.
- Produces:
  - `Policy` gains `blockOverdueOnly: boolean`.
  - `computeBlockingNetDebt(custname: string, policy: Policy, openTotal: number, paymentTerms: string | null): Promise<number>` exported from paymentPolicy.ts — the ONE place netDebt is computed (evaluate + home both call it).
  - `evaluate()` return shape unchanged (consumed by orders.ts / checkoutPreview.ts untouched).

- [ ] **Step 1: resolvePolicy reads the column** — in `server/paymentPolicy.ts`, extend `PolicyRow` and the SELECT:

```ts
interface PolicyRow { kind: string; open_debt_threshold: number | null; allow_order_with_open_debt: number; block_overdue_only: number }
```

SELECT becomes `SELECT kind, open_debt_threshold, allow_order_with_open_debt, block_overdue_only FROM customer_policies WHERE custname = ?`, and the returned `Policy` gains:

```ts
    blockOverdueOnly: !!(row && row.block_overdue_only),
```

(add `blockOverdueOnly: boolean;` to the `Policy` interface; `derivePolicyKind`/`decide` untouched.)

- [ ] **Step 2: Shared computation** — add to `server/paymentPolicy.ts` (imports: `getUnpaidInvoicesCached` from `./finance.js` — NOTE finance.ts already imports from paymentPolicy? Verify: it does NOT (grep first); if a cycle appears, move the import to a dynamic `await import` inside the function like other cycle-breakers in the codebase — but current dependency direction paymentPolicy→finance already exists via getAccountSummary, so a static import is fine):

```ts
/** The single source of the net-debt figure used for blocking. Standard mode:
 *  openTotal − pendingSettlement. Overdue-only mode (block_overdue_only): only
 *  invoices strictly past their computed due date count, capped by openTotal
 *  (on-account payments reduce the cap first). Fail-open: if the unpaid list is
 *  unavailable and uncached, the overdue refinement yields 0 (no block) — the
 *  same conservative direction as the M2 balance fail-open. */
export async function computeBlockingNetDebt(
  custname: string,
  policy: Policy,
  openTotal: number,
  paymentTerms: string | null
): Promise<number> {
  let blockingDebt = openTotal;
  if (policy.blockOverdueOnly) {
    const unpaid = await getUnpaidInvoicesCached(custname);
    if (unpaid === null) {
      console.warn('[policy] unpaid invoices unavailable for ' + custname + ' — overdue block skipped (fail-open)');
      blockingDebt = 0;
    } else {
      blockingDebt = Math.min(overdueSum(unpaid, paymentTerms, israelTodayYmd()), openTotal);
    }
  }
  return Math.max(0, blockingDebt - pendingSettlement(custname));
}
```

- [ ] **Step 3: evaluate() uses it** — replace the two netDebt lines at the bottom of `evaluate()`:

```ts
  const openTotal = summary.balanceOk ? summary.balance.openTotal : 0;
  const netDebt = await computeBlockingNetDebt(custname, policy, openTotal, summary.profile?.paymentTerms ?? null);
  return { ...decide(policy, netDebt, cartTotal), kind: policy.kind };
```

- [ ] **Step 4: home.ts uses it** — replace line ~109:

```ts
  const netDebt = pol && summary.balanceOk
    ? await computeBlockingNetDebt(custname, pol, summary.balance.openTotal, summary.profile?.paymentTerms ?? null)
    : 0;
```

(import `computeBlockingNetDebt` from `./paymentPolicy.js`; line 174's `blocksOnDebt` expression is unchanged — it already consumes `netDebt`.)

- [ ] **Step 5: Test** — append to `scripts/test-overdue-block.mjs` (scratch-DB integration of resolvePolicy + fail-open path):

```js
// resolvePolicy picks up the new column; computeBlockingNetDebt fails open with no
// Priority config (getUnpaidInvoicesCached → null) for an overdue-only customer.
import Database from 'better-sqlite3';
import path from 'node:path';
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, allow_order_with_open_debt, enforced, block_overdue_only) VALUES ('C-OVERDUE','net',0,1,1)").run();
db.close();
const { resolvePolicy, computeBlockingNetDebt } = await import('../dist/server/paymentPolicy.js');
const pol = resolvePolicy('C-OVERDUE', 'שוטף');
assert.equal(pol.blockOverdueOnly, true);
assert.equal(resolvePolicy('NO-SUCH', 'שוטף').blockOverdueOnly, false);
// No PRIORITY_* env in this test run → accessor returns null → fail-open → 0
assert.equal(await computeBlockingNetDebt('C-OVERDUE', pol, 5000, 'שוטף'), 0);
// Standard mode unchanged: blocking = openTotal (no pending settlements in scratch DB)
assert.equal(await computeBlockingNetDebt('C-STD', resolvePolicy('NO-SUCH', 'שוטף'), 5000, 'שוטף'), 5000);
console.log('resolvePolicy + computeBlockingNetDebt: ALL PASS');
```

Run: `npm run build && mkdir -p /tmp/odb-test && DATA_DIR=/tmp/odb-test node scripts/test-overdue-block.mjs` (run WITHOUT Priority env vars so the fail-open path triggers) → both ALL PASS lines.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run typecheck
git add server/paymentPolicy.ts server/home.ts scripts/test-overdue-block.mjs
git commit -m "feat(policy): overdue-only blocking debt shared by evaluate+home; fail-open on missing unpaid data"
```

---

### Task 4: Admin — column through customers API + customer-card toggle

**Files:**
- Modify: `server/customers.ts:44,74-92,136` (SELECTs + patchCustomer)
- Modify: `src/pages/adminCustomerCard.ts` (~23 interface, ~146-175 policy section, ~255 save)

**Interfaces:**
- Consumes: Task 2 column.
- Produces: policy PATCH accepts `block_overdue_only: boolean`; customer-card API returns it; admin toggle renders/saves it.

- [ ] **Step 1: server/customers.ts** — add `block_overdue_only` to the three SELECTs (lines 44 join, 74, 136) and to `patchCustomer`'s read-merge-write:

```ts
  let overdueOnly = cur.block_overdue_only;
  if ('block_overdue_only' in patch) overdueOnly = patch.block_overdue_only ? 1 : 0;
```

with the INSERT/UPSERT extended to include the column (both the column list, VALUES `?`, and `DO UPDATE SET block_overdue_only = excluded.block_overdue_only`), and the `cur` fallback object gaining `block_overdue_only: 0`.

- [ ] **Step 2: adminCustomerCard.ts** — extend `CustomerCardPolicy` with `block_overdue_only: number;`. In the policy section markup, directly under the exemption checkbox block (~line 171), add:

```ts
          <label style="display:flex;align-items:center;gap:0.45rem;margin-top:0.5rem;cursor:pointer">
            <input type="checkbox" id="cc-overdue" ${d.policy.block_overdue_only ? 'checked' : ''}/>
            <span>חסימה רק לפי תאריך תשלום (שוטף)</span>
          </label>
          <div class="muted" style="font-size:0.8rem;margin:0.15rem 0 0 1.6rem">חשבוניות שטרם הגיע מועד פירעונן לא חוסמות הזמנה</div>
```

and in the save handler (~line 255 object) add `block_overdue_only: (shell.querySelector('#cc-overdue') as HTMLInputElement).checked,`.

- [ ] **Step 3: Verify + commit** — `npm run typecheck`; commit `feat(admin): per-customer overdue-only block toggle on the customer card`.

---

### Task 5: Customer-facing copy — bank-transfer line on blocked screens

**Files:**
- Modify: `src/pages/checkout.ts` (debtBlock card, ~line 80-89)
- Modify: `server/orders.ts` (~line 223 open_debt OrderError)

**Interfaces:** none new — copy only.

- [ ] **Step 1: checkout.ts** — inside the existing `debtBlock` card template, after the amount line's `</div>` and before the `סגור חוב ←` CTA, add:

```ts
         <div class="muted" style="font-size:0.82rem;margin-top:0.35rem">שילמתם בהעברה בנקאית? החסימה תוסר אוטומטית עם קליטת התשלום במשרד.</div>
```

- [ ] **Step 2: orders.ts** — extend the open_debt OrderError string (line ~223) to:

```ts
        `לא ניתן לבצע הזמנה — קיים חוב פתוח בסך ₪${(decision.amount ?? 0).toFixed(2)}. נא לסגור אותו (צ׳ק או אשראי) במסך "חשבוניות" ולנסות שוב. שילמתם בהעברה בנקאית? החסימה תוסר עם קליטת התשלום במשרד.`
```

- [ ] **Step 3: Verify + commit** — `npm run typecheck`; commit `feat(policy): bank-transfer note on debt-block messages`.

---

### Task 6: Verification, QA plan, deploy (inert), 10330 activation checklist

**Files:**
- Modify: `QA_PLAN.md` (append cases)

- [ ] **Step 1: QA_PLAN.md** — append:

```markdown
## Overdue-only debt block (block_overdue_only, per-customer)

- [ ] Toggle OFF (default): net customer's netDebt figure and block decision identical to before (home, checkout, order submit).
- [ ] Toggle ON, שוטף customer with only current-month unpaid invoices: NOT blocked; home shows netDebt of overdue portion only.
- [ ] Toggle ON, customer with last-month unpaid invoices: blocked; amount shown = overdue sum (capped by total debt).
- [ ] Month rollover: an invoice due at month-end starts blocking on the 1st.
- [ ] Priority unpaid-list failure (no cache): block skipped (fail-open), warning logged.
- [ ] Blocked screens show the העברה-בנקאית note.
- [ ] Admin: customer-card toggle round-trips (save → reload shows state).
- [ ] Activation for 10330: enroll (enforced=on, kind=auto→net, block_overdue_only=on) + master payment_policy_enabled ON; verify she can order with zero debt.
```

- [ ] **Step 2: Full verification**

```bash
npm run typecheck && npm run build \
  && mkdir -p /tmp/odb-test && DATA_DIR=/tmp/odb-test node scripts/test-overdue-block.mjs \
  && DATA_DIR=/tmp/odb-test CARD_TOKEN_KEY=$(node -e "console.log('ab'.repeat(32))") node scripts/test-saved-card.mjs \
  && DATA_DIR=/tmp/odb-test node scripts/test-checkout-preview.mjs
```

All pass. Then controller live QA per the QA plan (local dev, flags/policy rows set temporarily on 10184/10330 read paths, restored after).

- [ ] **Step 3: Merge + deploy** — merge branch to main, push (Railway). `block_overdue_only` defaults 0 and `payment_policy_enabled` is off in prod → zero behavior change. Post-deploy: site 200.

---

## Activation for 10330 (Assaf, in prod admin, after deploy)

1. לקוחות → 10330 → create her login (username 0509205817) + send the WhatsApp message.
2. Same card: המדיניות פעילה ✓, סיווג auto (נגזר שוטף), toggle "חסימה רק לפי תאריך תשלום (שוטף)" ✓.
3. הגדרות → turn ON `payment_policy_enabled` (master). Only enrolled customers are affected — today that's 10330 only.

## Rollback

Customer-card toggle off → today's behavior for that customer; `payment_policy_enabled` off → nothing enforced (current prod posture). No migrations to revert.
