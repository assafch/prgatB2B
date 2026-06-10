import { api } from '../api.js';
import { formatMoney, escapeHtml, escapeAttr } from '../format.js';
import { toast, confirmDialog, qtyStepper, bindSteppers, emptyState } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface CartLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number | null;
  line_total: number;
  available: boolean;
}
interface CartResp {
  lines: CartLine[];
  total: number;
}

export async function renderCart(shell: HTMLElement): Promise<void> {
  await load(shell);
}

async function load(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card muted">טוען…</div>`;
  let cart: CartResp;
  try {
    cart = await api.get<CartResp>('/api/cart');
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }

  if (cart.lines.length === 0) {
    shell.innerHTML = `<div class="card">${emptyState('🛒', 'הסל ריק', 'התחילו הזמנה חדשה מהקטלוג', '#catalog', 'לקטלוג')}</div>`;
    return;
  }

  const hasUnavailable = cart.lines.some((l) => !l.available);

  shell.innerHTML = `
    <div class="card">
      <h1 style="margin-top:0">הסל שלי</h1>
      <div id="cart-lines">
        ${cart.lines.map(lineRow).join('')}
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;padding-top:0.75rem;border-top:2px solid var(--border)">
        <span style="font-weight:700">סה״כ</span>
        <span style="font-weight:900;font-size:1.3rem;color:var(--brand)">${formatMoney(cart.total)}</span>
      </div>
      <div class="muted" style="font-size:0.8rem;margin-top:0.25rem">המחיר הסופי ייקבע ב-Priority לפי ההסכם שלך</div>
    </div>
    <div style="display:flex;gap:0.5rem;margin-top:1rem">
      <button class="ghost" id="clear">רוקן סל</button>
      <button id="checkout" style="flex:1" ${hasUnavailable ? 'disabled' : ''}>המשך לסיום הזמנה ←</button>
    </div>
    ${hasUnavailable ? `<div class="error" style="text-align:center;margin-top:0.5rem;font-size:0.9rem">יש להסיר פריטים שאינם זמינים כדי להמשיך</div>` : ''}
  `;

  bindSteppers(shell, async (part, qty) => {
    try {
      await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: qty });
      await refreshCartCount();
      await load(shell);
    } catch (ex) {
      const reason = ex instanceof Error ? ex.message : String(ex);
      await load(shell);
      toast(reason, 'error');
    }
  });

  shell.querySelectorAll<HTMLButtonElement>('button.remove').forEach((b) => {
    b.addEventListener('click', async () => {
      await api.put(`/api/cart/lines/${encodeURIComponent(b.dataset.part!)}`, { quantity: 0 });
      await refreshCartCount();
      await load(shell);
    });
  });

  shell.querySelector('#clear')?.addEventListener('click', async () => {
    if (!(await confirmDialog('לרוקן את כל הסל?', 'רוקן', 'ביטול'))) return;
    await api.del('/api/cart');
    await refreshCartCount();
    await load(shell);
  });

  shell.querySelector('#checkout')?.addEventListener('click', () => {
    location.hash = '#checkout';
  });
}

function lineRow(l: CartLine): string {
  return `
    <div class="dash-row" style="padding:0.6rem 0;border-bottom:1px solid var(--border)${l.available ? '' : ';opacity:0.6'}">
      <div class="grow">
        <div style="font-weight:600">${escapeHtml(l.partdes || l.partname)}</div>
        <div class="muted" style="font-size:0.82rem">${escapeHtml(l.partname)}${
    l.price != null ? ` · ${formatMoney(l.price)} ליח׳` : ''
  }</div>
        ${l.available ? '' : '<div class="error" style="font-size:0.8rem">לא זמין יותר — יש להסיר</div>'}
      </div>
      ${l.available ? qtyStepper(l.partname, l.quantity, 1) : ''}
      <div style="min-width:72px;text-align:left;font-weight:700">${l.price != null ? formatMoney(l.line_total) : '—'}</div>
      <button class="ghost remove" data-part="${escapeAttr(l.partname)}" aria-label="הסר" style="padding:0.4rem 0.6rem">🗑</button>
    </div>`;
}
