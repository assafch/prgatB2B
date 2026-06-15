// Card payments via a hosted payment page (UPay or Tranzila — switched by the
// card_provider setting / CARD_PROVIDER env). Pay the open balance (debt) by card.
// Amount is fixed SERVER-SIDE from Priority (the client never supplies it).
// Provider callbacks are NEVER trusted — payment is confirmed only by re-querying
// the provider's transactions API and cross-checking ref + amount. No money posts
// to Priority (the office reconciles, same as cheques).

import crypto from 'node:crypto';
import { db, getSetting } from './db.js';
import { getAccountSummary, bustFinanceCache } from './finance.js';
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
  psp: string;
  confirmation_code: string | null;
  four_digits: string | null;
  provider: string | null;
  created_at: string;
  paid_at: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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

/** Create a hosted-page intent to pay the open balance. Returns the UPay URL. */
export async function createCardDebtIntent(
  userId: number,
  custname: string,
  requestedAmount: number | undefined,
  phone: string | undefined,
  baseUrl: string
): Promise<{ id: string; url: string; amount: number }> {
  const summary = await getAccountSummary(custname);
  if (!summary.balanceOk) throw new Error('נתוני החוב אינם זמינים כרגע');
  const debt = round2(summary.balance.openTotal);
  if (debt <= 0) throw new Error('אין חוב פתוח לתשלום');
  let amount = typeof requestedAmount === 'number' && isFinite(requestedAmount) && requestedAmount > 0 ? round2(requestedAmount) : debt;
  if (amount > debt) amount = debt; // never charge more than owed

  const id = crypto.randomBytes(12).toString('hex');
  const psp = activeCardProvider();
  if (!psp) throw new Error('תשלום בכרטיס אינו זמין כרגע');

  if (psp === 'payplus') {
    // PayPlus requires a customer email — use the Priority customer record (already
    // loaded above), falling back to a configured office address.
    const email = summary.profile?.email || process.env.PAYPLUS_FALLBACK_EMAIL || '';
    const created = await payplus.createPaymentPage({
      amount,
      ref: id,
      description: `תשלום חוב — ${custname}`,
      email,
      contact: custname,
      successUrl: `${baseUrl}/api/payments/payplus/return?id=${id}`,
      failUrl: `${baseUrl}/api/payments/payplus/return?id=${id}&fail=1`,
      cancelUrl: `${baseUrl}/api/payments/payplus/return?id=${id}&cancel=1`,
      notifyUrl: `${baseUrl}/api/payments/payplus/ipn?id=${id}`,
    });
    db.prepare(
      `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp, payplus_ref)
       VALUES (?, ?, ?, 'debt', ?, 'pending', 'payplus', ?)`
    ).run(id, userId, custname, amount, created.pageRequestUid);
    return { id, url: created.url, amount };
  }

  if (psp === 'tranzila') {
    const created = await tranzila.createPaymentPage({
      amount,
      ref: id,
      description: `תשלום חוב — ${custname}`,
      successUrl: `${baseUrl}/api/payments/tranzila/return?id=${id}`,
      failUrl: `${baseUrl}/api/payments/tranzila/return?id=${id}&fail=1`,
      notifyUrl: `${baseUrl}/api/payments/tranzila/ipn?id=${id}`,
      contact: custname,
      phone,
    });
    db.prepare(
      `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, psp)
       VALUES (?, ?, ?, 'debt', ?, 'pending', 'tranzila')`
    ).run(id, userId, custname, amount);
    return { id, url: created.url, amount };
  }

  const created = await createPaymentPage({
    amount,
    ref: id,
    description: `תשלום חוב — ${custname}`,
    returnUrl: `${baseUrl}/#pay/card/return?id=${id}`,
    ipnUrl: `${baseUrl}/api/payments/upay/ipn?id=${id}`,
    phone,
  });
  db.prepare(
    `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, upay_cashier_id, psp)
     VALUES (?, ?, ?, 'debt', ?, 'pending', ?, 'upay')`
  ).run(id, userId, custname, amount, created.cashierId);
  return { id, url: created.url, amount };
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
      return getCardAny(id);
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
    return getCardAny(id);
  }
  return row;
}

export function listAllCardPayments(): CardRow[] {
  return db
    .prepare(`SELECT * FROM card_payments WHERE status != 'created' ORDER BY created_at DESC LIMIT 500`)
    .all() as CardRow[];
}
