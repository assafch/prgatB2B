# Design — Inline (multi-row) editing in the admin products table

**Date:** 2026-06-28
**Status:** Approved (design)
**Author:** Assaf + Claude

## Goal
Let the admin edit several products' fields directly in the products table and
save all changes at once (batch), instead of opening each product's drawer.

## Scope
Inline-editable cells (per row): **box_size** (ארגז), **b2b_min_qty** (מינ׳), and
the status flags **b2b_visible** (מוסתר), **b2b_out_of_stock** (אזל מהמלאי),
**b2b_featured** (מומלץ). Name / family / price stay editable only in the full
drawer (they are Priority-sourced). `active` ("לא פעיל") is read-only (Priority).

Additive: the per-row drawer and the existing same-value bulk actions stay.

## UX
- **ארגז / מינ׳** cells → small number inputs (מינ׳ placeholder = box size).
- **סטטוס** cell → three small toggle chips per row (מוסתר / אזל מהמלאי / מומלץ),
  on/off on click; "לא פעיל" stays a read-only badge when set.
- Editing a cell marks the row **dirty** (highlight) and records the change in a
  `Map<partname, patch>`. A sticky bottom bar shows **"שמור N שינויים"** + **"בטל"**.
- Clicking an editable cell edits inline and does **not** open the drawer
  (stopPropagation); the rest of the row still opens the drawer.
- **בטל** discards pending edits (re-render from server). Leaving the page with
  pending edits just discards them (no nav-guard for v1).

## Save model — batch
- New server `batchUpdate(items)` in `server/products.ts`: one transaction; for
  each `{partname, ...patch}` reuse the existing per-row whitelist+normalize
  (`PATCHABLE_COLUMNS` / `patchProduct`). Returns the number of rows changed.
- New route `POST /api/admin/products/batch` (requireAdmin), body
  `{ items: Array<{ partname: string } & Partial<editableFields> }>`. Caps items
  at a sane limit (e.g. 1000). Returns `{ changes }`.
- Client posts the whole `edits` map in one request, then reloads the list and
  clears `edits`.

## Client (`src/pages/adminProducts.ts`)
- `renderRow()`: render box/min as inputs and status as toggle chips, each with
  `data-part` + `data-field`.
- Module `edits = new Map<string, Record<string, unknown>>()`; helpers to set a
  field, mark the row dirty, and refresh the sticky save bar.
- Sticky save bar (reuse `.thumb-bar`-like styling) with save/cancel.

## Testing
- Server: `batchUpdate` applies multiple rows in one tx; ignores unknown columns
  (whitelist); bad/empty partnames skipped; returns correct count.
- E2E (dev-browser, local): edit box+min+toggles on 2–3 rows → "שמור N שינויים"
  → reload shows persisted values; "בטל" discards. Out-of-stock toggled inline
  takes effect on the customer catalog (reuses the existing OOS path).
- typecheck + build green; no regression in the existing admin suite.
