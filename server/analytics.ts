// Business analytics from Priority — admin dashboard. Uses ONLY API-enabled forms
// (AINVOICES, ORDERS, OBLIGO), bare $expand only (the inner-$select termination
// bug), and a short in-memory cache so the admin reloading the tab doesn't hammer
// the shared 100/min Priority quota. Each metric degrades to [] on form failure.

import { type PriorityConfig, loadAllFromPriority } from './priority.js';

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10) + 'T00:00:00Z';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// --- tiny TTL cache ---
const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; val: unknown }>();
async function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val as T;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}
async function tryOr<T>(label: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[analytics] ${label} unavailable:`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

export interface RevenuePoint { month: string; total: number; count: number }
export interface ProductStat { partname: string; pdes: string; qty: number; revenue: number }
export interface DebtorStat { custname: string; debit: number }
export interface InactiveCustomer { custname: string; lastOrder: string; daysSince: number }

export async function getRevenueByMonth(config: PriorityConfig, months = 12): Promise<RevenuePoint[]> {
  return memo(`rev:${months}`, () =>
    tryOr('revenue', [], async () => {
      const from = monthsAgoIso(months);
      const rows = await loadAllFromPriority(config, `AINVOICES?$select=IVDATE,TOTPRICE&$filter=IVDATE ge ${from}&$orderby=IVDATE asc`);
      const map = new Map<string, { total: number; count: number }>();
      for (const r of rows) {
        const m = String(r.IVDATE || '').slice(0, 7);
        if (!m) continue;
        const cur = map.get(m) || { total: 0, count: 0 };
        cur.total += Number(r.TOTPRICE) || 0;
        cur.count += 1;
        map.set(m, cur);
      }
      return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, v]) => ({ month, total: round2(v.total), count: v.count }));
    })
  );
}

export async function getTopProducts(config: PriorityConfig, months = 6, limit = 15): Promise<ProductStat[]> {
  return memo(`prod:${months}:${limit}`, () =>
    tryOr('topProducts', [], async () => {
      const from = monthsAgoIso(months);
      const rows = await loadAllFromPriority(config, `AINVOICES?$filter=IVDATE ge ${from}&$expand=AINVOICEITEMS_SUBFORM`);
      const map = new Map<string, ProductStat>();
      for (const inv of rows) {
        const lines = (inv.AINVOICEITEMS_SUBFORM || []) as Array<Record<string, unknown>>;
        for (const ln of lines) {
          const part = String(ln.PARTNAME || '').trim();
          if (!part) continue;
          const cur = map.get(part) || { partname: part, pdes: String(ln.PDES || ''), qty: 0, revenue: 0 };
          cur.qty += Number(ln.TQUANT) || 0;
          cur.revenue += Number(ln.QPRICE ?? ln.TOTPRICE) || 0;
          if (!cur.pdes && ln.PDES) cur.pdes = String(ln.PDES);
          map.set(part, cur);
        }
      }
      return [...map.values()].sort((a, b) => b.revenue - a.revenue).slice(0, limit).map((p) => ({ ...p, revenue: round2(p.revenue), qty: round2(p.qty) }));
    })
  );
}

export async function getTopDebtors(config: PriorityConfig, limit = 20): Promise<DebtorStat[]> {
  return memo(`debt:${limit}`, () =>
    tryOr('topDebtors', [], async () => {
      const rows = await loadAllFromPriority(config, `OBLIGO?$select=CUSTNAME,ACC_DEBIT&$orderby=ACC_DEBIT desc`);
      return rows
        .map((r) => ({ custname: String(r.CUSTNAME || ''), debit: round2(Number(r.ACC_DEBIT) || 0) }))
        .filter((r) => r.custname && r.debit > 0)
        .slice(0, limit);
    })
  );
}

export async function getInactiveCustomers(config: PriorityConfig, days = 90): Promise<InactiveCustomer[]> {
  return memo(`inactive:${days}`, () =>
    tryOr('inactiveCustomers', [], async () => {
      // Bound the scan to ~2 years so we surface recently-dormant customers without
      // loading all-time order history.
      const from = monthsAgoIso(24);
      const rows = await loadAllFromPriority(config, `ORDERS?$select=CUSTNAME,CURDATE&$filter=CURDATE ge ${from}&$orderby=CURDATE desc`);
      const last = new Map<string, string>();
      for (const r of rows) {
        const c = String(r.CUSTNAME || '');
        const d = String(r.CURDATE || '');
        if (!c || !d) continue;
        if (!last.has(c)) last.set(c, d); // desc order → first seen is most recent
      }
      const cutoff = Date.now() - days * 86400000;
      return [...last.entries()]
        .map(([custname, d]) => ({ custname, lastOrder: d.slice(0, 10), ts: new Date(d).getTime() }))
        .filter((x) => x.ts < cutoff)
        .sort((a, b) => a.ts - b.ts)
        .slice(0, 50)
        .map((x) => ({ custname: x.custname, lastOrder: x.lastOrder, daysSince: Math.floor((Date.now() - x.ts) / 86400000) }));
    })
  );
}
