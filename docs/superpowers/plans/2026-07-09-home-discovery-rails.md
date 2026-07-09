# Home Discovery Rails — "מוצרים חדשים" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A second horizontally-scrollable rail on the home screen — "חדשים אצלנו ✨" — showing products the admin flagged as new (image, name, price, one-tap add-to-cart), alongside the existing "מבצעים והנחות" promo rail.

**Architecture:** The promotions rail already exists and is already horizontal (`promo-rail` CSS: `overflow-x:auto` + scroll-snap, cards with admin image/title from `promoCards()` in `server/home.ts`) — it is NOT touched. The new rail is admin-driven data: a `b2b_is_new` flag + `b2b_new_since` timestamp on `catalog_cache` (mirroring the `b2b_out_of_stock` pattern everywhere: PATCHABLE whitelist, board chip, drawer checkbox, bulk action), a `listNewProducts()` query in the catalog domain, one new field on the home aggregate, and a client rail that reuses the existing `.rail`/`.rail-item` CSS. No feature flag needed: zero flagged products = no rail = zero change for customers.

**Tech Stack:** Express + better-sqlite3 (`server/*.ts`), vanilla-TS Vite front (`src/`). Test convention: `node scripts/test-*.mjs` against `dist/server/*.js` with a scratch `DATA_DIR` (build first).

## Global Constraints

- The existing promo rail (`src/pages/home.ts:140-158`, `promoCards()` in `server/home.ts`) stays untouched.
- "New" is a manual admin flag, exactly like אזל מהמלאי: `b2b_is_new` (0/1). `b2b_new_since` is stamped ONLY on a 0→1 transition and cleared on 1→0 — re-saving an already-new product must NOT bump it to the front of the rail.
- Rail order: `b2b_new_since DESC`, capped at 12 cards. Excluded: hidden (`b2b_visible=0`), inactive, out-of-stock, and unpriced products (add-to-cart would be rejected server-side for those).
- Rail add-to-cart adds one box (`box_size` units) via the existing `PUT /api/cart/lines/:partname` with `mode:'add'` — the single chokepoint that already enforces visibility/OOS/price rules.
- Catalog cards get a small "חדש" pill; neutral, no layout shift.
- All customer-facing copy Hebrew RTL. Node >= 20. Gates: `npm run typecheck`, `npm run build`, `scripts/test-new-products.mjs`.
- Out of scope (noted, not built): CSV export/import of the new flag, a board status filter for "new", auto-expiry after N days, badge on the product detail page.

---

### Task 1: Data layer — columns, stamping, `listNewProducts`, `isNew` on catalog items

**Files:**
- Modify: `server/db.ts` (catalog_cache ensureColumn block, ~line 390)
- Modify: `server/products.ts` (`PATCHABLE_COLUMNS` ~line 118, `patchProduct` ~line 131, `AdminProductRow` + both SELECTs at lines 94/110)
- Modify: `server/catalog.ts` (`CatalogItem` ~line 224, `getProduct` SELECT ~line 371 + return ~line 403, `queryCatalog` SELECT ~line 320 + row map ~line 360, new `listNewProducts`)
- Test: `scripts/test-new-products.mjs`

**Interfaces:**
- Consumes: existing `getProduct(partname, custname)`, `patchProduct(partname, patch)`, `ensureColumn`.
- Produces (later tasks rely on):
  - Columns: `catalog_cache.b2b_is_new` (INTEGER NOT NULL DEFAULT 0), `catalog_cache.b2b_new_since` (TEXT, null unless flagged).
  - `CatalogItem.isNew: boolean` (from `getProduct` and `queryCatalog`).
  - `listNewProducts(custname: string | null, limit = 12): CatalogItem[]` exported from `server/catalog.ts`.
  - `patchProduct` accepts `b2b_is_new` (boolean) and manages `b2b_new_since` itself.

- [ ] **Step 1: Columns** — in `server/db.ts`, after the `b2b_out_of_stock` ensureColumn (~line 390):

```ts
// "מוצר חדש" home-rail flag (manual admin, like out-of-stock). b2b_new_since is
// stamped on the 0→1 transition only — it orders the rail newest-first.
ensureColumn('catalog_cache', 'b2b_is_new', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('catalog_cache', 'b2b_new_since', 'TEXT');
```

- [ ] **Step 2: Write the failing test** — create `scripts/test-new-products.mjs`:

```js
// Unit checks for the new-products rail data layer.
// Run: npm run build && DATA_DIR=<scratch> node scripts/test-new-products.mjs
import assert from 'node:assert/strict';
import { listNewProducts, getProduct } from '../dist/server/catalog.js';
import { patchProduct } from '../dist/server/products.js';
import Database from 'better-sqlite3';
import path from 'node:path';

const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
const seed = db.prepare(
  `INSERT INTO catalog_cache (partname, partdes, list_price, active) VALUES (?, ?, ?, ?)`
);
seed.run('N-OK', 'חדש תקין', 50, 1);
seed.run('N-HIDDEN', 'חדש מוסתר', 50, 1);
seed.run('N-INACTIVE', 'חדש לא פעיל', 50, 0);
seed.run('N-OOS', 'חדש אזל', 50, 1);
seed.run('N-NOPRICE', 'חדש בלי מחיר', null, 1);
seed.run('N-OLD', 'ישן', 50, 1);
db.prepare("UPDATE catalog_cache SET b2b_visible = 0 WHERE partname = 'N-HIDDEN'").run();
db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 1 WHERE partname = 'N-OOS'").run();
db.close();

// patchProduct flips the flag and stamps b2b_new_since
for (const p of ['N-OK', 'N-HIDDEN', 'N-INACTIVE', 'N-OOS', 'N-NOPRICE']) patchProduct(p, { b2b_is_new: true });
const db2 = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));
const since = db2.prepare("SELECT b2b_new_since FROM catalog_cache WHERE partname = 'N-OK'").get().b2b_new_since;
assert.ok(since, 'b2b_new_since stamped on 0→1');

// re-saving the SAME value must NOT restamp (no jumping to the front)
patchProduct('N-OK', { b2b_is_new: true, b2b_description: 'עודכן' });
assert.equal(
  db2.prepare("SELECT b2b_new_since FROM catalog_cache WHERE partname = 'N-OK'").get().b2b_new_since,
  since,
  'unchanged flag keeps its stamp'
);

// unflagging clears the stamp
patchProduct('N-NOPRICE', { b2b_is_new: false });
assert.equal(db2.prepare("SELECT b2b_new_since FROM catalog_cache WHERE partname = 'N-NOPRICE'").get().b2b_new_since, null);
patchProduct('N-NOPRICE', { b2b_is_new: true }); // back on (still excluded below — no price)

// isNew surfaces on CatalogItem
assert.equal(getProduct('N-OK', null).isNew, true);
assert.equal(getProduct('N-OLD', null).isNew, false);

// the rail query: only visible+active+in-stock+priced flagged products
const rail = listNewProducts(null);
assert.deepEqual(rail.map((p) => p.partname), ['N-OK'], 'hidden/inactive/OOS/unpriced/unflagged all excluded');

// ordering: explicit stamps, newest first
db2.prepare("UPDATE catalog_cache SET b2b_is_new = 1, b2b_new_since = '2026-01-01 00:00:00' WHERE partname = 'N-OLD'").run();
db2.prepare("UPDATE catalog_cache SET b2b_new_since = '2026-02-01 00:00:00' WHERE partname = 'N-OK'").run();
db2.close();
assert.deepEqual(listNewProducts(null).map((p) => p.partname), ['N-OK', 'N-OLD'], 'ordered b2b_new_since DESC');
assert.deepEqual(listNewProducts(null, 1).map((p) => p.partname), ['N-OK'], 'limit respected');

console.log('new-products data layer: ALL PASS');
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run build && rm -rf /tmp/np-t1 && mkdir -p /tmp/np-t1 && DATA_DIR=/tmp/np-t1 node scripts/test-new-products.mjs`
Expected: FAIL — `listNewProducts` is not exported (SyntaxError on import).

- [ ] **Step 4: Whitelist + stamping in `server/products.ts`** — add `'b2b_is_new'` to `PATCHABLE_COLUMNS`:

```ts
const PATCHABLE_COLUMNS = new Set([
  'b2b_visible',
  'b2b_partdes_override',
  'b2b_description',
  'b2b_tags',
  'b2b_min_qty',
  'b2b_sort_priority',
  'b2b_featured',
  'b2b_category_override',
  'b2b_out_of_stock',
  'b2b_is_new',
  'box_size',
]);
```

In `patchProduct`, directly after the whitelist `for` loop (before `if (cols.length === 0)`), add:

```ts
  // Flipping b2b_is_new manages its companion stamp: 0→1 stamps b2b_new_since
  // (orders the home rail newest-first), 1→0 clears it. Same-value saves leave
  // the stamp alone so an edited product doesn't jump to the front of the rail.
  if ('b2b_is_new' in patch) {
    const cur = db.prepare('SELECT b2b_is_new FROM catalog_cache WHERE partname = ?').get(partname) as
      | { b2b_is_new: number } | undefined;
    const next = patch.b2b_is_new ? 1 : 0;
    if (cur && cur.b2b_is_new !== next) {
      cols.push(next ? "b2b_new_since = datetime('now')" : 'b2b_new_since = NULL');
    }
  }
```

Extend `AdminProductRow` with:

```ts
  b2b_is_new: number;
  b2b_new_since: string | null;
```

and add `b2b_is_new, b2b_new_since` to the column list of BOTH admin SELECTs (lines ~94 and ~110 — `listProductsAdmin` and `getProductAdmin`).

- [ ] **Step 5: `isNew` + `listNewProducts` in `server/catalog.ts`** — add to `CatalogItem`:

```ts
  /** true → admin flagged "מוצר חדש": shows the catalog pill + the home rail. */
  isNew: boolean;
```

In `getProduct`: add `c.b2b_is_new` to the SELECT column list, `b2b_is_new: number` to the row type, and `isNew: row.b2b_is_new === 1,` to the returned object. Do the same in `queryCatalog` (SELECT ~line 320, row type ~line 343, row map ~line 360: `isNew: r.b2b_is_new === 1,`).

Add at the end of the file:

```ts
/** Home-rail "מוצרים חדשים": admin-flagged products, newest stamp first. Runs each
 *  candidate through getProduct so pricing/visibility/OOS rules stay in ONE place;
 *  over-fetches because OOS/unpriced rows are filtered after the fact. */
export function listNewProducts(custname: string | null, limit = 12): CatalogItem[] {
  const rows = db
    .prepare(
      `SELECT partname FROM catalog_cache
       WHERE b2b_is_new = 1 AND active = 1 AND b2b_visible = 1
       ORDER BY b2b_new_since DESC, updated_at DESC
       LIMIT ?`
    )
    .all(limit * 2) as { partname: string }[];
  const out: CatalogItem[] = [];
  for (const r of rows) {
    const p = getProduct(r.partname, custname);
    if (!p || p.outOfStock || typeof p.price !== 'number' || p.price <= 0) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run typecheck && npm run build && rm -rf /tmp/np-t1 && mkdir -p /tmp/np-t1 && DATA_DIR=/tmp/np-t1 node scripts/test-new-products.mjs`
Expected: `new-products data layer: ALL PASS`

- [ ] **Step 7: Commit**

```bash
git add server/db.ts server/products.ts server/catalog.ts scripts/test-new-products.mjs
git commit -m "feat(new-products): b2b_is_new flag, stamped ordering, and listNewProducts query"
```

---

### Task 2: Home rail — API field + horizontal UI + add-to-cart

**Files:**
- Modify: `server/home.ts` (interface ~line 33-65, return ~line 157)
- Modify: `src/pages/home.ts` (interface ~line 40, render ~line 140-232, wiring ~line 234+)
- Modify: `src/styles.css` (after `.rail-item .pr`, ~line 616)

**Interfaces:**
- Consumes: `listNewProducts(custname)` from `./catalog.js` (Task 1).
- Produces: `HomeData.newProducts: CatalogItem[]` on `GET /api/home`; client renders `#new-rail` with `.add-mini` buttons that `PUT /api/cart/lines/:partname {quantity: box_size, mode:'add'}`.

- [ ] **Step 1: Server field** — in `server/home.ts`, add to imports:

```ts
import { getProduct, listNewProducts, type CatalogItem } from './catalog.js';
```

(replacing the existing `import { getProduct } from './catalog.js';`). Add to the `HomeData` interface after `promotions: HomePromo[];`:

```ts
  /** admin-flagged "מוצרים חדשים" for the home rail (visible, in-stock, priced; max 12) */
  newProducts: CatalogItem[];
```

and in the returned object of `getHomeData`, after `promotions: promoCards(custname),`:

```ts
    newProducts: listNewProducts(custname),
```

- [ ] **Step 2: Client interface** — in `src/pages/home.ts`, next to the `promotions: HomePromo[];` field of the local `HomeData` interface, add:

```ts
  newProducts: {
    partname: string;
    partdes: string | null;
    image_url: string | null;
    price: number | null;
    box_size: number;
  }[];
```

- [ ] **Step 3: Render the rail** — in `renderHome`, directly after the `promoRail` block (after line ~158), add:

```ts
  // New-products rail — horizontal scroll, reuses the .rail/.rail-item pattern.
  let newRail = '';
  if (d.newProducts.length > 0) {
    newRail = `
      <h2 class="home-sec">חדשים אצלנו ✨</h2>
      <div class="rail" id="new-rail">
        ${d.newProducts
          .map((it) => {
            const enc = encodeURIComponent(it.partname);
            return `
          <div class="rail-item">
            <a class="thumb" href="#product/${enc}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt="" loading="lazy"/>` : '✨'}</a>
            <a class="nm" href="#product/${enc}" style="display:block;color:inherit;text-decoration:none">${escapeHtml(it.partdes || it.partname)}</a>
            <div class="pr">${it.price != null ? formatMoney(it.price) : ''}</div>
            <button class="add-mini" data-part="${escapeAttr(it.partname)}" data-box="${it.box_size}">הוסף · ארגז ${it.box_size}</button>
          </div>`;
          })
          .join('')}
      </div>`;
  }
```

and place it in the template: change `${promoRail}` (inside `shell.innerHTML`, ~line 224) to:

```ts
    ${promoRail}
    ${newRail}
```

- [ ] **Step 4: Wire add-to-cart** — after the existing `#reorder-last` listener block (~line 251), add:

```ts
  shell.querySelectorAll<HTMLButtonElement>('#new-rail .add-mini').forEach((b) => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api.put(`/api/cart/lines/${encodeURIComponent(b.dataset.part!)}`, {
          quantity: Number(b.dataset.box) || 1,
          mode: 'add',
        });
        await refreshCartCount();
        toast('נוסף לעגלה ✓', 'ok');
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      } finally {
        b.disabled = false;
      }
    });
  });
```

(`api`, `refreshCartCount`, `toast`, `formatMoney`, `escapeHtml`, `escapeAttr` are already imported in this file — verify the import line and add any that are missing.)

- [ ] **Step 5: CSS** — in `src/styles.css`, after `.rail-item .pr` (~line 616), add:

```css
.rail-item .add-mini { width: 100%; margin-top: 0.35rem; padding: 0.4rem 0; font-size: 0.8rem; font-weight: 700; border-radius: 8px; }
```

- [ ] **Step 6: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/home.ts src/pages/home.ts src/styles.css
git commit -m "feat(home): horizontal 'חדשים אצלנו' rail with one-tap box add"
```

---

### Task 3: Catalog "חדש" pill on product cards

**Files:**
- Modify: `src/pages/catalog.ts` (local `CatalogItem` interface + `gridCard` ~line 580)
- Modify: `src/styles.css`

**Interfaces:**
- Consumes: `isNew` on the catalog API items (Task 1 — `queryCatalog` already returns it).
- Produces: visual only.

- [ ] **Step 1: Type + badge** — in `src/pages/catalog.ts`, add `isNew?: boolean;` to the file's local `CatalogItem` interface. In `gridCard`, change the name div:

```ts
          <div class="nm">${it.isNew ? '<span class="new-pill">חדש</span> ' : ''}${escapeHtml(it.partdes || it.partname)}</div>
```

- [ ] **Step 2: CSS** — add to `src/styles.css` next to the rail styles:

```css
.new-pill { background: #dcfce7; color: #15803d; border: 1px solid #86efac; border-radius: 999px; font-size: 0.68rem; padding: 0 6px; font-weight: 700; vertical-align: middle; }
```

- [ ] **Step 3: Typecheck + build + commit**

Run: `npm run typecheck && npm run build`
Expected: clean.

```bash
git add src/pages/catalog.ts src/styles.css
git commit -m "feat(catalog): 'חדש' pill on cards of admin-flagged new products"
```

---

### Task 4: Admin controls — board chip, drawer checkbox, bulk actions

**Files:**
- Modify: `server/products.ts` (`BulkPayload` ~line 229, `bulkUpdate` switch ~line 240)
- Modify: `src/pages/adminProducts.ts` (row interface ~line 22, `chipStyle` ~line 46, row toggles ~line 352, bulk buttons ~line 112, drawer checkbox ~line 530, drawer save ~line 593)

**Interfaces:**
- Consumes: `PATCHABLE_COLUMNS` already accepts `b2b_is_new` (Task 1), so the inline chip + drawer + batch save flow through unchanged.
- Produces: bulk actions `'mark_new' | 'unmark_new'` on `POST /api/admin/products/bulk`.

- [ ] **Step 1: Bulk server cases** — in `server/products.ts`, extend the `BulkPayload` action union:

```ts
  action: 'hide' | 'show' | 'set_box_size' | 'set_min_qty' | 'feature' | 'unfeature' | 'mark_out_of_stock' | 'mark_in_stock' | 'mark_new' | 'unmark_new';
```

and add to the `switch` in `bulkUpdate` (after `mark_in_stock`):

```ts
    case 'mark_new':
      setClause = "b2b_is_new = 1, b2b_new_since = datetime('now')";
      break;
    case 'unmark_new':
      setClause = 'b2b_is_new = 0, b2b_new_since = NULL';
      break;
```

- [ ] **Step 2: Board UI** — in `src/pages/adminProducts.ts`:

Add to the product row interface (next to `b2b_out_of_stock: number;` ~line 22): `b2b_is_new: number;`

Add a chip color in `chipStyle` (before the fallback return):

```ts
  if (field === 'b2b_is_new') return 'background:#dcfce7;color:#15803d;border-color:#86efac';
```

Add the chip to the row toggles (~line 352):

```ts
  const toggles =
    statusToggle(p.partname, 'מוסתר', !p.b2b_visible, 'b2b_visible', true) +
    ' ' +
    statusToggle(p.partname, 'אזל', !!p.b2b_out_of_stock, 'b2b_out_of_stock') +
    ' ' +
    statusToggle(p.partname, '⭐', !!p.b2b_featured, 'b2b_featured') +
    ' ' +
    statusToggle(p.partname, 'חדש', !!p.b2b_is_new, 'b2b_is_new');
```

Add bulk buttons (after `mark_in_stock`, ~line 113):

```html
          <button class="ghost" data-bulk="mark_new">סמן כחדשים</button>
          <button class="ghost" data-bulk="unmark_new">בטל חדשים</button>
```

(The generic `data-bulk` click handler posts `{partnames, action}` as-is — no extra client logic, same as feature/unfeature.)

- [ ] **Step 3: Drawer** — add a checkbox after the `b2b_out_of_stock` label (~line 530):

```html
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
          <input type="checkbox" name="b2b_is_new" ${p.b2b_is_new ? 'checked' : ''}/> ✨ מוצר חדש (מופיע במסך הבית)
        </label>
```

and to the drawer save patch object (~line 593):

```ts
        b2b_is_new: fd.get('b2b_is_new') === 'on',
```

- [ ] **Step 4: Typecheck + tests + commit**

Run: `npm run typecheck && npm run build && rm -rf /tmp/np-t4 && mkdir -p /tmp/np-t4 && DATA_DIR=/tmp/np-t4 node scripts/test-new-products.mjs`
Expected: clean + ALL PASS.

```bash
git add server/products.ts src/pages/adminProducts.ts
git commit -m "feat(admin): mark products as 'חדש' — board chip, drawer, bulk actions"
```

---

### Task 5: Verification + deploy

**Files:** none.

- [ ] **Step 1: Full gate**

Run: `npm run typecheck && npm run build && rm -rf /tmp/np-e2e && mkdir -p /tmp/np-e2e && DATA_DIR=/tmp/np-e2e node scripts/test-new-products.mjs && DATA_DIR=/tmp/np-e2e node scripts/test-fast-track.mjs && DATA_DIR=/tmp/np-e2e node scripts/test-payment-policy.mjs`
Expected: everything green.

- [ ] **Step 2: Scripted home-flow check** — seed a scratch DB (user + 2 flagged products, one with an image), call `getHomeData` from `dist/server/home.js`, assert `newProducts` has both in stamp order with prices; add one to a cart via `setCartLine` and confirm quantity. (Write it in the session scratchpad, not the repo.)

- [ ] **Step 3: Manual UI check (local `npm run dev`)**

1. No products flagged: home shows NO new rail (zero customer change).
2. Admin → מוצרים: chip "חדש" toggles green on a row; drawer checkbox round-trips; bulk "סמן כחדשים" on 3 selected rows works.
3. Home as a customer: "חדשים אצלנו ✨" rail renders, scrolls horizontally with snap, newest-flagged first, images load, "הוסף · ארגז N" adds a box (toast + cart badge bump).
4. Catalog: flagged products show the green "חדש" pill; unflagged don't.
5. Flag a product that is also אזל מהמלאי: it must NOT appear in the rail but DOES show the pill in the catalog (grayed card).
6. Promo rail unchanged, both rails coexist without layout breakage on a narrow phone viewport.

- [ ] **Step 4: Deploy** — merge/push to `main` (Railway auto-deploys). Feature is admin-driven and dormant until products are flagged.

```bash
git push origin main
```
