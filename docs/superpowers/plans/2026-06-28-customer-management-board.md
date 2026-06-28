# Customer (Company) Management Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A "לקוחות" admin tab — a companies list (inline policy edit + batch save, like the products board) plus a per-company card (full policy + the company's user logins + Priority context + extensible flags), keyed by the Priority customer (`custname`).

**Architecture:** New `server/customers.ts` mirrors `server/products.ts` (list/get/patch/batch). Companies = `GROUP BY custname` over `users` (role='customer'); policy = the existing `customer_policies` table (company-keyed). List enriches with **cached-only** finance (no live Priority call); the card uses **live** `getAccountSummary`. Client clones `adminProducts.ts` for the list + a new card page. Spec: `docs/superpowers/specs/2026-06-28-customer-management-board-design.md`.

**Tech Stack:** TS Express + vanilla-TS client + better-sqlite3. Verify: `npm run typecheck && npm run build` + curl + dev-browser (system Chrome `--connect`, port 9222). Local server node@24: `PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev`. Branch `feat/payment-policy`.

**Reuse map (read these before cloning):**
- `server/products.ts`: `listProductsAdmin` (WHERE/count/LIMIT-OFFSET), `getProductAdmin`, `patchProduct` (PATCHABLE_COLUMNS whitelist + bool/null normalize), `batchUpdate` (one `db.transaction`).
- `server/index.ts`: products admin routes (`GET /api/admin/products`, `GET/PATCH /:partname`, `POST /batch`) — all `requireAdmin`; existing `GET/PATCH /api/admin/customers/:custname/policy`; `/api/admin/users` create/reset/status routes.
- `server/paymentPolicy.ts`: `resolvePolicy(custname, paymentTerms): Policy` (`.kind`).
- `server/finance.ts`: `getAccountSummary(custname)` (live) + the persistent finance cache table (read directly for cached-only list data).
- `src/pages/adminProducts.ts`: the inline-edit board (edits Map, setEdit, refreshSaveBar, saveEdits→/batch, loadList, sticky save bar, cell-edit inputs, status-toggle chips).
- `src/pages/admin.ts`: tab registration (import + tab link + dispatch; hashes `#admin/products` etc.).
- `src/pages/adminUsers.ts`: `editPolicy` prompt to remove; user-row actions to reuse.

---

## Phase 1 — Server + companies list board

### Task 1: `server/customers.ts` — list companies (+ cached finance) + GET route

**Files:** Create `server/customers.ts`; Modify `server/index.ts`

- [ ] **Step 1:** Read `server/products.ts` (`listProductsAdmin`) and `server/finance.ts` (find how the persistent finance cache is stored — the table name + JSON column — so we can read a customer's cached `paymentTerms`/`openTotal` WITHOUT a live Priority call). Read `server/paymentPolicy.ts` `resolvePolicy`.

- [ ] **Step 2:** Create `server/customers.ts` with the list service:
```ts
import { db } from './db.js';
import { resolvePolicy } from './paymentPolicy.js';

export interface AdminCustomerRow {
  custname: string;
  cust_desc: string | null;
  user_count: number;
  kind: string;                 // stored override ('auto'|'cash'|'net'), default 'auto'
  resolvedKind: 'cash' | 'net'; // what resolvePolicy returns
  open_debt_threshold: number | null;
  allow_order_with_open_debt: number;
  paymentTerms: string | null;  // cached PAYDES, may be null
  openTotal: number | null;     // cached, may be null
}

/** Read a customer's CACHED finance snapshot only (no live Priority call). Returns
 *  {paymentTerms, openTotal} or nulls if nothing is cached. Adapt the table/column
 *  names to what finance.ts actually persists (read it first). */
function cachedFinance(custname: string): { paymentTerms: string | null; openTotal: number | null } {
  // EXAMPLE — replace with the real finance-cache table/shape from finance.ts:
  const row = db.prepare('SELECT data FROM finance_cache WHERE custname = ?').get(custname) as { data: string } | undefined;
  if (!row) return { paymentTerms: null, openTotal: null };
  try {
    const s = JSON.parse(row.data);
    return { paymentTerms: s?.profile?.paymentTerms ?? null, openTotal: s?.balance?.openTotal ?? null };
  } catch { return { paymentTerms: null, openTotal: null }; }
}

export function listCustomersAdmin(q: string, page: number, pageSize: number): { items: AdminCustomerRow[]; total: number } {
  const like = `%${q.trim()}%`;
  const where = q.trim() ? `AND (u.custname LIKE ? OR u.cust_desc LIKE ?)` : '';
  const params: unknown[] = q.trim() ? [like, like] : [];
  const total = (db.prepare(
    `SELECT COUNT(*) n FROM (SELECT u.custname FROM users u WHERE u.role='customer' AND u.custname IS NOT NULL ${where} GROUP BY u.custname)`
  ).get(...params) as { n: number }).n;
  const rows = db.prepare(
    `SELECT u.custname AS custname, MAX(u.cust_desc) AS cust_desc, COUNT(*) AS user_count,
            cp.kind AS kind, cp.open_debt_threshold AS open_debt_threshold, cp.allow_order_with_open_debt AS allow_order_with_open_debt
     FROM users u LEFT JOIN customer_policies cp ON cp.custname = u.custname
     WHERE u.role='customer' AND u.custname IS NOT NULL ${where}
     GROUP BY u.custname ORDER BY cust_desc IS NULL, cust_desc LIMIT ? OFFSET ?`
  ).all(...params, pageSize, page * pageSize) as Array<Record<string, unknown>>;
  const items: AdminCustomerRow[] = rows.map((r) => {
    const custname = String(r.custname);
    const fin = cachedFinance(custname);
    return {
      custname,
      cust_desc: (r.cust_desc as string) ?? null,
      user_count: Number(r.user_count) || 0,
      kind: (r.kind as string) ?? 'auto',
      resolvedKind: resolvePolicy(custname, fin.paymentTerms).kind,
      open_debt_threshold: r.open_debt_threshold == null ? null : Number(r.open_debt_threshold),
      allow_order_with_open_debt: Number(r.allow_order_with_open_debt) || 0,
      paymentTerms: fin.paymentTerms,
      openTotal: fin.openTotal,
    };
  });
  return { items, total };
}
```

- [ ] **Step 3:** Add the route in `server/index.ts` (near the products admin routes), `requireAdmin`, importing `listCustomersAdmin` from `./customers.js`:
```ts
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const page = Math.max(0, Number(req.query.page) || 0);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  res.json(listCustomersAdmin(q, page, pageSize));
});
```

- [ ] **Step 4:** typecheck + build. Curl (admin):
```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev > /tmp/t1.log 2>&1 & sleep 8
AU=$(grep '^ADMIN_BOOTSTRAP_USERNAME=' .env|cut -d= -f2-); AP=$(grep '^ADMIN_BOOTSTRAP_PASSWORD=' .env|cut -d= -f2-)
curl -s -c /tmp/a.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$AU\",\"password\":\"$AP\"}" -o /dev/null
curl -s -b /tmp/a.j "localhost:3030/api/admin/customers?page=0" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("total="+j.total,"first="+JSON.stringify(j.items[0]))})'
curl -s -o /dev/null -w 'anon=%{http_code}\n' "localhost:3030/api/admin/customers"
pkill -f "tsx watch server/index.ts" 2>/dev/null; pkill -f "node_modules/.bin/vite" 2>/dev/null
```
Expected: a `total` ≥ 1 and a first item with `custname`, `user_count`, `resolvedKind`; anon → 401.

- [ ] **Step 5:** Commit: `git add server/customers.ts server/index.ts && git commit -m "feat(admin): list companies endpoint (group-by custname + cached finance + resolved policy)"`

---

### Task 2: get/patch/batch customer + routes

**Files:** Modify `server/customers.ts`, `server/index.ts`

- [ ] **Step 1:** Append to `server/customers.ts`:
```ts
import { getAccountSummary } from './finance.js';

const PATCHABLE = new Set(['kind', 'open_debt_threshold', 'allow_order_with_open_debt']);

export function patchCustomer(custname: string, patch: Record<string, unknown>): void {
  const kind = patch.kind != null && ['auto', 'cash', 'net'].includes(String(patch.kind)) ? String(patch.kind) : undefined;
  const thr = 'open_debt_threshold' in patch
    ? (patch.open_debt_threshold === '' || patch.open_debt_threshold == null ? null : Number(patch.open_debt_threshold))
    : undefined;
  const allow = 'allow_order_with_open_debt' in patch ? (patch.allow_order_with_open_debt ? 1 : 0) : undefined;
  // Upsert only the provided fields; COALESCE keeps untouched columns.
  db.prepare(
    `INSERT INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt, updated_at)
     VALUES (@custname, COALESCE(@kind,'auto'), @thr, COALESCE(@allow,0), datetime('now'))
     ON CONFLICT(custname) DO UPDATE SET
       kind = COALESCE(@kind, kind),
       open_debt_threshold = CASE WHEN @thrSet=1 THEN @thr ELSE open_debt_threshold END,
       allow_order_with_open_debt = COALESCE(@allow, allow_order_with_open_debt),
       updated_at = datetime('now')`
  ).run({ custname, kind: kind ?? null, thr: thr ?? null, thrSet: thr !== undefined || ('open_debt_threshold' in patch) ? 1 : 0, allow: allow ?? null });
}

export function batchUpdateCustomers(items: Array<Record<string, unknown>>): number {
  let n = 0;
  const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const custname = String(row.custname || '');
      if (!custname) continue;
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(row)) if (PATCHABLE.has(k)) patch[k] = row[k];
      if (Object.keys(patch).length) { patchCustomer(custname, patch); n++; }
    }
  });
  tx(items);
  return n;
}

export async function getCustomerAdmin(custname: string): Promise<Record<string, unknown>> {
  const pol = db.prepare('SELECT kind, open_debt_threshold, allow_order_with_open_debt FROM customer_policies WHERE custname = ?').get(custname)
    || { kind: 'auto', open_debt_threshold: null, allow_order_with_open_debt: 0 };
  const users = db.prepare(
    `SELECT id, username, customer_role, status, last_login_at FROM users WHERE custname = ? ORDER BY username`
  ).all(custname);
  const cust_desc = (db.prepare('SELECT cust_desc FROM users WHERE custname = ? AND cust_desc IS NOT NULL LIMIT 1').get(custname) as { cust_desc?: string } | undefined)?.cust_desc ?? null;
  let finance: Record<string, unknown> = { priorityOk: false };
  try {
    const s = await getAccountSummary(custname);
    finance = { priorityOk: s.priorityOk !== false, paymentTerms: s.profile?.paymentTerms ?? null, openTotal: s.balance?.openTotal ?? null, creditLimit: s.balance?.creditLimit ?? null, obligo: s.balance?.obligo ?? null };
  } catch { /* leave priorityOk:false */ }
  const resolvedKind = resolvePolicy(custname, (finance.paymentTerms as string) ?? null).kind;
  return { custname, cust_desc, policy: pol, resolvedKind, users, finance };
}
```
(Adjust the `getAccountSummary` field access to the real `AccountSummary` shape — read `finance.ts`. The `patchCustomer` upsert must correctly handle "threshold explicitly set to null" vs "threshold not in patch" — verify with the curl below; if the `@thrSet` named-param trick is awkward in better-sqlite3, simplify to a read-modify-write: read the row, merge the provided fields, then a plain upsert.)

- [ ] **Step 2:** Add routes in `server/index.ts` (`requireAdmin`), importing `getCustomerAdmin, patchCustomer, batchUpdateCustomers`:
```ts
app.get('/api/admin/customers/:custname', requireAdmin, ah(async (req, res) => { res.json(await getCustomerAdmin(req.params.custname)); }));
app.patch('/api/admin/customers/:custname', requireAdmin, (req, res) => { patchCustomer(req.params.custname, (req.body || {}) as Record<string, unknown>); res.json({ ok: true }); });
app.post('/api/admin/customers/batch', requireAdmin, (req, res) => {
  const items = Array.isArray((req.body || {}).items) ? (req.body as { items: Array<Record<string, unknown>> }).items : [];
  res.json({ changes: batchUpdateCustomers(items) });
});
```
(NOTE: the existing `GET/PATCH /api/admin/customers/:custname/policy` routes still match — ensure express route order doesn't conflict. `/:custname` and `/:custname/policy` are distinct paths, so both coexist; leave the old ones, they're harmless.)

- [ ] **Step 3:** typecheck + build. Curl (admin session): pick a real custname from Task 1's list, then:
```bash
C=10184
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/customers/$C -H 'Content-Type: application/json' -d '{"kind":"cash","open_debt_threshold":5000}' -w '\npatch=%{http_code}\n'
curl -s -b /tmp/a.j localhost:3030/api/admin/customers/$C | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify({policy:j.policy,users:j.users.length,terms:j.finance.paymentTerms,resolved:j.resolvedKind}))})'
curl -s -b /tmp/a.j -X POST localhost:3030/api/admin/customers/batch -H 'Content-Type: application/json' -d "{\"items\":[{\"custname\":\"$C\",\"allow_order_with_open_debt\":true}]}" -w '\nbatch=%{http_code}\n'
# reset
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/customers/$C -H 'Content-Type: application/json' -d '{"kind":"auto","open_debt_threshold":null,"allow_order_with_open_debt":false}' -o /dev/null
```
Expected: patch 200; GET shows `policy.kind:"cash"`, `open_debt_threshold:5000`, a `users` count, the cached/live terms, a `resolvedKind`; batch 200 `{changes:1}`.

- [ ] **Step 4:** Commit: `git add server/customers.ts server/index.ts && git commit -m "feat(admin): customer get/patch/batch endpoints (policy upsert + users + live finance)"`

---

### Task 3: Companies list board (client) + "לקוחות" tab

**Files:** Create `src/pages/adminCustomers.ts`; Modify `src/pages/admin.ts`

- [ ] **Step 1:** Read `src/pages/adminProducts.ts` fully (the inline-edit board) and `src/pages/admin.ts` (tab registration). Clone the board into `src/pages/adminCustomers.ts` as `renderAdminCustomers(shell)`:
   - `edits = new Map<string, Record<string, unknown>>()` keyed by `custname`.
   - `loadList()` → `GET /api/admin/customers?q=&page=` → render a `<table>`: columns **חברה** (`cust_desc` + small `custname`), **משתמשים** (`user_count`), **תנאים** (`paymentTerms ?? '—'`), **חוב** (`openTotal!=null ? '₪'+openTotal : '—'`), **סוג** (`<select data-field="kind">` auto/cash/net, value = stored `kind`), **סף** (`<input class="cell-edit" data-field="open_debt_threshold" type="number">`), **פטור** (toggle chip `data-field="allow_order_with_open_debt"`). Each editable control binds on input/change → `setEdit(custname, field, value)`.
   - The whole row (except the editable controls) is clickable → `location.hash = '#admin/customers/' + custname`.
   - Sticky `#cust-save-bar` (clone `#inline-save-bar`): "שמור N שינויים" → `saveEdits()` POSTs `{items:[{custname,...patch}]}` to `/api/admin/customers/batch`, clears `edits`, reloads; "בטל" clears + reloads.
   - A search box bound to `q` + a pager (clone the products pager).
   Match the products file's exact helpers (`chipStyle`, the save-bar show/hide, `escapeHtml`).

- [ ] **Step 2:** In `src/pages/admin.ts`: add the import, a **"לקוחות"** tab link (next to the products/users tabs), and the dispatch for `#admin/customers` → `renderAdminCustomers(c)`. Match the exact tab/dispatch pattern in that file.

- [ ] **Step 3:** typecheck + build. dev-browser (admin):
```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev > /tmp/t3.log 2>&1 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome --no-first-run --disable-gpu about:blank >/tmp/c.log 2>&1 &
sleep 8
cat > /tmp/cb.js <<'JS'
const p=await browser.getPage("main"); await p.setViewportSize({width:1100,height:900});
const AU=process.env.AU, AP=process.env.AP;
await p.goto("http://localhost:5175/#login",{waitUntil:"networkidle"});
if(await p.$('input[name=username]')){await p.fill('input[name=username]',AU);await p.fill('input[name=password]',AP);await p.$eval('#login-form',f=>f.requestSubmit());await p.waitForTimeout(2000);}
await p.goto("http://localhost:5175/#admin/customers",{waitUntil:"networkidle"}); await p.waitForTimeout(2000);
console.log("BOARD:",JSON.stringify(await p.evaluate(()=>({rows:document.querySelectorAll('table tr').length, hasKindSelect:!!document.querySelector('[data-field=kind]'), tab:/לקוחות/.test(document.body.innerText)}))));
JS
AU=$(grep '^ADMIN_BOOTSTRAP_USERNAME=' .env|cut -d= -f2-) AP=$(grep '^ADMIN_BOOTSTRAP_PASSWORD=' .env|cut -d= -f2-) dev-browser --connect < /tmp/cb.js 2>/dev/null | grep BOARD
pkill -f "tsx watch server/index.ts" 2>/dev/null; pkill -f "node_modules/.bin/vite" 2>/dev/null; pkill -f "remote-debugging-port=9222" 2>/dev/null
```
Expected: `BOARD: {"rows":>1,"hasKindSelect":true,"tab":true}`.

- [ ] **Step 4:** Commit: `git add src/pages/adminCustomers.ts src/pages/admin.ts && git commit -m "feat(admin): companies list board — inline policy edit + batch save + 'לקוחות' tab"`

---

## Phase 2 — Per-company card

### Task 4: Customer card — policy + Priority context + flags scaffold

**Files:** Create `src/pages/adminCustomerCard.ts`; Modify `src/pages/admin.ts`

- [ ] **Step 1:** Create `src/pages/adminCustomerCard.ts` `renderCustomerCard(shell, custname)`: fetch `GET /api/admin/customers/:custname`, render sections:
   - **Header**: `cust_desc` + `custname` + `users.length` + a back link to `#admin/customers`.
   - **מדיניות תשלום**: a small form — kind `<select>` (auto/cash/net, value=`policy.kind`), threshold `<input number>` (`policy.open_debt_threshold`), exempt checkbox (`policy.allow_order_with_open_debt`), a "שמור" button → `PATCH /api/admin/customers/:custname` with the form values → `toast('נשמר ✓','ok')`. Show the **resolved** kind + a hint of the Priority `paymentTerms` it derives from.
   - **נתוני Priority (קריאה בלבד)**: `finance.priorityOk ? (terms / openTotal / creditLimit / obligo)` else "לא זמין".
   - **דגלים נוספים**: a placeholder section "אין דגלים נוספים כרגע" (scaffold for future per-company flags). Leave a clear extension point comment.
   - **משתמשי החברה**: render a list of `users` (username, customer_role, status) — read-only in this task (management actions are Task 5). 
   Use `api.get`/`api.patch`, `toast`, `escapeHtml` matching the codebase.

- [ ] **Step 2:** In `src/pages/admin.ts` / the router: register `#admin/customers/:custname` → `renderCustomerCard(c, custname)` (string-slice the param; ensure it's matched BEFORE the bare `#admin/customers` so the param route wins — check ordering).

- [ ] **Step 3:** typecheck + build. dev-browser: navigate `#admin/customers/10184` → assert the card shows "מדיניות תשלום", the kind select, and "נתוני Priority"; save a policy change → re-fetch shows it. (Script like Task 3, goto the card hash, assert text + that a PATCH persists.)

- [ ] **Step 4:** Commit: `git add src/pages/adminCustomerCard.ts src/pages/admin.ts && git commit -m "feat(admin): per-company card — policy form + Priority context + flags scaffold"`

---

### Task 5: Company user management in the card

**Files:** Modify `src/pages/adminCustomerCard.ts`

- [ ] **Step 1:** Read `src/pages/adminUsers.ts` for the EXACT existing endpoints + payloads used to: create a customer login (`POST /api/admin/users` with username/password/custname/cust_desc/email/phone), reset password, toggle status. In the card's **משתמשי החברה** section, add per-user actions (reset password, enable/disable) and a **"+ משתמש חדש"** form that creates a login **prefilled with this company's `custname`/`cust_desc`**. After any action, re-fetch `GET /api/admin/customers/:custname` and re-render the users list. Reuse the same endpoints/payloads as `adminUsers.ts` (do not invent new ones). `toast` feedback.

- [ ] **Step 2:** typecheck + build. dev-browser: on `#admin/customers/10184`, assert the "+ משתמש חדש" control + at least one user row with a reset/disable action render. (Don't necessarily create a real user; asserting the controls exist is enough. If you do create one, use a throwaway username and delete/disable it after.)

- [ ] **Step 3:** Commit: `git add src/pages/adminCustomerCard.ts && git commit -m "feat(admin): manage a company's user logins from its card"`

---

## Phase 3 — Cleanup + ship

### Task 6: Remove the per-user policy prompt + final verify + deploy

**Files:** Modify `src/pages/adminUsers.ts`

- [ ] **Step 1:** Remove the `editPolicy` function + the "מדיניות תשלום" `prompt()` button from the user rows in `src/pages/adminUsers.ts` (policy now lives on the company card). Leave the rest of adminUsers (create login, reset, status) unchanged. typecheck + build.

- [ ] **Step 2:** Commit: `git add src/pages/adminUsers.ts && git commit -m "refactor(admin): drop per-user policy prompt (moved to company card)"`

- [ ] **Step 3:** Full gate: reset data-qa policies (single-quoted SQL), `npm run typecheck && npm run build && node scripts/test-payment-policy.mjs` (fresh temp DB), boot + `qa/run-auth.sh` (logout browser first) → **21/21**.

- [ ] **Step 4:** Deploy: `git push origin feat/payment-policy && git push origin HEAD:main`; poll bundle-hash; health-check `/api/auth/me` 200, `/api/admin/customers` 401.

- [ ] **Step 5:** Report: prod healthy; the "לקוחות" board + per-company card live; payment policy now managed per company (no more per-user prompt).

---

## Self-Review notes
- **Spec coverage:** companies list board (Task 1,3, §3) ✓ · per-company card with policy + users + Priority + flags scaffold (Task 2,4,5, §3b) ✓ · cached list / live card finance (Task 1,2, §3a) ✓ · adminUsers prompt removed (Task 6) ✓ · 4 new endpoints (Task 1,2) ✓. Phasing matches spec §4.
- **Types:** `AdminCustomerRow`, `listCustomersAdmin`/`getCustomerAdmin`/`patchCustomer`/`batchUpdateCustomers` consistent across server tasks; client `renderAdminCustomers`/`renderCustomerCard` consistent.
- **Flagged for implementer:** (a) read the real finance-cache table shape for `cachedFinance` (the `finance_cache`/`data` names are a guess — verify); (b) the `getAccountSummary` field paths must match the real `AccountSummary`; (c) confirm the `patchCustomer` upsert handles "threshold set to null" correctly — simplify to read-merge-write if the named-param CASE is fragile; (d) route ordering `#admin/customers/:custname` before `#admin/customers`.
