// Payment-policy engine. PURE decision helpers here have NO DB/IO so they are unit-
// testable; the DB-backed resolve/evaluate live in later tasks. Spec: 2026-06-28-payment-policy.
export type PolicyKind = 'cash' | 'net';
export interface Policy {
  kind: PolicyKind;
  requirePaymentBeforeApproval: boolean; // cash → true
  blockOnOpenDebt: boolean;              // net → true
  openDebtThreshold: number;             // block when netDebt > threshold
  allowOrderWithOpenDebt: boolean;       // per-customer exemption
}
export interface PolicyDecision {
  allowOrder: boolean;
  requiresPayment: boolean;
  amount: number | null;
  reason: 'cash_payment_required' | 'open_debt' | null;
}

/** Map a Priority PAYDES string to a policy kind. `cashMatch` is a list of
 *  substrings that mean "cash" (admin-config, default ["מזומן"]). Unknown → net
 *  (safe: ordering keeps working). */
export function derivePolicyKind(paydes: string | null, cashMatch: string[]): PolicyKind {
  const s = (paydes || '').trim();
  if (s && cashMatch.some((m) => m.trim() && s.includes(m.trim()))) return 'cash';
  return 'net';
}

/** Pure order-time decision. `netDebt` = openTotal − pendingSettlement (already
 *  excludes post-dated cheques). `cartTotal` is the new order total. */
export function decide(policy: Policy, netDebt: number, cartTotal: number): PolicyDecision {
  if (policy.kind === 'cash') {
    return { allowOrder: true, requiresPayment: true, amount: round2(cartTotal), reason: 'cash_payment_required' };
  }
  if (policy.blockOnOpenDebt && !policy.allowOrderWithOpenDebt && netDebt > policy.openDebtThreshold + 0.001) {
    return { allowOrder: false, requiresPayment: false, amount: round2(netDebt), reason: 'open_debt' };
  }
  return { allowOrder: true, requiresPayment: false, amount: null, reason: null };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
