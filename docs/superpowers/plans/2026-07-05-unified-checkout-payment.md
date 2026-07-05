# Unified Checkout + Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One consistent VAT-inclusive total from cart to payment, and payment folded into the checkout screen for cash-policy customers — all behind a `unified_checkout_enabled` flag (default off) for instant rollback.

**Architecture:** All server changes are additive (new read-only preview endpoint, new response fields on `/api/cart`, `/api/home`, `/api/payments/card/:id`). The Priority pipeline — order payload, cash-hold, `approveOrder`→`sendHeldOrderToPriority`, receipts, BOOKNUM idempotency — is untouched. Client pages branch on the flag; flag off renders today's flow exactly (with one deliberate exception: the checkout promo-total display bugfix, Task 4).

**Tech Stack:** Express + better-sqlite3 (server, ESM, `.js` import suffixes), vanilla TS hash-router SPA (client), no test framework — repo convention is standalone assert scripts in `scripts/` run with `node` against `dist/` (see `scripts/test-payment-policy.mjs`).

**Spec:** `docs/superpowers/specs/2026-07-05-unified-checkout-payment-design.md`

## Global Constraints

- Priority side untouched: no edits to `createOrder` payload logic, cash-hold gating, `approveOrder`, receipts, sweeps, or `server/paymentPolicy.ts` decision logic (spec §2.1).
- Flag `unified_checkout_enabled`, default `false`. Everything user-visible except Task 4 is gated on it (spec §2.2).
- VAT source of truth is `server/money.ts` only; the client never hardcodes 0.18 — it uses `vatRate` from API responses.
- All new server fields/endpoints are additive; no schema migrations.
- Hebrew UI copy exactly as written in each task (RTL app).
- After each task: `npm run typecheck` must pass.
- Never test against production; local dev only (`npm run dev`, client on :5175). Local DB (`data/app.db`) test rows must be cleaned up after manual QA (Task 9 includes the recipe).

---

### Task 1: Server — VAT breakdown helper + `unified_checkout_enabled` flag registration

**Files:**
- Modify: `server/money.ts` (8 lines today — add one function)
- Modify: `server/index.ts:1345-1364` (SETTABLE + BOOL_SETTINGS)
- Test: `scripts/test-checkout-preview.mjs` (new)

**Interfaces:**
- Consumes: `VAT_RATE`, `withVat` (existing in `server/money.ts`)
- Produces: `vatBreakdown(preVat: number): { vatRate: number; vatAmount: number; payable: number }` — used by Task 2's preview builder. `payable === withVat(preVat)` and `preVat + vatAmount === payable` exactly (rounding-safe).

- [ ] **Step 1: Write the failing test**

Create `scripts/test-checkout-preview.mjs`:

```js
// Unit checks for the checkout-preview math. Run: npm run build && node scripts/test-checkout-preview.mjs
import assert from 'node:assert/strict';
import { vatBreakdown, withVat } from '../dist/server/money.js';

// The walkthrough numbers: 513.60 pre-VAT → 606.05 payable, 92.45 VAT.
assert.deepEqual(vatBreakdown(513.6), { vatRate: 0.18, vatAmount: 92.45, payable: 606.05 });
// Components must sum exactly (display rows must reconcile).
for (const v of [0, 0.01, 99.99, 513.6, 1234.56]) {
  const b = vatBreakdown(v);
  assert.equal(Math.round((v + b.vatAmount) * 100) / 100, b.payable, `sum mismatch for ${v}`);
  assert.equal(b.payable, withVat(v), `withVat mismatch for ${v}`);
}
assert.deepEqual(vatBreakdown(0), { vatRate: 0.18, vatAmount: 0, payable: 0 });
console.log('vatBreakdown: ALL PASS');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node scripts/test-checkout-preview.mjs`
Expected: FAIL — `SyntaxError: The requested module ... does not provide an export named 'vatBreakdown'`

- [ ] **Step 3: Implement `vatBreakdown` in `server/money.ts`**

Append to `server/money.ts`:

```ts
/** Display breakdown for a pre-VAT total. vatAmount is derived as payable − preVat
 *  (not preVat × rate) so the three numbers always sum exactly after rounding. */
export function vatBreakdown(preVat: number): { vatRate: number; vatAmount: number; payable: number } {
  const payable = withVat(preVat);
  return { vatRate: VAT_RATE, vatAmount: round2(payable - preVat), payable };
}
```

- [ ] **Step 4: Register the flag in the admin-settings whitelist**

In `server/index.ts`, add `'unified_checkout_enabled'` to BOTH sets:

In the `SETTABLE` set (after `'discount_pricing_enabled',` at line ~1362):

```ts
  'discount_pricing_enabled',
  'unified_checkout_enabled',
]);
```

In `BOOL_SETTINGS` (line ~1364), append to the array literal:

```ts
const BOOL_SETTINGS = new Set(['payments_enabled', 'check_payment_enabled', 'maintenance_enabled', 'announcement_enabled', 'payment_policy_enabled', 'priority_receipts_enabled', 'discount_pricing_enabled', 'unified_checkout_enabled']);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node scripts/test-checkout-preview.mjs`
Expected: `vatBreakdown: ALL PASS`

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add server/money.ts server/index.ts scripts/test-checkout-preview.mjs
git commit -m "feat(server): vatBreakdown helper + unified_checkout_enabled flag registration"
```

---

### Task 2: Server — `GET /api/checkout/preview` + additive fields on `/api/cart` and `/api/home`

**Files:**
- Create: `server/checkoutPreview.ts`
- Modify: `server/index.ts:661-663` (`GET /api/cart` route) and near it, add the preview route
- Modify: `server/home.ts` (add `pendingPaymentOrder` + `features.unifiedCheckout`)
- Test: extend `scripts/test-checkout-preview.mjs`

**Interfaces:**
- Consumes: `getCart(userId, custname): CartResult` (`server/orders.ts:35`, returns `{ lines, total, promotions: PromoResult }` where `PromoResult = { subtotal, discount, total, applied, gifts, freebies, giftProgress }`); `enforcedFor(custname)`, `evaluate(custname, cartTotal)` (`server/paymentPolicy.ts` — read-only, do not modify); `vatBreakdown` (Task 1); `getSettingBool` (`server/db.ts`).
- Produces:
  - `buildCheckoutPreview(userId: number, custname: string): Promise<CheckoutPreview>` where `CheckoutPreview = { enabled: boolean; subtotal: number; discount: number; total: number; vatRate: number; vatAmount: number; payable: number; requiresPayment: boolean; kind: 'cash' | 'net' | null; blocked: boolean; blockedReason: 'open_debt' | null }`
  - `GET /api/checkout/preview` → `CheckoutPreview` (consumed by Task 6)
  - `GET /api/cart` response gains `vatRate: number` and `unifiedCheckout: boolean` (consumed by Task 5)
  - `GET /api/home` response gains `features.unifiedCheckout: boolean` and `pendingPaymentOrder: { id: number; amount: number; createdAt: string } | null` (consumed by Task 8)

- [ ] **Step 1: Create `server/checkoutPreview.ts`**

```ts
// Read-only checkout preview: the amounts + policy outcome the checkout screen
// shows BEFORE submit. Display-only — POST /api/orders re-evaluates the policy at
// submit time and remains the single source of truth (spec §3.1). No writes here.
import { getCart } from './orders.js';
import { enforcedFor, evaluate } from './paymentPolicy.js';
import { vatBreakdown } from './money.js';
import { getSettingBool } from './db.js';

export interface CheckoutPreview {
  enabled: boolean; // unified_checkout_enabled flag — client renders new UI only when true
  subtotal: number; // pre-discount, pre-VAT
  discount: number; // promo savings
  total: number;    // promotions.total (pre-VAT) — what the order records
  vatRate: number;
  vatAmount: number;
  payable: number;  // withVat(total) — what a cash customer pays now
  requiresPayment: boolean;
  kind: 'cash' | 'net' | null; // null when policy not enforced for this customer
  blocked: boolean; // net-terms open-debt block (mirrors decide())
  blockedReason: 'open_debt' | null;
}

export async function buildCheckoutPreview(userId: number, custname: string): Promise<CheckoutPreview> {
  const { promotions } = getCart(userId, custname);
  const base = {
    enabled: getSettingBool('unified_checkout_enabled', false),
    subtotal: promotions.subtotal,
    discount: promotions.discount,
    total: promotions.total,
    ...vatBreakdown(promotions.total),
  };
  if (!enforcedFor(custname)) {
    return { ...base, requiresPayment: false, kind: null, blocked: false, blockedReason: null };
  }
  const d = await evaluate(custname, promotions.total);
  return {
    ...base,
    requiresPayment: d.requiresPayment,
    kind: d.kind,
    blocked: !d.allowOrder,
    blockedReason: d.reason === 'open_debt' ? 'open_debt' : null,
  };
}
```

- [ ] **Step 2: Wire the route and extend `/api/cart`**

In `server/index.ts`, import at the top (with the other server imports):

```ts
import { buildCheckoutPreview } from './checkoutPreview.js';
import { VAT_RATE } from './money.js'; // if not already imported
```

Replace the `GET /api/cart` handler body (line ~661) — additive fields only:

```ts
app.get('/api/cart', requireCustomer, (req: AuthedRequest, res) => {
  res.json({
    ...getCart(req.user!.id, req.user!.custname!),
    vatRate: VAT_RATE,
    unifiedCheckout: getSettingBool('unified_checkout_enabled', false),
  });
});
```

Note: `PUT /api/cart/lines/:partname` (line ~686) also returns `getCart(...)` — the cart page re-fetches via GET after mutations (`load()` calls `api.get('/api/cart')`), so the PUT response does NOT need the new fields. Leave it unchanged.

Add the preview route directly below the cart routes:

```ts
// Read-only checkout preview (unified checkout). Safe to call regardless of the
// flag; `enabled` tells the client which UI to render.
app.get('/api/checkout/preview', requireCustomer, ah(async (req: AuthedRequest, res) => {
  res.json(await buildCheckoutPreview(req.user!.id, req.user!.custname!));
}));
```

(`ah` is the existing async-handler wrapper used throughout `server/index.ts`.)

- [ ] **Step 3: Extend `/api/home` in `server/home.ts`**

Inside the home builder (the function returning at line ~122), add a query next to the existing `lastRow` query (which selects the last `submitted` order around line ~97):

```ts
  // Newest order still awaiting payment (unified checkout: home resume banner).
  const pendingRow = db
    .prepare(
      `SELECT id, payment_required_amount, created_at FROM orders_local
       WHERE user_id = ? AND status = 'pending_payment'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId) as { id: number; payment_required_amount: number | null; created_at: string } | undefined;
```

In the returned object: inside `features` add

```ts
      unifiedCheckout: getSettingBool('unified_checkout_enabled', false),
```

and as a new top-level field (next to `paymentPolicy`):

```ts
    pendingPaymentOrder: pendingRow
      ? { id: pendingRow.id, amount: pendingRow.payment_required_amount ?? 0, createdAt: pendingRow.created_at }
      : null,
```

- [ ] **Step 4: Extend the test script with an integration check of the pure assembly**

Append to `scripts/test-checkout-preview.mjs` (the repo's test scripts hit the built `dist/` and a scratch `DATA_DIR` — same pattern as `scripts/test-payment-policy.mjs`):

```js
// buildCheckoutPreview shape check against a scratch DB: no policy row → policy
// not enforced → requiresPayment=false, kind=null, but VAT math still present.
// (Full cash-path evaluation needs Priority finance and is covered by manual QA.)
import { buildCheckoutPreview } from '../dist/server/checkoutPreview.js';
const preview = await buildCheckoutPreview(999999, 'NO-SUCH-CUSTOMER');
assert.equal(preview.requiresPayment, false);
assert.equal(preview.kind, null);
assert.equal(preview.blocked, false);
assert.equal(preview.total, 0); // empty cart for unknown user
assert.equal(preview.payable, 0);
assert.equal(preview.vatRate, 0.18);
assert.equal(typeof preview.enabled, 'boolean');
console.log('buildCheckoutPreview (unenforced/empty): ALL PASS');
```

Run with a scratch data dir so the import of `db.js` never touches the real local DB:

```bash
mkdir -p /tmp/ucp-test-data && DATA_DIR=/tmp/ucp-test-data node scripts/test-checkout-preview.mjs
```

- [ ] **Step 5: Build + run tests**

Run: `npm run build && DATA_DIR=/tmp/ucp-test-data node scripts/test-checkout-preview.mjs`
Expected: both `ALL PASS` lines.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add server/checkoutPreview.ts server/index.ts server/home.ts scripts/test-checkout-preview.mjs
git commit -m "feat(server): checkout preview endpoint + additive cart/home fields (flag-gated display data)"
```

---

### Task 3: Server — order-aware card-payment status

**Files:**
- Modify: `server/index.ts:1106-1117` (`GET /api/payments/card/:id`)

**Interfaces:**
- Consumes: `getCardForUser` returns `CardRow` with `kind: string` and `order_id: string | null` (`server/cardPayments.ts:15-26`); `db` (already imported in `server/index.ts`).
- Produces: `GET /api/payments/card/:id` response gains `orderId: number | null` and `ordname: string | null` (populated only for `kind === 'order_payment'`). Consumed by Task 7's success page.

- [ ] **Step 1: Extend the response**

Replace the final `res.json(...)` of the handler (line ~1116) with:

```ts
  // Unified checkout: order-payment polls need to know WHICH order was settled so
  // the success page can say "ההזמנה אושרה" instead of a generic payment message.
  let orderId: number | null = null;
  let ordname: string | null = null;
  if (row.kind === 'order_payment' && row.order_id) {
    orderId = Number(row.order_id);
    const o = db.prepare('SELECT priority_ordname FROM orders_local WHERE id = ?').get(orderId) as
      | { priority_ordname: string | null }
      | undefined;
    ordname = o?.priority_ordname ?? null; // null until Priority send completes — success copy must not depend on it
  }
  res.json({ id: row.id, status: row.status, amount: row.amount, confirmationCode: row.confirmation_code, fourDigits: row.four_digits, provider: row.provider, orderId, ordname });
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Manual smoke (existing behavior unchanged)**

Run: `npm run dev` in background; then with any authenticated session, `GET /api/payments/card/<nonexistent>` still 404s and debt payments return `orderId: null`. (Full verification is Task 9's QA walkthrough.) Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "feat(server): card status poll returns orderId/ordname for order payments"
```

---

### Task 4: Client — checkout promo-total bugfix (NOT flag-gated, deliberate)

**Files:**
- Modify: `src/pages/checkout.ts`

**Interfaces:**
- Consumes: `GET /api/cart` → `promotions: { subtotal, discount, total, applied: {name, savings}[], ... }` (already returned by the server today; the client interface just never declared it).
- Produces: checkout displays `promotions.total` — the number the order actually records. Task 6 builds on this same interface.

Today checkout shows `cart.total` (pre-discount ₪542.40) while the cart page and the recorded order use the promo total (₪513.60). This is a display bug in the CURRENT flow, fixed regardless of flag (spec §2.2, §3.4).

- [ ] **Step 1: Declare promotions on the checkout cart interface**

In `src/pages/checkout.ts`, replace the `CartResp` interface (line ~15):

```ts
interface CartPromotions {
  subtotal: number;
  discount: number;
  total: number;
  applied: { id: number; name: string; type: string; savings: number }[];
}
interface CartResp {
  lines: CartLine[];
  total: number;
  promotions?: CartPromotions;
  vatRate?: number;
  unifiedCheckout?: boolean;
}
```

- [ ] **Step 2: Render promo rows and the promo total**

In the summary card template (line ~102-120), replace the final total block:

```ts
      ${home?.features?.discountPricing ? '<p class="muted" style="font-size:0.78rem;margin:0.2rem 0 0.5rem">המחירים כוללים את ההנחה הקבועה שלך.</p>' : ''}
      <div style="display:flex;justify-content:space-between;margin-top:0.75rem;font-weight:900;font-size:1.2rem">
        <span>סה״כ</span><span style="color:var(--brand)">${formatMoney(cart.total)}</span>
      </div>
```

with:

```ts
      ${home?.features?.discountPricing ? '<p class="muted" style="font-size:0.78rem;margin:0.2rem 0 0.5rem">המחירים כוללים את ההנחה הקבועה שלך.</p>' : ''}
      ${(cart.promotions?.applied || [])
        .filter((a) => a.savings > 0)
        .map(
          (a) => `<div style="display:flex;justify-content:space-between;margin-top:0.4rem;color:var(--ok);font-size:0.9rem">
            <span>🏷️ ${escapeHtml(a.name)}</span><span dir="ltr">−${formatMoney(a.savings)}</span></div>`
        )
        .join('')}
      <div style="display:flex;justify-content:space-between;margin-top:0.75rem;font-weight:900;font-size:1.2rem">
        <span>סה״כ</span><span style="color:var(--brand)">${formatMoney(cart.promotions?.total ?? cart.total)}</span>
      </div>
```

- [ ] **Step 3: Verify in the browser**

Run `npm run dev`. Create a throwaway customer login: `node scripts/make-test-user.mjs qa-ucp qa-ucp-pass 10184` (upserts; cleanup in Task 9). Log in at `http://localhost:5175`, add a promo-eligible product (MX03 — 15% off) to the cart, open `#checkout`.
Expected: checkout shows the promo discount row and the same total the cart page shows (e.g. cart `לסיום הזמנה · ₪X` == checkout `סה״כ ₪X`). Empty the cart afterwards.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/pages/checkout.ts
git commit -m "fix(checkout): show promotions total — checkout displayed pre-discount total while the order records the promo total"
```

---

### Task 5: Client — cart VAT rows (flag on)

**Files:**
- Modify: `src/pages/cart.ts`

**Interfaces:**
- Consumes: `GET /api/cart` → `vatRate: number`, `unifiedCheckout: boolean` (Task 2).
- Produces: with the flag on, the cart summary bar ends with a VAT row and a VAT-inclusive **לתשלום** total; the CTA carries that same number. Flag off → pixel-identical to today.

- [ ] **Step 1: Extend `CartResp` and compute the payable**

In `src/pages/cart.ts`, extend the interface (line ~24):

```ts
interface CartResp {
  lines: CartLine[];
  total: number;
  promotions?: Promotions;
  vatRate?: number;
  unifiedCheckout?: boolean;
}
```

In `load()` after `finalTotal` is computed (line ~63), add:

```ts
  // Unified checkout: one honest number from here to the payment page. The VAT
  // formula mirrors server money.ts withVat exactly (round-half-up to 2dp).
  const unified = !!cart.unifiedCheckout && typeof cart.vatRate === 'number';
  const vatRate = cart.vatRate ?? 0;
  const payable = Math.round(finalTotal * (1 + vatRate) * 100) / 100;
  const vatAmount = Math.round((payable - finalTotal) * 100) / 100;
```

- [ ] **Step 2: Render the rows and retarget the CTA**

In the summary-bar template (line ~100-120), replace:

```ts
      <div class="cart-summary-total"><b>סה״כ לתשלום</b><b>${formatMoney(finalTotal)}</b></div>
      <button id="checkout" class="cart-summary-cta" ${hasUnavailable ? 'disabled' : ''}>לסיום הזמנה · ${formatMoney(finalTotal)} ←</button>
```

with:

```ts
      ${
        unified
          ? `<div class="cart-summary-row"><span>סה״כ לפני מע״מ</span><span>${formatMoney(finalTotal)}</span></div>
             <div class="cart-summary-row"><span>מע״מ ${Math.round(vatRate * 100)}%</span><span>${formatMoney(vatAmount)}</span></div>
             <div class="cart-summary-total"><b>סה״כ לתשלום כולל מע״מ</b><b>${formatMoney(payable)}</b></div>`
          : `<div class="cart-summary-total"><b>סה״כ לתשלום</b><b>${formatMoney(finalTotal)}</b></div>`
      }
      <button id="checkout" class="cart-summary-cta" ${hasUnavailable ? 'disabled' : ''}>לסיום הזמנה · ${formatMoney(unified ? payable : finalTotal)} ←</button>
```

- [ ] **Step 3: Verify both flag states in the browser**

With `npm run dev` running and items in the qa-ucp cart:
- Flag off (default): cart summary identical to before (no VAT rows).
- Enable: `sqlite3 data/app.db "INSERT INTO settings (key,value) VALUES ('unified_checkout_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true'"` → reload cart.
Expected with flag on: `סה״כ לפני מע״מ`, `מע״מ 18%`, bold `סה״כ לתשלום כולל מע״מ`, CTA shows the VAT-inclusive figure; the three numbers sum exactly.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/pages/cart.ts
git commit -m "feat(cart): VAT breakdown + VAT-inclusive payable total (unified_checkout_enabled)"
```

---

### Task 6: Client — checkout payment section + merged submit (flag on)

**Files:**
- Modify: `src/pages/checkout.ts`

**Interfaces:**
- Consumes: `GET /api/checkout/preview` → `CheckoutPreview` (Task 2); existing `POST /api/orders` → `{ ordname, orderId, needsPayment?, amount? }`; existing `POST /api/orders/:id/pay/card` → `{ url }`; routes `#pay-check/:id` and `#order-pay/:id` (unchanged).
- Produces: flag-on cash customers see breakdown + method picker + `שלח ושלם` CTA; card → PSP redirect, cheque → scanner, any pay-step failure → `#order-pay/:id` (interstitial as recovery). Flag off / non-payment customers: exact current behavior.

- [ ] **Step 1: Fetch the preview alongside cart+home**

In `renderCheckout` (line ~49), extend the parallel fetch:

```ts
  let cart: CartResp;
  let home: HomeData | null = null;
  let preview: CheckoutPreview | null = null;
  try {
    [cart, home, preview] = await Promise.all([
      api.get<CartResp>('/api/cart'),
      api.get<HomeData>('/api/home').catch(() => null),
      api.get<CheckoutPreview>('/api/checkout/preview').catch(() => null),
    ]);
  } catch (ex) {
```

Add the interface next to `CartResp`:

```ts
interface CheckoutPreview {
  enabled: boolean;
  subtotal: number;
  discount: number;
  total: number;
  vatRate: number;
  vatAmount: number;
  payable: number;
  requiresPayment: boolean;
  kind: 'cash' | 'net' | null;
  blocked: boolean;
  blockedReason: 'open_debt' | null;
}
```

And derive the mode flags after the empty/unavailable-cart guards:

```ts
  const unified = !!preview?.enabled;
  const payNow = unified && !!preview!.requiresPayment;
```

- [ ] **Step 2: Render the unified breakdown (replaces Task 4's total block when flag on)**

Where Task 4 rendered the promo rows + `סה״כ`, branch on `unified` (keep Task 4's markup as the `else`):

```ts
      ${
        unified
          ? `${preview!.discount > 0 ? `<div style="display:flex;justify-content:space-between;margin-top:0.4rem;font-size:0.9rem"><span>סכום ביניים</span><span>${formatMoney(preview!.subtotal)}</span></div>` : ''}
             ${(cart.promotions?.applied || [])
               .filter((a) => a.savings > 0)
               .map((a) => `<div style="display:flex;justify-content:space-between;margin-top:0.3rem;color:var(--ok);font-size:0.9rem"><span>🏷️ ${escapeHtml(a.name)}</span><span dir="ltr">−${formatMoney(a.savings)}</span></div>`)
               .join('')}
             <div style="display:flex;justify-content:space-between;margin-top:0.4rem;font-size:0.9rem"><span>מע״מ ${Math.round(preview!.vatRate * 100)}%</span><span>${formatMoney(preview!.vatAmount)}</span></div>
             <div style="display:flex;justify-content:space-between;margin-top:0.6rem;font-weight:900;font-size:1.2rem"><span>לתשלום</span><span style="color:var(--brand)">${formatMoney(preview!.payable)}</span></div>`
          : `${(cart.promotions?.applied || [])
               .filter((a) => a.savings > 0)
               .map(
                 (a) => `<div style="display:flex;justify-content:space-between;margin-top:0.4rem;color:var(--ok);font-size:0.9rem">
                   <span>🏷️ ${escapeHtml(a.name)}</span><span dir="ltr">−${formatMoney(a.savings)}</span></div>`
               )
               .join('')}
             <div style="display:flex;justify-content:space-between;margin-top:0.75rem;font-weight:900;font-size:1.2rem">
               <span>סה״כ</span><span style="color:var(--brand)">${formatMoney(cart.promotions?.total ?? cart.total)}</span>
             </div>`
      }
```

(The else branch is exactly Task 4's markup, so flag-off renders are unchanged by this task.)

- [ ] **Step 3: Render the payment-method section and CTA**

After the note card and before the submit button (line ~137-142), insert:

```ts
    ${
      payNow
        ? `<div class="card">
             <div style="font-weight:700;margin-bottom:0.35rem">אמצעי תשלום</div>
             <p class="muted" style="font-size:0.82rem;margin:0 0 0.6rem">לקוחות מזומן משלמים בעת ההזמנה — ההזמנה תישלח מיד עם אישור התשלום.</p>
             <div style="display:flex;gap:0.5rem">
               <button type="button" class="pay-method sel" data-method="card" style="flex:1;padding:0.7rem;font-weight:700;border:2px solid var(--brand);border-radius:10px;background:var(--brand);color:#fff">💳 אשראי</button>
               <button type="button" class="pay-method" data-method="check" style="flex:1;padding:0.7rem;font-weight:700;border:2px solid var(--border);border-radius:10px;background:#fff">📸 צ׳ק</button>
             </div>
           </div>`
        : ''
    }
```

Change the submit button label:

```ts
    <button id="submit" style="width:100%;padding:0.9rem;font-size:1.05rem;font-weight:700;margin-top:0.25rem">${
      payNow ? `שלח ושלם ${formatMoney(preview!.payable)} ←` : 'שלח הזמנה'
    }</button>
```

Wire the picker after the date-chip wiring:

```ts
  let payMethod: 'card' | 'check' = 'card';
  shell.querySelectorAll<HTMLButtonElement>('.pay-method').forEach((btn) => {
    btn.addEventListener('click', () => {
      shell.querySelectorAll<HTMLButtonElement>('.pay-method').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('sel', on);
        b.style.background = on ? 'var(--brand)' : '#fff';
        b.style.color = on ? '#fff' : 'inherit';
        b.style.borderColor = on ? 'var(--brand)' : 'var(--border)';
      });
      payMethod = (btn.dataset.method as 'card' | 'check') || 'card';
    });
  });
```

- [ ] **Step 4: Merge the submit handler**

Inside the existing `submitBtn` click handler, replace the single line

```ts
      if (result.needsPayment) { location.hash = '#order-pay/' + result.orderId; return; }
```

with:

```ts
      if (result.needsPayment) {
        // Unified flow: continue straight into the chosen payment. Any failure in
        // the pay step falls back to the interstitial (#order-pay) — the order is
        // already safely recorded as pending_payment; nothing is lost.
        if (unified && payMethod === 'card') {
          msg.textContent = 'מעביר לעמוד תשלום מאובטח…';
          try {
            const r = await api.post<{ url: string }>(`/api/orders/${result.orderId}/pay/card`, {});
            window.location.href = r.url;
          } catch {
            location.hash = '#order-pay/' + result.orderId;
          }
          return;
        }
        if (unified && payMethod === 'check') {
          location.hash = '#pay-check/' + result.orderId;
          return;
        }
        location.hash = '#order-pay/' + result.orderId;
        return;
      }
```

Also honor the preview's debt block for consistency (spec §3.3): extend the existing disable (line ~159) to

```ts
  if (home?.paymentPolicy?.blocksOnDebt || preview?.blocked) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'סגור חוב כדי להזמין';
  }
```

- [ ] **Step 5: Verify in the browser (flag on, cash policy)**

Local-only setup (all reverted in Task 9):

```bash
sqlite3 data/app.db "
INSERT INTO settings (key,value) VALUES ('unified_checkout_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true';
INSERT INTO settings (key,value) VALUES ('payment_policy_enabled','true') ON CONFLICT(key) DO UPDATE SET value='true';
INSERT INTO customer_policies (custname, kind, enforced) VALUES ('10184','cash',1) ON CONFLICT(custname) DO UPDATE SET kind='cash', enforced=1;"
```

As qa-ucp with items in cart, open `#checkout`.
Expected: breakdown ends in `לתשלום ₪X` where X matches the cart's VAT-inclusive figure exactly; method picker with אשראי pre-selected; CTA `שלח ושלם ₪X ←`. Choose צ׳ק → submit → lands on `#pay-check/<id>` showing the same ₪X. **Do NOT click the card path** unless PayPlus test config exists locally (card submit creates a real PSP page). Then check `#orders` — the held order shows `ממתין לתשלום`. Delete the held order:

```bash
sqlite3 data/app.db "DELETE FROM order_lines WHERE order_id IN (SELECT id FROM orders_local WHERE status='pending_payment' AND user_id=(SELECT id FROM users WHERE username='qa-ucp')); DELETE FROM orders_local WHERE status='pending_payment' AND user_id=(SELECT id FROM users WHERE username='qa-ucp');"
```

Also verify flag-off regression: set `unified_checkout_enabled` to `false`, reload checkout → today's UI (Task 4 total, plain `שלח הזמנה`), and submit for a cash customer still lands on `#order-pay/:id`. Re-enable the flag for the remaining tasks.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/pages/checkout.ts
git commit -m "feat(checkout): unified breakdown + pay-method picker + merged submit→pay (unified_checkout_enabled)"
```

---

### Task 7: Client — order-aware payment success + interstitial polish

**Files:**
- Modify: `src/pages/payCard.ts:150-183` (`renderPayCardReturn`)
- Modify: `src/pages/orderPay.ts`

**Interfaces:**
- Consumes: `GET /api/payments/card/:id` → now includes `orderId: number | null`, `ordname: string | null` (Task 3).
- Produces: order payments land on "ההזמנה אושרה ותישלח" with the order number; failures link back to `#order-pay/:orderId`. Debt payments (orderId null) keep today's copy exactly.

- [ ] **Step 1: Extend the poll response type and success/failure branches**

In `renderPayCardReturn`, change the poll's type parameter and branches:

```ts
      const r = await api.get<{ status: string; amount: number; confirmationCode: string | null; orderId?: number | null; ordname?: string | null }>(`/api/payments/card/${encodeURIComponent(id)}`);
      if (r.status === 'paid') {
        const forOrder = r.orderId != null;
        shell.innerHTML = forOrder
          ? `
          <div class="empty-state">
            <div class="es-icon">✅</div>
            <div class="es-title">התשלום בוצע — ההזמנה אושרה ותישלח</div>
            <div class="es-sub">שולם ₪${(r.amount || 0).toFixed(2)} בכרטיס אשראי.${r.ordname ? `<br/>מספר הזמנה: <b>${escapeHtml(r.ordname)}</b>` : `<br/>מספר הזמנה מקומי: <b>${r.orderId}</b>`}${r.confirmationCode ? `<br/>אישור: ${escapeHtml(r.confirmationCode)}` : ''}</div>
            <a class="es-cta" href="#orders">להזמנות שלי</a>
          </div>`
          : `
          <div class="empty-state">
            <div class="es-icon">✅</div>
            <div class="es-title">התשלום בוצע</div>
            <div class="es-sub">שולם ₪${(r.amount || 0).toFixed(2)} בכרטיס אשראי.${r.confirmationCode ? `<br/>אישור: ${escapeHtml(r.confirmationCode)}` : ''}</div>
            <a class="es-cta" href="#home">חזרה לדף הבית</a>
          </div>`;
        return;
      }
      if (r.status === 'failed' || r.status === 'expired') {
        const retry = r.orderId != null ? `#order-pay/${r.orderId}` : '#pay/card';
        shell.innerHTML = `<div class="card error" style="text-align:center"><div class="es-icon">⚠️</div><div class="es-title">התשלום לא הושלם</div><div style="margin-top:0.75rem"><a href="${retry}">נסו שוב</a> · <a href="#home">דף הבית</a></div></div>`;
        return;
      }
```

- [ ] **Step 2: Interstitial: amount on the cheque button**

In `src/pages/orderPay.ts` (line ~22), change:

```ts
        <button id="pay-check" class="es-cta" style="margin-top:0.6rem;background:var(--ok)">שלם בצ׳ק</button>
```

to:

```ts
        <button id="pay-check" class="es-cta" style="margin-top:0.6rem;background:var(--ok)">שלם בצ׳ק ₪${amt}</button>
```

- [ ] **Step 3: Verify**

Flag on: re-create a held order via the cheque path (submit at checkout with צ׳ק selected, then navigate back). Open `#order-pay/<id>` directly — both buttons now show the amount. The paid-success branch is fully verified only with a real card test (production go-live check, out of local scope); the `orderId: null` debt-payment branch must render today's copy — confirm by reading the code path (no API change for debt payments). Delete the held order (same SQL as Task 6 Step 5).

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/pages/payCard.ts src/pages/orderPay.ts
git commit -m "feat(pay): order-aware card success page; cheque button shows amount on interstitial"
```

---

### Task 8: Client — home resume banner (flag on)

**Files:**
- Modify: `src/pages/home.ts`

**Interfaces:**
- Consumes: `GET /api/home` → `pendingPaymentOrder: { id, amount, createdAt } | null`, `features.unifiedCheckout: boolean` (Task 2).
- Produces: a banner above the debt card linking to `#order-pay/:id`. Flag off or no pending order → nothing renders.

- [ ] **Step 1: Extend `HomeData`**

In `src/pages/home.ts` (line ~41-44):

```ts
  features: { payments: boolean; checkPayment: boolean; unifiedCheckout?: boolean };
  banner: { text: string } | null;
  maintenance: { enabled: boolean; message: string };
  paymentPolicy?: { kind: 'cash' | 'net'; netDebt: number; blocksOnDebt: boolean } | null;
  pendingPaymentOrder?: { id: number; amount: number; createdAt: string } | null;
```

- [ ] **Step 2: Render the banner above the debt card**

After the `debtCard` string is built (line ~105), add:

```ts
  // Unified checkout: an order held for payment is the single most urgent thing on
  // this screen — surface it above everything (spec §3.6).
  const pendingPayBanner =
    d.features.unifiedCheckout && d.pendingPaymentOrder
      ? `<a class="debt-coral" style="display:block;text-decoration:none;margin-bottom:0.75rem" href="#order-pay/${d.pendingPaymentOrder.id}">
           <div class="label">⏳ הזמנה ממתינה לתשלום</div>
           <div class="amount">${formatMoney(d.pendingPaymentOrder.amount)}</div>
           <div class="label">ההזמנה תישלח מיד עם השלמת התשלום</div>
           <span class="pay-navy" style="margin-top:0.5rem">שלם עכשיו ←</span>
         </a>`
      : '';
```

Then include `${pendingPayBanner}` in the shell template immediately BEFORE `${debtCard}` (find where `debtCard` is interpolated in the final `shell.innerHTML` and prepend).

- [ ] **Step 3: Verify**

Flag on, with a held order for qa-ucp (create via cheque-path submit as in Task 7): home shows the banner with the correct VAT-inclusive amount; tapping it opens `#order-pay/<id>`. Flag off (`UPDATE settings SET value='false' WHERE key='unified_checkout_enabled'`): banner gone even though the held order exists. Re-enable, then delete the held order (Task 6 Step 5 SQL).

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/pages/home.ts
git commit -m "feat(home): pending-payment resume banner (unified_checkout_enabled)"
```

---

### Task 9: Admin toggle, QA plan, cleanup, deploy

**Files:**
- Modify: `src/pages/adminSettings.ts:27-32` (`SWITCH_ROWS`)
- Modify: `QA_PLAN.md` (append cases)

**Interfaces:**
- Consumes: `SwitchRow` shape (`src/pages/adminSettings.ts:18-25`); PATCH whitelist already accepts the key (Task 1).
- Produces: one-tap admin rollback switch. `dangerousValue: true` → typed confirmation when turning ON, plain one-tap when turning OFF — rollback is deliberately the easy direction.

- [ ] **Step 1: Add the switch row**

In `SWITCH_ROWS` (line ~27), insert after the `check_payment_enabled` row:

```ts
  { key: 'unified_checkout_enabled', name: 'תשלום בסיום הזמנה (מאוחד)', desc: 'פירוט מע״מ בסל + תשלום ישירות במסך סיום ההזמנה. כיבוי מחזיר מיידית את התהליך הקודם.', def: false, dangerousValue: true },
```

- [ ] **Step 2: Append QA cases to `QA_PLAN.md`**

```markdown
## Unified checkout (`unified_checkout_enabled`)

- [ ] Flag OFF: cart/checkout/home render exactly as before; checkout total equals cart total (promo bugfix); cash-customer submit lands on `#order-pay/:id`.
- [ ] Flag ON, cash customer: cart shows `סה״כ לפני מע״מ` / `מע״מ 18%` / bold `סה״כ לתשלום כולל מע״מ`; checkout breakdown shows the SAME payable; CTA `שלח ושלם ₪X ←`.
- [ ] Flag ON, card: submit → PSP page directly; amount on PSP equals checkout payable; success page says "ההזמנה אושרה ותישלח" + order number.
- [ ] Flag ON, cheque: submit with צ׳ק selected → scanner directly with the required amount shown.
- [ ] Flag ON, PSP create failure: submit falls back to `#order-pay/:id` (order recorded, nothing lost).
- [ ] Flag ON, abandon payment: home shows `⏳ הזמנה ממתינה לתשלום` banner → resumes at `#order-pay/:id`. Flag OFF hides the banner.
- [ ] Flag ON, net-terms customer: VAT rows visible, NO payment section, plain `שלח הזמנה`; net+debt still blocked.
- [ ] Rollback drill: turn the flag OFF in admin settings (one tap, no typed confirm) → next page load renders the old flow.
```

- [ ] **Step 3: Full local verification pass**

```bash
npm run typecheck && npm run build && DATA_DIR=/tmp/ucp-test-data node scripts/test-checkout-preview.mjs && node scripts/test-payment-policy.mjs 2>/dev/null || true
```

Expected: typecheck + build clean; checkout-preview tests ALL PASS. (`test-payment-policy.mjs` needs its own DATA_DIR harness — run it the same way if it was runnable before; it must be untouched by this work.)

Then walk the QA cases above against `npm run dev` with the Task 6 local setup.

- [ ] **Step 4: Clean up ALL local test state**

```bash
sqlite3 data/app.db "
DELETE FROM customer_policies WHERE custname='10184';
DELETE FROM settings WHERE key IN ('unified_checkout_enabled','payment_policy_enabled');
DELETE FROM order_lines WHERE order_id IN (SELECT id FROM orders_local WHERE user_id=(SELECT id FROM users WHERE username='qa-ucp'));
DELETE FROM orders_local WHERE user_id=(SELECT id FROM users WHERE username='qa-ucp');
DELETE FROM cart_lines WHERE user_id=(SELECT id FROM users WHERE username='qa-ucp');
DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username='qa-ucp');
DELETE FROM users WHERE username='qa-ucp';"
```

Caveat: if `customer_policies` had a pre-existing row for 10184 (check `data/backups/` snapshots), restore it instead of deleting.

- [ ] **Step 5: Commit and deploy (flag ships OFF — inert in production)**

```bash
git add src/pages/adminSettings.ts QA_PLAN.md
git commit -m "feat(admin): unified-checkout kill switch + QA plan cases"
git push origin main   # Railway auto-deploys; flag defaults off → zero customer-visible change
```

Post-deploy sanity: `GET /api/checkout/preview` on prod returns `enabled: false` for a logged-in customer; prod cart/checkout unchanged.

---

## Rollback (any time, production)

Admin → הגדרות → `תשלום בסיום הזמנה (מאוחד)` → off (one tap, no typed confirmation). The old flow renders on the next page load. No data cleanup needed — held orders keep working through the interstitial, which exists in both flag states.
