// Card payments via UPay hosted page. Pay the open balance (debt) by card.
// Amount is fixed SERVER-SIDE from Priority (the client never supplies it).
// The UPay callback is NEVER trusted — payment is confirmed only by re-querying
// GETTRANSACTIONS and cross-checking ref + amount. No money posts to Priority
// (the office reconciles, same as cheques).

import crypto from 'node:crypto';
import { db } from './db.js';
import { getAccountSummary, bustFinanceCache } from './finance.js';
import { createPaymentPage, getTransaction } from './upay.js';

export interface CardRow {
  id: string;
  user_id: number;
  custname: string;
  kind: string;
  amount: number;
  status: string;
  upay_cashier_id: string | null;
  confirmation_code: string | null;
  four_digits: string | null;
  provider: string | null;
  created_at: string;
  paid_at: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

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
  const created = await createPaymentPage({
    amount,
    ref: id,
    description: `תשלום חוב — ${custname}`,
    returnUrl: `${baseUrl}/#pay/card/return?id=${id}`,
    ipnUrl: `${baseUrl}/api/payments/upay/ipn?id=${id}`,
    phone,
  });
  db.prepare(
    `INSERT INTO card_payments (id, user_id, custname, kind, amount, status, upay_cashier_id)
     VALUES (?, ?, ?, 'debt', ?, 'pending', ?)`
  ).run(id, userId, custname, amount, created.cashierId);
  return { id, url: created.url, amount };
}

export function getCardForUser(userId: number, id: string): CardRow | null {
  return (db.prepare(`SELECT * FROM card_payments WHERE id = ? AND user_id = ?`).get(id, userId) as CardRow) ?? null;
}
function getCardAny(id: string): CardRow | null {
  return (db.prepare(`SELECT * FROM card_payments WHERE id = ?`).get(id) as CardRow) ?? null;
}

/** Authoritative confirm via UPay re-query (callback never trusted). Cross-checks
 *  the returned ref === our intent id and the amount before marking paid. */
export async function confirmCard(id: string): Promise<CardRow | null> {
  const row = getCardAny(id);
  if (!row) return null;
  if (row.status === 'paid' || !row.upay_cashier_id) return row;
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
