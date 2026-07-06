// Payment-policy engine. PURE decision helpers here have NO DB/IO so they are unit-
// testable; the DB-backed resolve/evaluate live in later tasks. Spec: 2026-06-28-payment-policy.
import { db, getSetting, getSettingBool } from './db.js';
import { getAccountSummary } from './finance.js';
import { paidDebtCardTotal } from './cardPayments.js';
import { withVat } from './money.js';

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
    // Cart prices are pre-VAT (BASEPLPRICE); Priority invoices include VAT — charge the gross-up.
    return { allowOrder: true, requiresPayment: true, amount: withVat(cartTotal), reason: 'cash_payment_required' };
  }
  if (policy.blockOnOpenDebt && !policy.allowOrderWithOpenDebt && netDebt > policy.openDebtThreshold + 0.001) {
    return { allowOrder: false, requiresPayment: false, amount: round2(netDebt), reason: 'open_debt' };
  }
  return { allowOrder: true, requiresPayment: false, amount: null, reason: null };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------- Overdue-only block: PURE due-date helpers (no DB/IO — unit-tested) ----------
// Spec: 2026-07-06-overdue-only-debt-block. The tenant does not expose a per-invoice
// due date (IVPAY_SUBFORM verified empty on final invoices), so we compute it the way
// Priority displays it: end of invoice month + N days from the customer's PAYDES.

/** "שוטף" → 0, "שוטף+30"/"שוטף +30"/"שוטף30" → 30. Anything else (מזומן, null,
 *  unparseable) → 0 — strictest common terms; matches plain שוטף. */
export function parseNetTermsDays(paydes: string | null): number {
  const m = (paydes || '').match(/שוטף\s*\+?\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/** yyyy-mm-dd string for a UTC-midnight Date (IVDATE strings are date-only, so all
 *  math happens on calendar days — no timezone drift). */
const ymd = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

/** Due date for an invoice: the latest explicit IVPAY payment date when present
 *  (future-proofing — this tenant never populates it), else end of the invoice's
 *  calendar month + extraDays. Returns yyyy-mm-dd. */
export function invoiceDueDate(
  ivdate: string,
  extraDays: number,
  ivpayDates?: (string | null | undefined)[]
): string {
  const explicit = (ivpayDates || []).filter((s): s is string => typeof s === 'string' && s.length >= 10);
  if (explicit.length) return explicit.map((s) => s.slice(0, 10)).sort().at(-1)!;
  const y = Number(ivdate.slice(0, 4));
  const m = Number(ivdate.slice(5, 7)); // 1-based
  // Date.UTC(y, m, 0) = last day of month m; + extraDays via UTC ms arithmetic.
  const due = new Date(Date.UTC(y, m, 0) + extraDays * 86_400_000);
  return ymd(due);
}

/** Sum of unpaid invoices strictly past their due date. `todayYmd` is a yyyy-mm-dd
 *  string (Asia/Jerusalem); comparison is lexicographic (safe for ISO dates). */
export function overdueSum(
  invoices: { IVDATE?: string; TOTPRICE?: number; IVPAY_SUBFORM?: { PAYDATE?: string | null }[] }[],
  paydes: string | null,
  todayYmd: string
): number {
  const extra = parseNetTermsDays(paydes);
  let sum = 0;
  for (const iv of invoices) {
    if (!iv.IVDATE || typeof iv.TOTPRICE !== 'number' || !(iv.TOTPRICE > 0)) continue;
    const due = invoiceDueDate(iv.IVDATE, extra, iv.IVPAY_SUBFORM?.map((p) => p.PAYDATE));
    if (due < todayYmd) sum += iv.TOTPRICE;
  }
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}

/** Today's calendar date in Israel as yyyy-mm-dd ('en-CA' locale formats ISO-style). */
export function israelTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
}

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

const RECON_WINDOW = '-3 days';
/** Money "in flight" that should offset open debt so a fresh payment lifts the
 *  block: confirmed debt card payments + non-post-dated cheques the customer has
 *  submitted recently. Pending card intents are intentionally excluded (H2 fix) —
 *  only a confirmed 'paid' card transaction counts against the block. */
export function pendingSettlement(custname: string): number {
  const card = paidDebtCardTotal(custname);
  const chq = db.prepare(
    `SELECT COALESCE(SUM(amount),0) AS s FROM payment_checks
     WHERE custname = ? AND status = 'submitted' AND is_postdated = 0
       AND submitted_at >= datetime('now', ?)`
  ).get(custname, RECON_WINDOW) as { s: number };
  return Math.round(((card + (chq.s || 0)) + Number.EPSILON) * 100) / 100;
}

/** Async order-time evaluation: resolve policy, compute net debt, decide. */
export async function evaluate(custname: string, cartTotal: number): Promise<PolicyDecision & { kind: PolicyKind }> {
  const summary = await getAccountSummary(custname);
  const policy = resolvePolicy(custname, summary.profile?.paymentTerms ?? null);
  // M2: fail-open on Priority outage — bypass block but log it
  if (!summary.balanceOk) console.warn('[policy] balance unavailable for ' + custname + ' — open-debt block bypassed (fail-open)');
  const openTotal = summary.balanceOk ? summary.balance.openTotal : 0;
  const netDebt = Math.max(0, openTotal - pendingSettlement(custname));
  return { ...decide(policy, netDebt, cartTotal), kind: policy.kind };
}
