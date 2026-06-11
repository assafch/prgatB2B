// Tranzila client (card payments via the hosted payment page — no card data
// touches our server, PCI SAQ-A). Protocol extracted from Tranzila's official
// WooCommerce plugin (WCGatewayTranzila 0.0.24.6) and docs.tranzila.com:
//   - Hosted page:   https://direct.tranzila.com/<terminal>/iframenew.php
//   - 3DS handshake: GET https://api.tranzila.com/v1/handshake/create → "thtk=<token>"
//   - Status query:  POST https://api.tranzila.com/v1/transactions (HMAC headers)
// The success/notify callbacks are NEVER trusted — payment is confirmed only by
// re-querying /v1/transactions and cross-checking terminal + amount + our ref.

import crypto from 'node:crypto';

const DIRECT_BASE = 'https://direct.tranzila.com';
const API_BASE = 'https://api.tranzila.com';

function cfg() {
  return {
    terminal: process.env.TRANZILA_TERMINAL || '',
    appKey: process.env.TRANZILA_APP_KEY || '',
    secret: process.env.TRANZILA_SECRET || '',
    handshakePw: process.env.TRANZILA_HANDSHAKE_PW || '',
  };
}

export function tranzilaEnabled(): boolean {
  const c = cfg();
  return !!c.terminal && !!c.appKey && !!c.secret;
}

// HMAC header auth for api.tranzila.com (scheme from the plugin's TrApiClient):
// access-token = HMAC-SHA256(msg = appKey, key = secret + unixTime + nonce).
function apiHeaders(): Record<string, string> {
  const c = cfg();
  const nonce = crypto.randomBytes(40).toString('hex');
  const time = String(Math.floor(Date.now() / 1000));
  const token = crypto.createHmac('sha256', c.secret + time + nonce).update(c.appKey).digest('hex');
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-tranzila-api-app-key': c.appKey,
    'X-tranzila-api-request-time': time,
    'X-tranzila-api-nonce': nonce,
    'X-tranzila-api-access-token': token,
  };
}

/** Build the hosted payment page URL. amount in shekels. ref is our intent id —
 *  sent as a custom param (echoed back to success/notify) and cross-checked on
 *  confirm. The page itself is opened in the customer's browser. */
export async function createPaymentPage(input: {
  amount: number;
  ref: string;
  description: string;
  successUrl: string;
  failUrl: string;
  notifyUrl: string;
  contact?: string;
  email?: string;
  phone?: string;
}): Promise<{ url: string }> {
  const c = cfg();
  const sum = input.amount.toFixed(2);
  const p = new URLSearchParams({
    sum,
    currency: '1', // ILS
    tranmode: 'A', // standard J4 charge
    cred_type: '1', // single payment
    // ref is embedded in the product description (like UPay's productdescription)
    // so it lands in the transaction record itself, not only in the callbacks.
    pdesc: `${input.description} [${input.ref}]`,
    myref: input.ref, // custom param — echoed back in the success/notify callbacks
    success_url_address: input.successUrl,
    fail_url_address: input.failUrl,
    notify_url_address: input.notifyUrl,
    lang: 'il',
    nologo: '1',
  });
  if (input.contact) p.set('contact', input.contact);
  if (input.email) p.set('email', input.email);
  if (input.phone) p.set('phone', input.phone);

  // 3DS V2 handshake (thtk) when the handshake password is configured. The page
  // still works without it, so a handshake failure must not block payment.
  if (c.handshakePw) {
    try {
      const hs = new URLSearchParams({ sum, supplier: c.terminal, TranzilaPW: c.handshakePw, currency: '1' });
      const res = await fetch(`${API_BASE}/v1/handshake/create?${hs}`);
      const text = await res.text();
      const m = text.match(/thtk=([^&\s"']+)/);
      if (res.ok && m) {
        p.set('thtk', m[1]);
        p.set('new_process', '1');
      } else {
        console.warn('[tranzila] handshake did not return thtk; continuing without 3DS handshake');
      }
    } catch (err) {
      console.warn('[tranzila] handshake failed:', err instanceof Error ? err.message : err);
    }
  }
  return { url: `${DIRECT_BASE}/${encodeURIComponent(c.terminal)}/iframenew.php?${p}` };
}

export interface TranzilaTx {
  paid: boolean;
  responseCode: string | null; // '000' = approved
  index: string | null; // Tranzila transaction index
  amount: number | null;
  fourDigits: string | null;
  confirmationCode: string | null;
  refFound: boolean; // our ref appears somewhere in the transaction record
  raw: unknown;
}

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = (obj as Record<string, unknown>)[k];
    if (v !== undefined && v !== null && v !== '') return v as T;
  }
  return undefined;
}

// Live response shape (verified): { transactions: [...], user_defined: [...] }.
// Prefer the documented key; fall back to scanning, skipping user_defined
// (terminal field definitions, not transactions).
function findTxArray(node: unknown, depth = 0): unknown[] | null {
  if (depth > 4 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.length && typeof node[0] === 'object' ? node : null;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.transactions)) return obj.transactions;
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'user_defined') continue;
    const found = findTxArray(v, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseTx(tx: unknown, ref: string): TranzilaTx {
  const code = pick<string | number>(tx, 'processor_response_code', 'response_code', 'Response', 'response', 'status_code');
  const codeStr = code != null ? String(code).padStart(3, '0') : null;
  const amountRaw = pick<string | number>(tx, 'amount', 'sum', 'transaction_amount');
  const amount = amountRaw != null && isFinite(Number(amountRaw)) ? Number(amountRaw) : null;
  return {
    paid: codeStr === '000',
    responseCode: codeStr,
    index: (() => {
      const i = pick<string | number>(tx, 'transaction_index', 'index', 'transaction_id');
      return i != null ? String(i) : null;
    })(),
    amount,
    fourDigits: (() => {
      const d = pick<string>(tx, 'last_4', 'last4', 'ccno', 'card_mask');
      const m = d ? String(d).match(/(\d{4})\s*$/) : null;
      return m ? m[1] : null;
    })(),
    confirmationCode: (() => {
      const a = pick<string | number>(tx, 'auth_number', 'authnr', 'confirmation_code', 'ConfirmationCode');
      return a != null ? String(a) : null;
    })(),
    // ref is a 24-hex random id — a substring match over the record is unambiguous
    refFound: JSON.stringify(tx).includes(ref),
    raw: tx,
  };
}

async function queryTransactions(body: Record<string, unknown>, ref: string): Promise<TranzilaTx[]> {
  const res = await fetch(`${API_BASE}/v1/transactions`, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`tranzila transactions query failed (${res.status}): ${text.slice(0, 200)}`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('tranzila transactions: non-JSON response');
  }
  return (findTxArray(json) || []).map((t) => parseTx(t, ref));
}

/** Authoritative status lookup. The transaction must carry our ref (random 24-hex,
 *  embedded in pdesc) — a notify-hinted index alone is never trusted, since indexes
 *  are sequential/guessable and the notify endpoint is unauthenticated. Tries the
 *  hinted index first (cheap), then scans the date range around the intent. */
export async function findTransaction(opts: {
  ref: string;
  index?: string | null;
  createdAt: string; // 'YYYY-MM-DD HH:MM:SS' (UTC, from sqlite)
}): Promise<TranzilaTx | null> {
  const c = cfg();
  if (opts.index && isFinite(Number(opts.index))) {
    const byIndex = await queryTransactions({ terminal_name: c.terminal, transaction_index: Number(opts.index) }, opts.ref);
    const hit = byIndex.find((t) => t.refFound);
    if (hit) return hit;
  }
  const created = new Date(opts.createdAt.replace(' ', 'T') + 'Z');
  const start = new Date(created.getTime() - 24 * 3600 * 1000);
  const end = new Date(Date.now() + 24 * 3600 * 1000);
  const inRange = await queryTransactions(
    {
      terminal_name: c.terminal,
      transaction_start_date: start.toISOString().slice(0, 10),
      transaction_end_date: end.toISOString().slice(0, 10),
    },
    opts.ref
  );
  return inRange.find((t) => t.refFound) ?? null;
}
