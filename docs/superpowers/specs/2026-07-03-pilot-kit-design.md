# Pilot Kit: OrgatB2B as a Product for Other Priority Companies

**Date:** 2026-07-03
**Status:** Approved (design), pending implementation plan
**Approach:** A — "Pilot kit, flags-as-tiers" (chosen over B "kit + entitlements" and C "global-ready first")

## Context

OrgatB2B is a single-tenant B2B ordering portal built for Orgat Sahar on top of Priority ERP.
The owner wants to commercialize it: first by giving it free to 2–5 pilot companies that run
Priority (Israel-first), later with free/paid tiers, eventually globally (Priority is a global ERP).

A 5-dimension codebase scan (tenancy, i18n, feature flags, Priority coupling, infra/Israel-isms)
concluded:

- **Clone-per-customer is nearly ready today** for another Israeli Priority company: ~25 env vars
  already cover per-company config, no hardcoded URLs/creds, webhook URLs derive from
  `APP_BASE_URL`, VAPID keys auto-generate at first boot, and the Priority client is centralized
  behind an injected `PriorityConfig` (`server/priority.ts`).
- **Revenue features are already server-enforced flags** (card payments, discount pricing,
  payment policy, auto receipts) — they can act as paid-tier toggles with no new code.
- **The blockers are Orgat-specific conventions baked into business logic** (statuses, pricing
  strategy, receipt journal, branding) plus the per-tenant discovery labor of verifying a new
  Priority instance.
- **Deferred deliberately:** i18n (~700 Hebrew strings), non-Israeli PSPs (ILS hardcoded in all
  three), entitlement/billing code, shared multi-tenancy (no tenant column in ~20 tables).
  None of these block Israeli pilots.

## Goals

1. Onboarding pilot company #2 requires **zero code edits** — only a discovery run, a settings
   form, env vars, and a flag posture. A new pilot goes live in under a day of operator time.
2. Every decision stays compatible with the later paths: entitlement layer (Path B) and
   global/i18n/Stripe (Path C).
3. Free-vs-paid is expressed as **documented flag posture per clone**, not code.

## Non-goals

- No i18n / English UI. No non-Israeli payment providers. No check-OCR generalization.
- No entitlement/plan/billing code. No shared multi-tenant hosting. No new pricing strategies
  (design the seam only).

## Architecture

**Clone-per-company appliance (unchanged).** Each pilot company gets its own Railway service +
volume + Litestream bucket + env set, running the same image from the same repo. One SQLite file
per company. Upgrades ship by redeploying clones from `main`.

Rationale: the scan found shared multi-tenancy would be a re-architecture (~20 unscoped tables,
global `settings` namespace, singleton background jobs, env-singleton creds) while clone-per-company
is nearly free. Operating a handful of pilots does not justify the rewrite; revisit only if
operating dozens of tenants hurts.

## Components

### 1. Branding pack

Extract the ~15 hardcoded Orgat spots into a `branding_*` group in the existing `settings` table,
editable from the current admin settings tab. New clone = fill in one form + upload one logo.

Covers (evidence from scan):

| Item | Current location |
|---|---|
| App/company display name | `index.html`, `public/manifest.json:2-5`, `server/webauthn.ts:16` (RP_NAME) |
| Logo / PWA icons | `public/` static assets |
| Contact email | `server/push.ts:19` (VAPID mailto), `src/pages/accessibility.ts:6` |
| CSV export filename | `server/index.ts:1513` (`orgat-products.csv`) |
| AI assistant identity | `server/assistant.ts:22-35` (system prompt names "אורגת סחר") |
| Deploy-script defaults | `scripts/railway-deploy.mjs:13,58` |

Design points:

- `manifest.json` becomes a **server-rendered route** (name/short_name/icons from branding
  settings); `index.html` title/meta filled at runtime or served with placeholders replaced.
- Logo uploaded via admin UI, stored under `DATA_DIR` (same pattern as check images), served from
  a stable URL used by manifest + header.
- Sensible fallbacks: missing branding values fall back to neutral defaults, never to Orgat's.

### 2. Tenant profile (Priority conventions as settings)

Convert "verified against Orgat tenant a051014" literals into settings with today's values as
defaults, following the existing `priority_receipt_*` settings pattern:

| Setting | Today's hardcoded value | Location |
|---|---|---|
| Active-product status | `STATDES === 'פעיל'` | `server/catalog.ts:86-91` |
| Finalized-invoice status | `STATDES === 'סופית'` | `server/priority.ts:419`, `server/finance.ts:351` |
| Credit-note prefix | `'IK'` | `server/finance.ts:360` |
| Receipt currency + journal pattern | `CODE 'ש"ח'`, `FNCPATNAME 'ק'` | `server/priorityReceipts.ts:19-48` |
| Portal order reference prefix | `BOOKNUM 'B2B-'` | `server/orders.ts:270-293` |
| VAT rate | `0.18` constant | `server/money.ts:1-8` |
| Debt source | OBLIGO.ACC_DEBIT (authoritative) | `server/finance.ts:234-245` |
| Price source strategy | BASEPLPRICE + order-derived discount % | `server/priority.ts:183-237`, `server/discounts.ts` |

Design points:

- **Price source** becomes a named enum setting (`price_source = baseplprice_order_discounts`)
  with only the current strategy implemented. The seam exists so a `pricelist` strategy can be
  added later without touching call sites. (Scan ranked pricing the #1 per-tenant risk: Orgat's
  strategy exists because PRICELIST is API-disabled on Orgat's tenant — other tenants differ.)
- **Debt source** likewise a named setting (`debt_source = obligo`), current behavior only.
- Image sourcing (inline base64 in `LOGPART.EXTFILENAME`) stays as-is but is verified per tenant
  by the discovery kit; a graceful "no images" fallback must exist (it already largely does).

### 3. Tenant discovery kit

Productize the ad-hoc probe scripts (`scripts/probe-priority*.mjs`, `probe-tinvoices.ts`) into one
`scripts/tenant-discovery.mjs` that runs against a prospect's Priority PAT and emits a readiness
report:

- Which forms are API-enabled (LOGPART, CUSTOMERS, ORDERS, AINVOICES, OPENINVOICES, OBLIGO,
  TINVOICES, PRICELIST, FAMILY_LOG) — the app already degrades per-form (`tryGet` pattern).
- Status vocabulary actually in use (STATDES values on LOGPART and AINVOICES).
- Price-list model: is PRICELIST readable? Does BASEPLPRICE look like a selling price?
- Debt source sanity: does OPENINVOICES return rows for indebted customers, or is OBLIGO needed?
- Image storage convention on LOGPART.
- BOOKNUM writability/filterability (order idempotency depends on it).
- API quota headroom.

Output: a markdown report with **green / yellow / red** per item, mapping to the tenant-profile
settings above. Paired with `docs/ONBOARDING_CHECKLIST.md` — the human steps (PAT creation,
which flags start off, finance-side verification for receipts).

This doubles as the pre-sales qualification tool: run it before committing to a pilot.

### 4. Hardening (pre-pilot security fixes from the scan)

1. **Server-side gate for check payments:** `/api/payments/check/*` endpoints are currently
   gated client-side only (`server/index.ts:920-994` area) — add the same server-side flag check
   pattern used by `paymentsLive()`.
2. **Move VAPID keys out of `settings`:** web-push secrets live in the same key-value table as
   admin-editable flags. Move to a dedicated table (or dedicated non-listable keys) so future
   settings-surface work can never leak them.

### 5. Documentation deliverables (no code)

- **Cloning runbook:** extend `docs/OPS_RUNBOOK.md` — new Railway service + volume, env matrix
  (which of the ~25 vars are per-company vs shared), Litestream bucket + keys, admin bootstrap,
  DNS/`APP_BASE_URL`/`RP_ID`, launch-flag posture (payments/receipts/discounts OFF until verified).
- **Tier-split posture doc:** the recommended free/paid line, applied manually per clone:
  - **Free tier:** catalog, cart/ordering, order history, favorites, saved baskets, push.
  - **Paid tier (flags):** card payments (`payments_enabled`), discount pricing
    (`discount_pricing_enabled`), payment policy enforcement, auto receipts, AI assistant,
    analytics dashboard, promotions.
- **Pilot terms one-pager:** free pilot, their data is theirs, no SLA, either side can stop,
  feedback expected. Reviewed by a lawyer before the first signature (business task, not code).

## Error handling

- Missing/blank tenant-profile settings fall back to current Orgat defaults, so the Orgat
  production clone is bit-for-bit unaffected by this work (regression risk ≈ config plumbing only).
- Discovery script failures degrade per-probe (report "unknown / verify manually"), never crash.
- A clone with `payments_enabled=off` must never render payment CTAs nor accept payment API calls
  (already true; hardening item #4.1 closes the one gap).

## Testing

- Unit: settings-driven tenant profile (status matching, prefixes, VAT) with Orgat defaults vs
  overridden values.
- Smoke: boot the app against an empty DB with branding unset — neutral defaults render, no
  Orgat leakage.
- Discovery kit: run against Orgat's live tenant; report must come back all-green and match the
  current hardcoded conventions.
- Regression: full existing QA flow on the Orgat clone after the refactor (flags unchanged).

## Success criteria

1. Company #2 onboards with zero code edits (discovery run → settings form → env → flags).
2. Orgat production behavior is unchanged (defaults preserve every current convention).
3. The discovery report alone answers "will the portal work on this Priority instance?"

## Future paths (explicitly out of scope now)

- **Path B — entitlements (after 2–3 clones prove demand):** `customer_entitlements` modeled on
  the existing `customer_policies` pattern, `entitledFor()` replacing ~10 `getSettingBool` sites,
  plan editing in the admin board. Note the open business question: billing *distributors*
  (per-clone plans) vs distributors billing *their customers* — different products.
- **Path C — global:** pluggable price-source strategy first, then Stripe/Adyen adapter on the
  existing `createPspIntent` seam + currency/tax abstraction, then i18n extraction + LTR, and
  only if operating dozens of tenants hurts, shared multi-tenancy.
