# prgatB2B — Upgrade Plan (תוכנית שדרוג)

**Owner:** Assaf, Orgat Sahar Ltd (אורגת סחר) · **Date:** 2026-06-09 · **Status:** Approved-for-build pending the decisions in §6
**App:** Hebrew RTL B2B self-order PWA · Express 4 + TypeScript + better-sqlite3 + vanilla-TS SPA · Priority ERP via OData (company a051014) · Railway

---

## 1. Executive summary

prgatB2B today is a solid, correctly-guarded ordering portal: catalog, cart, order submission into Priority, debt/invoice views, and an admin panel — but none of the headline items from your brief (dashboard home, biometric login, payments, check OCR, AI) exist yet, and the PWA is not actually installable. This plan upgrades the app in seven dependency-ordered phases over roughly **62–86 dev-days (~3–4.5 calendar months for one developer)**: first lock the production domain and close the security holes that become fraud the moment money flows (a logged-in customer can currently order hidden SKUs at price 0); then ship the home dashboard and a real checkout; then passkeys (Face ID / fingerprint) with SMS recovery and per-payment step-up authentication; then card payments via **PayPlus** (hosted page, SAQ-A, 3DS, signed webhooks) recorded into Priority through a crash-safe local-first queue; then **instant check photography** with Claude vision OCR (amount + post-dated date, ~1–2 seconds, ~₪0.01–0.2/check) feeding a draft קבלה in Priority; then AI order suggestions, push/WhatsApp notifications, and admin collections intelligence. The architecture principle throughout: **the server is the single source of truth for price, amount, and identity — the client, the PSP webhook, and the AI model are all untrusted inputs.** Total monthly run cost excluding card fees and the optional WhatsApp channel: ~₪250–600 (~₪350–900 if WhatsApp is adopted).

### Brief-to-plan mapping

| # | Owner's brief (תקציר) | Where delivered |
|---|---|---|
| 1 | Store owner enters the app (website/PWA) | **P0**: real icons + service-worker registration → installable PWA on b2b.orgat.co.il |
| 2 | Password login + biometric (Face ID / fingerprint) | **P2**: WebAuthn passkeys (`@simplewebauthn` v13), one-tap conditional UI, SMS-OTP recovery; password stays as fallback |
| 3 | Dashboard with open debts (חובות פתוחים) | **P1**: new `#home` default landing — debt card with pay CTA, credit-limit bar, last order, suggested order |
| 4 | Simple entry to a new order | **P1**: FAB + search-first catalog + 2-tap reorder + checkout with delivery date |
| 5 | Pay after order / pay debt — card or check photo | **P3** (card via PayPlus hosted page, also Bit) + **P4** (check photo); post-order success routes straight to payment |
| 6 | Instant AI check recognition — amount + post-dated date (צ'ק דחוי) | **P4**: Claude vision, tiered `claude-haiku-4-5` → `claude-fable-5`, structured JSON, mandatory human-confirm, draft receipt in Priority |
| 7 | AI woven through the app (suggested order, similar products) | **P1** heuristic reorder card (no LLM, ships early) · **P5** similar products, NL order entry · **P6** admin churn alerts + collections briefing |
| 8 | Think of improvements + all security aspects | **P1/P5/P6** extras (templates, barcode scan, push/WhatsApp, invoice aging/PDF) · **§4** full threat model & payment launch gates · **§5** compliance |

---

## 2. Current state

**What works.** The core order loop is production-real: Priority-synced catalog with admin overrides and images, per-customer pricing, cart → `orders_local` → Priority ORDERS with the returned ORDNAME stored, order history (portal + ERP), and read-only finance views (open invoices via OPENINVOICES, obligo, customer profile). Authorization coverage is complete — every non-public route is correctly guarded, `custname` is always derived from the session (no IDOR anywhere), SQL is parameterized, login has anti-enumeration timing, and the invite-based onboarding works. RTL handling is genuinely good.

**What's missing.** Everything in the brief: there is no home dashboard (login lands on `#catalog`; debt data is buried behind the last nav item), no payment capability of any kind, no WebAuthn/biometric login, no AI anywhere, and the PWA is not installable (manifest is fine but the icons directory is empty and the service worker is an unregistered 8-line stub). There is also no checkout step (orders fire in one tap with no delivery date), no password reset, no cart badge, weak mobile ergonomics (17px tap targets, tables that overflow phones, a data-loss bug where editing a cart quantity wipes the typed order note), and technical Hebrew leakage to customers.

**Key risks.** (1) `setCartLine` accepts arbitrary partnames and `submitOrder` pushes them to Priority at `PRICE: 0` — harmless-ish today, **financial fraud the day payments exist**; this is the first fix in the plan. (2) Session tokens are stored plaintext with a 30-day TTL and no idle timeout. (3) No rate limiting on authenticated mutating routes against a 100-calls/min shared Priority quota. (4) One full-power Priority PAT (currently expired — it 401s since ~2026-05-29, blocking the receipt-form probe). (5) CSRF rests on SameSite=Lax alone. (6) Escaping is inconsistent across 8+ files and the production CSP is untested. All are remediated in P0.

---

## 3. Phased roadmap

**Ordering constraints honored:** production domain **before** any passkey enrollment and before PSP/webhook URLs are registered; security hardening **before** payments; card payments **before** check OCR goes live (checks reuse the payment-intent machinery); deterministic reorder heuristic **before** any LLM feature. PSP onboarding, the fresh Priority PAT + TINVOICES probe, the Anthropic DPA, and the SMS provider account are all **long-lead human actions kicked off in P0** so they never block a phase.

### 3.0 Design conflicts resolved (merge decisions)

The four domain designs (auth, UX, payments, AI) and the threat model disagreed in places. Resolutions, with rationale:

| Conflict | Chosen | Why |
|---|---|---|
| Step-up freshness: `payment_grants` table (auth design) vs `sessions.auth_time ≤ 10 min` (threat model §2.5) | **`payment_grants`** — 5-min single-use tokens bound to intent+amount+ref, consumed atomically | Stronger: single-use, amount-bound, and yields a per-payment signed audit record; `auth_time` is a session-wide flag that a second tab could ride |
| Session migration: hash existing tokens in place (auth design) vs invalidate all sessions on deploy (threat model R3) | **Hash in place** | Equally secure (sha256 of a 256-bit random token), zero user disruption; invalidate-all remains the fallback if migration code misbehaves |
| `last_seen` bump cadence: 5 min (auth) vs 1 hour (threat model) | **5 min, lazy** | Finer idle enforcement; one write per session per 5 min is nothing for SQLite WAL |
| Webhook with **invalid signature**: respond 400 + alert (payments design) vs always-200 (threat model) | **400 + log + admin alert** | A forged request deserves rejection and surfacing as probing; the always-200 rule applies to *valid-signature* events whose processing fails (ack fast, process async/idempotently) |
| Check tables: `payment_checks` (payments) and `check_scans` (AI) overlap | **One table: `payment_checks`**, absorbing the AI columns (`ai_raw`, `confidence_json`, `corrections_json`, `model_tier`, `image_iv`, status incl. `purged`) | One row per physical check, one lifecycle; two tables would drift |
| Audit logging: `auth_events` + `payment_events` (designs) vs unified `audit_log` (threat model §5.1) | **Unified append-only `audit_log`** (actor, action, target_type/id, ip, ua, detail_json), domain code writes through one `logAudit()` helper | One WORM-shippable table is easier to export to external storage and to query during incidents |
| Check capture: getUserMedia + overlay (UX/AI) vs `<input type=file capture>` (payments) | **File-input capture is the v1 floor; `CameraView` overlay (guide frame, torch) is the target UX — both in P4** | File input has no permission dance and works in every WebView; the overlay measurably improves photo quality, so it ships in the same phase, not later |
| Check image storage: plain webp in private dir (payments) vs AES-256-GCM encrypted (AI design + threat model) | **Encrypted at rest** (AES-256-GCM, `CHECK_IMAGE_KEY` in Railway secrets), JPEG re-encode, `$DATA_DIR/checks/`, never under `/uploads` | Check photo = bank account + signature = "especially sensitive" data under Amendment 13; platform-level volume encryption is not enough |
| OCR scan rate limit: 5/min (payments) vs 10/hour (AI/threat model) | **10/hour + 30/day per user, burst 5/min** | Vision calls cost money; a store owner never legitimately scans more |
| Password policy: ≥10 chars + top-1k list (auth) vs top-100k breach list (threat model) | **≥10 chars + offline breach list** (top-100k; an embedded top-1k subset is the acceptable v1) | No external call, better coverage |
| Saved-card re-auth: "password or passkey re-prompt" (payments) vs payment grants (auth) | **`requirePaymentGrant` on every payment endpoint** including token charges | One mechanism, one audit trail |
| UX payment statuses (`pending/processing/approved/failed`) vs payments state machine | **Payments state machine is canonical** (`created→pending→paid|promised|failed|expired`, with `promised→paid|bounced` for checks, + independent `erp_status` axis); UI labels map onto it | The state machine is the implementation; UI naming is presentation. A bounced check must be a ledger state, not just a `physical_status` flag — otherwise the payment sits `paid` forever |

---

### P0 — Production domain, deploy hygiene, security hardening (≈ 6–9 days)

**Goal:** the app lives at its forever-address, the known holes are closed, and every long-lead external dependency is in motion. **Everything else is blocked on this phase.**

Work items:
- **Domain (BLOCKER for passkeys & PSP):** point **b2b.orgat.co.il** at Railway, HTTPS live. Env: `RP_ID=b2b.orgat.co.il` (exact host, **not** the apex — the apex registrable domain also serves the production WordPress/WooCommerce site, the softest asset on the domain, and an apex RP ID would let any compromised sibling subdomain run WebAuthn ceremonies against B2B credentials; a future host move costs a re-enrollment campaign, which is acceptable), `WEB_ORIGIN=https://b2b.orgat.co.il`. WebAuthn routes return `503 webauthn_not_configured` unless RP_ID is set and the host matches — premature passkey enrollment is *impossible*, not just discouraged. — **S**
- **R1 (P0, fraud-enabler):** `server/orders.ts` — `setCartLine` rejects partnames that are not active + `b2b_visible` (400); `submitOrder` re-validates every line and refuses null/zero-price lines (prefer omitting `PRICE` so Priority computes from the price list). Regression tests: fake partname → 400; since-hidden item → rejected. — **S**
- **R2:** per-user (not per-IP) rate limiters: `POST /api/orders` 5/min + 30/day; `PUT /api/cart/lines` 60/min; finance reads 20/min; admin uploads 10/min; per-account login backoff (exponential lock after 5 failures, `failed_logins`/`locked_until` columns) **plus per-IP (e.g., 20/min) and global throttles on `POST /api/auth/login`** — per-account locking alone leaves one IP free to spray a single password across many usernames (credential stuffing). — **S/M**
- **R4:** global Origin/Referer same-origin middleware on all mutating `/api` routes (`APP_ORIGIN` env); payment/passkey routes additionally JSON-only. — **S**
- **R3 / session hardening:** rebuild `sessions` → store `sha256(token)` (`token_hash`), migrate existing tokens in place; TTLs: customers 14d absolute / 3d idle, admins 12h / 30min; lazy `last_seen_at` (5-min granularity); rotation on login/password-change; revoke-others on password change; expired sweep on boot + daily. New endpoints: `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/sessions/revoke-others`. `src/api.ts`: on 401, stash `location.hash` and restore after re-login (fixes the mid-order bounce). — **M**
- **R5:** unify `escapeHtml` (delete the 6 duplicates, add `escapeAttr`), remove inline `onclick` handlers (admin.ts:152,196), self-host Heebo, fix and *test* the prod CSP locally (`NODE_ENV=production`). — **M**
- **R6:** redact ERP error bodies (status + 200 chars, fields stripped); **issue a fresh least-privilege PAT on a dedicated portal API user** (isolates the 100/min quota from the WooCommerce bridge); request per-form scoping from the Priority admin; remove `ADMIN_BOOTSTRAP_*` from Railway env post-bootstrap; delete dead `SESSION_SECRET`. — **S + human**
- **R8/R9:** server-side username/password policy; `app.use('/api', notFoundJson)` before the SPA fallback; global error handler with request IDs. — **S**
- **Supply chain (S):** lockfile committed and pinned, `npm audit` + dependency review wired into CI, documented dependency-update policy — a payments+passkeys app cannot ship without this; enforced again at the §4.2 gate.
- **PWA installability (R10 rules apply):** generate real 192/512 maskable icons, register `sw.js` with cache-first **static assets only**, network-only for `/api/*` and `/uploads`, versioned cache + "גרסה חדשה זמינה — רענון" update toast. Never cache authenticated responses. — **S/M**
- **Backups:** Litestream WAL replication to R2/B2 (client-side encrypted, write-only key) + nightly `VACUUM INTO` snapshot (30d retention) + **one rehearsed test restore**. Litestream covers SQLite only — the backup design also includes (activated in P4) an **encrypted object-storage sync of `$DATA_DIR/checks/`** to the same bucket, because volume loss must not destroy the only evidence behind promised-check receipts. — **M**
- **Kick off in parallel (human, long-lead):** PayPlus merchant onboarding + sandbox (negotiate with Cardcom's published 0.9%/1.2% as leverage); Priority admin ticks **TINVOICES** as API-enabled in Limited Access/API Forms; run the **Step-0 probe** (`scripts/probe-tinvoices.ts`): `GetMetadataFor(entity='TINVOICES')`, `GetMetadataFor(entity='PAYMENTDEF')`, `TINVOICES?$top=2&$expand=…` to confirm subform names (expected TPAYMENT_SUBFORM / TPAYMENT2_SUBFORM / TFNCITEMS-style), the OPENINVOICES matching column (FNCIREF vs IVNUM vs DOCREF), **and `TINVOICES?$filter=BOOKNUM eq '…'` — the BOOKNUM-dedupe lookup P3 depends on, on a tenant where some `$filter` expressions are known to 500**. **Never reuse order-to-priority's guessed RECEIPTS/KACNUM/CHECKS_SUBFORM names — explicitly unconfirmed.** Sign the Anthropic commercial DPA + zero-retention workspace; open the 019 SMS account; book the privacy attorney (§5).

**Acceptance criteria:** app serves only from b2b.orgat.co.il; fake-partname PUT returns 400 and a hidden-SKU order is refused; sessions DB contains no plaintext tokens; CSP passes with zero violations on all routes; Lighthouse reports installable PWA; restore-from-backup demonstrated; fresh PAT works and probe results documented.
**Security gate:** R1, R2, R4 merged before any P1 code; no payment code may be written before the Step-0 probe results exist.

---

### P1 — Customer dashboard & order UX (≈ 12–16 days)

**Goal:** the owner's brief items 3, 4, and 7 (heuristic part) visibly work: login lands on a debt-first home screen, ordering is a thumb-friendly 2-tap flow with a real checkout, and the app suggests the usual basket — all before any money or AI-model risk.

Work items:
- **Shell (M):** `src/ui/` component set — `BottomNav` (5 tabs, cart badge, safe-area), `Toast`, `Sheet`, `ConfirmDialog` (kills native `confirm()/alert()`), `QtyStepper` (44×44px, step = box_size), `StatusChip`, `Skeleton`, `EmptyState/ErrorState` with retry, `MoneyStat`, `ProgressSteps`, `DateChips`. `src/main.ts`: cache `state.me` (stop re-fetching `/api/auth/me` on every hashchange; refresh on `visibilitychange`/401); **default landing → `#home`**.
- **`#home` (L):** new `GET /api/home` aggregate (balance, obligo, last order + status, suggestion, promos, unpaid count — one round-trip). Finance reads served from the existing cache with **explicit TTLs — balance/obligo and unpaid count cached 10 min, busted immediately on payment events** — so a morning login burst never dents the shared 100/min Priority quota. Debt card (red; green "אין חוב פתוח ✓" otherwise; "באיחור" badges), credit-utilization bar (amber >90%), last-order card with one-tap "הזמנה חוזרת", suggested-order card, promotions rail (`b2b_featured` finally surfaced), quick actions, FAB "הזמנה חדשה". **All pay CTAs ("לתשלום עכשיו" → `#pay/debt`) ship behind a `payments.enabled` feature flag and stay hidden until P3 is live — no dead payment buttons in the weeks between P1 and P3.**
- **Heuristic reorder (M, no LLM):** `server/ai/reorder.ts` — pull ORDERS+ORDERITEMS history (12 months) per customer via existing `loadAllFromPriority`; per (custname, partname): median interval, median qty snapped to box_size, `due_score = days_since_last / median_interval`; nightly job + lazy refresh → `reorder_suggestions` table → `GET /api/ai/reorder` + `POST /api/ai/reorder/add-all` (adds to cart and routes to `#cart` — **never auto-submits**). Hidden until ≥2 past orders. Cost ₪0; also feeds P6 churn data.
- **Cart + checkout (M+M):** cart line edits patch DOM only (fixes the note-wipe data-loss bug); credit-limit awareness (soft warn ≥90%, configurable hard banner over limit); min-order bar; CTA → **new `#checkout`**: delivery-date `DateChips` driven by `settings.order_cutoff` + Israeli work-week/holidays (**seeded `il_holidays` table generated from `@hebcal/core`, admin-editable — no runtime external calls**), live cutoff countdown, review summary, submit → success screen that **routes to payment** ("לתשלום ההזמנה ←" / "תשלום מאוחר יותר") instead of dead-ending — payment CTA behind the same `payments.enabled` flag, hidden until P3.
- **Catalog/product (L+M):** sticky debounced search (kills the search button), family chips, "הוזמן לאחרונה" sort (`GET /api/catalog?sort=recent`), QtySteppers, scroll/state restore; product page collapses to one column <640px, sticky add bar, "מוצרים דומים" rail placeholder (deterministic same-family until P5).
- **Orders + invoices (M+M):** unified order card list (portal+Priority merged by ORDNAME) with `StatusChip` + per-row "הזמנה חוזרת" diff Sheet; order detail gets a status timeline mapped from `ORDSTATUSDES`; invoices get aging chips (computed from CURDATE + CUSTOMERS.PAYCODE terms — OPENINVOICES has no due-date field, probe-verified), mobile cards, per-row "שלם" (wired in P3, flag-hidden until then) and `GET /api/invoices/:iv/pdf` (server-proxied Priority print/attachment, auth-gated — needs a small Priority probe; degrade gracefully if unavailable).
- **Hebrew copy pass (S):** single source `src/copy.ts` + `errorToHebrew(code)`; nominal verb forms on buttons (התחברות, שליחה, הוספה לסל); kill technical leakage ("אדמין… Priority", CUSTNAME placeholders); rename admin invites to "הזמנות הצטרפות".
- **Accessibility statement page `#accessibility` (S)** — legally required (ת"י 5568), cheap, ships now; the full audit lands in P6.

**Acceptance criteria:** post-login screen shows real open-debt total and one-tap reorder; an order can be placed cart→checkout→delivery-date→success in <60s on a phone; cart note survives quantity edits; all tap targets ≥44px on the core flow; zero raw English/HTTP errors visible to customers; no visible payment CTA anywhere while `payments.enabled` is off.
**Security gate:** new `GET /api/home`/reorder endpoints are `requireCustomer`-guarded and session-custname-scoped; suggestion output filtered to active+visible catalog only.

---

### P2 — Auth upgrade: passkeys, recovery, roles, step-up (≈ 10–13 days)

**Goal:** brief item 2 — Face ID / fingerprint login — plus the identity infrastructure payments will demand. Internal order: SMS/OTP → passkeys → admin 2FA → multi-user roles → payment grants (grants land last and immediately unblock P3).

Work items (full detail in the auth design; summarized):
- **SMS OTP (M, ~2–3d):** new `server/sms.ts` (`SMS_PROVIDER=019|inforu|twilio|console`) + `server/otp.ts` (6 digits via `crypto.randomInt`, sha256 at rest, 5-min TTL, single-use, 3 attempts, never logged) + `otp_codes` table. Flows: recovery (`/api/auth/recovery/start|verify|reset` — generic 200 always, no enumeration; recovery mints a **`scope:'recovery'`** session that can *only* set a password/enroll a passkey — it cannot browse, order, or pay, which is the SIM-swap containment), login MFA (`/api/auth/login/mfa`), phone verification at enrollment. Phone source of truth = the Priority customer record, **validated at enrollment: Israeli grocery CUSTOMERS records frequently hold a store landline, so if the record's number isn't a valid mobile, the user verifies a mobile via OTP at enrollment and it is stored as the auth phone (flagged for the admin to sync back to Priority). An admin-assisted recovery path (admin verifies identity by phone, then issues a one-time reset link) covers users who never enrolled a mobile — exactly the least technical customers.** New `src/pages/recovery.ts` (`#forgot`).
- **Passkeys (L, ~4–6d):** `@simplewebauthn/server` v13.x + `/browser`; discoverable credentials (`residentKey:'required'`), attestation `none`, platform authenticator preferred. Tables: `webauthn_credentials` (multiple named passkeys per user — owner's iPhone + clerk's Android + store tablet), `auth_challenges` (single-use, 2-min TTL). Endpoints: `GET /api/auth/capabilities`, `POST /api/webauthn/register/options|verify` (requireAuth; SMS-notifies "נוסף אמצעי כניסה חדש"), `POST /api/webauthn/login/options|verify` (usernameless, loginLimiter; counter anomalies logged not fatal — synced passkeys report 0), passkey list/rename/revoke. Frontend: conditional-UI autofill on `#login`, visible "כניסה עם Face ID / טביעת אצבע" button, post-password-login enrollment interstitial (`src/pages/enrollPasskey.ts`), `#settings/security` (`src/pages/securitySettings.ts`) with passkey + device/session management. WebAuthn login flows through the same session-creation path (status check, custname hydration) as password login.
- **Admin hardening (S–M, ~1–1.5d):** `requireAdmin` rejects plain-`password` sessions (must be `passkey` or `password_mfa`); first admin login forces OTP enrollment; optional `ADMIN_IP_ALLOWLIST` (CIDRs); unified `audit_log` live from this phase, surfaced in a new `#admin/security` tab (12-month retention); bootstrap-password warnings.
- **Multi-user per store (M, ~2d):** `users.customer_role` `owner|orderer` (existing users default `owner`). New `requireOwner` guard on `/api/account`, `/api/invoices`, all future `/api/payments/*`, and sub-user management. Owner-issued invites pre-bound server-side to the owner's custname (`/api/customer/users*`); orders list becomes custname-scoped with "הוזמן ע״י"; topbar/route gating by `customerRole` (UI convenience; server is the enforcement point). **Automated route×role test matrix** — this is the regression net.
- **Payment grants (M, ~1.5d):** `payment_grants` table; `POST /api/auth/stepup/options|verify` — fresh WebAuthn assertion with `userVerification:'required'` (Face ID at the moment of payment, even mid-session) → 5-min single-use grant bound to `{intent, amount, ref}`; **fallback for accounts without a usable passkey: SMS-OTP step-up — and that is the floor. Password re-entry alone never mints a payment grant (a phished password must not be able to move money).** New guard `requirePaymentGrant(intent)` + reusable `src/components/stepup.ts` modal. Alert on first payment from a passkey enrolled <24h ago.

**Acceptance criteria:** Face ID login works on iOS 16+ Safari/installed-PWA and Android Chrome; password+forgot-password fully self-service (including the landline-record case via enrolled mobile or admin-assisted reset); an `orderer` user receives 403 on every finance/payment route (test matrix green); admin cannot operate on password alone; a payment grant cannot be reused or applied to a different amount; a payment grant cannot be minted by password re-entry.
**Security gate:** challenges single-use; credential resolved by ID from our table; RP ID bound to the exact production host; registration requires a fresh authenticated session and notifies via SMS; recovery scope cannot reach money.

---

### P3 — Card payments via PayPlus (≈ 12–15 days)

**Goal:** brief item 5a — pay for the just-placed order or selected open invoices by card (and Bit), recorded into Priority as a receipt, with the customer experience never blocked by ERP availability.

**Architecture (non-negotiable):** local-first, ERP-second — secure the money → persist in SQLite → post to Priority from a serialized retry queue → reconcile. All money in **integer agorot**. Client sends references, never amounts. SAQ-A only: PayPlus hosted page (redirect; iframe optional later), **no Hosted Fields**, no card field in our DOM, ever.

Work items:
- **Schema (S):** `payments` (uuid id = idempotency key, round-tripped into PSP `more_info` and Priority BOOKNUM/DETAILS; status machine `created→pending→paid|promised|failed|expired` with `promised→paid|bounced` for checks (P4), + independent `erp_status` axis `none→queued→posting→posted|needs_admin|manual_posted`), `payment_allocations` (per-invoice applied amounts; snapshot of open amount), `saved_cards` (PSP token UID + last4/brand/exp only — no PAN), `webhook_events` (UNIQUE(psp, event_uid) replay shield), `refunds`, `orders_local.paid_payment_id` via ensureColumn. All transitions through one `transition(id, from[], to, actor)` compare-and-set inside a transaction.
- **`server/payplus.ts` (M):** `generateLink` (`charge_method: 1` J4; **3-D Secure enabled on the hosted page — confirm the flag/account default and the liability shift in sandbox during onboarding**; `language_code:'he'`; `create_token: true`; `allowed_charge_methods: ['credit-card','bit']`; `more_info: payment.id`; 30-min page expiry aligned to intent), charge-by-token, refund, transaction lookup, token remove, HMAC helper.
- **`server/payments.ts` (L):** intent creation (order: amount recomputed from `orders_local` lines; debt: re-fetch OPENINVOICES for the session custname, validate every ref, clamp `0 < applied ≤ open` ±1 agora VAT tolerance; credit-memo offset allowed but **net total to PSP must be > 0**), Idempotency-Key header support, one non-terminal intent per target, sweeper, finance-cache bust on `paid`. **Local-settlement overlay (critical):** API-created receipts arrive in Priority as drafts (טיוטא) and do **not** reduce OPENINVOICES until the bookkeeper finalizes — so the invoice/debt/home views **subtract local `paid`/`promised` allocations and label those invoices "שולם בפורטל — בעיבוד"**, and intent creation **rejects invoices already carrying a live local allocation** until reconciliation confirms the ERP side. Without this, a customer sees "paid" next to an unchanged debt and — since `paid` is terminal — could open a second intent on the same invoice (double payment).
- **Webhook (M, security-critical):** `POST /api/payments/webhook/payplus` registered with `express.raw` **before** `express.json`; verify `hash` header = base64-HMAC-SHA256(raw body, `PAYPLUS_SECRET_KEY`) via `timingSafeEqual`; invalid → 400 + audit + admin alert; replay → dedupe no-op; even valid events **cross-check amount/currency/page_request_uid** against the local intent (mismatch → `needs_admin`, never paid); respond <2s, heavy work queued. **Plus the 5-min reconciliation poller** querying PayPlus by `page_request_uid` for stale `pending` intents — lost webhooks, closed tabs, and our downtime are all covered; `pending` >24h with no PSP record → `expired`. **Chargebacks/disputes:** PSP chargeback events (webhook where supported, daily transaction-lookup sweep otherwise) flip the payment's `erp_status` to `needs_admin`, surface a dispute item in `#admin/payments` with the evidence trail (audit_log, allocation snapshot), and any ERP reversal stays a manual bookkeeper action (credit/reversal docs are deliberately out of API scope).
- **ERP posting — `server/erpPost.ts` (L):** serialized queue (concurrency 1, backoff 1m→2h, 8 attempts, 2–5 OData calls per receipt). **Design B ships first regardless of the probe:** local ledger + `#admin/payments` "לרישום בפריוריטי" queue with everything the bookkeeper needs + `mark-posted {ivnum}`. **Design A (auto-post) activates when the Step-0 probe confirms TINVOICES** (including the `$filter=BOOKNUM` lookup — the crash-safe dedupe queries by BOOKNUM before posting, and that filter is itself probe-verified, not assumed): POST header with `BOOKNUM: payment.id`, card line to a TPAYMENT2-style subform with **`CASHNAME` derived from the PSP's card-brand field via a bookkeeper-confirmed PAYMENTDEF mapping table** — the only production-proven pair (`PAYMENTCODE:'10'`, `CASHNAME:'101'`) comes from the WooCommerce bridge's ויזה כאל rail; `'101'` is the Visa CAL code specifically, and hardcoding it would misbook Isracard/Mastercard/Amex receipts. **Bit requires its own payment-means code — added to the §6 #2 bookkeeper decision.** Invoice matching to the confirmed TFNCITEMS-style subform — **matching failure never rolls back** (unmatched on-account receipt still records the money; bookkeeper matches in סילוקין). EINVOICES (fully verified, has ORDNAME header) is the switchable fallback **for pay-at-order only** via `settings.erp_receipt_doc`. API-created documents arrive as drafts (טיוטא) — finalization stays with the bookkeeper.
- **Frontend (L+S+S):** `src/pages/pay.ts` (method picker; debt mode with invoice multiselect, oldest-first prefill, partial amounts, locally-settled invoices shown as "שולם בפורטל — בעיבוד" and unselectable; saved-card one-click), `payReturn.ts` (poll `GET /api/payments/:id`, success/failure; the confirmation is labeled "אישור תשלום — אינו מסמך חשבונאי"; the קבלה number appears when `erp_status='posted'`), `adminPayments.ts` (payments list, ERP queue, disputes, refunds), CTAs on cart success / invoices / account / home debt card (the `payments.enabled` flag from P1 flips on here). Saved-card management `GET /api/cards` / `DELETE /api/cards/:id`.
- **Every customer payment endpoint sits behind `requireCustomer` + `paymentsLimiter` (10/min/user) + `requirePaymentGrant`.** Refunds are admin-only, step-up-gated, ERP side always `needs_admin` (credit/reversal docs were never probed — deliberately out of API scope).

**Acceptance criteria:** sandbox E2E: pay an order and a multi-invoice debt selection by card (with 3DS challenge) and by Bit; forged/replayed/amount-tampered webhooks provably rejected (tests); Priority down during payment → customer unaffected, receipt posts on retry or lands in the admin queue; after payment the dashboard and invoice views immediately reflect the money via the local-allocation overlay ("שולם בפורטל — בעיבוד") and the same invoice cannot be paid twice, even though the draft receipt has not yet reduced OPENINVOICES; a simulated chargeback lands in `needs_admin` with an admin dispute item; refund flow works.
**Security gate (blocking):** §4 gate items 1–14 all green; SAQ-A data-flow diagram (no PAN on our origin) signed off; CSP `frame-src`/`form-action` restricted to the PSP origin.

---

### P4 — Check-photo AI: instant OCR + reconciliation (≈ 8–11 days)

**Goal:** brief items 5b + 6 — photograph a check (including post-dated, צ'ק דחוי), have the amount and due date read **instantly** by AI, confirmed by the human, recorded as a draft receipt in Priority, and reconciled when the physical check arrives. This is **record-keeping / promise-to-pay**, not remote deposit capture — the physical check still rides with the driver.

Work items:
- **AI infra first (S):** `server/ai/client.ts` (`@anthropic-ai/sdk`, `ANTHROPIC_API_KEY` server-only), feature flags in `settings` (`ai.check_ocr`, `ai.master`, …), `ai_usage` token/cost logging per call, circuit breaker (5 failures/5 min auto-disables the flag + admin alert).
- **Capture (`#pay/check`, L):** v1 floor `<input type="file" accept="image/*" capture="environment">`; target UX `CameraView` (getUserMedia, 2.2:1 guide frame, torch, Hebrew guidance), multi-check loop. Client preprocessing: `createImageBitmap` (EXIF orientation) → canvas downscale ≤2048px → JPEG q0.85 (canvas re-encode strips all EXIF incl. GPS) → ≤3MB upload. **Hebrew privacy notice on the camera screen** (what, why, retention, AI processor under contract — Amendment 13 duty).
- **Extraction (`server/ai/checkOcr.ts`, M):** `POST /api/checks/parse` (multer memory, 8MB server cap, sharp magic-byte validation + `limitInputPixels`, re-encode). One Messages call, **structured outputs** (`client.messages.parse()` + `zodOutputFormat`) returning amount-digits, Hebrew amount-words + parsed value, date, payee, bank/branch/account, check number, per-field confidence, `is_check`, legibility issues. **The prompt starts from the production-tested Israeli check prompt `getCheckParsePrompt` (order-to-priority `server/prompts.ts:93`) and its ParsedCheck shape, adapted to structured outputs — not written from scratch.** **Tier 1: `claude-haiku-4-5`** @ ≤1568px ≈ **$0.003/check (~₪0.01), 1–2s**. **Escalate to `claude-fable-5`** @ ≤2576px (~$0.05–0.06, 2–4s) when any confidence <0.90, digits≠words, or bank-code validation fails; `CHECK_OCR_SINGLE_TIER=fable` switch for low volume. Max 2 LLM calls per image, 3 images per attempt; 15s timeout; on AI failure → manual-entry form (photo still attached) — **payment recording is never blocked by the AI being down**. Note: Israeli MICR is **CMC-7, not E-13B** — US-centric OCR products don't fit; the vision LLM reads digits optically and handles handwritten Hebrew in the same pass. Fable 5 API quirks honored: omit `thinking` entirely for extraction; no temperature.
- **Deterministic server validation (never trusts the model):** digits ↔ Hebrew-words agreement (server runs its own words parser as a third vote); date parses, ≤12 months future / warn >6 months past, `is_postdated` computed server-side; bank code on the seeded `il_banks` Bank-of-Israel list; branch/account format; amount-vs-selected-debt comparison server-side (warn, not block — partials exist); **duplicate hard-block via a partial unique index on `(bank_code, branch, account, check_number)` scoped to live statuses** — a failed/abandoned/bounced row must not block legitimate resubmission of the same physical check. Prompt-injection defense: zero tools, schema-locked output, all in-image text is data, every output field validated/escaped/length-capped, nothing model-produced executes or writes to Priority without human confirm.
- **Confirm screen (`#pay/check/:id/confirm`, M):** photo beside editable prefilled fields; low-confidence fields highlighted and require an explicit tap; **amount + date always require active confirmation**; "צ'ק דחוי — N ימים" badge; every human correction logged (`corrections_json`) → production accuracy metric. Confirm is gated by `requirePaymentGrant('check_submit')`. On confirm: intent → **`promised`** (kind=check — it transitions to `paid` only when the check clears, or to `bounced`; "paid-as-promise" is a state, not an overload of `paid`), `payment_checks.physical_status='promised'`, ERP queue posts the **draft TINVOICES receipt** with per-check TPAYMENT-style lines (`PAYDATE` = the post-dated due date — exactly how Priority encodes שיק דחוי; field set live-verified on the EINVOICES analogue). **Same probe gate as P3: if the TINVOICES probe fails, check receipts land in the Design-B bookkeeper queue — the EINVOICES fallback applies to pay-at-order only; using it against existing debt would double-bill.** Success copy: "השיקים נקלטו כהתחייבות תשלום — נא למסור את השיקים לנהג."
- **Storage & retention:** AES-256-GCM-encrypted images in `$DATA_DIR/checks/`, served only via owner-gated/admin-gated routes, every view audit-logged; the directory is synced encrypted to the P0 backup bucket (SQLite replication alone would lose the only evidence behind promised-check receipts); nightly cron **crypto-shreds the image 90 days after clearing** (180 days if never cleared), keeping only extracted fields (Priority is the system of record); `PRAGMA secure_delete=ON`.
- **Reconciliation loop (`#admin/payments` checks view, in adminPayments):** `payment_checks.physical_status`: `promised → received` (admin compares physical check to photo) `→ deposited` (deposit itself stays a back-office Priority action — deposit forms never probed; this also triggers the bookkeeper to finalize the draft receipt; clearing flips the payment intent `promised → paid`) `→ bounced` (payment intent `promised → bounced`; the local allocation overlay is released so the debt resurfaces via OPENINVOICES, customer notified, optional auto-block of the check method) / `returned`. Owner dashboard tile: `OBLIGO.CHEQUE_DEBIT` ("שיקים פתוחים") + promised-but-undelivered chase list.

**Acceptance criteria:** check photographed → parsed fields on screen in <5s; post-dated date correctly extracted and badged; duplicate photo of the same check hard-blocked, but resubmission after a failed/bounced attempt succeeds; image unreadable → graceful manual entry; image inaccessible via any public URL; retention cron verified deleting a cleared check's image; a bounced check flips the intent to `bounced` and the debt reappears; pilot with ~5 friendly customers before general enablement, thresholds tuned from correction logs.
**Security gate:** Anthropic DPA + zero-retention confirmed; `CHECK_IMAGE_KEY` provisioned and backed up off-Railway; `il_banks` seeded; privacy notice approved by Assaf; AI spend cap + kill-switch live.

---

### P5 — AI suggestions (LLM layer), push & WhatsApp (≈ 8–12 days)

**Goal:** brief item 7 fully delivered, plus the notification channels Israeli B2B actually reads.

- **Similar products / substitutions (S):** `claude-haiku-4-5`, structured output `{suggestions:[{partname, reason_he}]}`, input = target product + same-family candidate set (names/SKUs only — PII-free); cached per `(partname, catalog_version)` in `similar_products_cache`; server filters output against active+visible catalog (kills hallucination and injection in one move); deterministic same-family fallback. Powers the product-page rail and out-of-stock substitution.
- **Web Push (M):** VAPID keys, SW `push` handler, `push_subscriptions` table with **endpoint-host allowlist** (FCM/APNs/WNS/Mozilla only — otherwise web-push is an SSRF primitive), 5 subscriptions/user cap. Permission asked **in context** (after first successful order), never on load. Events: order approved / shipped / delivered, payment received, debt reminder, check due soon, new promotion — driven by a 5-min Priority status poller diffing `ORDSTATUSDES` into a `notifications` outbox. **Payload minimization:** "יש עדכון בחשבונך" — never debt amounts on a lock screen.
- **WhatsApp (M, decision §6):** WABA via a BSP (Twilio/Glassix-class), pre-approved Hebrew templates, opt-in per event; fallback channel when no push subscription. `#settings/notifications` channel×event matrix.
- **NL order entry (M, nice-to-have):** "כמו שבוע שעבר בלי החלב" → `claude-fable-5`, `thinking:{type:"adaptive"}`, SDK tool runner with three **read-only** tools (`search_catalog`, `get_recent_orders`, `get_current_cart`) all internally scoped to the session custname; output = **draft cart only, never an order**; every partname re-validated server-side, qty snapped to box_size; max 8 turns / 30s; prompt-cached system prefix; 10/hour/user. Voice via Web Speech API (he-IL) where available; iOS uses keyboard dictation.

**Acceptance criteria:** push arrives on an installed PWA when an order ships; suggestion rails never show hidden/inactive SKUs; NL drafts land in the cart with unmatched items listed in Hebrew; AI features all degrade gracefully when flags are off.

---

### P6 — Admin AI, power features & polish (≈ 6–10 days)

- **Churn-risk alerts (S, deterministic):** customer-level cadence from the P1 reorder data; flag at 0.5×/1.5× median-interval overdue; `GET /api/admin/ai/churn` + dashboard card.
- **Collections briefing (S/M):** nightly `claude-fable-5` call (top debts + aging + broken check promises + churn flags → `{summary_he, priorities[], anomalies_he[]}`), cached, `#admin/briefing` tab, regenerate 5/day. ~₪14/month. Anomaly hooks: reused check numbers, promise≠debt amounts, first payment from a new passkey.
- **Barcode shelf-restock `#scan` (L):** `BarcodeDetector` + `@zxing/browser` fallback (iOS), lookup `GET /api/catalog/barcode/:ean`, continuous scan loop with haptics, unknown-EAN logging for the admin.
- **Templates & favorites (M + S/M):** `templates`/`template_lines`, `favorites` tables; "שמירה כתבנית" from cart or any past order; favorites chip in catalog.
- **Accessibility audit (M):** full ת"י 5568 / WCAG 2.0 AA pass — contrast fixes (darken `#6b7280` muted text), focus traps, `aria-live` on badges/toasts, VoiceOver (Hebrew) + NVDA documented test pass — **before broad public rollout**.
- Misc: invoice "קבלות" history tab, admin daily-summary email when the ERP queue is non-empty (via a transactional email provider — Postmark/Resend-class, free tier covers this volume; provider picked in this phase), HSTS preload submission.

---

## 4. Security architecture

### 4.1 Threat model — condensed (full STRIDE analysis maintained alongside this plan)

| Surface | Decisive controls |
|---|---|
| **PSP webhook** (most dangerous new surface — a forged "paid" credits a debt) | HMAC-SHA256 signature over raw bytes (a deciding factor in the PSP choice — signed-webhook behavior verified in sandbox during onboarding); **never trust transport alone**: amount/currency/uid cross-checked against the local payment intent, plus a 5-min server-to-server reconciliation poller; replay shield `UNIQUE(psp, event_uid)`; forward-only state machine; intents expire in 30 min; webhook flood limiter + fast-ACK idempotent processing; chargeback/dispute events routed to `needs_admin` + admin workflow |
| **Payment integrity** | Payment-intent pattern: amount fixed server-side in agorot from Priority/local data — the client never supplies an amount; Idempotency-Key + one non-terminal intent per target **+ invoices with live local allocations blocked from new intents** (draft receipts don't reduce OPENINVOICES — without the block, a paid invoice stays payable); 3-D Secure on the hosted page (liability shift); ERP posting deduped via BOOKNUM lookup (crash-safe, filter probe-verified); R1 cart fix means a PRICE=0 line can never reach Priority (alert if one ever does) |
| **Check images** (bank account + signature — the most sensitive data the app will hold) | Multipart bytes only (no URLs — no SSRF); magic-byte + sharp decode/re-encode (destroys polyglots, strips EXIF); UUID names, AES-256-GCM at rest, **never under `/uploads`**; access owner-or-admin only, every view audit-logged; encrypted off-site backup of the image directory; retention-bounded crypto-shredding; AI result advisory-only with human confirm; duplicate-check hard block (partial index, live statuses only) |
| **AI endpoints** | Prompt injection (text written on a check, product names) neutralized by: zero tools on extraction calls, schema-constrained output, all model output treated as untrusted input with deterministic range/format validation, suggestions filtered to the active catalog, `escapeHtml` on all rendered model text, no LLM-to-LLM chaining; per-user quotas + global daily spend cap + kill-switch flags + circuit breaker |
| **WebAuthn** | `@simplewebauthn` (no hand-rolled CBOR); single-use 2-min challenges stored server-side; user resolved by credential ID from our table; origin + rpIdHash verified against the final domain; RP ID pinned to the exact production host (not the apex — the apex hosts the WordPress site); registration bound to a fresh authenticated session + SMS notification; passkey login passes the same status/custname checks as password login |
| **Sessions & step-up** | Tokens hashed at rest; 14d/3d (customer) and 12h/30min (admin) TTLs; rotation on login/password-change; device list + remote revocation; **money moves only with a fresh step-up — a `userVerification:'required'` WebAuthn assertion, or SMS-OTP for accounts without a passkey, never password re-entry alone — minting a 5-min single-use amount-bound grant** — neutralizes shared store phones, synced-passkey cloning, stolen sessions, and phished passwords |
| **Roles** | Deny-by-default matrix: `orderer` never reaches finance/payments; owner invites server-bound to own custname; every new table carries `user_id`+`custname` filtered from session (the existing no-IDOR discipline, extended); automated route×role test |
| **Admin & ERP blast radius** | Mandatory admin 2FA; ERP error bodies redacted; dedicated least-privilege portal PAT, rotated at go-live + quarterly; application-level egress allowlist — all outbound HTTP through one wrapped fetch/agent restricted to Priority + PSP + Anthropic + push-service hosts (Railway has no outbound firewall, so this control lives in-app); write-volume anomaly alerts |
| **Web push** | Endpoint-host allowlist (anti-SSRF), payload minimization, per-user cap, prune on 404/410 |
| **Supply chain** | Pinned lockfile, `npm audit` + dependency review in CI, documented update policy — passkey + payment code paths treat dependency updates as security-relevant changes |

**Data security:** Railway volume encryption verified and documented (platform layer); application-level encryption for check images; `PRAGMA secure_delete=ON` on payment/bank tables; Litestream (RPO ≈ 15 min) + nightly snapshots + encrypted replication of the check-image directory, all client-side-encrypted, **quarterly test restores**; RTO ≤ 4h with a rehearsed DR drill; all secrets in Railway's store with a documented rotation schedule; append-only `audit_log` periodically shipped to WORM storage; incident-response runbook (detect → contain/rotate/kill-switch → assess from audit_log → notify PPA/customers → restore → post-mortem) with Priority/PSP/attorney contacts inline.

### 4.2 MUST-pass gate before real money flows (end of P3)

1. R1 fix merged + tested — no unknown/hidden SKU, no zero-price line can reach Priority.
2. Per-user rate limits on orders, uploads, ERP reads; per-account login backoff **plus per-IP and global login throttles** (credential stuffing).
3. PSP integration is **SAQ-A** — hosted page only, data-flow diagram proving no PAN touches our origin, signed off.
4. Payment-intent + server-side amounts + idempotency + signature verification + reconciliation poller (webhook never trusted alone).
5. Webhook replay/dedupe + amount cross-check + forged-event tests green.
6. Check-image controls live (encrypted, private, gated, audited, retention job scheduled, directory included in encrypted backups) — gates P4, verified now.
7. AI outputs structured, validated, human-confirmed; cost cap + kill-switch live.
8. Step-up payment grants enforced on every payment endpoint, server-side; SMS-OTP is the grant floor — no password-only grants.
9. `audit_log` recording all auth + payment + admin + check actions.
10. ERP errors redacted; fresh scoped PAT in service; bootstrap creds removed from env.
11. Backups running **and a test restore performed**; `CHECK_IMAGE_KEY` + backup key escrowed off-Railway.
12. Admin 2FA enforced.
13. **3-D Secure enabled on the hosted page** (liability shift verified in sandbox) and **chargeback/dispute events handled** (webhook or daily lookup → `needs_admin` + admin dispute workflow).
14. **Supply-chain controls:** lockfile pinned, `npm audit` + dependency review in CI green, update policy documented.

P1-class items landing in the same release train: hashed sessions (done in P0), Origin-check CSRF middleware (P0), unified escaping + production-tested CSP (P0, load-bearing once the PSP frame exists), passkey endpoint rules, push allowlist, role matrix test, in-app egress allowlist + anomaly/spend/webhook alerting, final domain + HSTS preload.

---

## 5. Compliance corner

**Israeli Privacy Protection Law + Amendment 13 (תיקון 13, in force 14 Aug 2025).** The portal is a database (מאגר מידע) holding names, phones, financial/debt data — and with check photos, **bank account numbers + signatures = "especially sensitive" data**. Duties implemented in this plan: encryption in transit and at rest (application-level for check images), strict access control + audit logging, breach-notification runbook to the Privacy Protection Authority, periodic risk assessment, data minimization (images crypto-shredded after clearing; only extracted fields retained, in Priority), documented internal record of processing, and a designated owner-side privacy/security responsible person (can be Assaf). Amendment 13 abolished general database registration; this database most likely doesn't trigger mandatory registration or a hard DPO requirement at its scale — **but confirm both with an Israeli privacy attorney before go-live (booked in P0; checklist item, not optional)**. Sending check images/order history to Anthropic is a transfer abroad: covered by the signed commercial **DPA + zero-data-retention workspace** (API inputs aren't used for training by default), Anthropic named as a processor in the privacy notice, and PII minimized per call (OCR gets the image only; suggestions get product rows only).

**PCI DSS — SAQ-A scope statement.** All cardholder data entry, transmission, and storage is fully outsourced to PayPlus (PCI DSS Level 1) via its hosted payment page. No PAN/CVV ever reaches our origin, JS, logs, or DB; we store only PSP token UID, last-4, brand, expiry, and approval numbers. Architectural gate: **hosted page / fully-sandboxed redirect only — Hosted Fields or any our-DOM card input is banned** (would escalate to SAQ A-EP). CSP `frame-src`/`form-action` pinned to the PSP origin enforces this in depth.

**Accessibility — ת"י 5568 (WCAG 2.0 AA).** A B2B ordering portal is in scope of the Israeli service-accessibility regulations. The plan ships the legally required **הצהרת נגישות** page in P1, fixes the concrete failures (44px tap targets, contrast, labels, focus, keyboard operability, RTL screen-reader semantics) through the P1 component system, and runs a documented VoiceOver/NVDA audit in P6 before broad rollout.

---

## 6. Decisions Assaf must make (each with a default so nothing blocks)

| # | Decision | Recommended default | Notes |
|---|---|---|---|
| 1 | **PSP** | **PayPlus** | Documented HMAC-signed webhooks (**verify signing behavior in sandbox during onboarding** — Meshulam/Grow and Z-Credit also sign callbacks in some configurations) + cleanest API + Bit/Google Pay on a Hebrew hosted page + full token lifecycle. Runner-up: **Cardcom** (licensed acquirer, published 0.9%/1.2% rates, unsigned webhooks → must verify via lookup). Use Cardcom's rates as leverage in the PayPlus quote. |
| 2 | **Receipt document for pay-at-order** (with the bookkeeper) | **TINVOICES (קבלה)** pending the Step-0 probe; **EINVOICES (חשבונית מס קבלה)** as the verified fallback — pay-at-order only, never against existing debt | Switchable via `settings.erp_receipt_doc`. Also confirm: the PAYMENTDEF mapping table — CASHNAME per card brand (the production-proven `'101'` is Visa CAL only; Isracard/Mastercard/Amex need their own codes) **and a payment-means code for Bit** — plus draft-receipt (טיוטא) finalization workflow, and whether showing the draft number to the customer satisfies the קבלה-on-receipt obligation (accountant). |
| 3 | **SMS provider** | **019 SMS (Telzar)** | Cheapest domestic, Hebrew + "ORGAT" sender ID. Alternatives: InforUMobile (equivalent), Twilio Verify (hosted but pricey for IL). |
| 4 | **WhatsApp BSP** | **Yes, in P5** — Twilio/Glassix-class, opt-in order-status + payment confirmations | Huge in Israeli B2B; fallback when no push subscription. Defer entirely if budget-sensitive — push alone is functional. |
| 5 | **Check-image retention** | **Crypto-shred 90 days after clearing; 180 days if never cleared** | Data-minimization lever under Amendment 13. Extracted fields stay in Priority. |
| 6 | **Partial debt payments** | **Allow**, per-invoice editable amounts, oldest-first (CURDATE asc) prefill | Final matching authority remains the bookkeeper's סילוקין. |
| 7 | **Check overage** (round-sum checks) | **Allow** — remainder recorded as on-account credit, flagged to bookkeeper | Standard trade practice. |
| 8 | **Over-credit-limit checkout** | **Warn, don't block** (settings toggle for hard block) | Banner offers "לשלם חוב פתוח עכשיו" instead. |
| 9 | **Check OCR tiering** | **Tiered Haiku→Fable** (escalate <0.90 confidence) | Flip `CHECK_OCR_SINGLE_TIER=fable` if volume <~1,000/month — all-Fable costs tens of shekels. |
| 10 | **Admin IP allowlist** | **On** (office IP/CIDR), since admin use is from the Orgat office | Env `ADMIN_IP_ALLOWLIST`; empty disables. |
| 11 | **Recovery office-approval for high-value accounts** | **Off at launch**; revisit after the first months | When on: SMS recovery completes only after an admin confirms by phone. |
| 12 | **Privacy attorney engagement** | **Yes (required)** — Amendment 13 applicability, DPO question, transfer-abroad confirmation | One-time consult; budget below. |

---

## 7. Cost sketch

**One-time effort:** P0 6–9 + P1 12–16 + P2 10–13 + P3 12–15 + P4 8–11 + P5 8–12 + P6 6–10 ≈ **62–86 dev-days** (~3–4.5 months solo; **~2.5–3 months with two developers** — only the UX track (P1) parallelizes cleanly with the auth track (P2); P0 → P3 → P4 remain a serial chain of ≈ 46–63 dev-days that a second developer cannot compress). One-time cash: PayPlus setup (quote; Tranzila-class benchmark ₪250), privacy-attorney consult (~₪3–6K), accessibility audit (~₪3–8K), domain/TLS ≈ ₪0 (existing apex + Railway certs).

**Monthly run costs:**

| Item | Estimate | Basis |
|---|---|---|
| PSP fixed fee | ₪50–150 | Quote-based (PayPlus); Tranzila benchmark ₪85 |
| Card MDR | ~0.9–1.2% of card volume | Dominant cost, volume-dependent — e.g. ₪200K/mo card volume ≈ ₪1,800–2,400. Bit included on the hosted page; Masav direct debit (₪-flat, Priority generates files natively) is the cheap rail for trusted recurring debt sweeps |
| Anthropic API | ~$18 ≈ **₪65** (cap $100) | 400 checks tier-1 + 15% escalation + similar-products + NL drafts + admin briefing; worst case (all-Fable, 3× volume) $60–70 |
| SMS (019) | ₪20–60 | Few hundred OTP/notification messages |
| Railway (app + volume) | $20–40 | Current footprint + growth |
| Backups (R2/B2) | $1–5 | DB replica + encrypted check images |
| Monitoring / log drain | $0–25 | Better Stack/Axiom class, free tier likely sufficient |
| WhatsApp BSP (if adopted) | ₪100–300 | BSP fee + per-conversation pricing at moderate volume |
| **Total excl. MDR and WhatsApp** | **≈ ₪250–600/month** (≈ ₪350–900 with WhatsApp) | AI spend is a rounding error vs. one delivery truck |

---

## 8. Out of scope / explicitly deferred

- **Check deposits (הפקדות) & bounced-check accounting in Priority** — never probed, unknown if API-exposed; stays a back-office Priority function (the portal records the ledger `bounced` state and `physical_status` only).
- **Masav file generation in the portal** — Priority does this natively; the portal only (optionally, later) collects debit authorizations.
- **PayPlus Invoice+ / PSP-side document issuing** — deliberately off; two invoicing systems on one transaction is a reconciliation bug factory. Priority is the single accounting source of truth.
- **Priority Click2Pay** — complementary email-dunning option, not part of the portal build.
- **J5 authorize-and-hold / capture flows** — deferred until delivery-variable orders demand it (J4 charge only in v1).
- **Hosted Fields / any card input in our DOM** — permanently banned (SAQ A-EP escalation).
- **Remote deposit capture** — the check flow is promise-to-pay record-keeping; the physical check is always collected.
- **Automated refund-on-order-cancel coupling** — admin sees a "הזמנה בוטלה אך שולמה" flag and refunds manually (v1).
- **Stripe** — not available to an Israeli-registered merchant; ruled out.
- **Offline ordering / background sync** — SW ships app-shell caching + offline fallback page only; queued offline orders are a future consideration.
- **Server-side speech-to-text** — voice input uses on-device Web Speech / keyboard dictation only.
- **bcrypt→argon2id migration, HEIC ingestion, native iOS/Android apps, multi-company Priority support, public self-registration** — nice-to-haves, not scheduled.

---

*Single recurring theme, worth repeating at every review: the server is the sole authority on price, amount, and identity. The client, the PSP webhook, and the AI model are all untrusted inputs — every phase above is built around that sentence.*