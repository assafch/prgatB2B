import { api } from '../api.js';
import { formatMoney, escapeHtml, escapeAttr } from '../format.js';
import { toast, confirmDialog, qtyStepper, bindSteppers, emptyState, priceBlock, buzz, OOS_LABEL } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface CartLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number | null;
  list_price: number | null;
  line_total: number;
  available: boolean;
  outOfStock?: boolean;
}
interface Promotions {
  subtotal: number;
  discount: number;
  total: number;
  applied: { id: number; name: string; type: string; savings: number }[];
  gifts: { partname: string; partdes: string | null; qty: number; price: number }[];
  giftProgress: { name: string; min: number; remaining: number; giftDes: string | null } | null;
}
interface CartResp {
  lines: CartLine[];
  total: number;
  promotions?: Promotions;
  vatRate?: number;
  unifiedCheckout?: boolean;
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
  const totalItems = cart.lines.length;
  const totalUnits = cart.lines.reduce((s, l) => s + l.quantity, 0);

  // Customer-discount summary (מחירון struck total → הנחת לקוח −N%) — independent
  // of the promotions engine below (coupon/promo savings apply AFTER this discount,
  // in their own rows). Only shown when there's a real, priced list-vs-net gap.
  const listTotal = Math.round(cart.lines.reduce((s, l) => s + (l.list_price ?? l.price ?? 0) * l.quantity, 0) * 100) / 100;
  const custDiscountAmt = Math.round((listTotal - cart.total) * 100) / 100;
  const hasCustDiscount = custDiscountAmt > 0.005;
  const custDiscountPct = hasCustDiscount && listTotal > 0 ? Math.round((custDiscountAmt / listTotal) * 100) : 0;

  const promo = cart.promotions;
  const hasDiscount = !!promo && promo.discount > 0;
  const finalTotal = promo ? promo.total : cart.total;

  // Unified checkout: one honest number from here to the payment page. The VAT
  // formula mirrors server money.ts withVat exactly (round-half-up to 2dp).
  const unified = !!cart.unifiedCheckout && typeof cart.vatRate === 'number';
  const vatRate = cart.vatRate ?? 0;
  const payable = Math.round(finalTotal * (1 + vatRate) * 100) / 100;
  const vatAmount = Math.round((payable - finalTotal) * 100) / 100;
  const giftsHtml =
    promo && promo.gifts.length
      ? promo.gifts
          .map(
            (g) => `<div class="cart-gift">🎁 מתנה: ${escapeHtml(g.partdes || g.partname)} ×${g.qty} <span>חינם</span></div>`
          )
          .join('')
      : '';
  const promoLinesHtml = hasDiscount
    ? promo!.applied
        .filter((a) => a.savings > 0)
        .map((a) => `<div class="cart-promo-line"><span>🏷️ ${escapeHtml(a.name)}</span><span>−${formatMoney(a.savings)}</span></div>`)
        .join('')
    : '';
  const giftNudge =
    promo && promo.giftProgress
      ? `<div class="cart-gift-nudge">עוד ${formatMoney(promo.giftProgress.remaining)} ומקבלים מתנה: ${escapeHtml(promo.giftProgress.giftDes || '')} 🎁</div>`
      : '';

  shell.innerHTML = `
    <div class="cart-head">
      <span class="cart-head-title">הסל שלי</span>
      <span class="cart-head-sub">${totalItems} פריטים · ${totalUnits} יח׳</span>
      <button type="button" id="clear" class="cart-head-clear">רוקן סל</button>
    </div>
    <div id="cart-lines" class="cart-lines">
      ${cart.lines.map(lineRow).join('')}
    </div>
    ${giftsHtml}
    ${giftNudge}
    <div class="cart-tpl-row">
      <button type="button" id="save-tpl" class="cart-tpl-link">💾 שמור כתבנית</button>
      <span>·</span>
      <a href="#templates" class="cart-tpl-link">📋 התבניות שלי</a>
    </div>
    <div class="thumb-bar-spacer" id="cart-bar-spacer"></div>
    <div class="thumb-bar cart-summary-bar">
      ${hasCustDiscount ? `<div class="cart-summary-row"><span>סה״כ לפי מחירון</span><s class="price-was">${formatMoney(listTotal)}</s></div>` : ''}
      ${
        hasCustDiscount
          ? `<div class="cart-summary-row discount"><span>הנחת לקוח <span dir="ltr">−${custDiscountPct}%</span></span><span dir="ltr">−${formatMoney(custDiscountAmt)}</span></div>`
          : ''
      }
      ${hasCustDiscount ? `<div class="cart-savings-pill">💰 חסכת ${formatMoney(custDiscountAmt)} בהזמנה זו</div>` : ''}
      ${
        hasDiscount
          ? `<div class="cart-promo-line muted"><span>סכום ביניים</span><span>${formatMoney(cart.total)}</span></div>${promoLinesHtml}`
          : ''
      }
      ${
        unified
          ? `<div class="cart-summary-row"><span>סה״כ לפני מע״מ</span><span>${formatMoney(finalTotal)}</span></div>
             <div class="cart-summary-row"><span>מע״מ ${Math.round(vatRate * 100)}%</span><span>${formatMoney(vatAmount)}</span></div>
             <div class="cart-summary-total"><b>סה״כ לתשלום כולל מע״מ</b><b>${formatMoney(payable)}</b></div>`
          : `<div class="cart-summary-total"><b>סה״כ לתשלום</b><b>${formatMoney(finalTotal)}</b></div>`
      }
      <button id="checkout" class="cart-summary-cta" ${hasUnavailable ? 'disabled' : ''}>לסיום הזמנה · ${formatMoney(unified ? payable : finalTotal)} ←</button>
      ${
        hasUnavailable
          ? `<div class="cart-blocked-note">יש להסיר פריטים שאינם זמינים כדי להמשיך</div>`
          : `<div class="cart-certainty">✓ המחירים סופיים וכוללים את ההנחה שלך לפי ההסכם</div>`
      }
    </div>
  `;

  // Reserve exactly as much scroll-bottom padding as the sticky bar occupies, so
  // the last row is never hidden behind it (bar height varies with the discount
  // rows above, so this is measured, not guessed).
  const spacer = shell.querySelector<HTMLElement>('#cart-bar-spacer');
  const bar = shell.querySelector<HTMLElement>('.cart-summary-bar');
  if (spacer && bar) spacer.style.height = `${Math.ceil(bar.getBoundingClientRect().height) + 10}px`;

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

  bindSwipe(shell);

  // Non-gesture fallback for unavailable/OOS lines (which have no stepper): a
  // focusable button that removes just that line, so a blocked checkout can be
  // cleared without emptying the whole cart or relying on the swipe gesture.
  shell.querySelectorAll<HTMLButtonElement>('.cart-line-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const part = btn.dataset.remove!;
      const card = btn.closest<HTMLElement>('.cart-line');
      void deleteLineWithUndo(shell, part, card?.dataset.name || part, Number(card?.dataset.qty) || 0);
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

  shell.querySelector('#save-tpl')?.addEventListener('click', async () => {
    const name = window.prompt('שם התבנית:', 'הסדר הקבוע');
    if (!name) return;
    try {
      await api.post('/api/templates', { name });
      toast('התבנית נשמרה ✓', 'ok');
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : String(ex), 'error');
    }
  });
}

function lineRow(l: CartLine): string {
  const name = l.partdes || l.partname;
  const unavailable = !l.available;
  return `
    <div class="swipe-wrap cart-swipe-wrap">
      <div class="swipe-bg cart-swipe-bg" aria-hidden="true">🗑 מחק</div>
      <div class="cart-line swipe-card${unavailable ? ' cart-line-unavail' : ''}" data-part="${escapeAttr(l.partname)}" data-qty="${l.quantity}" data-name="${escapeAttr(name)}">
        <div class="cart-line-top">
          <div class="cart-line-thumb" aria-hidden="true"><span>—</span></div>
          <div class="cart-line-name">${escapeHtml(name)}</div>
          <div class="cart-line-price">${priceBlock(l, { variant: 'stack' })}</div>
        </div>
        <div class="cart-line-sku">${escapeHtml(l.partname)}</div>
        <div class="cart-line-bottom">
          ${
            l.available
              ? `<div class="cart-stepper-compact">${qtyStepper(l.partname, l.quantity, 1)}</div><span class="cart-line-units">${l.quantity} יח׳</span>
                 <span class="cart-line-sum"><span class="cart-line-sum-label">סה״כ</span><b>${l.price != null ? formatMoney(l.line_total) : '—'}</b></span>`
              : `<span class="cart-line-unavail-note">${l.outOfStock ? OOS_LABEL : 'לא זמין יותר'}</span>
                 <button type="button" class="cart-line-remove" data-remove="${escapeAttr(l.partname)}">הסר מהסל</button>`
          }
        </div>
      </div>
    </div>`;
}

// Swipe-to-delete — the same axis-lock mechanic as the catalog's swipe-to-add
// (A2, src/pages/catalog.ts): axis locks after the first 10px so a vertical
// scroll is never hijacked. Committing past the threshold removes the line
// immediately (no confirm dialog) and offers an Undo toast; the stepper's "−"
// down to 0 and "רוקן סל" remain as the non-gesture fallbacks. Unlike the
// catalog's add-swipe, this applies to unavailable/OOS lines too — removing
// them is exactly what those lines need.
function bindSwipe(shell: HTMLElement): void {
  const root = shell.querySelector('#cart-lines') as HTMLElement;
  if (!root) return;
  let active: HTMLElement | null = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let axis: '' | 'x' | 'y' = '';
  let pid = -1;
  const THRESH = -80; // leftward px past which the delete commits

  const endSwipe = (commit: boolean) => {
    if (!active) return;
    const card = active;
    active = null;
    axis = '';
    card.classList.remove('swiping');
    card.classList.add('snapping');
    card.style.transform = '';
    if (commit) {
      const part = card.dataset.part!;
      const name = card.dataset.name || part;
      const qty = Number(card.dataset.qty) || 0;
      void deleteLineWithUndo(shell, part, name, qty);
    }
    setTimeout(() => card.classList.remove('snapping'), 240);
  };

  root.addEventListener('pointerdown', (e) => {
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

  root.addEventListener('pointermove', (e) => {
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
    dx = Math.max(-160, Math.min(0, mx)); // RTL: only leftward reveals the delete layer
    active.style.transform = `translateX(${dx}px)`;
  });

  root.addEventListener('pointerup', (e) => {
    if (!active || e.pointerId !== pid) return;
    const commit = axis === 'x' && dx <= THRESH;
    endSwipe(commit);
  });
  root.addEventListener('pointercancel', () => endSwipe(false));
}

async function deleteLineWithUndo(shell: HTMLElement, part: string, name: string, prevQty: number): Promise<void> {
  try {
    await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: 0 });
    buzz();
    await refreshCartCount();
    await load(shell);
    toast(`${name} הוסר מהסל`, 'info', {
      label: 'בטל',
      onClick: () => {
        void (async () => {
          try {
            await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: prevQty });
            await refreshCartCount();
            await load(shell);
          } catch (ex) {
            toast(ex instanceof Error ? ex.message : String(ex), 'error');
          }
        })();
      },
    });
  } catch (ex) {
    toast(ex instanceof Error ? ex.message : String(ex), 'error');
    await load(shell);
  }
}
