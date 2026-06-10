import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface Product {
  partname: string;
  partdes: string | null;
  family: string | null;
  family_desc: string | null;
  barcode: string | null;
  price: number | null;
  list_price: number | null;
  image_url: string | null;
  box_size: number;
}

export async function renderProduct(shell: HTMLElement, partname: string): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const p = await api.get<Product>(`/api/catalog/${encodeURIComponent(partname)}`);
    shell.innerHTML = `
      <div class="card" style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;align-items:start">
        <div style="aspect-ratio:1;background:#f3f4f6;border-radius:8px;display:grid;place-items:center;color:#9ca3af">
          ${p.image_url ? `<img src="${escapeAttr(p.image_url)}" style="max-width:100%;max-height:100%"/>` : 'אין תמונה'}
        </div>
        <div>
          <h1 style="margin:0 0 0.5rem 0">${escapeHtml(p.partdes || p.partname)}</h1>
          <div class="muted">מק״ט: ${escapeHtml(p.partname)}</div>
          ${p.barcode ? `<div class="muted">ברקוד: ${escapeHtml(p.barcode)}</div>` : ''}
          ${p.family ? `<div class="muted">משפחה: ${escapeHtml(p.family_desc || p.family)}</div>` : ''}
          <div style="margin:1rem 0;font-size:1.5rem;font-weight:700;color:var(--brand)">
            ${p.price != null ? `₪${p.price.toFixed(2)}` : 'צור קשר למחיר'}
          </div>
          <div class="muted" style="margin-bottom:0.5rem">ארגז: ${p.box_size} יחידות</div>
          <div style="display:flex;gap:0.5rem;align-items:stretch">
            <div style="display:flex;flex-direction:column;gap:1px">
              <button id="step-up" title="הוסף ${p.box_size}" style="padding:0 0.55rem;height:1.2rem;line-height:1;font-size:0.75rem">▲</button>
              <button id="step-down" title="הפחת ${p.box_size}" style="padding:0 0.55rem;height:1.2rem;line-height:1;font-size:0.75rem">▼</button>
            </div>
            <input type="number" id="qty" min="0" step="1" value="${p.box_size}" style="width:80px;text-align:center"/>
            <button id="add">הוסף לסל</button>
          </div>
          <div id="msg" style="margin-top:0.5rem"></div>
          <p style="margin-top:1.5rem"><a href="#catalog">← חזרה לקטלוג</a></p>
        </div>
      </div>
    `;
    const qty = shell.querySelector('#qty') as HTMLInputElement;
    const btn = shell.querySelector('#add') as HTMLButtonElement;
    const msg = shell.querySelector('#msg') as HTMLDivElement;
    const stepUp = shell.querySelector('#step-up') as HTMLButtonElement;
    const stepDown = shell.querySelector('#step-down') as HTMLButtonElement;
    const step = p.box_size || 1;
    stepUp.addEventListener('click', () => {
      qty.value = String(Math.max(0, (Number(qty.value) || 0) + step));
    });
    stepDown.addEventListener('click', () => {
      qty.value = String(Math.max(0, (Number(qty.value) || 0) - step));
    });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.put(`/api/cart/lines/${encodeURIComponent(p.partname)}`, {
          quantity: Number(qty.value),
          mode: 'add',
        });
        await refreshCartCount();
        msg.textContent = '✓ נוסף לסל';
        msg.className = 'ok';
        toast('נוסף לסל', 'ok');
      } catch (ex) {
        msg.textContent = ex instanceof Error ? ex.message : String(ex);
        msg.className = 'error';
      } finally {
        btn.disabled = false;
      }
    });
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}
