// prgatB2B — hash router. Loads /api/auth/me at boot, dispatches to pages by route.

import { api, type MeUser } from './api.js';
import { registerPwa } from './pwa.js';
import { bottomNav } from './ui.js';
import { renderLogin } from './pages/login.js';
import { renderLead } from './pages/lead.js';
import { renderInvite } from './pages/invite.js';
import { renderHome } from './pages/home.js';
import { renderCatalog } from './pages/catalog.js';
import { renderProduct } from './pages/product.js';
import { renderCart } from './pages/cart.js';
import { renderCheckout } from './pages/checkout.js';
import { renderOrders } from './pages/orders.js';
import { renderOrderDetail } from './pages/orderDetail.js';
import { renderAccount } from './pages/account.js';
import { renderInvoices } from './pages/invoices.js';
import { renderInvoiceDetail } from './pages/invoiceDetail.js';
import { renderPayCheck } from './pages/payCheck.js';
import { renderPayments } from './pages/payments.js';
import { renderAssistant } from './pages/assistant.js';
import { renderAccessibility } from './pages/accessibility.js';
import { renderPayCard, renderPayCardReturn } from './pages/payCard.js';
import { renderTemplates } from './pages/templates.js';
import { renderFavorites } from './pages/favorites.js';
import { renderScan } from './pages/scan.js';
import { renderAdmin } from './pages/admin.js';
import { renderOrderPay } from './pages/orderPay.js';

const root = document.getElementById('app')!;

interface AppState {
  me: MeUser | null;
  cartCount: number;
}

export const state: AppState = { me: null, cartCount: 0 };

// Which bottom-nav tab a route belongs to.
function navKeyFor(hash: string): string {
  if (hash.startsWith('#home')) return 'home';
  if (hash.startsWith('#catalog') || hash.startsWith('#product/') || hash === '#favorites' || hash === '#scan') return 'catalog';
  if (hash.startsWith('#cart') || hash.startsWith('#checkout') || hash === '#templates') return 'cart';
  if (hash.startsWith('#orders') || hash.startsWith('#order-pay/')) return 'orders';
  if (hash.startsWith('#account') || hash.startsWith('#invoice') || hash.startsWith('#pay')) return 'account';
  return '';
}

function topbar(): string {
  const me = state.me;
  if (!me) {
    return `
      <div class="topbar">
        <div class="logo"><img class="logo-img" src="/icons/logo.svg" alt="אורגת B2B"/></div>
        <nav>
          <a href="#login" class="${location.hash === '#login' || !location.hash ? 'active' : ''}">התחברות</a>
          <a href="#lead" class="${location.hash === '#lead' ? 'active' : ''}">צור קשר</a>
          <a href="#accessibility" class="${location.hash === '#accessibility' ? 'active' : ''}">נגישות</a>
        </nav>
      </div>`;
  }
  if (me.role === 'admin') {
    return `
      <div class="topbar">
        <div class="logo"><img class="logo-img" src="/icons/logo.svg" alt="אורגת"/><span class="logo-sub">אדמין</span></div>
        <nav>
          <a href="#admin" class="${location.hash.startsWith('#admin') ? 'active' : ''}">לוח בקרה</a>
          <a href="#logout">יציאה</a>
        </nav>
      </div>`;
  }
  // Customer: slim topbar (logo + logout); primary nav is the bottom bar.
  return `
    <div class="topbar">
      <div class="logo">אורגת B2B</div>
      <nav>
        <a href="#logout">יציאה</a>
      </nav>
    </div>`;
}

// Mount page HTML. For logged-in customers also renders the bottom nav and pads
// the shell so content never hides behind it.
function mount(html: string): HTMLDivElement {
  const isCustomer = state.me?.role === 'customer';
  const navKey = navKeyFor(location.hash || '#home');
  root.innerHTML = `${topbar()}<div class="app-shell${isCustomer ? ' has-bottom-nav' : ''}"></div>${
    isCustomer ? bottomNav({ active: navKey, cartCount: state.cartCount }) : ''
  }${isCustomer && location.hash !== '#assistant' ? '<a href="#assistant" class="asst-fab" aria-label="שאל את אורגת">🤖</a>' : ''}`;
  const shell = root.querySelector('.app-shell') as HTMLDivElement;
  shell.innerHTML = html;
  return shell;
}

async function refreshMe(): Promise<void> {
  try {
    const { user } = await api.get<{ user: MeUser | null }>('/api/auth/me');
    state.me = user;
  } catch {
    state.me = null;
  }
}

// Keep the cart badge honest. Pages call this after mutating the cart.
export async function refreshCartCount(): Promise<void> {
  if (state.me?.role !== 'customer') {
    state.cartCount = 0;
    return;
  }
  try {
    const cart = await api.get<{ lines: unknown[] }>('/api/cart');
    state.cartCount = cart.lines.length;
  } catch {
    /* leave as-is */
  }
  // Update the badge in place without a full re-render.
  const badge = document.querySelector('.bn-tab[href="#cart"] .bn-badge');
  const icon = document.querySelector('.bn-tab[href="#cart"] .bn-icon');
  if (state.cartCount > 0) {
    const txt = state.cartCount > 99 ? '99+' : String(state.cartCount);
    if (badge) badge.textContent = txt;
    else if (icon) icon.insertAdjacentHTML('beforeend', `<span class="bn-badge">${txt}</span>`);
  } else if (badge) {
    badge.remove();
  }
}

async function route(): Promise<void> {
  // Auth is cached after boot; only (re)fetch when we don't know who the user is.
  if (state.me === null) await refreshMe();
  const hash = location.hash || (state.me ? '#home' : '#login');

  if (hash === '#logout') {
    await api.post('/api/auth/logout').catch(() => {});
    state.me = null;
    state.cartCount = 0;
    location.hash = '#login';
    return;
  }

  // Already-authenticated users have no business on the public auth screens —
  // send them to their home (prevents the "login form with customer chrome" state).
  if (state.me && (hash === '#login' || hash === '#lead' || hash.startsWith('#invite/'))) {
    location.hash = state.me.role === 'admin' ? '#admin' : '#home';
    return;
  }

  // Public routes
  if (hash === '#login') return renderLogin(mount(''), onAuthChanged);
  if (hash === '#lead') return renderLead(mount(''));
  if (hash === '#accessibility') return renderAccessibility(mount(''));
  if (hash.startsWith('#invite/')) {
    const token = hash.slice('#invite/'.length);
    return renderInvite(mount(''), token, onAuthChanged);
  }

  // Require auth
  if (!state.me) {
    location.hash = '#login';
    return;
  }

  if (state.me.role === 'admin') {
    if (!hash.startsWith('#admin')) {
      location.hash = '#admin';
      return;
    }
    return renderAdmin(mount(''), hash);
  }

  // Customer routes
  if (hash === '#home' || hash === '') return renderHome(mount(''));
  if (hash === '#catalog') return renderCatalog(mount(''));
  if (hash.startsWith('#product/')) {
    const part = decodeURIComponent(hash.slice('#product/'.length));
    return renderProduct(mount(''), part);
  }
  if (hash === '#cart') return renderCart(mount(''));
  if (hash === '#checkout') return renderCheckout(mount(''));
  if (hash === '#orders') return renderOrders(mount(''));
  if (hash.startsWith('#orders/')) {
    const id = Number(hash.slice('#orders/'.length));
    return renderOrderDetail(mount(''), id);
  }
  if (hash.startsWith('#order-pay/')) {
    const id = hash.slice('#order-pay/'.length);
    return renderOrderPay(mount(''), id);
  }
  if (hash === '#account') return renderAccount(mount(''));
  if (hash === '#invoices') return renderInvoices(mount(''));
  if (hash.startsWith('#invoice/')) {
    return renderInvoiceDetail(mount(''), decodeURIComponent(hash.slice('#invoice/'.length)));
  }
  if (hash.startsWith('#pay/card/return')) {
    const id = new URLSearchParams(hash.split('?')[1] || '').get('id') || '';
    return renderPayCardReturn(mount(''), id);
  }
  if (hash === '#pay/card') return renderPayCard(mount(''));
  if (hash === '#pay/check') return renderPayCheck(mount(''));
  if (hash.startsWith('#pay-check/')) {
    const id = hash.slice('#pay-check/'.length);
    return renderPayCheck(mount(''), id);
  }
  if (hash === '#payments') return renderPayments(mount(''));
  if (hash === '#assistant') return renderAssistant(mount(''));
  if (hash === '#templates') return renderTemplates(mount(''));
  if (hash === '#favorites') return renderFavorites(mount(''));
  if (hash === '#scan') return renderScan(mount(''));

  // Unknown route → home
  location.hash = '#home';
}

async function onAuthChanged(): Promise<void> {
  await refreshMe();
  await refreshCartCount();
  const saved = sessionStorage.getItem('prgat_post_login_hash');
  sessionStorage.removeItem('prgat_post_login_hash');
  if (state.me?.role === 'admin') location.hash = '#admin';
  else location.hash = saved && saved !== '#login' ? saved : '#home';
}

window.addEventListener('hashchange', () => {
  route().catch((err) => {
    root.innerHTML = `<div class="app-shell"><div class="card error">שגיאה: ${err.message || err}</div></div>`;
  });
});

// A request 401'd (session idled out / password reset): drop the cached identity
// so route() actually shows the login screen instead of bouncing back to #home.
window.addEventListener('prgat:auth-expired', () => {
  state.me = null;
  state.cartCount = 0;
  // If we're already on #login, api.ts's hash assignment won't fire hashchange —
  // re-route explicitly so the login form renders.
  if (location.hash === '#login') void route();
});

// Re-check auth when the tab regains focus (the session may have idled out while
// backgrounded). If the identity changed or the session died, re-route so the UI
// reflects it immediately instead of waiting for the next tap to 401.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me) return;
  const prev = state.me;
  refreshMe()
    .then(() => {
      if (!state.me || state.me.id !== prev.id || state.me.role !== prev.role) {
        return route();
      }
    })
    .catch(() => {});
});

(async () => {
  await refreshMe();
  await refreshCartCount();
  await route();
})().catch((err) => {
  root.innerHTML = `<div class="app-shell"><div class="card error">שגיאה: ${err.message || err}</div></div>`;
});

registerPwa();
