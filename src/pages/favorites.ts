import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { toast, emptyState, skeleton, oosBadge, priceBlock } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface Item {
  partname: string;
  partdes: string | null;
  price: number | null;
  list_price: number | null;
  image_url: string | null;
  box_size: number;
  outOfStock?: boolean;
}

function row(it: Item): string {
  const p = escapeAttr(it.partname);
  const oos = !!it.outOfStock;
  const d = oos ? ' disabled' : '';
  return `
    <div class="card cat-row${oos ? ' is-oos' : ''}" data-part="${p}">
      <div class="cat-row-top">
        <a class="cat-thumb" href="#product/${encodeURIComponent(it.partname)}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt=""/>` : '<span>—</span>'}</a>
        <a class="cat-row-name" href="#product/${encodeURIComponent(it.partname)}">
          <div class="nm">${escapeHtml(it.partdes || it.partname)}</div>
          <div class="sku">${escapeHtml(it.partname)} · ארגז ${it.box_size}</div>
        </a>
        <button class="fav on" data-part="${p}" type="button" aria-label="הסר ממועדפים">♥</button>
      </div>
      <div class="cat-row-bottom">
        <div class="cat-row-price">${priceBlock(it)}${oos ? ' ' + oosBadge() : ''}</div>
        <div class="cat-row-buy">
          <button class="step-down" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הפחת"${d}>−</button>
          <input type="number" min="0" step="1" value="${it.box_size}" class="qty" data-part="${p}" aria-label="כמות"${d}/>
          <button class="step-up" data-part="${p}" data-step="${it.box_size}" type="button" aria-label="הוסף"${d}>+</button>
          <button class="add" data-part="${p}"${d}>הוסף</button>
        </div>
      </div>
    </div>`;
}

export async function renderFavorites(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(3)}</div>`;
  let items: Item[] = [];
  try {
    items = (await api.get<{ items: Item[] }>('/api/favorites/products')).items;
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }
  if (!items.length) {
    shell.innerHTML = `<div class="card">${emptyState('❤️', 'אין מועדפים עדיין', 'סמנו מוצרים בלב ❤ מהקטלוג', '#catalog', 'לקטלוג')}</div>`;
    return;
  }
  shell.innerHTML = `
    <div class="sec-head"><h1 style="margin:0;font-size:1.3rem">המועדפים שלי</h1></div>
    <div class="cat-list">${items.map(row).join('')}</div>`;

  const esc = (s: string) => s.replace(/(["\\])/g, '\\$1');
  const qtyOf = (part: string) => shell.querySelector<HTMLInputElement>(`input.qty[data-part="${esc(part)}"]`);

  shell.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const up = t.closest('button.step-up') as HTMLButtonElement | null;
    const down = t.closest('button.step-down') as HTMLButtonElement | null;
    if (up || down) {
      const b = (up || down)!;
      const input = qtyOf(b.dataset.part!);
      if (input) {
        const step = Number(b.dataset.step) || 1;
        input.value = String(Math.max(0, (Number(input.value) || 0) + (up ? step : -step)));
      }
      return;
    }
    const add = t.closest('button.add') as HTMLButtonElement | null;
    if (add) {
      const input = qtyOf(add.dataset.part!);
      const qty = Number(input?.value);
      if (!input || !isFinite(qty) || qty <= 0) {
        input?.focus();
        return;
      }
      add.disabled = true;
      try {
        await api.put(`/api/cart/lines/${encodeURIComponent(add.dataset.part!)}`, { quantity: qty, mode: 'add' });
        await refreshCartCount();
        add.textContent = '✓ נוסף';
        setTimeout(() => {
          add.textContent = 'הוסף';
          add.disabled = false;
        }, 1200);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
        add.disabled = false;
      }
      return;
    }
    const fav = t.closest('button.fav') as HTMLButtonElement | null;
    if (fav) {
      e.preventDefault();
      try {
        await api.post('/api/favorites', { partname: fav.dataset.part });
        fav.closest('.cat-row')?.remove();
        if (!shell.querySelector('.cat-row')) renderFavorites(shell);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      }
    }
  });
}
