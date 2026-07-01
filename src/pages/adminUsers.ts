import { api } from '../api.js';
import { escapeHtml, escapeAttr } from '../format.js';
import { toast } from '../ui.js';

interface AUser {
  id: number;
  username: string;
  role: string;
  custname: string | null;
  cust_desc: string | null;
  status: string;
  last_login_at: string | null;
  created_at: string;
}

// Customer / login management: create a login directly, reset a password,
// enable/disable. Admin accounts are protected server-side from these actions.
export async function renderUsersAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `<div class="muted">טוען…</div>`;
  let users: AUser[] = [];
  try {
    users = (await api.get<{ users: AUser[] }>('/api/admin/users/detailed')).users;
  } catch (ex) {
    c.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
    return;
  }

  c.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">יצירת התחברות ללקוח</h2>
      <div class="form-grid">
        <input id="u-username" placeholder="שם משתמש"/>
        <input id="u-password" placeholder="סיסמה (6+ תווים)"/>
        <input id="u-custname" placeholder="מספר לקוח ב-Priority (custname)"/>
        <input id="u-desc" placeholder="שם העסק (אופציונלי)"/>
      </div>
      <select id="u-role" style="margin-top:0.4rem;width:100%">
        <option value="owner">אחראי (גישה לחיוב/תשלום)</option>
        <option value="orderer">מזמין (הזמנות בלבד)</option>
      </select>
      <button id="u-create" style="margin-top:0.6rem;width:100%">צור משתמש</button>
      <div id="u-cmsg" style="margin-top:0.5rem;text-align:center"></div>
    </div>
    <div class="card" style="margin-top:0.75rem">
      <h2 style="margin-top:0">משתמשים רשומים (${users.length})</h2>
      <div id="u-list"></div>
      <div id="u-msg" style="margin-top:0.5rem;text-align:center"></div>
    </div>`;

  const list = c.querySelector('#u-list') as HTMLElement;
  list.innerHTML = users
    .map(
      (u) => `
      <div class="dash-row" style="border-bottom:1px solid var(--border);padding:0.55rem 0">
        <div class="grow">
          <div style="font-weight:700">${escapeHtml(u.username)}
            ${u.role === 'admin' ? '<span class="badge warn">מנהל</span>' : ''}
            ${u.status !== 'active' ? '<span class="chip error">מושבת</span>' : ''}</div>
          <div class="muted" style="font-size:0.82rem">${escapeHtml(u.cust_desc || '')}${u.custname ? ' · ' + escapeHtml(u.custname) : ''} · התחבר: ${u.last_login_at ? escapeHtml(u.last_login_at.slice(0, 10)) : '—'}</div>
        </div>
        ${
          u.role !== 'admin'
            ? `<button class="ghost u-reset" data-id="${u.id}" data-name="${escapeAttr(u.username)}">איפוס סיסמה</button>
               <button class="ghost u-toggle" data-id="${u.id}" data-status="${escapeAttr(u.status)}">${u.status === 'active' ? 'השבת' : 'הפעל'}</button>
               <button class="ghost u-edit" data-id="${u.id}" data-name="${escapeAttr(u.username)}" data-custname="${escapeAttr(u.custname || '')}" data-desc="${escapeAttr(u.cust_desc || '')}">ערוך מספר לקוח</button>
               <button class="ghost u-del" data-id="${u.id}" data-name="${escapeAttr(u.username)}">מחק</button>`
            : ''
        }
      </div>`
    )
    .join('');

  const cmsg = c.querySelector('#u-cmsg') as HTMLDivElement;
  (c.querySelector('#u-create') as HTMLButtonElement).onclick = async () => {
    cmsg.textContent = 'יוצר…';
    cmsg.className = 'muted';
    try {
      await api.post('/api/admin/users', {
        username: (c.querySelector('#u-username') as HTMLInputElement).value.trim(),
        password: (c.querySelector('#u-password') as HTMLInputElement).value,
        custname: (c.querySelector('#u-custname') as HTMLInputElement).value.trim(),
        cust_desc: (c.querySelector('#u-desc') as HTMLInputElement).value.trim(),
        customer_role: (c.querySelector('#u-role') as HTMLSelectElement).value,
      });
      cmsg.textContent = '✓ המשתמש נוצר';
      cmsg.className = 'ok';
      setTimeout(() => renderUsersAdmin(c), 600);
    } catch (ex) {
      cmsg.textContent = ex instanceof Error ? ex.message : String(ex);
      cmsg.className = 'error';
    }
  };

  const msg = c.querySelector('#u-msg') as HTMLDivElement;
  list.querySelectorAll<HTMLButtonElement>('.u-reset').forEach((b) => {
    b.onclick = async () => {
      const np = window.prompt(`סיסמה חדשה ל-${b.dataset.name} (6+ תווים):`);
      if (!np) return;
      msg.textContent = 'מאפס…';
      msg.className = 'muted';
      try {
        await api.post(`/api/admin/users/${b.dataset.id}/reset-password`, { new_password: np });
        msg.textContent = '✓ הסיסמה אופסה (החיבורים הקיימים נותקו)';
        msg.className = 'ok';
      } catch (ex) {
        msg.textContent = ex instanceof Error ? ex.message : String(ex);
        msg.className = 'error';
      }
    };
  });
  list.querySelectorAll<HTMLButtonElement>('.u-toggle').forEach((b) => {
    b.onclick = async () => {
      const next = b.dataset.status === 'active' ? 'disabled' : 'active';
      msg.textContent = 'מעדכן…';
      msg.className = 'muted';
      try {
        await api.post(`/api/admin/users/${b.dataset.id}/status`, { status: next });
        renderUsersAdmin(c);
      } catch (ex) {
        msg.textContent = ex instanceof Error ? ex.message : String(ex);
        msg.className = 'error';
      }
    };
  });
  list.querySelectorAll<HTMLButtonElement>('.u-edit').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.id!;
      const curCust = b.dataset.custname || '';
      const curDesc = b.dataset.desc || '';
      const custname = window.prompt('מספר לקוח ב-Priority (custname):', curCust);
      if (custname === null) return;
      const cust_desc = window.prompt('שם העסק (אופציונלי):', curDesc) ?? '';
      try {
        await api.patch(`/api/admin/users/${id}`, { custname, cust_desc });
        toast('עודכן ✓', 'ok');
        renderUsersAdmin(c);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      }
    };
  });
  list.querySelectorAll<HTMLButtonElement>('.u-del').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.id!;
      if (!window.confirm(`למחוק את המשתמש ${b.dataset.name}? פעולה בלתי הפיכה.`)) return;
      try {
        await api.del(`/api/admin/users/${id}`);
        toast('נמחק', 'ok');
        renderUsersAdmin(c);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      }
    };
  });
}
