import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { toast, openSheet, closeSheet, buzz, oosBadge, OOS_LABEL } from '../ui.js';
import { refreshCartCount, state as app } from '../main.js';
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
  outOfStock?: boolean; // "אזל מהמלאי" — grayed, cannot be added
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
// A2: a real swipe must not also register as a tap (which would open the keypad).
let suppressClick = false;
// A2: boxes added per part via swipe this session — drives the "✓ N ארגזים" label.
const swipeBoxes = new Map<string, number>();

// Browse (no text query) → group products under collapsible family bars. A text
// search → flat, relevance-ranked results (best matches first, no headers).
function isGrouped(): boolean {
  return !state.q;
}

export async function renderCatalog(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="card cat-filters">
      <div class="cat-search-wrap">
        <input id="q" class="cat-search" placeholder="חיפוש מוצר / מק״ט / ברקוד" />
        <a href="#scan" class="cat-scan-in" title="סריקת ברקוד" aria-label="סריקת ברקוד">📷</a>
        <span class="cat-search-ico" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4.5 4.5"/></svg></span>
      </div>
      <div class="cat-filters-row">
        <select id="family"><option value="">כל המשפחות</option></select>
        <a href="#favorites" class="fav-link" title="המועדפים שלי" aria-label="מועדפים">❤️</a>
        <div class="view-toggle" role="group" aria-label="תצוגה">
          <button id="view-grid" title="תצוגת רשת" aria-label="רשת">▦</button>
          <button id="view-list" title="תצוגת רשימה" aria-label="רשימה">☰</button>
        </div>
        <button id="btn-search" class="cat-search-btn">חפש</button>
      </div>
    </div>
    <div id="catalog-grid"></div>
    <div id="cat-sentinel" style="height:1px"></div>
    <div id="cat-status" class="muted" style="text-align:center;margin:1rem 0"></div>
    <a href="#cart" class="cart-fab" aria-label="עגלת קניות">🛒</a>
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
  (shell.querySelector('#btn-search') as HTMLButtonElement).addEventListener('click', doSearch);

  bindDelegation(shell);
  bindSwipe(shell);
  setupObserver(shell);
  syncCartFab(shell);
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
        syncCartFab(shell);
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
      return;
    }

    // A1: a plain tap on the card chrome (not a link/button/input/stepper) opens
    // the quantity keypad. Power users can opt out via localStorage('add_mode').
    if (suppressClick) return; // a swipe just happened — don't treat it as a tap
    if (localStorage.getItem('add_mode') === 'stepper') return;
    if (t.closest('a, button, input, .stepper, .cat-stepper')) return;
    const card = t.closest('.cat-card, .cat-row') as HTMLElement | null;
    if (!card?.dataset.part) return;
    if (card.dataset.oos === '1') { toast(OOS_LABEL, 'info'); return; } // out of stock — no keypad
    openQtyKeypad(card, shell);
  });
}

// A1 — Quantity keypad sheet. Pure front-end on top of the existing add flow:
// PUT /api/cart/lines/:part {quantity, mode:'add'} → refreshCartCount → showUpsell.
function openQtyKeypad(card: HTMLElement, shell: HTMLElement): void {
  const part = card.dataset.part!;
  const box = Math.max(1, Number(card.dataset.box) || 1);
  const price = card.dataset.price ? Number(card.dataset.price) : null;
  const name = card.dataset.name || part;
  let qty = box; // start at one box — the common wholesale unit

  const body = document.createElement('div');
  body.innerHTML = `
    <div class="qsheet-head">
      <div class="qsheet-name">${escapeHtml(name)}</div>
      <div class="qsheet-box">${box > 1 ? `ארגז = ${box} יח׳` : 'ליחידה'}</div>
    </div>
    <div class="qsheet-row">
      <button class="qsheet-step minus" type="button" aria-label="הפחת">−</button>
      <div class="qsheet-qtywrap">
        <div class="qsheet-qty" data-qty>0</div>
        <div class="qsheet-sub" data-sub></div>
      </div>
      <button class="qsheet-step plus" type="button" aria-label="הוסף">+</button>
    </div>
    <div class="qsheet-chips">
      <button class="qsheet-chip" type="button" data-add="1">+1</button>
      <button class="qsheet-chip" type="button" data-add="5">+5</button>
      <button class="qsheet-chip" type="button" data-add="10">+10</button>
      ${box > 1 ? '<button class="qsheet-chip box" type="button" data-box-snap>×ארגז</button>' : ''}
    </div>
    <button class="qsheet-cta" type="button" data-confirm>הוסף לעגלה</button>`;

  const qtyEl = body.querySelector('[data-qty]') as HTMLElement;
  const subEl = body.querySelector('[data-sub]') as HTMLElement;
  const cta = body.querySelector('[data-confirm]') as HTMLButtonElement;
  const render = () => {
    qtyEl.textContent = String(qty);
    const boxes = qty / box;
    subEl.textContent =
      box > 1 && Number.isInteger(boxes)
        ? `${qty} יח׳ · ${boxes} ${boxes === 1 ? 'ארגז' : 'ארגזים'}`
        : `${qty} יח׳`;
    cta.textContent = price != null ? `הוסף לעגלה · ₪${(qty * price).toFixed(2)}` : 'הוסף לעגלה';
  };
  render();

  body.querySelector('.minus')!.addEventListener('click', () => {
    qty = Math.max(1, qty - box);
    render();
  });
  body.querySelector('.plus')!.addEventListener('click', () => {
    qty += box;
    render();
  });
  body.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) => {
    b.addEventListener('click', () => {
      qty += Number(b.dataset.add) || 1;
      render();
    });
  });
  body.querySelector('[data-box-snap]')?.addEventListener('click', () => {
    const r = qty % box;
    qty = r === 0 ? qty + box : qty + (box - r); // round up to the next whole box
    render();
  });

  cta.addEventListener('click', async () => {
    if (cta.disabled) return;
    cta.disabled = true;
    try {
      await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: qty, mode: 'add' });
      buzz();
      await refreshCartCount();
      syncCartFab(shell);
      closeSheet();
      void showUpsell(part);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : String(ex), 'error');
      cta.disabled = false;
    }
  });

  openSheet(body, { label: 'בחירת כמות' });
}

// A2 — Swipe a list row leftward (RTL) to add one box. Axis-locked on the first
// 10px so it never fights vertical scroll. The inline stepper stays for exact qty.
function bindSwipe(shell: HTMLElement): void {
  const grid = shell.querySelector('#catalog-grid') as HTMLElement;
  let active: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let axis: '' | 'x' | 'y' = '';
  let pid = -1;
  const THRESH = -80; // leftward px past which the box is added

  const endSwipe = (commit: boolean) => {
    if (!active) return;
    const card = active;
    active = null;
    axis = '';
    card.classList.remove('swiping');
    card.classList.add('snapping');
    card.style.transform = '';
    if (commit) void addBoxFromSwipe(card, shell);
    setTimeout(() => card.classList.remove('snapping'), 240);
  };

  grid.addEventListener('pointerdown', (e) => {
    const card = (e.target as HTMLElement).closest('.swipe-card') as HTMLElement | null;
    if (!card) return;
    if ((e.target as HTMLElement).closest('a, button, input')) return; // let controls work
    active = card;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    axis = '';
    pid = e.pointerId;
    card.classList.remove('snapping');
  });

  grid.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== pid) return;
    const mx = e.clientX - startX;
    const my = e.clientY - startY;
    if (!axis) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      axis = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
      if (axis === 'x') {
        active.classList.add('swiping');
        try {
          active.setPointerCapture(pid);
        } catch {
          /* ignore */
        }
      } else {
        endSwipe(false); // vertical → release to native scroll
        return;
      }
    }
    if (axis !== 'x') return;
    e.preventDefault();
    dx = Math.max(-160, Math.min(0, mx)); // RTL: only leftward reveals the green layer
    active.style.transform = `translateX(${dx}px)`;
  });

  grid.addEventListener('pointerup', (e) => {
    if (!active || e.pointerId !== pid) return;
    const commit = axis === 'x' && dx <= THRESH;
    if (axis === 'x') {
      suppressClick = true; // the trailing click after a swipe must not open the keypad
      setTimeout(() => {
        suppressClick = false;
      }, 350);
    }
    endSwipe(commit);
  });
  grid.addEventListener('pointercancel', () => endSwipe(false));
}

async function addBoxFromSwipe(card: HTMLElement, shell: HTMLElement): Promise<void> {
  if (card.dataset.oos === '1') { toast(OOS_LABEL, 'info'); return; } // out of stock — swipe is a no-op
  const part = card.dataset.part!;
  const box = Math.max(1, Number(card.dataset.box) || 1);
  try {
    await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: box, mode: 'add' });
    buzz();
    await refreshCartCount();
    syncCartFab(shell);
    const n = (swipeBoxes.get(part) || 0) + 1;
    swipeBoxes.set(part, n);
    card.classList.add('swipe-added');
    const sku = card.querySelector('.sku') as HTMLElement | null;
    if (sku) sku.textContent = `✓ ${n} ${n === 1 ? 'ארגז' : 'ארגזים'} בעגלה`;
  } catch (ex) {
    toast(ex instanceof Error ? ex.message : String(ex), 'error');
  }
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
  // Grouped → outer column of family sections (cards/rows live inside each group);
  // flat grid → 2-up grid container; flat list → column.
  grid.className = !isGrouped() && state.view === 'grid' ? 'cat-grid' : 'cat-list';
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
    if (isGrouped()) params.set('sort', 'family'); // contiguous families for grouping
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
    if (isGrouped()) appendGrouped(grid, items);
    else grid.insertAdjacentHTML('beforeend', items.map(state.view === 'grid' ? gridCard : listRow).join(''));
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

// Append items into family sections, continuing a family across pages. Groups are
// keyed on the family CODE (what the server sorts by) so continuity/counts are correct
// even if two codes share a description. Grid view = 2-up compact cards inside each
// group; list view = stacked rows. List browse opens collapsed (clean family directory),
// grid opens expanded (browse products) — a chosen family filter is always expanded.
function appendGrouped(grid: HTMLElement, items: CatalogItem[]): void {
  const isGridView = state.view === 'grid';
  const collapsed = state.view === 'list' && !state.family;
  for (const it of items) {
    const key = it.family || it.family_desc || 'ללא משפחה';
    const label = it.family_desc || it.family || 'ללא משפחה';
    if (key !== lastFam || !lastItemsEl) {
      const group = document.createElement('div');
      group.className = 'cat-fam-group' + (collapsed ? ' collapsed' : '');
      group.innerHTML = `
        <button type="button" class="cat-fam-head" aria-expanded="${!collapsed}">
          <span class="cat-fam-name">${escapeHtml(label)} <span class="cat-fam-count">(0)</span></span>
          <span class="cat-fam-chev">▾</span>
        </button>
        <div class="cat-fam-items${isGridView ? ' cat-fam-grid' : ''}"></div>`;
      grid.appendChild(group);
      lastFam = key;
      lastItemsEl = group.querySelector('.cat-fam-items') as HTMLElement;
    }
    lastItemsEl.insertAdjacentHTML('beforeend', isGridView ? gridCard(it) : listRow(it));
    const countEl = lastItemsEl.parentElement!.querySelector('.cat-fam-count') as HTMLElement;
    countEl.textContent = `(${lastItemsEl.children.length})`;
  }
}

function priceHtml(it: CatalogItem): string {
  return it.price != null ? `₪${it.price.toFixed(2)}` : '<span class="muted">צור קשר</span>';
}

function stepperHtml(it: CatalogItem): string {
  const p = escapeAttr(it.partname);
  const d = it.outOfStock ? ' disabled' : '';
  return `
    <div class="cat-row-buy">
      <button class="step-down" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הפחת"${d}>−</button>
      <input type="number" min="0" step="1" value="${it.box_size}" class="qty" data-part="${p}" aria-label="כמות"${d}/>
      <button class="step-up" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הוסף"${d}>+</button>
      <button class="add" data-part="${p}"${d}>הוסף</button>
    </div>`;
}

// Compact grouped-grid card: name + SKU (right), small thumbnail (left), price,
// then [הוסף] + [− qty +] stepper.
function gridCard(it: CatalogItem): string {
  const p = escapeAttr(it.partname);
  const enc = encodeURIComponent(it.partname);
  const oos = !!it.outOfStock;
  const d = oos ? ' disabled' : '';
  return `
    <div class="card cat-card${oos ? ' is-oos' : ''}" data-part="${p}" data-box="${it.box_size}" data-price="${it.price ?? ''}" data-name="${escapeAttr(it.partdes || it.partname)}" data-oos="${oos ? '1' : ''}">
      <button class="fav fav-card ${favSet.has(it.partname) ? 'on' : ''}" data-part="${p}" type="button" aria-label="מועדף">${favSet.has(it.partname) ? '♥' : '♡'}</button>
      <div class="cat-card-top">
        <a class="cat-card-info" href="#product/${enc}">
          <div class="nm">${escapeHtml(it.partdes || it.partname)}</div>
          <div class="sku">מק"ט: ${escapeHtml(it.partname)} · ארגז ${it.box_size}</div>
        </a>
        <a class="cat-card-thumb" href="#product/${enc}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt=""/>` : '<span>—</span>'}</a>
      </div>
      <div class="cat-card-price">${priceHtml(it)}<span class="muted"> ליח׳</span>${oos ? ' ' + oosBadge() : ''}</div>
      <div class="cat-card-buy">
        <div class="cat-stepper">
          <button class="step-down" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הפחת"${d}>−</button>
          <input type="number" min="0" step="1" value="${it.box_size}" class="qty" data-part="${p}" aria-label="כמות"${d}/>
          <button class="step-up" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הוסף"${d}>+</button>
        </div>
        <button class="add" data-part="${p}"${d}>הוסף</button>
      </div>
    </div>`;
}

// Roomy two-row mobile list row: [thumb · name/SKU · ♥] then [price ... stepper + add].
function listRow(it: CatalogItem): string {
  const p = escapeAttr(it.partname);
  const oos = !!it.outOfStock;
  return `
    <div class="swipe-wrap">
      <div class="swipe-bg" aria-hidden="true">＋ ארגז</div>
      <div class="card cat-row swipe-card${oos ? ' is-oos' : ''}" data-part="${p}" data-box="${it.box_size}" data-price="${it.price ?? ''}" data-name="${escapeAttr(it.partdes || it.partname)}" data-oos="${oos ? '1' : ''}">
      <div class="cat-row-top">
        <a class="cat-thumb" href="#product/${encodeURIComponent(it.partname)}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt=""/>` : '<span>—</span>'}</a>
        <a class="cat-row-name" href="#product/${encodeURIComponent(it.partname)}">
          <div class="nm">${escapeHtml(it.partdes || it.partname)}</div>
          <div class="sku">${escapeHtml(it.partname)} · ארגז ${it.box_size}</div>
        </a>
        <button class="fav ${favSet.has(it.partname) ? 'on' : ''}" data-part="${escapeAttr(it.partname)}" type="button" aria-label="מועדף">${favSet.has(it.partname) ? '♥' : '♡'}</button>
      </div>
      <div class="cat-row-bottom">
        <div class="cat-row-price">${priceHtml(it)}<span class="muted"> ליח׳</span>${oos ? ' ' + oosBadge() : ''}</div>
        ${stepperHtml(it)}
      </div>
      </div>
    </div>`;
}

function cssEscape(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}

// Floating cart button badge — mirrors the bottom-nav cart count.
function syncCartFab(shell: HTMLElement): void {
  const fab = shell.querySelector('.cart-fab') as HTMLElement | null;
  if (!fab) return;
  let badge = fab.querySelector('.cart-fab-badge') as HTMLElement | null;
  if (app.cartCount > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'cart-fab-badge';
      fab.appendChild(badge);
    }
    badge.textContent = app.cartCount > 99 ? '99+' : String(app.cartCount);
  } else {
    badge?.remove();
  }
}
