import { api } from '../api.js';
import { formatMoney, escapeHtml, escapeAttr, formatDateTime } from '../format.js';
import { toast, confirmDialog } from '../ui.js';
import { supportsPasskeys, serverPasskeysEnabled, passkeyRegister, isPasskeyCancel } from '../webauthn.js';
import { state } from '../main.js';
import { pushSupported, pushSubscribed, enablePush, disablePush } from '../push.js';

interface Profile {
  custname: string;
  name: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  vatNumber: string | null;
  paymentTerms: string | null;
  agent: string | null;
}

interface Balance {
  openTotal: number;
  openCount: number;
  obligo: number | null;
  creditLimit: number | null;
}

interface Account {
  custname: string | null;
  cust_desc: string | null;
  email: string | null;
  phone: string | null;
  profile: Profile | null;
  balance: Balance;
  priorityOk: boolean;
  balanceOk: boolean;
}

export async function renderAccount(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const a = await api.get<Account>('/api/account');
    const p = a.profile;

    // Prefer live Priority profile; fall back to local user record when unreachable.
    const name = p?.name || a.cust_desc || '-';
    const custname = p?.custname || a.custname || '-';
    const phone = p?.phone || a.phone || '-';
    const email = p?.email || a.email || '-';
    const addressParts = [p?.address, p?.city, p?.zip].filter(Boolean).join(', ');

    const rows: Array<[string, string | null]> = [
      ['שם לקוח', name],
      ['מספר לקוח', custname],
      ['ח.פ / עוסק מורשה', p?.vatNumber || null],
      ['כתובת', addressParts || null],
      ['טלפון', phone],
      ['פקס', p?.fax || null],
      ['אימייל', email],
      ['תנאי תשלום', p?.paymentTerms || null],
      ['סוכן', p?.agent || null],
    ];

    const isOwner = state.me?.customer_role !== 'orderer';
    shell.innerHTML = `
      <div class="card" style="max-width:720px;margin:0 auto">
        <h1 style="margin-top:0">החשבון שלי</h1>
        ${isOwner ? balanceSection(a) : ''}
        <dl class="kv" style="margin-top:1.25rem">
          ${rows
            .filter(([, v]) => v && v !== '-')
            .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
            .join('')}
        </dl>
        ${
          !a.priorityOk
            ? `<p class="muted" style="margin-top:1rem">⚠ נתוני Priority אינם זמינים כעת — מוצגים הפרטים השמורים.</p>`
            : ''
        }
        <p class="muted" style="margin-top:1.5rem">לשינוי פרטים — צרו קשר עם משרד אורגת.</p>
      </div>
      <div id="passkey-card"></div>
      <div id="push-card"></div>
      <div id="mobile-card"></div>
      <div id="staff-card"></div>
    `;
    renderPasskeys(shell.querySelector('#passkey-card') as HTMLElement);
    void renderPush(shell.querySelector('#push-card') as HTMLElement);
    renderMobile(shell.querySelector('#mobile-card') as HTMLElement, a.phone);
    if (isOwner) void renderStaff(shell.querySelector('#staff-card') as HTMLElement);
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}

interface Passkey { id: number; device_name: string | null; created_at: string; last_used_at: string | null }

async function renderPasskeys(host: HTMLElement): Promise<void> {
  if (!supportsPasskeys() || !(await serverPasskeysEnabled())) return; // device/server can't do it → hide
  const load = async () => {
    let list: Passkey[] = [];
    try {
      list = (await api.get<{ passkeys: Passkey[] }>('/api/auth/passkeys')).passkeys;
    } catch {
      /* ignore */
    }
    host.innerHTML = `
      <div class="card" style="max-width:720px;margin:1rem auto 0">
        <h2 style="margin-top:0">כניסה מהירה (Face ID / טביעת אצבע)</h2>
        <p class="muted" style="margin-top:-0.3rem">היכנסו לאפליקציה ללא סיסמה, באמצעות זיהוי ביומטרי במכשיר.</p>
        ${
          list.length
            ? list
                .map(
                  (p) => `
          <div class="dash-row" style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
            <div class="grow"><div style="font-weight:600">🔑 ${escapeHtml(p.device_name || 'מכשיר')}</div>
              <div class="muted" style="font-size:0.8rem">נוסף ${formatDateTime(p.created_at)}${p.last_used_at ? ' · שימוש אחרון ' + formatDateTime(p.last_used_at) : ''}</div></div>
            <button class="ghost pk-del" data-id="${p.id}" style="padding:0.4rem 0.7rem">הסר</button>
          </div>`
                )
                .join('')
            : '<p class="muted">לא הוגדרה עדיין כניסה מהירה במכשיר זה.</p>'
        }
        <button id="pk-add" style="width:100%;margin-top:0.75rem">הוסף את המכשיר הזה</button>
      </div>`;
    (host.querySelector('#pk-add') as HTMLButtonElement).addEventListener('click', async () => {
      const btn = host.querySelector('#pk-add') as HTMLButtonElement;
      btn.disabled = true;
      try {
        const device = navigator.platform || 'מכשיר';
        await passkeyRegister(device);
        toast('כניסה מהירה הופעלה ✓', 'ok');
        await load();
      } catch (ex) {
        if (!isPasskeyCancel(ex)) toast('ההפעלה נכשלה — נסו שוב', 'error');
        btn.disabled = false;
      }
    });
    host.querySelectorAll<HTMLButtonElement>('.pk-del').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!(await confirmDialog('להסיר את הכניסה המהירה מהמכשיר הזה?', 'הסר', 'ביטול'))) return;
        await api.del(`/api/auth/passkeys/${b.dataset.id}`);
        toast('הוסר', 'ok');
        await load();
      })
    );
  };
  await load();
}

// Push-notifications toggle for this device.
async function renderPush(host: HTMLElement): Promise<void> {
  if (!pushSupported()) return; // iOS Safari needs the app installed to home screen, etc.
  const on = await pushSubscribed();
  host.innerHTML = `
    <div class="card" style="max-width:720px;margin:1rem auto 0">
      <h2 style="margin-top:0">🔔 התראות</h2>
      <p class="muted" style="margin-top:-0.3rem">קבלת עדכונים על אישור הזמנה, תשלומים ומבצעים — במכשיר זה.</p>
      <button id="push-toggle" class="${on ? 'ghost' : ''}" style="width:100%">${on ? 'כיבוי התראות במכשיר זה' : 'הפעלת התראות'}</button>
    </div>`;
  (host.querySelector('#push-toggle') as HTMLButtonElement).onclick = async () => {
    const btn = host.querySelector('#push-toggle') as HTMLButtonElement;
    btn.disabled = true;
    try {
      if (on) {
        await disablePush();
        toast('ההתראות כובו', 'ok');
      } else {
        await enablePush();
        toast('ההתראות הופעלו ✓', 'ok');
      }
      void renderPush(host);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : String(ex), 'error');
      btn.disabled = false;
    }
  };
}

interface Staff { id: number; username: string; status: string; created_at: string; last_login_at: string | null }

// Owner-only: create/manage staff (orderer) logins for the store.
async function renderStaff(host: HTMLElement): Promise<void> {
  let staff: Staff[] = [];
  try {
    staff = (await api.get<{ staff: Staff[] }>('/api/account/staff')).staff;
  } catch {
    return; // 403 for non-owners → just hide the section
  }
  const draw = (list: Staff[]) => {
    host.innerHTML = `
      <div class="card" style="max-width:720px;margin:1rem auto 0">
        <h2 style="margin-top:0">משתמשי החנות</h2>
        <p class="muted" style="margin-top:-0.3rem">הוסיפו משתמשים לעובדים שמזמינים — הם רואים קטלוג ומזמינים, אך ללא גישה לחוב/חשבוניות/תשלומים.</p>
        <div class="form-grid">
          <input id="st-user" placeholder="שם משתמש"/>
          <input id="st-pass" placeholder="סיסמה (6+ תווים)"/>
        </div>
        <button id="st-add" style="width:100%;margin-top:0.5rem">הוסף עובד</button>
        <div id="st-msg" style="margin-top:0.4rem;text-align:center"></div>
        <div id="st-list" style="margin-top:0.75rem">
          ${
            list.length
              ? list
                  .map(
                    (s) => `
            <div class="dash-row" style="padding:0.5rem 0;border-bottom:1px solid var(--border)">
              <div class="grow"><div style="font-weight:600">👤 ${escapeHtml(s.username)} ${s.status !== 'active' ? '<span class="chip error">מושבת</span>' : ''}</div>
                <div class="muted" style="font-size:0.8rem">התחבר: ${s.last_login_at ? escapeHtml(s.last_login_at.slice(0, 10)) : '—'}</div></div>
              <button class="ghost st-reset" data-id="${s.id}" data-name="${escapeAttr(s.username)}">איפוס סיסמה</button>
              <button class="ghost st-toggle" data-id="${s.id}" data-status="${escapeAttr(s.status)}">${s.status === 'active' ? 'השבת' : 'הפעל'}</button>
            </div>`
                  )
                  .join('')
              : '<p class="muted">אין עדיין עובדים נוספים.</p>'
          }
        </div>
      </div>`;
    const msg = host.querySelector('#st-msg') as HTMLDivElement;
    (host.querySelector('#st-add') as HTMLButtonElement).onclick = async () => {
      msg.textContent = 'יוצר…';
      msg.className = 'muted';
      try {
        await api.post('/api/account/staff', {
          username: (host.querySelector('#st-user') as HTMLInputElement).value.trim(),
          password: (host.querySelector('#st-pass') as HTMLInputElement).value,
        });
        void renderStaff(host);
      } catch (ex) {
        msg.textContent = ex instanceof Error ? ex.message : String(ex);
        msg.className = 'error';
      }
    };
    host.querySelectorAll<HTMLButtonElement>('.st-toggle').forEach((b) => {
      b.onclick = async () => {
        try {
          await api.post(`/api/account/staff/${b.dataset.id}/status`, { status: b.dataset.status === 'active' ? 'disabled' : 'active' });
          void renderStaff(host);
        } catch (ex) {
          msg.textContent = ex instanceof Error ? ex.message : String(ex);
          msg.className = 'error';
        }
      };
    });
    host.querySelectorAll<HTMLButtonElement>('.st-reset').forEach((b) => {
      b.onclick = async () => {
        const np = window.prompt(`סיסמה חדשה ל-${b.dataset.name} (6+ תווים):`);
        if (!np) return;
        try {
          await api.post(`/api/account/staff/${b.dataset.id}/reset-password`, { new_password: np });
          toast('הסיסמה אופסה ✓', 'ok');
        } catch (ex) {
          toast(ex instanceof Error ? ex.message : String(ex), 'error');
        }
      };
    });
  };
  draw(staff);
}

function renderMobile(host: HTMLElement, phone: string | null): void {
  host.innerHTML = `
    <div class="card" style="max-width:720px;margin:1rem auto 0">
      <div style="font-weight:700;margin-bottom:0.4rem">📱 מספר נייד לעדכונים</div>
      <div style="display:flex;gap:0.5rem">
        <input id="acc-mobile" type="tel" inputmode="tel" placeholder="05XXXXXXXX" value="${escapeAttr(phone || '')}" style="flex:1"/>
        <button id="acc-mobile-save">שמור</button>
      </div>
      <div id="acc-mobile-msg" style="margin-top:0.35rem;text-align:center;font-size:0.85rem"></div>
    </div>`;
  const mmsg = host.querySelector('#acc-mobile-msg') as HTMLDivElement | null;
  (host.querySelector('#acc-mobile-save') as HTMLButtonElement | null)?.addEventListener('click', async () => {
    const val = (host.querySelector('#acc-mobile') as HTMLInputElement).value.trim();
    try {
      await api.patch('/api/account/phone', { phone: val });
      if (mmsg) { mmsg.textContent = 'נשמר ✓'; mmsg.className = 'ok'; }
      toast('מספר הנייד נשמר ✓', 'ok');
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      if (mmsg) { mmsg.textContent = m; mmsg.className = 'error'; }
    }
  });
}

function balanceSection(a: Account): string {
  if (!a.balanceOk) return '';
  const b = a.balance;
  const hasDebt = b.openTotal > 0.005;
  const extra: string[] = [];
  if (b.creditLimit != null) {
    extra.push(`<div class="stat"><div class="num">${formatMoney(b.creditLimit)}</div><div class="label">מסגרת אשראי</div></div>`);
  }
  if (b.obligo != null) {
    extra.push(`<div class="stat"><div class="num">${formatMoney(b.obligo)}</div><div class="label">ניצול אשראי (אובליגו)</div></div>`);
  }
  return `
    <div class="summary-grid">
      ${
        hasDebt
          ? `<div class="stat debt">
               <div class="num">${formatMoney(b.openTotal)}</div>
               <div class="label">יתרה לתשלום · ${b.openCount} חשבוניות · <a href="#invoices">פירוט</a></div>
             </div>`
          : `<div class="stat clear">
               <div class="num">אין יתרה ✓</div>
               <div class="label">כל החשבוניות שולמו · <a href="#invoices">היסטוריה</a></div>
             </div>`
      }
      ${extra.join('')}
    </div>`;
}
