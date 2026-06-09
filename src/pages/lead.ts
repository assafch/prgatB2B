import { api } from '../api.js';

export function renderLead(shell: HTMLElement): void {
  shell.innerHTML = `
    <div class="card" style="max-width:560px;margin:2rem auto;">
      <h1 style="margin-top:0">צור קשר</h1>
      <p class="muted">אנחנו אורגת סחר — יבואני FMCG. השאירו פרטים ונחזור אליכם.</p>
      <form id="lead-form">
        <label>שם העסק</label>
        <input name="business_name" required />
        <div style="height:0.5rem"></div>
        <label>איש קשר</label>
        <input name="contact_name" required />
        <div style="height:0.5rem"></div>
        <label>טלפון</label>
        <input name="phone" type="tel" required />
        <div style="height:0.5rem"></div>
        <label>אימייל</label>
        <input name="email" type="email" />
        <div style="height:0.5rem"></div>
        <label>עיר</label>
        <input name="city" />
        <div style="height:0.5rem"></div>
        <label>הערות</label>
        <textarea name="notes" rows="3"></textarea>
        <div style="height:1rem"></div>
        <button type="submit" style="width:100%">שלח</button>
        <div id="lead-msg" style="margin-top:0.5rem"></div>
      </form>
    </div>
  `;
  const form = shell.querySelector('#lead-form') as HTMLFormElement;
  const msg = shell.querySelector('#lead-msg') as HTMLDivElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const data: Record<string, string> = {};
    fd.forEach((v, k) => (data[k] = String(v)));
    try {
      await api.post('/api/leads', data);
      shell.innerHTML = `
        <div class="card" style="max-width:560px;margin:3rem auto;text-align:center">
          <h2 class="ok">תודה!</h2>
          <p>פנייתך התקבלה. נחזור אליך בהקדם.</p>
          <a href="#login">חזרה</a>
        </div>`;
    } catch (ex) {
      msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
      msg.className = 'error';
    }
  });
}
