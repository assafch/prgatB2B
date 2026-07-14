# Back-in-Stock Alerts (התראות חזרה למלאי) — Design

**Date:** 2026-07-14
**Status:** Approved by Assaf (this session)
**Origin:** Customer request — "notify me when goods come back to stock."

## Summary

Customers can opt in, per product, to be notified when an out-of-stock product returns. Notification is web push (for users who granted permission) plus an in-app "חזרו למלאי" home rail (for everyone who asked). Firing is hooked into the existing `b2b_out_of_stock` flag flip — the only restock mechanism today, and the same one a future Priority numeric-stock sync will write through.

Deploys inert behind a new `stock_alerts_enabled` admin flag (default OFF), per house convention.

## Decisions (with rationale)

1. **Audience: opt-in only.** Only users who tapped the button on that product get notified. No spam; the request doubles as a demand signal for the admin.
2. **Channel: push + in-app fallback.** Push reaches only users who enabled notifications (a minority initially); the home rail guarantees everyone who asked sees the restock on next visit. Rail shows for push subscribers too (reinforcement).
3. **Trigger: hook the flag flip (Approach A).** Both flip paths in `server/products.ts` (single-product patch setting `b2b_out_of_stock = 0`, and bulk `mark_in_stock` action) call `fireStockAlerts(partnames)` after the DB write. Rejected: periodic sweep (delay, more infra, no benefit while the flag is the single source of truth) and event/outbox worker (overkill for single-tenant, push failures already tolerated).
4. **One-shot lifecycle.** An alert is fulfilled when the product restocks. A later re-OOS does not resurrect it — the customer taps again if they still care.
5. **Push opt-in at the button.** Tapping the button is the highest-intent moment; it runs the existing `enablePush()` flow if push isn't enabled yet. Permission denial does NOT block the request — the rail covers those users.

## Customer UX

**Button** on every OOS surface that shows the shared אזל מהמלאי badge (product page, catalog/family cards):

- Label: **«קבל הודעה כשחוזר למלאי 🔔»**
- Tap → save request immediately → then, if push not yet enabled, run `enablePush()` (browser permission + subscription sync).
  - Granted: button flips to **«נעדכן אותך כשחוזר ✓»**.
  - Denied/unsupported: toast «נשמר — תראה עדכון כאן כשהמוצר יחזור»; request stands.
- Tap again → cancels the request (toggle back).

**On restock:**

- **Push** (subscribers): «המוצר חזר למלאי! 🎉 [שם המוצר] זמין עכשיו להזמנה» — deep-link to the product page.
- **Home rail «חזרו למלאי»** (all askers): same pattern as the «חדשים אצלנו» rail; shows the user's returned products until seen/dismissed (`seen_at`). Ordering the product also clears it.

## Data model

```sql
CREATE TABLE IF NOT EXISTS stock_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  custname TEXT,
  partname TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,   -- stamped when restock fires (fulfilled)
  seen_at TEXT,       -- stamped when the user sees/dismisses the rail item
  UNIQUE(user_id, partname)  -- one live request per user+product; re-request after fulfillment updates the row (reset timestamps)
);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_part ON stock_alerts(partname) WHERE notified_at IS NULL;
```

## API

All customer endpoints require an authenticated session; all respect `stock_alerts_enabled` (404/hidden when off).

- `POST /api/stock-alerts/:partname` — create/re-arm request (upsert; resets `notified_at`/`seen_at` if re-requesting after fulfillment). Rejects if product not OOS or hidden.
- `DELETE /api/stock-alerts/:partname` — cancel.
- `GET /api/stock-alerts` — the user's alerts (used to render button state + home rail: fulfilled-and-unseen items).
- `POST /api/stock-alerts/:partname/seen` — stamp `seen_at` (rail dismissal / product ordered).
- Admin: waiting counts come embedded in the existing products payload (`alert_count` per partname), not a new endpoint.

## Server flow

`fireStockAlerts(partnames: string[])` in a new `server/stockAlerts.ts`:

1. Skip entirely if `stock_alerts_enabled` is off.
2. Select unnotified alerts for those partnames, excluding products that are hidden or not active (`STATDES ≠ פעיל`) at flip time.
3. For each alert: `notifyUser(user_id, payload)` via existing `server/push.ts` (failures tolerated/silent, same as elsewhere), stamp `notified_at`.
4. Bulk flips fire once per product; the function is idempotent (already-notified rows are never re-selected).

Call sites (both in `server/products.ts`, after the UPDATE commits):
- single-product patch when the patch sets `b2b_out_of_stock` from 1 → 0
- bulk action `mark_in_stock` (only for rows that were actually OOS before)

## Admin visibility

Products board: OOS rows show a chip **«N ממתינים»** (count of unnotified alerts); product detail drawer lists the waiting customers (company + user). Zero new screens.

## Edge cases

- Multiple users per company: alerts are per user; each asker gets their own push/rail item.
- No push subscription at fire time: rail-only, no error.
- OOS → in → OOS misclick: first flip fulfills; re-OOS doesn't resurrect (accepted).
- Product hidden/deactivated while alerts pending: alerts skipped at fire time; they simply never fire (no cleanup job needed at this scale).
- Flag off: buttons hidden client-side, endpoints dark, firing skipped — fully inert.

## Testing

- Unit (server): create/cancel/re-arm lifecycle; one-shot semantics; both flip paths fire; bulk fires once per product; hidden/inactive skip; flag-off inertness; per-user fan-out for same custname.
- Manual at activation: test product OOS → request from user with push and user without → mark in stock → push received, rail shows for both, admin count drops, re-request works after fulfillment.

## Out of scope

- WhatsApp/email channels.
- Priority numeric-stock sync (separate feature; it will write the same flag and inherit this hook).
- Auto-expiry of stale requests (admin sees waiters; revisit if lists grow stale).
