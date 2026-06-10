// Customer financial view: live profile + invoices + open balance from Priority.
// Short in-memory TTL cache keyed per customer keeps us well under Priority's
// 100-calls/min limit when a customer reloads their account/invoices screens.

import { db } from './db.js';
import {
  getPriorityConfig,
  getCustomer,
  listOpenInvoices,
  listInvoices,
  getObligo,
  getInvoiceWithItems,
  type PriorityCustomerFull,
} from './priority.js';

export interface InvoiceDetailView {
  ivnum: string;
  date: string | null;
  total: number;
  beforeVat: number | null;
  vat: number | null;
  ordname: string | null;
  status: string | null;
  items: Array<{ partname: string | null; pdes: string | null; quantity: number; price: number | null; lineTotal: number | null }>;
}

export async function getInvoiceDetail(custname: string, ivnum: string): Promise<InvoiceDetailView | null> {
  const config = getPriorityConfig();
  if (!config) return null;
  const inv = await getInvoiceWithItems(config, custname, ivnum).catch(() => null);
  if (!inv) return null;
  return {
    ivnum: String(inv.IVNUM ?? ivnum),
    date: inv.IVDATE ?? null,
    total: Math.round((Number(inv.TOTPRICE) || 0) * 100) / 100,
    beforeVat: inv.QPRICE != null ? Math.round(Number(inv.QPRICE) * 100) / 100 : null,
    vat: inv.VAT != null ? Math.round(Number(inv.VAT) * 100) / 100 : null,
    ordname: inv.ORDNAME ?? null,
    status: inv.STATDES ?? null,
    items: (inv.items || []).map((l) => ({
      partname: l.PARTNAME ?? null,
      pdes: l.PDES ?? null,
      quantity: Number(l.TQUANT) || 0,
      price: l.PRICE != null ? Math.round(Number(l.PRICE) * 100) / 100 : null,
      lineTotal: l.TOTPRICE != null ? Math.round(Number(l.TOTPRICE) * 100) / 100 : null,
    })),
  };
}

// Stale-while-revalidate: serve the cached snapshot INSTANTLY (never block the
// request on Priority); if it's older than FRESH_MS, kick off a background refresh
// for next time. Snapshots persist to SQLite so deploys/restarts stay warm. Only
// the very first read for a customer (no snapshot anywhere) awaits Priority.
const FRESH_MS = 5 * 60_000;

interface CacheEntry<T> {
  value: T;
  updatedAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Set<string>();

const loadPersist = db.prepare('SELECT value, updated_at FROM finance_cache WHERE key = ?');
const savePersist = db.prepare(
  'INSERT INTO finance_cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
);
const dropPersist = db.prepare('DELETE FROM finance_cache WHERE key = ?');

function store<T>(key: string, value: T): void {
  const updatedAt = Date.now();
  cache.set(key, { value, updatedAt });
  try {
    savePersist.run(key, JSON.stringify(value), updatedAt);
  } catch {
    /* cache write best-effort */
  }
}

function revalidate<T>(key: string, fn: () => Promise<T>): void {
  if (inflight.has(key)) return;
  inflight.add(key);
  fn()
    .then((v) => store(key, v))
    .catch((err) => console.warn(`[finance] bg refresh ${key}:`, err instanceof Error ? err.message : err))
    .finally(() => inflight.delete(key));
}

async function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) {
    const row = loadPersist.get(key) as { value: string; updated_at: number } | undefined;
    if (row) {
      try {
        entry = { value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
        cache.set(key, entry);
      } catch {
        /* corrupt row — ignore, fall through to fetch */
      }
    }
  }
  if (entry) {
    if (Date.now() - entry.updatedAt > FRESH_MS) revalidate(key, fn); // stale → refresh for next time
    return entry.value; // instant, even if slightly stale
  }
  // No snapshot anywhere — must fetch once.
  const value = await fn();
  store(key, value);
  return value;
}

export function bustFinanceCache(custname?: string): void {
  if (!custname) {
    cache.clear();
    try {
      db.prepare('DELETE FROM finance_cache').run();
    } catch {
      /* ignore */
    }
    return;
  }
  for (const key of cache.keys()) {
    if (key.endsWith(`:${custname}`)) {
      cache.delete(key);
      try {
        dropPersist.run(key);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Fire-and-forget warm of a customer's finance snapshots (called on login) so the
 *  first dashboard load is instant. */
export function warmFinance(custname: string): void {
  void getAccountSummary(custname).catch(() => {});
  void getInvoices(custname).catch(() => {});
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------- Profile + balance summary ----------

export interface CustomerProfile {
  custname: string;
  name: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  vatNumber: string | null;
  paymentTerms: string | null;
  agent: string | null;
}

export interface BalanceSummary {
  openTotal: number; // outstanding to pay (incl VAT)
  openCount: number; // number of open invoices
  obligo: number | null; // total credit exposure
  creditLimit: number | null;
}

export interface AccountSummary {
  profile: CustomerProfile | null;
  balance: BalanceSummary;
  /** could we reach Priority at all (the customer profile loaded)? */
  priorityOk: boolean;
  /** did the open-balance/obligo forms load? They may be API-disabled per the
   *  API user's form permissions even when the profile loads fine. */
  balanceOk: boolean;
}

// Run a Priority call but never throw — return null on any failure (incl. a
// form that isn't API-enabled, which 400s). Lets the summary show what IS
// available instead of collapsing entirely when one form is blocked.
async function tryGet<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[finance] ${label} unavailable:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function shapeProfile(custname: string, c: PriorityCustomerFull | null): CustomerProfile | null {
  if (!c) return null;
  const clean = (v: unknown): string | null => {
    const s = v == null ? '' : String(v).trim();
    return s ? s : null;
  };
  return {
    custname,
    name: clean(c.CUSTDES),
    address: clean(c.ADDRESS),
    city: clean(c.STATE),
    zip: clean(c.ZIP),
    phone: clean(c.PHONE),
    fax: clean(c.FAX),
    email: clean(c.EMAIL),
    vatNumber: clean(c.VATNUM),
    paymentTerms: clean(c.PAYDES),
    agent: clean(c.AGENTNAME),
  };
}

export async function getAccountSummary(custname: string): Promise<AccountSummary> {
  const emptyBalance: BalanceSummary = { openTotal: 0, openCount: 0, obligo: null, creditLimit: null };
  const config = getPriorityConfig();
  if (!config) {
    return { profile: null, balance: emptyBalance, priorityOk: false, balanceOk: false };
  }

  // Each form is fetched independently and tolerates failure — a single
  // API-disabled form (OPENINVOICES/OBLIGO commonly need the form ticked for the
  // API user) must not hide the customer profile.
  const [customer, open, obligo] = await Promise.all([
    tryGet(`customer:${custname}`, () => memo(`customer:${custname}`, () => getCustomer(config, custname))),
    tryGet(`open:${custname}`, () => memo(`open:${custname}`, () => listOpenInvoices(config, custname))),
    tryGet(`obligo:${custname}`, () => memo(`obligo:${custname}`, () => getObligo(config, custname))),
  ]);

  // AUTHORITATIVE open debt = OBLIGO.ACC_DEBIT (the AR account debit), which
  // matches Priority's official "חובות שטרם שולמו" statement. OPENINVOICES proved
  // unreliable on this tenant (returns 0 rows for customers who genuinely owe — it
  // missed a real overdue invoice), so it is NOT used for the debt total; we keep
  // it only as a best-effort line-item list. Post-dated cheques (CHEQUE_DEBIT) are
  // deliberately NOT counted as debt — the customer already handed over the cheques.
  const accDebit =
    obligo && typeof obligo.ACC_DEBIT === 'number' ? Math.max(0, round2(obligo.ACC_DEBIT)) : null;
  const openSum = open ? round2(open.reduce((sum, iv) => sum + (Number(iv.TOTPRICE) || 0), 0)) : null;
  const openTotal = accDebit ?? openSum ?? 0;
  const balanceOk = accDebit !== null || openSum !== null;

  const balance: BalanceSummary = {
    openTotal,
    // From OPENINVOICES — a HINT only (may undercount). The UI must not claim
    // "0 open invoices" when openTotal > 0.
    openCount: open ? open.length : 0,
    obligo: obligo && typeof obligo.OBLIGO === 'number' ? round2(obligo.OBLIGO) : null,
    creditLimit:
      obligo && typeof obligo.MAX_CREDIT === 'number' && obligo.MAX_CREDIT > 0
        ? round2(obligo.MAX_CREDIT)
        : null,
  };

  return {
    profile: shapeProfile(custname, customer),
    balance,
    priorityOk: customer !== null || obligo !== null || open !== null,
    balanceOk,
  };
}

// ---------- Invoices (open + history) ----------

export interface OpenInvoiceView {
  date: string | null;
  docNo: string | null;
  amount: number; // incl VAT, the open amount
  amountBeforeVat: number | null;
  vat: number | null;
  ordname: string | null;
  reference: string | null;
}

export interface InvoiceView {
  ivnum: string;
  date: string | null;
  amount: number; // incl VAT
  beforeVat: number | null;
  vat: number | null;
  status: string | null;
  ordname: string | null;
  isCredit: boolean; // credit note / זיכוי (negative)
}

export interface InvoicesResult {
  open: OpenInvoiceView[];
  history: InvoiceView[];
  summary: { openTotal: number; openCount: number };
  priorityOk: boolean;
  /** true when the open-invoices form is API-disabled (distinct from a network outage) */
  openUnavailable?: boolean;
  historyUnavailable?: boolean;
  /** openTotal came from the authoritative OBLIGO.ACC_DEBIT but the per-invoice
   *  open LIST (from OPENINVOICES) is empty/incomplete — UI should say so rather
   *  than imply "no open invoices". */
  openListIncomplete?: boolean;
}

export async function getInvoices(custname: string): Promise<InvoicesResult> {
  const config = getPriorityConfig();
  if (!config) {
    return { open: [], history: [], summary: { openTotal: 0, openCount: 0 }, priorityOk: false };
  }

  const [open, history, obligo] = await Promise.all([
    tryGet(`open:${custname}`, () => memo(`open:${custname}`, () => listOpenInvoices(config, custname))),
    tryGet(`invoices:${custname}`, () => memo(`invoices:${custname}`, () => listInvoices(config, custname))),
    tryGet(`obligo:${custname}`, () => memo(`obligo:${custname}`, () => getObligo(config, custname))),
  ]);

  // Both invoice forms blocked/unreachable → signal a hard failure to the UI.
  if (open === null && history === null) {
    return { open: [], history: [], summary: { openTotal: 0, openCount: 0 }, priorityOk: false };
  }

  try {
    const openViews: OpenInvoiceView[] = (open ?? []).map((iv) => ({
      date: iv.CURDATE ?? null,
      docNo: iv.DOCNO != null ? String(iv.DOCNO) : iv.DOCREF ?? null,
      amount: round2(Number(iv.TOTPRICE) || 0),
      amountBeforeVat: iv.DISPRICE != null ? round2(Number(iv.DISPRICE)) : null,
      vat: iv.VAT != null ? round2(Number(iv.VAT)) : null,
      ordname: iv.ORDNAME ?? null,
      reference: iv.REFERENCE ?? iv.BOOKNUM ?? null,
    }));

    // Customers should only see finalized documents (hide drafts/cancelled).
    const historyViews: InvoiceView[] = (history ?? [])
      .filter((iv) => (iv.STATDES || '').trim() === 'סופית')
      .map((iv) => ({
        ivnum: String(iv.IVNUM ?? ''),
        date: iv.IVDATE ?? null,
        amount: round2(Number(iv.TOTPRICE) || 0),
        beforeVat: iv.QPRICE != null ? round2(Number(iv.QPRICE)) : null,
        vat: iv.VAT != null ? round2(Number(iv.VAT)) : null,
        status: iv.STATDES ?? null,
        ordname: iv.ORDNAME ?? null,
        isCredit: (Number(iv.TOTPRICE) || 0) < 0 || String(iv.IVNUM ?? '').startsWith('IK'),
      }));

    // Authoritative open debt = OBLIGO.ACC_DEBIT (matches the official statement);
    // OPENINVOICES sum is the fallback when OBLIGO is unavailable.
    const accDebit =
      obligo && typeof obligo.ACC_DEBIT === 'number' ? Math.max(0, round2(obligo.ACC_DEBIT)) : null;
    const openListSum = round2(openViews.reduce((sum, iv) => sum + iv.amount, 0));
    const openTotal = accDebit ?? openListSum;
    // We owe money (per the AR balance) but the per-invoice open list is empty.
    const openListIncomplete = openTotal > 0.005 && openViews.length === 0;

    return {
      open: openViews,
      history: historyViews,
      summary: { openTotal, openCount: openViews.length },
      priorityOk: true,
      openUnavailable: open === null,
      historyUnavailable: history === null,
      openListIncomplete,
    };
  } catch (err) {
    console.warn('[finance] getInvoices shaping failed:', err);
    return { open: [], history: [], summary: { openTotal: 0, openCount: 0 }, priorityOk: false };
  }
}
