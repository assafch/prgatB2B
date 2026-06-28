# Design — Payment Policy + Order Approval (customer-type gating)

**Date:** 2026-06-28
**Status:** Approved (design decisions) — pending spec review, then per-phase plans
**Author:** Assaf + Claude
**Grounded in:** a 4-agent codebase map (customer classification, order lifecycle,
payment rails, messaging/config).

## 1. Goal

Tie **order approval** to the customer's **payment policy**:
- A **cash** customer must pay (cheque or card) **before** the order is approved —
  "only then is the order approved."
- A **net-terms (שוטף)** customer with **open invoices** is **blocked** from
  ordering until they settle (cheque or card).
- A net-terms customer **without** open debt orders normally (unchanged).
- The customer is told clearly what's required and how to act.
- More customer types and payment methods will be added later → a **data-driven
  policy engine**, not hardcoded `if/else`.

## 2. Approved decisions

1. **Cash order handling:** the order is **held locally as `pending_payment` and
   NOT sent to Priority** until payment is confirmed; then it's approved and sent.
   (No unpaid orders created in the ERP.)
2. **Cheque approval timing:** the order is approved the moment the customer
   **photographs + confirms** the cheque (their commitment). The office reconciles
   later, as cheques already work.
3. **Customer-type source:** **auto-derived from Priority `PAYDES`** (e.g. "מזומן"
   → cash, "שוטף"/"ש+30" → net-terms), with an **admin per-customer override**.
4. **Net-terms with open debt:** **hard block** — cannot order until settled.
   *Refined to be usable (see §6): block on **net debt** (openTotal minus pending
   settlements) **above an admin-set threshold**, so a customer isn't trapped after
   paying but before the office reconciles, and so within-terms balances can be
   allowed if the owner sets a non-zero threshold.*

## 3. Today's system (relevant facts)

- `PAYDES` (payment terms) already flows to `CustomerProfile.paymentTerms`
  (`server/finance.ts` shapeProfile) and to `/api/account` + `/api/home`. No logic
  acts on it.
- Open debt = authoritative `OBLIGO.ACC_DEBIT` → `getAccountSummary().balance.openTotal`;
  `getUnpaidInvoices()` (hint list); `unreconciledCardTotal()` (pending card pays,
  1-day window).
- Order flow: `checkout.ts` → `POST /api/orders` → `submitOrder()` (`server/orders.ts`):
  insert `orders_local` ('submitting') → Priority `createOrder()` → 'submitted'. No
  payment gate. States: submitting / submitted / failed.
- Payments: `payment_checks` (draft→submitted→received/...), `card_payments`
  (created→pending→paid, PayPlus). **Neither has an `order_id`.** `confirmCard` /
  `setCheckStatus` confirm payments but never touch orders.
- Messaging: toasts, home banner (`announcement_*`), `blockIfMaintenance`,
  web-push (`notifyUser`), `confirmDialog`/`openSheet`, soft credit warning at checkout.
- Config: global `settings` key/value + `adminSettings.ts`; per-customer overrides
  have a precedent (`customer_pricing`); customer logins managed in `adminUsers.ts`.

## 4. Architecture — the policy engine

One server module `server/paymentPolicy.ts`, the single source of truth:

```ts
type PolicyKind = 'cash' | 'net' | 'custom';
interface Policy {
  kind: PolicyKind;
  requirePaymentBeforeApproval: boolean; // cash → true
  blockOnOpenDebt: boolean;              // net → true (configurable)
  openDebtThreshold: number;             // admin-set; block when netDebt > threshold
  methods: ('card' | 'check')[];         // accepted payment methods
  messages: { cash: string; openDebt: string }; // customer-facing (admin-editable)
}

// derive from Priority PAYDES, then apply an admin per-customer override
function resolvePolicy(custname: string, paymentTerms: string | null): Policy

// the order-time decision
interface PolicyDecision {
  allowOrder: boolean;          // false → block submit
  requiresPayment: boolean;     // cash → must pay to approve
  amount: number | null;        // cash → order total; debt-block → net open debt
  methods: ('card'|'check')[];
  reason: 'cash_payment_required' | 'open_debt' | null;
  message: string;              // shown to the customer
}
function evaluate(custname: string, cartTotal: number): Promise<PolicyDecision>
```

- **Derivation** maps `PAYDES` substrings → kind via an admin-editable mapping
  (default: contains "מזומן" → cash; else net). Unknown → net (safe default:
  ordering keeps working).
- **Override** comes from a new `customer_policies` table (per `custname`),
  following the `customer_pricing` precedent.
- The engine is **pure + testable**; all gating reads its output.

## 5. Data model

- **`customer_policies`** (new): `custname TEXT PRIMARY KEY, kind TEXT /*auto|cash|net|custom*/,
  open_debt_threshold REAL, updated_at`. Absent row → `auto` (derive from PAYDES).
- **`settings`** keys (global config, via existing `SETTABLE`/`BOOL_SETTINGS`):
  `payment_policy_enabled` (bool, default **false** — staged rollout),
  `policy_cash_paydes_match` (CSV of PAYDES substrings → cash, default "מזומן"),
  `policy_net_debt_threshold` (default 0), `policy_msg_cash`, `policy_msg_open_debt`.
- **`orders_local`** new columns: `payment_status TEXT /*not_required|pending_payment|approved*/`,
  `payment_required_amount REAL`, `linked_payment_kind TEXT /*card|check*/`,
  `linked_payment_id TEXT`, `approved_at TEXT`.
- **`card_payments`** + **`payment_checks`**: add nullable `order_id TEXT` (the order
  this payment approves; null = a normal debt/standalone payment).
- **`pendingSettlement(custname)`**: card unreconciled (existing) **+** submitted
  cheques within the recon window — used for the net-debt calc so a fresh payment
  lifts the block.

## 6. Behavior

### 6a. Net-terms open-debt block (hard, server-enforced)
At `submitOrder()`: if policy.blockOnOpenDebt and
`openTotal − pendingSettlement(custname) > openDebtThreshold` → throw
`OrderError(policy.messages.openDebt + " (₪<netDebt>)")`. The customer settles via
the **existing** B1/B2 pay surfaces (`#invoices`), then re-orders; the block lifts
as soon as a card payment is confirmed or a cheque is submitted (pending settlement
offsets the debt), without waiting for office reconciliation. Checkout shows the
same message + a "סגור חוב" button up-front (don't make them discover it on submit).

### 6b. Cash customer — pay before approval (order held, not sent to Priority)
- `submitOrder()` for a cash policy inserts the order with
  `payment_status='pending_payment'`, `payment_required_amount=cartTotal`, **and does
  NOT call Priority** `createOrder()`. Cart is cleared; a "תשלום להזמנה" flow opens.
- The customer pays for **that order**:
  - **Card:** a new order-scoped intent (`kind='order_payment'`, `order_id` set,
    `amount=cartTotal`) → PayPlus → `confirmCard` confirms.
  - **Cheque:** the existing scan/confirm flow, scoped to the order
    (`order_id` set); approval at **submit** (decision #2).
- **On payment confirm** (`confirmCard` / cheque `setCheckStatus`→'submitted'): a hook
  finds the order via `linked_payment_id`/`order_id`, sets `payment_status='approved'`
  + `approved_at`, then calls Priority `createOrder()` (the deferred submit), records
  `priority_ordname`, and `notifyUser` ("ההזמנה אושרה ונשלחה"). If Priority is
  unreachable, the order stays `approved`-but-not-sent and a retry/admin path re-sends
  (it is **paid**, so it must not be lost).
- **Abandon/expire:** a `pending_payment` order with no confirmed payment after a TTL
  is swept (local only; nothing in Priority to cancel).

### 6c. Messaging
- **Checkout:** policy decision rendered as a blocking panel/sheet before submit —
  cash: "כלקוח מזומן יש לשלם ₪X כדי שההזמנה תאושר" + [שלם באשראי]/[צלם צ׳ק]; debt:
  "יש לסגור ₪Y חוב פתוח" + [סגור חוב].
- **Orders list / detail:** `pending_payment` orders show a "ממתין לתשלום" chip + a
  pay button; on approval the chip flips to "אושרה ונשלחה".
- **Push** on approval (reuse `notifyUser`). Optional home banner hint.

### 6d. Admin
- **Settings → "מדיניות תשלום"** (in `adminSettings.ts`): feature flag, the
  PAYDES→cash mapping, the net-debt threshold, the two customer-facing messages, and
  the accepted methods.
- **Per-customer override** in `adminUsers.ts`: a dropdown `auto / cash / net / custom`
  + optional per-customer threshold → `PATCH /api/admin/customers/:custname/policy`.

## 7. Phasing (each phase = its own spec → implement → deploy)

1. **Foundation (no gating):** `paymentPolicy.ts` engine + `customer_policies` table
   + admin config (flag OFF by default) + surface the resolved policy in `/api/home`
   + the schema migrations (order columns, payment `order_id`). Nothing changes for
   customers until the flag is on. *Lowest risk; everything else builds on it.*
2. **Net-terms debt block:** the §6a server gate + checkout message + the
   `pendingSettlement` helper. Reuses existing pay-debt flows. *Medium; one gate.*
3. **Cash pay-at-order:** the §6b held-order state machine, order-scoped payments,
   the confirm→approve→send-to-Priority hook, order-state UI, abandon sweep. *Largest
   + most sensitive (touches the live ordering + payment paths).*

Recommended order is 1 → 2 → 3 (risk-ascending). Cash-first is possible if the owner
prefers, but it's the heaviest piece.

## 8. Testing
- Unit: `resolvePolicy` (PAYDES + override), `evaluate` (cash / net-with-debt /
  net-no-debt / below+above threshold / after a pending payment), `pendingSettlement`.
- Integration: `submitOrder` blocks net-debt; cash order is held (no Priority call);
  payment confirm approves + sends to Priority; abandon sweep; Priority-down retry.
- E2E (dev-browser, like `qa/`): a cash test customer can't get an order approved
  without paying; a net-terms customer with seeded open debt is blocked, settles, then
  orders. typecheck + build green; no regression in the existing suite.

## 9. Open items / future (out of scope for now)
- "Overdue-only" gating (block only invoices past due date) instead of total open
  debt — needs invoice due-date logic; the threshold is the v1 lever.
- Installments / partial-pay-then-ship.
- More policy kinds/methods (the engine is built for this).
- Manual admin approval queue / RBAC approver role.
