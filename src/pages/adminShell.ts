// Admin chrome — grouped navy sidebar (>=1024px) / bottom nav + "עוד" sheet (<1024px).
// Both are rendered; CSS decides which is visible. Badges come from /api/admin/ops-queue.
import { api } from '../api.js';
import { openSheet } from '../ui.js';

const I = {
  home: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2z"/></svg>',
  card: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
  box: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v9"/></svg>',
  lead: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M19 8v6M22 11h-6"/></svg>',
  grid: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  tag: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12l-8 8-9-9V4h7z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  people: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="3.5"/><circle cx="16.5" cy="10" r="2.5"/><path d="M2 20c0-3.5 2.5-5.5 6-5.5s6 2 6 5.5M15 20c0-2.5 1.5-4 4.5-4 1 0 1.9.2 2.5.6"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M7 17V9M12 17V5M17 17v-6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/></svg>',
  gear: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a7.8 7.8 0 0 0 .1-6l2-1.5-2-3.5-2.4 1a8 8 0 0 0-5.2-3L11.5 0h-4L7 2a8 8 0 0 0-5.2 3l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 .1 6"/></svg>',
};

type BadgeKey = 'payments' | 'orders' | 'leads';
interface NavItem { hash: string; label: string; icon: string; badge?: BadgeKey }

const GROUPS: Array<{ label: string; items: NavItem[] }> = [
  { label: 'תפעול יומי', items: [
    { hash: '#admin/dashboard', label: 'לוח בקרה', icon: I.home },
    { hash: '#admin/payments', label: 'תשלומים', icon: I.card, badge: 'payments' },
    { hash: '#admin/orders', label: 'הזמנות', icon: I.box, badge: 'orders' },
    { hash: '#admin/leads', label: 'לידים', icon: I.lead, badge: 'leads' },
  ]},
  { label: 'מסחר', items: [
    { hash: '#admin/products', label: 'מוצרים', icon: I.grid },
    { hash: '#admin/promotions', label: 'מבצעים', icon: I.tag },
    { hash: '#admin/customers', label: 'לקוחות', icon: I.people },
  ]},
  { label: 'מערכת', items: [
    { hash: '#admin/analytics', label: 'דוחות', icon: I.chart },
    { hash: '#admin/catalog', label: 'סנכרון Priority', icon: I.refresh },
    { hash: '#admin/settings', label: 'הגדרות', icon: I.gear },
  ]},
];

const isActive = (item: NavItem, tab: string): boolean =>
  tab === item.hash || (item.hash === '#admin/customers' && tab.startsWith('#admin/customers'));

function badgeSpan(key?: BadgeKey): string {
  return key ? `<span class="nav-badge" data-ops-badge="${key}" hidden></span>` : '';
}

function sidebar(tab: string): string {
  return `
  <aside class="admin-side">
    <div class="admin-brand"><span class="admin-brand-mark">א</span><span><b>אורגת סחר</b><small>מרכז בקרה</small></span></div>
    ${GROUPS.map(g => `
      <div class="admin-group-label">${g.label}</div>
      ${g.items.map(it => `
        <a class="admin-nav-item${isActive(it, tab) ? ' active' : ''}" href="${it.hash}">
          ${it.icon}<span>${it.label}</span>${badgeSpan(it.badge)}
        </a>`).join('')}
    `).join('')}
    <div class="admin-side-foot">
      <span class="admin-avatar">א</span>
      <span class="admin-foot-id"><b>אסף</b><small>מנהל</small></span>
      <a href="#logout" class="admin-foot-logout">יציאה</a>
    </div>
  </aside>`;
}

// Bottom nav: 5 destinations by frequency; "עוד" opens the secondary sheet.
const MOBILE_ITEMS: NavItem[] = [
  { hash: '#admin/dashboard', label: 'בקרה', icon: I.home },
  { hash: '#admin/payments', label: 'תשלומים', icon: I.card, badge: 'payments' },
  { hash: '#admin/orders', label: 'הזמנות', icon: I.box, badge: 'orders' },
  { hash: '#admin/customers', label: 'לקוחות', icon: I.people },
];

function bottomNav(tab: string): string {
  return `
  <nav class="admin-bottom-nav">
    ${MOBILE_ITEMS.map(it => `
      <a href="${it.hash}" class="${isActive(it, tab) ? 'active' : ''}">
        <span class="abn-icon">${it.icon}${badgeSpan(it.badge)}</span>${it.label}
      </a>`).join('')}
    <button type="button" id="admin-more" class="abn-more"><span class="abn-icon">⋯</span>עוד</button>
  </nav>`;
}

function moreSheet(): HTMLElement {
  const node = document.createElement('div');
  node.innerHTML = `
    <div class="admin-more-grid">
      <a href="#admin/products">📦<b>מוצרים</b></a>
      <a href="#admin/promotions">🏷️<b>מבצעים</b></a>
      <a href="#admin/leads">✦<b>לידים</b><span class="nav-badge" data-ops-badge="leads" hidden></span></a>
      <a href="#admin/analytics">📊<b>דוחות</b></a>
      <a href="#admin/catalog">↻<b>סנכרון</b></a>
      <a href="#admin/settings">⚙️<b>הגדרות</b></a>
    </div>
    <a href="#logout" class="admin-more-logout">יציאה</a>`;
  return node;
}

/** Fill every [data-ops-badge] from /api/admin/ops-queue. Safe to call after actions. */
export async function refreshOpsBadges(): Promise<void> {
  try {
    const { queues } = await api.get<{ queues: {
      stuckOrders: { count: number }; failedReceipts: { count: number };
      pendingChecks: { count: number }; newLeads: { count: number };
    } }>('/api/admin/ops-queue');
    const counts: Record<BadgeKey, number> = {
      payments: queues.pendingChecks.count,
      orders: queues.stuckOrders.count + queues.failedReceipts.count,
      leads: queues.newLeads.count,
    };
    document.querySelectorAll<HTMLElement>('[data-ops-badge]').forEach(el => {
      const n = counts[el.dataset.opsBadge as BadgeKey] ?? 0;
      el.textContent = String(n);
      el.hidden = n === 0;
    });
  } catch { /* badges are decoration-adjacent; never block the screen on them */ }
}

/** Render the admin chrome into `shell`, return the content container. */
export function renderAdminChrome(shell: HTMLElement, tab: string): HTMLElement {
  shell.innerHTML = `
    <div class="admin-layout">
      ${sidebar(tab)}
      <div class="admin-mobile-head"><span class="admin-brand-mark">א</span><b>מרכז בקרה</b></div>
      <main class="admin-main" id="admin-content"></main>
      ${bottomNav(tab)}
    </div>`;
  shell.querySelector('#admin-more')?.addEventListener('click', () => {
    openSheet(moreSheet(), { label: 'עוד' });
    void refreshOpsBadges(); // the sheet has its own leads badge
  });
  void refreshOpsBadges();
  return shell.querySelector('#admin-content') as HTMLElement;
}
