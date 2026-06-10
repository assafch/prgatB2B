import { api } from '../api.js';
import { escapeHtml, formatMoney } from '../format.js';

// Pay the open balance by credit card via the UPay hosted page.
export async function renderPayCard(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card"><div class="muted">טוען…</div></div>`;
  let debt = 0;
  let enabled = false;
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
  if (debt <= 0) {
    shell.innerHTML = `<div class="card"><div class="es-title">אין חוב פתוח 🎉</div><div style="margin-top:0.75rem"><a href="#home">חזרה</a></div></div>`;
    return;
  }
  shell.innerHTML = `
    <div class="card" style="text-align:center">
      <h1 style="margin-top:0">תשלום בכרטיס אשראי</h1>
      <div class="muted">יתרת החוב לתשלום</div>
      <div style="font-size:2rem;font-weight:800;color:var(--brand);margin:0.4rem 0">${formatMoney(debt)}</div>
      <button id="pc-go" style="width:100%;padding:0.8rem;font-weight:700">לתשלום מאובטח ←</button>
      <div id="pc-msg" style="margin-top:0.5rem"></div>
      <p class="muted" style="font-size:0.78rem;margin-top:0.6rem">התשלום מתבצע בעמוד מאובטח של UPay. פרטי הכרטיס אינם נשמרים אצלנו.</p>
      <div style="margin-top:0.5rem"><a href="#home">ביטול</a></div>
    </div>`;
  const btn = shell.querySelector('#pc-go') as HTMLButtonElement;
  const msg = shell.querySelector('#pc-msg') as HTMLDivElement;
  btn.onclick = async () => {
    btn.disabled = true;
    msg.textContent = 'מעביר לעמוד התשלום…';
    msg.className = 'muted';
    try {
      const r = await api.post<{ id: string; url: string }>('/api/payments/card/create', {});
      window.location.href = r.url; // UPay hosted page
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
