// Heuristic "usual basket" suggestions — NO LLM (P1). Looks at the customer's own
// past order lines and surfaces the items they buy most, at their usual quantity,
// so a store owner can rebuild a routine order in one tap.
//
// Data source today: the portal's own order history (orders_local + order_lines).
// When Priority is reachable, listPriorityOrders gives a longer history, but the
// portal lines are enough to drive the card and need no ERP round-trip. Every
// suggestion is re-validated against the live catalog (active + b2b_visible +
// priced) before it is shown, so hidden/discontinued SKUs never surface.

import { db } from './db.js';
import { getProduct } from './catalog.js';

export interface ReorderSuggestion {
  partname: string;
  partdes: string | null;
  price: number;
  image_url: string | null;
  box_size: number;
  /** usual quantity = median of past order quantities, snapped to box size */
  quantity: number;
  /** how many past orders included this item — drives the ordering */
  timesOrdered: number;
  lastOrdered: string | null;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function snapToBox(qty: number, box: number): number {
  if (!box || box <= 1) return Math.max(1, Math.round(qty));
  return Math.max(box, Math.round(qty / box) * box);
}

interface HistRow {
  partname: string;
  quantity: number;
  created_at: string;
}

export function getReorderSuggestions(
  userId: number,
  custname: string,
  limit = 8
): ReorderSuggestion[] {
  // Only successfully-submitted orders count as "what this store actually buys".
  const rows = db
    .prepare(
      `SELECT ol.partname AS partname, ol.quantity AS quantity, o.created_at AS created_at
       FROM order_lines ol
       JOIN orders_local o ON o.id = ol.order_id
       WHERE o.user_id = ? AND o.status = 'submitted'
         AND ol.is_promotion_freebie = 0
       ORDER BY o.created_at DESC`
    )
    .all(userId) as HistRow[];

  const byPart = new Map<string, { qtys: number[]; count: number; last: string }>();
  for (const r of rows) {
    const e = byPart.get(r.partname);
    if (e) {
      e.qtys.push(r.quantity);
      e.count++;
      if (r.created_at > e.last) e.last = r.created_at;
    } else {
      byPart.set(r.partname, { qtys: [r.quantity], count: 1, last: r.created_at });
    }
  }

  const out: ReorderSuggestion[] = [];
  for (const [partname, agg] of byPart) {
    const prod = getProduct(partname, custname);
    // Re-validate: skip anything no longer active/visible, out of stock, or without a usable price.
    if (!prod || prod.outOfStock || typeof prod.price !== 'number' || prod.price <= 0) continue;
    out.push({
      partname,
      partdes: prod.partdes,
      price: prod.price,
      image_url: prod.image_url,
      box_size: prod.box_size,
      quantity: snapToBox(median(agg.qtys), prod.box_size),
      timesOrdered: agg.count,
      lastOrdered: agg.last,
    });
  }

  // Most-ordered first, then most-recent. Hidden until there is real history.
  out.sort((a, b) => b.timesOrdered - a.timesOrdered || (b.lastOrdered || '').localeCompare(a.lastOrdered || ''));
  return out.slice(0, limit);
}
