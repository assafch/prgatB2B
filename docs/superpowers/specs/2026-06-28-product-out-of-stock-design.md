# Design — Per-Product "Out of Stock" Flag (admin override)

**Date:** 2026-06-28
**Status:** Approved (design) — pending implementation plan
**Author:** Assaf + Claude

## 1. Goal

Give the store owner a way to mark a product as **out of stock** so customers
can see it is unavailable and **cannot order it**, without the owner managing
exact inventory numbers yet. Implemented as a per-product **manual admin
override** (a boolean), set from the admin product area.

Hebrew label everywhere: **"אזל מהמלאי"**.

## 2. Scope

**In scope (now):**
- One manual boolean per product: `b2b_out_of_stock` (admin override).
- Customer sees out-of-stock products **grayed, with an "אזל מהמלאי" badge**, and
  **cannot add them to the cart by any path**.
- Customer **never sees a numeric stock level** — only available / out-of-stock.

**Out of scope (future seam, do NOT build):**
- Pulling the real numeric stock from Priority. The `catalog_cache.stock REAL`
  column already exists and is unused. The availability rule is centralized in one
  helper (`isOutOfStock`) so a future Priority-stock check slots in there with no
  other changes. This will likely change — see §10.

## 3. Behavior decisions (approved)

1. **Item already in the cart when it is marked out-of-stock** → it stays in the
   cart, flagged "אזל מהמלאי — יש להסיר", **blocks checkout** until removed; the
   customer can still **remove / reduce** it. It is **not** auto-removed.
2. **Usual-basket suggestions / reorder suggestions** → out-of-stock items simply
   **do not appear**.
3. **One-tap reorder of a past order** → silently **skips** out-of-stock lines and
   reports how many were actually added (existing "X מוצרים נוספו" / "אף מוצר…" flow).
4. Out-of-stock products **stay visible** in the catalog (grayed + badge), they are
   **not hidden**. (Hiding entirely is the existing separate `b2b_visible=0`.)

## 4. Data model

`server/db.ts` — add one column to `catalog_cache`, following the existing
`b2b_*` override pattern, via the `ensureColumn` migration block (next to the
other `b2b_*` columns):

```js
ensureColumn('catalog_cache', 'b2b_out_of_stock', 'INTEGER NOT NULL DEFAULT 0');
// admin manual override. 1 = out of stock (grayed, un-orderable); 0 = in stock.
// INDEPENDENT of the (currently unused) Priority `stock` column.
```

Existing rows default to `0` (in stock). The column is a B2B admin override and is
**not** touched by Priority sync (see §6).

### Single derivation rule

`server/catalog.ts` — one exported helper is the **only** place that decides
availability (so the future Priority-stock rule has one home):

```ts
export function isOutOfStock(row: { b2b_out_of_stock: number /*, stock?: number|null */ }): boolean {
  return row.b2b_out_of_stock === 1;
  // FUTURE (out of scope): || ((row.stock ?? Infinity) <= 0)
}
```

## 5. Server enforcement (single source of truth)

The cart has **one** insert chokepoint: `setCartLine()` in `server/orders.ts`.
Every add path (catalog keypad/swipe/stepper, product page, favorites, upsell,
barcode scan, assistant, `reorder/add-all`, `templates/:id/apply`,
`orders/:id/reorder`) funnels through it. Guarding it covers them all.

- **`setCartLine()`** (`server/orders.ts`): after the existing `getProduct` null
  check and price check, add — **for `mode === 'add'` only**:
  ```ts
  if (mode === 'add' && isOutOfStock(prod)) throw new OrderError('המוצר אזל מהמלאי — אינו זמין להזמנה');
  ```
  `mode === 'set'` is **not** blocked, so a customer can still reduce/remove an
  out-of-stock item already in the cart. (Removal via `mode:'set'` qty≤0 → DELETE
  is already always allowed.)
- **`getCart()`** (`server/orders.ts`, the `available:` mapping, ~line 43): change
  `available: prod !== null` → `available: prod !== null && !isOutOfStock(prod)`,
  **and** add a separate `outOfStock: prod !== null && isOutOfStock(prod)` field on
  the cart line so the cart UI can show the precise "אזל מהמלאי" badge while
  `available=false` drives the checkout block (existing behavior).
- **`submitOrder()`** re-validation loop (`server/orders.ts`): add an
  `isOutOfStock(prod)` check → reject submit with
  `המוצר "<name>" אזל מהמלאי — הסירו אותו מהסל`. Belt-and-suspenders for the
  race where an item goes out of stock between add and submit.
- **`reorderToCart()`** (`server/orders.ts`): add `|| isOutOfStock(prod)` to the
  per-line skip condition (one-tap reorder skips out-of-stock lines).
- **`getReorderSuggestions()`** (`server/reorder.ts`): add `|| isOutOfStock(prod)`
  to the skip condition so out-of-stock items never appear in the usual basket.

`getProduct()` must continue to **return the product object** for out-of-stock
items (they stay visible). It returns `null` only for hidden/inactive, as today.

## 6. Priority-sync override preservation

`server/catalog.ts` → `refreshCatalogFromPriority()`: **NO CHANGE.** The upsert's
`ON CONFLICT(partname) DO UPDATE SET …` touches only Priority-sourced columns
(partdes, family, barcode, list_price, active, updated_at) and never the `b2b_*`
columns. The new `b2b_out_of_stock` override therefore survives every sync
automatically — this is the existing seam that makes admin overrides durable.

## 7. API shape (catalog → client)

The customer-facing catalog/product responses gain **one boolean** and never a
number. `server/catalog.ts`:
- `CatalogItem` interface: add `outOfStock: boolean`.
- `queryCatalog()` SELECT: add `c.b2b_out_of_stock`; map `outOfStock: isOutOfStock(r)`.
- `getProduct()` SELECT + row type + return mapping: same (`outOfStock`).
- `getSimilarProducts()` inherits via `queryCatalog()` — no extra change.
- `findByBarcode()` returns the product → carries `outOfStock`.

Endpoints that feed customer surfaces must include the field:
- `/api/catalog`, `/api/catalog/:partname`, `/api/catalog/:partname/similar`,
  `/api/catalog/barcode/:code` — all via the shaped `CatalogItem`.
- `/api/favorites/products` — ensure it returns `outOfStock` per item.
- Cart (`/api/cart`) lines — `available` + new `outOfStock` (see §5).

## 8. Customer UI (grayed + "אזל מהמלאי" badge + disabled add)

Single shared Hebrew constant for the label ("אזל מהמלאי") and one CSS treatment
(e.g. `.is-oos` → reduced opacity / grayscale + a coral badge), reused everywhere.

| Surface | File | What changes |
|---|---|---|
| Catalog grid card | `src/pages/catalog.ts` `gridCard()` | `data-oos` + `.is-oos` gray, badge after price, **disable** add/stepper |
| Catalog list row | `src/pages/catalog.ts` `listRow()` | same; **block A2 swipe** in `bindSwipe()` when `data-oos` |
| Quantity keypad (A1) | `src/pages/catalog.ts` `openQtyKeypad()` | if OOS: disable `.qsheet-cta`, show "אזל מהמלאי" notice |
| Client `CatalogItem` | `src/pages/catalog.ts` | add `outOfStock: boolean` |
| Product page | `src/pages/product.ts` | `Product.outOfStock`; gray, badge, disable add; gray OOS items in similar rail |
| Favorites | `src/pages/favorites.ts` | gray + badge + disable add (needs API field, §7) |
| Upsell sheet | `src/pages/upsell.ts` | gray + badge + disable `.up-add` |
| Barcode scan | `src/pages/scan.ts` | if `item.outOfStock`: show "אזל מהמלאי" toast, do **not** add |
| Home usual-basket (A3) | `src/pages/home.ts` | items already filtered out server-side (§5); no extra UI needed |
| Cart | `src/pages/cart.ts` | OOS line → existing `available=false` styling + "אזל מהמלאי" badge; checkout already blocked |

Client disabling is **UX only**; the server guard (§5) is the real enforcement.

## 9. Admin (your management area)

**Server `server/products.ts`:**
- `AdminProductRow` interface: add `b2b_out_of_stock: number`.
- `listProductsAdmin()` + `getProductAdmin()` SELECTs: add `b2b_out_of_stock`.
- `PATCHABLE_COLUMNS`: add `'b2b_out_of_stock'` (boolean→0/1 normalization already
  handled by `patchProduct()`).
- `bulkUpdate()`: add actions `mark_out_of_stock` (`b2b_out_of_stock = 1`) and
  `mark_in_stock` (`b2b_out_of_stock = 0`).
- `CSV_COLUMNS`: add `'b2b_out_of_stock'`; `importCsv()` parse `1/0/true/false/yes/no`.

**Client `src/pages/adminProducts.ts`:**
- `AdminProduct` interface: add `b2b_out_of_stock: number`.
- Table row: status badge "אזל מהמלאי" when set.
- Bulk-action bar: buttons **"סמן כאזל"** / **"סמן כקיים"**.
- Edit drawer: checkbox **"אזל מהמלאי"**; include in the form-submit patch.

## 10. Future change (remember this)

This is explicitly an **interim** design. The likely next iteration: pull the real
numeric `stock` from Priority during `refreshCatalogFromPriority()` and extend
`isOutOfStock()` to also return true when Priority stock ≤ 0 — with the **manual
override winning** (manual "out of stock" forces unavailable; manual "in stock"
could optionally force-available even if Priority says 0). All availability logic
is centralized in `isOutOfStock()` for exactly this reason. No customer-facing or
admin UI should need to change when that lands.

## 11. Testing / verification

- Server: unit-level — `setCartLine(mode:'add')` on an OOS part throws; `mode:'set'`
  (reduce/remove) succeeds; `submitOrder` rejects an OOS line; `getReorderSuggestions`
  and `reorderToCart` skip OOS; Priority refresh preserves the flag.
- End-to-end (dev-browser, like the QA suite in `qa/`): mark a seeded product OOS in
  admin → it shows grayed + "אזל מהמלאי" in catalog/product/favorites → every add
  path is blocked (keypad, swipe, stepper, scan, upsell, reorder, usual-basket) →
  an OOS item already in cart blocks checkout but can be removed → unmark → orderable
  again. Extend `qa/` with an `oos` script.
- `npm run typecheck` + `npm run build` green.
