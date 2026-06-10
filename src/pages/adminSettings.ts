import { api } from '../api.js';
import { escapeHtml } from '../format.js';

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
}
