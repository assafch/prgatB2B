import { api } from '../api.js';
import { formatMoney, formatDate, formatDateTime, escapeHtml } from '../format.js';

interface OrderRow {
  id: number;
  priority_ordname: string | null;
  status: string;
  total: number | null;
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

export async function renderOrders(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען הזמנות…</div>`;
  try {
    // Local orders are portal-submitted; Priority orders are the full ERP history
    // (incl. orders placed by phone/agent). Priority may be slow → fetch in parallel,
    // and it degrades to [] on its own if unreachable.
    const [{ orders }, priority] = await Promise.all([
      api.get<{ orders: OrderRow[] }>('/api/orders'),
      api
        .get<{ orders: PriorityOrder[] }>('/api/orders/priority')
        .catch(() => ({ orders: [] as PriorityOrder[] })),
    ]);

    if (orders.length === 0 && priority.orders.length === 0) {
      shell.innerHTML = `
        <div class="card empty">
          <h2>אין הזמנות עדיין</h2>
          <p><a href="#catalog">צא לקטלוג והזמן</a></p>
        </div>`;
      return;
    }

    shell.innerHTML = `
      ${localOrdersCard(orders)}
      ${priorityOrdersCard(priority.orders)}
    `;
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}

function localOrdersCard(orders: OrderRow[]): string {
  if (orders.length === 0) return '';
  return `
    <div class="card">
      <div class="section-title"><h1 style="margin:0">הזמנות מהפורטל</h1><span class="count">${orders.length}</span></div>
      <table class="table">
        <thead>
          <tr>
            <th>תאריך</th>
            <th>מס׳ Priority</th>
            <th>סטטוס</th>
            <th>סכום</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${orders
            .map(
              (o) => `
            <tr>
              <td>${formatDateTime(o.created_at)}</td>
              <td>${escapeHtml(o.priority_ordname || '-')}</td>
              <td>${statusLabel(o.status)}</td>
              <td class="amount">${o.total != null ? formatMoney(o.total) : '-'}</td>
              <td><a href="#orders/${o.id}">פרטים</a></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function priorityOrdersCard(orders: PriorityOrder[]): string {
  if (orders.length === 0) return '';
  return `
    <div class="card">
      <div class="section-title"><h2 style="margin:0">כל ההזמנות (Priority)</h2><span class="count">${orders.length}</span></div>
      <table class="table">
        <thead>
          <tr>
            <th>תאריך</th>
            <th>מס׳ הזמנה</th>
            <th>תיאור</th>
            <th>סטטוס</th>
          </tr>
        </thead>
        <tbody>
          ${orders
            .map(
              (o) => `
            <tr>
              <td>${formatDate(o.CURDATE)}</td>
              <td>${escapeHtml(o.ORDNAME || '-')}</td>
              <td>${escapeHtml(o.CDES || o.DETAILS || '-')}</td>
              <td>${escapeHtml(o.ORDSTATUSDES || '-')}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}

function statusLabel(s: string): string {
  return (
    {
      submitting: '<span class="muted">נשלח…</span>',
      submitted: '<span class="ok">נשלח ✓</span>',
      failed: '<span class="error">נכשל</span>',
      draft: 'טיוטה',
    }[s] || escapeHtml(s)
  );
}
