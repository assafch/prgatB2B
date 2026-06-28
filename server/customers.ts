// Admin customer list — group users by custname, enrich with cached finance + payment policy.

import { db } from './db.js';
import { resolvePolicy } from './paymentPolicy.js';

export interface AdminCustomerRow {
  custname: string;
  cust_desc: string | null;
  user_count: number;
  kind: string;                 // stored override ('auto'|'cash'|'net')
  resolvedKind: 'cash' | 'net';
  open_debt_threshold: number | null;
  allow_order_with_open_debt: number;
  paymentTerms: string | null;  // cached PAYDES, may be null
  openTotal: number | null;     // cached ACC_DEBIT, may be null
}

/** CACHED-only finance (no live Priority call): read the per-piece finance_cache. */
function cachedFinance(custname: string): { paymentTerms: string | null; openTotal: number | null } {
  const get = db.prepare('SELECT value FROM finance_cache WHERE key = ?');
  let paymentTerms: string | null = null;
  let openTotal: number | null = null;
  const cust = get.get(`customer:${custname}`) as { value: string } | undefined;
  if (cust) { try { const p = String(JSON.parse(cust.value)?.PAYDES ?? '').trim(); paymentTerms = p || null; } catch { /* ignore */ } }
  const ob = get.get(`obligo:${custname}`) as { value: string } | undefined;
  if (ob) { try { const j = JSON.parse(ob.value); if (typeof j?.ACC_DEBIT === 'number') openTotal = Math.max(0, Math.round(j.ACC_DEBIT * 100) / 100); } catch { /* ignore */ } }
  return { paymentTerms, openTotal };
}

export function listCustomersAdmin(q: string, page: number, pageSize: number): { items: AdminCustomerRow[]; total: number } {
  const like = `%${q.trim()}%`;
  const where = q.trim() ? 'AND (u.custname LIKE ? OR u.cust_desc LIKE ?)' : '';
  const params: unknown[] = q.trim() ? [like, like] : [];
  const total = (db.prepare(
    `SELECT COUNT(*) n FROM (SELECT u.custname FROM users u WHERE u.role='customer' AND u.custname IS NOT NULL ${where} GROUP BY u.custname)`
  ).get(...params) as { n: number }).n;
  const rows = db.prepare(
    `SELECT u.custname AS custname, MAX(u.cust_desc) AS cust_desc, COUNT(*) AS user_count,
            cp.kind AS kind, cp.open_debt_threshold AS open_debt_threshold, cp.allow_order_with_open_debt AS allow_order_with_open_debt
     FROM users u LEFT JOIN customer_policies cp ON cp.custname = u.custname
     WHERE u.role='customer' AND u.custname IS NOT NULL ${where}
     GROUP BY u.custname ORDER BY cust_desc IS NULL, cust_desc LIMIT ? OFFSET ?`
  ).all(...params, pageSize, page * pageSize) as Array<Record<string, unknown>>;
  const items: AdminCustomerRow[] = rows.map((r) => {
    const custname = String(r.custname);
    const fin = cachedFinance(custname);
    return {
      custname,
      cust_desc: (r.cust_desc as string) ?? null,
      user_count: Number(r.user_count) || 0,
      kind: (r.kind as string) ?? 'auto',
      resolvedKind: resolvePolicy(custname, fin.paymentTerms).kind,
      open_debt_threshold: r.open_debt_threshold == null ? null : Number(r.open_debt_threshold),
      allow_order_with_open_debt: Number(r.allow_order_with_open_debt) || 0,
      paymentTerms: fin.paymentTerms,
      openTotal: fin.openTotal,
    };
  });
  return { items, total };
}
