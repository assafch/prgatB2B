import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { toast } from '../ui.js';

interface ParseResult {
  id: string;
  aiAvailable: boolean;
  ai: null | {
    isCheck: boolean;
    amount: number | null;
    date: string | null;
    isPostdated: boolean | null;
    bank: string | null;
    branch: string | null;
    account: string | null;
    checkNumber: string | null;
    confidence: number;
    legible: boolean;
    notes: string | null;
  };
}

export function renderPayCheck(shell: HTMLElement): void {
  shell.innerHTML = `
    <div class="card">
      <h1 style="margin-top:0">תשלום בצ׳ק</h1>
      <p class="muted" style="margin-top:-0.3rem">צלמו את הצ׳ק — נזהה את הסכום והתאריך אוטומטית. הצ׳ק הפיזי ייאסף ע״י הנהג כרגיל.</p>
      <label id="capture" class="check-capture">
        <input type="file" id="check-file" accept="image/*" capture="environment" hidden/>
        <div class="cc-inner">
          <div style="font-size:2.5rem">📸</div>
          <div style="font-weight:700;margin-top:0.3rem">צלמו או בחרו תמונה של הצ׳ק</div>
          <div class="muted" style="font-size:0.85rem">JPG / PNG, עד 8MB</div>
        </div>
      </label>
      <div id="pc-body"></div>
    </div>
  `;
  const fileInput = shell.querySelector('#check-file') as HTMLInputElement;
  const capture = shell.querySelector('#capture') as HTMLElement;
  const body = shell.querySelector('#pc-body') as HTMLElement;

  capture.addEventListener('click', (e) => {
    // The <label> already triggers the input; guard against double-fire.
    if ((e.target as HTMLElement).id !== 'check-file') fileInput.click();
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    body.innerHTML = `<div class="card" style="text-align:center"><div class="muted">מעלה וקורא את הצ׳ק…</div></div>`;
    const fd = new FormData();
    fd.append('image', file);
    let result: ParseResult;
    try {
      const res = await fetch('/api/payments/check/parse', { method: 'POST', credentials: 'include', body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      result = await res.json();
    } catch (ex) {
      body.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
      return;
    }
    renderConfirm(body, file, result);
  });
}

function renderConfirm(body: HTMLElement, file: File, r: ParseResult): void {
  const ai = r.ai;
  const previewUrl = URL.createObjectURL(file);
  const amount = ai?.amount != null ? String(ai.amount) : '';
  const date = ai?.date || '';
  const aiNote = ai
    ? ai.isCheck === false
      ? '⚠️ לא זוהה צ׳ק בתמונה — אנא הזינו את הפרטים ידנית.'
      : ai.legible === false
        ? '⚠️ הצ׳ק לא נקרא בבירור — בדקו את הפרטים.'
        : `זוהה אוטומטית (ביטחון ${Math.round((ai.confidence || 0) * 100)}%). אנא אשרו את הפרטים.`
    : r.aiAvailable
      ? 'לא הצלחנו לקרוא את הצ׳ק — הזינו את הפרטים ידנית.'
      : 'הזינו את פרטי הצ׳ק.';

  body.innerHTML = `
    <div class="card" style="margin-top:0.75rem">
      <img src="${previewUrl}" alt="צ׳ק" style="width:100%;max-height:240px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff"/>
      <div class="${ai && (ai.isCheck === false || ai.legible === false) ? 'error' : 'muted'}" style="margin-top:0.5rem;font-size:0.88rem">${escapeHtml(aiNote)}</div>

      <label style="margin-top:0.75rem">סכום (₪)</label>
      <input id="pc-amount" type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(amount)}" placeholder="0.00"/>

      <label style="margin-top:0.5rem">תאריך הצ׳ק</label>
      <input id="pc-date" type="date" value="${escapeHtml(date)}"/>
      <div id="pc-postdated" class="badge warn" style="display:${ai?.isPostdated ? 'inline-block' : 'none'};margin-top:0.4rem">צ׳ק דחוי</div>

      ${ai && (ai.bank || ai.checkNumber)
        ? `<div class="muted" style="font-size:0.82rem;margin-top:0.6rem">${[ai.bank, ai.branch ? 'סניף ' + ai.branch : '', ai.account ? 'חשבון ' + ai.account : '', ai.checkNumber ? 'צ׳ק ' + ai.checkNumber : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>`
        : ''}

      <label style="margin-top:0.6rem">הערה (אופציונלי)</label>
      <input id="pc-note" placeholder="לדוגמה: על חשבון חוב פתוח"/>

      <button id="pc-submit" style="width:100%;margin-top:1rem;padding:0.8rem;font-weight:700">שליחת הצ׳ק לתשלום</button>
      <div id="pc-msg" style="margin-top:0.5rem;text-align:center"></div>
      <p class="muted" style="font-size:0.78rem;margin-top:0.5rem">הצ׳ק הפיזי ייאסף ע״י הנהג. זהו רישום הודעת תשלום בלבד.</p>
    </div>
  `;

  const dateInput = body.querySelector('#pc-date') as HTMLInputElement;
  const postBadge = body.querySelector('#pc-postdated') as HTMLElement;
  const recomputePostdated = () => {
    const v = dateInput.value;
    postBadge.style.display = v && v > new Date().toISOString().slice(0, 10) ? 'inline-block' : 'none';
  };
  dateInput.addEventListener('change', recomputePostdated);

  const submit = body.querySelector('#pc-submit') as HTMLButtonElement;
  const msg = body.querySelector('#pc-msg') as HTMLDivElement;
  submit.addEventListener('click', async () => {
    const amountVal = Number((body.querySelector('#pc-amount') as HTMLInputElement).value);
    const dateVal = dateInput.value;
    if (!isFinite(amountVal) || amountVal <= 0) {
      msg.textContent = 'יש להזין סכום תקין';
      msg.className = 'error';
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
      msg.textContent = 'יש להזין תאריך תקין';
      msg.className = 'error';
      return;
    }
    submit.disabled = true;
    msg.textContent = 'שולח…';
    msg.className = 'muted';
    try {
      await api.post(`/api/payments/check/${r.id}/confirm`, {
        amount: amountVal,
        checkDate: dateVal,
        isPostdated: dateVal > new Date().toISOString().slice(0, 10),
        note: (body.querySelector('#pc-note') as HTMLInputElement).value || undefined,
      });
      URL.revokeObjectURL(previewUrl);
      body.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">✅</div>
          <div class="es-title">הצ׳ק התקבל</div>
          <div class="es-sub">רשמנו תשלום בצ׳ק על סך ₪${amountVal.toFixed(2)} לתאריך ${escapeHtml(dateVal)}.<br/>הנהג יאסוף את הצ׳ק הפיזי.</div>
          <a class="es-cta" href="#payments">התשלומים שלי</a>
          <div style="margin-top:0.75rem"><a href="#home">חזרה לדף הבית</a></div>
        </div>`;
      toast('הצ׳ק נרשם ✓', 'ok');
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
      submit.disabled = false;
    }
  });
}
