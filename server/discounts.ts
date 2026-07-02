// Per-customer discount percent: Priority applies a flat line PERCENT on top of the
// base list price (verified live: PRICE == BASEPLPRICE, PERCENT uniform per customer).
// There is NO API-readable master on this tenant (CUSTOMERS has no discount field,
// PRICELIST form is API-disabled) — so we derive the percent from the customer's own
// recent order lines and let the admin override it.

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
