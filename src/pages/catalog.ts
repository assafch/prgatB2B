import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface CatalogItem {
  partname: string;
  partdes: string | null;
  family: string | null;
  family_desc: string | null;
  barcode: string | null;
  price: number | null;
  image_url: string | null;
  box_size: number;
}

interface Family {
  family: string;
  family_desc: string | null;
  count: number;
}

const state = { q: '', family: '', page: 1, pageSize: 24 };

export async function renderCatalog(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="card" style="margin-bottom:0.75rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
      <input id="q" placeholder="חיפוש מוצר / מק״ט / ברקוד" style="flex:1;min-width:240px" />
      <select id="family" style="width:auto"><option value="">כל המשפחות</option></select>
      <button id="search">חפש</button>
    </div>
    <div id="catalog-grid"></div>
    <div id="pager" style="text-align:center;margin-top:1rem"></div>
  `;
  const q = shell.querySelector('#q') as HTMLInputElement;
  const famSel = shell.querySelector('#family') as HTMLSelectElement;
  const btn = shell.querySelector('#search') as HTMLButtonElement;
  q.value = state.q;
  famSel.value = state.family;

  try {
    const { families } = await api.get<{ families: Family[] }>('/api/catalog/families');
    for (const f of families) {
      const opt = document.createElement('option');
      opt.value = f.family;
      opt.textContent = `${f.family_desc || f.family} (${f.count})`;
      famSel.appendChild(opt);
    }
    famSel.value = state.family;
  } catch (ex) {
    // ignore
  }

  const doSearch = () => {
    state.q = q.value.trim();
    state.family = famSel.value;
    state.page = 1;
    load(shell);
  };
  btn.addEventListener('click', doSearch);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  // Search-as-you-type (debounced) so store owners don't have to hunt for a button.
  let debounce: number | undefined;
  q.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = window.setTimeout(doSearch, 350);
  });
  famSel.addEventListener('change', doSearch);

  await load(shell);
}

async function load(shell: HTMLElement): Promise<void> {
  const grid = shell.querySelector('#catalog-grid') as HTMLDivElement;
  const pager = shell.querySelector('#pager') as HTMLDivElement;
  grid.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.family) params.set('family', state.family);
    params.set('page', String(state.page));
    params.set('pageSize', String(state.pageSize));
    const { items, total } = await api.get<{ items: CatalogItem[]; total: number }>(
      `/api/catalog?${params}`
    );
    if (items.length === 0) {
      grid.innerHTML = `<div class="card muted">לא נמצאו מוצרים. אם הקטלוג ריק, אדמין צריך להריץ סנכרון מ-Priority.</div>`;
      pager.innerHTML = '';
      return;
    }
    grid.style.cssText = `
      display:grid;
      grid-template-columns:repeat(2,1fr);
      gap:0.75rem;
    `;
    grid.innerHTML = items
      .map(
        (it) => `
      <div class="card" style="display:flex;flex-direction:column;gap:0.5rem">
        <div style="aspect-ratio:1;background:#f3f4f6;border-radius:6px;display:grid;place-items:center;color:#9ca3af;font-size:0.85rem">
          ${it.image_url ? `<img src="${escapeAttr(it.image_url)}" style="max-width:100%;max-height:100%"/>` : 'אין תמונה'}
        </div>
        <a href="#product/${encodeURIComponent(it.partname)}" style="font-weight:500;color:var(--text)">
          ${escapeHtml(it.partdes || it.partname)}
        </a>
        <div class="muted" style="font-size:0.85rem">${escapeHtml(it.partname)} · ארגז: ${it.box_size}</div>
        <div style="font-weight:700;color:var(--brand)">
          ${it.price != null ? `₪${it.price.toFixed(2)}` : '<span class="muted">צור קשר</span>'}
        </div>
        <div style="display:flex;gap:0.25rem;align-items:stretch">
          <div style="display:flex;flex-direction:column;gap:1px">
            <button class="step-up" data-part="${escapeAttr(it.partname)}" data-step="${it.box_size}" title="הוסף ${it.box_size}" style="padding:0 0.5rem;height:1.1rem;line-height:1;font-size:0.7rem">▲</button>
            <button class="step-down" data-part="${escapeAttr(it.partname)}" data-step="${it.box_size}" title="הפחת ${it.box_size}" style="padding:0 0.5rem;height:1.1rem;line-height:1;font-size:0.7rem">▼</button>
          </div>
          <input type="number" min="0" step="1" value="0" class="qty" data-part="${escapeAttr(it.partname)}" style="width:60px;text-align:center"/>
          <button class="add" data-part="${escapeAttr(it.partname)}" style="flex:1">הוסף</button>
        </div>
      </div>`
      )
      .join('');

    const stepInput = (part: string, delta: number): void => {
      const input = grid.querySelector<HTMLInputElement>(`input.qty[data-part="${cssEscape(part)}"]`);
      if (!input) return;
      const current = Number(input.value) || 0;
      const next = Math.max(0, current + delta);
      input.value = String(next);
    };

    grid.querySelectorAll<HTMLButtonElement>('button.step-up').forEach((b) => {
      b.addEventListener('click', () => stepInput(b.dataset.part!, Number(b.dataset.step) || 1));
    });
    grid.querySelectorAll<HTMLButtonElement>('button.step-down').forEach((b) => {
      b.addEventListener('click', () => stepInput(b.dataset.part!, -(Number(b.dataset.step) || 1)));
    });

    grid.querySelectorAll<HTMLButtonElement>('button.add').forEach((b) => {
      b.addEventListener('click', async () => {
        const part = b.dataset.part!;
        const input = grid.querySelector<HTMLInputElement>(`input.qty[data-part="${cssEscape(part)}"]`)!;
        const qty = Number(input.value);
        if (!isFinite(qty) || qty <= 0) {
          input.focus();
          return;
        }
        b.disabled = true;
        try {
          await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: qty });
          await refreshCartCount();
          b.textContent = '✓ נוסף';
          input.value = '0';
          setTimeout(() => {
            b.textContent = 'הוסף';
            b.disabled = false;
          }, 1200);
        } catch (ex) {
          toast(ex instanceof Error ? ex.message : String(ex), 'error');
          b.textContent = 'הוסף';
          b.disabled = false;
        }
      });
    });

    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    pager.innerHTML = `
      <button ${state.page <= 1 ? 'disabled' : ''} id="prev">‹ הקודם</button>
      <span style="margin:0 1rem">עמוד ${state.page} מתוך ${totalPages} · סה״כ ${total}</span>
      <button ${state.page >= totalPages ? 'disabled' : ''} id="next">הבא ›</button>
    `;
    (pager.querySelector('#prev') as HTMLButtonElement)?.addEventListener('click', () => {
      state.page--;
      load(shell);
    });
    (pager.querySelector('#next') as HTMLButtonElement)?.addEventListener('click', () => {
      state.page++;
      load(shell);
    });
  } catch (ex) {
    grid.innerHTML = `<div class="card error">שגיאת טעינה: ${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}
