# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Hebrew (RTL) B2B ordering PWA for אורגת סחר בע"מ, backed by Priority ERP over OData REST. Business customers log in, see a catalog priced per their Priority `CUSTNAME`, order into Priority `ORDERS`, view invoices/balance, and pay (PayPlus cards, check photos). Single tenant, one Express server, one SQLite file. Production: https://b2b.orgat.co.il (Railway, service `web` in project `orgat-b2b`; the old `web-production-ac422.up.railway.app` URL still serves).

## Commands

```bash
npm run dev          # server :3030 (tsx watch) + Vite :5175 concurrently; Vite proxies /api + /uploads
npm run typecheck    # tsc for BOTH server and client — run before every commit
npm run build        # vite build + tsc server → dist/
DATA_DIR=$(mktemp -d) node --import tsx --test --test-concurrency=1 server/stockAlerts.test.ts server/products.stockAlerts.test.ts
                     # unit tests (node:test). ALWAYS use a scratch DATA_DIR and --test-concurrency=1:
                     # parallel test files sharing one DATA_DIR flake with SQLITE_BUSY.
                     # Run a single file the same way with just that file.
```

There is no lint step and no CI; the gate is typecheck + tests + build, run locally.

**Deploy = merge/push to `main`** — Railway auto-deploys. A deploy causes ~15 min of prod downtime (single-attach volume: old container must release it before the new one starts), so deploy off-hours once customers are active. Post-deploy sanity: bundle hash changed on `https://b2b.orgat.co.il/`, new API routes answer 401 (not 404) unauthenticated.

Env comes from `.env` (see `.env.example`): `PRIORITY_PAT`, `SESSION_SECRET`, `ADMIN_BOOTSTRAP_USERNAME/PASSWORD` (admin is created only when the users table is EMPTY at boot), `DATA_DIR`, PayPlus/UPay keys. Dev helper scripts live in `scripts/` (e.g. `make-test-user.mjs` upserts a customer login bound to a real Priority CUSTNAME; `db-state.mjs` inspects the DB).

## Architecture

Two halves, no framework on either side:

- `server/` — Express (ESM TypeScript), one file per domain (orders, payments, catalog, promotions…). `server/index.ts` holds ALL routes (~2000 lines) and delegates to the domain modules; `server/db.ts` holds the entire SQLite schema as `CREATE TABLE IF NOT EXISTS` template strings plus ad-hoc migrations that run at boot. `better-sqlite3` is synchronous — no `await` between related reads/writes; use `db.transaction()` for multi-write atomicity.
- `src/` — vanilla TS SPA, hash-routed by `src/main.ts` (`#catalog`, `#product/<part>`, `#admin/...`), one file per screen in `src/pages/`. Screens build HTML strings and wire listeners on a `shell` element; user data is escaped with `escapeHtml`/`escapeAttr` or set via `textContent`. `src/api.ts` exports `api.get/post/put/patch/del`. `src/ui.ts` holds shared widgets (toast — kinds are `'ok' | 'error' | 'info'` — price blocks, OOS badge).

**Priority integration** (`server/priority.ts` + `finance.ts` + `catalog.ts`): OData with a PAT. Catalog is cached in the `catalog_cache` table (synced from Priority; only `STATDES=פעיל` parts; price = `BASEPLPRICE` pre-VAT, not `LASTPRICE`), then overlaid with local `b2b_*` columns the admin controls (visible, out-of-stock, featured, is_new, image, overrides). Customer finance views are TTL-cached ~5 min in `finance.ts` to stay under Priority rate limits. Extensive Priority OData reference: `/Users/assaf/Documents/order-to-priority/CLAUDE.md`.

**Auth** (`server/auth.ts`): bcrypt + cookie sessions, roles `customer`/`admin` (+ `customer_role` `orderer` with reduced rights). Route guards: `requireAuth`, `requireCustomer`, `requireAdmin`. WebAuthn passkeys layer on top (`RP_ID`/`WEB_ORIGIN` env — bound to b2b.orgat.co.il; changing the domain kills enrolled passkeys). Magic login links and invite tokens are hashed at rest.

**Payments**: three PSP integrations exist (`payplus.ts` live, `tranzila.ts`, `upay.ts`), selected by the `card_provider` setting; check-photo payments (`checkOcr.ts`) read amount/date via the Anthropic API with encrypted image storage. Card charges are "on-account" with manual office reconciliation; `priorityReceipts.ts` can auto-create TINVOICES receipts (flag off).

**Web push** (`server/push.ts` + `src/push.ts` + `public/sw.js`): VAPID keys auto-generate into the settings table. `notifyUser(userId, {title, body, url})` is fire-and-forget and never throws — but it is irreversible I/O: NEVER call it (directly or via a helper like `fireStockAlerts`) inside an open `db.transaction()`; defer until after commit (see the `pendingRestocks` pattern in `server/products.ts`).

## House rules (the constitution)

1. **Every customer-facing feature ships inert behind an admin settings flag, default OFF.** Register the key in BOTH the `SETTABLE` and `BOOL_SETTINGS` allowlists in `server/index.ts`, add a toggle in `src/pages/adminSettings.ts` (prefs-panel pattern: combined save, each toggle PATCHes only its own key), and make the feature fully dark when off (endpoints 404 `{error:'disabled'}` or return empty; UI hidden). Deploy first, activate later via the admin UI — never by editing prod data by hand.
2. **All customer-facing copy is Hebrew**, including server `Error` messages (they surface in toasts as-is). Match the register of neighboring strings.
3. **Copy the neighboring pattern.** New routes look like the favorites/templates block in `server/index.ts` (guard → limiter → try/catch → Hebrew 400). New home rails copy the `#new-rail` structure in `src/pages/home.ts`. New admin toggles copy `s-oos-bottom`. New schema goes into the `db.ts` template string as `CREATE TABLE IF NOT EXISTS`.
4. **Feature work flow**: spec in `docs/superpowers/specs/`, plan in `docs/superpowers/plans/` (dated filenames), work on a feature branch, per-task review, final whole-branch review, then merge to main. Progress ledger: `.superpowers/sdd/progress.md` (git-ignored — APPEND to it, never overwrite; it holds the history of every past goal).
5. **Verify before claiming done**: typecheck + unit tests + build, plus an end-to-end exercise of the real flow (scratch `DATA_DIR`, spawn the server, drive the HTTP API — see the E2E pattern referenced in the ledger). Clean up any QA rows created in a real DB afterward.
6. **Money**: prices are pre-VAT in the catalog; totals shown to customers are VAT-inclusive; use `server/money.ts` helpers for rounding. Never trust client-computed amounts — the server re-derives every charge.
7. **The office is the safety net, never the customer.** When an integration is uncertain (Priority write fails, PSP answer ambiguous), degrade to a state the office can reconcile manually rather than blocking or double-charging the customer.

## Gotchas that have bitten before

- Deployment ≈ 15 min downtime (volume re-attach) — it's not the app, a healthcheck won't fix it.
- Railway custom domains need a CNAME **and** a hidden TXT `_railway-verify.*` record; the GraphQL API doesn't report the TXT and shows all-green while the edge 404s. The dashboard's "Show DNS records" is the only truthful source.
- `docs/GOLIVE_AUDIT_2026-07-02.md` is intentionally untracked (contains a leaked password in its history notes) — don't commit it.
- Admin bootstrap (`ADMIN_BOOTSTRAP_*`) only runs on an empty users table; seeding any user first suppresses it.
- Order flow has careful recovery semantics (BOOKNUM adoption, stuck-order boot recovery, card-intent expiry sweeps) — read `server/orders.ts` + `cardPayments.ts` comments before touching submission/payment paths; several timing constants (90s settle delay, 30-min PayPlus expiry, 120s createOrder timeout) are deliberate.
