# Fast-Track Checkout (מסלול מהיר) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At checkout, eligible customers choose between a **fast track** (pay now by card / cheque photo → configurable ~3% discount, instant order approval, priority-shipping note to the office) and the **regular track** (their existing net terms, e.g. שוטף+60, normal flow).

**Architecture:** Reuse the existing cash-hold machinery end-to-end: a fast-track order is written as `pending_payment` with a *discounted* `payment_required_amount`, and the untouched pay/approve pipeline (`/api/orders/:id/pay/card`, `/pay/check` → `approveOrder` → `sendHeldOrderToPriority`) does the rest — `deriveOrderCharge` already charges `payment_required_amount`, so PayPlus/cheque automatically collect the discounted sum. The discount itself follows the existing manual-promo convention: the app never sends prices to Priority; a `DETAILS` note tells the office to apply the % on the invoice and to ship with priority. New code is one small server module (`server/fastTrack.ts`), a preview field, a `track` param on submit, admin plumbing, and the checkout selector UI.

**Business rationale (psychology, from the design discussion):** choice preserves autonomy (nothing is taken away); "cash buys priority" is a fairness norm, not a distrust signal; the fast option is pre-selected and shows the saving so choosing regular means visibly giving up a discount; the regular track stays genuinely fine (no punishment framing).

**Tech Stack:** Express + better-sqlite3 (`server/*.ts`), vanilla-TS Vite front (`src/`), Priority OData REST. Test convention: `node scripts/test-*.mjs` against `dist/server/*.js` with a scratch `DATA_DIR` (see `scripts/test-payment-policy.mjs`).

## Global Constraints

- `fast_track_enabled` defaults **false** — the whole feature is inert until Assaf flips it in admin. Deploy-safe at every commit.
- Server re-validates everything: a client asking for `track:'fast'` gets the discount ONLY if the flag is on, the customer is eligible, and the payment policy didn't already force a cash hold or block the order. Policy always wins over track choice.
- Never send prices for paid lines to Priority (existing rule). The fast-track discount rides in the order `DETAILS` note ("נא ליישם"), like percent promos.
- `orders_local.total` keeps its existing meaning (post-promotion, pre-VAT, **undiscounted**). The discounted collectible lives in `payment_required_amount` + the new `fast_track_discount_pct` column.
- All customer-facing copy is Hebrew, neutral status language: "מסלול מהיר" / "מסלול רגיל" — never "אשראי נחסם" or cash/credit status wording.
- Discount % is admin-config (`fast_track_discount_pct`, default 3, clamped 0–20).
- Tests import from `dist/server/*.js` → run `npm run build` before `node scripts/test-*.mjs`, with a scratch `DATA_DIR`.
- Node >= 20. Typecheck gate: `npm run typecheck`.
- **שוטף-only (amendment, user decision 2026-07-09):** the offer is restricted to genuine net-terms customers. Qualification = explicit `customer_policies.kind = 'net'` override, OR (`kind` auto/absent AND the customer's Priority PAYDES contains "שוטף"). An explicit `'cash'` override, unknown/empty terms, or an unreachable Priority all DISQUALIFY — `derivePolicyKind`'s net-default is a fail-open for ordering, not for granting discounts.

## Amendment: שוטף-only qualification

Task 1 additionally exports this async gate (used by Tasks 2 & 3 **instead of** the bare `fastTrackAvailable` in their availability checks; `fastTrackAvailable` remains the sync flag+opt-out core it composes):

```ts
import { getAccountSummary } from './finance.js';

/** Full qualification: flag on, company not opted out, AND genuinely on net terms
 *  (שוטף). Explicit per-customer kind override wins both ways; otherwise PAYDES must
 *  actually say שוטף. Terms unknown / Priority down → no offer (regular flow works). */
export async function fastTrackQualifies(custname: string): Promise<boolean> {
  if (!fastTrackAvailable(custname)) return false;
  const row = db.prepare('SELECT kind FROM customer_policies WHERE custname = ?').get(custname) as
    | { kind?: string } | undefined;
  if (row?.kind === 'net') return true;
  if (row?.kind === 'cash') return false;
  try {
    const summary = await getAccountSummary(custname);
    return /שוטף/.test(summary.profile?.paymentTerms ?? '');
  } catch {
    return false;
  }
}
```

- Task 2 Step 2 condition becomes: `if (track === 'fast' && !cashHold && (await fastTrackQualifies(custname)))`.
- Task 3's `offerFast` helper becomes async and awaits `fastTrackQualifies(custname)` in place of `fastTrackAvailable(custname)`; both call sites `await` it.
- Task 1's test additionally covers `fastTrackQualifies`: flag off → false even for a `kind='net'` override; flag on → `net` override true, `cash` override false, auto kind with Priority unreachable (no config in the scratch env) → false.

---

### Task 1: `server/fastTrack.ts` module + DB columns + unit tests

**Files:**
- Create: `server/fastTrack.ts`
- Modify: `server/db.ts` (after line 418, the `customer_policies` ensureColumn block)
- Test: `scripts/test-fast-track.mjs`

**Interfaces:**
- Consumes: `db`, `getSetting`, `getSettingBool` from `./db.js`; `withVat` from `./money.js`.
- Produces (later tasks import these from `./fastTrack.js`):
  - `fastTrackEnabled(): boolean`
  - `fastTrackDiscountPct(): number`
  - `fastTrackCustomerEligible(custname: string): boolean`
  - `fastTrackAvailable(custname: string): boolean`
  - `fastTrackAmounts(preVatTotal: number, pct: number): FastTrackAmounts`
  - `interface FastTrackAmounts { discountPct: number; discountedTotal: number; payable: number; saving: number }`
  - DB columns: `customer_policies.fast_track` (INTEGER, NULL/1 = eligible, 0 = opted out), `orders_local.fast_track` (INTEGER NOT NULL DEFAULT 0), `orders_local.fast_track_discount_pct` (REAL).

- [ ] **Step 1: Add the DB columns** — in `server/db.ts`, directly after the `customer_policies` lines at 417–418 (`enforced` / `block_overdue_only`), add:

```ts
// Fast-track checkout (מסלול מהיר): per-customer opt-OUT. NULL / 1 = the customer is
// offered the fast track (default — it's a benefit); 0 = admin excluded this company.
ensureColumn('customer_policies', 'fast_track', 'INTEGER');
// Which track the order took + the % actually granted (audit + office reconciliation).
ensureColumn('orders_local', 'fast_track', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders_local', 'fast_track_discount_pct', 'REAL');
```

- [ ] **Step 2: Write the failing test** — create `scripts/test-fast-track.mjs`:

```js
// Unit checks for fast-track checkout. Run: npm run build && DATA_DIR=<scratch> node scripts/test-fast-track.mjs
import assert from 'node:assert/strict';
import { fastTrackAmounts, fastTrackCustomerEligible } from '../dist/server/fastTrack.js';
import Database from 'better-sqlite3';
import path from 'node:path';

// --- pure discount math (VAT 18%) ---
// 3% off a 1000₪ pre-VAT cart: 970 pre-VAT → 1144.60 incl VAT; full 1180 → saving 35.40
assert.deepEqual(fastTrackAmounts(1000, 3), { discountPct: 3, discountedTotal: 970, payable: 1144.6, saving: 35.4 });
// 0% — no change, zero saving
assert.deepEqual(fastTrackAmounts(500, 0), { discountPct: 0, discountedTotal: 500, payable: 590, saving: 0 });
// rounding: 33.33 × 0.97 = 32.3301 → 32.33 → payable 38.15; full 39.33 → saving 1.18
const r = fastTrackAmounts(33.33, 3);
assert.equal(r.discountedTotal, 32.33);
assert.equal(r.payable, 38.15);
assert.equal(r.saving, 1.18);
console.log('fastTrackAmounts: ALL PASS');

// --- DB-backed eligibility (mirrors test-payment-policy.mjs style) ---
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, fast_track) VALUES ('C-OUT','auto',0)").run();
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind, fast_track) VALUES ('C-IN','auto',1)").run();
db.prepare("INSERT OR REPLACE INTO customer_policies (custname, kind) VALUES ('C-NULL','auto')").run();
db.close();
assert.equal(fastTrackCustomerEligible('C-OUT'), false);
assert.equal(fastTrackCustomerEligible('C-IN'), true);
assert.equal(fastTrackCustomerEligible('C-NULL'), true); // NULL column = eligible
assert.equal(fastTrackCustomerEligible('NO-ROW'), true); // no row at all = eligible
console.log('fastTrackCustomerEligible: ALL PASS');
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run build && DATA_DIR=/tmp/ft-t1 node scripts/test-fast-track.mjs`
Expected: FAIL — `Cannot find module '../dist/server/fastTrack.js'` (build error first: module doesn't exist yet, so `npm run build` itself is fine but the import fails at runtime).

- [ ] **Step 4: Write the implementation** — create `server/fastTrack.ts`:

```ts
// Fast-track checkout (מסלול מהיר): the customer CHOOSES to prepay (card / cheque
// photo) in exchange for a % discount + instant approval + priority shipping. The
// regular track (net terms) stays untouched. Plan: 2026-07-09-fast-track-checkout.
import { db, getSetting, getSettingBool } from './db.js';
import { withVat } from './money.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const FAST_TRACK_KEYS = {
  enabled: 'fast_track_enabled',
  discountPct: 'fast_track_discount_pct',
} as const;

export function fastTrackEnabled(): boolean {
  return getSettingBool(FAST_TRACK_KEYS.enabled, false);
}

/** Admin-config discount %. Default 3, clamped to 0–20 so a fat-fingered "30" can
 *  never give away a third of an order. */
export function fastTrackDiscountPct(): number {
  const v = Number(getSetting(FAST_TRACK_KEYS.discountPct));
  if (!isFinite(v) || v < 0) return 3;
  return Math.min(v, 20);
}

/** Per-customer eligibility. No row / NULL = eligible — the offer is a benefit,
 *  on by default; the admin opts specific companies OUT (fast_track = 0). */
export function fastTrackCustomerEligible(custname: string): boolean {
  const row = db.prepare('SELECT fast_track FROM customer_policies WHERE custname = ?').get(custname) as
    | { fast_track?: number | null } | undefined;
  if (!row || row.fast_track == null) return true;
  return !!row.fast_track;
}

/** The single gate later code checks: master flag AND this customer not opted out. */
export function fastTrackAvailable(custname: string): boolean {
  return fastTrackEnabled() && fastTrackCustomerEligible(custname);
}

export interface FastTrackAmounts {
  discountPct: number;
  discountedTotal: number; // pre-VAT, after the fast-track % (applied on the post-promotion total)
  payable: number;         // withVat(discountedTotal) — what the customer pays now
  saving: number;          // VAT-inclusive saving vs paying full: withVat(total) − payable
}

/** PURE discount math (unit-tested). `preVatTotal` is the post-promotion cart total —
 *  the fast-track % stacks on top of promotions, matching what the customer sees. */
export function fastTrackAmounts(preVatTotal: number, pct: number): FastTrackAmounts {
  const discountedTotal = round2(preVatTotal * (1 - pct / 100));
  const payable = withVat(discountedTotal);
  return { discountPct: pct, discountedTotal, payable, saving: round2(withVat(preVatTotal) - payable) };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && rm -rf /tmp/ft-t1 && mkdir -p /tmp/ft-t1 && DATA_DIR=/tmp/ft-t1 node scripts/test-fast-track.mjs`
Expected: `fastTrackAmounts: ALL PASS` then `fastTrackCustomerEligible: ALL PASS` (the import of `fastTrack.js` pulls in `db.js`, which creates the schema in the scratch `DATA_DIR` before the test body opens it).

- [ ] **Step 6: Commit**

```bash
git add server/fastTrack.ts server/db.ts scripts/test-fast-track.mjs
git commit -m "feat(fast-track): discount math, eligibility, and DB columns for the prepaid fast track"
```

---

### Task 2: Submit flow — `track` parameter, discounted hold, office note

**Files:**
- Modify: `server/orders.ts:153-171` (submitOrder / submitOrderInner signatures), `:179-191` (note composition), `:215-242` (policy gate + insert)
- Modify: `server/index.ts:839-842` (POST /api/orders)

**Interfaces:**
- Consumes: `fastTrackAvailable(custname)`, `fastTrackAmounts(preVatTotal, pct)`, `fastTrackDiscountPct()`, `type FastTrackAmounts` from `./fastTrack.js` (Task 1).
- Produces: `submitOrder(userId: number, custname: string, details?: string, track?: 'fast' | 'regular')` — unchanged `SubmitResult` shape; a fast-track submit returns `{ needsPayment: true, amount: <discounted VAT-inclusive> }` exactly like the existing cash hold. `POST /api/orders` accepts optional body field `track: 'fast' | 'regular'`.

- [ ] **Step 1: Thread `track` through the submit entry points** — in `server/orders.ts` change both signatures:

```ts
export async function submitOrder(
  userId: number,
  custname: string,
  details?: string,
  track?: 'fast' | 'regular'
): Promise<SubmitResult> {
  if (inFlightSubmits.has(userId)) throw new OrderError('ההזמנה כבר נשלחת — המתינו רגע');
  inFlightSubmits.add(userId);
  try {
    return await submitOrderInner(userId, custname, details, track);
  } finally {
    inFlightSubmits.delete(userId);
  }
}

async function submitOrderInner(
  userId: number,
  custname: string,
  details?: string,
  track?: 'fast' | 'regular'
): Promise<SubmitResult> {
```

Add to the imports at the top of `orders.ts`:

```ts
import { fastTrackAvailable, fastTrackAmounts, fastTrackDiscountPct, type FastTrackAmounts } from './fastTrack.js';
```

- [ ] **Step 2: Defer the details composition and add the fast-track decision** — in `submitOrderInner`, DELETE these two lines (currently 190–191):

```ts
  const promoNote = noteParts.join(' | ');
  const fullDetails = [details, promoNote].filter(Boolean).join(' | ') || null;
```

Then, directly AFTER the payment-policy gate block (the `if (enforcedFor(custname)) { ... }` ending at line 231), add:

```ts
  // Fast-track (מסלול מהיר): the customer CHOSE to prepay in exchange for the
  // discount + instant approval + priority shipping. Honored only when the policy
  // didn't already force a full-price cash hold (policy wins) — and re-validated
  // server-side so a stale or tampered client can't self-grant a discount while
  // the flag is off or the company was opted out.
  let fast: FastTrackAmounts | null = null;
  if (track === 'fast' && !cashHold && fastTrackAvailable(custname)) {
    fast = fastTrackAmounts(promotions.total, fastTrackDiscountPct());
    cashHold = true; // reuse the held-order machinery: pending_payment → pay → approveOrder
    requiredAmount = fast.payable;
    noteParts.push(
      `מסלול מהיר 🚀 שולם מראש בהנחת ${fast.discountPct}% — נא ליישם את ההנחה בחשבונית — למשלוח בעדיפות`
    );
  }
  const fullDetails = [details, noteParts.join(' | ')].filter(Boolean).join(' | ') || null;
```

(`fullDetails` is only used below this point — the local INSERT and the Priority payload — so moving it is safe. `sendHeldOrderToPriority` re-reads `orders_local.details`, so the note reaches Priority on the approve path too.)

- [ ] **Step 3: Record the track on the local order** — change the INSERT (currently lines 237–242) to:

```ts
  const localOrderId = (db
    .prepare(
      `INSERT INTO orders_local (user_id, custname, status, total, details, fast_track, fast_track_discount_pct)
       VALUES (?, ?, 'submitting', ?, ?, ?, ?)`
    )
    .run(userId, custname, promotions.total, fullDetails, fast ? 1 : 0, fast ? fast.discountPct : null).lastInsertRowid as number);
```

The existing `if (cashHold) { ... }` block (lines 266–272) needs **no change** — it already writes `payment_required_amount = requiredAmount` (now the discounted payable for fast-track) and returns `needsPayment: true`.

- [ ] **Step 4: Accept `track` at the endpoint** — in `server/index.ts`, change lines 840–842 to:

```ts
  const { details, track } = (req.body || {}) as { details?: string; track?: string };
  try {
    const result = await submitOrder(req.user!.id, req.user!.custname!, details, track === 'fast' ? 'fast' : 'regular');
```

- [ ] **Step 5: Typecheck + existing tests still green**

Run: `npm run typecheck && npm run build && rm -rf /tmp/ft-t2 && mkdir -p /tmp/ft-t2 && DATA_DIR=/tmp/ft-t2 node scripts/test-fast-track.mjs && DATA_DIR=/tmp/ft-t2 node scripts/test-payment-policy.mjs`
Expected: no type errors; both test scripts print ALL PASS.

- [ ] **Step 6: Commit**

```bash
git add server/orders.ts server/index.ts
git commit -m "feat(fast-track): customer-chosen prepaid hold with discounted required amount + office note"
```

---

### Task 3: Checkout preview — advertise the offer

**Files:**
- Modify: `server/checkoutPreview.ts`

**Interfaces:**
- Consumes: `fastTrackAvailable`, `fastTrackAmounts`, `fastTrackDiscountPct` from `./fastTrack.js` (Task 1).
- Produces: `CheckoutPreview.fastTrack: { discountPct: number; discountedTotal: number; payable: number; saving: number } | null` — `null` whenever the offer must not render (flag off, customer opted out, cash-forced customer, debt-blocked order, empty cart). Task 6's client reads exactly this shape.

- [ ] **Step 1: Add the field and compute it** — in `server/checkoutPreview.ts`:

Add to imports:

```ts
import { fastTrackAvailable, fastTrackAmounts, fastTrackDiscountPct, type FastTrackAmounts } from './fastTrack.js';
```

Add to the `CheckoutPreview` interface (after `installments`):

```ts
  /** Fast-track (מסלול מהיר) offer — null when the flag is off, the company is opted
   *  out, the customer must prepay anyway (cash policy — full price, no discount),
   *  or the order is debt-blocked. Amounts are VAT-inclusive where named payable/saving. */
  fastTrack: FastTrackAmounts | null;
```

In `buildCheckoutPreview`, add this helper before the `if (!enforcedFor(custname))` return:

```ts
  const offerFast = (requiresPayment: boolean, blocked: boolean): FastTrackAmounts | null =>
    fastTrackAvailable(custname) && !requiresPayment && !blocked && promotions.total > 0
      ? fastTrackAmounts(promotions.total, fastTrackDiscountPct())
      : null;
```

Change the early return to include `fastTrack: offerFast(false, false)`:

```ts
  if (!enforcedFor(custname)) {
    return { ...base, installments, requiresPayment: false, kind: null, blocked: false, blockedReason: null, fastTrack: offerFast(false, false) };
  }
```

And the final return to include `fastTrack: offerFast(d.requiresPayment, !d.allowOrder)`:

```ts
  return {
    ...base,
    installments,
    requiresPayment: d.requiresPayment,
    kind: d.kind,
    blocked: !d.allowOrder,
    blockedReason: d.reason === 'open_debt' ? 'open_debt' : null,
    fastTrack: offerFast(d.requiresPayment, !d.allowOrder),
  };
```

Note: the offer intentionally does NOT depend on `unified_checkout_enabled` — fast track works with the unified flag off (the client falls back to the `#order-pay` interstitial, Task 6).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/checkoutPreview.ts
git commit -m "feat(fast-track): checkout preview advertises the prepaid offer"
```

---

### Task 4: Admin settings — flag, discount %, kill switch

**Files:**
- Modify: `server/index.ts:1503-1529` (SETTABLE + BOOL_SETTINGS)
- Modify: `src/pages/adminSettings.ts:27-36` (SWITCH_ROWS) and the advanced `<details>` section (~line 130-160) + its save handler (~line 257-266)

**Interfaces:**
- Consumes: the settings PATCH machinery as-is.
- Produces: settings keys `fast_track_enabled` (bool) and `fast_track_discount_pct` (text/number) writable from the admin UI; a kill-switch row and a % input.

- [ ] **Step 1: Whitelist the keys** — in `server/index.ts` add to the `SETTABLE` set (after `'saved_card_charge_enabled',`):

```ts
  'fast_track_enabled',
  'fast_track_discount_pct',
```

and add `'fast_track_enabled'` to the `BOOL_SETTINGS` set (line 1529).

- [ ] **Step 2: Add the kill switch** — in `src/pages/adminSettings.ts`, add to `SWITCH_ROWS` (after the `saved_card_charge_enabled` row):

```ts
  { key: 'fast_track_enabled', name: 'מסלול מהיר (תשלום מראש)', desc: 'בחירת מסלול בסיום הזמנה: תשלום מיידי בהנחה + אישור מיידי ומשלוח בעדיפות. אחוז ההנחה בהגדרות מתקדמות.', def: false, dangerousValue: true },
```

(`dangerousValue: true` — turning it ON changes checkout for every eligible customer, so the ON direction requires the typed confirm, same as `unified_checkout_enabled`.)

- [ ] **Step 3: Add the % input to the advanced section** — in the `<details>` "הגדרות מתקדמות" HTML, directly after the `#s-policy-debt` input block (~line 139), add:

```html
        <label style="display:block;margin-top:0.75rem;font-weight:600">הנחת מסלול מהיר (%)</label>
        <input id="s-fast-pct" type="number" min="0" max="20" step="0.5" placeholder="3" value="${escapeHtml(txt('fast_track_discount_pct') || '3')}" style="width:100%;box-sizing:border-box"/>
        <div class="muted" style="font-size:0.78rem;margin-top:0.15rem">ברירת מחדל 3%. מוגבל ל-20% בצד השרת.</div>
```

- [ ] **Step 4: Save it** — in the `#s-adv-save` click handler's PATCH body (next to `policy_net_debt_threshold`, ~line 266), add:

```ts
        fast_track_discount_pct: (c.querySelector('#s-fast-pct') as HTMLInputElement).value,
```

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add server/index.ts src/pages/adminSettings.ts
git commit -m "feat(fast-track): admin flag, discount % config, and kill switch"
```

---

### Task 5: Per-customer opt-out on the customers board

**Files:**
- Modify: `server/customers.ts:72-97` (PATCHABLE + patchCustomer) and `:140-142` (getCustomerAdmin)
- Modify: `src/pages/adminCustomerCard.ts` (policy card checkbox ~line 176-181, save handler ~line 260-266, and the `policy` type)

**Interfaces:**
- Consumes: `customer_policies.fast_track` column (Task 1).
- Produces: `PATCH /api/admin/customers/:custname` accepts `fast_track: boolean`; `GET` returns `policy.fast_track: number | null` (null/1 = offered, 0 = excluded).

- [ ] **Step 1: Server patch/read** — in `server/customers.ts`:

Add `'fast_track'` to `PATCHABLE`:

```ts
const PATCHABLE = new Set(['kind', 'open_debt_threshold', 'allow_order_with_open_debt', 'enforced', 'fast_track']);
```

In `patchCustomer`, extend the current-row SELECT and default to include `fast_track`:

```ts
  const cur = (db.prepare('SELECT kind, open_debt_threshold, allow_order_with_open_debt, enforced, block_overdue_only, fast_track FROM customer_policies WHERE custname = ?').get(custname)
    || { kind: 'auto', open_debt_threshold: null, allow_order_with_open_debt: 0, enforced: 0, block_overdue_only: 0, fast_track: null }) as { kind: string; open_debt_threshold: number | null; allow_order_with_open_debt: number; enforced: number; block_overdue_only: number; fast_track: number | null };
```

after the `overdueOnly` handling add:

```ts
  let fastTrack = cur.fast_track;
  if ('fast_track' in patch) fastTrack = patch.fast_track ? 1 : 0;
```

and extend the upsert:

```ts
  db.prepare(
    `INSERT INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt, enforced, block_overdue_only, fast_track, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(custname) DO UPDATE SET kind = excluded.kind, open_debt_threshold = excluded.open_debt_threshold, allow_order_with_open_debt = excluded.allow_order_with_open_debt, enforced = excluded.enforced, block_overdue_only = excluded.block_overdue_only, fast_track = excluded.fast_track, updated_at = datetime('now')`
  ).run(custname, kind, thr, allow, enforced, overdueOnly, fastTrack);
```

In `getCustomerAdmin` (line 141-142) extend the SELECT and fallback the same way:

```ts
  const policy = db.prepare('SELECT kind, open_debt_threshold, allow_order_with_open_debt, enforced, block_overdue_only, fast_track FROM customer_policies WHERE custname = ?').get(custname)
    || { kind: 'auto', open_debt_threshold: null, allow_order_with_open_debt: 0, enforced: 0, block_overdue_only: 0, fast_track: null };
```

- [ ] **Step 2: Card editor checkbox** — in `src/pages/adminCustomerCard.ts`:

Add `fast_track?: number | null;` to the `policy` object type in the `CustomerCard` interface.

After the `#cc-overdue` label block (~line 176-181) add:

```html
          <label style="display:flex;align-items:center;gap:0.45rem;margin-top:0.5rem;cursor:pointer">
            <input type="checkbox" id="cc-fasttrack" ${d.policy.fast_track === 0 ? '' : 'checked'}/>
            <span>מסלול מהיר מוצע ללקוח (הנחת תשלום מראש)</span>
          </label>
          <div class="muted" style="font-size:0.8rem;margin:0.15rem 0 0 1.6rem">פעיל רק כשהמתג הראשי דולק בהגדרות</div>
```

In the save handler's PATCH body (after `block_overdue_only:`) add:

```ts
        fast_track: (shell.querySelector('#cc-fasttrack') as HTMLInputElement).checked,
```

- [ ] **Step 3: Extend the test** — append to `scripts/test-fast-track.mjs`:

```js
// patchCustomer round-trip: opt out, then back in
import { patchCustomer } from '../dist/server/customers.js';
import Database2 from 'better-sqlite3';
const db3 = new Database2(path.join(process.env.DATA_DIR || './data', 'app.db'));
patchCustomer('C-RT', { fast_track: false });
assert.equal(db3.prepare("SELECT fast_track FROM customer_policies WHERE custname='C-RT'").get().fast_track, 0);
assert.equal(fastTrackCustomerEligible('C-RT'), false);
patchCustomer('C-RT', { fast_track: true });
assert.equal(fastTrackCustomerEligible('C-RT'), true);
// patching an unrelated field must PRESERVE the opt-out (read-merge-write)
patchCustomer('C-RT2', { fast_track: false });
patchCustomer('C-RT2', { enforced: true });
assert.equal(fastTrackCustomerEligible('C-RT2'), false);
console.log('patchCustomer fast_track: ALL PASS');
```

- [ ] **Step 4: Run tests**

Run: `npm run typecheck && npm run build && rm -rf /tmp/ft-t5 && mkdir -p /tmp/ft-t5 && DATA_DIR=/tmp/ft-t5 node scripts/test-fast-track.mjs`
Expected: all three PASS lines, ending `patchCustomer fast_track: ALL PASS`.

- [ ] **Step 5: Commit**

```bash
git add server/customers.ts src/pages/adminCustomerCard.ts scripts/test-fast-track.mjs
git commit -m "feat(fast-track): per-customer opt-out on the customers board"
```

---

### Task 6: Checkout UI — the track selector

**Files:**
- Modify: `src/pages/checkout.ts`

**Interfaces:**
- Consumes: `preview.fastTrack` (Task 3 shape), `POST /api/orders` `track` field (Task 2). Existing pay endpoints unchanged.
- Produces: customer-facing selector. Fast pre-selected. Choosing regular visibly gives up the saving (loss framing). Neutral copy — no credit/cash status language.

- [ ] **Step 1: Extend the client preview type** — add to the `CheckoutPreview` interface in `src/pages/checkout.ts`:

```ts
  fastTrack: { discountPct: number; discountedTotal: number; payable: number; saving: number } | null;
```

- [ ] **Step 2: Offer state** — after `const payNow = unified && !!preview!.requiresPayment;` (line 111) add:

```ts
  // Fast-track offer: server already nulls it for cash-forced / blocked / opted-out
  // customers; re-guard on the client debt block anyway (belt and braces).
  const fastOffer = (!home?.paymentPolicy?.blocksOnDebt && preview?.fastTrack) || null;
  let fastSelected = !!fastOffer; // pre-selected: choosing "regular" means giving up the discount
```

Change the saved-card fetch condition (line 117) from `if (payNow && preview!.savedCardCharge)` to:

```ts
  if ((payNow || fastOffer) && preview!.savedCardCharge) {
```

- [ ] **Step 3: Render the selector** — in the big `shell.innerHTML` template, directly after `${debtBlock}\n    ${creditWarn}`, add:

```ts
    ${
      fastOffer
        ? `<div class="card" id="track-card">
             <div style="font-weight:700;margin-bottom:0.55rem">בחרו מסלול</div>
             <div class="track-opt" data-track="fast" style="border:2px solid var(--brand);border-radius:12px;padding:0.7rem 0.8rem;cursor:pointer;background:rgba(37,99,235,0.05)">
               <div style="display:flex;justify-content:space-between;align-items:center">
                 <span style="font-weight:800">🚀 מסלול מהיר</span>
                 <span style="font-weight:800;color:var(--brand)">${formatMoney(fastOffer.payable)}</span>
               </div>
               <div class="muted" style="font-size:0.84rem;margin-top:0.2rem">משלמים עכשיו (אשראי או צילום צ׳ק) — ההזמנה מאושרת מיד ויוצאת למשלוח בעדיפות</div>
               <div style="color:var(--ok);font-weight:700;font-size:0.88rem;margin-top:0.2rem">הנחת ${fastOffer.discountPct}% — חיסכון של ${formatMoney(fastOffer.saving)}</div>
             </div>
             <div class="track-opt" data-track="regular" style="border:2px solid var(--border);border-radius:12px;padding:0.7rem 0.8rem;cursor:pointer;margin-top:0.5rem">
               <div style="display:flex;justify-content:space-between;align-items:center">
                 <span style="font-weight:700">מסלול רגיל</span>
                 <span style="font-weight:700">${formatMoney(preview!.payable)}</span>
               </div>
               <div class="muted" style="font-size:0.84rem;margin-top:0.2rem">תשלום לפי תנאי התשלום הקיימים שלכם — אספקה רגילה</div>
             </div>
             <div class="muted" style="font-size:0.75rem;margin-top:0.4rem">המחירים כוללים מע״מ</div>
           </div>`
        : ''
    }
```

- [ ] **Step 4: Show the payment picker for fast track too** — change the payment-method card's guard from `payNow ? ... : ''` to render for `payNow || fastOffer`, give it an id + initial visibility, and adapt the copy and amounts. Replace the block's opening with:

```ts
    ${
      payNow || fastOffer
        ? `<div class="card" id="pay-methods" style="${payNow || fastSelected ? '' : 'display:none'}">
             <div style="font-weight:700;margin-bottom:0.35rem">אמצעי תשלום</div>
             <p class="muted" style="font-size:0.82rem;margin:0 0 0.6rem">${
               payNow
                 ? 'לקוחות מזומן משלמים בעת ההזמנה — ההזמנה תישלח מיד עם אישור התשלום.'
                 : 'התשלום מאשר את ההזמנה מיד ושולח אותה בעדיפות.'
             }</p>
```

and inside it replace the saved-card button's amount `${formatMoney(preview!.payable)}` with `${formatMoney(fastOffer ? fastOffer.payable : preview!.payable)}`. The rest of the card (method buttons, save-card checkbox, installments note) stays as-is. (`payNow` and `fastOffer` never coexist — the server nulls the offer for cash-forced customers — so the amount is unambiguous.)

- [ ] **Step 5: Submit button initial text** — replace the submit button template (line 241-243) with:

```ts
    <button id="submit" style="width:100%;padding:0.9rem;font-size:1.05rem;font-weight:700;margin-top:0.25rem">${
      fastOffer ? `שלח ושלם ${formatMoney(fastOffer.payable)} ←` : payNow ? `שלח ושלם ${formatMoney(preview!.payable)} ←` : 'שלח הזמנה'
    }</button>
```

- [ ] **Step 6: Track toggle handler** — after the `submitBtn` / `note` / `msg` consts (line 270-272), add:

```ts
  if (fastOffer) {
    const payCard = shell.querySelector('#pay-methods') as HTMLElement | null;
    shell.querySelectorAll<HTMLElement>('.track-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        fastSelected = opt.dataset.track === 'fast';
        shell.querySelectorAll<HTMLElement>('.track-opt').forEach((o) => {
          const on = o === opt;
          o.style.borderColor = on ? 'var(--brand)' : 'var(--border)';
          o.style.background = on ? 'rgba(37,99,235,0.05)' : '';
        });
        if (payCard) payCard.style.display = fastSelected ? '' : 'none';
        submitBtn.textContent = fastSelected ? `שלח ושלם ${formatMoney(fastOffer.payable)} ←` : 'שלח הזמנה';
      });
    });
  }
```

- [ ] **Step 7: Send the track and route the payment** — in the submit click handler:

Change the POST (line 285) to:

```ts
      const payingNow = payNow || (!!fastOffer && fastSelected);
      const result = await api.post<{ ordname: string; orderId: number; needsPayment?: boolean; amount?: number }>('/api/orders', {
        details,
        track: fastOffer && fastSelected ? 'fast' : 'regular',
      });
```

Then inside the `if (result.needsPayment)` branch, replace the three `payNow &&` guards with `payingNow &&`:

```ts
        if (payingNow && payMethod === 'saved') {
```
```ts
        if (payingNow && payMethod === 'card') {
```
```ts
        if (payingNow && payMethod === 'check') {
```

(The final `location.hash = '#order-pay/' + result.orderId;` fallback stays — it covers any edge where a hold was created without a picker.)

- [ ] **Step 8: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/pages/checkout.ts
git commit -m "feat(fast-track): checkout track selector — prepaid fast lane vs regular terms"
```

---

### Task 7: End-to-end verification + deploy

**Files:** none (verification + deploy).

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run build && rm -rf /tmp/ft-e2e && mkdir -p /tmp/ft-e2e && DATA_DIR=/tmp/ft-e2e node scripts/test-fast-track.mjs && DATA_DIR=/tmp/ft-e2e node scripts/test-payment-policy.mjs`
Expected: everything green.

- [ ] **Step 2: Manual flow check (local `npm run dev`)** — verify each item:

1. Flag OFF (default): checkout shows NO track selector; orders submit exactly as before (inert deploy confirmed).
2. Admin → הגדרות: flip "מסלול מהיר (תשלום מראש)" ON (typed confirm) and confirm the % input saves.
3. Checkout as a test customer: selector renders, fast pre-selected, both VAT-inclusive amounts shown, saving line correct (payable × 0.97-ish).
4. Toggle to מסלול רגיל: payment picker hides, button reverts to "שלח הזמנה"; submit → normal Priority order, `orders_local.fast_track = 0`, no discount note in DETAILS.
5. Toggle to fast, submit with 📸 צ׳ק: order lands as `pending_payment` with `payment_required_amount` = discounted payable and `fast_track = 1`; pay with a non-post-dated cheque draft → order approved, sent to Priority, and the ORDERS `DETAILS` carries "מסלול מהיר 🚀 … נא ליישם את ההנחה בחשבונית — למשלוח בעדיפות".
6. Card path: "שלח ושלם" → PayPlus page shows the DISCOUNTED amount (stop before charging a real card; the amount on the hosted page is the check).
7. Customers board → a company card: untick "מסלול מהיר מוצע ללקוח", save; that customer's checkout no longer shows the selector; re-tick restores it.
8. Cash-forced test customer (policy kind=cash, enforced): NO selector (server nulls the offer), existing full-price pay-now flow unchanged.
9. Debt-blocked test customer: NO selector, block message unchanged.
10. Flip the flag OFF again and confirm checkout instantly reverts (leave OFF for deploy).

- [ ] **Step 3: Deploy** — merge/push to `main` (Railway auto-deploys). The feature ships inert (`fast_track_enabled` default false); activation is a later admin action, ideally after the messaging sequence to customers (human first, app second).

```bash
git push origin main
```

- [ ] **Step 4: Post-deploy smoke** — on prod with the flag still OFF: load checkout as a real customer login and confirm no selector and a normal order submits.

---

## Explicitly out of scope (YAGNI, noted for later)

- Earn-back / terms-restoration progress UI (relevant to scenario (a) downgrades, not this blanket offer).
- A dedicated Priority UDF for shipping priority — the `DETAILS` note is the office signal for now.
- Fast-track badge on the admin orders/dashboard rail (the office sees the note in Priority; add locally only if reconciliation demands it).
- Automatic invoice-side discount — the office applies the % per the note, matching how percent promos already work.
