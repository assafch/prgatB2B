// Card payments via a hosted payment page (UPay or Tranzila — switched by the
// card_provider setting / CARD_PROVIDER env). Pay the open balance (debt) by card.
// Amount is fixed SERVER-SIDE from Priority (the client never supplies it).
// Provider callbacks are NEVER trusted — payment is confirmed only by re-querying
// the provider's transactions API and cross-checking ref + amount. No money posts
// to Priority (the office reconciles, same as cheques).

import crypto from 'node:crypto';
import { db, getSetting, getSettingBool, getSettingInt } from './db.js';
import { getAccountSummary, getUnpaidInvoices, bustFinanceCache } from './finance.js';
import { createPaymentPage, getTransaction, upayEnabled } from './upay.js';
import * as tranzila from './tranzila.js';
import * as payplus from './payplus.js';
import { tokenVaultReady, decryptToken } from './tokenVault.js';
import { upsertSavedCard, getSavedCardToken } from './savedCards.js';
// OrderError is imported dynamically inside chargeSavedCard — a static import here would
// create a load-time cycle (orders.js -> paymentPolicy.js -> cardPayments.js already).

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
  payments_count: number | null;
  save_card: number;
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

/** How many installments (תשלומים) to offer for this amount, or null for a single
 *  payment. Reads settings fresh on every call (no caching) so an admin toggle takes
 *  effect immediately: off unless `installments_enabled`, and only once the amount
 *  clears `installments_min_amount` (default ₪1000); the count is `installments_max`
 *  (default 4) clamped to PayPlus's supported [2,12] range. */
export function installmentsFor(amount: number): number | null {
  if (!getSettingBool('installments_enabled', false)) return null;
  const min = getSettingInt('installments_min_amount', 1000);
  if (!(amount >= min)) return null;
  const max = getSettingInt('installments_max', 4);
  return Math.min(12, Math.max(2, max));
}

/** Installments window (min amount + max count) for display purposes — independent of
 *  any specific cart/payable amount (unlike installmentsFor). Used by /api/home and the
 *  checkout preview so the client can show "up to N payments" before an amount is known
 *  to be eligible. Same settings/defaults/clamp as installmentsFor; null when the
 *  feature flag is off. */
export function installmentsRange(): { min: number; max: number } | null {
  if (!getSettingBool('installments_enabled', false)) return null;
  const min = getSettingInt('installments_min_amount', 1000);
  const max = getSettingInt('installments_max', 4);
  return { min, max: Math.min(12, Math.max(2, max)) };
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
  // Customer opted in (checkbox) to save the card used on this intent for later
  // one-tap reuse. Only takes effect on the PayPlus path, and only when the
  // saved_cards_enabled setting is on and the token vault has a key configured.
  saveCard?: boolean;
}): Promise<{ id: string; url: string }> {
  const { id, baseUrl } = opts;
  const psp = activeCardProvider();
  if (!psp) throw new Error('תשלום בכרטיס אינו זמין כרגע');

  if (psp === 'payplus') {
    const shouldSaveCard = !!opts.saveCard && getSettingBool('saved_cards_enabled', false) && tokenVaultReady();
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
      maxPayments: installmentsFor(opts.amount) ?? undefined,
      createToken: shouldSaveCard || undefined,
    });
    db.prepare(
      `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp, payplus_ref, paid_items, save_card)
       VALUES (?, ?, ?, ?, ?, 'pending', 'payplus', ?, ?, ?)`
    ).run(id, opts.userId, opts.custname, opts.kind, opts.amount, created.pageRequestUid, opts.paidItemsJson, shouldSaveCard ? 1 : 0);
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
// A hosted-page intent that was never completed only deflates the payable cap for
// this long. Beyond it the page link is long dead (PayPlus pages are created with a
// hard 30-min expiry) — without this bound one declined/abandoned attempt would zero
// the cap for the whole RECON_WINDOW and lock the customer out of card payment.
// Accepted residual: a 'failed' (declined) intent stops deflating the cap immediately
// so the customer can retry at once, but its page stays chargeable until the 30-min
// expiry — paying BOTH a fresh intent and the stale declined page in that window
// over-pays the debt. Both charges are recorded 'paid' (confirmCard pays from any
// non-paid status), so the office sees it at reconciliation and refunds via PayPlus.
const PENDING_INTENT_TTL = '-2 hours';
// Token (one-tap saved-card) charges settle almost immediately in practice — the
// customer copy on a still-pending charge promises resolution "בדקות הקרובות" (in
// the next few minutes). Sweeping them on the same 2-hour hosted-page TTL made that
// promise false and left an in-flight token row deflating the payable cap for hours.
// Hosted-page rows keep the 2-hour TTL (PayPlus pages are alive up to 30 min, plus
// slack for a slow customer/redirect).
const TOKEN_INTENT_TTL = '-5 minutes';
export function unreconciledCardTotal(custname: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM card_payments
       WHERE custname = ? AND kind IN ('debt', 'debt_partial')
         AND ((status = 'paid' AND created_at >= datetime('now', ?))
           OR (status = 'pending' AND created_at >= datetime('now', ?)))`
    )
    .get(custname, RECON_WINDOW, PENDING_INTENT_TTL) as { s: number };
  return round2(row.s || 0);
}

/** Sweep: resolve hosted-page intents that were never completed. Each stale row gets
 *  a final authoritative PSP re-query (confirmCard) FIRST — a charge whose IPN and
 *  return redirect were both lost (e.g. mid-deploy) must become 'paid', approve its
 *  order, and stay protected from the order sweeps. Only rows the PSP does not show
 *  as paid are marked 'expired'. */
export async function expireStaleCardIntents(): Promise<number> {
  const stale = db
    .prepare(
      `SELECT id FROM card_payments WHERE status = 'pending' AND (
         (COALESCE(charge_source,'') = 'token' AND created_at < datetime('now', ?))
         OR (COALESCE(charge_source,'') != 'token' AND created_at < datetime('now', ?))
       )`
    )
    .all(TOKEN_INTENT_TTL, PENDING_INTENT_TTL) as { id: string }[];
  let expired = 0;
  for (const row of stale) {
    try {
      // throwOnQueryFailure: expiring is only safe on an AUTHORITATIVE not-paid
      // answer. On a failed PSP query the row stays 'pending' and the next sweep
      // (10 min) retries — it no longer deflates the cap past the TTL anyway.
      const fresh = await confirmCard(row.id, { throwOnQueryFailure: true }); // pays + approves order if the PSP says paid
      if (fresh && fresh.status === 'paid') continue;
    } catch (err) {
      console.warn(`[card] expiry sweep: PSP query failed for ${row.id} — retrying next sweep:`, err instanceof Error ? err.message : err);
      continue;
    }
    const r = db.prepare(`UPDATE card_payments SET status = 'expired' WHERE id = ? AND status = 'pending'`).run(row.id);
    expired += r.changes;
  }
  if (expired > 0) console.log(`[card] expired ${expired} stale pending intent(s)`);
  return expired;
}

/** Confirmed (paid) debt card payments in the recon window — used by the open-debt
 *  BLOCK offset (an unpaid 'pending' intent must NOT lift the block). */
export function paidDebtCardTotal(custname: string): number {
  const row = db.prepare(
    "SELECT COALESCE(SUM(amount),0) AS s FROM card_payments WHERE custname = ? AND status = 'paid' AND kind IN ('debt','debt_partial') AND COALESCE(paid_at, created_at) >= datetime('now', '-3 days')"
  ).get(custname) as { s: number };
  return Math.round(((row.s || 0) + Number.EPSILON) * 100) / 100;
}

/** Shared derivation for the debt path (whole balance or a chosen set of invoices) —
 *  used by BOTH the hosted intent (createCardDebtIntent) and the one-tap token charge
 *  (chargeSavedCard). Throws the exact same errors as the pre-refactor inline logic;
 *  callers that need a payer email for the PSP page read it off `summary`. */
export async function deriveDebtCharge(
  custname: string,
  selection: { invoices?: string[] }
): Promise<{
  amount: number;
  label: string;
  paidItems: string[];
  payplusItems?: { name: string; amount: number }[];
  summary: Awaited<ReturnType<typeof getAccountSummary>>;
}> {
  const summary = await getAccountSummary(custname);
  if (!summary.balanceOk) throw new Error('נתוני החוב אינם זמינים כרגע');
  const debt = round2(summary.balance.openTotal);
  if (debt <= 0) throw new Error('אין חוב פתוח לתשלום');
  // Authoritative payable = open balance (ACC_DEBIT) minus card payments already in flight,
  // so we never charge past the real debt (on-account credit / partial payment) NOR double-pay
  // an unreconciled in-process payment. Matches the client display + the partial-pay path.
  const payableCap = round2(Math.max(0, debt - unreconciledCardTotal(custname)));

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
    const sumSelected = round2(chosen.reduce((sum, u) => sum + u.amount, 0));
    amount = round2(Math.min(sumSelected, payableCap)); // never charge more than the real open balance
    paidItems = chosen.map((u) => u.ivnum);
    // If capped below the itemized sum (on-account credit / partial payment exists), the
    // per-invoice breakdown won't reconcile to the charged total — drop the itemization and
    // use a generic label so PayPlus items always sum to the amount; keep paid_items as the office hint.
    if (amount < sumSelected - 0.01) {
      payplusItems = undefined;
      label = `תשלום חוב — ${custname}`;
    } else {
      payplusItems = chosen.map((u) => ({ name: `חשבונית מס׳ ${u.ivnum}`, amount: u.amount }));
      label = chosen.length === 1 ? `חשבונית מס׳ ${chosen[0].ivnum}` : `תשלום ${chosen.length} חשבוניות`;
    }
  } else {
    amount = payableCap; // whole-balance fallback (e.g. customer with no itemized invoices)
    label = `תשלום חוב — ${custname}`;
  }
  if (amount <= 0) throw new Error('הסכום לתשלום אינו תקין');
  return { amount, label, paidItems, payplusItems, summary };
}

/** Create a hosted-page intent to pay the open debt — either a chosen set of invoices
 *  (selection.invoices) or, when none are given, the whole open balance. The amount is
 *  always re-derived SERVER-SIDE; the client never supplies amounts. */
export async function createCardDebtIntent(
  userId: number,
  custname: string,
  selection: { invoices?: string[] },
  phone: string | undefined,
  baseUrl: string,
  saveCard?: boolean
): Promise<{ id: string; url: string; amount: number }> {
  const { amount, label, paidItems, payplusItems, summary } = await deriveDebtCharge(custname, selection);

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
    saveCard,
  });
  return { id, url, amount };
}

/** Shared derivation for the partial / custom-amount path — used by BOTH the hosted
 *  intent (createCardPartialIntent) and the one-tap token charge (chargeSavedCard).
 *  Validates 0 < amount <= payable, where payable = authoritative openTotal minus
 *  recent unreconciled card payments. Throws the exact same errors as before the
 *  refactor. */
export async function derivePartialCharge(
  custname: string,
  requestedAmount: number
): Promise<{ amount: number; summary: Awaited<ReturnType<typeof getAccountSummary>> }> {
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
  return { amount, summary };
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
  baseUrl: string,
  saveCard?: boolean
): Promise<{ id: string; url: string; amount: number }> {
  const { amount, summary } = await derivePartialCharge(custname, requestedAmount);

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
    saveCard,
  });
  return { id, url, amount };
}

/** Shared derivation for the order path — used by BOTH the hosted intent
 *  (createCardOrderIntent) and the one-tap token charge (chargeSavedCard). Enforces
 *  ownership (order belongs to this user AND custname), status (`pending_payment`
 *  only), a valid positive amount, and the same "already paid" duplicate-tab/race
 *  guard the hosted path always had. Throws the exact same errors as before the
 *  refactor. Synchronous — no PSP/Priority I/O, only local DB reads. */
export function deriveOrderCharge(userId: number, custname: string, orderId: number): { amount: number; label: string } {
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

  return { amount, label: `תשלום הזמנה #${orderId}` };
}

/** Create a hosted-page intent to pay for a specific order. Amount comes from the
 *  order row (server-trusted); the client never supplies amounts. Only valid when
 *  the order is in `pending_payment` status. */
export async function createCardOrderIntent(
  userId: number,
  custname: string,
  orderId: number,
  phone: string | undefined,
  baseUrl: string,
  saveCard?: boolean
): Promise<{ id: string; url: string; amount: number }> {
  const { amount, label } = deriveOrderCharge(userId, custname, orderId);

  // Expire any stale not-yet-paid intents so only the newest will be live. Token
  // charges are excluded: an unconfirmed one-tap charge may have already moved money
  // (chargeToken's own result is never trusted — see chargeSavedCard) and 'expired'
  // rows are never re-confirmed, so flipping it here would risk an invisible double
  // charge. It stays 'pending' until confirmCard settles it (paid/failed) or the
  // expiry sweep does, after re-confirming with the PSP.
  db.prepare("UPDATE card_payments SET status='expired' WHERE order_id = ? AND kind='order_payment' AND status IN ('created','pending') AND COALESCE(charge_source,'') != 'token'").run(String(orderId));

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
    label,
    paidItemsJson: null,
    email,
    contact: custname,
    phone,
    baseUrl,
    saveCard,
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
  try {
    const { enqueueReceipt } = await import('./priorityReceipts.js'); // dynamic import avoids load cycle
    const crow = db.prepare('SELECT custname FROM card_payments WHERE id = ?').get(id) as { custname: string } | undefined;
    if (crow) enqueueReceipt(id, crow.custname);
  } catch (err) {
    console.warn('[receipts] enqueue hook failed (non-blocking):', err);
  }
  return getCardAny(id);
}

/** Authoritative confirm via provider re-query (callback never trusted). Cross-
 *  checks the returned ref === our intent id and the amount before marking paid.
 *  opts.throwOnQueryFailure: rethrow PSP query errors instead of returning the row
 *  unchanged — callers that must DISTINGUISH "PSP says not paid" from "no answer"
 *  (the expiry sweep) need the difference; the request paths deliberately don't. */
export async function confirmCard(id: string, opts?: { throwOnQueryFailure?: boolean }): Promise<CardRow | null> {
  const row = getCardAny(id);
  if (!row) return null;
  if (row.status === 'paid') return row;

  if (row.psp === 'tranzila') {
    let tx;
    try {
      tx = await tranzila.findTransaction({ ref: id, index: row.tranzila_index, createdAt: row.created_at });
    } catch (err) {
      if (opts?.throwOnQueryFailure) throw err;
      console.warn('[card] tranzila confirm query failed:', err instanceof Error ? err.message : err);
      return row;
    }
    if (!tx) return row;
    // findTransaction only returns records carrying our ref; still verify amount.
    const amountOk = tx.amount == null || Math.abs(tx.amount - row.amount) <= 0.01;
    if (tx.paid && tx.refFound && amountOk) {
      // status != 'paid' (not just 'pending'): a charge completed after the intent
      // was marked failed/expired must still be recorded — money moved.
      db.prepare(
        `UPDATE card_payments SET status = 'paid', confirmation_code = ?, four_digits = ?, provider = 'tranzila',
           tranzila_index = COALESCE(tranzila_index, ?), paid_at = datetime('now')
         WHERE id = ? AND status != 'paid'`
      ).run(tx.confirmationCode, tx.fourDigits, tx.index, id);
      bustFinanceCache(row.custname);
      return returnPaidCard(id);
    }
    // An attempt carrying our ref exists and none of them is paid — a definitive
    // decline. Freeing the row stops it deflating the payable cap for 2 hours.
    if (tx.refFound && !tx.paid && row.status === 'pending') {
      db.prepare(`UPDATE card_payments SET status = 'failed' WHERE id = ? AND status = 'pending'`).run(id);
      return getCardAny(id);
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
      if (opts?.throwOnQueryFailure) throw err;
      console.warn('[card] payplus confirm query failed:', err instanceof Error ? err.message : err);
      return row;
    }
    if (!tx) return row;
    const amountOk = tx.amount == null || Math.abs(tx.amount - row.amount) <= 0.01;
    if (tx.paid && tx.refFound && amountOk) {
      // status != 'paid' (not just 'pending'): a charge completed after the intent
      // was marked failed/expired must still be recorded — money moved.
      db.prepare(
        `UPDATE card_payments SET status = 'paid', confirmation_code = ?, four_digits = ?, provider = 'payplus',
           payplus_ref = COALESCE(?, payplus_ref), payments_count = ?, paid_at = datetime('now')
         WHERE id = ? AND status != 'paid'`
      ).run(tx.confirmationCode, tx.fourDigits, tx.transactionUid, tx.paymentsCount, id);
      bustFinanceCache(row.custname);
      // Consent capture: only when the customer opted in on this intent AND the
      // charge actually produced a reusable token (create_token requires the PSP's
      // own eligibility — not guaranteed just because we asked).
      if (row.save_card && tx.tokenUid) {
        try {
          upsertSavedCard(row.user_id, row.custname, tx);
        } catch (err) {
          console.warn('[card] saved-card capture failed (non-blocking):', err instanceof Error ? err.message : err);
        }
      }
      return returnPaidCard(id);
    }
    // Attempts carrying our ref exist and none is paid (findTransaction prefers a
    // paid row when one exists) — a definitive decline. Freeing the row stops it
    // deflating the payable cap for 2 hours.
    if (tx.refFound && !tx.paid && row.status === 'pending') {
      db.prepare(`UPDATE card_payments SET status = 'failed' WHERE id = ? AND status = 'pending'`).run(id);
      return getCardAny(id);
    }
    return row;
  }

  if (!row.upay_cashier_id) return row;
  let tx;
  try {
    tx = await getTransaction(row.upay_cashier_id);
  } catch (err) {
    if (opts?.throwOnQueryFailure) throw err;
    console.warn('[card] confirm query failed:', err instanceof Error ? err.message : err);
    return row;
  }
  // Cross-check: paid status + our ref + amount within 1 agora (provider may omit amount).
  const refOk = !tx.ref || tx.ref === id;
  const amountOk = tx.amount == null || Math.abs(tx.amount - row.amount) <= 0.01;
  if (tx.paid && refOk && amountOk) {
    db.prepare(
      `UPDATE card_payments SET status = 'paid', confirmation_code = ?, four_digits = ?, provider = ?, paid_at = datetime('now')
       WHERE id = ? AND status != 'paid'`
    ).run(tx.confirmationCode, tx.fourDigits, tx.provider, id);
    bustFinanceCache(row.custname);
    return returnPaidCard(id);
  }
  return row;
}

// Single-process in-flight guard for one-tap saved-card charges: a double-tap must
// not fire two chargeToken calls before either row is paid. Sound only because the
// server runs as a single process (no cross-instance coordination) — paired below
// with a DB-level guard that also covers a very-recent request from just before a
// restart, which this in-memory set can't see.
const chargeLocks = new Set<number>();

export function listAllCardPayments(): CardRow[] {
  return db
    .prepare(`SELECT * FROM card_payments WHERE status != 'created' ORDER BY created_at DESC LIMIT 500`)
    .all() as CardRow[];
}

/** One-tap charge against the customer's saved PayPlus token — no hosted page, the
 *  customer isn't present. Exactly one of orderId/invoices/amount selects the mode;
 *  the amount is derived via the SAME shared helpers the hosted intents use (byte-
 *  identical validation/errors), so a customer never gets a different eligibility
 *  answer here than on the hosted page.
 *
 *  chargeToken's own result is NEVER trusted — win or throw, we always fall through to
 *  confirmCard's authoritative Transactions/View re-query, exactly like the hosted
 *  callback/return/IPN paths. Only that re-query flips the row to 'paid' and runs the
 *  existing receipts/approveOrder/payments_count side effects. */
export async function chargeSavedCard(
  userId: number,
  custname: string,
  mode: { orderId?: number; invoices?: string[]; amount?: number }
): Promise<{ id: string; status: string; amount: number }> {
  // Dynamic import: orders.js -> paymentPolicy.js -> cardPayments.js already forms a
  // load-time cycle; a static import of OrderError here would re-trigger it.
  const { OrderError } = await import('./orders.js');

  // In-flight guard (a): a double-tap must not fire two chargeToken calls before
  // either row is paid. See chargeLocks' definition above for why this is sound.
  if (chargeLocks.has(userId)) {
    throw new OrderError('תשלום קודם עדיין בעיבוד — המתינו רגע');
  }
  chargeLocks.add(userId);
  try {
    const card = getSavedCardToken(userId);
    if (!card) throw new OrderError('אין כרטיס שמור');
    const token = decryptToken(card.token);
    if (!token) throw new OrderError('כרטיס שמור אינו זמין כרגע'); // vault key missing/corrupt — no charge attempted

    // In-flight guard (b): a DB-level check for the same race, covering a gap the
    // in-memory lock above can't (e.g. a request from just before a process restart).
    const inFlight = db
      .prepare(
        `SELECT id FROM card_payments WHERE user_id = ? AND charge_source = 'token' AND status = 'pending'
           AND created_at >= datetime('now','-2 minutes') LIMIT 1`
      )
      .get(userId);
    if (inFlight) throw new OrderError('תשלום קודם עדיין בעיבוד — המתינו רגע');

    let amount: number;
    let kind: string;
    let orderId: number | undefined;
    let paidItemsJson: string | null = null;

    try {
      if (mode.orderId != null) {
        orderId = Number(mode.orderId);
        const derived = deriveOrderCharge(userId, custname, orderId);
        amount = derived.amount;
        kind = 'order_payment';
        // Expire any stale not-yet-paid intents for this order — same one-liner
        // createCardOrderIntent runs, so only the newest intent (this one) is live.
        // Token charges are excluded — see the matching comment in createCardOrderIntent.
        db.prepare(
          "UPDATE card_payments SET status='expired' WHERE order_id = ? AND kind='order_payment' AND status IN ('created','pending') AND COALESCE(charge_source,'') != 'token'"
        ).run(String(orderId));
      } else if (mode.invoices !== undefined) {
        const derived = await deriveDebtCharge(custname, { invoices: mode.invoices });
        amount = derived.amount;
        paidItemsJson = derived.paidItems.length ? JSON.stringify(derived.paidItems) : null;
        kind = 'debt';
      } else if (mode.amount != null) {
        const derived = await derivePartialCharge(custname, mode.amount);
        amount = derived.amount;
        kind = 'debt_partial';
      } else {
        throw new OrderError('בקשת תשלום שגויה');
      }
    } catch (err) {
      // The derivation helpers throw plain Error (same as the hosted creators) — surface
      // the same customer-safe message here via OrderError so the route can 402 it.
      if (err instanceof OrderError) throw err;
      throw new OrderError(err instanceof Error ? err.message : 'שגיאה בבדיקת סכום התשלום');
    }

    const id = crypto.randomBytes(12).toString('hex');
    db.prepare(
      `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp, paid_items, save_card, charge_source, order_id)
       VALUES (?, ?, ?, ?, ?, 'pending', 'payplus', ?, 0, 'token', ?)`
    ).run(id, userId, custname, kind, amount, paidItemsJson, orderId != null ? String(orderId) : null);

    try {
      await payplus.chargeToken({
        token,
        amount,
        ref: id,
        customerName: custname,
        // No installments here on purpose: one-tap is a single charge — the customer
        // never chose a split, and the payments sub-shape hasn't been verified against
        // staging for the token-charge path. Installments stay available on the hosted
        // page; revisit once staging-verified and there's explicit UX to choose a split.
      });
    } catch (err) {
      // chargeToken's own throw/result is NOT authoritative — it can throw AFTER PayPlus
      // already processed the charge (e.g. a timeout reading the response), so we must
      // NOT mark this row failed here. Swallow it and let the confirmCard re-query below
      // decide; if it can't get an authoritative answer either, the row stays 'pending'
      // for the expiry sweep to settle later (see the fallthrough below).
      console.warn('[card] chargeToken threw for saved-card charge', id, err instanceof Error ? err.message : err);
    }

    const confirmed = await confirmCard(id);

    if (confirmed && confirmed.status === 'paid') {
      db.prepare(`UPDATE saved_cards SET last_used_at = datetime('now') WHERE user_id = ?`).run(userId);
      return { id, status: 'paid', amount: confirmed.amount };
    }

    if (confirmed && confirmed.status === 'failed') {
      // confirmCard's own authoritative decline (refFound && !paid) already set this —
      // do not stomp it again here.
      throw new OrderError('החיוב נדחה — נסו בעמוד התשלום');
    }

    // Still 'pending': no authoritative answer yet (chargeToken threw, or the PSP
    // query itself failed / found nothing). Do NOT mark this row 'failed' — money may
    // still have moved. Leave it pending: the existing expiry sweep re-confirms it and
    // settles it (pays + approves the order if the charge did go through). Telling the
    // customer to retry here, on top of a charge that may already have succeeded, is
    // exactly the double-charge this guard exists to prevent.
    throw new OrderError('התשלום בעיבוד — נעדכן בדקות הקרובות, אל תחייבו שוב');
  } finally {
    chargeLocks.delete(userId);
  }
}
