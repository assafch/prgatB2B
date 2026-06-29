// Home dashboard aggregate — one round-trip for the post-login landing screen.
// Combines the live finance summary (cached, degrades gracefully when Priority is
// down) with purely-local data (last order, heuristic reorder) so the dashboard
// always renders something useful even if the ERP is unreachable.

import { db, getSetting, getSettingBool } from './db.js';
import { getAccountSummary, type BalanceSummary } from './finance.js';
import { getReorderSuggestions, type ReorderSuggestion } from './reorder.js';
import { activePromotions } from './promotions.js';
import { getProduct } from './catalog.js';
import { resolvePolicy, enforcedFor, pendingSettlement } from './paymentPolicy.js';

export interface LastOrderView {
  id: number;
  ordname: string | null;
  status: string;
  total: number | null;
  created_at: string;
  itemCount: number;
}

/** Display-ready promo card for the home rail (title/subtitle/image derived server-side). */
export interface HomePromo {
  id: number;
  title: string;
  subtitle: string;
  image_url: string | null;
  href: string;
}

export interface HomeData {
  custname: string;
  custDesc: string | null;
  balance: BalanceSummary;
  priorityOk: boolean;
  balanceOk: boolean;
  lastOrder: LastOrderView | null;
  suggestions: ReorderSuggestion[];
  promotions: HomePromo[];
  /** server-owned feature flags so the client never shows dead CTAs */
  features: { payments: boolean; checkPayment: boolean };
  /** admin-controlled customer announcement (plain text, rendered escaped) */
  banner: { text: string } | null;
  /** admin-controlled maintenance mode — client blocks ordering + shows a notice */
  maintenance: { enabled: boolean; message: string };
  /** resolved payment policy for this customer (informational only; null when feature flag is off) */
  paymentPolicy: { kind: 'cash' | 'net'; netDebt: number; blocksOnDebt: boolean } | null;
}

// One card per active promotion, with a human subtitle derived from the promo
// params and the target product's image when there is a specific product.
function promoCards(custname: string): HomePromo[] {
  const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
  const cards: HomePromo[] = [];
  for (const p of activePromotions().slice(0, 8)) {
    const pr = p.params;
    let subtitle = '';
    let part: string | null = null;
    if (p.type === 'bogo') {
      part = String(pr.partname || '') || null;
      subtitle = `קנה ${Math.max(1, num(pr.buy, 1))} קבל ${Math.max(1, num(pr.free, 1))} חינם`;
    } else if (p.type === 'percent' || p.type === 'fixed') {
      const scope = String(pr.scope || 'order');
      if (scope === 'product') part = String(pr.target || '') || null;
      const what = p.type === 'percent' ? `${num(pr.percent)}% הנחה` : `הנחה של ₪${num(pr.amount)}`;
      const min = num(pr.minSubtotal);
      subtitle = scope === 'order' ? `${what} על כל ההזמנה${min ? ` מעל ₪${min}` : ''}` : what;
    } else if (p.type === 'gift') {
      part = String(pr.giftPartname || '') || null;
      subtitle = `מתנה בקנייה מעל ₪${num(pr.minSubtotal)}`;
    }
    const prod = part ? getProduct(part, custname) : null;
    cards.push({
      id: p.id,
      title: p.name,
      subtitle: prod?.partdes && !subtitle.includes(prod.partdes) ? `${subtitle} · ${prod.partdes}` : subtitle,
      image_url: prod?.image_url ?? null,
      href: prod ? `#product/${encodeURIComponent(prod.partname)}` : '#catalog',
    });
  }
  return cards;
}

export async function getHomeData(
  userId: number,
  custname: string,
  custDesc: string | null
): Promise<HomeData> {
  // Finance can be slow / unavailable; the rest is instant local SQLite.
  const summary = await getAccountSummary(custname);
  const pol = enforcedFor(custname) ? resolvePolicy(custname, summary.profile?.paymentTerms ?? null) : null;
  const netDebt = pol && summary.balanceOk ? Math.max(0, summary.balance.openTotal - pendingSettlement(custname)) : 0;

  const lastRow = db
    .prepare(
      `SELECT id, priority_ordname, status, total, created_at
       FROM orders_local
       WHERE user_id = ? AND status = 'submitted'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(userId) as
    | { id: number; priority_ordname: string | null; status: string; total: number | null; created_at: string }
    | undefined;

  let lastOrder: LastOrderView | null = null;
  if (lastRow) {
    const { c } = db
      .prepare('SELECT COUNT(*) AS c FROM order_lines WHERE order_id = ?')
      .get(lastRow.id) as { c: number };
    lastOrder = {
      id: lastRow.id,
      ordname: lastRow.priority_ordname,
      status: lastRow.status,
      total: lastRow.total,
      created_at: lastRow.created_at,
      itemCount: c,
    };
  }

  return {
    custname,
    custDesc,
    balance: summary.balance,
    priorityOk: summary.priorityOk,
    balanceOk: summary.balanceOk,
    lastOrder,
    suggestions: getReorderSuggestions(userId, custname),
    promotions: promoCards(custname),
    features: {
      // Admin-toggleable (settings table), with the original env/default as fallback.
      payments: getSettingBool('payments_enabled', process.env.PAYMENTS_ENABLED === 'true'),
      checkPayment: getSettingBool('check_payment_enabled', true),
    },
    banner: getSettingBool('announcement_enabled', false)
      ? { text: getSetting('announcement_text') || '' }
      : null,
    maintenance: {
      enabled: getSettingBool('maintenance_enabled', false),
      message: getSetting('maintenance_message') || 'המערכת בתחזוקה זמנית. נחזור בקרוב.',
    },
    paymentPolicy: pol
      ? { kind: pol.kind, netDebt, blocksOnDebt: pol.blockOnOpenDebt && !pol.allowOrderWithOpenDebt && netDebt > pol.openDebtThreshold + 0.001 }
      : null,
  };
}
