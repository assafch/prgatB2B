// Priority receipt (TINVOICES) creation. The customer flow is NEVER blocked by this:
// enqueue is fire-and-forget, creation runs only in the background sweep, failures are
// left for manual handling. Spec: 2026-06-30-priority-receipts.
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
