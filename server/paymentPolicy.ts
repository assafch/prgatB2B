// Payment-policy engine. PURE decision helpers here have NO DB/IO so they are unit-
// testable; the DB-backed resolve/evaluate live in later tasks. Spec: 2026-06-28-payment-policy.
import { db, getSetting, getSettingBool } from './db.js';
import { getAccountSummary } from './finance.js';
import { unreconciledCardTotal } from './cardPayments.js';

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

const SETTING_KEYS = {
  enabled: 'payment_policy_enabled',
  cashMatch: 'policy_cash_paydes_match', // CSV of PAYDES substrings → cash
  netThreshold: 'policy_net_debt_threshold',
} as const;

export function policyEnabled(): boolean {
  return getSettingBool(SETTING_KEYS.enabled, false);
}

/** Is the payment policy individually enabled for this customer? */
export function isEnforced(custname: string): boolean {
  const row = db.prepare('SELECT enforced FROM customer_policies WHERE custname = ?').get(custname) as { enforced?: number } | undefined;
  return !!(row && row.enforced);
}
/** Policy fires for a customer iff the master flag is on AND the customer is enrolled. */
export function enforcedFor(custname: string): boolean {
  return policyEnabled() && isEnforced(custname);
}
function cashMatchList(): string[] {
  return (getSetting(SETTING_KEYS.cashMatch) || 'מזומן').split(',').map((s) => s.trim()).filter(Boolean);
}
function globalThreshold(): number {
  const v = Number(getSetting(SETTING_KEYS.netThreshold));
  return isFinite(v) && v >= 0 ? v : 0;
}

interface PolicyRow { kind: string; open_debt_threshold: number | null; allow_order_with_open_debt: number }

/** Resolve a customer's effective policy: auto-derive from PAYDES, then apply the
 *  per-customer customer_policies override (kind + threshold + exemption). */
export function resolvePolicy(custname: string, paymentTerms: string | null): Policy {
  const row = db.prepare('SELECT kind, open_debt_threshold, allow_order_with_open_debt FROM customer_policies WHERE custname = ?').get(custname) as PolicyRow | undefined;
  const overrideKind = row && row.kind !== 'auto' && (row.kind === 'cash' || row.kind === 'net') ? (row.kind as PolicyKind) : null;
  const kind = overrideKind ?? derivePolicyKind(paymentTerms, cashMatchList());
  return {
    kind,
    requirePaymentBeforeApproval: kind === 'cash',
    blockOnOpenDebt: kind === 'net',
    openDebtThreshold: row && row.open_debt_threshold != null ? row.open_debt_threshold : globalThreshold(),
    allowOrderWithOpenDebt: !!(row && row.allow_order_with_open_debt),
  };
}

const RECON_WINDOW = '-1 day';
/** Money "in flight" that should offset open debt so a fresh payment lifts the
 *  block: unreconciled card payments + cheques the customer has submitted recently. */
export function pendingSettlement(custname: string): number {
  const card = unreconciledCardTotal(custname);
  const chq = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM payment_checks
     WHERE custname = ? AND status = 'submitted' AND submitted_at >= datetime('now', ?)`
  ).get(custname, RECON_WINDOW) as { s: number };
  return Math.round(((card + (chq.s || 0)) + Number.EPSILON) * 100) / 100;
}

/** Async order-time evaluation: resolve policy, compute net debt, decide. */
export async function evaluate(custname: string, cartTotal: number): Promise<PolicyDecision & { kind: PolicyKind }> {
  const summary = await getAccountSummary(custname);
  const policy = resolvePolicy(custname, summary.profile?.paymentTerms ?? null);
  const openTotal = summary.balanceOk ? summary.balance.openTotal : 0;
  const netDebt = Math.max(0, openTotal - pendingSettlement(custname));
  return { ...decide(policy, netDebt, cartTotal), kind: policy.kind };
}
