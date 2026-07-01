import { api } from '../api.js';
import { formatMoney, formatDate, escapeHtml } from '../format.js';
import { emptyState, skeleton, buzz } from '../ui.js';

interface PayFeatures {
  payments: boolean;
  checkPayment: boolean;
}

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
  /** recent card payments not yet reconciled into Priority's debt (₪) */
  paymentInProcess?: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export async function renderInvoices(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(3)}</div>`;
  // The invoice list and the payment-method gates (/api/home) are independent —
  // fetch both at once. A /api/home failure only hides the pay bar; it never
  // blocks the list.
  const [invRes, homeRes] = await Promise.allSettled([
    api.get<InvoicesResult>('/api/invoices'),
    api.get<{ features: PayFeatures }>('/api/home'),
  ]);
  if (invRes.status === 'rejected') {
    const ex = invRes.reason;
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }
  const data = invRes.value;

  // Both forms blocked / Priority unreachable.
  if (!data.priorityOk) {
    shell.innerHTML = `<div class="card">${emptyState(
      '🧾',
      'נתוני החשבוניות אינם זמינים כעת',
      'המידע יתעדכן בקרוב. לפרטים מיידיים פנו למשרד אורגת.'
    )}</div>`;
    return;
  }

  const features: PayFeatures =
    homeRes.status === 'fulfilled' && homeRes.value?.features ? homeRes.value.features : { payments: false, checkPayment: false };

  const bar = payBar(data, features);
  shell.innerHTML = `
    ${balanceCard(data)}
    ${
      data.openListIncomplete
        ? `<div class="card" style="border-color:var(--warn);background:rgba(217,119,6,0.06)"><b class="badge warn">לתשומת לבך</b> קיימת יתרה לתשלום. לפירוט החשבוניות הפתוחות פנו למשרד אורגת.</div>`
        : ''
    }
    ${openAndPaySection(data, features)}
    ${historySection(data)}
    ${bar ? '<div class="thumb-bar-spacer" style="height:88px"></div>' : ''}
    ${bar}
  `;
  // Haptic tick when a pay action is launched (one-hand feedback).
  shell.querySelectorAll('.thumb-bar a').forEach((a) => a.addEventListener('click', () => buzz()));
  wirePayPanel(shell, data);
}

// B2 — wire the inline select/partial pay panel: checkboxes set the amount, the
// "סכום אחר" field overrides it, and the button posts to /api/payments/card/intent.
function wirePayPanel(shell: HTMLElement, d: InvoicesResult): void {
  const panel = shell.querySelector('.pay2-panel') as HTMLElement | null;
  if (!panel) return;
  const amountEl = panel.querySelector('#pay2-amount') as HTMLInputElement;
  const btn = panel.querySelector('#pay2-go') as HTMLButtonElement;
  const msg = panel.querySelector('#pay2-msg') as HTMLElement;
  const payable = round2(Number(panel.dataset.payable) || 0);
  const capNote = panel.querySelector('#pay2-cap-note') as HTMLElement | null;
  const cbs = Array.from(shell.querySelectorAll<HTMLInputElement>('.pay2-cb'));

  const refresh = () => {
    const amt = round2(Number(amountEl.value) || 0);
    const ok = amt > 0 && amt <= payable + 0.001;
    btn.disabled = !ok;
    btn.textContent = amt > 0 ? `💳 לתשלום ${formatMoney(amt)}` : '💳 לתשלום מאובטח';
  };
  cbs.forEach((cb) =>
    cb.addEventListener('change', () => {
      if (cbs.some((c) => c.checked)) {
        const selSum = round2(cbs.filter((c) => c.checked).reduce((s, c) => s + Number(c.dataset.amount || 0), 0));
        const capped = Math.min(selSum, payable); // never display more than the real open balance
        amountEl.value = capped.toFixed(2);
        if (capNote) {
          capNote.textContent =
            capped < selSum - 0.005
              ? `יתרת החוב בפועל ${formatMoney(capped)} (קיים תשלום/זיכוי על-חשבון)`
              : '';
        }
      } else {
        if (capNote) capNote.textContent = '';
      }
      refresh();
    })
  );
  amountEl.addEventListener('input', refresh);
  refresh();

  btn.addEventListener('click', async () => {
    const amount = round2(Number(amountEl.value) || 0);
    if (!(amount > 0)) return;
    const invoiceRefs = cbs.filter((c) => c.checked).map((c) => c.dataset.ref || '').filter(Boolean);
    btn.disabled = true;
    msg.textContent = 'מעביר לעמוד התשלום…';
    msg.className = 'muted';
    try {
      const r = await api.post<{ id: string; url: string }>('/api/payments/card/intent', { amount, invoiceRefs });
      buzz();
      window.location.href = r.url; // PSP hosted page
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
      btn.disabled = false;
    }
  });
}

// B1 — sticky thumb-zone pay bar. Shown only when there's an open balance and at
// least one payment method is enabled; each button respects its own feature gate.
function payBar(d: InvoicesResult, f: PayFeatures): string {
  if (d.openUnavailable || d.summary.openTotal <= 0.005) return '';
  if (!f.payments && !f.checkPayment) return '';
  return `
    <div class="thumb-bar">
      <div class="thumb-bar-row">
        ${f.checkPayment ? '<a class="thumb-check" href="#pay/check">📷 צ׳ק</a>' : ''}
        ${f.payments ? `<a class="thumb-pay" href="#pay/card">💳 שלם ${formatMoney(d.summary.openTotal)}</a>` : ''}
      </div>
    </div>`;
}

function balanceCard(d: InvoicesResult): string {
  if (d.openUnavailable) {
    return `<div class="card debt-card"><div class="amount" style="color:var(--muted);font-size:1.3rem">היתרה לא זמינה כעת</div><div class="label">לפרטים על חוב פתוח פנו למשרד</div></div>`;
  }
  const hasDebt = d.summary.openTotal > 0.005;
  return hasDebt
    ? `<div class="card debt-card owing">
         <div class="label">יתרה לתשלום${d.summary.openCount > 0 ? ` · ${d.summary.openCount} חשבוניות פתוחות` : ''}</div>
         <div class="amount">${formatMoney(d.summary.openTotal)}</div>
       </div>`
    : `<div class="card debt-card clear">
         <div class="amount">✓ אין חוב פתוח</div>
         <div class="label">כל החשבוניות שולמו</div>
       </div>`;
}

// B2 — open invoices + inline pay panel. When card payments are enabled the rows
// become tickable and a "סכום אחר" panel lets the owner pay a partial/custom amount.
function openAndPaySection(d: InvoicesResult, f: PayFeatures): string {
  const payEnabled = f.payments && !d.openUnavailable && d.summary.openTotal > 0.005;
  const hasList = !d.openUnavailable && d.open.length > 0;
  if (!hasList && !payEnabled) return '';

  const rows = hasList
    ? d.open
        .map((iv) => {
          const ref = iv.docNo || iv.reference || iv.ordname || '';
          return `
      <label class="card dash-row${payEnabled && ref ? ' pay2-row' : ''}" style="margin-bottom:0.5rem">
        ${payEnabled && ref ? `<input type="checkbox" class="pay2-cb" data-ref="${escapeHtml(ref)}" data-amount="${iv.amount}" style="width:1.2rem;height:1.2rem;flex:none">` : ''}
        <div class="grow">
          <div style="font-weight:700">${escapeHtml(iv.docNo || iv.reference || iv.ordname || 'חשבונית')}</div>
          <div class="muted" style="font-size:0.83rem">${formatDate(iv.date)}${iv.ordname ? ' · הזמנה ' + escapeHtml(iv.ordname) : ''}</div>
        </div>
        <div style="font-weight:800;color:var(--err)">${formatMoney(iv.amount)}</div>
      </label>`;
        })
        .join('')
    : '';

  const header = hasList ? `<div class="sec-head"><h2>חשבוניות פתוחות</h2><span class="muted">${d.open.length}</span></div>` : '';
  return header + rows + (payEnabled ? payPanel(d, hasList) : '');
}

function payPanel(d: InvoicesResult, hasList: boolean): string {
  const inProcess = round2(d.paymentInProcess || 0);
  const payable = round2(Math.max(0, d.summary.openTotal - inProcess));
  return `
    <div class="card pay2-panel" data-payable="${payable}">
      <div style="font-weight:800;margin-bottom:0.3rem">תשלום בכרטיס אשראי</div>
      <div class="muted" style="font-size:0.83rem;margin-bottom:0.6rem">${hasList ? 'סמנו חשבוניות לתשלום, או הזינו סכום אחר.' : 'הזינו סכום לתשלום (אפשר תשלום חלקי).'}</div>
      <div style="display:flex;align-items:center;gap:0.5rem">
        <label for="pay2-amount" style="flex:none;font-weight:600">סכום (₪)</label>
        <input id="pay2-amount" type="number" inputmode="decimal" min="0" step="0.01" value="${payable.toFixed(2)}" style="flex:1"/>
      </div>
      <div id="pay2-cap-note" class="muted" style="font-size:0.82rem;margin-top:0.3rem"></div>
      ${inProcess > 0.005 ? `<div class="muted" style="font-size:0.8rem;margin-top:0.45rem">⏳ ₪${inProcess.toFixed(2)} בתהליך עיבוד — היתרה תתעדכן לאחר אישור במשרד.</div>` : ''}
      <button id="pay2-go" class="pay2-cta">💳 לתשלום מאובטח</button>
      <div id="pay2-msg" style="margin-top:0.4rem;text-align:center"></div>
      <p class="muted" style="font-size:0.78rem;margin-top:0.3rem">התשלום בעמוד מאובטח (PCI-DSS). פרטי הכרטיס אינם נשמרים אצלנו.</p>
    </div>`;
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
      <a href="#invoice/${encodeURIComponent(iv.ivnum)}" class="card dash-row" style="margin-bottom:0.5rem;color:var(--text)">
        <div class="grow">
          <div style="font-weight:700">${escapeHtml(iv.ivnum)} ${iv.isCredit ? '<span class="chip info">זיכוי</span>' : ''}</div>
          <div class="muted" style="font-size:0.83rem">${formatDate(iv.date)}${iv.ordname ? ' · הזמנה ' + escapeHtml(iv.ordname) : ''}</div>
        </div>
        <div style="font-weight:700">${formatMoney(iv.amount)}</div>
        <div class="muted" style="font-size:1.2rem">›</div>
      </a>`
      )
      .join('')}`;
}
