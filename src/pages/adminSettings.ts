import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { openSheet, toast } from '../ui.js';

// App settings screen (Stage 8c redesign):
//   1. "⚡ מתגי מסחר" — kill switches that stop money moving. Turning the
//      dangerous direction off (or, for maintenance, on) requires typing the
//      switch's exact name in a confirm sheet; the safe direction PATCHes
//      immediately. Each toggle only ever PATCHes its own key.
//   2. "העדפות תצוגה" — display preferences (banner, discount price display,
//      maintenance message), saved together via one button.
//   3. <details> "הגדרות מתקדמות" — payment-policy + Priority-receipts config,
//      moved verbatim from the old single settings card.
//   4. Migration info strip — stuck-orders / failed-receipts monitoring moved
//      to the dashboard ops rail, so those cards no longer live here.
//   5. Push broadcast card — unchanged.

interface SwitchRow {
  key: string;
  name: string;
  desc: string;
  def: boolean;
  dangerousValue: boolean; // the value that requires typed confirmation
  maint?: boolean;
}

const SWITCH_ROWS: SwitchRow[] = [
  { key: 'payments_enabled', name: 'תשלום בכרטיס אשראי', desc: 'לקוחות משלמים חוב מהאפליקציה', def: false, dangerousValue: false },
  { key: 'check_payment_enabled', name: 'תשלום בצ׳ק (צילום)', desc: 'OCR + אישור ידני שלך', def: true, dangerousValue: false },
  { key: 'priority_receipts_enabled', name: 'קבלות Priority אוטומטיות', desc: 'קבלה נרשמת מיד עם אישור תשלום', def: false, dangerousValue: false },
  { key: 'maintenance_enabled', name: 'מצב תחזוקה', desc: '⚠ חוסם את כל הלקוחות מהאפליקציה', def: false, dangerousValue: true, maint: true },
];

function typedConfirm(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const node = document.createElement('div');
    node.innerHTML = `
      <p style="font-size:13px;margin:0 0 4px"><b>פעולה מסוכנת.</b> כדי לאשר, הקלד/י את שם המתג:</p>
      <p style="font-size:12px;color:var(--muted);margin:0 0 8px">${name}</p>
      <input id="tc-in" style="width:100%" autocomplete="off" placeholder="${name}"/>
      <button id="tc-ok" class="adm-btn-primary" style="width:100%;margin-top:10px;background:var(--err)" disabled>אישור</button>`;
    const sheet = openSheet(node, { label: 'אישור פעולה', onClose: () => { if (!done) resolve(false); } });
    const inp = node.querySelector('#tc-in') as HTMLInputElement;
    const ok = node.querySelector('#tc-ok') as HTMLButtonElement;
    inp.addEventListener('input', () => { ok.disabled = inp.value.trim() !== name; });
    ok.addEventListener('click', () => { done = true; sheet.close(); resolve(true); });
  });
}

function setSwitchVisual(pillEl: HTMLElement, toggleEl: HTMLButtonElement, isOn: boolean): void {
  pillEl.className = isOn ? 'pill-on' : 'pill-off';
  pillEl.textContent = isOn ? 'פעיל' : 'כבוי';
  toggleEl.className = 'adm-toggle' + (isOn ? ' on danger-on' : '');
}

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

  const switchRowsHtml = SWITCH_ROWS.map((r) => {
    const isOn = on(r.key, r.def);
    return `
      <div class="switch-row${r.maint ? ' maint' : ''}">
        <div>
          <div class="switch-name">${escapeHtml(r.name)}</div>
          <div class="switch-desc">${escapeHtml(r.desc)}</div>
        </div>
        <div class="switch-end">
          <span class="${isOn ? 'pill-on' : 'pill-off'}" id="pill-${r.key}">${isOn ? 'פעיל' : 'כבוי'}</span>
          <button type="button" class="adm-toggle${isOn ? ' on danger-on' : ''}" id="tgl-${r.key}" aria-label="${escapeHtml(r.name)}"></button>
        </div>
      </div>`;
  }).join('');

  c.innerHTML = `
    <div class="adm-head">
      <h1 class="adm-title">הגדרות</h1>
    </div>

    <div class="card switch-panel">
      <div class="switch-panel-head">
        <b>⚡ מתגי מסחר</b>
        <small>עוצרים כסף — כיבוי דורש אישור בהקלדה</small>
      </div>
      ${switchRowsHtml}
    </div>

    <div class="card" style="margin-top:0.75rem">
      <h2 style="margin-top:0">העדפות תצוגה</h2>
      <div class="set-row"><span>באנר הודעה ללקוחות</span><input type="checkbox" id="s-ann" ${on('announcement_enabled') ? 'checked' : ''}/></div>
      <textarea id="s-ann-text" rows="2" placeholder="טקסט ההודעה שתוצג ללקוחות בדף הבית">${escapeHtml(txt('announcement_text'))}</textarea>

      <div class="set-row" style="margin-top:0.6rem">
        <span>מחיר מחירון + הנחת לקוח (קו אדום על המחיר המלא)</span>
        <button type="button" id="s-discount" class="adm-toggle${on('discount_pricing_enabled') ? ' on' : ''}" aria-label="מחיר מחירון + הנחת לקוח"></button>
      </div>

      <div class="set-row" style="margin-top:0.6rem"><span>הודעת תחזוקה</span></div>
      <textarea id="s-maint-text" rows="2" placeholder="הודעת תחזוקה שתוצג ללקוח">${escapeHtml(txt('maintenance_message'))}</textarea>

      <button id="s-prefs-save" style="margin-top:1rem;width:100%">שמירת העדפות</button>
      <div id="s-prefs-msg" style="margin-top:0.5rem;text-align:center"></div>
    </div>

    <details class="card" style="margin-top:0.75rem">
      <summary style="cursor:pointer;font-weight:700">הגדרות מתקדמות</summary>

      <hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)"/>
      <fieldset style="border:1px solid var(--border);border-radius:6px;padding:0.75rem 1rem;margin:0">
        <legend style="font-weight:600;padding:0 0.4rem">מדיניות תשלום ואישור הזמנה</legend>
        <div class="set-row"><span>הפעל מדיניות תשלום (כבוי = שום שינוי ללקוחות)</span><input type="checkbox" id="s-policy" ${on('payment_policy_enabled') ? 'checked' : ''}/></div>
        <div class="set-row" style="margin-top:0.6rem"><span>מילים ש"מזומן" (מופרד בפסיק, מ-PAYDES)</span></div>
        <input id="s-policy-cash" type="text" placeholder="מזומן" value="${escapeHtml(txt('policy_cash_paydes_match') || 'מזומן')}" style="width:100%;box-sizing:border-box"/>
        <div class="set-row" style="margin-top:0.6rem"><span>סף חוב פתוח לחסימת שוטף (₪, 0 = כל חוב לא-מכוסה חוסם)</span></div>
        <input id="s-policy-debt" type="number" min="0" placeholder="0" value="${escapeHtml(txt('policy_net_debt_threshold') || '0')}" style="width:100%;box-sizing:border-box"/>
      </fieldset>

      <hr style="margin:1rem 0;border:none;border-top:1px solid var(--border)"/>
      <fieldset style="border:1px solid var(--border);border-radius:6px;padding:0.75rem 1rem;margin:0">
        <legend style="font-weight:600;padding:0 0.4rem">קבלות אוטומטיות (Priority)</legend>
        <div class="set-row"><span>הפעל יצירת קבלה אוטומטית ב-Priority (כבוי = ללא שינוי)</span><input type="checkbox" id="s-receipts-enabled" ${on('priority_receipts_enabled') ? 'checked' : ''}/></div>
        <div class="set-row" style="margin-top:0.6rem"><span>קופה (CASHNAME)</span></div>
        <input id="s-receipt-cashname" type="text" placeholder="020" value="${escapeHtml(txt('priority_receipt_cashname'))}" style="width:100%;box-sizing:border-box"/>
        <div class="set-row" style="margin-top:0.6rem"><span>אחראי (OWNERLOGIN)</span></div>
        <input id="s-receipt-ownerlogin" type="text" placeholder="" value="${escapeHtml(txt('priority_receipt_ownerlogin'))}" style="width:100%;box-sizing:border-box"/>
        <div class="set-row" style="margin-top:0.6rem"><span>קוד תשלום אשראי</span></div>
        <input id="s-receipt-cc-paymentcode" type="text" placeholder="13" value="${escapeHtml(txt('priority_receipt_cc_paymentcode') || '13')}" style="width:100%;box-sizing:border-box"/>
        <div class="set-row" style="margin-top:0.6rem"><span>מסוף (אופציונלי)</span></div>
        <input id="s-receipt-terminal" type="text" placeholder="" value="${escapeHtml(txt('priority_receipt_terminal'))}" style="width:100%;box-sizing:border-box"/>
        <div class="set-row" style="margin-top:0.6rem"><span>לקוח בדיקה יחיד (מספר לקוח — ריק = כל הלקוחות)</span></div>
        <input id="s-receipts-test-custname" type="text" placeholder="" value="${escapeHtml(txt('priority_receipts_test_custname'))}" style="width:100%;box-sizing:border-box"/>
      </fieldset>

      <button id="s-adv-save" style="margin-top:1rem;width:100%">שמירת הגדרות מתקדמות</button>
      <div id="s-adv-msg" style="margin-top:0.5rem;text-align:center"></div>
    </details>

    <div class="adm-info-strip">📌 "הזמנות ששולמו וטרם נשלחו" ו"קבלות שנכשלו" עברו ללוח הבקרה — פס "דורש טיפול".</div>

    <div class="card" style="margin-top:0.75rem">
      <h2 style="margin-top:0">🔔 שליחת התראה ללקוחות</h2>
      <p class="muted" style="margin-top:-0.3rem">תישלח לכל מי שהפעיל התראות במכשירו.</p>
      <input id="pb-title" placeholder="כותרת" maxlength="80"/>
      <textarea id="pb-body" rows="2" placeholder="תוכן ההודעה" maxlength="200" style="margin-top:0.4rem"></textarea>
      <button id="pb-send" style="margin-top:0.5rem;width:100%">שליחה</button>
      <div id="pb-msg" style="margin-top:0.5rem;text-align:center"></div>
    </div>`;

  // ---- Kill-switch rows: dangerous direction requires typed confirm; each
  // toggle PATCHes only its own key, optimistically updates, reverts on error.
  for (const r of SWITCH_ROWS) {
    const pillEl = c.querySelector(`#pill-${r.key}`) as HTMLElement;
    const toggleEl = c.querySelector(`#tgl-${r.key}`) as HTMLButtonElement;
    toggleEl.onclick = async () => {
      const current = on(r.key, r.def);
      const next = !current;
      if (next === r.dangerousValue) {
        const confirmed = await typedConfirm(r.name);
        if (!confirmed) return; // switch left untouched
      }
      setSwitchVisual(pillEl, toggleEl, next);
      try {
        await api.patch('/api/admin/settings', { [r.key]: next });
        s[r.key] = String(next);
        toast('✓ עודכן', 'ok');
        // Keep the advanced "s-receipts-enabled" checkbox (same key) in sync.
        if (r.key === 'priority_receipts_enabled') {
          const advChk = c.querySelector('#s-receipts-enabled') as HTMLInputElement | null;
          if (advChk) advChk.checked = next;
        }
      } catch (ex) {
        setSwitchVisual(pillEl, toggleEl, current);
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      }
    };
  }

  // ---- Prefs panel: plain toggle (no confirm), one combined save ----
  const discToggle = c.querySelector('#s-discount') as HTMLButtonElement;
  discToggle.onclick = () => discToggle.classList.toggle('on');

  (c.querySelector('#s-prefs-save') as HTMLButtonElement).onclick = async () => {
    const msgEl = c.querySelector('#s-prefs-msg') as HTMLDivElement;
    msgEl.textContent = 'שומר…';
    msgEl.className = 'muted';
    try {
      const announcementEnabled = (c.querySelector('#s-ann') as HTMLInputElement).checked;
      const announcementText = (c.querySelector('#s-ann-text') as HTMLTextAreaElement).value;
      const discountEnabled = discToggle.classList.contains('on');
      const maintenanceMessage = (c.querySelector('#s-maint-text') as HTMLTextAreaElement).value;
      await api.patch('/api/admin/settings', {
        announcement_enabled: announcementEnabled,
        announcement_text: announcementText,
        discount_pricing_enabled: discountEnabled,
        maintenance_message: maintenanceMessage,
      });
      s.announcement_enabled = String(announcementEnabled);
      s.announcement_text = announcementText;
      s.discount_pricing_enabled = String(discountEnabled);
      s.maintenance_message = maintenanceMessage;
      msgEl.textContent = '✓ ההעדפות נשמרו';
      msgEl.className = 'ok';
    } catch (ex) {
      msgEl.textContent = ex instanceof Error ? ex.message : String(ex);
      msgEl.className = 'error';
    }
  };

  // ---- Advanced: payment-policy + Priority-receipts config, own save ----
  (c.querySelector('#s-adv-save') as HTMLButtonElement).onclick = async () => {
    const msgEl = c.querySelector('#s-adv-msg') as HTMLDivElement;
    msgEl.textContent = 'שומר…';
    msgEl.className = 'muted';
    try {
      const receiptsEnabled = (c.querySelector('#s-receipts-enabled') as HTMLInputElement).checked;
      await api.patch('/api/admin/settings', {
        payment_policy_enabled: (c.querySelector('#s-policy') as HTMLInputElement).checked,
        policy_cash_paydes_match: (c.querySelector('#s-policy-cash') as HTMLInputElement).value,
        policy_net_debt_threshold: (c.querySelector('#s-policy-debt') as HTMLInputElement).value,
        priority_receipts_enabled: receiptsEnabled,
        priority_receipt_cashname: (c.querySelector('#s-receipt-cashname') as HTMLInputElement).value,
        priority_receipt_ownerlogin: (c.querySelector('#s-receipt-ownerlogin') as HTMLInputElement).value,
        priority_receipt_cc_paymentcode: (c.querySelector('#s-receipt-cc-paymentcode') as HTMLInputElement).value,
        priority_receipt_terminal: (c.querySelector('#s-receipt-terminal') as HTMLInputElement).value,
        priority_receipts_test_custname: (c.querySelector('#s-receipts-test-custname') as HTMLInputElement).value,
      });
      s.priority_receipts_enabled = String(receiptsEnabled);
      // Keep the top kill-switch row (same key) in sync with this save too.
      const pillEl = c.querySelector('#pill-priority_receipts_enabled') as HTMLElement | null;
      const toggleEl = c.querySelector('#tgl-priority_receipts_enabled') as HTMLButtonElement | null;
      if (pillEl && toggleEl) setSwitchVisual(pillEl, toggleEl, receiptsEnabled);
      msgEl.textContent = '✓ ההגדרות נשמרו';
      msgEl.className = 'ok';
    } catch (ex) {
      msgEl.textContent = ex instanceof Error ? ex.message : String(ex);
      msgEl.className = 'error';
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
