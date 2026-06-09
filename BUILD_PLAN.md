# prgatB2B — Build Plan & Progress

> Goal: a fully working, useful B2B self-order portal for אורגת סחר, on Priority ERP.
> Customers log in, browse a personally-priced catalog, order (→ Priority `ORDERS`),
> **and now also see their own Priority data: profile, past orders, invoices, and
> open invoices that still need to be paid.**

This file is the working plan + status. Update the checkboxes as work lands.

---

## Current status (2026-05-28)

Already built before this round: auth (bcrypt + cookie sessions, customer/admin),
SQLite schema + migrations, Priority OData client, catalog + personal pricing,
cart, order submission → Priority, invites, public leads, admin product control
panel (CSV import/export, image upload, bulk edits, dashboard), PWA shell.

This round adds the **customer financial view** (the headline request) and makes
the app verifiably work end-to-end against the live Priority company `a051014`.

---

## Priority entity map (verified by live read-only probing — see `scripts/probe-priority*.mjs`)

Base: `https://p.priority-connect.online/odata/Priority/tabp008h.ini/a051014`, PAT auth (`Basic base64(PAT:PAT)`).

| Need | Entity | Key fields (verified to exist) |
|---|---|---|
| Products | `LOGPART` | PARTNAME, PARTDES, FAMILYNAME, BARCODE, LASTPRICE, STATDES |
| **Product images** | `LOGPART.EXTFILENAME` | Inline **base64 data URI** (`data:image/png;base64,…` / one jpeg), *not* a filename. 64 of 291 parts carry one. `EXTFILEFLAG` and the `PARTEXTFILE_SUBFORM` nav are unused/empty here; standalone `EXTFILES` 404s. Filtering `EXTFILENAME ne null` returns HTTP 500, so select it for all parts and filter client-side. |
| Families | `FAMILY_LOG` | FAMILYNAME, FAMILYDESC |
| Customer profile | `CUSTOMERS` | CUSTNAME, CUSTDES, ADDRESS, STATE (city), ZIP, PHONE, EMAIL, VATNUM, PAYCODE/PAYDES (terms), AGENTNAME, MAX_CREDIT, MAX_OBLIGO |
| Create / list orders | `ORDERS` (+`ORDERITEMS_SUBFORM`) | ORDNAME, CUSTNAME, CURDATE, ORDSTATUSDES, BOOLCLOSED, DETAILS |
| **Tax-invoice history** | `AINVOICES` | IVNUM, IVTYPE(=A), CUSTNAME, CDES, IVDATE, TOTPRICE (incl VAT), QPRICE, VAT, DISCOUNT, ORDNAME, STATDES, FNCNUM. **No** REMPRICE/PAYDATE here. Statuses: `סופית`=final, `טיוטא`=draft, `מבוטלת`=cancelled. Credit notes have `IK`-prefixed IVNUM + negative amounts. |
| **Open invoices (debt)** | `OPENINVOICES` | CUSTNAME, CUSTDES, CURDATE, TOTPRICE (incl VAT, = open amount), DISPRICE (pre-VAT), VAT, DOCNO, DOC, ORDNAME, REFERENCE, BOOKNUM. Total open balance = Σ TOTPRICE. |
| Credit exposure | `OBLIGO` | CUSTNAME, OBLIGO (total exposure), IV_DEBIT, DOC_DEBIT, ORD_DEBIT, CREDIT, MAX_CREDIT, MAX_OBLIGO |
| Invoice-receipts (paid-on-issue) | `EINVOICES` | has REMPRICE, PAYDATE (not primary for AR here) |

Notes:
- `OPENINVOICES` is the canonical "what does this customer still owe" set. The portal's
  open-balance headline = sum of `TOTPRICE` over the customer's `OPENINVOICES` rows.
- `AINVOICES` is the full tax-invoice history (filter to non-cancelled for display).
- Rate limit: 100 calls/min. Per-customer finance reads are cached with a short TTL.

---

## Work breakdown

- [x] **1. Priority client** — `getCustomer`, `listOpenInvoices`, `listInvoices`, `getObligo` in `server/priority.ts`.
- [x] **2. Finance module** — `server/finance.ts`: `getAccountSummary(custname)`, `getInvoices(custname)` with TTL cache.
- [x] **3. API endpoints** — enriched `GET /api/account`; added `GET /api/invoices`. Priority failures degrade gracefully (`priorityOk:false`).
- [x] **4. Frontend** — `src/format.ts` (money/date/escape helpers), `src/pages/invoices.ts` (#invoices: balance card + open table + history table), enriched `account.ts` (profile + balance + obligo), nav link "חשבוניות" + `#invoices` route in `main.ts`, Priority order history wired into `orders.ts`.
- [x] **5. Verify** — real test customer (CUSTNAME `10184`, user `test10184`) → logged in → confirmed live profile, ₪996 open balance / 1 open invoice, 90 final invoices, 100 orders, obligo ₪37,160 all render correctly in RTL. No console errors. `npm run typecheck` clean.
- [x] **6. Docs/memory** — this file current, README roadmap refreshed, durable memory saved.

---

## ✅ Status: DONE (2026-05-28)

The customer financial view is live and verified end-to-end against company `a051014`.
Customers now log in and see, pulled live from Priority:
- **`#account`** — full profile (name, address, phone, fax, email, VAT, payment terms, agent) + balance summary (open total, obligo, credit limit).
- **`#invoices`** — open-balance headline (red when owing / green when clear), open-invoices table (Σ = amount owed), and finalized invoice history (with זיכוי/credit-note badges).
- **`#orders`** — portal-submitted orders + full Priority order history.

Dev verification helpers (read-only / dev-only): `scripts/probe-10184.mjs` (runs the 4 finance queries for any CUSTNAME), `scripts/make-test-user.mjs` (upserts a customer login mapped to a real CUSTNAME).

## ✅ Status: Product images from Priority (2026-05-29)

Customers now see real product photos in the catalog and product pages, pulled live from Priority.

- **Discovery:** Priority stores product images inline on `LOGPART.EXTFILENAME` as base64 data URIs (64/291 parts have one). See entity map above for the gotchas (500 on filter, empty subform).
- **Client:** `listProductImages()` in `server/priority.ts` selects `PARTNAME,EXTFILENAME` for all parts and keeps only `data:image/*` rows.
- **Sync:** `syncProductImagesFromPriority()` in `server/catalog.ts` decodes each data URI, transcodes to WebP (`sharp`, ≤800px, q82 — same pipeline as admin uploads), writes a content-hashed `prio_<part>_<hash>.webp` into `/uploads`, and sets `catalog_cache.image_url`. Idempotent (content-hash filenames; skips unchanged). Admin-uploaded `b2b_image_path` still wins in `queryCatalog`, so manual overrides are never clobbered. Wired into `refreshCatalogFromPriority()` (non-fatal) so the admin "refresh catalog" also pulls images.
- **Dev fix:** added `/uploads` to the Vite proxy (`vite.config.ts`) — without it Vite's SPA fallback returned `index.html` for image requests and they failed to load in dev. (Production is single-origin via Express, so no proxy needed.)
- **Result:** 64 images synced (0 failures), 2.3 MB total on disk (avg 34 KB WebP, ~7× smaller than the source PNGs). Verified end-to-end as `test10184`: catalog + product pages render the photos, no console errors, `npm run typecheck` clean.
- **Dev helper:** `node --env-file=.env --import tsx scripts/sync-images.ts` runs the image sync on its own.

## ✅ Status: Security hardening (2026-05-29)

The app holds a Priority PAT with read/write access to the **entire** company (every
customer's profile, pricing, invoices, debt). Audited the whole surface and hardened it.

**Access model (per-customer private login — already the design, confirmed sound):**
- Each customer logs in with their own username + password (bcrypt, cost 12). A login row
  maps to exactly one Priority `CUSTNAME`; `requireCustomer` blocks anyone without one.
- **No customer ever supplies a CUSTNAME** — every customer endpoint derives it from the
  server-side session (`req.user.custname` / `.id`), so customer A can't read customer B's
  data by tampering with a request (no IDOR). All `/api/admin/*` routes sit behind `requireAdmin`.
- Sessions: 256-bit random tokens stored server-side with expiry + live `status='active'`
  re-check; httpOnly + SameSite=Lax cookie (Secure in production). Onboarding is invite-only
  (admin issues a 128-bit invite token → customer sets their own username + password ≥ 8 chars).

**Fixes applied this pass:**
- **Login user-enumeration timing** — unknown username now runs a dummy bcrypt compare
  (`equalizeLoginTiming`) so "no such user" and "wrong password" take the same time.
- **`password_hash` never leaves the DB layer** — `userFromSession` selects an explicit column
  list (no hash); `UserRow.password_hash` made optional and only populated by the login query.
- **Security headers on every response** — `X-Content-Type-Options`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP; plus **production-only** HSTS and a
  strict CSP (`default-src 'self'`, `img-src 'self' data: blob:`, `object-src 'none'`,
  `frame-ancestors 'none'`). `x-powered-by` disabled.
- **Rate limiting** — login 10/min (existing) + a 20/min `publicLimiter` on the unauthenticated,
  abusable endpoints: invite lookup, invite accept, lead capture (deters token brute-force + spam).
- **No ERP internals leak to customers** — order-submit failures now log the full error
  server-side and return a generic Hebrew message; only whitelisted `OrderError` validation
  messages (e.g. empty cart) reach the client.

Verified: `npm run typecheck` clean; headers present (CSP/HSTS prod-only); rate limiter returns
429 after the cap; login + catalog + auth guards (401 anon / 403 customer-on-admin) all correct.

### Not yet done (future)
- Promotions engine (Buy X Get Y) — DB schema exists, engine logic pending.
- Invoice PDF download from Priority.
- Deploy to Railway (`b2b.orgat.co.il`).

## ✅ Status: Customer onboarding + personal-pricing fix (2026-05-29)

Onboarded the first real customer for UX testing: **מ.נ.מ הכל לתעשיה בע"מ** (CUSTNAME `10293`).
Verified the account view shows their live Priority profile (השיטה 4, כפר סבא · agent אסף ·
terms ש60) and real balance (obligo ₪34,736).

- **Fixed a real bug in `getCustomerLastPrices` (`server/priority.ts`)** — it selected `CURDATE`
  *inside* the `ORDERITEMS_SUBFORM` expand, but `CURDATE` is an ORDER-header field, not a
  line-item field, so Priority returned HTTP 400 and **personal pricing silently never loaded
  for anyone** (`customer_pricing` was empty). Removed `CURDATE` from the subform `$select`
  (the outer `$orderby=CURDATE desc` already gives newest-first, so the first PRICE per PARTNAME
  is the latest). Now loads correctly — 20 personal prices pulled for `10293`.
- **First-time connection** is invite-based (already built, verified end-to-end):
  admin creates an invite → customer opens `#invite/<token>` → sees "ברוכים הבאים, <company>"
  → picks their own username + password (≥ 8 chars) → account created and logged in.
  Each accepted invite maps the new login to exactly one `CUSTNAME`.

**Dev/admin helper scripts (read-only against Priority unless noted):**
- `scripts/find-customer.mjs "<name>"` — search Priority CUSTOMERS by name/code fragment.
- `scripts/make-test-user.mjs <user> <pass> <custname> ["cust_desc"]` — upsert a customer login.
- `scripts/make-invite.ts <custname> ["cust_desc"]` — mint a real first-time onboarding link.
- `scripts/refresh-pricing.ts <custname>` — pull a customer's personal prices into the cache.
- `scripts/delete-user.mjs <user> [--apply]` — safely remove a login (guards admins + orders).

## How to run / verify

```bash
npm run dev                       # server :3030, Vite :5175 (proxy /api → :3030)
node --env-file=.env scripts/probe-priority.mjs    # re-discover Priority entities (read-only)
node scripts/db-state.mjs                           # local DB snapshot
```

End-to-end finance check: log in as the test customer → `#invoices` shows open
invoices + total owed; `#account` shows the live Priority profile.
