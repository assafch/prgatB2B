// Customer financial view: live profile + invoices + open balance from Priority.
// Short in-memory TTL cache keyed per customer keeps us well under Priority's
// 100-calls/min limit when a customer reloads their account/invoices screens.

import {
  getPriorityConfig,
  getCustomer,
  listOpenInvoices,
  listInvoices,
  getObligo,
  type PriorityCustomerFull,
} from './priority.js';

const TTL_MS = 5 * 60_000;

interface CacheEntry<T> {
  value: T;
  expires: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

async function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

export function bustFinanceCache(custname?: string): void {
  if (!custname) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.endsWith(`:${custname}`)) cache.delete(key);
  }
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
  priorityOk: boolean;
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
  const config = getPriorityConfig();
  if (!config) {
    return {
      profile: null,
      balance: { openTotal: 0, openCount: 0, obligo: null, creditLimit: null },
      priorityOk: false,
    };
  }

  try {
    const [customer, open, obligo] = await Promise.all([
      memo(`customer:${custname}`, () => getCustomer(config, custname)),
      memo(`open:${custname}`, () => listOpenInvoices(config, custname)),
      memo(`obligo:${custname}`, () => getObligo(config, custname)),
    ]);

    const openTotal = round2(open.reduce((sum, iv) => sum + (Number(iv.TOTPRICE) || 0), 0));

    return {
      profile: shapeProfile(custname, customer),
      balance: {
        openTotal,
        openCount: open.length,
        obligo: obligo && typeof obligo.OBLIGO === 'number' ? round2(obligo.OBLIGO) : null,
        creditLimit:
          obligo && typeof obligo.MAX_CREDIT === 'number' && obligo.MAX_CREDIT > 0
            ? round2(obligo.MAX_CREDIT)
            : null,
      },
      priorityOk: true,
    };
  } catch (err) {
    console.warn('[finance] getAccountSummary failed:', err);
    return {
      profile: null,
      balance: { openTotal: 0, openCount: 0, obligo: null, creditLimit: null },
      priorityOk: false,
    };
  }
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
}

export async function getInvoices(custname: string): Promise<InvoicesResult> {
  const config = getPriorityConfig();
  if (!config) {
    return { open: [], history: [], summary: { openTotal: 0, openCount: 0 }, priorityOk: false };
  }

  try {
    const [open, history] = await Promise.all([
      memo(`open:${custname}`, () => listOpenInvoices(config, custname)),
      memo(`invoices:${custname}`, () => listInvoices(config, custname)),
    ]);

    const openViews: OpenInvoiceView[] = open.map((iv) => ({
      date: iv.CURDATE ?? null,
      docNo: iv.DOCNO != null ? String(iv.DOCNO) : iv.DOCREF ?? null,
      amount: round2(Number(iv.TOTPRICE) || 0),
      amountBeforeVat: iv.DISPRICE != null ? round2(Number(iv.DISPRICE)) : null,
      vat: iv.VAT != null ? round2(Number(iv.VAT)) : null,
      ordname: iv.ORDNAME ?? null,
      reference: iv.REFERENCE ?? iv.BOOKNUM ?? null,
    }));

    // Customers should only see finalized documents (hide drafts/cancelled).
    const historyViews: InvoiceView[] = history
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

    const openTotal = round2(openViews.reduce((sum, iv) => sum + iv.amount, 0));

    return {
      open: openViews,
      history: historyViews,
      summary: { openTotal, openCount: openViews.length },
      priorityOk: true,
    };
  } catch (err) {
    console.warn('[finance] getInvoices failed:', err);
    return { open: [], history: [], summary: { openTotal: 0, openCount: 0 }, priorityOk: false };
  }
}
