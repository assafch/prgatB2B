# Saved Card + Installments (תשלומים) — Design Spec

**Date:** 2026-07-05
**Status:** Approved direction — pending user review
**Flags:** `installments_enabled`, `saved_cards_enabled`, `saved_card_charge_enabled` (all default `false` — deployed inert, one-tap rollback each)

## 1. Goal

Two add-ons to the card-payment flows (unified checkout order payments, debt/invoice
payments, partial on-account payments — "everywhere", per decision):

1. **Installments:** let a customer split a card payment into N monthly charges on
   the PayPlus hosted page, above an admin-set amount threshold, up to an admin-set
   max count.
2. **Saved card:** save the customer's card (as a PayPlus token — the card number
   never touches our server, PCI SAQ-A preserved) on first payment, then charge it
   with one tap on later payments.

## 2. PayPlus API facts (verified against docs.payplus.co.il, 2026-07-05)

- `PaymentPages/generateLink` supports:
  - `create_token: boolean` — "In case you have tokenization permission, you can
    decide if you would like to return the token of the customer for future
    charges". **Requires tokenization permission on the terminal.**
  - `payments: integer` — installment count for the payment page;
    `payments_selected`, `payments_first_amount` for preselection;
    `payments_credit: boolean` for credit deals (עסקת קרדיט, min 3) — we do NOT
    use credit deals (regular תשלומים only).
- `Transactions/Charge` (J4, server-to-server) supports `use_token: true` +
  `token` + customer object + `terminal_uid` + `credit_terms` (1=regular) +
  `payments` object + `more_info` — this is the true one-tap charge
  (merchant-initiated, card not re-entered).
- Token management endpoints exist: `Token/Add`, `Token/View`, `Token/List`.
- **NOT documented:** any way to make the hosted page display/prefill a returning
  customer's saved card. Therefore the "prefilled hosted page" middle step from
  the original discussion is dropped; the phases below are what the API supports.
  (The PayPlus verification call should still ask whether an undocumented
  registered-customer page feature exists — if yes, it can be added later as a
  bonus, but nothing in this design depends on it.)

## 3. The PayPlus gate (unchanged from June)

Token storage + merchant-initiated charging is compliance- and
contract-sensitive. **Task 0 of the plan is Assaf's verification call to PayPlus**
(tech@payplus.co.il / account manager):

1. Enable **tokenization permission** on the terminal (gates Phase 1's
   `create_token`).
2. Written confirmation the terminal/contract permits **storing tokens and
   charging them merchant-initiated** (gates Phase 2), and that the ToS allow it.
3. Enable **תשלומים** on the payment-page settings; confirm `payments` semantics
   on the staging env (`restapidev.payplus.co.il`) — max-allowed vs fixed-count.
4. Ask whether the hosted page can show saved cards for returning customers
   (nice-to-have, see §2).

Build proceeds before the answers — everything is flag-gated — but the flags stay
off until the corresponding approval exists. Installments (item 3) is page
configuration, not a compliance approval; it can typically go live first.

## 4. Design — Installments

### 4.1 Settings (admin, all in the existing settings table)

- `installments_enabled` (bool, default false) — master switch.
- `installments_min_amount` (number, default 1000) — payments at or above this
  (VAT-inclusive ₪) offer installments; below it, single payment only.
- `installments_max` (int, default 4, clamp 2..12) — most installments a customer
  may pick.

### 4.2 Server

- `createPaymentPage` input gains optional `maxPayments?: number`; when set, the
  body includes `payments: maxPayments`. Callers (debt create, partial intent,
  order pay) compute it: flag on && amount ≥ min → `installments_max`, else omit
  (single payment, today's behavior).
- `parseTx` additionally extracts the number of payments from the transaction
  record (`number_of_payments` / `payments` — exact field confirmed against a
  staging transaction during implementation) → new nullable
  `card_payments.payments_count` column (additive migration). Confirm/IPN path
  stores it.
- **Reconciliation unchanged:** the transaction records the full amount once; the
  card company splits the customer's billing. Priority receipts, payable-cap
  math, approveOrder — all untouched.

### 4.3 Client / admin

- Pay screens (checkout payment section, pay/card, order interstitial) show a
  passive eligibility note when applicable: "אפשר לחלק עד N תשלומים בעמוד
  התשלום" — the actual picker is PayPlus's, on the hosted page.
- Admin payments queue and payment history rows show "ב-N תשלומים" when
  `payments_count > 1`.
- Admin settings: one switch + two number inputs (pattern: existing prefs panel).

## 5. Design — Saved card (two phases, two flags)

### 5.1 Data

New table `saved_cards`:

```sql
CREATE TABLE IF NOT EXISTS saved_cards (
  id TEXT PRIMARY KEY,              -- random 24-hex
  user_id INTEGER NOT NULL,
  custname TEXT NOT NULL,
  token TEXT NOT NULL,              -- PayPlus token, encrypted at rest (same AES-GCM util as cheque images)
  brand TEXT,                       -- 'Visa' etc, from card_information
  four_digits TEXT,
  expiry_month TEXT, expiry_year TEXT,
  consented_at TEXT NOT NULL,       -- when the customer ticked the save box
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_saved_cards_user ON saved_cards(user_id);
```

One card per user to start (upsert replaces) — YAGNI on multi-card.

### 5.2 Phase 1 — save + manage (`saved_cards_enabled`)

- **Consent:** a checkbox on the card-pay initiation surfaces (unified-checkout
  payment section and pay/card page): "💾 שמור את הכרטיס לתשלומים הבאים"
  — default **unchecked**, never pre-ticked. The create-intent endpoints accept
  `saveCard: boolean`; only then does `generateLink` get `create_token: true`.
- **Capture:** the confirm path (`Transactions/View` re-query — the only trusted
  source) extracts the returned token + card metadata and upserts `saved_cards`.
  No token in the IPN body is ever trusted without the re-query.
- **Manage:** account page gains an "אמצעי תשלום" section: the saved card
  (brand ••last4, expiry) + "הסר כרטיס" (deletes the row immediately; customer
  consent is revocable at any time). Server: `GET /api/payments/saved-card`,
  `DELETE /api/payments/saved-card`.
- Phase 1 alone does not change how payment happens — it builds the stock of
  tokens (and the trust UX) so Phase 2 is instant when approved.

### 5.3 Phase 2 — one-tap charge (`saved_card_charge_enabled`, HARD-GATED on §3.2)

- **Endpoint:** `POST /api/payments/card/charge-saved` with either
  `{ orderId }` (held order) or `{ invoices: [...] }` (debt) or `{ amount }`
  (partial, capped) — amount derivation reuses the EXACT same server-side
  validation paths as the hosted flows today (never client-trusted).
- Charge via `Transactions/Charge`: `use_token: true`, `token`, customer object,
  `terminal_uid`, `credit_terms: 1`, `more_info: <ref>`, and the same
  installments rule as §4 when eligible. Result confirmed by `Transactions/View`
  re-query (same `confirmCard` machinery, same `card_payments` row lifecycle,
  same approveOrder / receipts / pendingSettlement hooks — zero new
  reconciliation logic).
- **UX:** where a saved card exists (and flag on), the card option renders as the
  primary action: "שלם בויזה ••4580 · ₪X" — one tap, in-app spinner, straight to
  the order-aware success screen. Secondary link "תשלום בכרטיס אחר" → today's
  hosted page (which can also re-save the new card).
- **Failure:** any charge error falls back to the hosted page (order flows keep
  the `#order-pay` interstitial as final recovery, exactly like unified
  checkout). A declined token charge never strands the customer.
- 3DS: MIT charges are customer-not-present; `self_secure_3ds` exists on the
  endpoint if PayPlus requires it — decided by their answer in §3.

### 5.4 Security & privacy

- Token encrypted at rest with the existing AES-GCM utility (cheque-image
  pattern); decrypt only at charge time; never sent to the client (client sees
  brand + last4 + expiry only).
- All new endpoints requireOwner (finance-scoped) — staff 'orderer' logins never
  see or use saved cards.
- Delete = immediate row delete; optional PayPlus-side `Token/Remove` if the
  endpoint exists on our contract (checked in implementation).
- Charge endpoint rate-limited with the existing `cardPayLimiter`.

## 6. Rollback

Three independent admin switches (same pattern as `unified_checkout_enabled` —
typed confirm to enable, one tap to disable):
- `installments_enabled` off → pages revert to single-payment. No data cleanup.
- `saved_cards_enabled` off → consent checkbox and account section disappear; no
  new tokens are created. Existing rows stay (harmless) unless customers delete.
- `saved_card_charge_enabled` off → one-tap button disappears; hosted page is
  the only card path again. In-flight charges resolve via the normal confirm.

## 7. Out of scope

- Multi-card wallets, card nicknames.
- Credit deals (עסקת קרדיט / payments_credit).
- Auto-charge / standing payment agreements (הוראת קבע) — different contract.
- UPay/Tranzila parity — PayPlus is the live PSP; others remain hosted-page only.
- Hosted-page saved-card display (undocumented; revisit if PayPlus says yes).

## 8. Testing

- Unit (repo convention, scripts/): installments eligibility math (flag ×
  threshold × max), payments field only sent when eligible; token
  encrypt/decrypt round-trip; charge-saved amount derivation mirrors hosted-flow
  derivation for all three kinds.
- Staging (restapidev.payplus.co.il, PAYPLUS_ENV=staging): create_token page
  round-trip, token charge, payments semantics — before any prod flag flips.
- Manual QA additions to QA_PLAN.md per phase.
- Live sign-off: one real payment with save-consent + one real one-tap charge at
  Phase-2 activation (like the unified-checkout card test).
