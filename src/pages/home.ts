import { api } from '../api.js';
import { formatMoney, formatDateTime, escapeHtml, escapeAttr } from '../format.js';
import { toast, statusChip, skeleton, errorState } from '../ui.js';
import { state, refreshCartCount } from '../main.js';

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
interface HomeData {
  custname: string;
  custDesc: string | null;
  balance: { openTotal: number; openCount: number; obligo: number | null; creditLimit: number | null };
  priorityOk: boolean;
  balanceOk: boolean;
  lastOrder: LastOrder | null;
  suggestions: Suggestion[];
  features: { payments: boolean; checkPayment: boolean };
  banner: { text: string } | null;
  maintenance: { enabled: boolean; message: string };
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

  const name = d.custDesc || state.me?.cust_desc || '';
  const owing = d.balance.openTotal > 0;

  // Debt headline. When the balance form is unreachable/not-API-enabled we can't
  // trust the number, so we show an honest "unavailable" instead of a misleading ₪0.
  let debtCard: string;
  if (!d.balanceOk) {
    debtCard = `
      <div class="card debt-card">
        <div class="amount" style="color:var(--muted);font-size:1.4rem">לא זמין כעת</div>
        <div class="label">נתוני החוב יתעדכנו בקרוב</div>
      </div>`;
  } else if (owing) {
    debtCard = `
      <div class="card debt-card owing">
        <div class="label">יתרה לתשלום${d.balance.openCount > 0 ? ` (${d.balance.openCount} חשבוניות פתוחות)` : ''}</div>
        <div class="amount">${formatMoney(d.balance.openTotal)}</div>
        ${d.features.checkPayment ? `<a class="pay-btn" href="#pay/check" style="display:inline-flex;align-items:center;gap:0.4rem;justify-content:center">📸 תשלום בצ׳ק</a>` : ''}
        ${d.features.payments ? `<button class="pay-btn" id="pay-debt" style="margin-top:0.5rem">לתשלום בכרטיס אשראי</button>` : ''}
        <div style="margin-top:0.6rem"><a href="#invoices">צפייה בחשבוניות הפתוחות</a></div>
      </div>`;
  } else if (d.lastOrder) {
    debtCard = `
      <div class="card debt-card clear">
        <div class="amount">✓ אין חוב פתוח</div>
        <div class="label">כל החשבוניות שולמו — כל הכבוד!</div>
      </div>`;
  } else {
    // First-time customer with no history — welcome, don't congratulate.
    debtCard = `
      <div class="card debt-card clear">
        <div class="amount">👋 ברוכים הבאים</div>
        <div class="label">אין חשבוניות פתוחות — הזמינו עכשיו דרך הקטלוג</div>
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

  // "Usual basket" rail.
  let suggestionCard = '';
  if (d.suggestions.length > 0) {
    suggestionCard = `
      <div class="sec-head"><h2>הסל הרגיל שלך</h2></div>
      <div class="card">
        <div class="muted" style="font-size:0.88rem;margin-bottom:0.5rem">המוצרים שאתה מזמין הכי הרבה — בכמות הרגילה</div>
        <div class="rail">
          ${d.suggestions
            .map(
              (s) => `
            <div class="rail-item">
              <div class="thumb">${s.image_url ? `<img src="${escapeAttr(s.image_url)}" alt=""/>` : 'אין תמונה'}</div>
              <div class="nm">${escapeHtml(s.partdes || s.partname)}</div>
              <div class="pr">${formatMoney(s.price)}</div>
            </div>`
            )
            .join('')}
        </div>
        <button id="add-usual" style="width:100%;margin-top:0.75rem">הוסף את הסל הרגיל לעגלה</button>
      </div>`;
  }

  const quickActions = `
    <div class="dash-actions">
      <a class="dash-action" href="#catalog"><span class="ico">🛍️</span><span>הזמנה חדשה</span><span class="sub">עיון בקטלוג</span></a>
      <a class="dash-action" href="#invoices"><span class="ico">🧾</span><span>חשבוניות</span><span class="sub">מסמכים ויתרה</span></a>
      <a class="dash-action" href="#orders"><span class="ico">📦</span><span>ההזמנות שלי</span><span class="sub">מעקב סטטוס</span></a>
      <a class="dash-action" href="#account"><span class="ico">👤</span><span>החשבון שלי</span><span class="sub">פרטים והגדרות</span></a>
    </div>`;

  // Admin-controlled customer notices (rendered escaped — plain text only).
  const maintenanceCard = d.maintenance?.enabled
    ? `<div class="card" style="border:1px solid var(--err);background:#fdecec"><div style="font-weight:700;color:var(--err)">🛠️ ${escapeHtml(d.maintenance.message)}</div></div>`
    : '';
  const bannerCard =
    d.banner && d.banner.text
      ? `<div class="card" style="border:1px solid var(--brand);background:#fff6f6"><div>📣 ${escapeHtml(d.banner.text)}</div></div>`
      : '';

  shell.innerHTML = `
    <p class="dash-greet">שלום${name ? `, <b>${escapeHtml(name)}</b>` : ''} 👋</p>
    ${maintenanceCard}
    ${bannerCard}
    ${debtCard}
    ${utilBar}
    ${lastOrderCard}
    ${suggestionCard}
    ${quickActions}
  `;

  shell.querySelector('#pay-debt')?.addEventListener('click', () => {
    location.hash = '#pay/card';
  });

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

  shell.querySelector('#add-usual')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      const r = await api.post<{ added: number }>('/api/reorder/add-all');
      await refreshCartCount();
      if (!r.added) {
        toast('אף מוצר מהסל הרגיל אינו זמין כעת', 'error');
        btn.disabled = false;
        return;
      }
      toast(`${r.added} מוצרים נוספו לעגלה`, 'ok');
      location.hash = '#cart';
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : String(ex), 'error');
      btn.disabled = false;
    }
  });
}

function statusLabel(s: string): string {
  return { submitted: 'נשלחה', submitting: 'בשליחה', failed: 'נכשלה' }[s] || s;
}
