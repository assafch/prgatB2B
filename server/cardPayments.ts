// Card payments via a hosted payment page (UPay or Tranzila — switched by the
// card_provider setting / CARD_PROVIDER env). Pay the open balance (debt) by card.
// Amount is fixed SERVER-SIDE from Priority (the client never supplies it).
// Provider callbacks are NEVER trusted — payment is confirmed only by re-querying
// the provider's transactions API and cross-checking ref + amount. No money posts
// to Priority (the office reconciles, same as cheques).

import crypto from 'node:crypto';
import { db, getSetting } from './db.js';
import { getAccountSummary, getUnpaidInvoices, bustFinanceCache } from './finance.js';
import { createPaymentPage, getTransaction, upayEnabled } from './upay.js';
import * as tranzila from './tranzila.js';
import * as payplus from './payplus.js';

export interface CardRow {
  id: string;
  user_id: number;
  custname: string;
  kind: string;
  amount: number;
  status: string;
  upay_cashier_id: string | null;
  tranzila_index: string | null;
  payplus_ref: string | null;
  paid_items: string | null; // JSON array of selected invoice IVNUMs (null = whole balance)
  order_id: string | null;
  psp: string;
  confirmation_code: string | null;
  four_digits: string | null;
  provider: string | null;
  created_at: string;
  paid_at: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// PayPlus requires a customer email — Priority record first, then the office fallback.
const payerEmail = (summary: { profile: { email: string | null } | null }): string =>
  summary.profile?.email || process.env.PAYPLUS_FALLBACK_EMAIL || '';

/** Which PSP handles new intents. Admin setting wins, then env, then whichever
 *  provider is configured (Tranzila preferred when both are). */
export function activeCardProvider(): 'upay' | 'tranzila' | 'payplus' | null {
  const pref = (getSetting('card_provider') || process.env.CARD_PROVIDER || '').toLowerCase();
  if (pref === 'payplus' && payplus.payPlusEnabled()) return 'payplus';
  if (pref === 'tranzila' && tranzila.tranzilaEnabled()) return 'tranzila';
  if (pref === 'upay' && upayEnabled()) return 'upay';
  if (tranzila.tranzilaEnabled()) return 'tranzila';
  if (upayEnabled()) return 'upay';
  if (payplus.payPlusEnabled()) return 'payplus';
  return null;
}

/** Shared: open the active PSP's hosted page for an intent and persist the row. The
 *  caller has already derived the authoritative amount + label (+ optional itemized
 *  lines). `kind` distinguishes a whole-invoice/balance pay ('debt') from a partial
 *  on-account pay ('debt_partial'). */
async function createPspIntent(opts: {
  id: string;
  userId: number;
  custname: string;
  kind: string;
  amount: number;
  label: string;
  items?: { name: string; amount: number }[];
  paidItemsJson: string | null;
  email: string;
  contact: string;
  phone: string | undefined;
  baseUrl: string;
}): Promise<{ id: string; url: string }> {
  const { id, baseUrl } = opts;
  const psp = activeCardProvider();
  if (!psp) throw new Error('תשלום בכרטיס אינו זמין כרגע');

  if (psp === 'payplus') {
    const created = await payplus.createPaymentPage({
      amount: opts.amount,
      ref: id,
      description: opts.label,
      items: opts.items,
      email: opts.email,
      contact: opts.contact,
      successUrl: `${baseUrl}/api/payments/payplus/return?id=${id}`,
      failUrl: `${baseUrl}/api/payments/payplus/return?id=${id}&fail=1`,
      cancelUrl: `${baseUrl}/api/payments/payplus/return?id=${id}&cancel=1`,
      notifyUrl: `${baseUrl}/api/payments/payplus/ipn?id=${id}`,
    });
    db.prepare(
      `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp, payplus_ref, paid_items)
       VALUES (?, ?, ?, ?, ?, 'pending', 'payplus', ?, ?)`
    ).run(id, opts.userId, opts.custname, opts.kind, opts.amount, created.pageRequestUid, opts.paidItemsJson);
    return { id, url: created.url };
  }

  if (psp === 'tranzila') {
    const created = await tranzila.createPaymentPage({
      amount: opts.amount,
      ref: id,
      description: opts.label,
      successUrl: `${baseUrl}/api/payments/tranzila/return?id=${id}`,
      failUrl: `${baseUrl}/api/payments/tranzila/return?id=${id}&fail=1`,
      notifyUrl: `${baseUrl}/api/payments/tranzila/ipn?id=${id}`,
      contact: opts.contact,
      phone: opts.phone,
    });
    db.prepare(
      `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp, paid_items)
       VALUES (?, ?, ?, ?, ?, 'pending', 'tranzila', ?)`
    ).run(id, opts.userId, opts.custname, opts.kind, opts.amount, opts.paidItemsJson);
    return { id, url: created.url };
  }

  const created = await createPaymentPage({
    amount: opts.amount,
    ref: id,
    description: opts.label,
    returnUrl: `${baseUrl}/#pay/card/return?id=${id}`,
    ipnUrl: `${baseUrl}/api/payments/upay/ipn?id=${id}`,
    phone: opts.phone,
  });
  db.prepare(
    `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, upay_cashier_id, psp, paid_items)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, 'upay', ?)`
  ).run(id, opts.userId, opts.custname, opts.kind, opts.amount, created.cashierId, opts.paidItemsJson);
  return { id, url: created.url };
}

/** Sum of recent DEBT card payments not yet known to be reconciled into Priority's
 *  ACC_DEBIT (pending, or paid within a short window). Subtracted from openTotal so a
 *  customer can't pay the same debt twice before the office posts the receipt. Bounded
 *  to RECON_WINDOW so an already-reconciled payment stops deflating the payable cap.
 *  Only counts debt kinds (not order_payment) so prepays don't wrongly deflate the cap. */
const RECON_WINDOW = '-3 days';
export function unreconciledCardTotal(custname: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM card_payments
       WHERE custname = ? AND status IN ('pending', 'paid')
         AND kind IN ('debt', 'debt_partial')
         AND created_at >= datetime('now', ?)`
    )
    .get(custname, RECON_WINDOW) as { s: number };
  return round2(row.s || 0);
}

/** Confirmed (paid) debt card payments in the recon window — used by the open-debt
 *  BLOCK offset (an unpaid 'pending' intent must NOT lift the block). */
export function paidDebtCardTotal(custname: string): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM card_payments WHERE custname = ? AND status = 'paid' AND kind IN ('debt','debt_partial') AND COALESCE(paid_at, created_at) >= datetime('now', '-3 days')"
  ).get(custname) as { s: number };
  return Math.round(((row.s || 0) + Number.EPSILON) * 100) / 100;
}

/** Create a hosted-page intent to pay the open debt — either a chosen set of invoices
 *  (selection.invoices) or, when none are given, the whole open balance. The amount is
 *  always re-derived SERVER-SIDE; the client never supplies amounts. */
export async function createCardDebtIntent(
  userId: number,
  custname: string,
  selection: { invoices?: string[] },
  phone: string | undefined,
  baseUrl: string
): Promise<{ id: string; url: string; amount: number }> {
  const summary = await getAccountSummary(custname);
  if (!summary.balanceOk) throw new Error('נתוני החוב אינם זמינים כרגע');
  const debt = round2(summary.balance.openTotal);
  if (debt <= 0) throw new Error('אין חוב פתוח לתשלום');

  // Resolve the selection server-side: the client sends only invoice numbers; we look up
  // each invoice's authoritative amount and sum them. No selection → whole open balance.
  const selectedNums = Array.isArray(selection.invoices) ? selection.invoices.filter((s) => typeof s === 'string') : [];
  let amount: number;
  let label: string;
  let paidItems: string[] = [];
  let payplusItems: { name: string; amount: number }[] | undefined;

  if (selectedNums.length) {
    const unpaid = await getUnpaidInvoices(custname).catch(() => []);
    const chosen = unpaid.filter((u) => selectedNums.includes(u.ivnum));
    if (!chosen.length) throw new Error('לא נבחרו חשבוניות לתשלום');
    amount = round2(chosen.reduce((sum, u) => sum + u.amount, 0));
    paidItems = chosen.map((u) => u.ivnum);
    payplusItems = chosen.map((u) => ({ name: `חשבונית מס׳ ${u.ivnum}`, amount: u.amount }));
    label = chosen.length === 1 ? `חשבונית מס׳ ${chosen[0].ivnum}` : `תשלום ${chosen.length} חשבוניות`;
  } else {
    amount = debt; // whole-balance fallback (e.g. customer with no itemized invoices)
    label = `תשלום חוב — ${custname}`;
  }
  if (amount <= 0) throw new Error('הסכום לתשלום אינו תקין');

  const id = crypto.randomBytes(12).toString('hex');
  const { url } = await createPspIntent({
    id,
    userId,
    custname,
    kind: 'debt',
    amount,
    label,
    items: payplusItems,
    paidItemsJson: paidItems.length ? JSON.stringify(paidItems) : null,
    email: payerEmail(summary),
    contact: custname,
    phone,
    baseUrl,
  });
  return { id, url, amount };
}

/** Partial / custom-amount card payment ("תשלום על חשבון"). This is the ONE place a
 *  client-supplied amount is accepted — validated SERVER-SIDE to 0 < amount <= payable,
 *  where payable = authoritative openTotal minus recent unreconciled card payments.
 *  Ticked invoices are persisted as an OFFICE HINT only: a partial sum can't settle
 *  whole invoices, so the office allocates the receipt in Priority. */
export async function createCardPartialIntent(
  userId: number,
  custname: string,
  requestedAmount: number,
  invoiceRefs: string[] | undefined,
  phone: string | undefined,
  baseUrl: string
): Promise<{ id: string; url: string; amount: number }> {
  const summary = await getAccountSummary(custname);
  if (!summary.balanceOk) throw new Error('נתוני החוב אינם זמינים כרגע');
  const openTotal = round2(summary.balance.openTotal);
  if (openTotal <= 0) throw new Error('אין חוב פתוח לתשלום');

  const payable = round2(Math.max(0, openTotal - unreconciledCardTotal(custname)));
  const amount = round2(Number(requestedAmount));
  if (!isFinite(amount) || amount <= 0) throw new Error('יש להזין סכום תקין');
  if (amount > payable + 0.001) {
    throw new Error(
      payable > 0 ? `הסכום חורג מהיתרה לתשלום (₪${payable.toFixed(2)})` : 'קיים תשלום בעיבוד — נסו שוב מאוחר יותר'
    );
  }

  const hint = Array.isArray(invoiceRefs) ? invoiceRefs.filter((s) => typeof s === 'string').slice(0, 200) : [];
  const id = crypto.randomBytes(12).toString('hex');
  const { url } = await createPspIntent({
    id,
    userId,
    custname,
    kind: 'debt_partial',
    amount,
    label: 'תשלום על חשבון',
    paidItemsJson: hint.length ? JSON.stringify(hint) : null,
    email: payerEmail(summary),
    contact: custname,
    phone,
    baseUrl,
  });
  return { id, url, amount };
}

/** Create a hosted-page intent to pay for a specific order. Amount comes from the
 *  order row (server-trusted); the client never supplies amounts. Only valid when
 *  the order is in `pending_payment` status. */
export async function createCardOrderIntent(
  userId: number,
  custname: string,
  orderId: number,
  phone: string | undefined,
  baseUrl: string
): Promise<{ id: string; url: string; amount: number }> {
  const order = db
    .prepare(
      `SELECT payment_required_amount, status, user_id FROM orders_local WHERE id = ? AND custname = ?`
    )
    .get(orderId, custname) as
    | { payment_required_amount: number | null; status: string; user_id: number }
    | undefined;
  if (!order || order.user_id !== userId) throw new Error('order not found');
  if (order.status !== 'pending_payment') throw new Error('order not awaiting payment');
  const amount = Number(order.payment_required_amount);
  if (!(amount > 0)) throw new Error('order amount unavailable');

  // M1: reject if already paid (duplicate tab / race)
  const paid = db.prepare("SELECT id FROM card_payments WHERE order_id = ? AND kind = 'order_payment' AND status = 'paid' LIMIT 1").get(String(orderId));
  if (paid) throw new Error('order already paid');
  // Expire any stale not-yet-paid intents so only the newest will be live
  db.prepare("UPDATE card_payments SET status='expired' WHERE order_id = ? AND kind='order_payment' AND status IN ('created','pending')").run(String(orderId));

  let email = '';
  try {
    const summary = await getAccountSummary(custname);
    email = payerEmail(summary);
  } catch {}

  const id = crypto.randomBytes(12).toString('hex');
  const { url } = await createPspIntent({
    id,
    userId,
    custname,
    kind: 'order_payment',
    amount,
    label: `תשלום הזמנה #${orderId}`,
    paidItemsJson: null,
    email,
    contact: custname,
    phone,
    baseUrl,
  });
  db.prepare('UPDATE card_payments SET order_id = ? WHERE id = ?').run(String(orderId), id);
  return { id, url, amount };
}

/** Store the transaction index hinted by Tranzila's notify/return callback.
 *  The hint is untrusted — it only tells confirmCard where to look. */
export function recordTranzilaIndex(id: string, index: string): void {
  if (!/^\d{1,12}$/.test(index)) return;
  db.prepare(`UPDATE card_payments SET tranzila_index = ? WHERE id = ? AND tranzila_index IS NULL AND psp = 'tranzila'`).run(index, id);
}

export function getCardForUser(userId: number, id: string): CardRow | null {
  return (db.prepare(`SELECT * FROM card_payments WHERE id = ? AND user_id = ?`).get(id, userId) as CardRow) ?? null;
}
function getCardAny(id: string): CardRow | null {
  return (db.prepare(`SELECT * FROM card_payments WHERE id = ?`).get(id) as CardRow) ?? null;
}

/** Shared success-path helper: if the paid card is linked to an order, approve it. */
async function returnPaidCard(id: string): Promise<CardRow | null> {
  const fresh = db
    .prepare('SELECT order_id, kind FROM card_payments WHERE id = ?')
    .get(id) as { order_id: string | null; kind: string } | undefined;
  if (fresh?.kind === 'order_payment' && fresh.order_id) {
    const { approveOrder } = await import('./orders.js'); // dynamic import avoids load-time circular dependency
    await approveOrder(Number(fresh.order_id), 'card', id);
  }
  return getCardAny(id);
}

/** Authoritative confirm via provider re-query (callback never trusted). Cross-
 *  checks the returned ref === our intent id and the amount before marking paid. */
export async function confirmCard(id: string): Promise<CardRow | null> {
  const row = getCardAny(id);
  if (!row) return null;
  if (row.status === 'paid') return row;

  if (row.psp === 'tranzila') {
    let tx;
    try {
      tx = await tranzila.findTransaction({ ref: id, index: row.tranzila_index, createdAt: row.created_at });
    } catch (err) {
      console.warn('[card] tranzila confirm query failed:', err instanceof Error ? err.message : err);
      return row;
    }
    if (!tx) return row;
    // findTransaction only returns records carrying our ref; still verify amount.
    const amountOk = tx.amount == null || Math.abs(tx.amount - row.amount) <= 0.01;
    if (tx.paid && tx.refFound && amountOk) {
      db.prepare(
        `UPDATE card_payments SET status = 'paid', confirmation_code = ?, four_digits = ?, provider = 'tranzila',
           tranzila_index = COALESCE(tranzila_index, ?), paid_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      ).run(tx.confirmationCode, tx.fourDigits, tx.index, id);
      bustFinanceCache(row.custname);
      return returnPaidCard(id);
    }
    return row;
  }

  if (row.psp === 'payplus') {
    let tx;
    try {
      // Query by more_info (our intent id) — the callback is never trusted; this
      // re-query against Transactions/View is the authoritative confirmation.
      tx = await payplus.findTransaction({ ref: id });
    } catch (err) {
      console.warn('[card] payplus confirm query failed:', err instanceof Error ? err.message : err);
      return row;
    }
    if (!tx) return row;
    const amountOk = tx.amount == null || Math.abs(tx.amount - row.amount) <= 0.01;
    if (tx.paid && tx.refFound && amountOk) {
      db.prepare(
        `UPDATE card_payments SET status = 'paid', confirmation_code = ?, four_digits = ?, provider = 'payplus',
           payplus_ref = COALESCE(?, payplus_ref), paid_at = datetime('now')
         WHERE id = ? AND status = 'pending'`
      ).run(tx.confirmationCode, tx.fourDigits, tx.transactionUid, id);
      bustFinanceCache(row.custname);
      return returnPaidCard(id);
    }
    return row;
  }

  if (!row.upay_cashier_id) return row;
  let tx;
  try {
    tx = await getTransaction(row.upay_cashier_id);
  } catch (err) {
    console.warn('[card] confirm query failed:', err instanceof Error ? err.message : err);
    return row;
  }
  // Cross-check: paid status + our ref + amount within 1 agora (provider may omit amount).
  const refOk = !tx.ref || tx.ref === id;
  const amountOk = tx.amount == null || Math.abs(tx.amount - row.amount) <= 0.01;
  if (tx.paid && refOk && amountOk) {
    db.prepare(
      `UPDATE card_payments SET status = 'paid', confirmation_code = ?, four_digits = ?, provider = ?, paid_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    ).run(tx.confirmationCode, tx.fourDigits, tx.provider, id);
    bustFinanceCache(row.custname);
    return returnPaidCard(id);
  }
  return row;
}

export function listAllCardPayments(): CardRow[] {
  return db
    .prepare(`SELECT * FROM card_payments WHERE status != 'created' ORDER BY created_at DESC LIMIT 500`)
    .all() as CardRow[];
}
