// Ops queue — the numbers behind the dashboard "דורש טיפול" rail and the admin
// nav badges. All reads are local SQLite only: the rail must render instantly
// even when Priority is down.
import { db } from './db.js';

export interface QueueStat { count: number; sum: number }

export interface OpsQueues {
  stuckOrders: QueueStat;                               // paid, never reached Priority
  failedReceipts: QueueStat;                            // receipt creation gave up
  pendingChecks: QueueStat & { oldest: string | null }; // cheques awaiting approval
  newLeads: { count: number; latestName: string | null; latestAt: string | null };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function getOpsQueues(): OpsQueues {
  const stuck = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(COALESCE(payment_required_amount, total)), 0) s
       FROM orders_local WHERE payment_status = 'approved' AND priority_ordname IS NULL`
  ).get() as { c: number; s: number };
  const receipts = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(cp.amount), 0) s
       FROM priority_receipts pr JOIN card_payments cp ON cp.id = pr.card_payment_id
      WHERE pr.status = 'failed'`
  ).get() as { c: number; s: number };
  const checks = db.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(amount), 0) s, MIN(COALESCE(submitted_at, created_at)) o
       FROM payment_checks WHERE status = 'submitted'`
  ).get() as { c: number; s: number; o: string | null };
  const leadCount = (db.prepare(`SELECT COUNT(*) c FROM leads WHERE status = 'new'`).get() as { c: number }).c;
  const latestLead = db.prepare(
    `SELECT business_name, created_at FROM leads WHERE status = 'new' ORDER BY created_at DESC, id DESC LIMIT 1`
  ).get() as { business_name: string | null; created_at: string } | undefined;
  return {
    stuckOrders: { count: stuck.c, sum: r2(stuck.s) },
    failedReceipts: { count: receipts.c, sum: r2(receipts.s) },
    pendingChecks: { count: checks.c, sum: r2(checks.s), oldest: checks.o },
    newLeads: { count: leadCount, latestName: latestLead?.business_name ?? null, latestAt: latestLead?.created_at ?? null },
  };
}

export interface ActivityEvent {
  kind: 'order' | 'check' | 'card' | 'lead';
  at: string;             // sqlite UTC datetime
  ref: string;            // order id / cheque id / payment id / lead id
  label: string;          // custname or business name
  amount: number | null;  // shekels; null for leads
}

/** Recent activity, newest first, across orders / cheques / card payments / leads. */
export function getRecentActivity(limit = 8): ActivityEvent[] {
  return db.prepare(
    `SELECT 'order' AS kind, created_at AS at, CAST(id AS TEXT) AS ref, custname AS label, total AS amount FROM orders_local
     UNION ALL
     SELECT 'check', COALESCE(submitted_at, created_at), id, custname, amount FROM payment_checks WHERE status != 'draft'
     UNION ALL
     SELECT 'card', COALESCE(paid_at, created_at), id, custname, amount FROM card_payments WHERE status = 'paid'
     UNION ALL
     SELECT 'lead', created_at, CAST(id AS TEXT), COALESCE(business_name, 'ליד חדש'), NULL FROM leads
     ORDER BY at DESC LIMIT ?`
  ).all(limit) as ActivityEvent[];
}
