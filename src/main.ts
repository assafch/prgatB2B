// prgatB2B — hash router. Loads /api/auth/me at boot, dispatches to pages by route.

import { api, type MeUser } from './api.js';
import { renderLogin } from './pages/login.js';
import { renderLead } from './pages/lead.js';
import { renderInvite } from './pages/invite.js';
import { renderCatalog } from './pages/catalog.js';
import { renderProduct } from './pages/product.js';
import { renderCart } from './pages/cart.js';
import { renderOrders } from './pages/orders.js';
import { renderOrderDetail } from './pages/orderDetail.js';
import { renderAccount } from './pages/account.js';
import { renderInvoices } from './pages/invoices.js';
import { renderAdmin } from './pages/admin.js';

const root = document.getElementById('app')!;

interface AppState {
  me: MeUser | null;
}

export const state: AppState = { me: null };

function topbar(): string {
  const me = state.me;
  if (!me) {
    return `
      <div class="topbar">
        <div class="logo">אורגת B2B</div>
        <nav>
          <a href="#login" class="${location.hash === '#login' || !location.hash ? 'active' : ''}">התחברות</a>
          <a href="#lead" class="${location.hash === '#lead' ? 'active' : ''}">ליד חדש</a>
        </nav>
      </div>`;
  }
  if (me.role === 'admin') {
    return `
      <div class="topbar">
        <div class="logo">אורגת B2B · אדמין</div>
        <nav>
          <a href="#admin" class="${location.hash.startsWith('#admin') ? 'active' : ''}">לוח בקרה</a>
          <a href="#logout">יציאה</a>
        </nav>
      </div>`;
  }
  return `
    <div class="topbar">
      <div class="logo">אורגת B2B</div>
      <nav>
        <a href="#catalog" class="${location.hash.startsWith('#catalog') || location.hash === '' ? 'active' : ''}">קטלוג</a>
        <a href="#cart" class="${location.hash === '#cart' ? 'active' : ''}">סל 🛒</a>
        <a href="#orders" class="${location.hash.startsWith('#orders') ? 'active' : ''}">הזמנות</a>
        <a href="#invoices" class="${location.hash === '#invoices' ? 'active' : ''}">חשבוניות</a>
        <a href="#account" class="${location.hash === '#account' ? 'active' : ''}">חשבון</a>
        <a href="#logout">יציאה</a>
      </nav>
    </div>`;
}

function mount(html: string): HTMLDivElement {
  root.innerHTML = `${topbar()}<div class="app-shell"></div>`;
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

async function route(): Promise<void> {
  const hash = location.hash || (state.me ? '#catalog' : '#login');
  await refreshMe();

  if (hash === '#logout') {
    await api.post('/api/auth/logout');
    state.me = null;
    location.hash = '#login';
    return;
  }

  // Public routes
  if (hash === '#login') return renderLogin(mount(''), onAuthChanged);
  if (hash === '#lead') return renderLead(mount(''));
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
  if (hash === '#catalog' || hash === '') return renderCatalog(mount(''));
  if (hash.startsWith('#product/')) {
    const part = decodeURIComponent(hash.slice('#product/'.length));
    return renderProduct(mount(''), part);
  }
  if (hash === '#cart') return renderCart(mount(''));
  if (hash === '#orders') return renderOrders(mount(''));
  if (hash.startsWith('#orders/')) {
    const id = Number(hash.slice('#orders/'.length));
    return renderOrderDetail(mount(''), id);
  }
  if (hash === '#account') return renderAccount(mount(''));
  if (hash === '#invoices') return renderInvoices(mount(''));

  // Unknown route → catalog
  location.hash = '#catalog';
}

async function onAuthChanged(): Promise<void> {
  await refreshMe();
  if (state.me?.role === 'admin') location.hash = '#admin';
  else location.hash = '#catalog';
  // Hash change handler will re-render
}

window.addEventListener('hashchange', () => {
  route().catch((err) => {
    root.innerHTML = `<div class="app-shell"><div class="card error">שגיאה: ${err.message || err}</div></div>`;
  });
});

route().catch((err) => {
  root.innerHTML = `<div class="app-shell"><div class="card error">שגיאה: ${err.message || err}</div></div>`;
});
