# Back-in-Stock Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers opt in per out-of-stock product ("קבל הודעה כשחוזר למלאי") and get a web-push + a home-screen «חזרו למלאי» rail item when the admin marks it back in stock.

**Architecture:** New `stock_alerts` table + `server/stockAlerts.ts` module. Firing hooks into the existing `b2b_out_of_stock` flag flip in `server/products.ts` (the only restock mechanism; a future Priority stock sync writes the same flag and inherits the hook). Push rides the existing `server/push.ts` pipeline; the in-app fallback rides the existing home-rail pattern. Everything is inert behind a new `stock_alerts_enabled` admin flag (default OFF).

**Tech Stack:** Node/Express + better-sqlite3 (server), vanilla TS SPA (client), web-push, node:test via tsx for unit tests.

**Spec:** `docs/superpowers/specs/2026-07-14-back-in-stock-alerts-design.md`

## Global Constraints

- Feature flag key is exactly `stock_alerts_enabled`, default **false**; when off: endpoints return 404 `{error:'disabled'}` (except GET which returns `{enabled:false, alerts:[]}`), firing is a no-op, client UI hidden.
- All customer-facing copy in Hebrew, exact strings as given in each task (button: «קבל הודעה כשחוזר למלאי 🔔» / armed: «נעדכן אותך כשחוזר ✓»; push title: «המוצר חזר למלאי! 🎉», body: «[שם] זמין עכשיו להזמנה»; rail heading: «חזרו למלאי 🎉»).
- One-shot lifecycle: fulfilled alerts (`notified_at` set) never re-fire; re-requesting re-arms the same row (UNIQUE user_id+partname).
- Follow house patterns: routes like the favorites block in `server/index.ts`, Hebrew `Error` messages, `getSettingBool`, fire-and-forget push, no new npm dependencies.
- Verification commands: `npm run typecheck` must pass after every task; unit tests run with `DATA_DIR=$(mktemp -d) node --import tsx --test <file>`.

---

### Task 1: `stock_alerts` table + `server/stockAlerts.ts` module

**Files:**
- Modify: `server/db.ts` (append table to the schema template string, after the `saved_cards` CREATE TABLE block ~line 285)
- Create: `server/stockAlerts.ts`
- Test: `server/stockAlerts.test.ts`

**Interfaces:**
- Consumes: `db`, `getSettingBool`, `setSettingBool` from `./db.js`; `notifyUser(userId: number, payload: {title,body,url?})` from `./push.js` (fire-and-forget, silent on failure).
- Produces (used by Tasks 2–5):
  - `stockAlertsEnabled(): boolean`
  - `requestAlert(userId: number, custname: string | null, partname: string): void` (throws Hebrew Error on invalid)
  - `cancelAlert(userId: number, partname: string): boolean`
  - `listAlerts(userId: number): StockAlertRow[]` where `StockAlertRow = { partname: string; created_at: string; notified_at: string | null; seen_at: string | null }`
  - `markSeen(userId: number, partname: string): void`
  - `listWaiters(partname: string): Array<{ username: string; cust_desc: string | null; custname: string | null; created_at: string }>`
  - `fireStockAlerts(partnames: string[]): number`

- [ ] **Step 1: Add the table to the schema**

In `server/db.ts`, inside the big schema template string (same string that contains `CREATE TABLE IF NOT EXISTS saved_cards`), append after the saved_cards block:

```sql
CREATE TABLE IF NOT EXISTS stock_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  custname TEXT,
  partname TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,
  seen_at TEXT,
  UNIQUE(user_id, partname)
);
CREATE INDEX IF NOT EXISTS idx_stock_alerts_pending ON stock_alerts(partname) WHERE notified_at IS NULL;
```

- [ ] **Step 2: Write the failing tests**

Create `server/stockAlerts.test.ts`:

```ts
// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/stockAlerts.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, setSettingBool } from './db.js';
import {
  requestAlert, cancelAlert, listAlerts, markSeen, listWaiters, fireStockAlerts,
} from './stockAlerts.js';

function seed() {
  db.exec('DELETE FROM stock_alerts; DELETE FROM users; DELETE FROM catalog_cache;');
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, custname, cust_desc) VALUES (1,'u1','x','customer','10001','לקוח א'),(2,'u2','x','customer','10001','לקוח א')"
  ).run();
  db.prepare(
    "INSERT INTO catalog_cache (partname, partdes, b2b_visible, b2b_out_of_stock) VALUES ('P1','מוצר בדיקה',1,1),('P2','מוצר נסתר',0,1),('P3','מוצר במלאי',1,0)"
  ).run();
  setSettingBool('stock_alerts_enabled', true);
}

test('request → arm; listAlerts reflects it; cancel removes', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  assert.equal(listAlerts(1).length, 1);
  assert.equal(listAlerts(1)[0].notified_at, null);
  assert.ok(cancelAlert(1, 'P1'));
  assert.equal(listAlerts(1).length, 0);
});

test('request rejects in-stock and hidden products', () => {
  seed();
  assert.throws(() => requestAlert(1, '10001', 'P3')); // in stock
  assert.throws(() => requestAlert(1, '10001', 'P2')); // hidden
  assert.throws(() => requestAlert(1, '10001', 'NOPE')); // unknown
});

test('fire is one-shot, per-user, and skips hidden products', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  requestAlert(2, '10001', 'P1');
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  assert.equal(fireStockAlerts(['P1']), 2); // both users
  assert.equal(fireStockAlerts(['P1']), 0); // one-shot: nothing left
  // hidden product never fires even with a pending alert
  db.prepare("INSERT INTO stock_alerts (user_id, custname, partname) VALUES (1,'10001','P2')").run();
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P2'").run();
  assert.equal(fireStockAlerts(['P2']), 0);
});

test('flag off → fire is a no-op', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  setSettingBool('stock_alerts_enabled', false);
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  assert.equal(fireStockAlerts(['P1']), 0);
});

test('re-request after fulfillment re-arms the same row', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  fireStockAlerts(['P1']);
  assert.ok(listAlerts(1)[0].notified_at);
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 1 WHERE partname = 'P1'").run();
  requestAlert(1, '10001', 'P1'); // re-arm
  const row = listAlerts(1)[0];
  assert.equal(row.notified_at, null);
  assert.equal(listAlerts(1).length, 1); // same row, not a duplicate
});

test('markSeen stamps only fulfilled alerts; listWaiters counts pending only', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  markSeen(1, 'P1'); // not fulfilled yet → no-op
  assert.equal(listAlerts(1)[0].seen_at, null);
  assert.equal(listWaiters('P1').length, 1);
  db.prepare("UPDATE catalog_cache SET b2b_out_of_stock = 0 WHERE partname = 'P1'").run();
  fireStockAlerts(['P1']);
  assert.equal(listWaiters('P1').length, 0); // fulfilled → no longer waiting
  markSeen(1, 'P1');
  assert.ok(listAlerts(1)[0].seen_at);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `DATA_DIR=$(mktemp -d) node --import tsx --test server/stockAlerts.test.ts`
Expected: FAIL — `Cannot find module './stockAlerts.js'`

- [ ] **Step 4: Implement the module**

Create `server/stockAlerts.ts`:

```ts
// Back-in-stock alerts (התראות חזרה למלאי). Customers opt in per product while
// it's flagged אזל מהמלאי; when the flag flips back (products.ts calls
// fireStockAlerts) every asker gets a web-push (if subscribed) and a home-rail
// item until seen. One-shot: a fulfilled alert never re-fires — the customer
// re-arms it if the product runs out again. Inert while stock_alerts_enabled
// is off.

import { db, getSettingBool } from './db.js';
import { notifyUser } from './push.js';

export interface StockAlertRow {
  partname: string;
  created_at: string;
  notified_at: string | null;
  seen_at: string | null;
}

export function stockAlertsEnabled(): boolean {
  return getSettingBool('stock_alerts_enabled', false);
}

/** Arm (or re-arm after fulfillment) an alert. Product must exist, be visible and OOS. */
export function requestAlert(userId: number, custname: string | null, partname: string): void {
  const p = db
    .prepare('SELECT b2b_out_of_stock, b2b_visible FROM catalog_cache WHERE partname = ?')
    .get(partname) as { b2b_out_of_stock: number; b2b_visible: number } | undefined;
  if (!p || !p.b2b_visible) throw new Error('המוצר לא נמצא');
  if (!p.b2b_out_of_stock) throw new Error('המוצר כבר במלאי');
  db.prepare(
    `INSERT INTO stock_alerts (user_id, custname, partname) VALUES (?, ?, ?)
     ON CONFLICT(user_id, partname) DO UPDATE SET
       created_at = datetime('now'), notified_at = NULL, seen_at = NULL, custname = excluded.custname`
  ).run(userId, custname, partname);
}

export function cancelAlert(userId: number, partname: string): boolean {
  return db.prepare('DELETE FROM stock_alerts WHERE user_id = ? AND partname = ?').run(userId, partname).changes > 0;
}

export function listAlerts(userId: number): StockAlertRow[] {
  return db
    .prepare('SELECT partname, created_at, notified_at, seen_at FROM stock_alerts WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as StockAlertRow[];
}

/** Stamp a fulfilled alert as seen (rail dismissal / product added to cart). */
export function markSeen(userId: number, partname: string): void {
  db.prepare(
    "UPDATE stock_alerts SET seen_at = datetime('now') WHERE user_id = ? AND partname = ? AND notified_at IS NOT NULL"
  ).run(userId, partname);
}

/** Customers still waiting (unnotified) for a product — for the admin drawer. */
export function listWaiters(partname: string): Array<{ username: string; cust_desc: string | null; custname: string | null; created_at: string }> {
  return db
    .prepare(
      `SELECT u.username, u.cust_desc, sa.custname, sa.created_at
         FROM stock_alerts sa JOIN users u ON u.id = sa.user_id
        WHERE sa.partname = ? AND sa.notified_at IS NULL
        ORDER BY sa.created_at`
    )
    .all(partname) as Array<{ username: string; cust_desc: string | null; custname: string | null; created_at: string }>;
}

/** Fire alerts for products that just returned to stock. Idempotent (only
 *  unnotified rows, only currently visible+in-stock products). Push failures
 *  are tolerated — the row is stamped regardless; the home rail still shows it. */
export function fireStockAlerts(partnames: string[]): number {
  if (!stockAlertsEnabled() || partnames.length === 0) return 0;
  const ph = partnames.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT sa.id, sa.user_id, sa.partname,
              COALESCE(NULLIF(c.b2b_partdes_override, ''), c.partdes, c.partname) AS name
         FROM stock_alerts sa JOIN catalog_cache c ON c.partname = sa.partname
        WHERE sa.partname IN (${ph}) AND sa.notified_at IS NULL
          AND c.b2b_visible = 1 AND c.b2b_out_of_stock = 0`
    )
    .all(...partnames) as Array<{ id: number; user_id: number; partname: string; name: string }>;
  const stamp = db.prepare("UPDATE stock_alerts SET notified_at = datetime('now') WHERE id = ?");
  for (const r of rows) {
    notifyUser(r.user_id, {
      title: 'המוצר חזר למלאי! 🎉',
      body: `${r.name} זמין עכשיו להזמנה`,
      url: `#product/${encodeURIComponent(r.partname)}`,
    });
    stamp.run(r.id);
  }
  return rows.length;
}
```

(The `url` shape `#product/<part>` matches what `public/sw.js` `notificationclick` already expects — it appends the hash to the app origin.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `DATA_DIR=$(mktemp -d) node --import tsx --test server/stockAlerts.test.ts`
Expected: PASS (6 tests). Also run `npm run typecheck` — clean.

- [ ] **Step 6: Commit**

```bash
git add server/db.ts server/stockAlerts.ts server/stockAlerts.test.ts
git commit -m "feat(stock-alerts): stock_alerts table + server module (inert, flag off)"
```

---

### Task 2: Fire on the flag flip in `server/products.ts`

**Files:**
- Modify: `server/products.ts` (`patchProduct` ~lines 130–167, `bulkUpdate` ~lines 251–300)
- Test: `server/products.stockAlerts.test.ts`

**Interfaces:**
- Consumes: `fireStockAlerts(partnames: string[]): number` from `./stockAlerts.js` (Task 1).
- Produces: restock firing on every admin path — `patchProduct` covers single edits, the detail drawer, AND `batchUpdate` (which delegates to `patchProduct` per row); `bulkUpdate` covers the bulk `mark_in_stock` action.

- [ ] **Step 1: Write the failing tests**

Create `server/products.stockAlerts.test.ts`:

```ts
// Run: DATA_DIR=$(mktemp -d) node --import tsx --test server/products.stockAlerts.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { db, setSettingBool } from './db.js';
import { requestAlert, listAlerts } from './stockAlerts.js';
import { patchProduct, bulkUpdate } from './products.js';

function seed() {
  db.exec('DELETE FROM stock_alerts; DELETE FROM users; DELETE FROM catalog_cache;');
  db.prepare("INSERT INTO users (id, username, password_hash, role, custname) VALUES (1,'u1','x','customer','10001')").run();
  db.prepare(
    "INSERT INTO catalog_cache (partname, partdes, b2b_visible, b2b_out_of_stock) VALUES ('P1','א',1,1),('P2','ב',1,1)"
  ).run();
  setSettingBool('stock_alerts_enabled', true);
}

test('patchProduct 1→0 fires; same-value save does not', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  patchProduct('P1', { b2b_out_of_stock: true }); // same value — must NOT fire
  assert.equal(listAlerts(1)[0].notified_at, null);
  patchProduct('P1', { b2b_out_of_stock: false }); // restock — fires
  assert.ok(listAlerts(1)[0].notified_at);
});

test('bulkUpdate mark_in_stock fires only for rows that were OOS', () => {
  seed();
  requestAlert(1, '10001', 'P1');
  requestAlert(1, '10001', 'P2');
  patchProduct('P2', { b2b_out_of_stock: false }); // P2 already restocked+fired
  const before = listAlerts(1).find((a) => a.partname === 'P2')!.notified_at;
  bulkUpdate({ partnames: ['P1', 'P2'], action: 'mark_in_stock' });
  assert.ok(listAlerts(1).find((a) => a.partname === 'P1')!.notified_at); // P1 fired now
  assert.equal(listAlerts(1).find((a) => a.partname === 'P2')!.notified_at, before); // P2 untouched
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `DATA_DIR=$(mktemp -d) node --import tsx --test server/products.stockAlerts.test.ts`
Expected: FAIL — `notified_at` stays null (no hook yet).

- [ ] **Step 3: Add the hooks**

In `server/products.ts`, add the import at the top:

```ts
import { fireStockAlerts } from './stockAlerts.js';
```

In `patchProduct`, directly after the existing `b2b_is_new` companion-stamp block (~line 162), add:

```ts
  // b2b_out_of_stock 1→0 is a restock: fire back-in-stock alerts after the write.
  let restocked = false;
  if ('b2b_out_of_stock' in patch && !patch.b2b_out_of_stock) {
    const cur = db.prepare('SELECT b2b_out_of_stock FROM catalog_cache WHERE partname = ?').get(partname) as
      | { b2b_out_of_stock: number } | undefined;
    restocked = !!cur?.b2b_out_of_stock;
  }
```

And after the `db.prepare(\`UPDATE catalog_cache SET ...\`).run(...vals);` line, before `return getProductAdmin(partname);`:

```ts
  if (restocked) fireStockAlerts([partname]);
```

In `bulkUpdate`, before the `switch` add:

```ts
  // Snapshot which products are actually restocking so alerts fire once, post-update.
  const restocking: string[] =
    payload.action === 'mark_in_stock'
      ? (db
          .prepare(`SELECT partname FROM catalog_cache WHERE partname IN (${placeholders}) AND b2b_out_of_stock = 1`)
          .all(...payload.partnames) as Array<{ partname: string }>).map((r) => r.partname)
      : [];
```

And after the final `.run(...setVals, ...payload.partnames);` statement, before `return result.changes;`:

```ts
  if (restocking.length > 0) fireStockAlerts(restocking);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `DATA_DIR=$(mktemp -d) node --import tsx --test server/products.stockAlerts.test.ts`
Expected: PASS (2 tests). Then re-run Task 1's tests + `npm run typecheck` — all clean.

- [ ] **Step 5: Commit**

```bash
git add server/products.ts server/products.stockAlerts.test.ts
git commit -m "feat(stock-alerts): fire alerts when b2b_out_of_stock flips back (patch + bulk paths)"
```

---

### Task 3: API routes, feature flag registration, admin counts

**Files:**
- Modify: `server/index.ts` (routes after the favorites block ~line 770; `SETTABLE`/`BOOL_SETTINGS` ~lines 1548–1576)
- Modify: `server/products.ts` (`listProductsAdmin` SELECT + `AdminProductRow` ~lines 20–105)

**Interfaces:**
- Consumes: Task 1 module functions; existing `requireCustomer`, `requireAdmin`, `cartLimiter`, `AuthedRequest`.
- Produces (client contracts for Tasks 4–6):
  - `GET /api/stock-alerts` → `{ enabled: boolean, alerts: StockAlertRow[] }` (alerts `[]` when disabled)
  - `POST /api/stock-alerts/:partname` → `{ ok: true }` | 400 `{ error }` | 404 when flag off
  - `DELETE /api/stock-alerts/:partname` → `{ ok: true }`
  - `POST /api/stock-alerts/:partname/seen` → `{ ok: true }`
  - `GET /api/admin/stock-alerts/:partname` → `{ waiters: [...] }` (admin drawer)
  - `AdminProductRow.alert_count: number` in the existing admin products payload

- [ ] **Step 1: Register the flag**

In `server/index.ts` add `'stock_alerts_enabled',` to the `SETTABLE` set (after `'fast_track_discount_pct',`) and `'stock_alerts_enabled'` to the `BOOL_SETTINGS` set.

- [ ] **Step 2: Add the routes**

In `server/index.ts`, import at top:

```ts
import { stockAlertsEnabled, requestAlert, cancelAlert, listAlerts, markSeen, listWaiters } from './stockAlerts.js';
```

After the `GET /api/favorites` route block (~line 770), add:

```ts
// ---------- Back-in-stock alerts (התראות חזרה למלאי) ----------
app.get('/api/stock-alerts', requireCustomer, (req: AuthedRequest, res) => {
  const enabled = stockAlertsEnabled();
  res.json({ enabled, alerts: enabled ? listAlerts(req.user!.id) : [] });
});
app.post('/api/stock-alerts/:partname', requireCustomer, cartLimiter, (req: AuthedRequest, res) => {
  if (!stockAlertsEnabled()) return res.status(404).json({ error: 'disabled' });
  try {
    requestAlert(req.user!.id, req.user!.custname, String(req.params.partname));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'שגיאה' });
  }
});
app.delete('/api/stock-alerts/:partname', requireCustomer, (req: AuthedRequest, res) => {
  if (!stockAlertsEnabled()) return res.status(404).json({ error: 'disabled' });
  cancelAlert(req.user!.id, String(req.params.partname));
  res.json({ ok: true });
});
app.post('/api/stock-alerts/:partname/seen', requireCustomer, (req: AuthedRequest, res) => {
  if (!stockAlertsEnabled()) return res.status(404).json({ error: 'disabled' });
  markSeen(req.user!.id, String(req.params.partname));
  res.json({ ok: true });
});
app.get('/api/admin/stock-alerts/:partname', requireAdmin, (req, res) => {
  res.json({ waiters: listWaiters(String(req.params.partname)) });
});
```

- [ ] **Step 3: Admin waiting counts in the products payload**

In `server/products.ts`:
- Add to `AdminProductRow` interface: `alert_count: number;`
- In `listProductsAdmin`, add to the SELECT column list (the query that produces the page of rows, ~line 100):

```sql
(SELECT COUNT(*) FROM stock_alerts sa WHERE sa.partname = catalog_cache.partname AND sa.notified_at IS NULL) AS alert_count
```

- In `getProductAdmin` (~line 110), add the same subquery column so the drawer payload has it too.

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — clean.
Run the dev server (`npm run dev:server`) and smoke the gate:

```bash
curl -s localhost:3000/api/stock-alerts   # → 401 (no session) — route exists
```

Expected: 401 JSON (auth guard first), not 404-HTML.

- [ ] **Step 5: Commit**

```bash
git add server/index.ts server/products.ts
git commit -m "feat(stock-alerts): API routes, stock_alerts_enabled flag, admin waiting counts"
```

---

### Task 4: Home payload — «חזרו למלאי» data + rail rendering

**Files:**
- Modify: `server/home.ts` (`HomeData` interface ~line 33, `getHomeData` ~line 112)
- Modify: `src/pages/home.ts` (rail markup after the new-products rail ~line 186, wiring near `#new-rail` handlers ~line 282)

**Interfaces:**
- Consumes: `stockAlertsEnabled` (Task 1); `getProduct(partname, custname): CatalogItem | null` from `./catalog.js`; `POST /api/stock-alerts/:partname/seen` (Task 3).
- Produces: `HomeData.restocked: CatalogItem[]` (fulfilled-and-unseen, max 12, newest first).

- [ ] **Step 1: Server — add `restocked` to the home payload**

In `server/home.ts` add to the `HomeData` interface (after `newProducts`):

```ts
  /** back-in-stock: this user's fulfilled-and-unseen alerts, for the «חזרו למלאי» rail */
  restocked: CatalogItem[];
```

Import at top: `import { stockAlertsEnabled } from './stockAlerts.js';` (plus `getProduct` from `./catalog.js` if not already imported). Add a helper above `getHomeData`:

```ts
function listRestocked(userId: number, custname: string | null): CatalogItem[] {
  if (!stockAlertsEnabled()) return [];
  const rows = db
    .prepare(
      "SELECT partname FROM stock_alerts WHERE user_id = ? AND notified_at IS NOT NULL AND seen_at IS NULL ORDER BY notified_at DESC LIMIT 12"
    )
    .all(userId) as Array<{ partname: string }>;
  const out: CatalogItem[] = [];
  for (const r of rows) {
    const it = getProduct(r.partname, custname);
    if (it) out.push(it);
  }
  return out;
}
```

And in the object `getHomeData` returns, add: `restocked: listRestocked(userId, custname),`

- [ ] **Step 2: Client — render the rail**

In `src/pages/home.ts`, directly after the new-products rail block (~line 186), add (mirrors the `#new-rail` pattern):

```ts
  // Back-in-stock rail — products the user asked about that returned.
  let restockRail = '';
  if (d.restocked && d.restocked.length > 0) {
    restockRail = `
      <h2 class="home-sec">חזרו למלאי 🎉</h2>
      <div class="rail" id="restock-rail">
        ${d.restocked
          .map((it) => {
            const enc = encodeURIComponent(it.partname);
            return `
          <div class="rail-item" data-part="${escapeAttr(it.partname)}">
            <button class="rail-dismiss" data-dismiss="${escapeAttr(it.partname)}" aria-label="הסר">✕</button>
            <a class="thumb" href="#product/${enc}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt="" loading="lazy"/>` : '🎉'}</a>
            <a class="nm" href="#product/${enc}" style="display:block;color:inherit;text-decoration:none">${escapeHtml(it.partdes || it.partname)}</a>
            <div class="pr">${it.price != null ? formatMoney(it.price) : ''}</div>
            <button class="add-mini" data-part="${escapeAttr(it.partname)}" data-box="${it.box_size}">הוסף · ארגז ${it.box_size}</button>
          </div>`;
          })
          .join('')}
      </div>`;
  }
```

Insert `${restockRail}` into the page template right after `${newRail}` (find where `newRail` is interpolated).

- [ ] **Step 3: Client — wire dismiss + add-to-cart-marks-seen**

Next to the existing `#new-rail .add-mini` wiring (~line 282), add:

```ts
  shell.querySelectorAll<HTMLButtonElement>('#restock-rail [data-dismiss]').forEach((b) => {
    b.addEventListener('click', async () => {
      const part = b.dataset.dismiss!;
      b.closest('.rail-item')?.remove();
      try { await api.post(`/api/stock-alerts/${encodeURIComponent(part)}/seen`); } catch { /* best-effort */ }
    });
  });
  shell.querySelectorAll<HTMLButtonElement>('#restock-rail .add-mini').forEach((b) => {
    b.addEventListener('click', () => {
      // Reuse the same add handler behavior as #new-rail (copy its listener body),
      // then mark seen best-effort:
      void api.post(`/api/stock-alerts/${encodeURIComponent(b.dataset.part!)}/seen`).catch(() => {});
    });
  });
```

(For the add-mini click: attach the exact same body the `#new-rail .add-mini` listener uses — same cart PUT + toast — plus the seen call above. Add a minimal `.rail-dismiss` style in the stylesheet next to the existing `.rail-item` rules: absolutely positioned top-left, small round button.)

- [ ] **Step 4: Verify**

`npm run typecheck` clean. In the dev app (`npm run dev`): enable the flag (`INSERT/UPDATE settings` or the Task 6 toggle once built), arm an alert as a test user, flip the product back in stock in the admin board, reload home → rail shows the product; ✕ removes it and it stays gone on reload.

- [ ] **Step 5: Commit**

```bash
git add server/home.ts src/pages/home.ts
git commit -m "feat(stock-alerts): «חזרו למלאי» home rail (server payload + client render/dismiss)"
```

---

### Task 5: Product-page button «קבל הודעה כשחוזר למלאי» + catalog OOS tap

**Files:**
- Modify: `src/pages/product.ts` (OOS badge block ~line 43 + wiring section)
- Modify: `src/pages/catalog.ts` (OOS card tap ~line 225)

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/stock-alerts...` (Task 3); `pushSupported(): boolean`, `pushSubscribed(): Promise<boolean>`, `enablePush(): Promise<void>` from `../push.js`; `toast` from `../ui.js`.
- Produces: the customer opt-in UX.

- [ ] **Step 1: Fetch alert state on product render**

In `src/pages/product.ts`, where the product is loaded, also fetch (guests/errors → feature hidden):

```ts
  let alertsEnabled = false;
  let armed = false;
  if (oos) {
    try {
      const r = await api.get<{ enabled: boolean; alerts: Array<{ partname: string; notified_at: string | null }> }>('/api/stock-alerts');
      alertsEnabled = r.enabled;
      armed = r.alerts.some((a) => a.partname === p.partname && !a.notified_at);
    } catch { /* not a customer / flag off → no button */ }
  }
```

- [ ] **Step 2: Render the button**

Extend the OOS badge line (~line 43) to include the button when enabled:

```ts
            ${oos ? '<div style="margin-top:0.4rem">' + oosBadge() + (alertsEnabled
              ? `<button id="stock-alert-btn" class="ghost" style="display:block;margin-top:0.5rem">${armed ? 'נעדכן אותך כשחוזר ✓' : 'קבל הודעה כשחוזר למלאי 🔔'}</button>`
              : '') + '</div>' : ''}
```

- [ ] **Step 3: Wire the toggle + push opt-in**

In the page's wiring section (where other buttons get listeners), add:

```ts
  const alertBtn = shell.querySelector<HTMLButtonElement>('#stock-alert-btn');
  if (alertBtn) {
    alertBtn.addEventListener('click', async () => {
      alertBtn.disabled = true;
      try {
        if (armed) {
          await api.del(`/api/stock-alerts/${encodeURIComponent(p.partname)}`);
          armed = false;
          alertBtn.textContent = 'קבל הודעה כשחוזר למלאי 🔔';
          toast('ההתראה בוטלה', 'info');
        } else {
          await api.post(`/api/stock-alerts/${encodeURIComponent(p.partname)}`);
          armed = true;
          alertBtn.textContent = 'נעדכן אותך כשחוזר ✓';
          // Highest-intent moment: get push permission so the alert actually reaches them.
          try {
            if (pushSupported() && !(await pushSubscribed())) await enablePush();
            toast('נעדכן אותך כשהמוצר יחזור למלאי ✓', 'success');
          } catch {
            toast('נשמר — תראה עדכון במסך הבית כשהמוצר יחזור', 'info');
          }
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'שגיאה', 'error');
      } finally {
        alertBtn.disabled = false;
      }
    });
  }
```

Add the imports: `import { pushSupported, pushSubscribed, enablePush } from '../push.js';`

- [ ] **Step 4: Catalog OOS tap opens the product page**

In `src/pages/catalog.ts` line ~225, replace the dead-end toast:

```ts
    if (card.dataset.oos === '1') { location.hash = '#product/' + encodeURIComponent(card.dataset.part!); return; } // OOS → product page (has the notify button)
```

Apply the same replacement to the swipe no-op at ~line 403 **only if** it has a part reference in scope; otherwise leave the swipe as-is (swipe-to-add on OOS staying inert is fine).

- [ ] **Step 5: Verify**

`npm run typecheck` clean. In the dev app with flag on: OOS product page shows the button; tap → browser permission prompt (first time) → armed state; tap again → cancels; tapping an OOS catalog card navigates to the product page. With flag off: no button, catalog tap shows the product page (still fine — page simply has no button).

- [ ] **Step 6: Commit**

```bash
git add src/pages/product.ts src/pages/catalog.ts
git commit -m "feat(stock-alerts): notify-me button on OOS products + catalog OOS tap opens product"
```

---

### Task 6: Admin — waiting-count chip, drawer waiters list, settings toggle

**Files:**
- Modify: `src/pages/adminProducts.ts` (row status area ~line 356, detail drawer ~line 536)
- Modify: `src/pages/adminSettings.ts` (toggle next to `s-oos-bottom` ~line 114)

**Interfaces:**
- Consumes: `AdminProductRow.alert_count` and `GET /api/admin/stock-alerts/:partname` (Task 3); the existing `statusToggle`/toggle-pill patterns.
- Produces: admin visibility + the activation switch.

- [ ] **Step 1: Waiting-count chip in the products board row**

In `src/pages/adminProducts.ts`, where the row status toggles render (~line 356, after the `toggles` concatenation), append to the row markup:

```ts
  const waitChip = p.alert_count > 0
    ? ` <span style="background:#eef;color:#33c;padding:1px 6px;border-radius:4px;font-size:0.75rem">🔔 ${p.alert_count} ממתינים</span>`
    : '';
```

and interpolate `${waitChip}` right after the toggles in the row template.

- [ ] **Step 2: Waiters list in the product drawer**

In the drawer template (~line 536, near the אזל checkbox), when `p.b2b_out_of_stock && p.alert_count > 0` add a container `<div id="alert-waiters" class="muted" style="font-size:0.8rem">טוען ממתינים…</div>` and after the drawer opens fetch and fill:

```ts
  const waitersEl = drawer.querySelector<HTMLElement>('#alert-waiters');
  if (waitersEl) {
    api.get<{ waiters: Array<{ username: string; cust_desc: string | null; custname: string | null }> }>(
      `/api/admin/stock-alerts/${encodeURIComponent(p.partname)}`
    ).then((r) => {
      waitersEl.textContent = r.waiters.length
        ? 'ממתינים: ' + r.waiters.map((w) => w.cust_desc || w.custname || w.username).join(', ')
        : '';
    }).catch(() => { waitersEl.textContent = ''; });
  }
```

- [ ] **Step 3: Settings toggle**

In `src/pages/adminSettings.ts`, duplicate the `s-oos-bottom` row pattern (~line 114) with:

```html
<button type="button" id="s-stock-alerts" class="adm-toggle${on('stock_alerts_enabled') ? ' on' : ''}" aria-label="התראות חזרה למלאי"></button>
```

Row label: **«התראות חזרה למלאי»**, description: «לקוחות יכולים לבקש עדכון כשמוצר שאזל חוזר למלאי (פוש + מסך הבית)». Wire its click exactly like the `s-oos-bottom` toggle (PATCH its own key `stock_alerts_enabled`).

- [ ] **Step 4: Verify**

`npm run typecheck` clean. Dev app: settings shows the new toggle and flips the flag; products board shows «🔔 N ממתינים» on a product with a pending alert; drawer lists the waiting customer names.

- [ ] **Step 5: Commit**

```bash
git add src/pages/adminProducts.ts src/pages/adminSettings.ts
git commit -m "feat(stock-alerts): admin waiting-count chip, drawer waiters, settings toggle"
```

---

### Task 7: Full verification + deploy (flag stays OFF)

**Files:** none new — verification and release.

- [ ] **Step 1: Run everything**

```bash
DATA_DIR=$(mktemp -d) node --import tsx --test server/stockAlerts.test.ts server/products.stockAlerts.test.ts
npm run typecheck
npm run build
```

Expected: all tests pass, typecheck clean, build succeeds.

- [ ] **Step 2: End-to-end dev-app walkthrough (flag on locally)**

With `npm run dev`, as admin: enable «התראות חזרה למלאי» in settings, mark a test product אזל. As a test customer: product page → tap the button → approve push → armed. As admin: mark the product back in stock. Confirm: push notification arrives (or rail-only if permission denied), home shows «חזרו למלאי» rail, admin chip count dropped to 0, tapping the push opens the product page.

- [ ] **Step 3: Deploy inert**

```bash
git push origin main   # Railway auto-deploys (~15 min window; volume re-attach)
```

Post-deploy sanity on prod: `curl -s https://b2b.orgat.co.il/api/stock-alerts` → 401 JSON; feature invisible to customers (flag OFF).

- [ ] **Step 4: Activation checklist (Assaf, when ready)**

1. Admin → הגדרות → «התראות חזרה למלאי» → ON.
2. One real product: mark אזל, request alert from a real customer login, mark back in stock, confirm push + rail.
3. Watch the products board «ממתינים» counts for the first week — it doubles as a demand signal.
