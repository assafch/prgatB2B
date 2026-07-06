import { api } from '../api.js';
import { formatMoney, formatDateTime, escapeHtml, escapeAttr } from '../format.js';
import { toast, statusChip, skeleton, errorState, buzz } from '../ui.js';
import { state, refreshCartCount } from '../main.js';
import { renderPushCard } from './pushPrompt.js';

interface Suggestion {
  partname: string;
  partdes: string | null;
  price: number;
  image_url: string | null;
  box_size: number;
  quantity: number;
  timesOrdered: number;
}
interface LastOrder {
  id: number;
  ordname: string | null;
  status: string;
  total: number | null;
  created_at: string;
  itemCount: number;
}
interface HomePromo {
  id: number;
  title: string;
  subtitle: string;
  image_url: string | null;
  href: string;
}
interface HomeData {
  custname: string;
  custDesc: string | null;
  customerName?: string | null;
  balance: { openTotal: number; openCount: number; obligo: number | null; creditLimit: number | null };
  priorityOk: boolean;
  balanceOk: boolean;
  lastOrder: LastOrder | null;
  suggestions: Suggestion[];
  promotions: HomePromo[];
  features: { payments: boolean; checkPayment: boolean; unifiedCheckout?: boolean };
  banner: { text: string } | null;
  maintenance: { enabled: boolean; message: string };
  paymentPolicy?: { kind: 'cash' | 'net'; netDebt: number; blocksOnDebt: boolean } | null;
  pendingPaymentOrder?: { id: number; amount: number; createdAt: string } | null;
}

export async function renderHome(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(4)}</div>`;
  let d: HomeData;
  try {
    d = await api.get<HomeData>('/api/home');
  } catch (ex) {
    shell.innerHTML = '';
    shell.appendChild(errorState(ex instanceof Error ? ex.message : String(ex), () => renderHome(shell)));
    return;
  }

  // One-time nudge after redeeming a magic login link (see pages/loginLink.ts).
  if (sessionStorage.getItem('mll-welcome')) {
    sessionStorage.removeItem('mll-welcome');
    toast('מחוברים! מומלץ להפעיל כניסה עם טביעת אצבע בחשבון', 'ok');
  }

  const name = d.customerName || d.custDesc || state.me?.cust_desc || '';
  const owing = d.balance.openTotal > 0;
  // 'orderer' staff don't see finance (debt/pay) — that's the owner's view.
  const isOrderer = state.me?.customer_role === 'orderer';

  // Debt card (coral, per the Stitch design). When the balance form is unreachable
  // we can't trust the number, so we show an honest "unavailable" — never ₪0.
  let debtCard: string;
  if (isOrderer) {
    debtCard = `
      <div class="debt-coral neutral">
        <div class="amount" style="font-size:1.4rem">👋 ${name ? escapeHtml(name) : 'שלום'}</div>
        <div class="label">בחרו מוצרים והוסיפו לסל — ההזמנה תישלח לאישור</div>
      </div>`;
  } else if (!d.balanceOk) {
    debtCard = `
      <div class="debt-coral neutral">
        <div class="amount" style="font-size:1.3rem">לא זמין כעת</div>
        <div class="label">נתוני החוב יתעדכנו בקרוב</div>
      </div>`;
  } else if (owing) {
    // White outline icons inside the navy buttons (check-circle / credit card),
    // exactly as in the Stitch render — icon leads the text (right side in RTL).
    const checkIco = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.6 2.6L16 9"/></svg>`;
    const cardIco = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/><path d="M6 15h4"/></svg>`;
    const amountHtml = formatMoney(d.balance.openTotal).replace('₪', '<span class="ils">₪</span>');
    debtCard = `
      <div class="debt-coral">
        <div class="label">יתרת חוב</div>
        <div class="amount">${amountHtml}</div>
        ${d.features.checkPayment ? `<a class="pay-navy" href="#pay/check">${checkIco} שלם בצ׳יק</a>` : ''}
        <a class="pay-navy" href="#pay/card">${cardIco} שלם באשראי</a>
        <a class="inv-link" href="#invoices">צפייה בחשבוניות הפתוחות</a>
      </div>`;
  } else if (d.lastOrder) {
    debtCard = `
      <div class="debt-coral clear">
        <div class="amount" style="font-size:1.5rem">✓ אין חוב פתוח</div>
        <div class="label">כל החשבוניות שולמו — כל הכבוד!</div>
      </div>`;
  } else {
    // First-time customer with no history — welcome, don't congratulate.
    debtCard = `
      <div class="debt-coral clear">
        <div class="amount" style="font-size:1.5rem">👋 ברוכים הבאים</div>
        <div class="label">אין חשבוניות פתוחות — הזמינו דרך הקטלוג</div>
      </div>`;
  }

  // Unified checkout: an order held for payment is the single most urgent thing on
  // this screen — surface it above everything (spec §3.6).
  const pendingPayBanner =
    d.features.unifiedCheckout && d.pendingPaymentOrder
      ? `<a class="debt-coral" style="display:block;text-decoration:none;margin-bottom:0.75rem" href="#order-pay/${d.pendingPaymentOrder.id}">
           <div class="label">⏳ הזמנה ממתינה לתשלום</div>
           <div class="amount">${formatMoney(d.pendingPaymentOrder.amount)}</div>
           <div class="label">ההזמנה תישלח מיד עם השלמת התשלום</div>
           <span class="pay-navy" style="margin-top:0.5rem">שלם עכשיו ←</span>
         </a>`
      : '';

  // Side tiles (the two white shortcut cards in the design). Staff 'orderer'
  // doesn't see finance — swap the invoices tile for the catalog.
  // 3D icons: invoices/account are cropped from the Stitch render itself;
  // catalog (orderer variant) is a matching Fluent 3D asset.
  const tiles = `
    <div class="home-tiles">
      ${
        isOrderer
          ? `<a class="home-tile" href="#catalog"><img class="ico3d" src="/icon3d-catalog.png" alt=""/><span class="t">קטלוג</span><span class="s">הזמנה חדשה</span></a>`
          : `<a class="home-tile" href="#invoices"><img class="ico3d" src="/icon3d-invoices.png" alt=""/><span class="t">חשבוניות</span><span class="s">מסמכים ויתרה</span></a>`
      }
      <a class="home-tile" href="#account"><img class="ico3d" src="/icon3d-account.png" alt=""/><span class="t">החשבון שלי</span><span class="s">פרטים והגדרות</span></a>
    </div>`;

  // Promotions rail — "מבצעים והנחות" cards with a navy "קנה עכשיו" CTA.
  let promoRail = '';
  if (d.promotions.length > 0) {
    promoRail = `
      <h2 class="home-sec">מבצעים והנחות</h2>
      <div class="promo-rail">
        ${d.promotions
          .map(
            (p) => `
          <a class="promo-card" href="${escapeAttr(p.href)}">
            <div class="promo-img">${p.image_url ? `<img src="${escapeAttr(p.image_url)}" alt="" loading="lazy"/>` : '🎁'}</div>
            <div class="promo-title">${escapeHtml(p.title)}</div>
            <div class="promo-sub">${escapeHtml(p.subtitle)}</div>
            <span class="promo-cta">קנה עכשיו</span>
          </a>`
          )
          .join('')}
      </div>`;
  }

  // Credit-utilization bar (only when we have both numbers).
  let utilBar = '';
  if (d.priorityOk && d.balance.obligo != null && d.balance.creditLimit) {
    const pct = Math.min(100, Math.round((d.balance.obligo / d.balance.creditLimit) * 100));
    const tone = pct >= 100 ? 'over' : pct >= 90 ? 'warn' : '';
    utilBar = `
      <div class="card">
        <div style="font-weight:700;margin-bottom:0.2rem">ניצול מסגרת אשראי</div>
        <div class="util">
          <div class="util-track"><div class="util-fill ${tone}" style="width:${pct}%"></div></div>
          <div class="util-meta"><span>${formatMoney(d.balance.obligo)}</span><span>מסגרת ${formatMoney(d.balance.creditLimit)}</span></div>
        </div>
        ${pct >= 90 ? `<div class="${pct >= 100 ? 'error' : 'badge warn'}" style="margin-top:0.5rem;font-size:0.85rem">${pct >= 100 ? 'חרגת מהמסגרת — ייתכן שהזמנות יעוכבו' : 'מתקרב למסגרת האשראי'}</div>` : ''}
      </div>`;
  }

  // Last order + one-tap reorder.
  let lastOrderCard = '';
  if (d.lastOrder) {
    const lo = d.lastOrder;
    lastOrderCard = `
      <div class="sec-head"><h2>ההזמנה האחרונה</h2><a href="#orders">כל ההזמנות</a></div>
      <div class="card dash-row">
        <div class="grow">
          <div style="font-weight:700">${lo.ordname ? escapeHtml(lo.ordname) : 'הזמנה #' + lo.id} · ${lo.itemCount} פריטים</div>
          <div class="muted" style="font-size:0.85rem">${formatDateTime(lo.created_at)} · ${formatMoney(lo.total)}</div>
          <div style="margin-top:0.35rem">${statusChip(statusLabel(lo.status))}</div>
        </div>
        <button class="ghost" id="reorder-last" data-id="${lo.id}">הזמנה חוזרת</button>
      </div>`;
  }

  // "Usual basket" checklist (A3): the routine order, pre-ticked at the usual
  // quantity. Tap a row to skip it this week; one button adds the rest at ₪total.
  let suggestionCard = '';
  if (d.suggestions.length > 0) {
    suggestionCard = `
      <div class="sec-head"><h2>הסל הרגיל שלך</h2></div>
      <div class="card usual-card">
        <div class="muted" style="font-size:0.88rem;margin-bottom:0.6rem">מה שאתה מזמין כל שבוע — בכמות הרגילה. הקש לדילוג על פריט.</div>
        <div class="usual-list">
          ${d.suggestions.map(usualRow).join('')}
        </div>
        <button id="add-usual" class="usual-cta"></button>
      </div>`;
  }

  // Admin-controlled customer notices (rendered escaped — plain text only).
  const maintenanceCard = d.maintenance?.enabled
    ? `<div class="card" style="border:1px solid var(--err);background:#fdecec"><div style="font-weight:700;color:var(--err)">🛠️ ${escapeHtml(d.maintenance.message)}</div></div>`
    : '';
  const bannerCard =
    d.banner && d.banner.text
      ? `<div class="card" style="border:1px solid var(--brand);background:#fff6f6"><div>📣 ${escapeHtml(d.banner.text)}</div></div>`
      : '';

  shell.innerHTML = `
    <div class="home-head">
      <span class="home-avatar" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.3 3.6-5.5 8-5.5s8 2.2 8 5.5v1H4z"/></svg></span>
      <span>שלום${name ? `, <b>${escapeHtml(name)}</b>` : ''}</span>
    </div>
    ${maintenanceCard}
    ${bannerCard}
    ${pendingPayBanner}
    ${promoRail}
    <div class="home-grid">
      ${tiles}
      ${debtCard}
    </div>
    ${utilBar}
    ${lastOrderCard}
    ${suggestionCard}
  `;

  shell.querySelector('#reorder-last')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await api.post<{ lines: number }>(`/api/orders/${btn.dataset.id}/reorder`);
      await refreshCartCount();
      if (!r.lines) {
        toast('אף מוצר מההזמנה אינו זמין כעת', 'error');
        btn.disabled = false;
        return;
      }
      toast(`${r.lines} מוצרים נוספו לעגלה`, 'ok');
      location.hash = '#cart';
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : String(ex), 'error');
      btn.disabled = false;
    }
  });

  wireUsualBasket(shell);
  renderPushCard(shell);
}

// A3 — usual-basket checklist interactivity. Skips are client-side; the add posts
// the exclude set to /api/reorder/add-all (server keeps the authoritative qtys).
function wireUsualBasket(shell: HTMLElement): void {
  const card = shell.querySelector('.usual-card');
  if (!card) return;
  const items = Array.from(card.querySelectorAll<HTMLElement>('.usual-item'));
  const btn = card.querySelector('#add-usual') as HTMLButtonElement;
  const excluded = new Set<string>();

  const updateTotal = () => {
    let total = 0;
    let count = 0;
    for (const el of items) {
      if (excluded.has(el.dataset.part!)) continue;
      total += Number(el.dataset.price) * Number(el.dataset.qty);
      count++;
    }
    btn.disabled = count === 0;
    btn.textContent = count === 0 ? 'בחר פריט אחד לפחות' : `הוסף את כל הסל · ${formatMoney(total)}`;
  };

  for (const el of items) {
    const toggle = () => {
      const part = el.dataset.part!;
      const skip = !excluded.has(part);
      if (skip) excluded.add(part);
      else excluded.delete(part);
      el.classList.toggle('skipped', skip);
      el.setAttribute('aria-pressed', String(!skip));
      const sub = el.querySelector('.sub') as HTMLElement;
      const qty = el.querySelector('.usual-qty') as HTMLElement;
      sub.textContent = skip ? 'דילגת השבוע' : sub.dataset.label!;
      qty.textContent = skip ? '×0' : `×${el.dataset.qty}`;
      updateTotal();
    };
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }
  updateTotal();

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const r = await api.post<{ added: number }>('/api/reorder/add-all', { exclude: [...excluded] });
      await refreshCartCount();
      if (!r.added) {
        toast('אף מוצר מהסל הרגיל אינו זמין כעת', 'error');
        updateTotal();
        return;
      }
      buzz();
      toast(`${r.added} מוצרים נוספו לעגלה`, 'ok');
      location.hash = '#cart';
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : String(ex), 'error');
      updateTotal();
    }
  });
}

// One usual-basket row, pre-ticked. data-* carry what the total/add logic needs.
function usualRow(s: Suggestion): string {
  const label = unitsLabel(s);
  return `
    <div class="usual-item" role="button" tabindex="0" aria-pressed="true" data-part="${escapeAttr(s.partname)}" data-price="${s.price}" data-qty="${s.quantity}">
      <span class="usual-check" aria-hidden="true">✓</span>
      <div class="usual-info">
        <div class="nm">${escapeHtml(s.partdes || s.partname)}</div>
        <div class="sub" data-label="${escapeAttr(label)}">${escapeHtml(label)}</div>
      </div>
      <span class="usual-qty">×${s.quantity}</span>
    </div>`;
}

// "N ארגזים" when the usual qty is whole boxes; otherwise plain units.
function unitsLabel(s: { quantity: number; box_size: number }): string {
  if (s.box_size > 1 && s.quantity % s.box_size === 0) {
    const b = s.quantity / s.box_size;
    return `${b} ${b === 1 ? 'ארגז' : 'ארגזים'}`;
  }
  return `${s.quantity} יח׳`;
}

function statusLabel(s: string): string {
  return { submitted: 'נשלחה', submitting: 'בשליחה', failed: 'נכשלה' }[s] || s;
}
