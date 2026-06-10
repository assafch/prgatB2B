import { api } from '../api.js';
import { formatMoney, formatDate, escapeHtml } from '../format.js';
import { emptyState, skeleton } from '../ui.js';

interface Check {
  id: string;
  amount: number | null;
  checkDate: string | null;
  isPostdated: boolean;
  status: string;
  createdAt: string;
}

const STATUS: Record<string, { he: string; tone: string }> = {
  draft: { he: 'טיוטה', tone: 'info' },
  submitted: { he: 'התקבל — בעיבוד', tone: 'warn' },
  received: { he: 'הצ׳ק נאסף', tone: 'ok' },
  deposited: { he: 'הופקד', tone: 'ok' },
  bounced: { he: 'חזר', tone: 'error' },
  cancelled: { he: 'בוטל', tone: 'error' },
};

export async function renderPayments(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(3)}</div>`;
  let checks: Check[] = [];
  try {
    checks = (await api.get<{ checks: Check[] }>('/api/payments')).checks;
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }
  // Drafts (abandoned uploads) aren't real payments — hide them.
  checks = checks.filter((c) => c.status !== 'draft');

  if (checks.length === 0) {
    shell.innerHTML = `<div class="card">${emptyState('🧾', 'אין תשלומים עדיין', 'שלמו חוב בצילום צ׳ק', '#pay/check', 'תשלום בצ׳ק')}</div>`;
    return;
  }

  shell.innerHTML = `
    <div class="sec-head"><h1 style="margin:0;font-size:1.3rem">התשלומים שלי</h1><a href="#pay/check">+ תשלום חדש</a></div>
    ${checks
      .map((c) => {
        const st = STATUS[c.status] || { he: c.status, tone: 'info' };
        return `
      <div class="card dash-row" style="margin-bottom:0.5rem">
        <div class="grow">
          <div style="font-weight:700">צ׳ק · ${c.amount != null ? formatMoney(c.amount) : '-'}</div>
          <div class="muted" style="font-size:0.83rem">לתאריך ${formatDate(c.checkDate)}${c.isPostdated ? ' · דחוי' : ''} · נשלח ${formatDate(c.createdAt)}</div>
        </div>
        <span class="chip ${st.tone}">${escapeHtml(st.he)}</span>
      </div>`;
      })
      .join('')}
  `;
}
