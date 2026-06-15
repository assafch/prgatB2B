import { api } from '../api.js';
import { escapeHtml, formatMoney, formatDate } from '../format.js';

interface OpenInvoice {
  ivnum: string;
  amount: number;
  date: string | null;
}

// Pay open invoices by credit card via the PSP hosted page. The customer picks which
// invoices to settle (default all); the server re-derives the amount from the selection.
export async function renderPayCard(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card"><div class="muted">טוען…</div></div>`;
  let debt = 0;
  let enabled = false;
  let items: OpenInvoice[] = [];
  try {
    const d = await api.get<{ balance: { openTotal: number }; balanceOk: boolean; features: { payments: boolean } }>('/api/home');
    debt = d.balanceOk ? d.balance.openTotal : 0;
    enabled = !!d.features?.payments;
  } catch {
    /* ignore — show generic */
  }
  if (!enabled) {
    shell.innerHTML = `
      <div class="card" style="text-align:center">
        <div class="es-icon">💳</div>
        <div class="es-title">תשלום בכרטיס אשראי — בקרוב</div>
        <div class="es-sub">האפשרות תיפתח ממש בקרוב. בינתיים ניתן לשלם בצ׳ק 📸 או לפנות אלינו.</div>
        <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:center">
          <a class="es-cta" href="#pay/check">תשלום בצ׳ק</a>
          <a href="#home" style="align-self:center">חזרה</a>
        </div>
      </div>`;
    return;
  }
  try {
    const oi = await api.get<{ items: OpenInvoice[]; debt: number }>('/api/payments/card/open-invoices');
    items = Array.isArray(oi.items) ? oi.items : [];
    if (oi.debt) debt = oi.debt;
  } catch {
    /* fall back to whole-balance flow below */
  }
  if (debt <= 0 && !items.length) {
    shell.innerHTML = `<div class="card"><div class="es-title">אין חוב פתוח 🎉</div><div style="margin-top:0.75rem"><a href="#home">חזרה</a></div></div>`;
    return;
  }

  const secureNote = `<p class="muted" style="font-size:0.78rem;margin-top:0.6rem">התשלום מתבצע בעמוד תשלום מאובטח (תקן PCI-DSS). פרטי הכרטיס אינם נשמרים אצלנו.</p>`;

  // No itemized invoices (rare) — pay the whole open balance in one button.
  if (!items.length) {
    shell.innerHTML = `
      <div class="card" style="text-align:center">
        <h1 style="margin-top:0">תשלום בכרטיס אשראי</h1>
        <div class="muted">יתרת החוב לתשלום</div>
        <div style="font-size:2rem;font-weight:800;color:var(--brand);margin:0.4rem 0">${formatMoney(debt)}</div>
        <button id="pc-go" style="width:100%;padding:0.8rem;font-weight:700">לתשלום מאובטח ←</button>
        <div id="pc-msg" style="margin-top:0.5rem"></div>
        ${secureNote}
        <div style="margin-top:0.5rem"><a href="#home">ביטול</a></div>
      </div>`;
    wirePay(shell, () => []);
    return;
  }

  const rows = items
    .map(
      (iv) => `
      <label class="pc-inv" style="display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.2rem;border-bottom:1px solid var(--line,#eee);cursor:pointer">
        <input type="checkbox" class="pc-cb" data-ivnum="${escapeHtml(iv.ivnum)}" data-amount="${iv.amount}" checked style="width:1.15rem;height:1.15rem;flex:0 0 auto">
        <span style="flex:1 1 auto;text-align:right">
          <span style="font-weight:600">חשבונית מס׳ ${escapeHtml(iv.ivnum)}</span>
          ${iv.date ? `<span class="muted" style="font-size:0.8rem"> · ${formatDate(iv.date)}</span>` : ''}
        </span>
        <span style="font-weight:700;white-space:nowrap">${formatMoney(iv.amount)}</span>
      </label>`
    )
    .join('');

  shell.innerHTML = `
    <div class="card">
      <h1 style="margin-top:0;text-align:center">תשלום בכרטיס אשראי</h1>
      <div class="muted" style="text-align:center">בחרו את החשבוניות לתשלום</div>
      <label style="display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.2rem;margin-top:0.5rem;font-weight:600;cursor:pointer">
        <input type="checkbox" id="pc-all" checked style="width:1.15rem;height:1.15rem">
        <span>בחר הכל (${items.length} חשבוניות)</span>
      </label>
      <div style="max-height:42vh;overflow:auto">${rows}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.8rem;font-size:1.1rem;font-weight:800">
        <span>לתשלום</span>
        <span id="pc-total" style="color:var(--brand)">${formatMoney(debt)}</span>
      </div>
      <button id="pc-go" style="width:100%;padding:0.8rem;font-weight:700;margin-top:0.6rem">לתשלום מאובטח ←</button>
      <div id="pc-msg" style="margin-top:0.5rem"></div>
      ${secureNote}
      <div style="margin-top:0.5rem;text-align:center"><a href="#home">ביטול</a></div>
    </div>`;

  const cbs = Array.from(shell.querySelectorAll<HTMLInputElement>('.pc-cb'));
  const all = shell.querySelector('#pc-all') as HTMLInputElement;
  const totalEl = shell.querySelector('#pc-total') as HTMLElement;
  const btn = shell.querySelector('#pc-go') as HTMLButtonElement;
  const recalc = () => {
    const checked = cbs.filter((c) => c.checked);
    const total = checked.reduce((s, c) => s + Number(c.dataset.amount || 0), 0);
    totalEl.textContent = formatMoney(total);
    all.checked = checked.length === cbs.length;
    all.indeterminate = checked.length > 0 && checked.length < cbs.length;
    btn.disabled = checked.length === 0;
    btn.textContent = checked.length ? `לתשלום מאובטח ${formatMoney(total)} ←` : 'בחרו חשבונית לתשלום';
  };
  cbs.forEach((c) => (c.onchange = recalc));
  all.onchange = () => {
    cbs.forEach((c) => (c.checked = all.checked));
    recalc();
  };
  recalc();
  wirePay(shell, () => cbs.filter((c) => c.checked).map((c) => c.dataset.ivnum || ''));
}

// Wire the pay button: POST the selected invoice numbers, then redirect to the PSP page.
function wirePay(shell: HTMLElement, getInvoices: () => string[]): void {
  const btn = shell.querySelector('#pc-go') as HTMLButtonElement;
  const msg = shell.querySelector('#pc-msg') as HTMLDivElement;
  btn.onclick = async () => {
    btn.disabled = true;
    msg.textContent = 'מעביר לעמוד התשלום…';
    msg.className = 'muted';
    try {
      const r = await api.post<{ id: string; url: string }>('/api/payments/card/create', { invoices: getInvoices() });
      window.location.href = r.url; // PSP hosted page
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
      btn.disabled = false;
    }
  };
}

export function renderPayCardReturn(shell: HTMLElement, id: string): void {
  shell.innerHTML = `<div class="card" style="text-align:center"><div class="es-icon">⏳</div><div class="es-title">מאמת תשלום…</div><div class="muted" id="pcr-msg">רגע אחד</div></div>`;
  const msgEl = shell.querySelector('#pcr-msg') as HTMLElement;
  let tries = 0;
  const poll = async () => {
    tries++;
    try {
      const r = await api.get<{ status: string; amount: number; confirmationCode: string | null }>(`/api/payments/card/${encodeURIComponent(id)}`);
      if (r.status === 'paid') {
        shell.innerHTML = `
          <div class="empty-state">
            <div class="es-icon">✅</div>
            <div class="es-title">התשלום בוצע</div>
            <div class="es-sub">שולם ₪${(r.amount || 0).toFixed(2)} בכרטיס אשראי.${r.confirmationCode ? `<br/>אישור: ${escapeHtml(r.confirmationCode)}` : ''}</div>
            <a class="es-cta" href="#home">חזרה לדף הבית</a>
          </div>`;
        return;
      }
      if (r.status === 'failed' || r.status === 'expired') {
        shell.innerHTML = `<div class="card error" style="text-align:center"><div class="es-icon">⚠️</div><div class="es-title">התשלום לא הושלם</div><div style="margin-top:0.75rem"><a href="#pay/card">נסו שוב</a> · <a href="#home">דף הבית</a></div></div>`;
        return;
      }
    } catch {
      /* keep polling */
    }
    if (tries < 20) {
      msgEl.textContent = `בודק… (${tries})`;
      setTimeout(poll, 2000);
    } else {
      shell.innerHTML = `<div class="card" style="text-align:center"><div class="es-title">התשלום עדיין בעיבוד</div><div class="muted">בדקו שוב בעוד מספר דקות ב"התשלומים שלי".</div><div style="margin-top:0.75rem"><a href="#home">דף הבית</a></div></div>`;
    }
  };
  void poll();
}
