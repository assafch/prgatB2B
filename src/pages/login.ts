import { api } from '../api.js';

export function renderLogin(shell: HTMLElement, onSuccess: () => Promise<void> | void): void {
  shell.innerHTML = `
    <div class="card" style="max-width:420px;margin:3rem auto;">
      <h1 style="margin-top:0">התחברות</h1>
      <form id="login-form">
        <label>שם משתמש</label>
        <input name="username" autocomplete="username" required />
        <div style="height:0.5rem"></div>
        <label>סיסמה</label>
        <input name="password" type="password" autocomplete="current-password" required />
        <div style="height:1rem"></div>
        <button type="submit" style="width:100%">היכנס</button>
        <div id="login-err" class="error" style="margin-top:0.5rem"></div>
      </form>
      <p class="muted" style="margin-top:1.5rem;text-align:center">
        עדיין לא לקוח? <a href="#lead">צור קשר</a>
      </p>
    </div>
  `;
  const form = shell.querySelector('#login-form') as HTMLFormElement;
  const err = shell.querySelector('#login-err') as HTMLDivElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(form);
    try {
      await api.post('/api/auth/login', {
        username: fd.get('username'),
        password: fd.get('password'),
      });
      await onSuccess();
    } catch (ex) {
      err.textContent = ex instanceof Error ? ex.message : String(ex);
    }
  });
}
