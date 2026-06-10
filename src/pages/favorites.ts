import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { toast, emptyState, skeleton } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface Item {
  partname: string;
  partdes: string | null;
  price: number | null;
  image_url: string | null;
  box_size: number;
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
    <div class="cat-list">
      ${items
        .map(
          (it) => `
        <div class="card cat-row" data-part="${escapeAttr(it.partname)}">
          <a class="cat-thumb" href="#product/${encodeURIComponent(it.partname)}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt=""/>` : '<span>—</span>'}</a>
          <div class="cat-row-main">
            <a href="#product/${encodeURIComponent(it.partname)}">${escapeHtml(it.partdes || it.partname)}</a>
            <div class="muted" style="font-size:0.76rem">${escapeHtml(it.partname)} · ארגז ${it.box_size}</div>
          </div>
          <div class="cat-row-price">${it.price != null ? `₪${it.price.toFixed(2)}` : '<span class="muted">צור קשר</span>'}<span class="muted">ליח׳</span></div>
          <button class="fav on" data-part="${escapeAttr(it.partname)}" type="button" aria-label="הסר ממועדפים">♥</button>
          <div class="cat-row-add">
            <input type="number" min="0" step="1" value="${it.box_size}" class="qty" data-part="${escapeAttr(it.partname)}"/>
            <button class="add" data-part="${escapeAttr(it.partname)}">הוסף</button>
          </div>
        </div>`
        )
        .join('')}
    </div>`;

  shell.querySelectorAll<HTMLButtonElement>('button.add').forEach((b) => {
    b.addEventListener('click', async () => {
      const part = b.dataset.part!;
      const input = shell.querySelector<HTMLInputElement>(`input.qty[data-part="${part.replace(/(["\\])/g, '\\$1')}"]`)!;
      const qty = Number(input.value);
      if (!isFinite(qty) || qty <= 0) return;
      b.disabled = true;
      try {
        await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: qty, mode: 'add' });
        await refreshCartCount();
        b.textContent = '✓ נוסף';
        setTimeout(() => {
          b.textContent = 'הוסף';
          b.disabled = false;
        }, 1200);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
        b.disabled = false;
      }
    });
  });
  shell.querySelectorAll<HTMLButtonElement>('button.fav').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api.post('/api/favorites', { partname: b.dataset.part });
        b.closest('.cat-row')?.remove();
        if (!shell.querySelector('.cat-row')) renderFavorites(shell);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      }
    });
  });
}
