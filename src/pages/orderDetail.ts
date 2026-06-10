import { api } from '../api.js';
import { escapeHtml } from '../format.js';

interface OrderLine {
  partname: string;
  pdes: string | null;
  quantity: number;
  price: number;
}

interface OrderDetail {
  id: number;
  priority_ordname: string | null;
  status: string;
  total: number | null;
  details: string | null;
  created_at: string;
  submitted_at: string | null;
  error: string | null;
  lines: OrderLine[];
}

export async function renderOrderDetail(shell: HTMLElement, id: number): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const o = await api.get<OrderDetail>(`/api/orders/${id}`);
    shell.innerHTML = `
      <div class="card">
        <h1 style="margin-top:0">הזמנה #${o.id}</h1>
        <p class="muted">מס׳ Priority: <b>${escapeHtml(o.priority_ordname || '-')}</b> · נוצרה ב-${new Date(
      o.created_at + 'Z'
    ).toLocaleString('he-IL')}</p>
        ${o.details ? `<p>הערה: ${escapeHtml(o.details)}</p>` : ''}
        ${o.error ? `<p class="error">שגיאה: ${escapeHtml(o.error)}</p>` : ''}
        <table style="width:100%;border-collapse:collapse;margin-top:1rem">
          <thead>
            <tr style="text-align:right;border-bottom:1px solid var(--border)">
              <th style="padding:0.5rem">מוצר</th>
              <th style="padding:0.5rem">כמות</th>
              <th style="padding:0.5rem">מחיר</th>
              <th style="padding:0.5rem">סה״כ</th>
            </tr>
          </thead>
          <tbody>
            ${o.lines
              .map(
                (l) => `
              <tr style="border-bottom:1px solid var(--border)">
                <td style="padding:0.5rem">
                  <div>${escapeHtml(l.pdes || l.partname)}</div>
                  <div class="muted" style="font-size:0.85rem">${escapeHtml(l.partname)}</div>
                </td>
                <td style="padding:0.5rem">${l.quantity}</td>
                <td style="padding:0.5rem">₪${l.price.toFixed(2)}</td>
                <td style="padding:0.5rem;font-weight:700">₪${(l.price * l.quantity).toFixed(2)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
          <tfoot>
            <tr><td colspan="3" style="padding:0.75rem;text-align:left;font-weight:700">סה״כ:</td>
                <td style="padding:0.75rem;font-weight:700;color:var(--brand)">₪${(o.total ?? 0).toFixed(2)}</td></tr>
          </tfoot>
        </table>
        <div style="margin-top:1rem;display:flex;gap:0.5rem">
          <button id="reorder">הזמן שוב</button>
          <a href="#orders" style="margin-inline-start:auto;align-self:center">← חזרה</a>
        </div>
      </div>
    `;
    const reorder = shell.querySelector('#reorder') as HTMLButtonElement;
    reorder.addEventListener('click', async () => {
      try {
        const r = await api.post<{ lines: number }>(`/api/orders/${id}/reorder`);
        if (!r.lines) {
          alert('אף מוצר מההזמנה הזו אינו זמין כעת להזמנה חוזרת');
          return;
        }
        location.hash = '#cart';
      } catch (ex) {
        alert(ex instanceof Error ? ex.message : String(ex));
      }
    });
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}
