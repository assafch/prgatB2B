// Priority receipt (TINVOICES) creation. The customer flow is NEVER blocked by this:
// enqueue is fire-and-forget, creation runs only in the background sweep, failures are
// left for manual handling. Spec: 2026-06-30-priority-receipts.
import { db, getSetting, getSettingBool } from './db.js';
import { getPriorityConfig, priorityRequest } from './priority.js';

export interface ReceiptConfig {
  cashname: string; ownerlogin: string; ccPaymentcode: string; terminal: string | null;
}
export interface ReceiptInput {
  cardPaymentId: string; custname: string; amount: number;
  cardLast4: string | null; confNum: string | null; ivdate: string;
  ordname: string | null;
  invoiceRefs: string[] | null;
}

/** PURE: build the TINVOICES body. No DB/network. Amount is the exact VAT-inclusive
 *  PSP charge — never re-apply VAT. */
export function buildReceiptBody(inp: ReceiptInput, cfg: ReceiptConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ACCNAME: inp.custname,
    CUSTNAME: inp.custname,
    CASHNAME: cfg.cashname,
    IVDATE: inp.ivdate,
    STATDES: 'סופית',
    FINAL: 'Y',
    OWNERLOGIN: cfg.ownerlogin,
    CODE: 'ש"ח',
    FNCPATNAME: 'ק',
    TOTPRICE: inp.amount,
    DETAILS: inp.cardPaymentId.slice(0, 24),
    TPAYMENT2_SUBFORM: [
      {
        PAYMENTCODE: cfg.ccPaymentcode,
        QPRICE: inp.amount,
        FIRSTPAY: inp.amount,
        TOTPRICE: inp.amount,
        CASHNAME: cfg.cashname,
        ...(inp.cardLast4 ? { CARDNUM: inp.cardLast4 } : {}),
        ...(inp.confNum ? { CONFNUM: inp.confNum } : {}),
        ...(cfg.terminal ? { SHVA_TERMINALNAME: cfg.terminal } : {}),
      },
    ],
  };
  if (inp.ordname) body.ORDNAME = inp.ordname;
  if (inp.invoiceRefs && inp.invoiceRefs.length) body.REFERENCE = inp.invoiceRefs.join(',').slice(0, 25);
  return body;
}

/** Is the receipt pipeline active for this customer? Off by default; an optional single
 *  test-customer allowlist lets it be enabled for one custname first. */
export function receiptsEnabledFor(custname: string): boolean {
  if (!getSettingBool('priority_receipts_enabled', false)) return false;
  const only = getSetting('priority_receipts_test_custname');
  return !only || only.trim() === custname;
}

/** Fire-and-forget, NON-THROWING: enqueue a receipt for a paid card. Any failure here is
 *  logged and swallowed — it must never propagate into the customer flow. */
export function enqueueReceipt(cardPaymentId: string, custname: string): void {
  try {
    if (!receiptsEnabledFor(custname)) return;
    db.prepare(
      "INSERT INTO priority_receipts (card_payment_id, status) VALUES (?, 'pending') ON CONFLICT(card_payment_id) DO NOTHING"
    ).run(cardPaymentId);
  } catch (err) {
    console.warn('[receipts] enqueue failed (non-blocking):', err);
  }
}

function receiptConfig(): ReceiptConfig {
  return {
    cashname: getSetting('priority_receipt_cashname') || '',
    ownerlogin: getSetting('priority_receipt_ownerlogin') || '',
    ccPaymentcode: getSetting('priority_receipt_cc_paymentcode') || '13',
    terminal: getSetting('priority_receipt_terminal') || null,
  };
}

/** Create (or adopt, if already created) the Priority receipt for a paid card payment.
 *  Throws on failure — the caller (sweep) records 'failed' + retries; it is NEVER called
 *  inside a customer request. */
export async function createReceipt(cardPaymentId: string): Promise<string> {
  const cfg = receiptConfig();
  if (!cfg.cashname || !cfg.ownerlogin) throw new Error('receipt config missing (cashname/ownerlogin)');
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');
  const cp = db
    .prepare(
      "SELECT custname, amount, kind, paid_items, order_id, four_digits, confirmation_code FROM card_payments WHERE id = ? AND status = 'paid'"
    )
    .get(cardPaymentId) as
    | {
        custname: string;
        amount: number;
        kind: string;
        paid_items: string | null;
        order_id: string | null;
        four_digits: string | null;
        confirmation_code: string | null;
      }
    | undefined;
  if (!cp) throw new Error('paid card payment not found: ' + cardPaymentId);

  // Idempotency: receipt with our DETAILS ref already exists? adopt it.
  // DETAILS is stored as cardPaymentId.slice(0, 24); hex IDs are exactly 24 chars so no truncation.
  const safeId = cardPaymentId.slice(0, 24).replace(/'/g, "''");
  const existing = await priorityRequest(
    config,
    `TINVOICES?$filter=DETAILS eq '${safeId}'&$select=IVNUM&$top=1`
  );
  const found = (existing.value as Array<{ IVNUM: string }> | undefined)?.[0];
  if (found?.IVNUM) return found.IVNUM;

  let ordname: string | null = null;
  let invoiceRefs: string[] | null = null;
  if (cp.kind === 'order_payment' && cp.order_id) {
    const o = db
      .prepare('SELECT priority_ordname FROM orders_local WHERE id = ?')
      .get(Number(cp.order_id)) as { priority_ordname: string | null } | undefined;
    ordname = o?.priority_ordname ?? null;
  } else if (cp.paid_items) {
    try {
      const arr = JSON.parse(cp.paid_items);
      if (Array.isArray(arr) && arr.length) invoiceRefs = arr.map(String);
    } catch {
      /* ignore */
    }
  }

  const body = buildReceiptBody(
    {
      cardPaymentId,
      custname: cp.custname,
      amount: cp.amount,
      cardLast4: cp.four_digits,
      confNum: cp.confirmation_code,
      ivdate: new Date().toISOString().slice(0, 10),
      ordname,
      invoiceRefs,
    },
    cfg
  );
  const res = await priorityRequest(config, 'TINVOICES', 'POST', body);
  const ivnum = (res.IVNUM as string) || '';
  if (!ivnum) throw new Error('receipt POST returned no IVNUM');
  return ivnum;
}

// Serialize sweeps within this single Node process: both the 5-min timer and the admin
// retry route call this same function. Without a guard two invocations can overlap (a
// 25-row batch with ~30s/row Priority calls outlives the 5-min interval, or an admin
// double-click) and each would POST a *second* TINVOICES receipt for the same payment.
let sweepInFlight = false;

/** Background worker: create receipts for pending/failed rows. Never runs in a request. */
export async function sweepPendingReceipts(): Promise<void> {
  if (!getSettingBool('priority_receipts_enabled', false)) return;
  if (sweepInFlight) return; // a sweep is already running in this process — no-op
  sweepInFlight = true;
  try {
    // Selectable = pending/failed, plus any 'processing' row orphaned by a crash mid-sweep
    // (stale updated_at) so a paid receipt never gets stuck invisibly. The 15-min staleness
    // window far exceeds a single row's real processing time, so an actively-processing row
    // is never reclaimed — even by a hypothetical concurrent sweep.
    const SELECTABLE =
      "(status IN ('pending','failed') OR (status='processing' AND updated_at < datetime('now','-15 minutes'))) AND attempts < 20";
    const rows = db.prepare(
      `SELECT card_payment_id FROM priority_receipts WHERE ${SELECTABLE} ORDER BY created_at LIMIT 25`
    ).all() as { card_payment_id: string }[];
    for (const r of rows) {
      // Atomically claim the row before the async work: flip it to 'processing' (and bump
      // attempts) in one conditional UPDATE. If another logical pass already claimed it,
      // .changes is 0 and we skip — so no two passes can POST a receipt for the same row.
      const claimed = db.prepare(
        `UPDATE priority_receipts SET status='processing', attempts=attempts+1, updated_at=datetime('now') WHERE card_payment_id=? AND ${SELECTABLE}`
      ).run(r.card_payment_id);
      if (claimed.changes !== 1) continue;
      try {
        const ivnum = await createReceipt(r.card_payment_id);
        db.prepare("UPDATE priority_receipts SET status='created', receipt_ivnum=?, error=NULL, updated_at=datetime('now') WHERE card_payment_id=?").run(ivnum, r.card_payment_id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // attempts was already bumped at claim; restore to the retryable 'failed' status so
        // the attempts<20 give-up budget and the admin retry (failed→attempts=0) both apply.
        db.prepare("UPDATE priority_receipts SET status='failed', error=?, updated_at=datetime('now') WHERE card_payment_id=?").run(msg, r.card_payment_id);
        console.warn('[receipts] create failed (left for manual handling):', r.card_payment_id, msg);
      }
    }
  } finally {
    sweepInFlight = false;
  }
}

/** Admin recovery queue: receipts that have not been created. */
export function listFailedReceipts(): Array<Record<string, unknown>> {
  return db.prepare(
    "SELECT card_payment_id, status, error, attempts, created_at FROM priority_receipts WHERE status='failed' ORDER BY created_at DESC LIMIT 100"
  ).all() as Array<Record<string, unknown>>;
}
export function failedReceiptCount(): number {
  return (db.prepare("SELECT COUNT(*) n FROM priority_receipts WHERE status='failed'").get() as { n: number }).n;
}
