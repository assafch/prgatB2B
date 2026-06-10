import { api } from '../api.js';
import { formatMoney, formatDate, escapeHtml } from '../format.js';
import { emptyState, skeleton } from '../ui.js';

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
  openUnavailable?: boolean;
  historyUnavailable?: boolean;
  openListIncomplete?: boolean;
}

export async function renderInvoices(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(3)}</div>`;
  let data: InvoicesResult;
  try {
    data = await api.get<InvoicesResult>('/api/invoices');
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }

  // Both forms blocked / Priority unreachable.
  if (!data.priorityOk) {
    shell.innerHTML = `<div class="card">${emptyState(
      '🧾',
      'נתוני החשבוניות אינם זמינים כעת',
      'המידע יתעדכן בקרוב. לפרטים מיידיים פנו למשרד אורגת.'
    )}</div>`;
    return;
  }

  shell.innerHTML = `
    ${balanceCard(data)}
    ${
      data.openListIncomplete
        ? `<div class="card" style="border-color:var(--warn);background:rgba(217,119,6,0.06)"><b class="badge warn">לתשומת לבך</b> קיימת יתרה לתשלום. לפירוט החשבוניות הפתוחות פנו למשרד אורגת.</div>`
        : ''
    }
    ${openSection(data)}
    ${historySection(data)}
  `;
}

function balanceCard(d: InvoicesResult): string {
  if (d.openUnavailable) {
    return `<div class="card debt-card"><div class="amount" style="color:var(--muted);font-size:1.3rem">היתרה לא זמינה כעת</div><div class="label">לפרטים על חוב פתוח פנו למשרד</div></div>`;
  }
  const hasDebt = d.summary.openTotal > 0.005;
  return hasDebt
    ? `<div class="card debt-card owing">
         <div class="label">יתרה לתשלום · ${d.summary.openCount} חשבוניות פתוחות</div>
         <div class="amount">${formatMoney(d.summary.openTotal)}</div>
       </div>`
    : `<div class="card debt-card clear">
         <div class="amount">✓ אין חוב פתוח</div>
         <div class="label">כל החשבוניות שולמו</div>
       </div>`;
}

function openSection(d: InvoicesResult): string {
  if (d.openUnavailable || d.open.length === 0) return '';
  return `
    <div class="sec-head"><h2>חשבוניות פתוחות</h2><span class="muted">${d.open.length}</span></div>
    ${d.open
      .map(
        (iv) => `
      <div class="card dash-row" style="margin-bottom:0.5rem">
        <div class="grow">
          <div style="font-weight:700">${escapeHtml(iv.docNo || iv.reference || iv.ordname || 'חשבונית')}</div>
          <div class="muted" style="font-size:0.83rem">${formatDate(iv.date)}${iv.ordname ? ' · הזמנה ' + escapeHtml(iv.ordname) : ''}</div>
        </div>
        <div style="font-weight:800;color:var(--err)">${formatMoney(iv.amount)}</div>
      </div>`
      )
      .join('')}`;
}

function historySection(d: InvoicesResult): string {
  if (d.historyUnavailable) return '';
  if (d.history.length === 0) {
    return `<div class="card">${emptyState('📄', 'אין חשבוניות בהיסטוריה')}</div>`;
  }
  return `
    <div class="sec-head"><h2>היסטוריית חשבוניות</h2><span class="muted">${d.history.length}</span></div>
    ${d.history
      .map(
        (iv) => `
      <div class="card dash-row" style="margin-bottom:0.5rem">
        <div class="grow">
          <div style="font-weight:700">${escapeHtml(iv.ivnum)} ${iv.isCredit ? '<span class="chip info">זיכוי</span>' : ''}</div>
          <div class="muted" style="font-size:0.83rem">${formatDate(iv.date)}${iv.ordname ? ' · הזמנה ' + escapeHtml(iv.ordname) : ''}</div>
        </div>
        <div style="font-weight:700">${formatMoney(iv.amount)}</div>
      </div>`
      )
      .join('')}`;
}
