import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { toast } from '../ui.js';

// App settings panel: toggle payment modes, post a customer banner, and put the
// app into maintenance mode (which blocks ordering + cheque payments server-side).
export async function renderSettingsAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `<div class="muted">טוען…</div>`;
  let s: Record<string, string> = {};
  try {
    s = (await api.get<{ settings: Record<string, string> }>('/api/admin/settings')).settings;
  } catch (ex) {
    c.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
    return;
  }
  const on = (k: string, def = false) => (s[k] != null ? s[k] === 'true' : def);
  const txt = (k: string) => s[k] || '';

  c.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">הגדרות אפליקציה</h2>

      <div class="set-row"><span>תשלום בצ׳ק (צילום)</span><input type="checkbox" id="s-check" ${on('check_payment_enabled', true) ? 'checked' : ''}/></div>
      <div class="set-row"><span>תשלום בכרטיס אשראי (Visa)</span><input type="checkbox" id="s-pay" ${on('payments_enabled') ? 'checked' : ''}/></div>
      <div class="muted" style="font-size:0.8rem;margin-top:-0.2rem">תשלום בכרטיס דורש חשבון סליקה (PSP) — השאירו כבוי עד שיוגדר.</div>

      <hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)"/>
      <div class="set-row"><span>הודעה ללקוחות (באנר)</span><input type="checkbox" id="s-ann" ${on('announcement_enabled') ? 'checked' : ''}/></div>
      <textarea id="s-ann-text" rows="2" placeholder="טקסט ההודעה שתוצג ללקוחות בדף הבית">${escapeHtml(txt('announcement_text'))}</textarea>

      <hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)"/>
      <div class="set-row"><span>מצב תחזוקה <span class="badge warn">חוסם הזמנות ותשלומים</span></span><input type="checkbox" id="s-maint" ${on('maintenance_enabled') ? 'checked' : ''}/></div>
      <textarea id="s-maint-text" rows="2" placeholder="הודעת תחזוקה שתוצג ללקוח">${escapeHtml(txt('maintenance_message'))}</textarea>

      <hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)"/>
      <fieldset style="border:1px solid var(--border);border-radius:6px;padding:0.75rem 1rem;margin:0">
        <legend style="font-weight:600;padding:0 0.4rem">מדיניות תשלום ואישור הזמנה</legend>
        <div class="set-row"><span>הפעל מדיניות תשלום (כבוי = שום שינוי ללקוחות)</span><input type="checkbox" id="s-policy" ${on('payment_policy_enabled') ? 'checked' : ''}/></div>
        <div class="set-row" style="margin-top:0.6rem"><span>מילים ש"מזומן" (מופרד בפסיק, מ-PAYDES)</span></div>
        <input id="s-policy-cash" type="text" placeholder="מזומן" value="${escapeHtml(txt('policy_cash_paydes_match') || 'מזומן')}" style="width:100%;box-sizing:border-box"/>
        <div class="set-row" style="margin-top:0.6rem"><span>סף חוב פתוח לחסימת שוטף (₪, 0 = כל חוב לא-מכוסה חוסם)</span></div>
        <input id="s-policy-debt" type="number" min="0" placeholder="0" value="${escapeHtml(txt('policy_net_debt_threshold') || '0')}" style="width:100%;box-sizing:border-box"/>
      </fieldset>

      <button id="s-save" style="margin-top:1rem;width:100%">שמירת הגדרות</button>
      <div id="s-msg" style="margin-top:0.5rem;text-align:center"></div>
    </div>
    <div class="card" style="margin-top:0.75rem">
      <h2 style="margin-top:0">🔔 שליחת התראה ללקוחות</h2>
      <p class="muted" style="margin-top:-0.3rem">תישלח לכל מי שהפעיל התראות במכשירו.</p>
      <input id="pb-title" placeholder="כותרת" maxlength="80"/>
      <textarea id="pb-body" rows="2" placeholder="תוכן ההודעה" maxlength="200" style="margin-top:0.4rem"></textarea>
      <button id="pb-send" style="margin-top:0.5rem;width:100%">שליחה</button>
      <div id="pb-msg" style="margin-top:0.5rem;text-align:center"></div>
    </div>
    <div class="card" style="margin-top:0.75rem">
      <h2 style="margin-top:0">הזמנות ששולמו וטרם נשלחו</h2>
      <p class="muted" style="margin-top:-0.3rem">הזמנות שהלקוח שילם אך לא נשלחו ל-Priority (למשל בשל תקלת תקשורת).</p>
      <div id="stuck-orders-body"><span class="muted">טוען…</span></div>
    </div>`;

  const msg = c.querySelector('#s-msg') as HTMLDivElement;
  (c.querySelector('#s-save') as HTMLButtonElement).onclick = async () => {
    msg.textContent = 'שומר…';
    msg.className = 'muted';
    try {
      await api.patch('/api/admin/settings', {
        check_payment_enabled: (c.querySelector('#s-check') as HTMLInputElement).checked,
        payments_enabled: (c.querySelector('#s-pay') as HTMLInputElement).checked,
        announcement_enabled: (c.querySelector('#s-ann') as HTMLInputElement).checked,
        announcement_text: (c.querySelector('#s-ann-text') as HTMLTextAreaElement).value,
        maintenance_enabled: (c.querySelector('#s-maint') as HTMLInputElement).checked,
        maintenance_message: (c.querySelector('#s-maint-text') as HTMLTextAreaElement).value,
        payment_policy_enabled: (c.querySelector('#s-policy') as HTMLInputElement).checked,
        policy_cash_paydes_match: (c.querySelector('#s-policy-cash') as HTMLInputElement).value,
        policy_net_debt_threshold: (c.querySelector('#s-policy-debt') as HTMLInputElement).value,
      });
      msg.textContent = '✓ ההגדרות נשמרו';
      msg.className = 'ok';
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
    }
  };

  (c.querySelector('#pb-send') as HTMLButtonElement).onclick = async () => {
    const pbmsg = c.querySelector('#pb-msg') as HTMLDivElement;
    const title = (c.querySelector('#pb-title') as HTMLInputElement).value.trim();
    const body = (c.querySelector('#pb-body') as HTMLTextAreaElement).value.trim();
    if (!title || !body) {
      pbmsg.textContent = 'נא למלא כותרת ותוכן';
      pbmsg.className = 'error';
      return;
    }
    pbmsg.textContent = 'שולח…';
    pbmsg.className = 'muted';
    try {
      const r = await api.post<{ sent: number }>('/api/admin/push/broadcast', { title, body });
      pbmsg.textContent = `✓ נשלח ל-${r.sent} מכשירים`;
      pbmsg.className = 'ok';
    } catch (ex) {
      pbmsg.textContent = ex instanceof Error ? ex.message : String(ex);
      pbmsg.className = 'error';
    }
  };

  // Stuck orders: fetch lazily after shell renders, re-fetch after resend
  const renderStuckOrders = async () => {
    const body = c.querySelector('#stuck-orders-body') as HTMLDivElement;
    if (!body) return;
    body.innerHTML = '<span class="muted">טוען…</span>';
    try {
      const { orders } = await api.get<{ orders: Array<{ id: number; custname: string; total: number; status: string; error?: string }> }>('/api/admin/orders/stuck');
      if (orders.length === 0) {
        body.innerHTML = '<span class="muted">אין</span>';
        return;
      }
      body.innerHTML = orders.map(o => `
        <div id="stuck-row-${o.id}" style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:0.75rem">
            <span>#${o.id} · ${escapeHtml(o.custname)} · ₪${o.total}</span>
            <button data-id="${o.id}" class="stuck-resend" style="margin-inline-start:auto">שלח מחדש</button>
          </div>
          ${o.error ? `<div class="muted" style="font-size:0.8rem;margin-top:0.25rem">${escapeHtml(o.error)}</div>` : ''}
        </div>
      `).join('');

      body.querySelectorAll<HTMLButtonElement>('.stuck-resend').forEach(btn => {
        btn.onclick = async () => {
          const id = Number(btn.dataset.id);
          btn.disabled = true;
          try {
            const resp = await api.post<{ ok: boolean; ordname?: string; error?: string }>(`/api/admin/orders/${id}/resend`);
            if (resp.ok) {
              toast('נשלח מחדש ✓', 'ok');
              await renderStuckOrders();
            } else {
              toast(resp.error || 'השליחה נכשלה', 'error');
              btn.disabled = false;
            }
          } catch (ex) {
            toast(ex instanceof Error ? ex.message : 'השליחה נכשלה', 'error');
            btn.disabled = false;
          }
        };
      });
    } catch (ex) {
      body.innerHTML = `<div class="error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
    }
  };
  void renderStuckOrders();
}
