# Saved Card + Installments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card tokenization (save on payment, manage in account, later one-tap charge) and hosted-page installments (תשלומים) — all behind three independent flags, deployed inert.

**Architecture:** Extends the existing PayPlus hosted-page integration (`server/payplus.ts`, `server/cardPayments.ts`) additively. Phase 1 (save+manage) and installments need only page-level features; Phase 2 (one-tap) adds a server-to-server `Transactions/Charge` path that reuses the existing confirm/approve/receipts machinery unchanged. Tokens are AES-256-GCM encrypted at rest (cheque-image pattern) and never reach the client.

**Tech Stack:** Express + better-sqlite3 TS ESM server; vanilla TS SPA client; standalone node assert scripts against dist/ (no test framework).

**Spec:** `docs/superpowers/specs/2026-07-05-saved-card-installments-design.md`

## Global Constraints

- Flags: `installments_enabled`, `saved_cards_enabled`, `saved_card_charge_enabled` — all default `false`. Every user-visible change is gated by exactly one of them.
- **Flag-flip gates (not build gates):** `saved_cards_enabled` needs PayPlus tokenization permission on the terminal; `saved_card_charge_enabled` needs written PayPlus approval for merchant-initiated token charging (Task 0). Build everything now; flip later.
- Priority side untouched: approveOrder, receipts, payment-policy, order payloads — the one-tap path plugs into the existing `confirmCard`/success machinery, never a parallel one.
- Amounts are always server-derived (order `payment_required_amount`, invoice selection re-sum, partial cap) — `charge-saved` must reuse the same derivation code paths as the hosted flows, not duplicate them.
- Token: encrypted at rest (AES-256-GCM, key = `CARD_TOKEN_KEY` env, fallback `CHECK_IMAGE_KEY`); client only ever sees brand/last4/expiry. All saved-card endpoints `requireOwner`.
- Consent checkbox default UNCHECKED; `create_token` sent only when the customer ticked it this session.
- Installments: regular only (`credit_terms: 1`; never `payments_credit`). Transaction amount stays the full sum — reconciliation/receipts unchanged.
- After each task: `npm run typecheck` passes. New migrations additive only.
- PayPlus staging (`PAYPLUS_ENV=staging`, restapidev) for any live-ish verification; never a prod charge during development.

---

### Task 0: PayPlus verification (Assaf — not code; gates flag flips only)

**Files:** none.

Ask PayPlus (account manager / tech@payplus.co.il), for terminal `PAYPLUS_TERMINAL_UID`:
1. Enable **tokenization permission** (gates `saved_cards_enabled`).
2. Written confirmation that **storing tokens + merchant-initiated token charging** is contractually permitted (gates `saved_card_charge_enabled`); whether MIT charges need `self_secure_3ds`.
3. Enable **תשלומים** on the payment page; confirm on staging whether `generateLink.payments = N` means "customer may pick up to N" or "fixed N" (gates `installments_enabled`).
4. (Nice-to-have) Can the hosted page show saved cards for returning customers?

Record answers in this file when they arrive. Implementation tasks 1-8 do NOT wait for this.

---

### Task 1: DB — saved_cards table, payments_count column, token vault, flag registration

**Files:**
- Modify: `server/db.ts` (schema block + additive migration)
- Create: `server/tokenVault.ts`
- Modify: `server/index.ts` (SETTABLE ~line 1345, BOOL_SETTINGS ~line 1365)
- Test: `scripts/test-saved-card.mjs` (new)

**Interfaces:**
- Produces: `saved_cards` table (spec §5.1 DDL verbatim); `card_payments.payments_count INTEGER` (nullable, additive `ALTER TABLE` guarded like existing migrations in db.ts); `encryptToken(plain: string): string | null` / `decryptToken(blob: string): string | null` (base64 `[12 iv][16 tag][ct]`, key from `CARD_TOKEN_KEY` hex env, fallback `CHECK_IMAGE_KEY`, null when no key/corrupt); settings keys registered: `installments_enabled`, `saved_cards_enabled`, `saved_card_charge_enabled` (both sets) + `installments_min_amount`, `installments_max` (SETTABLE only).

- [ ] **Step 1: Failing test** — `scripts/test-saved-card.mjs`:

```js
// Run: npm run build && CARD_TOKEN_KEY=<64-hex> DATA_DIR=/tmp/scv-test node scripts/test-saved-card.mjs
import assert from 'node:assert/strict';
import { encryptToken, decryptToken } from '../dist/server/tokenVault.js';
const tok = 'pp-token-1234567890abcdef';
const enc = encryptToken(tok);
assert.ok(enc && enc !== tok, 'encrypts');
assert.equal(decryptToken(enc), tok, 'round-trip');
assert.notEqual(encryptToken(tok), enc, 'fresh iv per call');
assert.equal(decryptToken('garbage'), null, 'corrupt → null');
console.log('tokenVault: ALL PASS');
```

- [ ] **Step 2: Run to fail** — `npm run build && CARD_TOKEN_KEY=$(node -e "console.log('ab'.repeat(32))") DATA_DIR=/tmp/scv-test node scripts/test-saved-card.mjs` → export missing.

- [ ] **Step 3: Implement `server/tokenVault.ts`** (mirror `payments.ts` imageKey/encryptToFile, string+base64 instead of file):

```ts
// PSP card-token vault: AES-256-GCM string encryption. Key: CARD_TOKEN_KEY (64-hex),
// falls back to CHECK_IMAGE_KEY so no new prod secret is required. blob format:
// base64([12 iv][16 tag][ciphertext]). No key configured → null (feature dark).
import crypto from 'node:crypto';
function vaultKey(): Buffer | null {
  const hex = (process.env.CARD_TOKEN_KEY || process.env.CHECK_IMAGE_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}
export function tokenVaultReady(): boolean { return vaultKey() !== null; }
export function encryptToken(plain: string): string | null {
  const key = vaultKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decryptToken(blob: string): string | null {
  const key = vaultKey();
  if (!key) return null;
  try {
    const b = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}
```

- [ ] **Step 4: Schema.** In `server/db.ts` add the spec §5.1 `saved_cards` DDL to the schema block, and an additive guarded migration for `payments_count` following the file's existing `ALTER TABLE` pattern:

```ts
try { db.exec('ALTER TABLE card_payments ADD COLUMN payments_count INTEGER'); } catch { /* exists */ }
```

- [ ] **Step 5: Flags.** In `server/index.ts` append to SETTABLE: `'installments_enabled', 'installments_min_amount', 'installments_max', 'saved_cards_enabled', 'saved_card_charge_enabled'`; append the three booleans to BOOL_SETTINGS.

- [ ] **Step 6: Test passes; typecheck; commit** `feat(server): saved_cards schema, token vault, add-on flags`.

---

### Task 2: PayPlus client — create_token, payments, token parse, chargeToken

**Files:**
- Modify: `server/payplus.ts`
- Test: extend `scripts/test-saved-card.mjs`

**Interfaces:**
- Consumes: existing `createPaymentPage`, `parseTx`, `cfg` in payplus.ts.
- Produces:
  - `createPaymentPage` input gains `createToken?: boolean` (→ body `create_token: true`) and `maxPayments?: number` (→ body `payments: n`, only when ≥2).
  - `PayPlusTx` gains `tokenUid: string | null`, `paymentsCount: number | null`, `brand: string | null`, `expiryMonth: string | null`, `expiryYear: string | null` — extracted in `parseTx` via the existing `pick()` over the tx and its `card_information` object (candidate keys: `token_uid`/`token`, `number_of_payments`/`payments`, `brand_name`/`brand`, `expiry_month`, `expiry_year`; keep candidates broad — verified against a real staging tx in Task 8).
  - `chargeToken(input: { token: string; amount: number; ref: string; customerName: string; email?: string; payments?: number }): Promise<PayPlusTx>` — POST `{base}/Transactions/Charge` with `{ terminal_uid, cashier_uid?, use_token: true, token, credit_terms: 1, amount (2dp shekels), currency_code: 'ILS', more_info: ref, customer: { customer_name, email }, ...(payments>1 ? { payments: { number_of_payments: payments } } : {}) }`, parse the returned transaction with `parseTx(…, ref)`; throw on non-success HTTP/status like `createPaymentPage` does. **Field-name caveat from spec §2: confirm exact `payments` sub-shape on staging before Phase-2 flag flip.**

- [ ] **Step 1: Failing parse test** — append to `scripts/test-saved-card.mjs` fixture-based checks:

```js
import { parseTxForTest } from '../dist/server/payplus.js'; // export parseTx as parseTxForTest
const tx = { status_code: '000', transaction_uid: 'u1', amount: 504.1, more_info: 'REF1',
  number_of_payments: 3, card_information: { four_digits: '4580', token_uid: 'tok_abc', brand_name: 'Visa', expiry_month: '08', expiry_year: '28' } };
const p = parseTxForTest(tx, 'REF1');
assert.equal(p.tokenUid, 'tok_abc');
assert.equal(p.paymentsCount, 3);
assert.equal(p.brand, 'Visa');
assert.equal(p.expiryMonth, '08');
console.log('parseTx token/payments: ALL PASS');
```

- [ ] **Step 2: Run to fail. Step 3: Implement** (extend parseTx with the new `pick()` extractions; export `parseTx as parseTxForTest`; add the two createPaymentPage body fields; add `chargeToken`). **Step 4: Test passes; typecheck; commit** `feat(payplus): create_token + payments on page, token charge (J4), tx token/installments parse`.

---

### Task 3: Server — installments wiring

**Files:**
- Modify: `server/cardPayments.ts` (PayPlus intent creators + confirm path)
- Modify: `server/index.ts` (admin payments/history responses gain `payments_count` — check what the admin queue selects and add the column)
- Test: extend `scripts/test-saved-card.mjs`

**Interfaces:**
- Consumes: `getSetting`/`getSettingBool` (db.js), `createPaymentPage` (Task 2).
- Produces: `installmentsFor(amount: number): number | null` exported from cardPayments.ts — `null` unless `installments_enabled` && amount ≥ `installments_min_amount` (default 1000) ; else clamp(`installments_max` default 4, 2..12). All three PayPlus intent creators (debt create, partial intent, order intent — they share the PayPlus branch around cardPayments.ts:90) pass `maxPayments: installmentsFor(amount) ?? undefined`. Confirm path (`confirmCard` / the UPDATE at ~line 452) also persists `payments_count = tx.paymentsCount`.

- [ ] **Step 1: Failing test** (pure, DB-backed settings):

```js
import Database from 'better-sqlite3'; import path from 'node:path';
const sdb = new Database(path.join(process.env.DATA_DIR, 'app.db'));
sdb.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('installments_enabled','true'),('installments_min_amount','1000'),('installments_max','4')").run();
sdb.close();
const { installmentsFor } = await import('../dist/server/cardPayments.js');
assert.equal(installmentsFor(999.99), null);
assert.equal(installmentsFor(1000), 4);
assert.equal(installmentsFor(50000), 4);
console.log('installmentsFor: ALL PASS');
```

- [ ] **Step 2: fail → implement → pass.** Implementation: read settings inside the function (no caching); clamp max to [2,12]; flag off → always null. Wire `maxPayments` into each PayPlus `createPaymentPage` call; add `payments_count` to the confirm UPDATE and to the admin payments queue/history SELECTs, rendering "· ב-N תשלומים" in `src/pages/adminPayments.ts` rows when N>1 (one-line template addition).

- [ ] **Step 3: typecheck; commit** `feat(payments): installments (תשלומים) on PayPlus page — threshold+max settings, recorded per payment`.

---

### Task 4: Server — Phase 1 save & manage endpoints

**Files:**
- Modify: `server/cardPayments.ts` (create-intent options + confirm-path capture)
- Modify: `server/index.ts` (saveCard param passthrough on the 3 create endpoints; new GET/DELETE routes)
- Test: extend `scripts/test-saved-card.mjs`

**Interfaces:**
- Consumes: Tasks 1-2 (`saved_cards` table, tokenVault, `PayPlusTx.tokenUid/brand/expiry*`).
- Produces:
  - The three card create endpoints (`POST /api/payments/card/create`, `/api/payments/card/intent`, `/api/orders/:id/pay/card`) accept optional body `saveCard: boolean`; when `saved_cards_enabled` && `tokenVaultReady()` && saveCard → intent creator passes `createToken: true` and marks the card_payments row (additive column `save_card INTEGER DEFAULT 0` — add in this task, guarded ALTER like Task 1).
  - Confirm path: when a paid tx carries `tokenUid` and the row has `save_card=1` → `upsertSavedCard(userId, custname, tx)` (one card per user: `DELETE FROM saved_cards WHERE user_id=?` then INSERT with `encryptToken(tokenUid)`, brand/four_digits/expiry, `consented_at=datetime('now')`).
  - `GET /api/payments/saved-card` (requireOwner) → `{ card: { id, brand, fourDigits, expiryMonth, expiryYear } | null }` (never the token).
  - `DELETE /api/payments/saved-card` (requireOwner) → deletes the user's row, `{ ok: true }`.

- [ ] **Step 1: Failing test** — upsert/read/delete round-trip against the scratch DB using exported `upsertSavedCard`/`getSavedCard`/`deleteSavedCard` helpers (assert token stored ≠ plaintext, single row after two upserts, null after delete).
- [ ] **Step 2: fail → implement → pass; typecheck; commit** `feat(payments): save card on consent — token capture on confirm, account get/delete endpoints`.

---

### Task 5: Client — Phase 1 consent + account management + installments note

**Files:**
- Modify: `src/pages/checkout.ts` (consent checkbox in the payment section)
- Modify: `src/pages/payCard.ts` (same checkbox above the pay button)
- Modify: `src/pages/account.ts` (new "אמצעי תשלום" section)
- Modify: `server/home.ts` + `server/checkoutPreview.ts` (feature signals)

**Interfaces:**
- Consumes: `/api/home features` (existing), Task 4 endpoints.
- Produces:
  - `/api/home` `features` gains `savedCards: boolean` (flag && vault ready) and `installments: { min: number; max: number } | null` (null when flag off). `/api/checkout/preview` gains the same `installments` field (computed on `payable`: `null` unless payable ≥ min).
  - Checkout payment section (only when card method available): `<label><input type="checkbox" id="save-card"> 💾 שמור את הכרטיס לתשלומים הבאים</label>` rendered when `features.savedCards`; checked state posted as `saveCard` on `POST /api/orders/:id/pay/card`. Same pattern on payCard's `wirePay` body for `/api/payments/card/create`.
  - Installments note (passive, one line, muted) on checkout payment section and payCard when eligible: `אפשר לחלק עד N תשלומים בעמוד התשלום`.
  - Account page section "אמצעי תשלום": shows `${brand} •• ${fourDigits} · בתוקף עד MM/YY` + button `הסר כרטיס` (confirmDialog → DELETE → toast). Section hidden entirely when `features.savedCards` is false AND no card exists (a saved card remains manageable/deletable even after the flag is turned off — consent revocation must always work: fetch the card unconditionally, show section if present).

- [ ] Steps: implement → typecheck → visual verify (flag on locally, checkbox renders unchecked; flag off — nothing) → commit `feat(client): save-card consent + account card management + installments note`.

---

### Task 6: Server — Phase 2 one-tap charge endpoint

**Files:**
- Modify: `server/cardPayments.ts` (charge-saved orchestration)
- Modify: `server/index.ts` (route)
- Test: extend `scripts/test-saved-card.mjs` (amount-derivation parity)

**Interfaces:**
- Consumes: `chargeToken` (Task 2), `decryptToken` (Task 1), existing amount-derivation internals: order path (`payment_required_amount` + status/ownership guards from `createCardOrderIntent`), debt path (invoice re-sum from `/create`'s helper), partial path (cap from `createCardPartialIntent`). **Refactor rule: extract each derivation into a shared function used by BOTH hosted and one-tap paths — no duplicated validation.**
- Produces: `POST /api/payments/card/charge-saved` (requireOwner, blockIfMaintenance, cardPayLimiter, flag `saved_card_charge_enabled`):
  - Body: `{ orderId?: number; invoices?: string[]; amount?: number }` — exactly one mode.
  - Flow: load saved card (404 if none) → derive amount via the shared helpers → insert `card_payments` row (kind per mode, psp 'payplus', status 'pending', plus a new additive column `charge_source TEXT` — guarded `ALTER TABLE card_payments ADD COLUMN charge_source TEXT` in this task, value `'token'`; hosted rows leave it NULL) → `chargeToken({ token: decryptToken(...), amount, ref: id, payments: installmentsFor(amount) ?? undefined })` → regardless of the immediate result, run the existing `confirmCard(id)` re-query path so status/receipts/approveOrder flow exactly like hosted payments → respond `{ id, status, amount }`.
  - Declined/failed → row marked failed, respond 402 `{ error: 'החיוב נדחה — נסו בעמוד התשלום' }`; client falls back to the hosted flow.
  - `last_used_at` updated on success.
- [ ] Steps: failing derivation-parity test (order/debt/partial derive the same amounts the hosted intents produce for identical fixtures) → implement → pass → typecheck → commit `feat(payments): one-tap saved-card charge (Transactions/Charge), gated behind saved_card_charge_enabled`.

---

### Task 7: Client — Phase 2 one-tap UX

**Files:**
- Modify: `src/pages/checkout.ts`, `src/pages/orderPay.ts`, `src/pages/payCard.ts`

**Interfaces:**
- Consumes: `/api/home features` gains `savedCardCharge: boolean` (add in this task, server one-liner); `GET /api/payments/saved-card`; `POST /api/payments/card/charge-saved`; existing `#pay/card/return`-style success rendering (order-aware, from unified checkout).
- Produces, everywhere a card payment starts (checkout payment section, order-pay interstitial, pay/card page), when `savedCardCharge` && a saved card exists:
  - Primary button `שלם ב${brand} ••${fourDigits} · ₪X` → POST charge-saved → in-page spinner → on `status==='paid'` render the SAME success view as the hosted return page (order-aware for orders); on error → toast + reveal the hosted-page button ("תשלום בכרטיס אחר" is always visible as secondary).
  - Order flow specifics: checkout submit with saved-card selected = create order → charge-saved → success; any failure → `#order-pay/:id` (existing recovery).
- [ ] Steps: implement → typecheck → local visual check with flag on + a fake saved_cards row (charge will 4xx locally without PSP — verify the fallback renders) → commit `feat(client): one-tap saved-card payment with hosted-page fallback`.

---

### Task 8: Admin toggles, QA, staging verification, deploy (inert)

**Files:**
- Modify: `src/pages/adminSettings.ts` (3 switches + 2 number prefs)
- Modify: `QA_PLAN.md`

- [ ] SWITCH_ROWS additions (all `dangerousValue: true` — enable needs typed confirm, disable is one tap):

```ts
{ key: 'installments_enabled', name: 'תשלומים באשראי', desc: 'חלוקה לתשלומים בעמוד PayPlus מעל סף שנקבע', def: false, dangerousValue: true },
{ key: 'saved_cards_enabled', name: 'שמירת כרטיס (טוקן)', desc: 'שמירת כרטיס בהסכמה לתשלומים הבאים — דורש אישור PayPlus', def: false, dangerousValue: true },
{ key: 'saved_card_charge_enabled', name: 'תשלום בלחיצה בכרטיס שמור', desc: 'חיוב טוקן ללא הזנת כרטיס — דורש אישור PayPlus בכתב', def: false, dangerousValue: true },
```

Plus two prefs inputs (existing prefs-panel pattern): `installments_min_amount` (₪, default 1000), `installments_max` (2-12, default 4).

- [ ] QA_PLAN.md cases: flags-off regression; consent checkbox flows; account delete; installments note thresholds; one-tap happy/declined/fallback; rollback drill per flag; **staging verification checklist** (create_token round-trip on restapidev, real token charge, payments semantics) — run before ANY prod flag flip.
- [ ] Full verification: `npm run typecheck && npm run build && mkdir -p /tmp/scv-test && DATA_DIR=/tmp/scv-test CARD_TOKEN_KEY=$(node -e "console.log('ab'.repeat(32))") node scripts/test-saved-card.mjs && DATA_DIR=/tmp/scv-test node scripts/test-checkout-preview.mjs` (+ existing scripts untouched).
- [ ] Merge to main → push (Railway deploys; all three flags off → production unchanged). Post-deploy: site 200, new endpoints 401-guarded, `/api/home` features show the new keys false.

---

## Activation order (after Task 0 answers)

1. `installments_enabled` — needs only page config; verify one real payment shows the picker and the admin row records N.
2. `saved_cards_enabled` — after tokenization permission; verify one real save + card visible in account.
3. `saved_card_charge_enabled` — after written MIT approval; one real one-tap charge as sign-off (like the unified-checkout live test).

## Rollback

Each flag is an independent one-tap kill switch. Saved cards remain deletable by customers even with flags off (Task 5 requirement). No migrations to revert.
