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
