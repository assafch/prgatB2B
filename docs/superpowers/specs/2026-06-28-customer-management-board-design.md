# Design — Customer (Company) Management Board

**Date:** 2026-06-28
**Status:** Approved (design) — pending spec review → plan → build
**Grounded in:** a 2-agent codebase map (products inline-edit board pattern + admin
router; company-vs-user data model + per-company data sources).

## 1. Goal

Replace the buried per-*user* `prompt()` for payment policy with a proper
**company-centric management board**, modeled on the existing **products board**.
The managed entity is the **Priority customer (company = `custname`)**, which has
**many app users**. Each company gets:
- inline-editable **payment policy** in a companies list (bulk, like products), and
- a **per-company card** managing its **app-user logins**, showing **Priority
  context** (terms / open debt / credit), and an **extensible flags** section.

## 2. Key fact — no data migration

`customer_policies(custname PRIMARY KEY, kind, open_debt_threshold,
allow_order_with_open_debt, updated_at)` is **already company-keyed** (`server/db.ts`).
Companies are implicit: a company = a distinct `custname` across `users`
(`role='customer'`). So this is a **new admin surface + endpoints**, not a schema
change. Per-company **flags** added later go on `customer_policies` (or a sibling
table) via `ensureColumn` — the board UI is built to absorb them.

## 3. Architecture

### 3a. Server — `server/customers.ts` (new), routes in `server/index.ts`
Mirror `server/products.ts` (list / get / patch / batch) + the products routes.

- `listCustomersAdmin(q, page, pageSize)` → `{ items, total }`. Core query:
  `SELECT custname, MAX(cust_desc) cust_desc, COUNT(*) user_count FROM users
   WHERE role='customer' [AND (custname LIKE q OR cust_desc LIKE q)] GROUP BY custname
   ORDER BY cust_desc LIMIT ? OFFSET ?`, LEFT JOIN `customer_policies` for the stored
  override, and enrich each row with the **resolved** policy kind + **cached-only**
  finance (open debt + payment terms) — read from the finance cache table, **never a
  live Priority call** (keeps the list instant; absent cache → fields show "—").
  Item shape: `{ custname, cust_desc, user_count, kind, open_debt_threshold,
  allow_order_with_open_debt, resolvedKind, paymentTerms?, openTotal? }`.
- `getCustomerAdmin(custname)` → the card payload: the policy row (or defaults), the
  company's users (`id, username, customer_role, status, last_login_at`), and **live**
  `getAccountSummary(custname)` (terms, openTotal, creditLimit, obligo) with graceful
  fallback (`priorityOk:false` → show "לא זמין", never block the card).
- `patchCustomer(custname, patch)` → whitelist `PATCHABLE = {kind,
  open_debt_threshold, allow_order_with_open_debt}` (+ future flags), normalize
  (bool→0/1, ''→NULL, kind∈{auto,cash,net}), upsert `customer_policies`
  (INSERT…ON CONFLICT). Returns the updated row.
- `batchUpdateCustomers(items)` → one `db.transaction`, loop `patchCustomer`, return
  `{ changes }` (clone of `batchUpdate` in products.ts).
- **Routes** (all `requireAdmin`): `GET /api/admin/customers?q=&page=`,
  `GET /api/admin/customers/:custname`, `PATCH /api/admin/customers/:custname`,
  `POST /api/admin/customers/batch`. The existing
  `GET/PATCH /api/admin/customers/:custname/policy` is superseded — keep or remove
  (the new `/:custname` PATCH covers it); the per-user prompt that called it is removed.
- **User actions reuse existing endpoints** (`POST /api/admin/users` create,
  password reset, status toggle) — the card just scopes them to the company's `custname`.

### 3b. Client
- `src/pages/adminCustomers.ts` (new) — the **companies list**, a near-clone of
  `adminProducts.ts`: `edits = Map<custname, patch>`, `setEdit`, `refreshSaveBar`,
  `saveEdits` → `POST /api/admin/customers/batch`, `loadList` with `q/page`, the sticky
  save bar. Columns: company (`custname` + `cust_desc`), `# users`, terms (cached),
  open debt (cached), **policy kind** (`<select>` auto/cash/net), **threshold**
  (`<input number>`), **exempt** (toggle chip). Row → navigates `#admin/customers/:custname`.
- `src/pages/adminCustomerCard.ts` (new) — the **per-company card** (`renderCustomerCard
  (shell, custname)`), sections:
  1. **Header** — company name, `custname`, user count, back link.
  2. **מדיניות תשלום** — full edit (kind select, threshold, exempt) → `PATCH
     /api/admin/customers/:custname`; shows the resolved/derived kind + the Priority
     `PAYDES` it derives from.
  3. **משתמשי החברה** — list the company's users (login, role owner/orderer, status,
     last login) with actions: create login (prefilled `custname`/`cust_desc`), reset
     password, enable/disable — reusing the existing `/api/admin/users` endpoints.
  4. **נתוני Priority (קריאה בלבד)** — payment terms, open debt, credit limit, obligo
     from `getAccountSummary`; "לא זמין" on Priority error.
  5. **דגלים נוספים** — extensible section (v1: present, wired to the policy patch;
     future flags drop in as new whitelisted columns + controls).
- `src/pages/admin.ts` — add the **"לקוחות"** tab (import + tab link + dispatch), the
  `#admin/customers` and `#admin/customers/:custname` routes (string-slice param like
  the existing admin routes).
- `src/pages/adminUsers.ts` — **remove** the `editPolicy` `prompt()` button from user
  rows (policy now lives on the company card). The Users tab stays as a global login
  list; optionally surface `customer_role`. No other change.

## 4. Phasing (each phase = part of one plan, verified + shipped)

1. **Server + companies list:** `server/customers.ts` (list/get/patch/batch) + the 4
   routes + `adminCustomers.ts` list board (inline policy edit + batch save) + the
   "לקוחות" tab. *Delivers the products-like board.*
2. **Per-company card:** `adminCustomerCard.ts` (policy form + company user management +
   Priority context + flags scaffold) + the `:custname` route.
3. **Cleanup + ship:** remove the `adminUsers` policy prompt; full verify; deploy.

## 5. Testing
- Server: curl `GET /api/admin/customers` (companies with user_count + resolved kind,
  cached finance), `GET /:custname` (policy + users + live terms), `PATCH /:custname`
  + `POST /batch` (policy persists; `GET` reflects it), all `requireAdmin` (401 anon).
- Client (dev-browser): the list renders companies + inline-edits a policy + batch-saves;
  the card opens, shows policy + the company's users + Priority terms; the `adminUsers`
  policy button is gone.
- `npm run typecheck && npm run build` green; **21/21** auth regression; deploy +
  bundle-hash + health checks.

## 6. Open items / future (out of scope for v1)
- Per-company flags beyond payment policy (custom-pricing-per-company would change the
  currently-global `customer_pricing_enabled` + `catalog.ts` — its own change).
- Bulk actions ("apply cash to selected"), CSV export/import (products has these).
- Listing Priority companies that have **no** app user yet (v1 lists app companies only).
- Live per-row Priority data on the list (deferred — cached-only by decision).
