// Priority receipt (TINVOICES) creation. The customer flow is NEVER blocked by this:
// enqueue is fire-and-forget, creation runs only in the background sweep, failures are
// left for manual handling. Spec: 2026-06-30-priority-receipts.
import { db, getSetting } from './db.js';
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
