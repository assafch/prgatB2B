import { api } from '../api.js';

/** Magic-link landing: redeem → hard reload into the logged-in app. Hard
 *  navigation (not hash swap) so main.ts re-runs /api/me with the new cookie. */
export function renderLoginLink(shell: HTMLElement, token: string): void {
  shell.innerHTML = `
    <div class="empty-state">
      <div class="es-icon">🔑</div>
      <div class="es-title">מתחברים…</div>
    </div>`;
  void (async () => {
    try {
      await api.post('/api/auth/link', { token });
      sessionStorage.setItem('mll-welcome', '1');
      window.location.href = window.location.origin + '/#home';
      window.location.reload();
    } catch {
      shell.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">⏱️</div>
          <div class="es-title">הקישור אינו תקף או שפג תוקפו</div>
          <div class="es-sub">בקשו קישור חדש, או היכנסו עם שם משתמש וסיסמה.</div>
          <a class="es-cta" href="#login">לכניסה רגילה</a>
        </div>`;
    }
  })();
}
