// Single source of truth for VAT. Catalog/cart prices are pre-VAT (BASEPLPRICE);
// Priority invoices include VAT. Israeli VAT is 18% (since 2025-01-01).
export const VAT_RATE = 0.18;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Gross a pre-VAT amount up to VAT-inclusive. */
export function withVat(preVat: number): number {
  return round2(preVat * (1 + VAT_RATE));
}
