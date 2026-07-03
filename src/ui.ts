// Shared mobile-first UI helpers for the customer app. Vanilla DOM, no framework.
import { escapeHtml, escapeAttr } from './format.js';

export interface NavState {
  active: string; // route key: 'home' | 'catalog' | 'cart' | 'orders' | 'account'
  cartCount: number;
}

// Thumb-reach bottom navigation for store owners on phones. Five targets, each
// ≥56px tall, cart badge, honors the iOS home-indicator safe area.
// Solid navy glyphs per the Stitch design (no emoji).
const NAV_ICONS: Record<string, string> = {
  // House with a door notched out of the bottom edge (Stitch glyph).
  home: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8 2.9 10h2.2v11h5v-5.2a1.9 1.9 0 0 1 3.8 0V21h5V10h2.2z"/></svg>`,
  catalog: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1.6"/><rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1.6"/><rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1.6"/><rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1.6"/></svg>`,
  // RTL cart: bold handle on the left, like the Stitch render.
  cart: `<svg viewBox="0 0 24 24" aria-hidden="true"><g transform="matrix(-1 0 0 1 24 0)"><path d="M2.2 3h2.6a1 1 0 0 1 1 .76L6.3 5.8h14.6l-2.1 8.9a2.2 2.2 0 0 1-2.15 1.7H9a2.2 2.2 0 0 1-2.15-1.74L4.6 5.4l-.5-1.4H2.2z"/><circle cx="9.6" cy="19.7" r="1.8"/><circle cx="16.4" cy="19.7" r="1.8"/></g></svg>`,
  // Receipt: zigzag bottom edge, two long lines + one short (Stitch glyph).
  orders: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.2h12A1.6 1.6 0 0 1 19.6 3.8v17.6l-2.17-1.6-2.17 1.6-2.16-1.6-2.16 1.6-2.17-1.6-2.17 1.6V3.8A1.6 1.6 0 0 1 6 2.2zm2.2 5h7.6v1.6H8.2zm0 3.4h7.6v1.6H8.2zm0 3.4h4.4v1.6H8.2z" fill-rule="evenodd"/></svg>`,
  account: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="4"/><path d="M4 20.5c0-3.6 3.7-6 8-6s8 2.4 8 6v.5H4z"/></svg>`,
};

export function bottomNav({ active, cartCount }: NavState): string {
  const tab = (key: string, href: string, label: string, badge = 0) => `
    <a href="${href}" class="bn-tab${active === key ? ' active' : ''}" aria-label="${escapeHtml(label)}">
      <span class="bn-icon">${NAV_ICONS[key]}${badge > 0 ? `<span class="bn-badge">${badge > 99 ? '99+' : badge}</span>` : ''}</span>
      <span class="bn-label">${escapeHtml(label)}</span>
    </a>`;
  return `
    <nav class="bottom-nav" role="navigation" aria-label="ניווט ראשי">
      ${tab('home', '#home', 'בית')}
      ${tab('catalog', '#catalog', 'קטלוג')}
      ${tab('cart', '#cart', 'עגלה', cartCount)}
      ${tab('orders', '#orders', 'הזמנות')}
      ${tab('account', '#account', 'חשבון')}
    </nav>`;
}

let toastTimer: number | undefined;
/**
 * `action` adds an inline button (e.g. cart swipe-delete's "בטל"/Undo) — the toast
 * then lingers longer (5s vs 3.2s) to give a real chance to tap it, and any tap
 * dismisses the toast immediately before running the callback.
 */
export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info', action?: { label: string; onClick: () => void }): void {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.className = `app-toast ${kind} show${action ? ' has-action' : ''}`;
  if (action) {
    el.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span><button type="button" class="toast-action">${escapeHtml(action.label)}</button>`;
    el.querySelector('.toast-action')!.addEventListener('click', () => {
      if (toastTimer) clearTimeout(toastTimer);
      el!.className = 'app-toast';
      action.onClick();
    });
  } else {
    el.textContent = message;
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el!.className = 'app-toast';
  }, action ? 5000 : 3200);
}

// Promise-based confirm (replaces native confirm() which is ugly on mobile).
export function confirmDialog(message: string, okLabel = 'אישור', cancelLabel = 'ביטול'): Promise<boolean> {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'sheet-backdrop show';
    back.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <p class="sheet-msg">${escapeHtml(message)}</p>
        <div class="sheet-actions">
          <button class="ghost" data-act="cancel">${escapeHtml(cancelLabel)}</button>
          <button data-act="ok">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;
    let done = false;
    const close = (val: boolean) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onNav);
      back.remove();
      resolve(val);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
    };
    // A route change must dismiss the dialog rather than orphan it on document.body.
    const onNav = () => close(false);
    back.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === back || t.dataset.act === 'cancel') close(false);
      if (t.dataset.act === 'ok') close(true);
    });
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onNav);
    document.body.appendChild(back);
  });
}

// ---- Bottom-sheet primitive (Phase 0) ----
// Generic version of confirmDialog: hosts arbitrary content in the existing
// `.sheet-backdrop`/`.sheet` chrome. A1's quantity keypad and other ad-hoc
// sheets sit in it. Dismisses on backdrop tap, Escape, or route change.
let currentSheet: { back: HTMLElement; onClose?: () => void } | null = null;

export function openSheet(content: HTMLElement | string, opts: { onClose?: () => void; label?: string } = {}): { close: () => void } {
  closeSheet(); // only one sheet at a time
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  if (opts.label) sheet.setAttribute('aria-label', opts.label);
  if (typeof content === 'string') sheet.innerHTML = content;
  else sheet.appendChild(content);
  back.appendChild(sheet);

  const close = () => closeSheet();
  back.addEventListener('click', (e) => {
    if (e.target === back) close();
  });
  document.addEventListener('keydown', onSheetKey);
  window.addEventListener('hashchange', close);
  document.body.appendChild(back);
  currentSheet = { back, onClose: opts.onClose };
  requestAnimationFrame(() => back.classList.add('show'));
  return { close };
}

export function closeSheet(): void {
  if (!currentSheet) return;
  const { back, onClose } = currentSheet;
  currentSheet = null;
  document.removeEventListener('keydown', onSheetKey);
  window.removeEventListener('hashchange', closeSheet);
  back.classList.remove('show');
  setTimeout(() => back.remove(), 200);
  onClose?.();
}

function onSheetKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeSheet();
}

// ---- Admin drawer — the "רשימה + מגירה" editing pattern (Stage 8b). ----
// Desktop: 380px side panel. Mobile: the same content inside the bottom sheet.
let activeDrawer: { close: () => void } | null = null;

export function openDrawer(
  content: HTMLElement,
  opts: { title: string; sub?: string; onClose?: () => void }
): { close: () => void } {
  activeDrawer?.close();

  const head = document.createElement('div');
  head.className = 'adm-drawer-head';
  /* sub is trusted HTML (callers embed links); title is escaped. */
  head.innerHTML = `<div><b>${escapeHtml(opts.title)}</b>${opts.sub ? `<small>${opts.sub}</small>` : ''}</div>
    <button type="button" class="adm-drawer-x" aria-label="סגירה">✕</button>`;

  if (!window.matchMedia('(min-width: 1024px)').matches) {
    const wrap = document.createElement('div');
    wrap.append(head, content);
    const handle = { close: () => { /* replaced below */ } };
    const sheet = openSheet(wrap, {
      label: opts.title,
      onClose: () => { if (activeDrawer === handle) activeDrawer = null; opts.onClose?.(); },
    });
    handle.close = () => { if (activeDrawer === handle) sheet.close(); };
    (head.querySelector('.adm-drawer-x') as HTMLButtonElement).onclick = () => sheet.close();
    activeDrawer = handle;
    return handle;
  }

  const backdrop = document.createElement('div');
  backdrop.className = 'adm-drawer-backdrop';
  const panel = document.createElement('aside');
  panel.className = 'adm-drawer';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', opts.title); // setAttribute takes the raw string as-is; no HTML entities to escape here
  panel.append(head, content);
  document.body.append(backdrop, panel);
  requestAnimationFrame(() => panel.classList.add('open')); // slide — the one allowed animation

  const close = (): void => {
    if (activeDrawer?.close !== close) return; // already superseded
    activeDrawer = null;
    panel.classList.remove('open');
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    setTimeout(() => { panel.remove(); backdrop.remove(); }, 200);
    opts.onClose?.();
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  backdrop.addEventListener('click', close);
  (head.querySelector('.adm-drawer-x') as HTMLButtonElement).onclick = close;
  window.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  activeDrawer = { close };
  return activeDrawer;
}

// Tiny haptic tick so one-hand add/pay actions feel real. No-op where unsupported.
export function buzz(ms = 10): void {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* unsupported */
  }
}

// ---- Discount pricing (Discount Pricing board, section A) ----
// Shared everywhere a per-unit price is shown: catalog grid/list, product page,
// favorites, similar-products rail, upsell sheet, qty-keypad header. Server sends
// `price` (net, after the customer's flat discount) and `list_price` (base) on
// every catalog/product item; a discount is only "real" when list_price − price
// exceeds half an agora (protects against float noise showing a phantom ₪0.00 line).
export interface PriceFields {
  price: number | null;
  list_price: number | null;
}

export function hasRealDiscount(it: PriceFields): boolean {
  return it.price != null && it.list_price != null && it.list_price - it.price > 0.005;
}

/**
 * Two-storey discount price block: a small struck list price sits above the bold
 * net price + muted "ליח׳" (the board's recommended V2 layout — fixed ~90px width,
 * survives 4-digit prices next to the catalog stepper at 360px).
 * - `variant: 'stack'` (default): compact grid/list form, storeys stacked.
 * - `variant: 'inline'`: storeys side by side — roomier surfaces (product page,
 *   qty-keypad header).
 * - `size: 'sm' | 'lg'`: shrink for rails/upsell chips, or grow for the product page.
 * - `reserveTop`: keep an invisible placeholder top storey even without a discount,
 *   so grid cards with mixed discounted/non-discounted items stay the same height.
 */
export function priceBlock(
  it: PriceFields,
  opts: { variant?: 'stack' | 'inline'; size?: 'sm' | 'lg'; reserveTop?: boolean } = {}
): string {
  if (it.price == null) return '<span class="muted">צור קשר</span>';
  const discounted = hasRealDiscount(it);
  const cls = ['price-block', `price-block-${opts.variant || 'stack'}`];
  if (opts.size) cls.push(`price-block-${opts.size}`);
  const top = discounted
    ? `<s class="price-was">₪${it.list_price!.toFixed(2)}</s>`
    : opts.reserveTop
      ? `<s class="price-was price-ph" aria-hidden="true">₪0.00</s>`
      : '';
  return `<span class="${cls.join(' ')}">${top}<span class="price-net">₪${it.price.toFixed(2)}<span class="price-unit"> ליח׳</span></span></span>`;
}

/** Red "−N%" discount chip (product page + qty-keypad header, per the board — not
 *  the compact catalog/rail surfaces). Empty string when there's no real discount. */
export function discountChip(it: PriceFields): string {
  if (!hasRealDiscount(it)) return '';
  const pct = Math.round((1 - it.price! / it.list_price!) * 100);
  return `<span class="discount-chip" dir="ltr">−${pct}%</span>`;
}

// ---- Out-of-stock (אזל מהמלאי) — shared label + badge so every surface matches ----
export const OOS_LABEL = 'אזל מהמלאי';
export function oosBadge(): string {
  return `<span class="oos-badge">${OOS_LABEL}</span>`;
}

// A 44×44px quantity stepper. `part` is escaped for the data-attribute.
export function qtyStepper(part: string, value: number, step: number): string {
  const p = escapeHtml(part);
  return `
    <div class="stepper" data-part="${p}" data-step="${step}">
      <button class="st-minus" aria-label="הפחתה" type="button">−</button>
      <input class="st-qty" type="number" inputmode="numeric" min="0" step="1" value="${value}" data-part="${p}" aria-label="כמות"/>
      <button class="st-plus" aria-label="הוספה" type="button">+</button>
    </div>`;
}

// Wire a stepper's +/- buttons. onChange receives the new value (does not fire on
// every keystroke — only on the buttons and on input 'change').
export function bindSteppers(root: ParentNode, onChange?: (part: string, qty: number) => void): void {
  root.querySelectorAll<HTMLDivElement>('.stepper').forEach((s) => {
    const step = Number(s.dataset.step) || 1;
    const input = s.querySelector<HTMLInputElement>('.st-qty')!;
    const fire = () => onChange?.(s.dataset.part!, Number(input.value) || 0);
    s.querySelector('.st-plus')!.addEventListener('click', () => {
      input.value = String(Math.max(0, (Number(input.value) || 0) + step));
      fire();
    });
    s.querySelector('.st-minus')!.addEventListener('click', () => {
      input.value = String(Math.max(0, (Number(input.value) || 0) - step));
      fire();
    });
    input.addEventListener('change', () => {
      if (!isFinite(Number(input.value)) || Number(input.value) < 0) input.value = '0';
      fire();
    });
  });
}

export function statusChip(statusDes: string | null, fallbackKey?: string): string {
  const s = (statusDes || '').trim();
  // Map common Hebrew Priority statuses to a tone.
  let tone = 'info';
  if (/בוצע|הושלם|נשלח|סופק/.test(s)) tone = 'ok';
  else if (/בוטל|נדחה|נכשל/.test(s)) tone = 'error';
  else if (/ממתין|טיוטא|חדש|בשליח/.test(s)) tone = 'warn';
  const label = s || fallbackKey || '—';
  return `<span class="chip ${tone}">${escapeHtml(label)}</span>`;
}

export function skeleton(lines = 3): string {
  return `<div class="skeleton">${Array.from({ length: lines }, () => '<div class="sk-line"></div>').join('')}</div>`;
}

export function emptyState(icon: string, title: string, sub?: string, ctaHref?: string, ctaLabel?: string): string {
  // icon/href are developer literals today, but escape them so a future caller
  // passing catalog/customer data can't turn this into an XSS sink.
  const safeHref = ctaHref && /^[#/]/.test(ctaHref) ? ctaHref : '#'; // only same-app links
  return `
    <div class="empty-state">
      <div class="es-icon">${escapeHtml(icon)}</div>
      <div class="es-title">${escapeHtml(title)}</div>
      ${sub ? `<div class="es-sub">${escapeHtml(sub)}</div>` : ''}
      ${ctaHref && ctaLabel ? `<a href="${escapeAttr(safeHref)}" class="es-cta">${escapeHtml(ctaLabel)}</a>` : ''}
    </div>`;
}

export function errorState(message: string, retry?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="es-icon">⚠️</div>
    <div class="es-title">משהו השתבש</div>
    <div class="es-sub">${escapeHtml(message)}</div>
    ${retry ? '<button class="es-cta" data-retry>נסה שוב</button>' : ''}`;
  if (retry) el.querySelector('[data-retry]')?.addEventListener('click', retry);
  return el;
}
