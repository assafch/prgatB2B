import { api } from '../api.js';
import { formatMoney, escapeHtml, formatDateTime } from '../format.js';
import { toast, confirmDialog } from '../ui.js';
import { supportsPasskeys, serverPasskeysEnabled, passkeyRegister } from '../webauthn.js';

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

    shell.innerHTML = `
      <div class="card" style="max-width:720px;margin:0 auto">
        <h1 style="margin-top:0">החשבון שלי</h1>
        ${balanceSection(a)}
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
    `;
    renderPasskeys(shell.querySelector('#passkey-card') as HTMLElement);
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
        const raw = ex instanceof Error ? ex.message : String(ex);
        if (!/NotAllowed|AbortError|cancel/i.test(raw)) toast('ההפעלה נכשלה — נסו שוב', 'error');
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
