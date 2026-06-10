// Promotions engine: percentage / fixed discounts, 1+1 (buy-X-get-Y), and
// spend-threshold gift SKUs. Applied server-side at cart time (display + recorded
// on the order). Priority still prices the purchased lines from its own price
// lists — the promo summary is written into the order note so the office honours
// the discount / adds the gift in the ERP (same model as portal pricing).

import { db } from './db.js';
import { getProduct } from './catalog.js';

export type PromoType = 'percent' | 'fixed' | 'bogo' | 'gift';

interface PromoRow {
  id: number;
  name: string;
  type: PromoType;
  params: string;
  active: number;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
}

export interface PromotionView {
  id: number;
  name: string;
  type: PromoType;
  params: Record<string, unknown>;
  active: boolean;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
}

function toView(r: PromoRow): PromotionView {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(r.params);
  } catch {
    /* corrupt */
  }
  return { id: r.id, name: r.name, type: r.type, params, active: !!r.active, priority: r.priority, startsAt: r.starts_at, endsAt: r.ends_at };
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
}

/** Active promos whose date window includes today, highest priority first. */
export function activePromotions(): PromotionView[] {
  const t = todayIso();
  return (db.prepare('SELECT * FROM promotions WHERE active = 1 ORDER BY priority DESC, id ASC').all() as PromoRow[])
    .filter((r) => (!r.starts_at || r.starts_at <= t) && (!r.ends_at || r.ends_at >= t))
    .map(toView);
}

// --- engine ---
interface PromoLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number;
  line_total: number;
}
export interface AppliedPromo {
  id: number;
  name: string;
  type: PromoType;
  savings: number;
}
export interface GiftItem {
  partname: string;
  partdes: string | null;
  qty: number;
  price: number;
}
export interface PromoResult {
  subtotal: number;
  discount: number;
  total: number;
  applied: AppliedPromo[];
  gifts: GiftItem[];
  /** the nearest unmet gift threshold, to nudge "add ₪X more for a gift" */
  giftProgress: { name: string; min: number; remaining: number; giftDes: string | null } | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

export function applyPromotions(lines: PromoLine[], custname: string): PromoResult {
  const subtotal = round2(lines.reduce((s, l) => s + (l.line_total || 0), 0));
  const applied: AppliedPromo[] = [];
  const gifts: GiftItem[] = [];
  let discount = 0;
  let giftProgress: PromoResult['giftProgress'] = null;

  // family lookups are cached per cart computation
  const familyOf = new Map<string, string | null>();
  const fam = (partname: string): string | null => {
    if (!familyOf.has(partname)) familyOf.set(partname, getProduct(partname, custname)?.family ?? null);
    return familyOf.get(partname) ?? null;
  };

  for (const p of activePromotions()) {
    const pr = p.params;
    if (p.type === 'bogo') {
      const partname = String(pr.partname || '');
      const buy = Math.max(1, num(pr.buy, 1));
      const free = Math.max(1, num(pr.free, 1));
      const line = lines.find((l) => l.partname === partname);
      if (!line) continue;
      const group = buy + free;
      const freeUnits = Math.floor(line.quantity / group) * free;
      if (freeUnits > 0) {
        const savings = round2(freeUnits * line.price);
        discount += savings;
        applied.push({ id: p.id, name: p.name, type: p.type, savings });
      }
    } else if (p.type === 'percent' || p.type === 'fixed') {
      const minSub = num(pr.minSubtotal, 0);
      if (subtotal < minSub) continue;
      const scope = String(pr.scope || 'order');
      const target = pr.target ? String(pr.target) : '';
      const base =
        scope === 'order'
          ? subtotal
          : round2(
              lines
                .filter((l) => (scope === 'product' ? l.partname === target : fam(l.partname) === target))
                .reduce((s, l) => s + l.line_total, 0)
            );
      if (base <= 0) continue;
      const savings = round2(p.type === 'percent' ? base * (num(pr.percent) / 100) : Math.min(num(pr.amount), base));
      if (savings > 0) {
        discount += savings;
        applied.push({ id: p.id, name: p.name, type: p.type, savings });
      }
    } else if (p.type === 'gift') {
      const min = num(pr.minSubtotal);
      const giftPart = String(pr.giftPartname || '');
      const giftQty = Math.max(1, num(pr.giftQty, 1));
      const prod = getProduct(giftPart, custname);
      if (!prod) continue;
      if (subtotal >= min) {
        if (!gifts.find((g) => g.partname === giftPart)) {
          gifts.push({ partname: giftPart, partdes: prod.partdes, qty: giftQty, price: prod.price ?? 0 });
          applied.push({ id: p.id, name: p.name, type: p.type, savings: round2((prod.price ?? 0) * giftQty) });
        }
      } else {
        const remaining = round2(min - subtotal);
        if (!giftProgress || remaining < giftProgress.remaining) {
          giftProgress = { name: p.name, min, remaining, giftDes: prod.partdes };
        }
      }
    }
  }

  discount = round2(Math.min(discount, subtotal));
  return { subtotal, discount, total: round2(subtotal - discount), applied, gifts, giftProgress };
}

// --- admin CRUD ---
export interface PromoInput {
  name: string;
  type: PromoType;
  params: Record<string, unknown>;
  active?: boolean;
  priority?: number;
  startsAt?: string | null;
  endsAt?: string | null;
}

export function listPromotions(): PromotionView[] {
  return (db.prepare('SELECT * FROM promotions ORDER BY active DESC, priority DESC, id DESC').all() as PromoRow[]).map(toView);
}

export function createPromotion(input: PromoInput): number {
  const info = db
    .prepare(
      `INSERT INTO promotions (name, type, params, active, priority, starts_at, ends_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name.slice(0, 120),
      input.type,
      JSON.stringify(input.params || {}),
      input.active === false ? 0 : 1,
      Math.round(num(input.priority, 0)),
      input.startsAt || null,
      input.endsAt || null
    );
  return Number(info.lastInsertRowid);
}

export function updatePromotion(id: number, input: Partial<PromoInput>): boolean {
  const cur = db.prepare('SELECT * FROM promotions WHERE id = ?').get(id) as PromoRow | undefined;
  if (!cur) return false;
  const v = toView(cur);
  const info = db
    .prepare(`UPDATE promotions SET name = ?, type = ?, params = ?, active = ?, priority = ?, starts_at = ?, ends_at = ? WHERE id = ?`)
    .run(
      (input.name ?? v.name).slice(0, 120),
      input.type ?? v.type,
      JSON.stringify(input.params ?? v.params),
      input.active === undefined ? (v.active ? 1 : 0) : input.active ? 1 : 0,
      input.priority === undefined ? v.priority : Math.round(num(input.priority, 0)),
      input.startsAt === undefined ? v.startsAt : input.startsAt || null,
      input.endsAt === undefined ? v.endsAt : input.endsAt || null,
      id
    );
  return info.changes > 0;
}

export function deletePromotion(id: number): boolean {
  return db.prepare('DELETE FROM promotions WHERE id = ?').run(id).changes > 0;
}
