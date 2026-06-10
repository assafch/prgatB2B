// Shared mobile-first UI helpers for the customer app. Vanilla DOM, no framework.
import { escapeHtml, escapeAttr } from './format.js';

export interface NavState {
  active: string; // route key: 'home' | 'catalog' | 'cart' | 'orders' | 'account'
  cartCount: number;
}

// Thumb-reach bottom navigation for store owners on phones. Five targets, each
// ≥56px tall, cart badge, honors the iOS home-indicator safe area.
export function bottomNav({ active, cartCount }: NavState): string {
  const tab = (key: string, href: string, label: string, icon: string, badge = 0) => `
    <a href="${href}" class="bn-tab${active === key ? ' active' : ''}" aria-label="${escapeHtml(label)}">
      <span class="bn-icon">${icon}${badge > 0 ? `<span class="bn-badge">${badge > 99 ? '99+' : badge}</span>` : ''}</span>
      <span class="bn-label">${escapeHtml(label)}</span>
    </a>`;
  return `
    <nav class="bottom-nav" role="navigation" aria-label="ניווט ראשי">
      ${tab('home', '#home', 'בית', '🏠')}
      ${tab('catalog', '#catalog', 'קטלוג', '🔍')}
      ${tab('cart', '#cart', 'סל', '🛒', cartCount)}
      ${tab('orders', '#orders', 'הזמנות', '📦')}
      ${tab('account', '#account', 'חשבון', '👤')}
    </nav>`;
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.className = `app-toast ${kind} show`;
  el.textContent = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el!.className = 'app-toast';
  }, 3200);
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
