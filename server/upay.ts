// UPay API6 client (card payments via the UPay-hosted page — no card data touches
// our server, PCI SAQ-A). Protocol confirmed against the live merchant account:
// POST form-encoded `msgs` = JSON array of envelopes; the FIRST envelope is always
// CONNECTION/LOGIN ({email, key}); subsequent results line up by index. Auth field
// is `key` (not password); `livesystem:1` is live (the only mode these creds work
// in — no sandbox). The hosted page is opened in the browser; we NEVER trust the
// callback — payment is confirmed only by re-querying GETTRANSACTIONS.

const UPAY_URL = 'https://app.upay.co.il/API6/clientsecure/json.php';

interface Envelope {
  header: { refername: 'UPAY'; livesystem: 0 | 1; language: 'HE' };
  request: { mainaction: string; minoraction: string; encoding: 'json'; parameters: Record<string, unknown> };
}

function cfg() {
  return {
    email: process.env.UPAY_EMAIL || '',
    key: process.env.UPAY_KEY || '',
    live: (process.env.UPAY_LIVE ?? '1') === '1' ? (1 as const) : (0 as const),
  };
}

export function upayEnabled(): boolean {
  const c = cfg();
  return !!c.email && !!c.key;
}

function env(mainaction: string, minoraction: string, parameters: Record<string, unknown>): Envelope {
  const c = cfg();
  return { header: { refername: 'UPAY', livesystem: c.live, language: 'HE' }, request: { mainaction, minoraction, encoding: 'json', parameters } };
}

// Every batch leads with LOGIN; results[i+1] corresponds to actions[i].
async function batch(actions: Envelope[]): Promise<unknown[]> {
  const c = cfg();
  const msgs = JSON.stringify([env('CONNECTION', 'LOGIN', { email: c.email, key: c.key }), ...actions]);
  const res = await fetch(UPAY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ msgs }),
  });
  const text = await res.text();
  let json: { results?: unknown[] };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`UPay non-JSON response (${res.status})`);
  }
  const results = (json.results || []) as Array<{ header?: { errorcode?: string; errormessage?: string } }>;
  const login = results[0];
  if (login?.header?.errormessage && login.header.errormessage !== 'LOGIN_OK' && login.header.errorcode !== '20001000') {
    throw new Error(`UPay login failed: ${login.header.errormessage}`);
  }
  return results;
}

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}

export interface CreatedPayment {
  url: string;
  cashierId: string | null;
  raw: unknown;
}

/** Create a hosted payment page. amount in shekels. ref is our intent id (round-
 *  tripped into productdescription so the confirm step can cross-check it). */
export async function createPaymentPage(input: {
  amount: number;
  ref: string;
  description: string;
  returnUrl: string;
  ipnUrl: string;
  phone?: string;
  email?: string;
  maxPayments?: number;
}): Promise<CreatedPayment> {
  const results = await batch([
    env('CASHIER', 'REDIRECTDEPOSITCREDITCARDTRANSFER', {
      email: input.email || cfg().email,
      amount: input.amount,
      currency: 1, // ILS
      maxpayments: input.maxPayments || 1,
      productdescription: input.ref, // our intent id — confirmed back via GETTRANSACTIONS
      returnurl: input.returnUrl,
      ipnurl: input.ipnUrl,
      cellphonenotify: input.phone || '',
      emailnotify: input.email || '',
    }),
  ]);
  const r = results[1] as { header?: { errorcode?: string; errormessage?: string }; result?: unknown };
  if (r?.header?.errormessage && !/OK/i.test(r.header.errormessage)) {
    throw new Error(`UPay create failed: ${r.header.errormessage}`);
  }
  const txs = pick<unknown[]>(r?.result, 'transactions', 'transfers') || [];
  const tx0 = Array.isArray(txs) ? txs[0] : undefined;
  const url = pick<string>(tx0, 'url', 'paymenturl', 'redirecturl');
  const cashierId = pick<string | number>(tx0, 'cashierid', 'id', 'transactionid', 'transferid');
  if (!url) throw new Error('UPay create: no payment URL in response');
  return { url, cashierId: cashierId != null ? String(cashierId) : null, raw: r };
}

export interface TxStatus {
  paid: boolean;
  status: string | null; // transferstatus (S/A = paid)
  fourDigits: string | null;
  confirmationCode: string | null;
  provider: string | null; // shva/bit
  amount: number | null;
  ref: string | null; // productdescription
  raw: unknown;
}

/** Authoritative confirmation: re-query by cashier id. Caller MUST also cross-check
 *  ref === our intent id and amount before crediting anything. */
export async function getTransaction(cashierId: string): Promise<TxStatus> {
  const results = await batch([env('TRANSACTIONSINFO', 'GETTRANSACTIONS', { cashierids: [cashierId] })]);
  const r = results[1] as { result?: unknown };
  const txs = pick<unknown[]>(r?.result, 'transactions', 'transfers') || [];
  const tx = Array.isArray(txs) ? txs[0] : undefined;
  const status = pick<string>(tx, 'transferstatus', 'status');
  return {
    paid: status === 'S' || status === 'A',
    status: status ?? null,
    fourDigits: pick<string>(tx, 'fourdigits') ?? null,
    confirmationCode: pick<string>(tx, 'confirmationcode') ?? null,
    provider: pick<string>(tx, 'providername') ?? null,
    amount: (pick<number>(tx, 'amount') as number) ?? null,
    ref: pick<string>(tx, 'productdescription') ?? null,
    raw: r,
  };
}
