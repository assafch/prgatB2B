import { api } from '../api.js';
import { formatMoney, formatDate, formatDateTime, escapeHtml } from '../format.js';
import { statusChip, emptyState, skeleton, toast } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface OrderRow {
  id: number;
  priority_ordname: string | null;
  status: string;
  total: number | null;
  total_incl_vat: number | null;
  details: string | null;
  created_at: string;
  submitted_at: string | null;
}
interface PriorityOrder {
  ORDNAME?: string;
  CDES?: string;
  CURDATE?: string;
  ORDSTATUSDES?: string;
  DETAILS?: string;
}

const LOCAL_STATUS: Record<string, string> = {
  submitting: 'בשליחה',
  submitted: 'נשלחה',
  failed: 'נכשלה',
  draft: 'טיוטה',
  pending_payment: 'ממתין לתשלום',
};

export async function renderOrders(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(3)}</div>`;
  try {
    const [{ orders }, priority] = await Promise.all([
      api.get<{ orders: OrderRow[] }>('/api/orders'),
      api.get<{ orders: PriorityOrder[] }>('/api/orders/priority').catch(() => ({ orders: [] as PriorityOrder[] })),
    ]);

    if (orders.length === 0 && priority.orders.length === 0) {
      shell.innerHTML = `<div class="card">${emptyState('📦', 'אין הזמנות עדיין', 'צאו לקטלוג והזמינו', '#catalog', 'לקטלוג')}</div>`;
      return;
    }

    shell.innerHTML = `
      ${orders.length ? `<div class="sec-head"><h2>הזמנות מהפורטל</h2><span class="muted">${orders.length}</span></div>` : ''}
      ${orders.map(portalCard).join('')}
      ${priority.orders.length ? `<div class="sec-head"><h2>היסטוריית הזמנות</h2><span class="muted">${priority.orders.length}</span></div>` : ''}
      ${priority.orders.map(priorityCard).join('')}
    `;

    shell.querySelectorAll<HTMLButtonElement>('button.reorder').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const r = await api.post<{ lines: number }>(`/api/orders/${b.dataset.id}/reorder`);
          await refreshCartCount();
          if (!r.lines) {
            toast('אף מוצר מההזמנה אינו זמין כעת', 'error');
            b.disabled = false;
            return;
          }
          toast(`${r.lines} מוצרים נוספו לעגלה`, 'ok');
          location.hash = '#cart';
        } catch (ex) {
          toast(ex instanceof Error ? ex.message : String(ex), 'error');
          b.disabled = false;
        }
      });
    });
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}

function portalCard(o: OrderRow): string {
  const isPendingPayment = o.status === 'pending_payment';
  return `
    <div class="card dash-row" style="margin-bottom:0.6rem">
      <div class="grow">
        <div style="font-weight:700">${escapeHtml(o.priority_ordname || 'הזמנה #' + o.id)}</div>
        <div class="muted" style="font-size:0.83rem">${formatDateTime(o.created_at)} · ${o.total_incl_vat != null ? formatMoney(o.total_incl_vat) + ' כולל מע״מ' : '-'}</div>
        <div style="margin-top:0.35rem">${statusChip(LOCAL_STATUS[o.status] || o.status)}</div>
        ${isPendingPayment ? `<div style="margin-top:0.35rem"><a href="#order-pay/${o.id}" style="color:var(--warn);font-weight:700">שלם ←</a></div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:0.4rem">
        <a href="#orders/${o.id}" class="es-cta" style="padding:0.4rem 0.8rem;font-size:0.85rem;text-align:center">פרטים</a>
        <button class="ghost reorder" data-id="${o.id}" style="padding:0.4rem 0.8rem;font-size:0.85rem">הזמנה חוזרת</button>
      </div>
    </div>`;
}

function priorityCard(o: PriorityOrder): string {
  return `
    <div class="card dash-row" style="margin-bottom:0.6rem">
      <div class="grow">
        <div style="font-weight:700">${escapeHtml(o.ORDNAME || '-')}</div>
        <div class="muted" style="font-size:0.83rem">${formatDate(o.CURDATE)}${o.CDES || o.DETAILS ? ' · ' + escapeHtml(o.CDES || o.DETAILS || '') : ''}</div>
      </div>
      <div>${statusChip(o.ORDSTATUSDES || null)}</div>
    </div>`;
}
