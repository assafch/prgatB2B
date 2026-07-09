// Admin orders — full screen (Stage 8c / Task 9): three tabs.
// דורש טיפול = today's recovery queue (stuck orders + failed Priority receipts,
// the Task 2 v1 promoted to a tab and joined by the receipts-retry action).
// פתוחות / הכול = quiet read-only rows over GET /api/admin/orders?scope=.
import { api } from '../api.js';
import { escapeHtml, formatDate, formatMoney } from '../format.js';
import { toast } from '../ui.js';
import { refreshOpsBadges } from './adminShell.js';

interface StuckOrder { id: number; custname: string; status: string; total: number; payment_status: string; created_at: string; error?: string }

interface OrderRow {
  id: number; custname: string; cust_desc: string | null; status: string; payment_status: string; total: number;
  payment_required_amount: number | null; priority_ordname: string | null; error?: string | null; created_at: string;
}

type OrdersTab = 'attention' | 'open' | 'all';

// Module-level so the tab pills can be re-clicked without re-fetching everything,
// but it's reset to the daily default every time this screen is (re)mounted —
// unlike Payments' remembered tab, Orders should always open on what needs eyes today.
let tab: OrdersTab = 'attention';

export async function renderAdminOrders(c: HTMLElement): Promise<void> {
  // Always mounts on the daily-default tab — see the module comment on `tab`.
  tab = 'attention';
  c.innerHTML = `
    <div class="adm-head"><h1 class="adm-title">הזמנות</h1></div>
    <div class="pay-tabs">
      <button type="button" data-t="attention" class="sel">דורש טיפול<span class="pay-tab-badge" id="ord-attn-badge" hidden>0</span></button>
      <button type="button" data-t="open">פתוחות</button>
      <button type="button" data-t="all">הכול</button>
    </div>
    <div id="ord-body"><div class="adm-empty">טוען…</div></div>`;

  c.querySelectorAll<HTMLButtonElement>('.pay-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.t as OrdersTab;
      if (t === tab) return;
      tab = t;
      c.querySelectorAll('.pay-tabs button').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      void loadTab(c);
    });
  });

  await loadTab(c);
}

async function fetchAttention(): Promise<{ stuck: StuckOrder[]; failedCount: number }> {
  const [stuckRes, failedRes] = await Promise.all([
    api.get<{ orders: StuckOrder[] }>('/api/admin/orders/stuck'),
    api.get<{ count: number; receipts: unknown[] }>('/api/admin/receipts/failed'),
  ]);
  return { stuck: stuckRes.orders, failedCount: failedRes.count };
}

function setAttnBadge(c: HTMLElement, n: number): void {
  const badge = c.querySelector('#ord-attn-badge') as HTMLElement | null;
  if (!badge) return;
  badge.textContent = String(n);
  badge.hidden = n === 0;
}

async function loadTab(c: HTMLElement): Promise<void> {
  const body = c.querySelector('#ord-body') as HTMLElement;
  body.innerHTML = `<div class="adm-empty">טוען…</div>`;

  if (tab === 'attention') {
    try {
      const { stuck, failedCount } = await fetchAttention();
      setAttnBadge(c, stuck.length + failedCount);
      renderAttentionTab(c, body, stuck, failedCount);
    } catch (ex) {
      body.innerHTML = `<div class="adm-card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
    }
    return;
  }

  await renderListTab(body, tab);
  // Keep the דורש-טיפול pill's badge current even while browsing another tab.
  // Decoration-adjacent — never let it error the visible list.
  fetchAttention()
    .then(({ stuck, failedCount }) => setAttnBadge(c, stuck.length + failedCount))
    .catch(() => { /* badge only */ });
}

// ---- דורש טיפול tab: stuck-order recovery cards + one failed-receipts card ----

// Raw Priority/network errors get translated to plain words where recognizable;
// anything else is the operator's own system, so show it verbatim.
function errorStripHtml(error?: string): string {
  if (!error) return '';
  const isNetworkish = /timeout|ECONN|ETIMEDOUT|fetch failed|network/i.test(error);
  if (isNetworkish) {
    return `<div class="stuck-error">✕ שגיאת תקשורת עם Priority<small class="stuck-error-raw">${escapeHtml(error)}</small></div>`;
  }
  return `<div class="stuck-error">✕ ${escapeHtml(error)}</div>`;
}

function stuckCardHtml(o: StuckOrder): string {
  return `
    <div class="ops-card stuck-card">
      <div class="stuck-head"><b>#${o.id} · ${escapeHtml(o.custname)}</b><span class="money">${formatMoney(o.total)}</span></div>
      ${errorStripHtml(o.error)}
      <div class="stuck-actions"><button type="button" class="adm-btn-primary" data-resend="${o.id}">↻ שלח שוב ל-Priority</button></div>
    </div>`;
}

function receiptsCardHtml(failedCount: number): string {
  return `
    <div class="ops-card stuck-card">
      <div class="stuck-head"><b>קבלת Priority נכשלה ×${failedCount}</b></div>
      <div class="stuck-actions"><button type="button" class="adm-btn-primary" id="ord-receipts-retry">↻ רשום קבלה שוב</button></div>
    </div>`;
}

function renderAttentionTab(c: HTMLElement, body: HTMLElement, stuck: StuckOrder[], failedCount: number): void {
  if (stuck.length === 0 && failedCount === 0) {
    body.innerHTML = `<div class="adm-card adm-empty">אין הזמנות תקועות 🎉<br><small>הזמנות ששולמו ולא הגיעו ל-Priority, וקבלות Priority שנכשלו, יופיעו כאן עם כפתור טיפול.</small></div>`;
    return;
  }

  body.innerHTML = (failedCount > 0 ? receiptsCardHtml(failedCount) : '') + stuck.map(stuckCardHtml).join('');

  body.querySelectorAll<HTMLButtonElement>('[data-resend]').forEach((btn) => {
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const r = await api.post<{ ok: boolean; error?: string }>(`/api/admin/orders/${btn.dataset.resend}/resend`);
        if (r.ok) { toast('נשלח מחדש ✓', 'ok'); await loadTab(c); void refreshOpsBadges(); }
        else { toast(r.error || 'השליחה נכשלה', 'error'); btn.disabled = false; }
      } catch (ex) { toast(ex instanceof Error ? ex.message : 'השליחה נכשלה', 'error'); btn.disabled = false; }
    };
  });

  const retryBtn = body.querySelector('#ord-receipts-retry') as HTMLButtonElement | null;
  retryBtn?.addEventListener('click', async () => {
    retryBtn.disabled = true;
    try {
      const r = await api.post<{ ok: boolean; remaining: number }>('/api/admin/receipts/retry');
      toast(r.remaining === 0 ? '✓ כל הקבלות נרשמו' : `נותרו ${r.remaining} קבלות שנכשלו`, 'ok');
      await loadTab(c);
      void refreshOpsBadges();
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'הרישום נכשל', 'error');
      retryBtn.disabled = false;
    }
  });
}

// ---- פתוחות / הכול tabs: quiet read-only rows ----

// Local SQLite timestamps are naive UTC ("2026-05-27 12:00:00"); append Z
// (same convention as leadTimeAgo in admin.ts / formatDateTime in format.ts).
function relativeDate(s: string): string {
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'היום';
  if (days === 1) return 'אתמול';
  if (days < 7) return `לפני ${days} ימים`;
  return formatDate(s);
}

function statusPillHtml(o: OrderRow): string {
  if (o.priority_ordname != null) return `<span class="cust-pill pill-on">נשלח ✓</span>`;
  if (o.payment_status === 'pending_payment') return `<span class="cust-pill pill-net">ממתין לתשלום</span>`;
  if (o.status === 'failed') return `<span class="cust-pill pill-new">נכשל</span>`;
  return `<span class="cust-pill pill-off">בתהליך</span>`;
}

function orderRowHtml(o: OrderRow): string {
  return `
    <div class="ord-grid">
      <span class="muted tabnum">#${o.id}</span>
      <span class="cust-name">${o.cust_desc ? `${escapeHtml(o.cust_desc)} <span class="muted tabnum">${escapeHtml(o.custname)}</span>` : escapeHtml(o.custname)}</span>
      <span class="muted">${escapeHtml(relativeDate(o.created_at))}</span>
      <span>${statusPillHtml(o)}</span>
      <span class="money">${formatMoney(o.total)}</span>
    </div>`;
}

async function renderListTab(body: HTMLElement, scope: 'open' | 'all'): Promise<void> {
  try {
    const { orders } = await api.get<{ orders: OrderRow[] }>(`/api/admin/orders?scope=${scope}`);
    if (orders.length === 0) {
      body.innerHTML = `<div class="adm-card adm-empty">${scope === 'open' ? 'אין הזמנות פתוחות' : 'עדיין אין הזמנות'}</div>`;
      return;
    }
    body.innerHTML = `
      <div class="adm-card" style="padding:0;overflow:hidden">
        <div class="ord-grid ord-grid-head"><span>#</span><span>לקוח</span><span>תאריך</span><span>סטטוס</span><span>סכום</span></div>
        ${orders.map(orderRowHtml).join('')}
      </div>`;
  } catch (ex) {
    body.innerHTML = `<div class="adm-card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}
