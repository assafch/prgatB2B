// Order submission: cart -> orders_local -> Priority ORDERS -> store ORDNAME back.

import { db } from './db.js';
import { createOrder, getPriorityConfig, listOrdersForCustomer } from './priority.js';
import { getProduct } from './catalog.js';

export interface CartLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number | null;
  line_total: number;
}

export function getCart(userId: number, custname: string): { lines: CartLine[]; total: number } {
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
    });
  }
  return { lines, total };
}

export function setCartLine(userId: number, partname: string, quantity: number): void {
  if (quantity <= 0) {
    db.prepare('DELETE FROM cart_lines WHERE user_id = ? AND partname = ?').run(userId, partname);
    return;
  }
  db.prepare(
    `INSERT INTO cart_lines (user_id, partname, quantity, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, partname) DO UPDATE SET
       quantity = excluded.quantity,
       updated_at = datetime('now')`
  ).run(userId, partname, quantity);
}

export function clearCart(userId: number): void {
  db.prepare('DELETE FROM cart_lines WHERE user_id = ?').run(userId);
}

export interface SubmitResult {
  orderId: number;
  ordname: string;
  total: number;
  lines: CartLine[];
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
  const { lines, total } = getCart(userId, custname);
  if (lines.length === 0) throw new OrderError('הסל ריק');

  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');

  // Insert local order in 'submitting' state
  const localOrderId = (db
    .prepare(
      `INSERT INTO orders_local (user_id, custname, status, total, details)
       VALUES (?, ?, 'submitting', ?, ?)`
    )
    .run(userId, custname, total, details ?? null).lastInsertRowid as number);

  const insertLine = db.prepare(
    `INSERT INTO order_lines (order_id, partname, pdes, quantity, price, is_promotion_freebie, promotion_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const ln of lines) {
      insertLine.run(localOrderId, ln.partname, ln.partdes, ln.quantity, ln.price ?? 0, 0, null);
    }
  });
  tx();

  // POST to Priority
  let ordname: string;
  try {
    ordname = await createOrder(
      config,
      custname,
      lines.map((ln) => ({
        PARTNAME: ln.partname,
        TQUANT: ln.quantity,
        PRICE: ln.price ?? undefined,
      })),
      details,
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
      `SELECT id, custname, priority_ordname, status, total, details, created_at, submitted_at
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

export function reorderToCart(userId: number, orderId: number): number {
  const order = db
    .prepare('SELECT id FROM orders_local WHERE id = ? AND user_id = ?')
    .get(orderId, userId) as { id: number } | undefined;
  if (!order) throw new Error('הזמנה לא נמצאה');
  const lines = db
    .prepare('SELECT partname, quantity FROM order_lines WHERE order_id = ?')
    .all(orderId) as Array<{ partname: string; quantity: number }>;
  for (const ln of lines) {
    setCartLine(userId, ln.partname, ln.quantity);
  }
  return lines.length;
}
