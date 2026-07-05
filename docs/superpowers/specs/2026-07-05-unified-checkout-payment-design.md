# Unified Checkout + Payment — Design Spec

**Date:** 2026-07-05
**Status:** Approved direction — pending user review of this spec
**Flag:** `unified_checkout_enabled` (settings, default `false` — deployed inert)

## 1. Problem

Walkthrough findings (2026-07-05, local dev, cash-policy customer):

1. **Three different totals in three consecutive screens.** Cart shows ₪513.60
   (promo total), checkout shows ₪542.40 (`checkout.ts` uses `cart.total` and
   ignores `promotions` — display bug), the pay screen demands ₪606.05 (VAT
   gross-up, mentioned nowhere earlier).
2. **Payment is a post-submit surprise.** Cash customers discover the mandatory
   payment only on a bare interstitial after "שלח הזמנה".
3. **Abandoned unpaid orders have no visible recovery path.** Home shows nothing;
   the order is silently swept after 48h.
4. **Card success page is generic.** It never says the order is approved and will
   ship — the one thing the customer paid to hear.

Goal: one honest number from cart to payment, payment folded into checkout
(~6 taps instead of ~11 to reach the PSP), a resume path for abandoned payments.

## 2. Hard constraints

### 2.1 Priority side — DO NOT TOUCH

The entire ERP pipeline is out of bounds. Specifically unchanged:

- `POST /api/orders` order-creation logic in `server/orders.ts`: Priority payload
  (PRICE omitted on paid lines; freebies/gifts at PRICE 0), BOOKNUM `B2B-<id>`
  idempotency + recovery lookups, `submitting`/`failed` state machine.
- Cash-hold gating: order stays local (`pending_payment`), forwarded to Priority
  **only** after payment approval via the existing `approveOrder` →
  `sendHeldOrderToPriority` path.
- Payment-policy engine (`server/paymentPolicy.ts`): `evaluate()` remains the
  single order-time authority, including fail-open on Priority outage.
- Priority receipts (TINVOICES), cheque linking (`payHeldOrderByCheck`), the
  pending-order sweep, and all admin ops queues.
- VAT source of truth stays `server/money.ts` (`VAT_RATE`, `withVat`). The client
  never hardcodes a VAT rate.

All server work in this spec is **additive** (new read-only endpoint, new
response fields). No changes to existing endpoint behavior, no schema migrations.

### 2.2 Full rollback

Everything user-visible is gated on `unified_checkout_enabled`:

- Flag **off** (default): the app renders and behaves exactly as today — current
  checkout, current interstitial, current home. New code paths are dormant.
- Rollback = flip the flag in admin settings. No data to migrate back; the new
  endpoint simply goes unused. The interstitial page (`#order-pay/:id`) is never
  deleted — with the flag on it remains the recovery screen (see 3.5).

**One exception, deliberately not flag-gated:** the checkout total display bug
(promo discount ignored) is fixed unconditionally. Today's checkout displays a
number that is simply wrong — the order already records the promo total. This is
a correctness fix valid in both flag states.

## 3. Design

### 3.1 Server: checkout preview endpoint (new, additive)

`GET /api/checkout/preview` (requireCustomer):

```jsonc
{
  "subtotal": 542.40,        // pre-discount, pre-VAT (promotions.subtotal)
  "discount": 28.80,          // promo savings (promotions.discount)
  "total": 513.60,            // promotions.total (pre-VAT)
  "vatRate": 0.18,            // from money.ts
  "vatAmount": 92.45,         // withVat(total) - total
  "payable": 606.05,          // withVat(total) — what a cash customer pays
  "requiresPayment": true,    // policy decision for THIS customer + cart
  "kind": "cash",            // 'cash' | 'net'
  "blocked": false,           // net-terms open-debt block (mirrors decide())
  "blockedReason": null
}
```

Implementation: reuse the existing cart/promotions computation plus
`enforcedFor` + `evaluate()` — both already read-only. Priority balance calls go
through the existing finance TTL cache, so rendering checkout adds no meaningful
load. The preview is **display-only**: `POST /api/orders` re-evaluates at submit
time and remains the source of truth. If the two disagree (debt settled or
incurred in between), the server's submit-time decision wins and the client uses
the amounts from the submit response.

`GET /api/cart` gains one additive field: `vatRate` (constant from money.ts), so
the cart page can render the VAT line without a finance call. Client computes
`round2(total * (1 + vatRate))` — same formula as `withVat`, identical result.

`GET /api/home` gains one additive field: `pendingPaymentOrder:
{ id, amount, createdAt } | null` — newest `pending_payment` order for this user
(cheap local query). Powers the resume banner (3.6).

`GET /api/payments/card/:id` gains additive fields when the payment is an
`order_payment`: `orderId`, and once approved, `ordname`. Powers the
order-aware success page (3.5).

### 3.2 Cart (flag on)

Summary bar gains two rows under the existing promo rows, using `vatRate` from
`/api/cart`:

```
מע״מ 18%                    ₪92.45
סה״כ לתשלום כולל מע״מ       ₪606.05   (bold — this is THE number)
```

CTA becomes `לסיום הזמנה · ₪606.05 ←`. Shown to **all** customers (net-terms
invoices include VAT too — this is true information for everyone). Pre-VAT line
totals and unit prices are untouched (B2B convention).

### 3.3 Checkout (flag on)

Fetches `/api/checkout/preview` alongside the cart. Renders:

1. Line summary (unchanged) + full breakdown: `סכום ביניים` → `הנחות` (if any) →
   `מע״מ 18%` → **`לתשלום ₪606.05`**. Same numbers as the cart — nothing changes
   between screens.
2. Delivery-date chips + note (unchanged).
3. **Payment section** — only when `preview.requiresPayment`:
   - Segmented method picker: `💳 אשראי` (default) | `📸 צ׳ק`, with one line of
     copy: "לקוחות מזומן משלמים בעת ההזמנה — ההזמנה תישלח מיד עם אישור התשלום."
   - CTA: **`שלח ושלם ₪606.05 ←`**.
4. When `!requiresPayment`: current `שלח הזמנה` behavior, untouched (including
   the net-terms debt block, which also honors `preview.blocked` for consistency).

Submit handler (flag on, requiresPayment):

```
POST /api/orders            (unchanged endpoint; server re-evaluates)
  └─ response.needsPayment:
       card   → POST /api/orders/:id/pay/card → location.href = PSP url
       cheque → location.hash = '#pay-check/:id'
  └─ PSP create fails / needsPayment but method step errors:
       location.hash = '#order-pay/:id'   (interstitial = recovery screen)
```

The customer never sees the interstitial on the happy path; it exists only as
the fallback/resume surface.

### 3.4 Checkout total bugfix (both flag states)

`checkout.ts` renders `promotions.total` (and the promo discount rows) instead
of raw `cart.total`. With the flag off this is the only visible change — the
checkout total finally matches the cart and the recorded order.

### 3.5 Order-aware payment success (flag on)

`renderPayCardReturn` polls as today. When the payment carries `orderId`:

- success → `✅ התשלום בוצע — ההזמנה אושרה ותישלח` + `מספר הזמנה: <ordname>`
  (once available; the poll already waits for approval) + CTA `להזמנות שלי`.
- failure/expired → existing retry UI, plus a link back to `#order-pay/:orderId`.

Cheque path already lands on an order-aware confirmation; unchanged. Minor
touch-up on the interstitial while we're there: the cheque button also shows the
amount (`שלם בצ׳ק ₪606.05`).

### 3.6 Home resume banner (flag on)

When `home.pendingPaymentOrder` is set, render a prominent card at the top of
home (above promos, styled like the debt card):

```
⏳ הזמנה ממתינה לתשלום · ₪606.05
ההזמנה תישלח מיד עם השלמת התשלום
[ שלם עכשיו ← ]        → #order-pay/:id
```

No push notifications and no sweep changes in this spec (candidates for a
follow-up; the 48h sweep behavior is untouched).

## 4. Error handling

- **Preview vs submit drift:** server re-evaluation at submit wins. If submit
  returns `needsPayment` with a different amount, the pay step uses the
  server's amount (it already does — `payment_required_amount`).
- **PSP page-create failure after order creation:** order is already recorded as
  `pending_payment`; client falls back to `#order-pay/:id` where the customer
  can retry card or switch to cheque. This equals today's behavior.
- **Priority outage:** unchanged fail-open in `evaluate()`; preview inherits it.
- **Double-submit:** existing guards unchanged (button disable, cart cleared on
  hold, idempotent cheque linking, single-paid-payment check in `pay/card`).

## 5. Testing

- **Unit:** preview endpoint math (subtotal/discount/VAT/payable vs `withVat`),
  `requiresPayment`/`blocked` mirroring `decide()` for cash / net / net+debt /
  exempt customers.
- **Regression (flag off):** existing flow untouched except checkout total =
  promo total. Existing payment-policy unit tests must pass unmodified.
- **Manual QA (flag on), mirroring the walkthrough:** cash customer sees the
  same ₪ figure on cart → checkout → PSP/cheque; card path lands on order-aware
  success; abandoning payment surfaces the home banner; net-terms customer sees
  VAT rows but no payment section; net+debt customer still blocked.
- QA cases appended to `QA_PLAN.md` as part of implementation.

## 6. Out of scope

- Upsell sheet throttling/stacking fix (separate small change).
- Saved-card one-tap (blocked on PayPlus token approval).
- Push reminders for unpaid orders; sweep TTL changes.
- Any change to Priority payloads, receipts, or admin queues (see 2.1).

## 7. Rollback plan

Flip `unified_checkout_enabled` off in admin settings. All new UI disappears;
flow returns to: checkout (with corrected total) → interstitial → pay. The
preview endpoint and additive response fields stay dormant. No migrations, no
data cleanup.
