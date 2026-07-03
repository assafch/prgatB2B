// Admin dashboard — "מה צריך אותי עכשיו?": the דורש-טיפול rail first, then quiet
// KPIs, activity, and the one allowed sparkline (revenue). Rail + KPI base data
// are local; Priority-backed tiles fill in async and fail soft.
import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshOpsBadges } from './adminShell.js';

interface Stats { users: number; orders: number; orders_submitted: number; leads: number; invites_pending: number; products: number }
interface Queues {
  stuckOrders: { count: number; sum: number };
  failedReceipts: { count: number; sum: number };
  pendingChecks: { count: number; sum: number; oldest: string | null };
  newLeads: { count: number; latestName: string | null; latestAt: string | null };
}
interface Activity { kind: 'order' | 'check' | 'card' | 'lead'; at: string; ref: string; label: string; amount: number | null }

const nis = (n: number): string => '₪' + Math.round(n).toLocaleString('he-IL');

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'בוקר טוב' : h < 18 ? 'צהריים טובים' : 'ערב טוב';
}

// KPI count-up — the one allowed load animation besides drawer slide.
function countUp(el: HTMLElement, target: number, fmt: (n: number) => string): void {
  const t0 = performance.now();
  const step = (t: number): void => {
    const p = Math.min(1, (t - t0) / 500);
    el.textContent = fmt(target * (1 - Math.pow(1 - p, 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function opsCard(count: number, title: string, context: string, action: string, opts: { href?: string; id?: string; err?: boolean } = {}): string {
  const btn = opts.href
    ? `<a class="ops-action" href="${opts.href}">${action}</a>`
    : `<button type="button" class="ops-action" id="${opts.id}">${action}</button>`;
  return `<div class="ops-card">
    <div class="ops-count${opts.err ? ' err' : ''}">${count}</div>
    <div><div class="ops-title">${title}</div><div class="ops-context">${context}</div></div>
    ${btn}
  </div>`;
}

function sparkline(values: number[]): string {
  if (values.length < 2) return '<div class="muted" style="font-size:11px">אין מספיק נתונים</div>';
  const w = 220, h = 74, max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) => {
    // RTL: newest month renders leftmost, matching the flex label row below.
    const x = w - ((i / (values.length - 1)) * (w - 8) + 4);
    const y = h - 6 - ((v - min) / (max - min || 1)) * (h - 12);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const [lx, ly] = pts[pts.length - 1].split(',');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px" aria-hidden="true">
    <polyline points="${pts.join(' ')}" fill="none" stroke="var(--brand)" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${lx}" cy="${ly}" r="3.5" fill="var(--brand)"/>
  </svg>`;
}

const ACT_ICON: Record<Activity['kind'], string> = { order: '🛒', check: '🧾', card: '💳', lead: '✦' };
const ACT_LABEL: Record<Activity['kind'], (a: Activity) => string> = {
  order: a => `הזמנה #${escapeHtml(a.ref)} · ${escapeHtml(a.label)}`,
  check: a => `צ׳ק · ${escapeHtml(a.label)}`,
  card: a => `תשלום בכרטיס · ${escapeHtml(a.label)}`,
  lead: a => `ליד חדש · ${escapeHtml(a.label)}`,
};

function when(at: string): string {
  const d = new Date(at.replace(' ', 'T') + 'Z');
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (mins < 60) return `לפני ${mins} דק׳`;
  if (mins < 60 * 24) return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
}

export async function renderAdminDashboard(c: HTMLElement): Promise<void> {
  const today = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  c.innerHTML = `
    <div class="adm-head">
      <div><h1 class="adm-title">${greeting()}, אסף</h1><div class="adm-meta">${today}</div></div>
      <div class="adm-head-actions">
        <button type="button" id="dash-sync" class="adm-btn-ghost">↻ סנכרן עכשיו</button>
        <a href="#admin/products" class="adm-btn-primary">+ מוצר חדש</a>
      </div>
    </div>
    <div class="ops-rail-head"><span>דורש טיפול</span><span id="ops-total" class="nav-badge" hidden></span></div>
    <div id="ops-rail" class="ops-rail"><div class="adm-card adm-empty">טוען…</div></div>
    <div id="kpi-grid" class="kpi-grid"></div>
    <div class="adm-two-col">
      <div class="adm-card"><div class="adm-card-head"><b>פעילות אחרונה</b></div><div id="dash-activity" class="muted">טוען…</div></div>
      <div class="adm-card"><div class="adm-card-head"><b>הכנסות · 6 חודשים</b><a href="#admin/analytics">דוחות ←</a></div><div id="dash-revenue"><span class="muted" style="font-size:11px">טוען…</span></div></div>
    </div>`;

  (c.querySelector('#dash-sync') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true; btn.textContent = 'מסנכרן…';
    try {
      const r = await api.post<{ products: number; families: number }>('/api/admin/catalog/refresh');
      toast(`✓ נטענו ${r.products} מוצרים`, 'ok');
    } catch (ex) { toast(ex instanceof Error ? ex.message : 'הסנכרון נכשל', 'error'); }
    btn.disabled = false; btn.textContent = '↻ סנכרן עכשיו';
  };

  await renderRailAndActivity(c);
  void renderKpisAndRevenue(c); // Priority-dependent parts fill in async
}

async function renderRailAndActivity(c: HTMLElement): Promise<void> {
  const rail = c.querySelector('#ops-rail') as HTMLElement;
  try {
    const { queues, activity } = await api.get<{ queues: Queues; activity: Activity[] }>('/api/admin/ops-queue');
    const total = queues.stuckOrders.count + queues.failedReceipts.count + queues.pendingChecks.count + queues.newLeads.count;
    const totalEl = c.querySelector('#ops-total') as HTMLElement;
    totalEl.textContent = String(total); totalEl.hidden = total === 0;

    if (total === 0) {
      rail.innerHTML = `<div class="adm-card adm-empty" style="grid-column:1/-1">הכול נקי — אין פריטים שממתינים לך 🎉</div>`;
    } else {
      const oldest = queues.pendingChecks.oldest ? new Date(queues.pendingChecks.oldest.replace(' ', 'T') + 'Z').toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) : '';
      rail.innerHTML = [
        queues.stuckOrders.count ? opsCard(queues.stuckOrders.count, 'הזמנות ששולמו וטרם נשלחו', `${nis(queues.stuckOrders.sum)} ממתינים ל-Priority`, 'שלח ל-Priority', { id: 'ops-resend-all' }) : '',
        queues.pendingChecks.count ? opsCard(queues.pendingChecks.count, 'צ׳קים ממתינים לאישור', `${nis(queues.pendingChecks.sum)}${oldest ? ' · הישן מ-' + oldest : ''}`, 'עבור לאישור', { href: '#admin/payments' }) : '',
        queues.failedReceipts.count ? opsCard(queues.failedReceipts.count, 'קבלת Priority נכשלה', nis(queues.failedReceipts.sum), 'נסה שוב', { id: 'ops-retry-receipts', err: true }) : '',
        queues.newLeads.count ? opsCard(queues.newLeads.count, 'לידים חדשים', queues.newLeads.latestName ? `אחרון: ${escapeHtml(queues.newLeads.latestName)}` : '', 'פתח לידים', { href: '#admin/leads' }) : '',
      ].filter(Boolean).join('');
    }

    // One action, done in place: resend every stuck order (idempotent server-side via BOOKNUM).
    (rail.querySelector('#ops-resend-all') as HTMLButtonElement | null)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true; btn.textContent = 'שולח…';
      try {
        const { orders } = await api.get<{ orders: Array<{ id: number }> }>('/api/admin/orders/stuck');
        let ok = 0, fail = 0;
        for (const o of orders) {
          try { const r = await api.post<{ ok: boolean }>(`/api/admin/orders/${o.id}/resend`); r.ok ? ok++ : fail++; }
          catch { fail++; }
        }
        toast(fail === 0 ? `✓ ${ok} הזמנות נשלחו ל-Priority` : `${ok} נשלחו, ${fail} נכשלו — ראה מסך הזמנות`, fail === 0 ? 'ok' : 'error');
      } finally { await renderRailAndActivity(c); void refreshOpsBadges(); }
    });

    (rail.querySelector('#ops-retry-receipts') as HTMLButtonElement | null)?.addEventListener('click', async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true; btn.textContent = 'מנסה…';
      try {
        const r = await api.post<{ ok: boolean; remaining: number }>('/api/admin/receipts/retry');
        toast(r.remaining === 0 ? '✓ כל הקבלות נרשמו' : `נותרו ${r.remaining} קבלות שנכשלו`, r.remaining === 0 ? 'ok' : 'error');
      } catch (ex) { toast(ex instanceof Error ? ex.message : 'הניסיון נכשל', 'error'); }
      finally { await renderRailAndActivity(c); void refreshOpsBadges(); }
    });

    const act = c.querySelector('#dash-activity') as HTMLElement;
    act.classList.remove('muted');
    act.innerHTML = activity.length === 0
      ? `<div class="adm-empty">עדיין אין פעילות</div>`
      : activity.map(a => `
        <div class="act-row">
          <span class="act-icon">${ACT_ICON[a.kind]}</span>
          <span>${ACT_LABEL[a.kind](a)}</span>
          ${a.amount != null ? `<span class="money" style="font-size:12.5px">${nis(a.amount)}</span>` : ''}
          <span class="act-when">${when(a.at)}</span>
        </div>`).join('');
  } catch (ex) {
    rail.innerHTML = `<div class="adm-card error" style="grid-column:1/-1">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}

async function renderKpisAndRevenue(c: HTMLElement): Promise<void> {
  const grid = c.querySelector('#kpi-grid') as HTMLElement;
  const tile = (id: string, label: string): string =>
    `<div class="kpi-tile"><div class="kpi-label">${label}</div><div class="kpi-value" id="${id}">—</div><div class="kpi-delta" id="${id}-d"></div></div>`;
  grid.innerHTML = [
    tile('kpi-rev', 'הכנסות החודש'), tile('kpi-open', 'הזמנות פתוחות'), tile('kpi-debt', 'חוב פתוח כולל'),
    tile('kpi-cust', 'לקוחות רשומים'), tile('kpi-sent', 'נשלחו ל-Priority'), tile('kpi-prod', 'מוצרים בקטלוג'),
  ].join('');
  const set = (id: string, v: number, fmt: (n: number) => string, delta?: { text: string; cls?: string }): void => {
    const el = c.querySelector('#' + id) as HTMLElement | null;
    if (!el) return; // user navigated away mid-fetch
    countUp(el, v, n => fmt(Math.round(n)));
    if (delta) { const d = c.querySelector(`#${id}-d`) as HTMLElement; d.textContent = delta.text; d.className = 'kpi-delta' + (delta.cls ? ' ' + delta.cls : ''); }
  };

  try {
    const s = await api.get<Stats>('/api/admin/dashboard');
    set('kpi-cust', s.users, String);
    set('kpi-prod', s.products, String);
    const pct = s.orders > 0 ? Math.round((s.orders_submitted / s.orders) * 100) : 0;
    set('kpi-sent', s.orders_submitted, String, { text: `${pct}% מההזמנות` });
    set('kpi-open', Math.max(0, s.orders - s.orders_submitted), String, { text: `מתוך ${s.orders} סה״כ` });
  } catch { /* local stats failed — leave dashes */ }

  // Priority-backed tiles + sparkline: fail soft, never block the rail.
  try {
    const { revenue } = await api.get<{ revenue: Array<{ month: string; total: number; count: number }> }>('/api/admin/analytics/revenue');
    if (revenue.length > 0) {
      const cur = revenue[revenue.length - 1], prev = revenue[revenue.length - 2];
      const deltaPct = prev && prev.total > 0 ? Math.round(((cur.total - prev.total) / prev.total) * 100) : null;
      set('kpi-rev', cur.total, n => nis(n), deltaPct == null ? undefined : { text: `${deltaPct >= 0 ? '+' : ''}${deltaPct}% מול החודש הקודם`, cls: deltaPct >= 0 ? 'up' : 'warn' });
      const last6 = revenue.slice(-6);
      (c.querySelector('#dash-revenue') as HTMLElement).innerHTML =
        sparkline(last6.map(r => r.total)) +
        `<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted)">${last6.map(r => `<span>${escapeHtml(r.month)}</span>`).join('')}</div>`;
    } else {
      (c.querySelector('#dash-revenue') as HTMLElement).innerHTML = `<div class="adm-empty">אין נתוני הכנסות (Priority לא זמין)</div>`;
    }
  } catch {
    const el = c.querySelector('#dash-revenue') as HTMLElement | null;
    if (el) el.innerHTML = `<div class="adm-empty">אין נתוני הכנסות (Priority לא זמין)</div>`;
  }
  try {
    const { debtors } = await api.get<{ debtors: Array<{ debit: number }> }>('/api/admin/analytics/debtors');
    const sum = debtors.reduce((s, d) => s + (Number(d.debit) || 0), 0);
    set('kpi-debt', sum, n => nis(n), { text: `${debtors.length} לקוחות` });
  } catch { /* leave dash */ }
}
