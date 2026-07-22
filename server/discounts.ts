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

export interface DiscountProfile {
  dominant: number | null;          // most frequent VALID (>0, ≤60) percent — null = none seen
  uniform: boolean;                 // every line carries the exact same percent value
  perPart: Map<string, number>;     // first-seen (newest line wins) percent per part, 0 included
}

/** Profile the customer's recent order lines. Lines arrive newest-order-first, so the
 *  first occurrence of a part is its current percent. `uniform` is the assumption the
 *  original feature shipped with ("PERCENT uniform per customer") — when it does NOT
 *  hold (real case: 10822), blanket-applying the dominant percent under-charges the
 *  customer relative to the Priority invoice, so callers must fall back to perPart. */
export function deriveDiscountProfile(lines: Array<{ partname: string; percent: number }>): DiscountProfile {
  const counts = new Map<number, number>();
  const perPart = new Map<string, number>();
  let uniform = true;
  let firstPct: number | null = null;
  for (const ln of lines) {
    if (!isFinite(ln.percent)) continue;
    if (firstPct === null) firstPct = ln.percent;
    else if (ln.percent !== firstPct) uniform = false;
    if (!perPart.has(ln.partname)) perPart.set(ln.partname, ln.percent);
    if (isValidPercent(ln.percent)) counts.set(ln.percent, (counts.get(ln.percent) || 0) + 1);
  }
  let dominant: number | null = null;
  let bestCount = 0;
  for (const [pct, count] of counts) {
    if (count > bestCount) { dominant = pct; bestCount = count; } // Map preserves insertion order → ties keep first-seen
  }
  return { dominant, uniform, perPart };
}

/** The percent to apply for this customer right now (null = no discount known). */
export function resolveDiscountPercent(custname: string | null): number | null {
  if (!custname) return null;
  const row = db.prepare('SELECT percent FROM customer_discounts WHERE custname = ?').get(custname) as
    | { percent: number } | undefined;
  return row && isValidPercent(row.percent) ? row.percent : null;
}

/** Apply Priority-derived order lines to the customer's cached discount. Pure DB op.
 *  Semantics (unchanged from the blanket-only version, extended with part rows):
 *  - dominant found → upsert customer_discounts (percent + uniform flag); part rows are
 *    REPLACED — written only for non-uniform customers (uniform needs no map: blanket
 *    covers every part, including ones never ordered).
 *  - lines non-empty + NO valid dominant → office revoked the discount → delete both.
 *  - lines EMPTY (API hiccup / no orders) → touch nothing; can't tell "none" from "unknown".
 *  - a 'manual' admin override is never overwritten AND suppresses part rows entirely —
 *    manual means "the admin says this % for everything". */
export function applyDerivedDiscount(custname: string, lines: Array<{ partname: string; percent: number }>): number | null {
  const profile = deriveDiscountProfile(lines);
  const replaceParts = db.transaction((parts: Map<string, number>) => {
    db.prepare('DELETE FROM customer_part_discounts WHERE custname = ?').run(custname);
    const ins = db.prepare(
      "INSERT INTO customer_part_discounts (custname, partname, percent, updated_at) VALUES (?, ?, ?, datetime('now'))"
    );
    for (const [partname, pct] of parts) ins.run(custname, partname, pct);
  });
  if (profile.dominant != null) {
    db.prepare(
      `INSERT INTO customer_discounts (custname, percent, source, uniform, updated_at) VALUES (?, ?, 'orders', ?, datetime('now'))
       ON CONFLICT(custname) DO UPDATE SET percent = excluded.percent, source = 'orders', uniform = excluded.uniform, updated_at = datetime('now')
       WHERE customer_discounts.source != 'manual'`
    ).run(custname, profile.dominant, profile.uniform ? 1 : 0);
    // Re-read: if a manual override exists (pre-existing or landed mid-flight), the upsert
    // was a no-op and part rows must not shadow it.
    const src = db.prepare('SELECT source FROM customer_discounts WHERE custname = ?').get(custname) as { source: string } | undefined;
    replaceParts(src?.source === 'manual' || profile.uniform ? new Map() : profile.perPart);
  } else if (lines.length > 0) {
    db.prepare("DELETE FROM customer_discounts WHERE custname = ? AND source = 'orders'").run(custname);
    replaceParts(new Map());
  }
  return profile.dominant;
}

/** Fetch recent order lines and store the dominant percent. A 'manual' admin override
 *  is never overwritten by sync (delete the row or save a new manual value to change it).
 *  See applyDerivedDiscount for the revocation vs. hiccup semantics of the fetched lines. */
export async function refreshCustomerDiscounts(custname: string): Promise<number | null> {
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');
  const manual = db.prepare("SELECT 1 FROM customer_discounts WHERE custname = ? AND source = 'manual'").get(custname);
  if (manual) return resolveDiscountPercent(custname);
  const lines = await getCustomerRecentDiscountLines(config, custname);
  applyDerivedDiscount(custname, lines);
  // Report the STORED value, not the derived one: if a manual override landed while
  // the fetch was in flight, the write was skipped (WHERE guard) and the derived
  // percent was never persisted — echoing it would show the admin a phantom value.
  return resolveDiscountPercent(custname);
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

// Implemented in the next task (per-part resolution); exported here so the shared
// test file typechecks. Do not use yet.
export function resolveDiscount(_custname: string | null): { blanket: number | null; uniform: boolean; forPart(partname: string): number | null } {
  throw new Error('not implemented');
}
