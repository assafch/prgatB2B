// Home dashboard aggregate — one round-trip for the post-login landing screen.
// Combines the live finance summary (cached, degrades gracefully when Priority is
// down) with purely-local data (last order, heuristic reorder) so the dashboard
// always renders something useful even if the ERP is unreachable.

import { db } from './db.js';
import { getAccountSummary, type BalanceSummary } from './finance.js';
import { getReorderSuggestions, type ReorderSuggestion } from './reorder.js';

export interface LastOrderView {
  id: number;
  ordname: string | null;
  status: string;
  total: number | null;
  created_at: string;
  itemCount: number;
}

export interface HomeData {
  custname: string;
  custDesc: string | null;
  balance: BalanceSummary;
  priorityOk: boolean;
  balanceOk: boolean;
  lastOrder: LastOrderView | null;
  suggestions: ReorderSuggestion[];
  /** server-owned feature flags so the client never shows dead CTAs */
  features: { payments: boolean };
}

export async function getHomeData(
  userId: number,
  custname: string,
  custDesc: string | null
): Promise<HomeData> {
  // Finance can be slow / unavailable; the rest is instant local SQLite.
  const summary = await getAccountSummary(custname);

  const lastRow = db
    .prepare(
      `SELECT id, priority_ordname, status, total, created_at
       FROM orders_local
       WHERE user_id = ? AND status = 'submitted'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId) as
    | { id: number; priority_ordname: string | null; status: string; total: number | null; created_at: string }
    | undefined;

  let lastOrder: LastOrderView | null = null;
  if (lastRow) {
    const { c } = db
      .prepare('SELECT COUNT(*) AS c FROM order_lines WHERE order_id = ?')
      .get(lastRow.id) as { c: number };
    lastOrder = {
      id: lastRow.id,
      ordname: lastRow.priority_ordname,
      status: lastRow.status,
      total: lastRow.total,
      created_at: lastRow.created_at,
      itemCount: c,
    };
  }

  return {
    custname,
    custDesc,
    balance: summary.balance,
    priorityOk: summary.priorityOk,
    balanceOk: summary.balanceOk,
    lastOrder,
    suggestions: getReorderSuggestions(userId, custname),
    features: { payments: process.env.PAYMENTS_ENABLED === 'true' },
  };
}
