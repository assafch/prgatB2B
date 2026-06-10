import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}
interface Proposal {
  partname: string;
  partdes: string | null;
  price: number | null;
  qty: number;
}

export function renderAssistant(shell: HTMLElement): void {
  const messages: Msg[] = [];
  shell.innerHTML = `
    <div class="asst-wrap">
      <div class="asst-head">
        <h1 style="margin:0;font-size:1.25rem">שאל את אורגת 🤖</h1>
        <div class="muted" style="font-size:0.85rem">מוצרים, מחירים, יתרת חוב, או "תזמין כמו הרגיל"</div>
      </div>
      <div id="asst-log" class="asst-log"></div>
      <div id="asst-chips" class="asst-chips">
        <button type="button" class="chip-q">כמה אני חייב?</button>
        <button type="button" class="chip-q">מה יש לכם לניקוי רובה?</button>
        <button type="button" class="chip-q">הסל הרגיל שלי</button>
      </div>
      <form id="asst-form" class="asst-input">
        <input id="asst-text" placeholder="כתבו שאלה…" autocomplete="off"/>
        <button type="submit">שליחה</button>
      </form>
    </div>`;

  const log = shell.querySelector('#asst-log') as HTMLElement;
  const form = shell.querySelector('#asst-form') as HTMLFormElement;
  const text = shell.querySelector('#asst-text') as HTMLInputElement;
  const chips = shell.querySelector('#asst-chips') as HTMLElement;
  let busy = false;

  const bubble = (role: 'user' | 'assistant', content: string): HTMLElement => {
    const d = document.createElement('div');
    d.className = 'asst-bubble ' + role;
    d.textContent = content; // textContent = injection-safe; CSS pre-wrap keeps line breaks
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  };

  const addProposals = (props: Proposal[]) => {
    if (!props.length) return;
    const wrap = document.createElement('div');
    wrap.className = 'asst-bubble assistant';
    wrap.innerHTML =
      '<div class="muted" style="font-size:0.78rem;margin-bottom:0.35rem">להוספה לסל:</div>' +
      props
        .map((p, i) => `<button type="button" class="prop-chip" data-i="${i}">➕ ${escapeHtml(p.partdes || p.partname)} · ×${p.qty} · ₪${(p.price || 0).toFixed(2)}</button>`)
        .join('');
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
    wrap.querySelectorAll<HTMLButtonElement>('.prop-chip').forEach((b) =>
      b.addEventListener('click', async () => {
        const p = props[Number(b.dataset.i)];
        b.disabled = true;
        try {
          await api.put(`/api/cart/lines/${encodeURIComponent(p.partname)}`, { quantity: p.qty, mode: 'add' });
          await refreshCartCount();
          toast('נוסף לסל ✓', 'ok');
          b.textContent = '✓ נוסף לסל';
        } catch (ex) {
          toast(ex instanceof Error ? ex.message : String(ex), 'error');
          b.disabled = false;
        }
      })
    );
  };

  async function send(q: string): Promise<void> {
    q = q.trim();
    if (!q || busy) return;
    busy = true;
    chips.style.display = 'none';
    bubble('user', q);
    messages.push({ role: 'user', content: q });
    const thinking = bubble('assistant', '…');
    thinking.classList.add('muted');
    try {
      const r = await api.post<{ reply: string; proposals: Proposal[] }>('/api/assistant', { messages });
      thinking.remove();
      bubble('assistant', r.reply);
      messages.push({ role: 'assistant', content: r.reply });
      addProposals(r.proposals || []);
    } catch (ex) {
      thinking.remove();
      bubble('assistant', ex instanceof Error ? ex.message : String(ex)).classList.add('error');
    } finally {
      busy = false;
    }
  }

  bubble('assistant', 'שלום! אני העוזר של אורגת. אפשר לשאול על מוצרים, מחירים, יתרת החוב, או לבקש "תזמין כמו הרגיל".');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = text.value;
    text.value = '';
    void send(q);
  });
  chips.querySelectorAll<HTMLButtonElement>('.chip-q').forEach((b) => b.addEventListener('click', () => void send(b.textContent || '')));
}
