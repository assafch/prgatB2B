// Per-customer discount percent: Priority applies a flat line PERCENT on top of the
// base list price (verified live: PRICE == BASEPLPRICE, PERCENT uniform per customer).
// There is NO API-readable master on this tenant (CUSTOMERS has no discount field,
// PRICELIST form is API-disabled) — so we derive the percent from the customer's own
// recent order lines and let the admin override it.

import { db } from './db.js';
import { getPriorityConfig, getCustomerRecentDiscountLines } from './priority.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sanity range: a typo'd 95% must not put the whole catalog on sale. */
export function isValidPercent(pct: unknown): pct is number {
  return typeof pct === 'number' && isFinite(pct) && pct > 0 && pct <= 60;
}

/** Base price → the customer's price. Null/invalid pct returns the base unchanged. */
export function applyDiscount(basePrice: number, pct: number | null): number {
  if (!isValidPercent(pct)) return basePrice;
  return round2(basePrice * (1 - pct / 100));
}

/** The most frequent valid percent among recent order lines (newest lines first —
 *  first-seen wins ties, so a recent discount change beats the old value). */
export function deriveDominantPercent(lines: Array<{ percent: number }>): number | null {
  const counts = new Map<number, number>();
  for (const ln of lines) {
    if (isValidPercent(ln.percent)) counts.set(ln.percent, (counts.get(ln.percent) || 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [pct, count] of counts) {
    if (count > bestCount) { best = pct; bestCount = count; } // Map preserves insertion order → ties keep first-seen
  }
  return best;
}

/** The percent to apply for this customer right now (null = no discount known). */
export function resolveDiscountPercent(custname: string | null): number | null {
  if (!custname) return null;
  const row = db.prepare('SELECT percent FROM customer_discounts WHERE custname = ?').get(custname) as
    | { percent: number } | undefined;
  return row && isValidPercent(row.percent) ? row.percent : null;
}

/** Fetch recent order lines and store the dominant percent. A 'manual' admin override
 *  is never overwritten by sync (delete the row or save a new manual value to change it).
 *  Derived-null does NOT delete an existing 'orders' row — a Priority hiccup returning
 *  zero orders must not strip everyone's discount. */
export async function refreshCustomerDiscounts(custname: string): Promise<number | null> {
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');
  const manual = db.prepare("SELECT 1 FROM customer_discounts WHERE custname = ? AND source = 'manual'").get(custname);
  if (manual) return resolveDiscountPercent(custname);
  const lines = await getCustomerRecentDiscountLines(config, custname);
  const pct = deriveDominantPercent(lines);
  if (pct != null) {
    db.prepare(
      `INSERT INTO customer_discounts (custname, percent, source, updated_at) VALUES (?, ?, 'orders', datetime('now'))
       ON CONFLICT(custname) DO UPDATE SET percent = excluded.percent, source = 'orders', updated_at = datetime('now')`
    ).run(custname, pct);
  }
  return pct ?? resolveDiscountPercent(custname);
}

/** Daily sweep: refresh every company that has a portal login. Per-customer failures
 *  are logged and skipped — one bad customer must not stop the rest. */
export async function sweepCustomerDiscounts(): Promise<void> {
  if (!getPriorityConfig()) return;
  const rows = db.prepare(
    "SELECT DISTINCT custname FROM users WHERE role = 'customer' AND custname IS NOT NULL"
  ).all() as { custname: string }[];
  for (const r of rows) {
    try {
      await refreshCustomerDiscounts(r.custname);
    } catch (err) {
      console.warn(`[discounts] sweep: refresh failed for ${r.custname}:`, err instanceof Error ? err.message : err);
    }
  }
}
