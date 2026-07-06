# Overdue-Only Debt Block (שוטף-aware) — Design Spec

**Date:** 2026-07-06
**Status:** Approved direction (Assaf, 2026-07-06) — pending spec review
**Gate:** per-customer opt-in column `customer_policies.block_overdue_only` (default 0 = today's behavior). Master `payment_policy_enabled` flag unchanged.

## 1. Problem

The net-terms debt block counts ALL open debt (`OBLIGO.ACC_DEBIT`), including
invoices from the current month that are not yet due under שוטף. A שוטף customer
(first: **10330 חסון אספקה טכני**, PAYDES "שוטף", pays by bank transfer) would be
blocked from a second order mid-month even with zero overdue debt. Assaf's rule:
*"יכול להזמין סחורה החודש אם סגר את החוב של חודש שעבר"* — and his refinement:
invoices have a **תאריך תשלום**; the block should follow it.

## 2. Tenant facts (verified live, 2026-07-06)

- `AINVOICES` is the reliable unpaid-invoice source: `IVRECONDATE == null` +
  `STATDES == 'סופית'` + `TOTPRICE > 0` (existing `listUnpaidInvoices`,
  production-proven by the pay-by-card picker). Rows carry `IVDATE`.
- **No due-date field is exposed:** `OPENDEBT`/aging forms are not exposed;
  `OPENINVOICES` has no PAYDATE; `AINVOICES.IVPAY_SUBFORM` (per-invoice payment
  schedule) expands safely (`$expand=IVPAY_SUBFORM` — verified, no connection
  drop) but is **empty on all sampled final invoices** — this tenant computes
  the displayed תאריך תשלום from the customer's תנאי תשלום rather than storing it.
- Customer payment terms are already available to the policy engine:
  `resolvePolicy(custname, paymentTerms)` receives `profile.paymentTerms`
  (CUSTOMERS.PAYDES, e.g. "שוטף", "שוטף+30").
- Real-data validation (10184, ACC_DEBIT ₪46,363.36): unpaid invoices
  Feb–May ₪36,418 (all overdue under שוטף) + 1/7 ₪8,564 (due 31/7, not
  overdue). Overdue-only block ≈ ₪37.8k after cap — blocks correctly, while the
  July invoice alone would not block. 10330 currently has zero unpaid invoices.

## 3. The rule

For an enforced net customer with `block_overdue_only = 1`:

```
dueDate(invoice)  = IVPAY.PAYDATE when present (future-proofing; tenant currently never populates)
                    else endOfMonth(IVDATE, Asia/Jerusalem) + N days
N                 = parsed from customer PAYDES: "שוטף" → 0; "שוטף+30"/"שוטף +30"/"שוטף30" → 30;
                    any unparseable/missing PAYDES → 0 (strictest common terms, matches שוטף)
overdueSum        = Σ TOTPRICE of unpaid final invoices where dueDate < today (start of day, Asia/Jerusalem)
blockingDebt      = min(overdueSum, ACC_DEBIT)         // on-account payments reduce ACC_DEBIT first
netDebt           = max(0, blockingDebt − pendingSettlement(custname))   // existing cheque/card offsets
block order       ⇔ netDebt > openDebtThreshold        // existing per-customer/global threshold
```

With `block_overdue_only = 0` (default): exactly today's computation
(`ACC_DEBIT − pendingSettlement`), byte-identical behavior.

Examples (today = 6/7): invoice 1/7 due 31/7 → never blocks in July; invoice
6/5 due 31/5 → blocks. On 1/8, unpaid July invoices start blocking — exactly
"order this month iff last month is settled". A שוטף+30 customer's June invoice
(due 30/7) correctly does NOT block during July.

## 4. Implementation surface

### 4.1 Data layer

- `listUnpaidInvoices` (server/priority.ts) gains `$expand=IVPAY_SUBFORM` (bare
  expand — no inner `$select`, per the documented tenant quirk) and returns
  optional `IVPAY_SUBFORM: { PAYDATE?: string }[]`. `top` stays 200.
- New cached accessor in server/finance.ts: `getUnpaidInvoicesCached(custname)`
  using the existing memo TTL + `finance_cache` persistent fallback (key
  `unpaid:<custname>`), same pattern as balance/customer. The pay-by-card
  picker's getUnpaidInvoices already shared this same cache slot (5-min TTL) before this feature; it now reuses the same accessor — behavior unchanged.

### 4.2 Policy engine (server/paymentPolicy.ts)

- `Policy` gains `blockOverdueOnly: boolean` (from the new column).
- New PURE, unit-tested helpers (no IO):
  - `parseNetTermsDays(paydes: string | null): number` — the PAYDES parser.
  - `invoiceDueDate(ivdate: string, extraDays: number, ivpayDates?: string[]): Date`
    — end-of-month (Asia/Jerusalem) + N, or max(IVPAY PAYDATE) when provided.
  - `overdueSum(invoices, paydes, today): number`.
- `evaluate()`: when `policy.blockOnOpenDebt && policy.blockOverdueOnly`, fetch
  the cached unpaid list; `blockingDebt = min(overdueSum, openTotal)`; on fetch
  failure with no cache → **fail-open** for the overdue refinement (fall back to
  0 blocking debt, i.e. skip the block) with a `[policy]` warning — consistent
  with the existing M2 fail-open. All callers (order submit, checkout preview,
  home `paymentPolicy.netDebt`) inherit automatically; home.ts must reuse the
  same computation (it currently recomputes netDebt inline — extract a shared
  `computeNetDebt(custname, policy, openTotal)` in paymentPolicy.ts and use it
  from both home.ts and evaluate()).

### 4.3 Schema + admin

- Additive guarded column: `customer_policies.block_overdue_only INTEGER DEFAULT 0`.
- Customer card (src/pages/adminCustomerCard.ts) policy section gains a toggle:
  **"חסימה רק לפי תאריך תשלום (שוטף)"** with a one-line description
  "חשבוניות שטרם הגיע מועד פירעונן לא חוסמות הזמנה". Saved via the existing
  per-customer policy PATCH.

### 4.4 Customer-facing copy

Blocked screens (checkout debt block + order error) — when the customer's mode
is overdue-only, the amount shown is the overdue figure. Add one line to the
block card: **"שילמתם בהעברה בנקאית? החסימה תוסר אוטומטית עם קליטת התשלום במשרד."**
(10330 pays by bank transfer; the block clears after the office posts the
receipt in Priority + cache TTL.)

## 5. Testing

- Pure-unit (scripts/ convention, extends `scripts/test-payment-policy.mjs` or a
  new `test-overdue-block.mjs`): `parseNetTermsDays` ("שוטף", "שוטף+30",
  "שוטף +60", "שוטף30", null, "מזומן", garbage); `invoiceDueDate` month-end
  edges (31/1→28/2 rollover for +30, December→January year rollover, DST months);
  `overdueSum` with the real 10184 fixture (expect the 1/7 invoice excluded,
  Feb–May included); cap/threshold interaction via `decide()` (unchanged).
- Live QA (local, flags on, 10330 + 10184 read-only): home netDebt figure,
  checkout block state, order-submit decision for both customers.
- Regression: `block_overdue_only=0` path byte-identical (existing
  test-payment-policy.mjs untouched and passing).

## 6. Rollback

Per-customer toggle off → identical to today. Master `payment_policy_enabled`
off → nothing enforced at all (current prod posture). No migrations to revert.

## 7. Out of scope

- Aging buckets / exposing OPENDEBT on the tenant.
- Per-invoice partial-payment precision beyond the ACC_DEBIT cap.
- Any change to cash-policy (pay-before-approval) customers.
- Automatic PAYDES→enrollment (enrollment stays manual per customer).
