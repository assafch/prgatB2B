// Read-only checkout preview: the amounts + policy outcome the checkout screen
// shows BEFORE submit. Display-only — POST /api/orders re-evaluates the policy at
// submit time and remains the single source of truth (spec §3.1). No writes here.
import { getCart } from './orders.js';
import { enforcedFor, evaluate } from './paymentPolicy.js';
import { vatBreakdown } from './money.js';
import { getSettingBool } from './db.js';
import { installmentsRange } from './cardPayments.js';
import { tokenVaultReady } from './tokenVault.js';
import { fastTrackQualifies, fastTrackAmounts, fastTrackDiscountPct, type FastTrackAmounts } from './fastTrack.js';

export interface CheckoutPreview {
  enabled: boolean; // unified_checkout_enabled flag — client renders new UI only when true
  subtotal: number; // pre-discount, pre-VAT
  discount: number; // promo savings
  total: number;    // promotions.total (pre-VAT) — what the order records
  vatRate: number;
  vatAmount: number;
  payable: number;  // withVat(total) — what a cash customer pays now
  requiresPayment: boolean;
  kind: 'cash' | 'net' | null; // null when policy not enforced for this customer
  blocked: boolean; // net-terms open-debt block (mirrors decide())
  blockedReason: 'open_debt' | null;
  /** saved-card one-tap reuse: flag on AND the token vault has a key configured */
  savedCards: boolean;
  /** saved-card one-tap CHARGE (Phase 2): separate flag, gates the /charge-saved endpoint */
  savedCardCharge: boolean;
  /** installments window; non-null only when the feature is on AND payable ≥ min */
  installments: { min: number; max: number } | null;
  /** Fast-track (מסלול מהיר) offer — null when the flag is off, the company is opted
   *  out, the customer isn't on שוטף terms, must prepay anyway (cash policy — full
   *  price, no discount), or the order is debt-blocked. payable/saving are VAT-inclusive. */
  fastTrack: FastTrackAmounts | null;
}

export async function buildCheckoutPreview(userId: number, custname: string): Promise<CheckoutPreview> {
  const { promotions } = getCart(userId, custname);
  const base = {
    enabled: getSettingBool('unified_checkout_enabled', false),
    subtotal: promotions.subtotal,
    discount: promotions.discount,
    total: promotions.total,
    ...vatBreakdown(promotions.total),
    savedCards: getSettingBool('saved_cards_enabled', false) && tokenVaultReady(),
    savedCardCharge: getSettingBool('saved_card_charge_enabled', false),
  };
  const instRange = installmentsRange();
  const installments = instRange && base.payable >= instRange.min ? instRange : null;
  const qualifies = promotions.total > 0 && (await fastTrackQualifies(custname));
  const offerFast = (requiresPayment: boolean, blocked: boolean): FastTrackAmounts | null =>
    qualifies && !requiresPayment && !blocked ? fastTrackAmounts(promotions.total, fastTrackDiscountPct()) : null;
  if (!enforcedFor(custname)) {
    return { ...base, installments, requiresPayment: false, kind: null, blocked: false, blockedReason: null, fastTrack: offerFast(false, false) };
  }
  const d = await evaluate(custname, promotions.total);
  return {
    ...base,
    installments,
    requiresPayment: d.requiresPayment,
    kind: d.kind,
    blocked: !d.allowOrder,
    blockedReason: d.reason === 'open_debt' ? 'open_debt' : null,
    fastTrack: offerFast(d.requiresPayment, !d.allowOrder),
  };
}
