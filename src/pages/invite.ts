import { api } from '../api.js';

interface InviteInfo {
  custname: string;
  cust_desc: string | null;
  email: string | null;
  phone: string | null;
}

export async function renderInvite(
  shell: HTMLElement,
  token: string,
  onSuccess: () => Promise<void> | void
): Promise<void> {
  shell.innerHTML = `<div class="card" style="max-width:480px;margin:3rem auto">טוען הזמנה…</div>`;
  let info: InviteInfo;
  try {
    info = await api.get<InviteInfo>(`/api/invites/${encodeURIComponent(token)}`);
  } catch (ex) {
    shell.innerHTML = `
      <div class="card error" style="max-width:480px;margin:3rem auto">
        ההזמנה לא תקפה או שפג תוקפה.
      </div>`;
    return;
  }
  shell.innerHTML = `
    <div class="card" style="max-width:480px;margin:3rem auto">
      <h1 style="margin-top:0">ברוכים הבאים, ${info.cust_desc || info.custname}</h1>
      <p class="muted">בחר שם משתמש וסיסמה כדי לסיים את ההרשמה.</p>
      <form id="accept-form">
        <label>שם משתמש</label>
        <input name="username" required minlength="3" />
        <div style="height:0.5rem"></div>
        <label>סיסמה (8+ תווים)</label>
        <input name="password" type="password" required minlength="8" />
        <div style="height:1rem"></div>
        <button type="submit" style="width:100%">סיים והיכנס</button>
        <div id="acc-err" class="error" style="margin-top:0.5rem"></div>
      </form>
    </div>
  `;
  const form = shell.querySelector('#accept-form') as HTMLFormElement;
  const err = shell.querySelector('#acc-err') as HTMLDivElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(form);
    try {
      await api.post(`/api/invites/${encodeURIComponent(token)}/accept`, {
        username: fd.get('username'),
        password: fd.get('password'),
      });
      await onSuccess();
    } catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : String(ex);
    }
  });
}
