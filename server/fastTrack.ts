// Fast-track checkout (מסלול מהיר): the customer CHOOSES to prepay (card / cheque
// photo) in exchange for a % discount + instant approval + priority shipping. The
// regular track (net terms) stays untouched. Plan: 2026-07-09-fast-track-checkout.
import { db, getSetting, getSettingBool } from './db.js';
import { withVat } from './money.js';
import { getAccountSummary } from './finance.js';

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const FAST_TRACK_KEYS = {
  enabled: 'fast_track_enabled',
  discountPct: 'fast_track_discount_pct',
} as const;

export function fastTrackEnabled(): boolean {
  return getSettingBool(FAST_TRACK_KEYS.enabled, false);
}

/** Admin-config discount %. Unset/blank/invalid → default 3; clamped to 0–20 so a
 *  fat-fingered "30" can never give away a third of an order. An explicit "0" is
 *  honored (admin deliberately runs the fast track without a discount). */
export function fastTrackDiscountPct(): number {
  const raw = getSetting(FAST_TRACK_KEYS.discountPct);
  if (raw == null || String(raw).trim() === '') return 3;
  const v = Number(raw);
  if (!isFinite(v) || v < 0) return 3;
  return Math.min(v, 20);
}

/** Per-customer eligibility. No row / NULL = eligible — the offer is a benefit,
 *  on by default; the admin opts specific companies OUT (fast_track = 0). */
export function fastTrackCustomerEligible(custname: string): boolean {
  const row = db.prepare('SELECT fast_track FROM customer_policies WHERE custname = ?').get(custname) as
    | { fast_track?: number | null } | undefined;
  if (!row || row.fast_track == null) return true;
  return !!row.fast_track;
}

/** Sync core gate: master flag AND this customer not opted out. Composed by
 *  fastTrackQualifies — callers deciding whether to OFFER must use that. */
export function fastTrackAvailable(custname: string): boolean {
  return fastTrackEnabled() && fastTrackCustomerEligible(custname);
}

/** Full qualification: flag on, company not opted out, AND genuinely on net terms
 *  (שוטף). Explicit per-customer kind override wins both ways; otherwise PAYDES must
 *  actually say שוטף — derivePolicyKind's net-default is a fail-open for ordering,
 *  not for granting discounts. Terms unknown / Priority down → no offer (the regular
 *  flow keeps working). */
export async function fastTrackQualifies(custname: string): Promise<boolean> {
  if (!fastTrackAvailable(custname)) return false;
  const row = db.prepare('SELECT kind FROM customer_policies WHERE custname = ?').get(custname) as
    | { kind?: string } | undefined;
  if (row?.kind === 'net') return true;
  if (row?.kind === 'cash') return false;
  try {
    const summary = await getAccountSummary(custname);
    return /שוטף/.test(summary.profile?.paymentTerms ?? '');
  } catch {
    return false;
  }
}

export interface FastTrackAmounts {
  discountPct: number;
  discountedTotal: number; // pre-VAT, after the fast-track % (applied on the post-promotion total)
  payable: number;         // withVat(discountedTotal) — what the customer pays now
  saving: number;          // VAT-inclusive saving vs paying full: withVat(total) − payable
}

/** PURE discount math (unit-tested). `preVatTotal` is the post-promotion cart total —
 *  the fast-track % stacks on top of promotions, matching what the customer sees. */
export function fastTrackAmounts(preVatTotal: number, pct: number): FastTrackAmounts {
  const discountedTotal = round2(preVatTotal * (1 - pct / 100));
  const payable = withVat(discountedTotal);
  return { discountPct: pct, discountedTotal, payable, saving: round2(withVat(preVatTotal) - payable) };
}
