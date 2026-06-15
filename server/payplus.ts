// PayPlus client (card payments via the PayPlus hosted payment page — no card data
// touches our server, PCI SAQ-A). Protocol from docs.payplus.co.il REST API v1.0:
//   - Create page:   POST {base}/PaymentPages/generateLink  (api-key/secret-key headers)
//   - Status query:  POST {base}/Transactions/View          (api-key/secret-key headers)
//   - Webhook (IPN): PayPlus POSTs the result to refURL_callback, signed with a
//                    base64 HMAC-SHA256 'hash' header over the raw body + User-Agent: PayPlus
// The success/callback is NEVER trusted — payment is confirmed only by re-querying
// /Transactions/View and cross-checking status_code '000' + our ref (more_info) + amount.
// Amount is in SHEKELS (major units), never agorot. charge_method 1 = J4 (real capture).

import crypto from 'node:crypto';

function cfg() {
  const env = (process.env.PAYPLUS_ENV || 'prod').toLowerCase();
  const base =
    env === 'staging' || env === 'dev' || env === 'test'
      ? 'https://restapidev.payplus.co.il/api/v1.0'
      : 'https://restapi.payplus.co.il/api/v1.0';
  return {
    base,
    apiKey: process.env.PAYPLUS_API_KEY || '',
    secret: process.env.PAYPLUS_SECRET_KEY || '',
    pageUid: process.env.PAYPLUS_PAGE_UID || '',
    cashierUid: process.env.PAYPLUS_CASHIER_UID || '',
    terminalUid: process.env.PAYPLUS_TERMINAL_UID || '',
  };
}

export function payPlusEnabled(): boolean {
  const c = cfg();
  return !!c.apiKey && !!c.secret && !!c.pageUid;
}

// Server-side auth for restapi.payplus.co.il: two discrete headers (NOT an
// Authorization header — that's the legacy API). The secret-key must never leave
// the server; it doubles as the HMAC key for webhook verification.
function apiHeaders(): Record<string, string> {
  const c = cfg();
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'api-key': c.apiKey,
    'secret-key': c.secret,
  };
}

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return undefined;
}

/** Create the hosted payment page. amount in shekels. ref is our intent id — sent as
 *  more_info (echoed back in the callback and queryable) and cross-checked on confirm.
 *  The returned page link is opened in the customer's browser. */
export async function createPaymentPage(input: {
  amount: number;
  ref: string;
  description: string;
  email?: string;
  contact?: string;
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  notifyUrl: string;
}): Promise<{ url: string; pageRequestUid: string | null }> {
  const c = cfg();
  const body: Record<string, unknown> = {
    payment_page_uid: c.pageUid,
    charge_method: 1, // J4 — real capture (not a J5 hold)
    amount: Number(input.amount.toFixed(2)), // SHEKELS, never agorot
    currency_code: 'ILS',
    more_info: input.ref, // our 24-hex intent id — echoed back, cross-checked on confirm
    sendEmailApproval: false,
    sendEmailFailure: false,
    send_failure_callback: true, // also fire the IPN on declines
    refURL_success: input.successUrl,
    refURL_failure: input.failUrl,
    refURL_cancel: input.cancelUrl,
    refURL_callback: input.notifyUrl, // server-to-server IPN
    customer: { customer_name: input.contact || input.ref, email: input.email || '' },
  };
  if (c.cashierUid) body.cashier_uid = c.cashierUid;

  const res = await fetch(`${c.base}/PaymentPages/generateLink`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: { results?: { status?: string; description?: string }; data?: { payment_page_link?: string; page_request_uid?: string } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`payplus generateLink: non-JSON response (${res.status})`);
  }
  const link = json?.data?.payment_page_link;
  if (!res.ok || json?.results?.status !== 'success' || !link) {
    throw new Error(`payplus generateLink failed (${res.status}): ${json?.results?.description || text.slice(0, 200)}`);
  }
  return { url: link, pageRequestUid: json?.data?.page_request_uid ?? null };
}

export interface PayPlusTx {
  paid: boolean;
  statusCode: string | null; // '000' = approved
  transactionUid: string | null;
  amount: number | null;
  fourDigits: string | null;
  confirmationCode: string | null; // approval_num
  refFound: boolean; // our ref appears in the transaction record (more_info)
  raw: unknown;
}

function parseTx(tx: unknown, ref: string): PayPlusTx {
  const code = pick<string | number>(tx, 'status_code');
  const codeStr = code != null ? String(code) : null;
  const amountRaw = pick<string | number>(tx, 'amount');
  const amount = amountRaw != null && isFinite(Number(amountRaw)) ? Number(amountRaw) : null;
  const cardInfo = pick<Record<string, unknown>>(tx, 'card_information');
  return {
    paid: codeStr === '000',
    statusCode: codeStr,
    transactionUid: (() => {
      const u = pick<string>(tx, 'transaction_uid', 'uid');
      return u != null ? String(u) : null;
    })(),
    amount,
    fourDigits: (() => {
      const d = pick<string | number>(tx, 'four_digits') ?? pick<string | number>(cardInfo, 'four_digits');
      return d != null ? String(d) : null;
    })(),
    confirmationCode: (() => {
      const a = pick<string | number>(tx, 'approval_num', 'approval_number', 'voucher_num');
      return a != null ? String(a) : null;
    })(),
    // ref is a 24-hex random id — a substring match over the record is unambiguous.
    refFound: JSON.stringify(tx).includes(ref),
    raw: tx,
  };
}

/** Authoritative status lookup. The transaction must carry our ref (random 24-hex,
 *  sent as more_info) — the callback is never trusted on its own. Queries by the
 *  hinted transaction_uid when known, else by more_info. */
export async function findTransaction(opts: { ref: string; transactionUid?: string | null }): Promise<PayPlusTx | null> {
  const c = cfg();
  const body = opts.transactionUid ? { transaction_uid: opts.transactionUid } : { more_info: opts.ref };
  const res = await fetch(`${c.base}/Transactions/View`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`payplus Transactions/View failed (${res.status}): ${text.slice(0, 200)}`);
  let json: { data?: unknown };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('payplus Transactions/View: non-JSON response');
  }
  const rows: unknown[] = Array.isArray(json?.data) ? json.data : json?.data ? [json.data] : [];
  if (!rows.length) return null;
  const parsed = rows.map((t) => parseTx(t, opts.ref));
  // Prefer a paid row carrying our ref (multiple attempts may share more_info);
  // then any row with our ref; finally the first (uid-queried) row.
  return parsed.find((t) => t.refFound && t.paid) ?? parsed.find((t) => t.refFound) ?? parsed[0] ?? null;
}

/** Verify an inbound webhook is genuinely from PayPlus: User-Agent must be 'PayPlus'
 *  AND the 'hash' header must equal base64(HMAC-SHA256(secret_key, raw body bytes)).
 *  Hash the EXACT bytes received — re-serializing would change the digest. */
export function verifyWebhook(rawBody: Buffer | string | undefined, hashHeader: string | undefined, userAgent: string | undefined): boolean {
  if (userAgent !== 'PayPlus' || !hashHeader) return false;
  const c = cfg();
  if (!c.secret) return false;
  const gen = crypto.createHmac('sha256', c.secret).update(rawBody ?? '').digest('base64');
  const a = Buffer.from(gen);
  const b = Buffer.from(hashHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
