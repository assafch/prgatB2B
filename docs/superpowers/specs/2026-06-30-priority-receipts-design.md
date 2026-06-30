# Design: Automatic receipt creation in Priority

**Project:** prgatB2B · **Branch:** `feat/payment-policy` · **Date:** 2026-06-30
**Status:** Approved (final, Priority-verified) — ready for implementation plan.

## Goal

Close the loop between an in-app credit-card payment and money being recorded in
Priority. Today the app writes **only an ORDER**; card payments live solely in the local
`card_payments` table and the office reconciles money into Priority by hand. This feature
makes the app create a **receipt (קבלה / תקבול)** in Priority automatically when a card
payment succeeds. The ORDER keeps being created exactly as today.

## #1 principle — the customer flow is NEVER blocked by receipts

Receipt creation is **entirely decoupled and asynchronous** from the customer experience.
Once a card charge has **succeeded** (PSP re-query → `status='paid'`), the customer is done:
their order is approved/sent and they keep working **regardless of what happens with the
Priority receipt**. A receipt failure (Priority down, bad config, validation error, outage)
**must never**: block or delay any request, change the order's approved/sent status, surface
an error to the customer, or trigger a refund. It is recorded as `failed` and **left for
manual handling** (admin queue + alert) and automatic sweep-retry. Concretely:
- The receipt is **only ever enqueued for a charge that actually succeeded** (`status='paid'`).
- Enqueue is **fire-and-forget and non-throwing** — wrapped so even a failure to enqueue is
  logged, never propagated into `confirmCard` / order approval / invoice-payment.
- The receipt is **created only in the background sweep**, never synchronously inside a
  request, so a slow/failing Priority call cannot delay the customer's response.
- Order creation/approval (`approveOrder` → `sendHeldOrderToPriority`) is independent: its
  success/failure is untouched by, and does not gate, the receipt.

## Verified Priority facts (live OData, read-only, 2026-06-30)

- **Receipt entity = `TINVOICES`** ("קבלות"), API-enabled. Key `IVNUM,DEBIT,IVTYPE`;
  receipts are `IVTYPE='T'`, `DEBIT='D'`, `IVNUM` auto-assigned (`RC…`).
- **Mandatory header fields** (confirmed consistent on ~100 live receipts):
  `ACCNAME` (customer account = customer number), `CASHNAME` (cash-box), `IVDATE`,
  `STATDES` (status), `OWNERLOGIN`, `CODE` (currency), `FNCPATNAME` (transaction type).
  Live constant values: `STATDES='סופית'` (+ `FINAL='Y'`), `CODE='ש"ח'`, `FNCPATNAME='ק'`.
  Also set `CUSTNAME`=customer#, `TOTPRICE`=amount, `ORDNAME` (scenario 1), `DETAILS`
  (idempotency, **24-char** field — empty on every live receipt).
- **Credit-card payment line → `TPAYMENT2_SUBFORM`** (`TPAYMENT_SUBFORM` is cheques, unused).
  Live credit-card code: **`PAYMENTCODE="13"`** ("לאומי ויזה-ידני"); bank-transfer = "3".
  Amount: `QPRICE` = `FIRSTPAY` = `TOTPRICE` = the charge. Card detail fields available:
  `CARDNUM`, `VALIDMONTH`, `CONFNUM`, `SHVA_TERMINALNAME`, `CASHNAME` (mirrors header).
- **Key finding:** **0 of ~100** recent receipts populate `IVRECON_SUBFORM`. The office
  creates **every** receipt **on-account** (card, transfer, all) and reconciles to invoices
  in a **separate** process. Auto-reconciliation at receipt-creation is therefore unverified
  on this installation and diverges from the office workflow → **out of scope for v1**.

## Decisions (owner, 2026-06-30)

1. **One mechanism, always on-account.** `createReceipt()` always creates an on-account
   `TINVOICES` receipt with one credit-card payment line. The two call sites differ only in
   the *hint* attached:
   - **Scenario 1 — new order paid by card:** set `ORDNAME` = the order. No invoice hint.
   - **Scenario 2 — paying old invoice(s):** set `REFERENCE` = the chosen `IVNUM`(s) as a
     hint (the full list also lives in `card_payments.paid_items`); the office reconciles,
     exactly as it does for every receipt today.
   Neither writes a tax invoice (the office still issues the חשבונית מס from the delivery
   note; this advance receipt offsets it) and neither writes `IVRECON_SUBFORM` in v1.
2. **Config via admin settings** (no hardcoded constants), office fills before go-live:
   `priority_receipt_cashname` (cash-box, e.g. "020"), `priority_receipt_ownerlogin`,
   `priority_receipt_cc_paymentcode` (default "13"), `priority_receipt_terminal` (optional).

## Architecture

- New module **`server/priorityReceipts.ts`** exporting `createReceipt(cardPaymentId)`,
  built with the `priorityRequest` helper + style of `server/priority.ts`. Builds the
  `TINVOICES` body (header + one `TPAYMENT2_SUBFORM` line; `ORDNAME` or `REFERENCE` hint)
  and POSTs it.
- New local table **`priority_receipts`**: `card_payment_id` (unique), `receipt_ivnum`
  (the `RC…` once created), `status` (`pending|created|failed`), `error`, `attempts`,
  `created_at`, `updated_at`. Mirrors the existing order-resend sweep + `findOrderByBookNum`
  idempotency patterns — reuse, don't reinvent.
- **Amount** = exactly what the PSP charged (`card_payments.amount`, already VAT-inclusive)
  — do **not** re-apply VAT. `TOTPRICE` and the payment line all equal this.

## Flow

1. `confirmCard` success (`status='paid'`, after PSP re-query) → **enqueue** a
   `priority_receipts` row (`pending`) for that `card_payment` — only if the flag is on and
   the customer is enrolled. Wire **both** call sites (order-payment confirm + debt/invoice
   payment confirm) — same enqueue.
2. A background sweep (like the order-resend sweep) picks up `pending`/`failed` rows and
   calls `createReceipt`.
3. `createReceipt` resolves linkage: order-payment → look up the approved order's `ORDNAME`;
   debt payment → read `paid_items` IVNUMs → `REFERENCE`.
4. **Idempotency:** write the deterministic `card_payment` id into `TINVOICES.DETAILS`;
   **check-before-create** (`TINVOICES?$filter=DETAILS eq '<id>'`) so a retry adopts the
   existing receipt's `RC…` instead of creating a second one.

## Error handling

Implements the #1 principle. Money is already captured, so we never block or refund. A
failed POST leaves the row `failed` with the error + increments `attempts`; the sweep retries
automatically. A standing `failed` count raises an **admin alert + counter** in the admin
panel (reuse the existing stuck-orders/alert mechanism) for **manual handling**. The enqueue
call in `confirmCard` is wrapped in try/catch and can never propagate an error into the
customer flow; receipt creation never runs inside a customer request.

## Feature flag

New `priority_receipts_enabled`, **off by default**, separate from `payments_enabled`. The
code path is fully inert until on; can be enabled for a **single test customer** first
(reuse the per-customer enforce pattern, or a one-custname allowlist setting).

## Out of scope (v1)

- `IVRECON_SUBFORM` auto-reconciliation (office reconciles on-account receipts as today;
  revisit once the office supplies a reconciled-receipt example to confirm the fields).
- Cheque / cash auto-receipts.
- The app creating the tax invoice itself (stays with the office, from the delivery note).
- Auto credit-memos / refunds.

## Testing

- **Unit** (payload builder, no network): on-account header has all mandatory fields with the
  verified constants; `TOTPRICE` + payment line = the VAT-inclusive PSP amount (no VAT
  re-applied); scenario 1 sets `ORDNAME` + no `REFERENCE`; scenario 2 sets `REFERENCE`
  (IVNUMs) + no `ORDNAME`; `DETAILS` = the card_payment id.
- **Integration** against a Priority **TEST** company only (never production): on-account
  receipt (scenario 1), invoice-hint receipt (scenario 2), double-call idempotency (second
  call adopts the same `RC…`), failure→retry.
- **Manual:** one small real end-to-end card payment with the flag on for a single test
  customer; verify the `RC…` receipt appears in Priority with the right amount + card line.

## Deliverables at the end (no flag flip, no deploy)

(a) final list of Priority config values used/needed; (b) how to run the tests; (c) exact
steps for one manual end-to-end card test with the flag on for one test customer.
