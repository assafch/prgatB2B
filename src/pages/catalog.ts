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

const state = {
  q: '',
  family: '',
  page: 1,
  pageSize: 30,
  view: 'grid' as 'grid' | 'list',
  total: 0,
  loaded: 0,
  loading: false,
  hasMore: true,
};
let favSet = new Set<string>();
let observer: IntersectionObserver | null = null;
// list-view family grouping continuity across infinite-scroll appends
let lastFam: string | null = null;
let lastItemsEl: HTMLElement | null = null;
// request generation — bumped on every reset so a stale in-flight load is a no-op
let loadGen = 0;
// safety cap on eager auto-pulls (collapsed groups are short → guard stays true)
let autoPulls = 0;
const MAX_AUTO_PULLS = 20;

export async function renderCatalog(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="card cat-filters">
      <input id="q" placeholder="חיפוש מוצר / מק״ט / ברקוד" />
      <select id="family"><option value="">כל המשפחות</option></select>
      <div class="view-toggle" role="group" aria-label="תצוגה">
        <button id="view-grid" title="תצוגת רשת" aria-label="רשת">▦</button>
        <button id="view-list" title="תצוגת רשימה" aria-label="רשימה">☰</button>
      </div>
      <a href="#scan" class="fav-link" title="סריקת ברקוד" aria-label="סריקת ברקוד">📷</a>
      <a href="#favorites" class="fav-link" title="המועדפים שלי" aria-label="מועדפים">❤️</a>
    </div>
    <div id="catalog-grid"></div>
    <div id="cat-sentinel" style="height:1px"></div>
    <div id="cat-status" class="muted" style="text-align:center;margin:1rem 0"></div>
  `;
  const q = shell.querySelector('#q') as HTMLInputElement;
  const famSel = shell.querySelector('#family') as HTMLSelectElement;
  q.value = state.q;

  const saved = localStorage.getItem('catalog_view');
  if (saved === 'list' || saved === 'grid') state.view = saved;
  const gridBtn = shell.querySelector('#view-grid') as HTMLButtonElement;
  const listBtn = shell.querySelector('#view-list') as HTMLButtonElement;
  const syncToggle = () => {
    gridBtn.classList.toggle('active', state.view === 'grid');
    listBtn.classList.toggle('active', state.view === 'list');
  };
  gridBtn.addEventListener('click', () => {
    if (state.view === 'grid') return;
    state.view = 'grid';
    localStorage.setItem('catalog_view', 'grid');
    syncToggle();
    void resetAndLoad(shell);
  });
  listBtn.addEventListener('click', () => {
    if (state.view === 'list') return;
    state.view = 'list';
    localStorage.setItem('catalog_view', 'list');
    syncToggle();
    void resetAndLoad(shell);
  });
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
  } catch {
    /* ignore */
  }

  const doSearch = () => {
    state.q = q.value.trim();
    state.family = famSel.value;
    void resetAndLoad(shell);
  };
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  let debounce: number | undefined;
  q.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = window.setTimeout(doSearch, 350);
  });
  famSel.addEventListener('change', doSearch);

  bindDelegation(shell);
  setupObserver(shell);
  await resetAndLoad(shell);
}

// One delegated click handler covers items appended later by infinite scroll.
function bindDelegation(shell: HTMLElement): void {
  const grid = shell.querySelector('#catalog-grid') as HTMLElement;
  const qtyInput = (part: string) => grid.querySelector<HTMLInputElement>(`input.qty[data-part="${cssEscape(part)}"]`);

  grid.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;

    const head = t.closest('.cat-fam-head') as HTMLElement | null;
    if (head) {
      const group = head.closest('.cat-fam-group');
      const collapsed = group?.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', String(!collapsed));
      return;
    }

    const fav = t.closest('button.fav') as HTMLButtonElement | null;
    if (fav) {
      e.preventDefault();
      const part = fav.dataset.part!;
      try {
        const r = await api.post<{ favorited: boolean }>('/api/favorites', { partname: part });
        fav.classList.toggle('on', r.favorited);
        fav.textContent = r.favorited ? '♥' : '♡';
        if (r.favorited) favSet.add(part);
        else favSet.delete(part);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      }
      return;
    }

    const up = t.closest('button.step-up') as HTMLButtonElement | null;
    const down = t.closest('button.step-down') as HTMLButtonElement | null;
    if (up || down) {
      const b = (up || down)!;
      const input = qtyInput(b.dataset.part!);
      if (input) {
        const step = Number(b.dataset.step) || 1;
        input.value = String(Math.max(0, (Number(input.value) || 0) + (up ? step : -step)));
      }
      return;
    }

    const add = t.closest('button.add') as HTMLButtonElement | null;
    if (add) {
      const part = add.dataset.part!;
      const input = qtyInput(part);
      const qty = Number(input?.value);
      if (!input || !isFinite(qty) || qty <= 0) {
        input?.focus();
        return;
      }
      add.disabled = true;
      try {
        await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: qty, mode: 'add' });
        await refreshCartCount();
        add.textContent = '✓ נוסף';
        setTimeout(() => {
          add.textContent = 'הוסף';
          add.disabled = false;
        }, 1200);
        if (state.view !== 'list') void showUpsell(part);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
        add.textContent = 'הוסף';
        add.disabled = false;
      }
    }
  });
}

function setupObserver(shell: HTMLElement): void {
  const sentinel = shell.querySelector('#cat-sentinel') as HTMLElement;
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((en) => en.isIntersecting)) void loadMore(shell);
    },
    { rootMargin: '400px' }
  );
  observer.observe(sentinel);
}

async function resetAndLoad(shell: HTMLElement): Promise<void> {
  const grid = shell.querySelector('#catalog-grid') as HTMLElement;
  loadGen++; // supersede any in-flight loadMore from a prior view/query
  autoPulls = 0;
  state.page = 1;
  state.loaded = 0;
  state.total = 0;
  state.hasMore = true;
  state.loading = false;
  lastFam = null;
  lastItemsEl = null;
  grid.className = state.view === 'list' ? 'cat-list' : 'cat-grid';
  grid.innerHTML = '';
  try {
    favSet = new Set((await api.get<{ partnames: string[] }>('/api/favorites')).partnames);
  } catch {
    /* hearts render empty */
  }
  await loadMore(shell);
}

async function loadMore(shell: HTMLElement): Promise<void> {
  if (state.loading || !state.hasMore) return;
  const gen = loadGen;
  const grid = shell.querySelector('#catalog-grid') as HTMLElement | null;
  const status = shell.querySelector('#cat-status') as HTMLElement | null;
  const sentinel = shell.querySelector('#cat-sentinel') as HTMLElement | null;
  if (!grid || !status || !sentinel) return; // navigated away — shell replaced
  state.loading = true;
  status.textContent = 'טוען…';
  try {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.family) params.set('family', state.family);
    if (state.view === 'list') params.set('sort', 'family');
    params.set('page', String(state.page));
    params.set('pageSize', String(state.pageSize));
    const { items, total } = await api.get<{ items: CatalogItem[]; total: number }>(`/api/catalog?${params}`);
    if (gen !== loadGen) return; // a reset/search/view-switch superseded this load
    state.total = total;
    if (state.page === 1 && items.length === 0) {
      grid.innerHTML = `<div class="card muted">לא נמצאו מוצרים. אם הקטלוג ריק, אדמין צריך להריץ סנכרון מ-Priority.</div>`;
      status.textContent = '';
      state.hasMore = false;
      return;
    }
    if (state.view === 'list') appendList(grid, items);
    else grid.insertAdjacentHTML('beforeend', items.map(gridCard).join(''));
    state.loaded += items.length;
    state.page += 1;
    state.hasMore = state.loaded < total && items.length > 0;
    status.textContent = state.hasMore ? '' : `סה״כ ${total} מוצרים`;
  } catch (ex) {
    if (gen !== loadGen) return;
    status.textContent = '';
    if (state.page === 1) grid.innerHTML = `<div class="card error">שגיאת טעינה: ${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    state.hasMore = false;
  } finally {
    if (gen === loadGen) state.loading = false;
  }
  // Short content (e.g. collapsed groups) keeps the sentinel on-screen but the
  // observer won't re-fire without an intersection change — pull more until the
  // sentinel drops below the fold or there's nothing more. Capped to avoid a
  // request storm when collapsed families never fill the viewport.
  if (gen === loadGen && state.hasMore && autoPulls < MAX_AUTO_PULLS) {
    const rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 400) {
      autoPulls++;
      requestAnimationFrame(() => void loadMore(shell));
    }
  }
}

// Append rows into family sections, continuing a family across pages. Groups are
// keyed on the family CODE (the field the server sorts by) so continuity/counts are
// correct even if two codes share a description. When searching/filtering, groups
// start expanded so results aren't hidden behind collapsed headers.
function appendList(grid: HTMLElement, items: CatalogItem[]): void {
  const expanded = !!(state.q || state.family);
  for (const it of items) {
    const key = it.family || it.family_desc || 'ללא משפחה';
    const label = it.family_desc || it.family || 'ללא משפחה';
    if (key !== lastFam || !lastItemsEl) {
      const group = document.createElement('div');
      group.className = expanded ? 'cat-fam-group' : 'cat-fam-group collapsed';
      group.innerHTML = `
        <button type="button" class="cat-fam-head" aria-expanded="${expanded}">
          <span class="cat-fam-chev">▾</span>
          <span class="cat-fam-name">${escapeHtml(label)}</span>
          <span class="cat-fam-count">0</span>
        </button>
        <div class="cat-fam-items"></div>`;
      grid.appendChild(group);
      lastFam = key;
      lastItemsEl = group.querySelector('.cat-fam-items') as HTMLElement;
    }
    lastItemsEl.insertAdjacentHTML('beforeend', listRow(it));
    const countEl = lastItemsEl.parentElement!.querySelector('.cat-fam-count') as HTMLElement;
    countEl.textContent = String(lastItemsEl.children.length);
  }
}

function priceHtml(it: CatalogItem): string {
  return it.price != null ? `₪${it.price.toFixed(2)}` : '<span class="muted">צור קשר</span>';
}

function stepperHtml(it: CatalogItem): string {
  const p = escapeAttr(it.partname);
  return `
    <div class="cat-row-buy">
      <button class="step-down" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הפחת">−</button>
      <input type="number" min="0" step="1" value="${it.box_size}" class="qty" data-part="${p}" aria-label="כמות"/>
      <button class="step-up" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הוסף">+</button>
      <button class="add" data-part="${p}">הוסף</button>
    </div>`;
}

function gridCard(it: CatalogItem): string {
  return `
    <div class="card cat-card">
      <div class="cat-card-img">
        ${it.image_url ? `<img src="${escapeAttr(it.image_url)}" style="max-width:100%;max-height:100%"/>` : 'אין תמונה'}
        <button class="fav fav-over ${favSet.has(it.partname) ? 'on' : ''}" data-part="${escapeAttr(it.partname)}" type="button" aria-label="מועדף">${favSet.has(it.partname) ? '♥' : '♡'}</button>
      </div>
      <a class="cat-card-name" href="#product/${encodeURIComponent(it.partname)}">${escapeHtml(it.partdes || it.partname)}</a>
      <div class="muted" style="font-size:0.8rem">${escapeHtml(it.partname)} · ארגז ${it.box_size}</div>
      <div class="cat-card-price">${priceHtml(it)}<span class="muted"> ליח׳</span></div>
      ${stepperHtml(it)}
    </div>`;
}

// Roomy two-row mobile list row: [thumb · name/SKU · ♥] then [price ... stepper + add].
function listRow(it: CatalogItem): string {
  return `
    <div class="card cat-row">
      <div class="cat-row-top">
        <a class="cat-thumb" href="#product/${encodeURIComponent(it.partname)}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt=""/>` : '<span>—</span>'}</a>
        <a class="cat-row-name" href="#product/${encodeURIComponent(it.partname)}">
          <div class="nm">${escapeHtml(it.partdes || it.partname)}</div>
          <div class="sku">${escapeHtml(it.partname)} · ארגז ${it.box_size}</div>
        </a>
        <button class="fav ${favSet.has(it.partname) ? 'on' : ''}" data-part="${escapeAttr(it.partname)}" type="button" aria-label="מועדף">${favSet.has(it.partname) ? '♥' : '♡'}</button>
      </div>
      <div class="cat-row-bottom">
        <div class="cat-row-price">${priceHtml(it)}<span class="muted"> ליח׳</span></div>
        ${stepperHtml(it)}
      </div>
    </div>`;
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}
