import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { toast } from '../ui.js';

interface ParseAi {
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
}
interface ParseResult {
  id: string;
  aiAvailable: boolean;
  ai: ParseAi | null;
}

interface CheckItem {
  draftId: string | null;
  previewUrl: string;
  ai: ParseAi | null;
  aiAvailable: boolean;
}

// Local (Israel) date as yyyy-mm-dd — avoids UTC flipping the post-dated flag near midnight.
const today = () => new Date().toLocaleDateString('en-CA');

export function renderPayCheck(shell: HTMLElement): void {
  shell.innerHTML = `
    <div class="card">
      <h1 style="margin-top:0">תשלום בצ׳ק</h1>
      <p class="muted" style="margin-top:-0.3rem">צלמו כל צ׳ק — נזהה אוטומטית את הסכום והתאריך. אפשר להוסיף כמה צ׳קים יחד.</p>
      <div class="muted" style="font-size:0.82rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:0.5rem 0.7rem;margin-bottom:0.75rem">
        💡 צלמו את כל הצ׳ק במסגרת, ממוקד ומואר היטב — התמונה משמשת לפירעון הצ׳ק.
      </div>
      <input type="file" id="pc-cam" accept="image/*" capture="environment" hidden/>
      <input type="file" id="pc-gal" accept="image/*" multiple hidden/>
      <div style="display:flex;gap:0.5rem">
        <button id="pc-cam-btn" style="flex:1">📸 סרוק צ׳ק</button>
        <button id="pc-gal-btn" class="ghost" style="flex:1">🖼️ מהגלריה</button>
      </div>
    </div>
    <div id="pc-list"></div>
    <div id="pc-footer"></div>
  `;
  const cam = shell.querySelector('#pc-cam') as HTMLInputElement;
  const gal = shell.querySelector('#pc-gal') as HTMLInputElement;
  const list = shell.querySelector('#pc-list') as HTMLElement;
  const footer = shell.querySelector('#pc-footer') as HTMLElement;
  const items: CheckItem[] = [];

  // Live guided scanner where supported (needs a camera + secure context); otherwise
  // fall back to the OS camera/file picker.
  const canScan = !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
  (shell.querySelector('#pc-cam-btn') as HTMLButtonElement).onclick = () => (canScan ? openScanner() : cam.click());
  (shell.querySelector('#pc-gal-btn') as HTMLButtonElement).onclick = () => gal.click();

  const onFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    for (const file of Array.from(files)) await addCheck(file);
    renderFooter();
  };
  cam.addEventListener('change', () => {
    onFiles(cam.files);
    cam.value = '';
  });
  gal.addEventListener('change', () => {
    onFiles(gal.files);
    gal.value = '';
  });

  // Try the in-app framed live scanner. Request the camera FIRST and only build the
  // overlay if it's granted — so a blocked/unsupported camera opens the device
  // camera directly (no black screen, no dead-end). The native picker is the most
  // reliable "open the camera" path and works in every browser.
  function openScanner(): void {
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((stream) => showScanner(stream))
      .catch(() => cam.click());
  }

  function showScanner(stream: MediaStream): void {
    const ov = document.createElement('div');
    ov.className = 'scan-overlay';
    ov.innerHTML = `
      <video class="scan-video" autoplay playsinline muted></video>
      <div class="scan-mask"><div class="scan-frame"><i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i></div></div>
      <div class="scan-hint">הצמידו את הצ׳ק לאורך המסגרת<br/><span>מואר, חד, וממלא את כל המסגרת</span></div>
      <button class="scan-close" type="button" aria-label="סגירה">✕</button>
      <div class="scan-bar"><button class="scan-shutter" type="button" aria-label="צלם"></button></div>
    `;
    document.body.appendChild(ov);
    const video = ov.querySelector('.scan-video') as HTMLVideoElement;
    video.srcObject = stream;
    let live = true;
    const close = () => {
      live = false;
      stream.getTracks().forEach((t) => t.stop());
      ov.remove();
      window.removeEventListener('hashchange', close);
    };
    window.addEventListener('hashchange', close);
    (ov.querySelector('.scan-close') as HTMLButtonElement).onclick = close;

    (ov.querySelector('.scan-shutter') as HTMLButtonElement).onclick = () => {
      if (!live || !video.videoWidth) return;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        async (blob) => {
          close();
          if (blob) {
            await addCheck(blob);
            renderFooter();
          }
        },
        'image/jpeg',
        0.92
      );
    };
  }

  async function addCheck(blob: Blob): Promise<void> {
    const item: CheckItem = { draftId: null, previewUrl: URL.createObjectURL(blob), ai: null, aiAvailable: false };
    items.push(item);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.marginTop = '0.6rem';
    card.innerHTML = `<div class="muted" style="text-align:center;padding:1rem">קורא את הצ׳ק…</div>`;
    list.appendChild(card);
    try {
      const fd = new FormData();
      fd.append('image', blob, 'cheque.jpg');
      const res = await fetch('/api/payments/check/parse', { method: 'POST', credentials: 'include', body: fd });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const r: ParseResult = await res.json();
      item.draftId = r.id;
      item.ai = r.ai;
      item.aiAvailable = r.aiAvailable;
    } catch (ex) {
      card.innerHTML = `<div class="error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
      return;
    }
    renderCard(card, item);
  }

  function renderCard(card: HTMLElement, item: CheckItem): void {
    const ai = item.ai;
    const unreadable = !!ai && (ai.isCheck === false || ai.legible === false);
    const amount = ai?.amount != null ? String(ai.amount) : '';
    const date = ai?.date || '';
    const note = ai
      ? unreadable
        ? '⚠️ הצ׳ק לא נקרא בבירור — צלמו שוב או הזינו ידנית'
        : `זוהה אוטומטית (ביטחון ${Math.round((ai.confidence || 0) * 100)}%) · אשרו את הפרטים`
      : item.aiAvailable
        ? 'לא הצלחנו לקרוא — הזינו את הפרטים'
        : 'הזינו את פרטי הצ׳ק';

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>צ׳ק</strong>
        <button class="pc-remove" type="button" style="background:none;border:none;color:var(--err);cursor:pointer;font-size:0.85rem;padding:0">הסר ✕</button>
      </div>
      <img src="${item.previewUrl}" alt="צ׳ק" style="width:100%;max-height:180px;object-fit:contain;border:1px solid var(--border);border-radius:8px;background:#fff;margin-top:0.4rem"/>
      <div class="${unreadable ? 'error' : 'muted'}" style="margin-top:0.4rem;font-size:0.85rem">${escapeHtml(note)}</div>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
        <div style="flex:1">
          <label>סכום (₪)</label>
          <input class="pc-amount" type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(amount)}" placeholder="0.00"/>
        </div>
        <div style="flex:1">
          <label>תאריך הצ׳ק</label>
          <input class="pc-date" type="date" value="${escapeHtml(date)}"/>
        </div>
      </div>
      <div class="pc-postdated badge warn" style="display:${date && date > today() ? 'inline-block' : 'none'};margin-top:0.4rem">צ׳ק דחוי</div>
      ${ai && (ai.bank || ai.checkNumber)
        ? `<div class="muted" style="font-size:0.8rem;margin-top:0.5rem">${[ai.bank, ai.branch ? 'סניף ' + ai.branch : '', ai.account ? 'חשבון ' + ai.account : '', ai.checkNumber ? 'צ׳ק ' + ai.checkNumber : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>`
        : ''}
      ${unreadable ? `<button class="ghost pc-retake" type="button" style="margin-top:0.5rem;width:100%">📸 צלם שוב</button>` : ''}
    `;

    const amountEl = card.querySelector('.pc-amount') as HTMLInputElement;
    const dateEl = card.querySelector('.pc-date') as HTMLInputElement;
    const postBadge = card.querySelector('.pc-postdated') as HTMLElement;
    amountEl.addEventListener('input', renderFooter);
    dateEl.addEventListener('change', () => {
      postBadge.style.display = dateEl.value && dateEl.value > today() ? 'inline-block' : 'none';
    });
    (card.querySelector('.pc-remove') as HTMLButtonElement).onclick = () => {
      URL.revokeObjectURL(item.previewUrl);
      const idx = items.indexOf(item);
      if (idx >= 0) items.splice(idx, 1);
      card.remove();
      renderFooter();
    };
    const retake = card.querySelector('.pc-retake') as HTMLButtonElement | null;
    if (retake) retake.onclick = () => cam.click();
  }

  function renderFooter(): void {
    const ready = items.filter((i) => i.draftId);
    if (!ready.length) {
      footer.innerHTML = '';
      return;
    }
    const amounts = Array.from(list.querySelectorAll<HTMLInputElement>('.pc-amount')).map((el) => Number(el.value) || 0);
    const total = amounts.reduce((a, b) => a + b, 0);
    footer.innerHTML = `
      <div class="card" style="margin-top:0.6rem;position:sticky;bottom:0.5rem">
        <div style="display:flex;justify-content:space-between;font-weight:700">
          <span>${ready.length} צ׳קים</span><span>סה״כ ₪${total.toFixed(2)}</span>
        </div>
        <button id="pc-submit-all" style="width:100%;margin-top:0.6rem;padding:0.8rem;font-weight:700">שליחת כל הצ׳קים</button>
        <div id="pc-msg" style="margin-top:0.4rem;text-align:center"></div>
        <p class="muted" style="font-size:0.78rem;margin-top:0.4rem">הצ׳קים שצולמו יופקדו לפירעון. אין צורך למסור צ׳ק פיזי.</p>
      </div>`;
    (footer.querySelector('#pc-submit-all') as HTMLButtonElement).onclick = submitAll;
  }

  async function submitAll(): Promise<void> {
    const msg = footer.querySelector('#pc-msg') as HTMLDivElement;
    const cards = Array.from(list.children) as HTMLElement[];
    const jobs: { card: HTMLElement; item: CheckItem; amount: number; date: string }[] = [];
    for (let i = 0; i < cards.length; i++) {
      const item = items[i];
      if (!item?.draftId) continue;
      const amount = Number((cards[i].querySelector('.pc-amount') as HTMLInputElement).value);
      const date = (cards[i].querySelector('.pc-date') as HTMLInputElement).value;
      if (!isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        msg.textContent = `בצ׳ק ${i + 1}: יש להזין סכום ותאריך תקינים`;
        msg.className = 'error';
        cards[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      jobs.push({ card: cards[i], item, amount, date });
    }
    if (!jobs.length) return;
    const btn = footer.querySelector('#pc-submit-all') as HTMLButtonElement;
    btn.disabled = true;
    msg.textContent = 'שולח…';
    msg.className = 'muted';
    let ok = 0;
    let total = 0;
    for (const j of jobs) {
      try {
        await api.post(`/api/payments/check/${j.item.draftId}/confirm`, {
          amount: j.amount,
          checkDate: j.date,
          isPostdated: j.date > today(),
        });
        ok++;
        total += j.amount;
      } catch {
        /* continue; report partial below */
      }
    }
    if (ok === 0) {
      msg.textContent = 'השליחה נכשלה — נסו שוב';
      msg.className = 'error';
      btn.disabled = false;
      return;
    }
    items.forEach((it) => URL.revokeObjectURL(it.previewUrl));
    shell.innerHTML = `
      <div class="empty-state">
        <div class="es-icon">✅</div>
        <div class="es-title">${ok > 1 ? `${ok} צ׳קים התקבלו` : 'הצ׳ק התקבל'}</div>
        <div class="es-sub">רשמנו תשלום על סך ₪${total.toFixed(2)}.<br/>הצ׳קים יופקדו לפירעון.${ok < jobs.length ? `<br/><span style="color:var(--err)">שימו לב: ${jobs.length - ok} צ׳קים לא נשלחו, נסו שוב.</span>` : ''}</div>
        <a class="es-cta" href="#payments">התשלומים שלי</a>
        <div style="margin-top:0.75rem"><a href="#home">חזרה לדף הבית</a></div>
      </div>`;
    toast(ok > 1 ? `${ok} צ׳קים נרשמו ✓` : 'הצ׳ק נרשם ✓', 'ok');
  }
}
