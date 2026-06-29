// Admin customer list — group users by custname, enrich with cached finance + payment policy.

import { db } from './db.js';
import { resolvePolicy } from './paymentPolicy.js';
import { getAccountSummary } from './finance.js';

export interface AdminCustomerRow {
  custname: string;
  cust_desc: string | null;
  user_count: number;
  kind: string;                 // stored override ('auto'|'cash'|'net')
  resolvedKind: 'cash' | 'net';
  open_debt_threshold: number | null;
  allow_order_with_open_debt: number;
  enforced: number;             // per-customer policy rollout gate (0=off, 1=on)
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
            cp.kind AS kind, cp.open_debt_threshold AS open_debt_threshold, cp.allow_order_with_open_debt AS allow_order_with_open_debt, cp.enforced AS enforced
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
      enforced: Number(r.enforced) || 0,
      paymentTerms: fin.paymentTerms,
      openTotal: fin.openTotal,
    };
  });
  return { items, total };
}

const PATCHABLE = new Set(['kind', 'open_debt_threshold', 'allow_order_with_open_debt', 'enforced']);

/** Upsert a company's policy. Read-merge-write so a field absent from `patch` is
 *  preserved and an explicit null threshold is honored. */
export function patchCustomer(custname: string, patch: Record<string, unknown>): void {
  const cur = (db.prepare('SELECT kind, open_debt_threshold, allow_order_with_open_debt, enforced FROM customer_policies WHERE custname = ?').get(custname)
    || { kind: 'auto', open_debt_threshold: null, allow_order_with_open_debt: 0, enforced: 0 }) as { kind: string; open_debt_threshold: number | null; allow_order_with_open_debt: number; enforced: number };
  let kind = cur.kind;
  if (patch.kind != null && ['auto', 'cash', 'net'].includes(String(patch.kind))) kind = String(patch.kind);
  let thr = cur.open_debt_threshold;
  if ('open_debt_threshold' in patch) thr = (patch.open_debt_threshold === '' || patch.open_debt_threshold == null) ? null : Number(patch.open_debt_threshold);
  let allow = cur.allow_order_with_open_debt;
  if ('allow_order_with_open_debt' in patch) allow = patch.allow_order_with_open_debt ? 1 : 0;
  let enforced = cur.enforced;
  if ('enforced' in patch) enforced = patch.enforced ? 1 : 0;
  db.prepare(
    `INSERT INTO customer_policies (custname, kind, open_debt_threshold, allow_order_with_open_debt, enforced, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(custname) DO UPDATE SET kind = excluded.kind, open_debt_threshold = excluded.open_debt_threshold, allow_order_with_open_debt = excluded.allow_order_with_open_debt, enforced = excluded.enforced, updated_at = datetime('now')`
  ).run(custname, kind, thr, allow, enforced);
}

export function batchUpdateCustomers(items: Array<Record<string, unknown>>): number {
  let n = 0;
  const tx = db.transaction((rows: Array<Record<string, unknown>>) => {
    for (const row of rows) {
      const custname = String(row.custname || '');
      if (!custname) continue;
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(row)) if (PATCHABLE.has(k)) patch[k] = row[k];
      if (Object.keys(patch).length) { patchCustomer(custname, patch); n++; }
    }
  });
  tx(items);
  return n;
}

export async function getCustomerAdmin(custname: string): Promise<Record<string, unknown>> {
  const policy = db.prepare('SELECT kind, open_debt_threshold, allow_order_with_open_debt, enforced FROM customer_policies WHERE custname = ?').get(custname)
    || { kind: 'auto', open_debt_threshold: null, allow_order_with_open_debt: 0, enforced: 0 };
  const users = db.prepare('SELECT id, username, customer_role, status, last_login_at FROM users WHERE custname = ? ORDER BY username').all(custname);
  const cust_desc = (db.prepare('SELECT cust_desc FROM users WHERE custname = ? AND cust_desc IS NOT NULL LIMIT 1').get(custname) as { cust_desc?: string } | undefined)?.cust_desc ?? null;
  let finance: Record<string, unknown> = { priorityOk: false };
  try {
    const s = await getAccountSummary(custname);
    finance = {
      priorityOk: s.priorityOk !== false,
      paymentTerms: s.profile?.paymentTerms ?? null,
      openTotal: s.balance?.openTotal ?? null,
      creditLimit: s.balance?.creditLimit ?? null,
      obligo: s.balance?.obligo ?? null,
    };
  } catch { /* leave priorityOk:false */ }
  const resolvedKind = resolvePolicy(custname, (finance.paymentTerms as string) ?? null).kind;
  return { custname, cust_desc, policy, resolvedKind, users, finance };
}
