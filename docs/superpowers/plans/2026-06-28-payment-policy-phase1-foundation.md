# Payment Policy — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the data-driven payment-policy foundation — schema, a pure policy engine, admin config, and per-customer overrides — WITHOUT changing any customer-facing behavior (feature flag OFF; no order gating yet).

**Architecture:** A new `server/paymentPolicy.ts` resolves each customer's policy from Priority `PAYDES` + an admin `customer_policies` override, and exposes a pure `decide()` for later gating. Phase 2 (net-debt block) and Phase 3 (cash pay-at-order) build on this. Migrations are additive/inert. Spec: `docs/superpowers/specs/2026-06-28-payment-policy-order-approval-design.md`.

**Tech Stack:** TypeScript, Express, better-sqlite3, vanilla-TS client. No unit-test runner in repo → verification = `npm run typecheck` + `npm run build` + a node assertion script run under node@24 (`/opt/homebrew/opt/node@24/bin/node`, since better-sqlite3's ABI) against a throwaway `DATA_DIR`, plus curl against a local admin session.

**Conventions:** deploy after verify (push branch → `git push origin HEAD:main` → Railway). Run the local server with `PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev`.

---

### Task 1: Schema migrations (additive, inert)

**Files:**
- Modify: `server/db.ts` (the `ensureColumn` block near line 336, and the `CREATE TABLE` section near line 212)

- [ ] **Step 1: Add the `customer_policies` table** — after the `customer_pricing` CREATE TABLE (≈ line 218):

```sql
CREATE TABLE IF NOT EXISTS customer_policies (
  custname TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'auto',            -- auto | cash | net | custom
  open_debt_threshold REAL,                      -- null → use global default
  allow_order_with_open_debt INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Add order + payment-link columns** — in the `ensureColumn` block (after the `b2b_out_of_stock` line ≈ 337):

```js
// Payment policy / order approval (Phase 1 foundation — inert until the engine ships).
ensureColumn('orders_local', 'payment_status', "TEXT NOT NULL DEFAULT 'not_required'"); // not_required | pending_payment | approved
ensureColumn('orders_local', 'payment_required_amount', 'REAL');
ensureColumn('orders_local', 'linked_payment_kind', 'TEXT'); // card | check
ensureColumn('orders_local', 'linked_payment_id', 'TEXT');
ensureColumn('orders_local', 'approved_at', 'TEXT');
ensureColumn('card_payments', 'order_id', 'TEXT');   // set when a payment approves an order
ensureColumn('payment_checks', 'order_id', 'TEXT');
```

- [ ] **Step 3: Verify migrations apply on a fresh DB**

Run:
```bash
rm -rf /tmp/pp-test && mkdir -p /tmp/pp-test
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=/tmp/pp-test npx tsx -e "import('./server/db.js').then(()=>{const D=require('better-sqlite3');const db=new D('/tmp/pp-test/app.db');console.log('customer_policies cols:', db.prepare('PRAGMA table_info(customer_policies)').all().map(c=>c.name).join(','));console.log('orders_local payment_status?:', db.prepare('PRAGMA table_info(orders_local)').all().some(c=>c.name==='payment_status'));})"
```
Expected: prints the `customer_policies` columns and `orders_local payment_status?: true`.

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add server/db.ts
git commit -m "feat(db): payment-policy schema — customer_policies + order/payment columns (inert)"
```

---

### Task 2: Pure policy engine (`derivePolicyKind`, `decide`)

**Files:**
- Create: `server/paymentPolicy.ts`
- Create: `scripts/test-payment-policy.mjs` (assertion script — the unit test)

- [ ] **Step 1: Write the pure engine** in `server/paymentPolicy.ts`:

```ts
// Payment-policy engine. PURE decision helpers here have NO DB/IO so they are unit-
// testable; the DB-backed resolve/evaluate live in Tasks 3-4. Spec: 2026-06-28-payment-policy.
export type PolicyKind = 'cash' | 'net';
export interface Policy {
  kind: PolicyKind;
  requirePaymentBeforeApproval: boolean; // cash → true
  blockOnOpenDebt: boolean;              // net → true
  openDebtThreshold: number;             // block when netDebt > threshold
  allowOrderWithOpenDebt: boolean;       // per-customer exemption
}
export interface PolicyDecision {
  allowOrder: boolean;
  requiresPayment: boolean;
  amount: number | null;
  reason: 'cash_payment_required' | 'open_debt' | null;
}

/** Map a Priority PAYDES string to a policy kind. `cashMatch` is a list of
 *  substrings that mean "cash" (admin-config, default ["מזומן"]). Unknown → net
 *  (safe: ordering keeps working). */
export function derivePolicyKind(paydes: string | null, cashMatch: string[]): PolicyKind {
  const s = (paydes || '').trim();
  if (s && cashMatch.some((m) => m.trim() && s.includes(m.trim()))) return 'cash';
  return 'net';
}

/** Pure order-time decision. `netDebt` = openTotal − pendingSettlement (already
 *  excludes post-dated cheques). `cartTotal` is the new order total. */
export function decide(policy: Policy, netDebt: number, cartTotal: number): PolicyDecision {
  if (policy.kind === 'cash') {
    return { allowOrder: true, requiresPayment: true, amount: round2(cartTotal), reason: 'cash_payment_required' };
  }
  if (policy.blockOnOpenDebt && !policy.allowOrderWithOpenDebt && netDebt > policy.openDebtThreshold + 0.001) {
    return { allowOrder: false, requiresPayment: false, amount: round2(netDebt), reason: 'open_debt' };
  }
  return { allowOrder: true, requiresPayment: false, amount: null, reason: null };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
```

- [ ] **Step 2: Write the assertion script** `scripts/test-payment-policy.mjs`:

```js
// Unit checks for the pure payment-policy engine. Run: node scripts/test-payment-policy.mjs
import assert from 'node:assert/strict';
import { derivePolicyKind, decide } from '../dist/server/paymentPolicy.js';

// derivePolicyKind
assert.equal(derivePolicyKind('מזומן', ['מזומן']), 'cash');
assert.equal(derivePolicyKind('שוטף+30', ['מזומן']), 'net');
assert.equal(derivePolicyKind(null, ['מזומן']), 'net');
assert.equal(derivePolicyKind('תשלום מזומן בלבד', ['מזומן']), 'cash');

const net = { kind: 'net', requirePaymentBeforeApproval: false, blockOnOpenDebt: true, openDebtThreshold: 0, allowOrderWithOpenDebt: false };
const cash = { kind: 'cash', requirePaymentBeforeApproval: true, blockOnOpenDebt: false, openDebtThreshold: 0, allowOrderWithOpenDebt: false };

// cash → must pay the cart total, order allowed (held)
assert.deepEqual(decide(cash, 0, 500), { allowOrder: true, requiresPayment: true, amount: 500, reason: 'cash_payment_required' });
// net + open debt > 0 → blocked
assert.equal(decide(net, 120, 500).allowOrder, false);
assert.equal(decide(net, 120, 500).reason, 'open_debt');
// net + no debt → allowed
assert.equal(decide(net, 0, 500).allowOrder, true);
// net + exempt → allowed despite debt
assert.equal(decide({ ...net, allowOrderWithOpenDebt: true }, 9999, 500).allowOrder, true);
// net + debt under threshold → allowed
assert.equal(decide({ ...net, openDebtThreshold: 200 }, 120, 500).allowOrder, true);
console.log('payment-policy engine: ALL PASS');
```

- [ ] **Step 3: Build, then run the assertion script — verify it passes**

Run: `npm run build && node scripts/test-payment-policy.mjs`
Expected: `payment-policy engine: ALL PASS`. (If the import path fails, confirm `dist/server/paymentPolicy.js` exists after build.)

- [ ] **Step 4: Commit**

```bash
git add server/paymentPolicy.ts scripts/test-payment-policy.mjs
git commit -m "feat(orders): pure payment-policy engine (derivePolicyKind, decide) + unit checks"
```

---

### Task 3: `resolvePolicy` — derive + admin override (DB-backed)

**Files:**
- Modify: `server/paymentPolicy.ts`
- Modify: `server/db.ts` (confirm `getSetting` exists ≈ line 357 — no change, reference only)

- [ ] **Step 1: Add settings keys + the resolver** to `server/paymentPolicy.ts`:

```ts
import { db, getSetting, getSettingBool } from './db.js';

const SETTING_KEYS = {
  enabled: 'payment_policy_enabled',
  cashMatch: 'policy_cash_paydes_match', // CSV of PAYDES substrings → cash
  netThreshold: 'policy_net_debt_threshold',
} as const;

export function policyEnabled(): boolean {
  return getSettingBool(SETTING_KEYS.enabled, false);
}
function cashMatchList(): string[] {
  return (getSetting(SETTING_KEYS.cashMatch) || 'מזומן').split(',').map((s) => s.trim()).filter(Boolean);
}
function globalThreshold(): number {
  const v = Number(getSetting(SETTING_KEYS.netThreshold));
  return isFinite(v) && v >= 0 ? v : 0;
}

interface PolicyRow { kind: string; open_debt_threshold: number | null; allow_order_with_open_debt: number }

/** Resolve a customer's effective policy: auto-derive from PAYDES, then apply the
 *  per-customer customer_policies override (kind + threshold + exemption). */
export function resolvePolicy(custname: string, paymentTerms: string | null): Policy {
  const row = db.prepare('SELECT kind, open_debt_threshold, allow_order_with_open_debt FROM customer_policies WHERE custname = ?').get(custname) as PolicyRow | undefined;
  const overrideKind = row && row.kind !== 'auto' && (row.kind === 'cash' || row.kind === 'net') ? (row.kind as PolicyKind) : null;
  const kind = overrideKind ?? derivePolicyKind(paymentTerms, cashMatchList());
  return {
    kind,
    requirePaymentBeforeApproval: kind === 'cash',
    blockOnOpenDebt: kind === 'net',
    openDebtThreshold: row && row.open_debt_threshold != null ? row.open_debt_threshold : globalThreshold(),
    allowOrderWithOpenDebt: !!(row && row.allow_order_with_open_debt),
  };
}
```

- [ ] **Step 2: Extend the assertion script** — append to `scripts/test-payment-policy.mjs` a DB-backed check (uses a temp DATA_DIR set by the runner in Step 3, so importing db.js opens the temp DB):

```js
// DB-backed resolve (runs against the temp DATA_DIR the runner sets)
import { resolvePolicy } from '../dist/server/paymentPolicy.js';
import Database from 'better-sqlite3';
import path from 'node:path';
const db2 = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db2.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt) VALUES ('C-EXEMPT','net',0,1)").run();
db2.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt) VALUES ('C-FORCECASH','cash',null,0)").run();
db2.close();
assert.equal(resolvePolicy('C-FORCECASH', 'שוטף').kind, 'cash');        // override wins
assert.equal(resolvePolicy('C-EXEMPT', 'שוטף').allowOrderWithOpenDebt, true);
assert.equal(resolvePolicy('UNKNOWN', 'מזומן').kind, 'cash');            // auto-derive
console.log('resolvePolicy: ALL PASS');
```

- [ ] **Step 3: Build + run against a temp DB (schema must exist first)**

Run:
```bash
rm -rf /tmp/pp-test && mkdir -p /tmp/pp-test
npm run build
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=/tmp/pp-test npx tsx -e "import('./server/db.js')"   # create schema
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=/tmp/pp-test node scripts/test-payment-policy.mjs
```
Expected: `payment-policy engine: ALL PASS` then `resolvePolicy: ALL PASS`.

- [ ] **Step 4: Commit**

```bash
git add server/paymentPolicy.ts scripts/test-payment-policy.mjs
git commit -m "feat(orders): resolvePolicy — PAYDES auto-derive + per-customer override"
```

---

### Task 4: `pendingSettlement` + `evaluate` (async integration)

**Files:**
- Modify: `server/paymentPolicy.ts`
- Reference: `server/cardPayments.ts` `unreconciledCardTotal` (exported), `server/finance.ts` `getAccountSummary`

- [ ] **Step 1: Add the helpers** to `server/paymentPolicy.ts`:

```ts
import { getAccountSummary } from './finance.js';
import { unreconciledCardTotal } from './cardPayments.js';

const RECON_WINDOW = '-1 day';
/** Money "in flight" that should offset open debt so a fresh payment lifts the
 *  block: unreconciled card payments + cheques the customer has submitted recently. */
export function pendingSettlement(custname: string): number {
  const card = unreconciledCardTotal(custname);
  const chq = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM payment_checks
     WHERE custname = ? AND status = 'submitted' AND submitted_at >= datetime('now', ?)`
  ).get(custname, RECON_WINDOW) as { s: number };
  return Math.round(((card + (chq.s || 0)) + Number.EPSILON) * 100) / 100;
}

/** Async order-time evaluation: resolve policy, compute net debt, decide. */
export async function evaluate(custname: string, cartTotal: number): Promise<PolicyDecision & { kind: PolicyKind }> {
  const summary = await getAccountSummary(custname);
  const policy = resolvePolicy(custname, summary.profile?.paymentTerms ?? null);
  const openTotal = summary.balanceOk ? summary.balance.openTotal : 0;
  const netDebt = Math.max(0, openTotal - pendingSettlement(custname));
  return { ...decide(policy, netDebt, cartTotal), kind: policy.kind };
}
```

- [ ] **Step 2: typecheck + build** (no new unit case — `evaluate` hits Priority; covered by E2E in Task 7/Phase 2)

Run: `npm run typecheck && npm run build`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add server/paymentPolicy.ts
git commit -m "feat(orders): pendingSettlement + async evaluate (policy + net debt)"
```

---

### Task 5: Admin settings — global policy config

**Files:**
- Modify: `server/index.ts` (the admin-settings `SETTABLE`/`BOOL_SETTINGS` sets ≈ lines 1271-1280)
- Modify: `src/pages/adminSettings.ts` (`renderSettingsAdmin` ≈ lines 6-87)

- [ ] **Step 1: Whitelist the new settings keys** — add to `SETTABLE` and (the bool one) to `BOOL_SETTINGS` in `server/index.ts`:

```ts
// in SETTABLE add:
'payment_policy_enabled', 'policy_cash_paydes_match', 'policy_net_debt_threshold',
// in BOOL_SETTINGS add:
'payment_policy_enabled',
```

- [ ] **Step 2: Add the config section** to `renderSettingsAdmin` in `src/pages/adminSettings.ts` (inside the form, following the existing checkbox/textarea pattern; bind to the same PATCH submit):

```html
<fieldset style="margin-top:1rem;border:1px solid var(--border);border-radius:8px;padding:0.75rem">
  <legend style="font-weight:700">מדיניות תשלום ואישור הזמנה</legend>
  <label style="display:flex;gap:0.5rem;align-items:center">
    <input type="checkbox" name="payment_policy_enabled" ${s.payment_policy_enabled === 'true' ? 'checked' : ''}/>
    הפעל מדיניות תשלום (כבוי = שום שינוי ללקוחות)
  </label>
  <label style="display:block;margin-top:0.5rem">מילים ש"מזומן" (מופרד בפסיק, מ-PAYDES)
    <input name="policy_cash_paydes_match" value="${escapeAttr(s.policy_cash_paydes_match || 'מזומן')}" style="width:100%"/>
  </label>
  <label style="display:block;margin-top:0.5rem">סף חוב פתוח לחסימת שוטף (₪, 0 = כל חוב לא-מכוסה חוסם)
    <input name="policy_net_debt_threshold" type="number" min="0" value="${escapeAttr(s.policy_net_debt_threshold || '0')}" style="width:160px"/>
  </label>
</fieldset>
```

(Note: the existing submit handler posts all named inputs to `PATCH /api/admin/settings`; the checkbox sends `'on'` → confirm the existing bool handling maps it, mirroring `announcement_enabled`.)

- [ ] **Step 3: Verify end-to-end against a local admin session**

Run (server up via `DATA_DIR=./data-qa npm run dev`, node@24):
```bash
AU=$(grep '^ADMIN_BOOTSTRAP_USERNAME=' .env|cut -d= -f2-); AP=$(grep '^ADMIN_BOOTSTRAP_PASSWORD=' .env|cut -d= -f2-)
curl -s -c /tmp/a.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$AU\",\"password\":\"$AP\"}" -o /dev/null
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/settings -H 'Content-Type: application/json' -d '{"payment_policy_enabled":true,"policy_cash_paydes_match":"מזומן","policy_net_debt_threshold":0}' -w "\n%{http_code}\n"
curl -s -b /tmp/a.j localhost:3030/api/admin/settings | grep -o 'payment_policy_enabled[^,]*'
```
Expected: PATCH returns 200; the GET shows `payment_policy_enabled":"true"`.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts src/pages/adminSettings.ts
git commit -m "feat(admin): payment-policy global config (flag + PAYDES match + threshold)"
```

---

### Task 6: Per-customer policy override (admin)

**Files:**
- Modify: `server/index.ts` (add routes near the other admin customer/user routes)
- Modify: `src/pages/adminUsers.ts` (`renderUsersAdmin` — add a policy control per customer row/form)

- [ ] **Step 1: Add GET + PATCH endpoints** in `server/index.ts` (admin-only):

```ts
app.get('/api/admin/customers/:custname/policy', requireAdmin, (req, res) => {
  const row = db.prepare('SELECT custname, kind, open_debt_threshold, allow_order_with_open_debt FROM customer_policies WHERE custname = ?').get(req.params.custname) || { custname: req.params.custname, kind: 'auto', open_debt_threshold: null, allow_order_with_open_debt: 0 };
  res.json(row);
});
app.patch('/api/admin/customers/:custname/policy', requireAdmin, (req, res) => {
  const b = (req.body || {}) as { kind?: string; open_debt_threshold?: number | null; allow_order_with_open_debt?: boolean };
  const kind = ['auto', 'cash', 'net', 'custom'].includes(String(b.kind)) ? b.kind : 'auto';
  const thr = b.open_debt_threshold == null || b.open_debt_threshold === undefined ? null : Number(b.open_debt_threshold);
  const allow = b.allow_order_with_open_debt ? 1 : 0;
  db.prepare(`INSERT INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt, updated_at)
              VALUES (?, ?, ?, ?, datetime('now'))
              ON CONFLICT(custname) DO UPDATE SET kind=excluded.kind, open_debt_threshold=excluded.open_debt_threshold, allow_order_with_open_debt=excluded.allow_order_with_open_debt, updated_at=datetime('now')`).run(req.params.custname, kind, thr, allow);
  res.json({ ok: true });
});
```

- [ ] **Step 2: Add the per-customer control** in `src/pages/adminUsers.ts` — for each customer, a small inline policy editor (dropdown `auto/cash/net` + an "מורשה להזמין עם חוב" checkbox), loading from GET and saving via the PATCH above. Add to the customer row actions:

```ts
// after fetching customers, for each row add a button "מדיניות תשלום" that opens a
// small inline form (or a prompt-based MVP):
async function editPolicy(custname: string): Promise<void> {
  const p = await api.get<{ kind: string; allow_order_with_open_debt: number }>(`/api/admin/customers/${encodeURIComponent(custname)}/policy`);
  const kind = prompt(`סוג תשלום ל-${custname} (auto / cash / net):`, p.kind) || p.kind;
  const allow = confirm('מורשה להזמין למרות חוב פתוח? (אישור = כן)');
  await api.patch(`/api/admin/customers/${encodeURIComponent(custname)}/policy`, { kind, allow_order_with_open_debt: allow });
  toast('מדיניות עודכנה', 'ok');
}
```

(A prompt/confirm MVP is acceptable for Phase 1; a proper inline form can come with Phase 2's UI work. Wire a `data-policy="<custname>"` button to `editPolicy`.)

- [ ] **Step 3: Verify**

Run (admin session from Task 5):
```bash
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/customers/10184/policy -H 'Content-Type: application/json' -d '{"kind":"cash"}' -w "\n%{http_code}\n"
curl -s -b /tmp/a.j localhost:3030/api/admin/customers/10184/policy
```
Expected: PATCH 200; GET shows `"kind":"cash"`.

- [ ] **Step 4: typecheck + build + commit**

```bash
npm run typecheck && npm run build
git add server/index.ts src/pages/adminUsers.ts
git commit -m "feat(admin): per-customer payment-policy override (kind + exemption)"
```

---

### Task 7: Surface resolved policy in /api/home (informational only)

**Files:**
- Modify: `server/home.ts` (`getHomeData` ≈ lines 81-137, the returned object)

- [ ] **Step 1: Add the policy to the home payload** — non-gating, so the client can later show hints. In `getHomeData`, after the summary is loaded:

```ts
import { resolvePolicy, policyEnabled, pendingSettlement } from './paymentPolicy.js';
// ... inside getHomeData, where `summary` (AccountSummary) is available:
const pol = policyEnabled() ? resolvePolicy(custname, summary.profile?.paymentTerms ?? null) : null;
const netDebt = summary.balanceOk ? Math.max(0, summary.balance.openTotal - pendingSettlement(custname)) : 0;
// add to the returned object:
paymentPolicy: pol ? { kind: pol.kind, netDebt, blocksOnDebt: pol.blockOnOpenDebt && !pol.allowOrderWithOpenDebt && netDebt > pol.openDebtThreshold + 0.001 } : null,
```

Add `paymentPolicy` to the `HomeData` interface (server `home.ts` and the client `src/pages/home.ts` interface) as:
```ts
paymentPolicy: { kind: 'cash' | 'net'; netDebt: number; blocksOnDebt: boolean } | null;
```

- [ ] **Step 2: Verify the field appears (flag on, logged-in customer)**

Run (server up, flag enabled from Task 5):
```bash
CU=$(curl -s -c /tmp/c.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d '{"username":"qa","password":"qa123456"}' -o /dev/null -w '%{http_code}')
curl -s -b /tmp/c.j localhost:3030/api/home | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("paymentPolicy:",JSON.stringify(j.paymentPolicy))})'
```
Expected: prints `paymentPolicy: {"kind":...,"netDebt":...,"blocksOnDebt":...}` (or `null` if the flag is off). No customer behavior changes.

- [ ] **Step 3: typecheck + build + commit**

```bash
npm run typecheck && npm run build
git add server/home.ts src/pages/home.ts
git commit -m "feat(home): surface resolved payment policy (informational, no gating)"
```

---

### Task 8: Final verification + deploy

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run build && node scripts/test-payment-policy.mjs` (after a fresh temp-DB build per Task 3)
Expected: all green; `ALL PASS` lines.

- [ ] **Step 2: Regression — existing E2E suite (no customer behavior changed; flag default OFF)**

Run: boot `DATA_DIR=./data-qa npm run dev` + the CDP Chrome, then `bash qa/run-auth.sh`
Expected: `AUTH TOTAL: 21 pass / 0 fail`.

- [ ] **Step 3: Deploy** (per the always-deploy preference; Phase 1 is inert with the flag OFF)

```bash
git push origin HEAD:main
```
Then poll the prod bundle hash change + health-check `/api/auth/me` 200 and `/api/admin/settings` 401.

- [ ] **Step 4: Confirm prod is healthy and the flag is OFF** (no behavior change), and report.

---

## Self-Review notes
- **Spec coverage (Phase 1 only):** policy engine (Task 2-4) ✓ · customer_policies + override (Task 1,3,6) ✓ · settings/flag (Task 1,5) ✓ · post-dated-cheque exclusion via openTotal + pendingSettlement (Task 4) ✓ · informational surfacing (Task 7) ✓ · order/payment columns staged for Phase 3 (Task 1) ✓. Gating behavior (Phase 2/3) intentionally NOT here.
- **Types:** `Policy`, `PolicyDecision`, `PolicyKind` defined in Task 2 and reused in Tasks 3-4,7. `resolvePolicy`/`evaluate`/`pendingSettlement`/`policyEnabled` names consistent across tasks.
- **No placeholders:** every code/verify step has concrete content + commands.
