import { api } from '../api.js';
import { supportsPasskeys, serverPasskeysEnabled, passkeyLogin } from '../webauthn.js';

export function renderLogin(shell: HTMLElement, onSuccess: () => Promise<void> | void): void {
  shell.innerHTML = `
    <div class="card" style="max-width:420px;margin:3rem auto;">
      <h1 style="margin-top:0">התחברות</h1>
      <div id="passkey-zone" style="display:none">
        <button id="passkey-login" type="button" style="width:100%">כניסה עם Face ID / טביעת אצבע</button>
        <div class="sep">או</div>
      </div>
      <form id="login-form">
        <label>שם משתמש</label>
        <input name="username" autocomplete="username webauthn" required />
        <div style="height:0.5rem"></div>
        <label>סיסמה</label>
        <input name="password" type="password" autocomplete="current-password webauthn" required />
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

  const friendly = (raw: string): string =>
    ({
      invalid_credentials: 'שם משתמש או סיסמה שגויים',
      account_locked: 'החשבון ננעל זמנית עקב ניסיונות כושלים — נסו שוב בעוד מספר דקות',
      missing_credentials: 'נא למלא שם משתמש וסיסמה',
    })[raw] ?? raw;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fd = new FormData(form);
    try {
      await api.post('/api/auth/login', { username: fd.get('username'), password: fd.get('password') });
      await onSuccess();
    } catch (ex) {
      err.textContent = friendly(ex instanceof Error ? ex.message : String(ex));
    }
  });

  // Offer passkey login only when both the browser and the server support it.
  if (supportsPasskeys()) {
    serverPasskeysEnabled().then((enabled) => {
      if (!enabled) return;
      const zone = shell.querySelector('#passkey-zone') as HTMLDivElement;
      zone.style.display = 'block';
      const btn = shell.querySelector('#passkey-login') as HTMLButtonElement;
      btn.addEventListener('click', async () => {
        err.textContent = '';
        btn.disabled = true;
        try {
          await passkeyLogin();
          await onSuccess();
        } catch (ex) {
          const raw = ex instanceof Error ? ex.message : String(ex);
          // User-cancelled ceremonies throw NotAllowedError/AbortError — stay quiet.
          if (!/NotAllowed|AbortError|cancel/i.test(raw)) {
            err.textContent = raw === 'invalid_credentials' ? 'המפתח לא זוהה — התחברו עם סיסמה' : 'הכניסה הביומטרית נכשלה — נסו סיסמה';
          }
          btn.disabled = false;
        }
      });
    });
  }
}
