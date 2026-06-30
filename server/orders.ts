// Order submission: cart -> orders_local -> Priority ORDERS -> store ORDNAME back.

import { db } from './db.js';
import { createOrder, getPriorityConfig, listOrdersForCustomer } from './priority.js';
import { getProduct } from './catalog.js';
import { applyPromotions, type PromoResult } from './promotions.js';
import { enforcedFor, evaluate } from './paymentPolicy.js';
import { notifyUser } from './push.js';
import { getCheckForUser } from './payments.js';

export interface CartLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number | null;
  line_total: number;
  /** false when the item is no longer active+visible in the catalog, OR is marked
   *  out of stock (kept so the user can remove it; blocks checkout). */
  available: boolean;
  /** true → marked "אזל מהמלאי" (drives the badge; also forces available=false). */
  outOfStock: boolean;
}

const MAX_LINE_QTY = 9999;

export interface CartResult {
  lines: CartLine[];
  total: number; // items subtotal (pre-promotion), for backward compatibility
  promotions: PromoResult;
}

export function getCart(userId: number, custname: string): CartResult {
  const rows = db
    .prepare('SELECT partname, quantity FROM cart_lines WHERE user_id = ? ORDER BY updated_at')
    .all(userId) as Array<{ partname: string; quantity: number }>;
  const lines: CartLine[] = [];
  let total = 0;
  for (const r of rows) {
    const prod = getProduct(r.partname, custname);
    const price = prod?.price ?? 0;
    const lineTotal = price * r.quantity;
    total += lineTotal;
    lines.push({
      partname: r.partname,
      partdes: prod?.partdes ?? null,
      quantity: r.quantity,
      price,
      line_total: lineTotal,
      available: prod !== null && !prod.outOfStock,
      outOfStock: prod?.outOfStock ?? false,
    });
  }
  const promotions = applyPromotions(
    lines.filter((l) => l.available && typeof l.price === 'number' && l.price > 0).map((l) => ({
      partname: l.partname,
      partdes: l.partdes,
      quantity: l.quantity,
      price: l.price as number,
      line_total: l.line_total,
    })),
    custname
  );
  return { lines, total: Math.round(total * 100) / 100, promotions };
}

/**
 * Set or increment a cart line.
 * - mode 'set' (default): quantity is the absolute new value (cart steppers).
 * - mode 'add': quantity is ADDED to whatever is already in the cart, so tapping
 *   "הוסף" twice from the catalog accumulates instead of silently overwriting.
 */
export function setCartLine(
  userId: number,
  custname: string,
  partname: string,
  quantity: number,
  mode: 'set' | 'add' = 'set'
): void {
  if (mode === 'set' && quantity <= 0) {
    // Always allow removal, even of items that have since been hidden/deactivated.
    db.prepare('DELETE FROM cart_lines WHERE user_id = ? AND partname = ?').run(userId, partname);
    return;
  }
  if (quantity <= 0) return; // add of 0/negative is a no-op
  // Only items that are active AND b2b_visible may enter a cart — getProduct
  // returns null otherwise. Without this check a logged-in customer could PUT any
  // partname (including hidden/internal SKUs) and push it into the ERP order.
  const prod = getProduct(partname, custname);
  if (!prod) throw new OrderError('המוצר אינו זמין להזמנה');
  // Out-of-stock (אזל מהמלאי) items may not be ADDED. mode 'set' is intentionally
  // allowed so a customer can still reduce/remove one that was added before it went
  // out of stock — this is the single chokepoint every add path funnels through.
  if (mode === 'add' && prod.outOfStock) {
    throw new OrderError('המוצר אזל מהמלאי — אינו זמין להזמנה');
  }
  // Unpriceable items are rejected at ADD time, not only at submit — otherwise the
  // cart accumulates lines that doom the whole order later (review finding).
  if (typeof prod.price !== 'number' || prod.price <= 0) {
    throw new OrderError('למוצר אין מחיר זמין — פנו אלינו ונשלים את המחיר');
  }
  let finalQty = quantity;
  if (mode === 'add') {
    const existing = db
      .prepare('SELECT quantity FROM cart_lines WHERE user_id = ? AND partname = ?')
      .get(userId, partname) as { quantity: number } | undefined;
    finalQty = (existing?.quantity ?? 0) + quantity;
  }
  if (finalQty > MAX_LINE_QTY) throw new OrderError('כמות גדולה מדי');
  db.prepare(
    `INSERT INTO cart_lines (user_id, partname, quantity, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, partname) DO UPDATE SET
       quantity = excluded.quantity,
       updated_at = datetime('now')`
  ).run(userId, partname, finalQty);
}

export function clearCart(userId: number): void {
  db.prepare('DELETE FROM cart_lines WHERE user_id = ?').run(userId);
}

export interface SubmitResult {
  orderId: number;
  ordname: string;
  total: number;
  lines: CartLine[];
  needsPayment?: boolean;
  amount?: number;
}

/**
 * A validation/business error whose message is safe to show the customer
 * (e.g. "cart empty"). Anything thrown that is NOT an OrderError is treated as
 * an internal failure and must NOT leak its message to the client — it may carry
 * Priority API internals (field names, OData payloads, URLs).
 */
export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

export async function submitOrder(
  userId: number,
  custname: string,
  details?: string
): Promise<SubmitResult> {
  const { lines, total, promotions } = getCart(userId, custname);
  if (lines.length === 0) throw new OrderError('הסל ריק');

  // Promo handling: bogo free units and gift items are MATERIALIZED as separate
  // 0₪ order lines (the invoice comes out ready — e.g. buy-5-get-6 posts 5 paid +
  // 1 at PRICE 0). Percent/fixed discounts are NOT — the app must not override
  // Priority's per-customer pricing — so those still go as a note for the office.
  const manualPromos = promotions.applied.filter((a) => a.type === 'percent' || a.type === 'fixed');
  const autoPromos = promotions.applied.filter((a) => a.type === 'bogo' || a.type === 'gift');
  const noteParts: string[] = [];
  if (manualPromos.length) {
    noteParts.push(
      'מבצעים: ' + manualPromos.map((a) => `${a.name} (חיסכון ₪${a.savings.toFixed(2)})`).join('; ') + ' — נא ליישם'
    );
  }
  if (autoPromos.length) {
    noteParts.push('מבצע ' + autoPromos.map((a) => a.name).join('; ') + ' — שורות חינם במחיר 0 כבר בהזמנה');
  }
  const promoNote = noteParts.join(' | ');
  const fullDetails = [details, promoNote].filter(Boolean).join(' | ') || null;

  // Free units per product (bogo) — split off the paid line below.
  const freeQty = new Map<string, number>();
  for (const f of promotions.freebies) freeQty.set(f.partname, (freeQty.get(f.partname) || 0) + f.qty);

  // Re-validate every line against the live catalog at submit time. The cart may
  // hold items that were hidden/deactivated since they were added, or items with
  // no usable price — neither may reach the ERP.
  for (const ln of lines) {
    const prod = getProduct(ln.partname, custname);
    if (!prod) {
      throw new OrderError(`המוצר "${ln.partdes ?? ln.partname}" אינו זמין עוד — הסירו אותו מהסל`);
    }
    if (prod.outOfStock) {
      throw new OrderError(`המוצר "${prod.partdes ?? ln.partname}" אזל מהמלאי — הסירו אותו מהסל`);
    }
    if (typeof prod.price !== 'number' || prod.price <= 0) {
      throw new OrderError(
        `למוצר "${prod.partdes ?? ln.partname}" אין מחיר זמין — פנו אלינו ונשלים את המחיר`
      );
    }
  }

  // Payment-policy gate (Phase 3: unified net-debt block + cash-hold). Inert unless
  // the admin flag is on. Net-terms customers blocked on open_debt; cash customers
  // held as pending_payment (never forwarded to Priority until payment confirmed).
  let cashHold = false;
  let requiredAmount = 0;
  if (enforcedFor(custname)) {
    const decision = await evaluate(custname, promotions.total);
    if (!decision.allowOrder && decision.reason === 'open_debt') {
      throw new OrderError(
        `לא ניתן לבצע הזמנה — קיים חוב פתוח בסך ₪${(decision.amount ?? 0).toFixed(2)}. נא לסגור אותו (צ׳ק או אשראי) במסך "חשבוניות" ולנסות שוב.`
      );
    }
    if (decision.requiresPayment && decision.reason === 'cash_payment_required') {
      cashHold = true;
      requiredAmount = decision.amount ?? promotions.total;
    }
  }

  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');

  // Insert local order in 'submitting' state
  const localOrderId = (db
    .prepare(
      `INSERT INTO orders_local (user_id, custname, status, total, details)
       VALUES (?, ?, 'submitting', ?, ?)`
    )
    .run(userId, custname, promotions.total, fullDetails).lastInsertRowid as number);

  const insertLine = db.prepare(
    `INSERT INTO order_lines (order_id, partname, pdes, quantity, price, is_promotion_freebie, promotion_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const ln of lines) {
      const free = freeQty.get(ln.partname) || 0;
      insertLine.run(localOrderId, ln.partname, ln.partdes, ln.quantity - free, ln.price ?? 0, 0, null);
      if (free > 0) insertLine.run(localOrderId, ln.partname, ln.partdes, free, 0, 1, null); // bogo freebie
    }
    for (const g of promotions.gifts) {
      insertLine.run(localOrderId, g.partname, g.partdes, g.qty, 0, 1, null); // promo gift, free
    }
  });
  tx();

  // Cash-hold: order is recorded locally; payment must arrive before we forward to
  // Priority. The cart is cleared so the customer can't accidentally re-submit.
  if (cashHold) {
    db.prepare(
      `UPDATE orders_local SET status = 'pending_payment', payment_status = 'pending_payment', payment_required_amount = ? WHERE id = ?`
    ).run(requiredAmount, localOrderId);
    clearCart(userId);
    return { orderId: localOrderId, ordname: '', total, lines, needsPayment: true, amount: requiredAmount };
  }

  // POST to Priority. PRICE is deliberately omitted on PAID lines: Priority prices
  // each line from its own price lists / customer agreements, exactly as a phoned-in
  // order would be priced. The portal's cached price (stored on orders_local above)
  // is display-only — sending it would let a stale cache write prices into the ERP.
  // The ONLY priced lines are promo freebies/gifts, sent explicitly at PRICE 0 so
  // the order (and invoice) comes out ready without office intervention.
  let ordname: string;
  try {
    ordname = await createOrder(
      config,
      custname,
      [
        ...lines.flatMap((ln) => {
          const free = freeQty.get(ln.partname) || 0;
          const out: { PARTNAME: string; TQUANT: number; PRICE?: number }[] = [
            { PARTNAME: ln.partname, TQUANT: ln.quantity - free },
          ];
          if (free > 0) out.push({ PARTNAME: ln.partname, TQUANT: free, PRICE: 0 });
          return out;
        }),
        ...promotions.gifts.map((g) => ({ PARTNAME: g.partname, TQUANT: g.qty, PRICE: 0 })),
      ],
      fullDetails ?? undefined,
      `B2B-${localOrderId}`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(
      `UPDATE orders_local SET status = 'failed', error = ? WHERE id = ?`
    ).run(msg, localOrderId);
    throw err;
  }

  db.prepare(
    `UPDATE orders_local SET status = 'submitted', priority_ordname = ?, submitted_at = datetime('now')
     WHERE id = ?`
  ).run(ordname, localOrderId);

  // Clear cart after successful submission
  clearCart(userId);

  return { orderId: localOrderId, ordname, total, lines };
}

export function listLocalOrders(userId: number): Array<Record<string, unknown>> {
  return db
    .prepare(
      `SELECT id, custname, priority_ordname, status, total, details, created_at, submitted_at,
              payment_status, payment_required_amount, approved_at
       FROM orders_local
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 100`
    )
    .all(userId) as Array<Record<string, unknown>>;
}

export function getLocalOrder(userId: number, orderId: number): Record<string, unknown> | null {
  const order = db
    .prepare('SELECT * FROM orders_local WHERE id = ? AND user_id = ?')
    .get(orderId, userId) as Record<string, unknown> | undefined;
  if (!order) return null;
  const lines = db
    .prepare('SELECT * FROM order_lines WHERE order_id = ? ORDER BY id')
    .all(orderId);
  return { ...order, lines };
}

export async function listPriorityOrders(custname: string): Promise<Array<Record<string, unknown>>> {
  const config = getPriorityConfig();
  if (!config) return [];
  try {
    return await listOrdersForCustomer(config, custname);
  } catch (err) {
    console.warn('[orders] failed to list Priority orders:', err);
    return [];
  }
}

export function reorderToCart(userId: number, custname: string, orderId: number): number {
  const order = db
    .prepare('SELECT id FROM orders_local WHERE id = ? AND user_id = ?')
    .get(orderId, userId) as { id: number } | undefined;
  if (!order) throw new OrderError('הזמנה לא נמצאה');
  const lines = db
    .prepare('SELECT partname, quantity FROM order_lines WHERE order_id = ?')
    .all(orderId) as Array<{ partname: string; quantity: number }>;
  let added = 0;
  for (const ln of lines) {
    // Skip items that have since been hidden/deactivated/lost their price instead
    // of failing the whole reorder.
    const prod = getProduct(ln.partname, custname);
    if (!prod || prod.outOfStock || typeof prod.price !== 'number' || prod.price <= 0) continue;
    setCartLine(userId, custname, ln.partname, ln.quantity);
    added++;
  }
  return added;
}

/** Rebuild the Priority order payload from persisted order_lines (cart is already
 *  cleared for held orders) and submit it. Returns the Priority ORDNAME. Mirrors
 *  submitOrder's live payload: paid lines carry no PRICE; freebies/gifts at PRICE 0. */
export async function sendHeldOrderToPriority(orderId: number): Promise<string> {
  const order = db.prepare(`SELECT id, custname, details FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; custname: string; details: string | null } | undefined;
  if (!order) throw new Error(`order ${orderId} not found`);
  const rows = db.prepare(
    `SELECT partname, quantity, is_promotion_freebie FROM order_lines WHERE order_id = ?`
  ).all(orderId) as { partname: string; quantity: number; is_promotion_freebie: number }[];
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');
  const items = rows.map((r) =>
    r.is_promotion_freebie
      ? { PARTNAME: r.partname, TQUANT: r.quantity, PRICE: 0 }
      : { PARTNAME: r.partname, TQUANT: r.quantity }
  );
  return createOrder(config, order.custname, items, order.details ?? undefined, `B2B-${orderId}`);
}

/** Approve a held (pending_payment) order after its payment confirmed: mark approved,
 *  link the payment, send to Priority, notify. Idempotent. */
export async function approveOrder(orderId: number, kind: 'card' | 'check', paymentId: string): Promise<void> {
  const order = db.prepare(`SELECT id, user_id, status FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; user_id: number; status: string } | undefined;
  if (!order || order.status !== 'pending_payment') return;
  // Atomically CLAIM the order (pending_payment → submitting) so a concurrent/duplicate
  // confirm cannot double-send the same order to Priority — only the caller whose UPDATE
  // actually flips the row proceeds.
  const claimed = db.prepare(
    `UPDATE orders_local SET status = 'submitting', payment_status = 'approved', linked_payment_kind = ?, linked_payment_id = ?, approved_at = datetime('now')
     WHERE id = ? AND status = 'pending_payment'`
  ).run(kind, paymentId, orderId);
  if (claimed.changes !== 1) return; // another confirm already claimed it
  let ordname: string;
  try {
    ordname = await sendHeldOrderToPriority(orderId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Payment IS taken — keep payment_status='approved' so it's recoverable (admin resend, Phase 3b).
    db.prepare(`UPDATE orders_local SET status = 'failed', error = ? WHERE id = ?`).run(msg, orderId);
    return;
  }
  db.prepare(
    `UPDATE orders_local SET status = 'submitted', priority_ordname = ?, submitted_at = datetime('now') WHERE id = ?`
  ).run(ordname, orderId);
  try {
    notifyUser(order.user_id, { title: 'ההזמנה אושרה ✓', body: `התשלום התקבל — הזמנה ${ordname} נשלחה`, url: '#orders' });
  } catch (err) {
    console.warn('[orders] notifyUser failed:', err);
  }
}

/** Link an already-submitted cheque to a held order and approve it (cheque = approve
 *  at submit, decision #2). */
export async function payHeldOrderByCheck(userId: number, custname: string, orderId: number, checkId: string): Promise<boolean> {
  const order = db.prepare(`SELECT id, status, custname, user_id, payment_required_amount FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; status: string; custname: string; user_id: number; payment_required_amount: number | null } | undefined;
  if (!order || order.user_id !== userId || order.custname !== custname) throw new OrderError('ההזמנה לא נמצאה');
  if (order.status !== 'pending_payment') throw new OrderError('ההזמנה אינה ממתינה לתשלום');
  const chk = getCheckForUser(userId, checkId) as { status?: string; amount?: number; is_postdated?: number } | null;
  if (!chk || chk.status !== 'submitted') throw new OrderError('הצ׳ק לא נמצא או טרם אושר');
  // Guard 1: reject post-dated cheques — must be payable immediately.
  if (chk.is_postdated) throw new OrderError('צ׳ק דחוי אינו תקף לאישור הזמנה — נדרש צ׳ק לפירעון מיידי');
  // Guard 2: cheque amount must cover the order's required amount (VAT-inclusive).
  const required = Number(order.payment_required_amount) || 0;
  if ((chk.amount ?? 0) + 0.01 < required) throw new OrderError('סכום הצ׳ק (₪' + (chk.amount ?? 0).toFixed(2) + ') נמוך מסכום ההזמנה (₪' + required.toFixed(2) + ')');
  // Atomically CLAIM the cheque for THIS order (order_id IS NULL) so a single cheque
  // can't approve multiple held orders — one cheque settles one order.
  const linked = db
    .prepare('UPDATE payment_checks SET order_id = ? WHERE id = ? AND user_id = ? AND order_id IS NULL')
    .run(String(orderId), checkId, userId);
  if (linked.changes !== 1) throw new OrderError('הצ׳ק כבר משויך להזמנה');
  await approveOrder(orderId, 'check', checkId);
  return true;
}

const PENDING_TTL = '-48 hours';
/** Delete abandoned held orders (pending_payment, no payment ever linked, older than
 *  the TTL). Local-only — nothing was sent to Priority. Returns the count removed. */
export function sweepPendingOrders(): number {
  const stale = db.prepare(
    `SELECT id FROM orders_local WHERE status = 'pending_payment' AND linked_payment_id IS NULL AND created_at < datetime('now', ?)`
  ).all(PENDING_TTL) as { id: number }[];
  const delLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const delOrder = db.prepare('DELETE FROM orders_local WHERE id = ?');
  const tx = db.transaction(() => { for (const o of stale) { delLines.run(o.id); delOrder.run(o.id); } });
  tx();
  return stale.length;
}

/** Re-send a paid-but-unsent order to Priority (recovery for a Priority outage after
 *  payment: payment_status='approved' while priority_ordname is still null). */
export async function resendApprovedOrder(orderId: number): Promise<{ ok: boolean; ordname?: string; error?: string }> {
  const order = db.prepare(`SELECT id, payment_status, priority_ordname FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; payment_status: string; priority_ordname: string | null } | undefined;
  if (!order) return { ok: false, error: 'not found' };
  if (order.priority_ordname) return { ok: true, ordname: order.priority_ordname };
  if (order.payment_status !== 'approved') return { ok: false, error: 'not paid' };
  try {
    const ordname = await sendHeldOrderToPriority(orderId);
    db.prepare(`UPDATE orders_local SET status = 'submitted', priority_ordname = ?, submitted_at = datetime('now'), error = NULL WHERE id = ?`).run(ordname, orderId);
    return { ok: true, ordname };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Paid orders that never reached Priority (admin recovery queue). */
export function listStuckOrders(): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT id, custname, status, total, payment_status, created_at, error FROM orders_local
     WHERE payment_status = 'approved' AND priority_ordname IS NULL ORDER BY created_at DESC LIMIT 100`
  ).all() as Array<Record<string, unknown>>;
}
