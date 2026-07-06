// Priority OData REST client. Port + extend of order-to-priority/server/priority.ts.
// PAT auth. Battle-tested error parsing.

export interface PriorityConfig {
  baseUrl: string;
  company: string;
  pat: string;
}

export function getPriorityConfig(): PriorityConfig | null {
  const baseUrl = process.env.PRIORITY_BASE_URL?.trim().replace(/\/+$/, '');
  const company = process.env.PRIORITY_COMPANY?.trim();
  const pat = process.env.PRIORITY_PAT?.trim();
  if (!baseUrl || !company || !pat) return null;
  return { baseUrl, company, pat };
}

export function extractPriorityErrorMessage(data: unknown): string {
  try {
    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;
      if (obj.error && typeof obj.error === 'object') {
        const errObj = obj.error as Record<string, unknown>;
        if (errObj.message) {
          return typeof errObj.message === 'object'
            ? (errObj.message as Record<string, string>).value || JSON.stringify(errObj.message)
            : String(errObj.message);
        }
      }
      if (obj.FORM && typeof obj.FORM === 'object') {
        const form = obj.FORM as Record<string, unknown>;
        if (form.InterfaceErrors && typeof form.InterfaceErrors === 'object') {
          const ie = form.InterfaceErrors as Record<string, unknown>;
          if (ie.text) return String(ie.text);
        }
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

export async function priorityRequest(
  config: PriorityConfig,
  endpoint: string,
  method = 'GET',
  body: unknown = null,
  timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  const url = `${config.baseUrl}/${config.company}/${endpoint}`;
  const authHeader = 'Basic ' + Buffer.from(`${config.pat}:PAT`).toString('base64');
  const options: RequestInit = {
    method,
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);

  console.log(`[Priority] ${method} ${url}`);
  // Bound every ERP call: a hung Priority connection would otherwise stall order
  // submit / first home load for minutes and wedge the finance-cache refresh.
  // Mutating calls pass a larger budget — aborting a slow-but-working ORDER POST
  // client-side doesn't stop Priority from committing it (duplicate risk).
  options.signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`Priority API timeout: ${method} ${endpoint.split('?')[0] ?? endpoint}`);
    }
    throw err;
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    console.error(`[Priority] Error ${res.status}:`, data);
    const friendly = extractPriorityErrorMessage(data);
    if (friendly) throw new Error(friendly);
    throw new Error(`Priority API Error ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data as Record<string, unknown>;
}

export async function loadAllFromPriority(
  config: PriorityConfig,
  endpoint: string
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let skip = 0;
  const top = 500;
  while (true) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const result = await priorityRequest(config, `${endpoint}${sep}$top=${top}&$skip=${skip}`);
    const batch = (result.value || []) as Record<string, unknown>[];
    all.push(...batch);
    if (batch.length < top) break;
    skip += top;
  }
  return all;
}

// --------- Domain helpers ---------

export interface PriorityProduct {
  PARTNAME: string;
  PARTDES?: string;
  FAMILYNAME?: string; // family CODE (e.g. "10")
  FAMILYDES?: string; // family Hebrew name (e.g. "דו״צ/סרטים") — on LOGPART directly
  BARCODE?: string;
  BASEPLPRICE?: number; // base price-list price (מחיר מחירון בסיס), BEFORE VAT — the selling price
  LASTPRICE?: number; // last transaction price (near cost) — NOT a selling price
  STATDES?: string;
}

export async function listProducts(config: PriorityConfig): Promise<PriorityProduct[]> {
  const items = await loadAllFromPriority(
    config,
    `LOGPART?$select=PARTNAME,PARTDES,FAMILYNAME,FAMILYDES,BARCODE,BASEPLPRICE,LASTPRICE,STATDES`
  );
  return items as unknown as PriorityProduct[];
}

export interface PriorityProductImage {
  PARTNAME: string;
  EXTFILENAME?: string | null;
}

// Product images are stored inline on LOGPART.EXTFILENAME as base64 data URIs
// (e.g. "data:image/png;base64,...."). On this Priority instance, filtering
// `EXTFILENAME ne null` returns HTTP 500, so we select the field for every part
// and keep only the rows whose value is an inline image. This is one paginated
// sweep; the payload is larger than a normal product list because of the embedded
// images, so it's fetched separately from listProducts().
export async function listProductImages(config: PriorityConfig): Promise<PriorityProductImage[]> {
  const items = await loadAllFromPriority(config, `LOGPART?$select=PARTNAME,EXTFILENAME`);
  return (items as unknown as PriorityProductImage[]).filter(
    (x) => typeof x.EXTFILENAME === 'string' && x.EXTFILENAME.startsWith('data:image/')
  );
}

export interface PriorityFamily {
  FAMILYNAME: string;
  FAMILYDESC?: string;
}

export async function listFamilies(config: PriorityConfig): Promise<PriorityFamily[]> {
  const items = await loadAllFromPriority(
    config,
    `FAMILY_LOG?$select=FAMILYNAME,FAMILYDESC`
  );
  return items as unknown as PriorityFamily[];
}

export interface PriorityCustomer {
  CUSTNAME: string;
  CUSTDES?: string;
  PHONE?: string;
  EMAIL?: string;
  PAYCODE?: string;
  PAYDES?: string;
}

export async function listCustomers(config: PriorityConfig): Promise<PriorityCustomer[]> {
  const items = await loadAllFromPriority(
    config,
    `CUSTOMERS?$select=CUSTNAME,CUSTDES,PHONE,EMAIL,PAYCODE,PAYDES`
  );
  return items as unknown as PriorityCustomer[];
}

// Per-customer pricing: derived from each customer's most recent order lines.
// (PRICELIST endpoint exposure varies by Priority config — falls back to LASTPRICE in catalog.)
export async function getCustomerLastPrices(
  config: PriorityConfig,
  custname: string,
  limit = 200
): Promise<Record<string, number>> {
  // Pull last N orders for this customer, expand ORDERITEMS_SUBFORM, take latest PRICE per PARTNAME.
  const safe = custname.replace(/'/g, "''");
  // Outer ORDERS are sorted newest-first, so the first PRICE we see per PARTNAME is
  // the most recent. CURDATE lives on the ORDER header (used for $orderby), NOT on
  // the line items — selecting it inside the subform 400s ("no property CURDATE on ORDERITEMS").
  const endpoint =
    `ORDERS?$filter=CUSTNAME eq '${safe}'&$orderby=CURDATE desc&$top=${limit}` +
    `&$expand=ORDERITEMS_SUBFORM($select=PARTNAME,PRICE)` +
    `&$select=ORDNAME,CUSTNAME,CURDATE`;
  const result = await priorityRequest(config, endpoint);
  const orders = (result.value || []) as Array<Record<string, unknown>>;
  const map: Record<string, number> = {};
  for (const order of orders) {
    const lines = (order.ORDERITEMS_SUBFORM || []) as Array<Record<string, unknown>>;
    for (const ln of lines) {
      const part = String(ln.PARTNAME || '').trim();
      const price = Number(ln.PRICE);
      if (part && isFinite(price) && price > 0 && !(part in map)) {
        map[part] = price;
      }
    }
  }
  return map;
}

/** Line-level discount PERCENTs from the customer's most recent orders, newest first.
 *  On this tenant the per-customer discount is applied as a flat PERCENT per line
 *  (PRICE == BASEPLPRICE) and there is no API-readable master — recent orders ARE
 *  the authoritative record of what the office actually grants this customer. */
export async function getCustomerRecentDiscountLines(
  config: PriorityConfig,
  custname: string,
  limit = 10
): Promise<Array<{ percent: number }>> {
  const safe = custname.replace(/'/g, "''");
  const endpoint =
    `ORDERS?$filter=CUSTNAME eq '${safe}'&$orderby=CURDATE desc&$top=${limit}` +
    `&$expand=ORDERITEMS_SUBFORM($select=PARTNAME,PERCENT)` +
    `&$select=ORDNAME,CUSTNAME,CURDATE`;
  const result = await priorityRequest(config, endpoint);
  const orders = (result.value || []) as Array<Record<string, unknown>>;
  const out: Array<{ percent: number }> = [];
  for (const order of orders) {
    for (const ln of (order.ORDERITEMS_SUBFORM || []) as Array<Record<string, unknown>>) {
      const percent = Number(ln.PERCENT);
      if (isFinite(percent)) out.push({ percent });
    }
  }
  return out;
}

export async function listOrdersForCustomer(
  config: PriorityConfig,
  custname: string
): Promise<Array<Record<string, unknown>>> {
  const safe = custname.replace(/'/g, "''");
  const result = await priorityRequest(
    config,
    `ORDERS?$filter=CUSTNAME eq '${safe}'&$orderby=CURDATE desc&$top=100&` +
      `$select=ORDNAME,CUSTNAME,CDES,CURDATE,ORDSTATUSDES,BOOLCLOSED,DETAILS`
  );
  return (result.value || []) as Array<Record<string, unknown>>;
}

export interface CreateOrderLine {
  PARTNAME: string;
  TQUANT: number;
  PRICE?: number;
}

export async function createOrder(
  config: PriorityConfig,
  custname: string,
  lines: CreateOrderLine[],
  details?: string,
  bookNum?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    CUSTNAME: custname,
    ORDERITEMS_SUBFORM: lines,
  };
  if (details) body.DETAILS = details;
  if (bookNum) body.BOOKNUM = bookNum;
  // 120s (not the default 30s): an aborted-but-committed ORDER POST is a duplicate
  // waiting to happen; give a slow ERP room to answer before we go down that path.
  const result = await priorityRequest(config, 'ORDERS', 'POST', body, 120_000);
  const ordname = (result.ORDNAME as string) || '';
  if (!ordname) throw new Error('Priority did not return ORDNAME');
  return ordname;
}

/** Look up an existing Priority order by its internal BOOKNUM reference (e.g. "B2B-42").
 *  Returns the ORDNAME if an order is found, or null if none exists. Used by the
 *  lost-response recovery paths to adopt an existing order instead of duplicating it.
 *  ALWAYS cross-check CUSTNAME when known: orders_local ids can be reused after an
 *  admin reset (INTEGER PRIMARY KEY rowid reuse), so a bare BOOKNUM hit may belong
 *  to a different customer's old order — adopting it would silently drop the order. */
export async function findOrderByBookNum(
  config: PriorityConfig,
  bookNum: string,
  custname?: string
): Promise<string | null> {
  const safe = bookNum.replace(/'/g, "''");
  const custFilter = custname ? ` and CUSTNAME eq '${custname.replace(/'/g, "''")}'` : '';
  const result = await priorityRequest(
    config,
    `ORDERS?$filter=BOOKNUM eq '${safe}'${custFilter}&$top=1&$select=ORDNAME,BOOKNUM,CUSTNAME`
  );
  const rows = (result.value || []) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const ordname = String(rows[0].ORDNAME || '').trim();
  return ordname || null;
}

// --------- Financial helpers (customer profile, invoices, AR) ---------
// Entity/field names verified against the live company a051014 via scripts/probe-priority*.mjs.

export interface PriorityCustomerFull {
  CUSTNAME: string;
  CUSTDES?: string;
  ADDRESS?: string;
  STATE?: string; // city
  ZIP?: string;
  PHONE?: string;
  FAX?: string;
  EMAIL?: string;
  VATNUM?: string; // company / VAT registration number
  PAYCODE?: string;
  PAYDES?: string; // payment terms description (שוטף / ש+30 ...)
  AGENTNAME?: string;
  MAX_CREDIT?: number;
  MAX_OBLIGO?: number;
  INACTIVEFLAG?: string;
}

const CUSTOMER_SELECT =
  'CUSTNAME,CUSTDES,ADDRESS,STATE,ZIP,PHONE,FAX,EMAIL,VATNUM,PAYCODE,PAYDES,AGENTNAME,MAX_CREDIT,MAX_OBLIGO,INACTIVEFLAG';

export async function getCustomer(
  config: PriorityConfig,
  custname: string
): Promise<PriorityCustomerFull | null> {
  const safe = custname.replace(/'/g, "''");
  const result = await priorityRequest(
    config,
    `CUSTOMERS?$filter=CUSTNAME eq '${safe}'&$top=1&$select=${CUSTOMER_SELECT}`
  );
  const rows = (result.value || []) as PriorityCustomerFull[];
  return rows[0] ?? null;
}

export interface PriorityOpenInvoice {
  CURDATE?: string;
  TOTPRICE?: number; // open amount incl VAT
  DISPRICE?: number; // pre-VAT
  VAT?: number;
  DOC?: number;
  DOCNO?: number;
  DOCREF?: string;
  ORDNAME?: string;
  REFERENCE?: string;
  BOOKNUM?: string;
}

// OPENINVOICES = invoices still open / unpaid. Sum of TOTPRICE = outstanding balance.
export async function listOpenInvoices(
  config: PriorityConfig,
  custname: string
): Promise<PriorityOpenInvoice[]> {
  const safe = custname.replace(/'/g, "''");
  const result = await priorityRequest(
    config,
    `OPENINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=CURDATE desc&$top=500` +
      `&$select=CURDATE,TOTPRICE,DISPRICE,VAT,DOC,DOCNO,DOCREF,ORDNAME,REFERENCE,BOOKNUM`
  );
  return (result.value || []) as PriorityOpenInvoice[];
}

export interface PriorityInvoice {
  IVNUM?: string;
  IVTYPE?: string;
  CDES?: string;
  IVDATE?: string;
  TOTPRICE?: number; // incl VAT
  QPRICE?: number; // pre-VAT, pre-discount
  VAT?: number;
  DISCOUNT?: number;
  ORDNAME?: string;
  STATDES?: string; // סופית | טיוטא | מבוטלת
  FNCNUM?: string;
}

// AINVOICES = tax-invoice history. Returns recent invoices; caller filters by status.
export async function listInvoices(
  config: PriorityConfig,
  custname: string,
  top = 100
): Promise<PriorityInvoice[]> {
  const safe = custname.replace(/'/g, "''");
  const result = await priorityRequest(
    config,
    `AINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=IVDATE desc&$top=${top}` +
      `&$select=IVNUM,IVTYPE,CDES,IVDATE,TOTPRICE,QPRICE,VAT,DISCOUNT,ORDNAME,STATDES,FNCNUM`
  );
  return (result.value || []) as PriorityInvoice[];
}

export interface PriorityUnpaidInvoice {
  IVNUM?: string;
  TOTPRICE?: number;
  IVDATE?: string;
  STATDES?: string;
  IVRECONDATE?: string | null; // reconciliation date — null = still unpaid
  /** Explicit payment schedule (תאריך תשלום). Empty on this tenant today; when
   *  Priority populates it, the due-date logic prefers it (spec §3). */
  IVPAY_SUBFORM?: { PAYDATE?: string | null }[];
}

// AINVOICES that haven't been reconciled (IVRECONDATE empty) are still owed — this
// is the authoritative "unpaid invoices" signal (OPENINVOICES is unreliable). The
// OData service can't filter `IVRECONDATE eq null`, so we fetch recent finalized
// invoices and filter the unreconciled ones client-side.
export async function listUnpaidInvoices(
  config: PriorityConfig,
  custname: string,
  top = 200
): Promise<PriorityUnpaidInvoice[]> {
  const safe = custname.replace(/'/g, "''");
  const result = await priorityRequest(
    config,
    `AINVOICES?$filter=CUSTNAME eq '${safe}'&$orderby=IVDATE desc&$top=${top}` +
      `&$select=IVNUM,TOTPRICE,IVDATE,STATDES,IVRECONDATE&$expand=IVPAY_SUBFORM`
  );
  return ((result.value || []) as PriorityUnpaidInvoice[]).filter(
    (iv) => iv.IVRECONDATE == null && (iv.STATDES || '').trim() === 'סופית' && Number(iv.TOTPRICE) > 0
  );
}

export interface PriorityInvoiceLine {
  PARTNAME?: string;
  PDES?: string;
  TQUANT?: number;
  UNITNAME?: string;
  PRICE?: number;
  QPRICE?: number; // line pre-VAT
  TOTPRICE?: number; // line incl VAT
}

// Single invoice with its line items — SCOPED to the customer (IDOR guard: the
// IVNUM must belong to this custname or we return null).
export async function getInvoiceWithItems(
  config: PriorityConfig,
  custname: string,
  ivnum: string
): Promise<(PriorityInvoice & { items: PriorityInvoiceLine[] }) | null> {
  const safeIv = ivnum.replace(/'/g, "''");
  const safeCust = custname.replace(/'/g, "''");
  // NOTE: Priority returns 200 but drops the connection mid-body ("terminated")
  // when AINVOICEITEMS_SUBFORM is expanded WITH an inner $select. A bare $expand
  // (no inner/outer $select) responds reliably, so we pull full rows and map the
  // fields we need in code (finance.ts) instead of constraining them server-side.
  const result = await priorityRequest(
    config,
    `AINVOICES?$filter=IVNUM eq '${safeIv}' and CUSTNAME eq '${safeCust}'&$top=1` +
      `&$expand=AINVOICEITEMS_SUBFORM`
  );
  const rows = (result.value || []) as Array<
    PriorityInvoice & { AINVOICEITEMS_SUBFORM?: PriorityInvoiceLine[] }
  >;
  const row = rows[0];
  if (!row) return null;
  const { AINVOICEITEMS_SUBFORM, ...inv } = row;
  return { ...inv, items: AINVOICEITEMS_SUBFORM || [] };
}

export interface PriorityObligo {
  OBLIGO?: number;
  IV_DEBIT?: number;
  DOC_DEBIT?: number;
  ORD_DEBIT?: number;
  ACC_DEBIT?: number;
  CHEQUE_DEBIT?: number;
  CREDIT?: number;
  CREDIT_REST?: number;
  MAX_CREDIT?: number;
  MAX_OBLIGO?: number;
}

// OBLIGO = total credit exposure (debt + open orders + cheques). Optional/nice-to-have.
export async function getObligo(
  config: PriorityConfig,
  custname: string
): Promise<PriorityObligo | null> {
  const safe = custname.replace(/'/g, "''");
  try {
    const result = await priorityRequest(
      config,
      `OBLIGO?$filter=CUSTNAME eq '${safe}'&$top=1` +
        `&$select=OBLIGO,IV_DEBIT,DOC_DEBIT,ORD_DEBIT,ACC_DEBIT,CHEQUE_DEBIT,CREDIT,CREDIT_REST,MAX_CREDIT,MAX_OBLIGO`
    );
    const rows = (result.value || []) as PriorityObligo[];
    return rows[0] ?? null;
  } catch {
    return null; // OBLIGO not always populated; never block the AR view on it
  }
}
