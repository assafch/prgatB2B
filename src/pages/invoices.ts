import { api } from '../api.js';
import { formatMoney, formatDate, escapeHtml } from '../format.js';

interface OpenInvoiceView {
  date: string | null;
  docNo: string | null;
  amount: number;
  amountBeforeVat: number | null;
  vat: number | null;
  ordname: string | null;
  reference: string | null;
}

interface InvoiceView {
  ivnum: string;
  date: string | null;
  amount: number;
  beforeVat: number | null;
  vat: number | null;
  status: string | null;
  ordname: string | null;
  isCredit: boolean;
}

interface InvoicesResult {
  open: OpenInvoiceView[];
  history: InvoiceView[];
  summary: { openTotal: number; openCount: number };
  priorityOk: boolean;
}

export async function renderInvoices(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען חשבוניות…</div>`;
  try {
    const data = await api.get<InvoicesResult>('/api/invoices');

    if (!data.priorityOk) {
      shell.innerHTML = `
        <div class="card">
          <h1 style="margin-top:0">חשבוניות ויתרה</h1>
          <div class="empty">לא ניתן לטעון נתונים מ-Priority כרגע. נסו שוב מאוחר יותר.</div>
        </div>`;
      return;
    }

    shell.innerHTML = `
      ${balanceCard(data.summary)}
      ${openTable(data.open)}
      ${historyTable(data.history)}
    `;
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}

function balanceCard(summary: { openTotal: number; openCount: number }): string {
  const hasDebt = summary.openTotal > 0.005;
  return `
    <div class="card">
      <h1 style="margin-top:0">חשבוניות ויתרה</h1>
      <div class="summary-grid">
        ${
          hasDebt
            ? `<div class="stat debt">
                 <div class="num">${formatMoney(summary.openTotal)}</div>
                 <div class="label">יתרה לתשלום · ${summary.openCount} חשבוניות פתוחות</div>
               </div>`
            : `<div class="stat clear">
                 <div class="num">אין יתרה ✓</div>
                 <div class="label">כל החשבוניות שולמו</div>
               </div>`
        }
      </div>
    </div>`;
}

function openTable(open: OpenInvoiceView[]): string {
  if (open.length === 0) return '';
  const total = open.reduce((s, iv) => s + iv.amount, 0);
  return `
    <div class="card">
      <div class="section-title"><h2 style="margin:0">חשבוניות פתוחות לתשלום</h2><span class="count">${open.length}</span></div>
      <table class="table">
        <thead>
          <tr>
            <th>תאריך</th>
            <th>מס׳ מסמך</th>
            <th>אסמכתא / הזמנה</th>
            <th>סכום לתשלום</th>
          </tr>
        </thead>
        <tbody>
          ${open
            .map(
              (iv) => `
            <tr>
              <td>${formatDate(iv.date)}</td>
              <td>${escapeHtml(iv.docNo || '-')}</td>
              <td>${escapeHtml(iv.reference || iv.ordname || '-')}</td>
              <td class="amount">${formatMoney(iv.amount)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3">סה״כ לתשלום</td>
            <td class="amount">${formatMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

function historyTable(history: InvoiceView[]): string {
  if (history.length === 0) {
    return `<div class="card"><div class="empty">אין חשבוניות בהיסטוריה.</div></div>`;
  }
  return `
    <div class="card">
      <div class="section-title"><h2 style="margin:0">היסטוריית חשבוניות</h2><span class="count">${history.length}</span></div>
      <table class="table">
        <thead>
          <tr>
            <th>מס׳ חשבונית</th>
            <th>תאריך</th>
            <th>הזמנה</th>
            <th>סכום כולל מע״מ</th>
          </tr>
        </thead>
        <tbody>
          ${history
            .map(
              (iv) => `
            <tr>
              <td>${escapeHtml(iv.ivnum)} ${iv.isCredit ? '<span class="badge credit">זיכוי</span>' : ''}</td>
              <td>${formatDate(iv.date)}</td>
              <td>${escapeHtml(iv.ordname || '-')}</td>
              <td class="amount">${formatMoney(iv.amount)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>`;
}
