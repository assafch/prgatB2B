import { api } from '../api.js';
import { formatMoney, formatDate, escapeHtml } from '../format.js';
import { skeleton, errorState } from '../ui.js';

interface InvoiceDetail {
  ivnum: string;
  date: string | null;
  total: number;
  beforeVat: number | null;
  vat: number | null;
  ordname: string | null;
  status: string | null;
  items: Array<{ partname: string | null; pdes: string | null; quantity: number; price: number | null; lineTotal: number | null }>;
}

export async function renderInvoiceDetail(shell: HTMLElement, ivnum: string): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(4)}</div>`;
  let d: InvoiceDetail;
  try {
    d = await api.get<InvoiceDetail>(`/api/invoices/${encodeURIComponent(ivnum)}`);
  } catch (ex) {
    shell.innerHTML = '';
    shell.appendChild(errorState(ex instanceof Error ? ex.message : String(ex), () => renderInvoiceDetail(shell, ivnum)));
    return;
  }

  shell.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline">
        <h1 style="margin:0">חשבונית ${escapeHtml(d.ivnum)}</h1>
        <a href="#invoices">← חזרה</a>
      </div>
      <div class="muted" style="margin-top:0.25rem">${formatDate(d.date)}${d.ordname ? ' · הזמנה ' + escapeHtml(d.ordname) : ''}</div>

      <div style="margin-top:1rem">
        ${d.items
          .map(
            (l) => `
          <div class="dash-row" style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
            <div class="grow">
              <div style="font-weight:600">${escapeHtml(l.pdes || l.partname || '-')}</div>
              <div class="muted" style="font-size:0.82rem">${l.quantity} יח׳${l.price != null ? ' × ' + formatMoney(l.price) : ''}</div>
            </div>
            <div style="font-weight:700">${l.lineTotal != null ? formatMoney(l.lineTotal) : '-'}</div>
          </div>`
          )
          .join('') || '<div class="muted">אין שורות פריטים</div>'}
      </div>

      <div style="margin-top:1rem;border-top:2px solid var(--border);padding-top:0.6rem">
        ${d.beforeVat != null ? `<div class="dash-row"><span class="grow muted">לפני מע״מ</span><span>${formatMoney(d.beforeVat)}</span></div>` : ''}
        ${d.vat != null ? `<div class="dash-row"><span class="grow muted">מע״מ</span><span>${formatMoney(d.vat)}</span></div>` : ''}
        <div class="dash-row" style="font-weight:900;font-size:1.15rem;margin-top:0.3rem"><span class="grow">סה״כ</span><span style="color:var(--brand)">${formatMoney(d.total)}</span></div>
      </div>
    </div>
  `;
}
