import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface Sug {
  partname: string;
  partdes: string | null;
  price: number | null;
  image_url: string | null;
  box_size: number;
  outOfStock?: boolean;
}

/**
 * Post-add upsell: after a product is added to the cart, offer same-family
 * suggestions in a dismissible bottom sheet. No suggestions → a plain toast.
 */
export async function showUpsell(partname: string): Promise<void> {
  let items: Sug[] = [];
  try {
    items = (await api.get<{ items: Sug[] }>(`/api/catalog/${encodeURIComponent(partname)}/similar`)).items;
  } catch {
    /* ignore */
  }
  items = items.filter((i) => !i.outOfStock); // don't suggest things they can't order
  if (!items.length) {
    toast('נוסף לסל ✓', 'ok');
    return;
  }
  const top = items.slice(0, 4);
  const ov = document.createElement('div');
  ov.className = 'upsell-overlay';
  ov.innerHTML = `
    <div class="upsell-sheet" role="dialog" aria-label="הצעות נוספות">
      <div class="upsell-head">✓ נוסף לסל</div>
      <div class="upsell-sub">אולי יתאים גם להזמנה:</div>
      <div class="upsell-items">
        ${top
          .map(
            (it) => `
          <div class="upsell-item">
            <a class="thumb" href="#product/${encodeURIComponent(it.partname)}">${it.image_url ? `<img src="${escapeAttr(it.image_url)}" alt=""/>` : '—'}</a>
            <div class="nm">${escapeHtml(it.partdes || it.partname)}</div>
            <div class="pr">${it.price != null ? `₪${it.price.toFixed(2)}` : ''}</div>
            <button class="up-add" data-part="${escapeAttr(it.partname)}" data-box="${it.box_size}">+ הוסף</button>
          </div>`
          )
          .join('')}
      </div>
      <div class="upsell-actions">
        <button class="ghost" id="up-continue">המשך בקנייה</button>
        <button id="up-cart">מעבר לסל ←</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add('show'));
  const close = () => {
    ov.classList.remove('show');
    setTimeout(() => ov.remove(), 200);
  };
  ov.addEventListener('click', (e) => {
    if (e.target === ov) close();
  });
  (ov.querySelector('#up-continue') as HTMLButtonElement).onclick = close;
  (ov.querySelector('#up-cart') as HTMLButtonElement).onclick = () => {
    close();
    location.hash = '#cart';
  };
  ov.querySelectorAll<HTMLButtonElement>('.up-add').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api.put(`/api/cart/lines/${encodeURIComponent(b.dataset.part!)}`, { quantity: Number(b.dataset.box) || 1, mode: 'add' });
        await refreshCartCount();
        b.textContent = '✓ נוסף';
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
        b.disabled = false;
      }
    };
  });
  // close the sheet on product-link navigation
  ov.querySelectorAll('a').forEach((a) => a.addEventListener('click', close));
}
