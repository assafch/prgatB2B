// Admin orders — v1: the stuck-order recovery queue (moved out of Settings).
// Task 9 (8c) upgrades this to the full tabbed screen (דורש טיפול/פתוחות/הכול).
import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshOpsBadges } from './adminShell.js';

interface StuckOrder { id: number; custname: string; status: string; total: number; payment_status: string; created_at: string; error?: string }

export async function renderAdminOrders(c: HTMLElement): Promise<void> {
  c.innerHTML = `
    <div class="adm-head"><h1 class="adm-title">הזמנות</h1></div>
    <div id="ord-stuck"><div class="muted">טוען…</div></div>`;
  await loadStuck(c.querySelector('#ord-stuck') as HTMLElement);
}

async function loadStuck(el: HTMLElement): Promise<void> {
  try {
    const { orders } = await api.get<{ orders: StuckOrder[] }>('/api/admin/orders/stuck');
    if (orders.length === 0) {
      el.innerHTML = `<div class="adm-card adm-empty">אין הזמנות תקועות 🎉<br><small>הזמנות ששולמו ולא הגיעו ל-Priority יופיעו כאן עם כפתור שליחה חוזרת.</small></div>`;
      return;
    }
    el.innerHTML = orders.map(o => `
      <div class="ops-card stuck-card">
        <div class="stuck-head"><b>#${o.id} · ${escapeHtml(o.custname)}</b><span class="money">₪${(o.total ?? 0).toLocaleString('he-IL')}</span></div>
        ${o.error ? `<div class="stuck-error">✕ ${escapeHtml(o.error)}</div>` : ''}
        <div class="stuck-actions"><button class="adm-btn-primary" data-resend="${o.id}">↻ שלח שוב ל-Priority</button></div>
      </div>`).join('');
    el.querySelectorAll<HTMLButtonElement>('[data-resend]').forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const r = await api.post<{ ok: boolean; error?: string }>(`/api/admin/orders/${btn.dataset.resend}/resend`);
          if (r.ok) { toast('נשלח מחדש ✓', 'ok'); await loadStuck(el); void refreshOpsBadges(); }
          else { toast(r.error || 'השליחה נכשלה', 'error'); btn.disabled = false; }
        } catch (ex) { toast(ex instanceof Error ? ex.message : 'השליחה נכשלה', 'error'); btn.disabled = false; }
      };
    });
  } catch (ex) {
    el.innerHTML = `<div class="adm-card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}
