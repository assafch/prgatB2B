import { api } from '../api.js';
import { escapeHtml, formatMoney, formatDate } from '../format.js';

interface OpenInvoice {
  ivnum: string;
  amount: number;
  date: string | null;
}
interface SavedCardInfo {
  id: string;
  brand: string | null;
  fourDigits: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
}

// Pay open invoices by credit card via the PSP hosted page. The customer picks which
// invoices to settle (default all); the server re-derives the amount from the selection.
export async function renderPayCard(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card"><div class="muted">טוען…</div></div>`;
  let debt = 0;
  let enabled = false;
  let items: OpenInvoice[] = [];
  let savedCards = false;
  let installments: { min: number; max: number } | null = null;
  let savedCard: SavedCardInfo | null = null;
  try {
    const d = await api.get<{
      balance: { openTotal: number };
      balanceOk: boolean;
      features: { payments: boolean; savedCards?: boolean; savedCardCharge?: boolean; installments?: { min: number; max: number } | null };
    }>('/api/home');
    debt = d.balanceOk ? d.balance.openTotal : 0;
    enabled = !!d.features?.payments;
    savedCards = !!d.features?.savedCards;
    installments = d.features?.installments ?? null;
    // One-tap saved-card charge: fetch the card only when the flag is on.
    if (d.features?.savedCardCharge) {
      try {
        const r = await api.get<{ card: SavedCardInfo | null }>('/api/payments/saved-card');
        savedCard = r.card;
      } catch {
        /* non-owner or vault unavailable — fall back to the hosted flow */
      }
    }
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
  const saveCardBlock = savedCards
    ? `<label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.6rem;font-size:0.9rem;cursor:pointer"><input type="checkbox" id="save-card" style="width:1.05rem;height:1.05rem"> 💾 שמור את הכרטיס לתשלומים הבאים</label>`
    : '';
  const installmentsNote =
    installments && debt >= installments.min
      ? `<p class="muted" style="font-size:0.8rem;margin-top:0.5rem">אפשר לחלק עד ${installments.max} תשלומים בעמוד התשלום</p>`
      : '';

  const savedCardBlockHtml = savedCard
    ? `<button type="button" id="pc-saved" style="width:100%;padding:0.8rem;font-weight:700;margin-bottom:0.6rem;background:var(--brand);color:#fff;border:none;border-radius:10px">שלם ב${escapeHtml(savedCard.brand)} ••${escapeHtml(savedCard.fourDigits)}</button>`
    : '';

  // No itemized invoices (rare) — pay the whole open balance in one button.
  if (!items.length) {
    shell.innerHTML = `
      <div class="card" style="text-align:center">
        <h1 style="margin-top:0">תשלום בכרטיס אשראי</h1>
        <div class="muted">יתרת החוב לתשלום</div>
        <div style="font-size:2rem;font-weight:800;color:var(--brand);margin:0.4rem 0">${formatMoney(debt)}</div>
        ${savedCardBlockHtml}
        ${saveCardBlock}
        ${installmentsNote}
        <button id="pc-go" style="width:100%;padding:0.8rem;font-weight:700">לתשלום מאובטח ←</button>
        <div id="pc-msg" style="margin-top:0.5rem"></div>
        ${secureNote}
        <div style="margin-top:0.5rem"><a href="#home">ביטול</a></div>
      </div>`;
    wirePay(shell, () => []);
    if (savedCard) wireSavedPay(shell, () => []);
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
      ${savedCardBlockHtml}
      <label style="display:flex;align-items:center;gap:0.6rem;padding:0.6rem 0.2rem;margin-top:0.5rem;font-weight:600;cursor:pointer">
        <input type="checkbox" id="pc-all" checked style="width:1.15rem;height:1.15rem">
        <span>בחר הכל (${items.length} חשבוניות)</span>
      </label>
      <div style="max-height:42vh;overflow:auto">${rows}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.8rem;font-size:1.1rem;font-weight:800">
        <span>לתשלום</span>
        <span id="pc-total" style="color:var(--brand)">${formatMoney(debt)}</span>
      </div>
      <div id="pc-cap-note" class="muted" style="font-size:0.8rem;margin-top:0.2rem"></div>
      ${saveCardBlock}
      ${installmentsNote}
      <button id="pc-go" style="width:100%;padding:0.8rem;font-weight:700;margin-top:0.6rem">לתשלום מאובטח ←</button>
      <div id="pc-msg" style="margin-top:0.5rem"></div>
      ${secureNote}
      <div style="margin-top:0.5rem;text-align:center"><a href="#home">ביטול</a></div>
    </div>`;

  const cbs = Array.from(shell.querySelectorAll<HTMLInputElement>('.pc-cb'));
  const all = shell.querySelector('#pc-all') as HTMLInputElement;
  const totalEl = shell.querySelector('#pc-total') as HTMLElement;
  const capNote = shell.querySelector('#pc-cap-note') as HTMLElement | null;
  const btn = shell.querySelector('#pc-go') as HTMLButtonElement;
  const savedBtn = shell.querySelector('#pc-saved') as HTMLButtonElement | null;
  const recalc = () => {
    const checked = cbs.filter((c) => c.checked);
    const sum = checked.reduce((s, c) => s + Number(c.dataset.amount || 0), 0);
    // Never show/charge more than the authoritative open balance: an on-account credit or
    // partial payment can make the invoices' full totals sum higher than the real debt.
    const total = Math.round(Math.min(sum, debt) * 100) / 100;
    totalEl.textContent = formatMoney(total);
    if (capNote) {
      capNote.textContent =
        total < sum - 0.005 ? `יתרת החוב בפועל ${formatMoney(total)} (קיים תשלום/זיכוי על-חשבון)` : '';
    }
    all.checked = checked.length === cbs.length;
    all.indeterminate = checked.length > 0 && checked.length < cbs.length;
    btn.disabled = checked.length === 0;
    btn.textContent = checked.length ? `לתשלום מאובטח ${formatMoney(total)} ←` : 'בחרו חשבונית לתשלום';
    if (savedBtn) savedBtn.disabled = checked.length === 0;
  };
  cbs.forEach((c) => (c.onchange = recalc));
  all.onchange = () => {
    cbs.forEach((c) => (c.checked = all.checked));
    recalc();
  };
  recalc();
  const getInvoices = () => cbs.filter((c) => c.checked).map((c) => c.dataset.ivnum || '');
  wirePay(shell, getInvoices);
  if (savedCard) wireSavedPay(shell, getInvoices);
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
      const saveCard = !!(shell.querySelector('#save-card') as HTMLInputElement | null)?.checked;
      const r = await api.post<{ id: string; url: string }>('/api/payments/card/create', { invoices: getInvoices(), saveCard });
      window.location.href = r.url; // PSP hosted page
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
      btn.disabled = false;
    }
  };
}

// Wire the one-tap saved-card button: charges the selected invoices directly (no hosted
// page). Success renders the same paid empty-state as the hosted return page; a decline
// falls back to a toast, leaving the hosted "לתשלום מאובטח" button in place; a
// still-processing charge replaces the card with a waiting message (never a retry).
function wireSavedPay(shell: HTMLElement, getInvoices: () => string[]): void {
  const btn = shell.querySelector('#pc-saved') as HTMLButtonElement | null;
  if (!btn) return;
  const msg = shell.querySelector('#pc-msg') as HTMLDivElement;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    msg.textContent = 'מחייב את הכרטיס השמור…';
    msg.className = 'muted';
    try {
      const r = await api.post<{ id: string; status: string; amount: number }>('/api/payments/card/charge-saved', { invoices: getInvoices() });
      shell.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">✅</div>
          <div class="es-title">התשלום בוצע</div>
          <div class="es-sub">שולם ${formatMoney(r.amount)} בכרטיס אשראי.</div>
          <a class="es-cta" href="#home">חזרה לדף הבית</a>
        </div>`;
    } catch (ex) {
      const msgText = ex instanceof Error ? ex.message : String(ex);
      if (msgText.includes('בעיבוד')) {
        shell.innerHTML = `
          <div class="card" style="text-align:center">
            <div class="es-icon">⏳</div>
            <div style="font-weight:700">${escapeHtml(msgText)}</div>
            <a class="es-cta" href="#home" style="display:inline-block;margin-top:0.75rem">חזרה לדף הבית</a>
          </div>`;
        return;
      }
      msg.textContent = msgText;
      msg.className = 'error';
      btn.disabled = false;
    }
  });
}

export function renderPayCardReturn(shell: HTMLElement, id: string): void {
  shell.innerHTML = `<div class="card" style="text-align:center"><div class="es-icon">⏳</div><div class="es-title">מאמת תשלום…</div><div class="muted" id="pcr-msg">רגע אחד</div></div>`;
  const msgEl = shell.querySelector('#pcr-msg') as HTMLElement;
  let tries = 0;
  const poll = async () => {
    tries++;
    try {
      const r = await api.get<{ status: string; amount: number; confirmationCode: string | null; orderId?: number | null; ordname?: string | null }>(`/api/payments/card/${encodeURIComponent(id)}`);
      if (r.status === 'paid') {
        const forOrder = r.orderId != null;
        shell.innerHTML = forOrder
          ? `
          <div class="empty-state">
            <div class="es-icon">✅</div>
            <div class="es-title">התשלום בוצע — ההזמנה אושרה ותישלח</div>
            <div class="es-sub">שולם ₪${(r.amount || 0).toFixed(2)} בכרטיס אשראי.${r.ordname ? `<br/>מספר הזמנה: <b>${escapeHtml(r.ordname)}</b>` : `<br/>מספר הזמנה מקומי: <b>${r.orderId}</b>`}${r.confirmationCode ? `<br/>אישור: ${escapeHtml(r.confirmationCode)}` : ''}</div>
            <a class="es-cta" href="#orders">להזמנות שלי</a>
          </div>`
          : `
          <div class="empty-state">
            <div class="es-icon">✅</div>
            <div class="es-title">התשלום בוצע</div>
            <div class="es-sub">שולם ₪${(r.amount || 0).toFixed(2)} בכרטיס אשראי.${r.confirmationCode ? `<br/>אישור: ${escapeHtml(r.confirmationCode)}` : ''}</div>
            <a class="es-cta" href="#home">חזרה לדף הבית</a>
          </div>`;
        return;
      }
      if (r.status === 'failed' || r.status === 'expired') {
        const retry = r.orderId != null ? `#order-pay/${r.orderId}` : '#pay/card';
        shell.innerHTML = `<div class="card error" style="text-align:center"><div class="es-icon">⚠️</div><div class="es-title">התשלום לא הושלם</div><div style="margin-top:0.75rem"><a href="${retry}">נסו שוב</a> · <a href="#home">דף הבית</a></div></div>`;
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
