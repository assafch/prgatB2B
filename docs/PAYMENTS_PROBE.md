# Step-0 Priority Receipts Probe — verified results

> Read-only probe (`scripts/probe-tinvoices.ts`) against company `a051014` on
> `tabp008h.ini`, 2026-06-10. This is the P3 (card + check payments) dependency:
> it confirms how a portal payment is recorded as a receipt (קבלה) in Priority.
> **Verified live** unless marked otherwise.

## API-enabled forms (this API user)

`CUSTOMERS`, `ORDERS`, `OPENINVOICES`, `OBLIGO`, `AINVOICES`, `TINVOICES` — all
return 200. (OPENINVOICES/OBLIGO/AINVOICES/TINVOICES were enabled by the Priority
admin on 2026-06-10; before that they 400'd "לא ניתן להפעיל API למסך זה".)

## TINVOICES = receipts (קבלות)

`IVTYPE = "T"`. Top-level fields verified on real rows:

| Field | Meaning / sample |
|---|---|
| `IVNUM` | receipt number — `T23339` (draft), `RC269000156` (final) |
| `STATDES` | `טיוטא` = draft, `סופית` = final |
| `FINAL` | `Y` when finalized, else null |
| `CUSTNAME` / `ACCNAME` / `CDES` | customer code / account / name |
| `CASHNAME` | cash account, e.g. `020` |
| `IVDATE` | receipt date |
| `PAYDATE` | payment/value date |
| `QPRICE` / `DISPRICE` / `TOTPRICE` | amounts |
| `BOOKNUM` | **null on the sampled rows** — do NOT rely on it for webhook idempotency; use `DETAILS`/`REFERENCE` to carry the portal payment UUID instead, and confirm a queryable field before P3. |
| `OWNERLOGIN` | who created it (`Assaf`, `אורטל`) |

### Subforms (verified names — earlier guesses were wrong)

- **`TPAYMENT2_SUBFORM`** — payment-means lines (the populated one; `TPAYMENT_SUBFORM` came back empty `[]`). Verified fields: `PAYMENTCODE` (e.g. `"3"`), `PAYMENTNAME` (`"העברה בנקאית"`), `CASHNAME`, `QPRICE`, `FIRSTPAY`, `TOTPRICE`, **`PAYDATE`** (← the post-dated-check due date, שיק דחוי), plus card fields `CARDNUM`, `CCUID`, `CONFNUM`, `SHVA_TERMINALNAME`, `SHVAFLAG`, and `VALIDMONTH`. This is where a card charge or a (post-dated) check is recorded.
- **`TFNCITEMS_SUBFORM`** — invoice-matching lines (which open invoices the receipt settles). Verified fields: **`FNCIREF1`** (matched document ref, e.g. `IN244000335`), `CREDIT` (amount applied), `IVCODE`, `ORDNAME`, `ACCNAME`/`CUSTNAME`, `FNCTRANS`, `KLINE`.
- ✗ `FNCITEMS_SUBFORM` and `TINVOICESFNCITEMS_SUBFORM` → 400 (not the right names).

## Open / not-yet-verified (before writing P3)

- **Write permission**: read works; whether this API user may **create** TINVOICES is unverified — do NOT test by posting to production without sign-off. API-created financial docs typically arrive as drafts (`טיוטא`) needing manual finalization — keep that in the design (a feature for post-dated checks: hold the draft until the physical check arrives).
- **`PAYMENTDEF` → 404**: the payment-means master isn't exposed under that name. The codes we need come inline from `TPAYMENT2_SUBFORM.PAYMENTCODE`/`PAYMENTNAME` (seen: `3` = העברה בנקאית). Confirm the **check** and **credit-card** codes with the bookkeeper before P3.
- **`CASHNAME` per payment type** (`020` seen) — confirm which cash account maps to the chosen PSP and to checks.
- **OPENINVOICES → TFNCITEMS matching key**: receipts reference `FNCIREF1`; confirm it matches the OPENINVOICES document identifier the portal shows.

## Live finance confirmed working (customer 10184)

`/api/home` and `/api/invoices` now return live data: open balance **₪996** (1 open
invoice), obligo **₪37,160**, 90 finalized invoices in history. The dashboard debt
headline and invoices page render these.
