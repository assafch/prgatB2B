import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount } from '../main.js';
import { showUpsell } from './upsell.js';

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

const state = { q: '', family: '', page: 1, pageSize: 24, view: 'grid' as 'grid' | 'list' };
let favSet = new Set<string>();

export async function renderCatalog(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="card" style="margin-bottom:0.75rem;display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">
      <input id="q" placeholder="חיפוש מוצר / מק״ט / ברקוד" style="flex:1;min-width:200px" />
      <select id="family" style="width:auto"><option value="">כל המשפחות</option></select>
      <button id="search">חפש</button>
      <div class="view-toggle" role="group" aria-label="תצוגה">
        <button id="view-grid" title="תצוגת רשת" aria-label="רשת">▦</button>
        <button id="view-list" title="תצוגת רשימה" aria-label="רשימה">☰</button>
      </div>
      <a href="#scan" class="fav-link" title="סריקת ברקוד" aria-label="סריקת ברקוד">📷</a>
      <a href="#favorites" class="fav-link" title="המועדפים שלי" aria-label="מועדפים">❤️</a>
    </div>
    <div id="catalog-grid"></div>
    <div id="pager" style="text-align:center;margin-top:1rem"></div>
  `;
  const q = shell.querySelector('#q') as HTMLInputElement;
  const famSel = shell.querySelector('#family') as HTMLSelectElement;
  const btn = shell.querySelector('#search') as HTMLButtonElement;
  q.value = state.q;
  famSel.value = state.family;

  // View preference (grid/list) persists across visits.
  const saved = localStorage.getItem('catalog_view');
  if (saved === 'list' || saved === 'grid') state.view = saved;
  const gridBtn = shell.querySelector('#view-grid') as HTMLButtonElement;
  const listBtn = shell.querySelector('#view-list') as HTMLButtonElement;
  const syncToggle = () => {
    gridBtn.classList.toggle('active', state.view === 'grid');
    listBtn.classList.toggle('active', state.view === 'list');
  };
  const setView = (v: 'grid' | 'list') => {
    state.view = v;
    localStorage.setItem('catalog_view', v);
    syncToggle();
    load(shell);
  };
  gridBtn.addEventListener('click', () => setView('grid'));
  listBtn.addEventListener('click', () => setView('list'));
  syncToggle();

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
    if (state.view === 'list') params.set('sort', 'family'); // group consecutive same-family rows
    params.set('page', String(state.page));
    params.set('pageSize', String(state.pageSize));
    const { items, total } = await api.get<{ items: CatalogItem[]; total: number }>(
      `/api/catalog?${params}`
    );
    try {
      favSet = new Set((await api.get<{ partnames: string[] }>('/api/favorites')).partnames);
    } catch {
      /* hearts just render empty */
    }
    if (items.length === 0) {
      grid.innerHTML = `<div class="card muted">לא נמצאו מוצרים. אם הקטלוג ריק, אדמין צריך להריץ סנכרון מ-Priority.</div>`;
      pager.innerHTML = '';
      return;
    }
    const isList = state.view === 'list';
    grid.className = isList ? 'cat-list' : '';
    grid.style.cssText = isList ? '' : 'display:grid;grid-template-columns:repeat(2,1fr);gap:0.75rem;';
    if (isList) {
      // Group consecutive same-family rows (server sorts by family) into collapsible
      // accordion sections — click a family title to fold/unfold its products.
      const groups: Array<{ fam: string; items: CatalogItem[] }> = [];
      for (const it of items) {
        const fam = it.family_desc || it.family || 'ללא משפחה';
        if (!groups.length || groups[groups.length - 1].fam !== fam) groups.push({ fam, items: [] });
        groups[groups.length - 1].items.push(it);
      }
      grid.innerHTML = groups
        .map(
          (g) => `
        <div class="cat-fam-group">
          <button type="button" class="cat-fam-head" aria-expanded="true">
            <span class="cat-fam-chev">▾</span>
            <span class="cat-fam-name">${escapeHtml(g.fam)}</span>
            <span class="cat-fam-count">${g.items.length}</span>
          </button>
          <div class="cat-fam-items">${g.items.map(listRow).join('')}</div>
        </div>`
        )
        .join('');
      grid.querySelectorAll<HTMLButtonElement>('.cat-fam-head').forEach((h) => {
        h.addEventListener('click', () => {
          const group = h.closest('.cat-fam-group');
          const collapsed = group?.classList.toggle('collapsed');
          h.setAttribute('aria-expanded', String(!collapsed));
        });
      });
    } else {
      grid.innerHTML = items.map(gridCard).join('');
    }

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
          await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: qty, mode: 'add' });
          await refreshCartCount();
          b.textContent = '✓ נוסף';
          input.value = '0';
          setTimeout(() => {
            b.textContent = 'הוסף';
            b.disabled = false;
          }, 1200);
          // Upsell popup on grid adds; list view stays fast for bulk ordering.
          if (state.view !== 'list') void showUpsell(part);
        } catch (ex) {
          toast(ex instanceof Error ? ex.message : String(ex), 'error');
          b.textContent = 'הוסף';
          b.disabled = false;
        }
      });
    });

    grid.querySelectorAll<HTMLButtonElement>('button.fav').forEach((b) => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const part = b.dataset.part!;
        try {
          const r = await api.post<{ favorited: boolean }>('/api/favorites', { partname: part });
          if (r.favorited) {
            favSet.add(part);
            b.textContent = '♥';
            b.classList.add('on');
          } else {
            favSet.delete(part);
            b.textContent = '♡';
            b.classList.remove('on');
          }
        } catch (ex) {
          toast(ex instanceof Error ? ex.message : String(ex), 'error');
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

function priceHtml(it: CatalogItem): string {
  return it.price != null ? `₪${it.price.toFixed(2)}` : '<span class="muted">צור קשר</span>';
}

function gridCard(it: CatalogItem): string {
  return `
    <div class="card" style="display:flex;flex-direction:column;gap:0.5rem">
      <div style="position:relative;aspect-ratio:1;background:#f3f4f6;border-radius:6px;display:grid;place-items:center;color:#9ca3af;font-size:0.85rem">
        ${it.image_url ? `<img src="${escapeAttr(it.image_url)}" style="max-width:100%;max-height:100%"/>` : 'אין תמונה'}
        <button class="fav fav-over ${favSet.has(it.partname) ? 'on' : ''}" data-part="${escapeAttr(it.partname)}" type="button" aria-label="מועדף">${favSet.has(it.partname) ? '♥' : '♡'}</button>
      </div>
      <a href="#product/${encodeURIComponent(it.partname)}" style="font-weight:500;color:var(--text)">${escapeHtml(it.partdes || it.partname)}</a>
      <div class="muted" style="font-size:0.85rem">${escapeHtml(it.partname)} · ארגז: ${it.box_size}</div>
      <div style="font-weight:700;color:var(--brand)">${priceHtml(it)}<span class="muted" style="font-weight:400;font-size:0.8rem"> ליח׳</span></div>
      <div style="display:flex;gap:0.25rem;align-items:stretch">
        <div style="display:flex;flex-direction:column;gap:1px">
          <button class="step-up" data-part="${escapeAttr(it.partname)}" data-step="${it.box_size}" title="הוסף ${it.box_size}" style="padding:0 0.5rem;height:1.1rem;line-height:1;font-size:0.7rem">▲</button>
          <button class="step-down" data-part="${escapeAttr(it.partname)}" data-step="${it.box_size}" title="הפחת ${it.box_size}" style="padding:0 0.5rem;height:1.1rem;line-height:1;font-size:0.7rem">▼</button>
        </div>
        <input type="number" min="0" step="1" value="0" class="qty" data-part="${escapeAttr(it.partname)}" style="width:60px;text-align:center"/>
        <button class="add" data-part="${escapeAttr(it.partname)}" style="flex:1">הוסף</button>
      </div>
    </div>`;
}

// Compact list row: small thumbnail · name/SKU · unit price · qty + add.
function listRow(it: CatalogItem): string {
  return `
    <div class="card cat-row">
      <a class="cat-thumb" href="#product/${encodeURIComponent(it.partname)}">
        ${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt=""/>` : '<span>—</span>'}
      </a>
      <div class="cat-row-main">
        <a href="#product/${encodeURIComponent(it.partname)}">${escapeHtml(it.partdes || it.partname)}</a>
        <div class="muted" style="font-size:0.76rem">${escapeHtml(it.partname)} · ארגז ${it.box_size}</div>
      </div>
      <div class="cat-row-price">${priceHtml(it)}<span class="muted">ליח׳</span></div>
      <button class="fav ${favSet.has(it.partname) ? 'on' : ''}" data-part="${escapeAttr(it.partname)}" type="button" aria-label="מועדף">${favSet.has(it.partname) ? '♥' : '♡'}</button>
      <div class="cat-row-add">
        <input type="number" min="0" step="1" value="${it.box_size}" class="qty" data-part="${escapeAttr(it.partname)}"/>
        <button class="add" data-part="${escapeAttr(it.partname)}">הוסף</button>
      </div>
    </div>`;
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}
