// Read-only checkout preview: the amounts + policy outcome the checkout screen
// shows BEFORE submit. Display-only — POST /api/orders re-evaluates the policy at
// submit time and remains the single source of truth (spec §3.1). No writes here.
import { getCart } from './orders.js';
import { enforcedFor, evaluate } from './paymentPolicy.js';
import { vatBreakdown } from './money.js';
import { getSettingBool } from './db.js';

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
}

export async function buildCheckoutPreview(userId: number, custname: string): Promise<CheckoutPreview> {
  const { promotions } = getCart(userId, custname);
  const base = {
    enabled: getSettingBool('unified_checkout_enabled', false),
    subtotal: promotions.subtotal,
    discount: promotions.discount,
    total: promotions.total,
    ...vatBreakdown(promotions.total),
  };
  if (!enforcedFor(custname)) {
    return { ...base, requiresPayment: false, kind: null, blocked: false, blockedReason: null };
  }
  const d = await evaluate(custname, promotions.total);
  return {
    ...base,
    requiresPayment: d.requiresPayment,
    kind: d.kind,
    blocked: !d.allowOrder,
    blockedReason: d.reason === 'open_debt' ? 'open_debt' : null,
  };
}
