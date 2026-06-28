import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { renderAdminProducts } from './adminProducts.js';
import { renderSettingsAdmin } from './adminSettings.js';
import { renderUsersAdmin } from './adminUsers.js';
import { renderAnalyticsAdmin } from './adminAnalytics.js';
import { renderPromotionsAdmin } from './adminPromotions.js';
import { renderAdminCustomers } from './adminCustomers.js';
import { renderCustomerCard } from './adminCustomerCard.js';

interface Stats {
  users: number;
  orders: number;
  orders_submitted: number;
  leads: number;
  invites_pending: number;
  products: number;
}

interface Customer {
  CUSTNAME: string;
  CUSTDES?: string;
}

interface Invite {
  token: string;
  custname: string;
  cust_desc: string | null;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

interface Lead {
  id: number;
  business_name: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  notes: string | null;
  status: string;
  created_at: string;
}

export async function renderAdmin(shell: HTMLElement, hash: string): Promise<void> {
  const tab = hash === '#admin' ? '#admin/dashboard' : hash;
  shell.innerHTML = `
    <div class="card" style="margin-bottom:0.75rem">
      <nav style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <a href="#admin/dashboard" class="${tab === '#admin/dashboard' ? 'active' : ''}">לוח בקרה</a>
        <a href="#admin/analytics" class="${tab === '#admin/analytics' ? 'active' : ''}">דוחות</a>
        <a href="#admin/products" class="${tab === '#admin/products' ? 'active' : ''}">ניהול מוצרים</a>
        <a href="#admin/catalog" class="${tab === '#admin/catalog' ? 'active' : ''}">סנכרון Priority</a>
        <a href="#admin/users" class="${tab === '#admin/users' ? 'active' : ''}">משתמשים</a>
        <a href="#admin/customers" class="${tab === '#admin/customers' || tab.startsWith('#admin/customers/') ? 'active' : ''}">לקוחות</a>
        <a href="#admin/promotions" class="${tab === '#admin/promotions' ? 'active' : ''}">מבצעים</a>
        <a href="#admin/invites" class="${tab === '#admin/invites' ? 'active' : ''}">הזמנות-לקוח</a>
        <a href="#admin/payments" class="${tab === '#admin/payments' ? 'active' : ''}">תשלומים</a>
        <a href="#admin/leads" class="${tab === '#admin/leads' ? 'active' : ''}">לידים</a>
        <a href="#admin/settings" class="${tab === '#admin/settings' ? 'active' : ''}">הגדרות</a>
      </nav>
    </div>
    <div id="admin-content"></div>
  `;
  const c = shell.querySelector('#admin-content') as HTMLDivElement;

  if (tab === '#admin/dashboard') await renderDashboard(c);
  else if (tab === '#admin/analytics') await renderAnalyticsAdmin(c);
  else if (tab === '#admin/products') await renderAdminProducts(c);
  else if (tab === '#admin/catalog') await renderCatalogAdmin(c);
  else if (tab === '#admin/users') await renderUsersAdmin(c);
  else if (tab.startsWith('#admin/customers/')) { await renderCustomerCard(c, decodeURIComponent(tab.slice('#admin/customers/'.length))); }
  else if (tab === '#admin/customers') await renderAdminCustomers(c);
  else if (tab === '#admin/promotions') await renderPromotionsAdmin(c);
  else if (tab === '#admin/invites') await renderInvitesAdmin(c);
  else if (tab === '#admin/payments') await renderPaymentsAdmin(c);
  else if (tab === '#admin/leads') await renderLeadsAdmin(c);
  else if (tab === '#admin/settings') await renderSettingsAdmin(c);
}

interface AdminCheck {
  id: string;
  custname: string;
  amount: number | null;
  checkDate: string | null;
  isPostdated: boolean;
  status: string;
  createdAt: string;
}

async function renderPaymentsAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `<div class="muted">טוען…</div>`;
  let checks: AdminCheck[] = [];
  try {
    checks = (await api.get<{ checks: AdminCheck[] }>('/api/admin/payments')).checks;
  } catch (ex) {
    c.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }
  checks = checks.filter((c2) => c2.status !== 'draft');
  if (checks.length === 0) {
    c.innerHTML = `<div class="card muted">אין תשלומי צ׳ק עדיין.</div>`;
    return;
  }
  const opts = (cur: string) =>
    [
      ['submitted', 'התקבל — בעיבוד'],
      ['received', 'הצ׳ק נאסף'],
      ['deposited', 'הופקד'],
      ['bounced', 'חזר'],
      ['cancelled', 'בוטל'],
    ]
      .map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`)
      .join('');

  c.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">תשלומי צ׳ק — סליקה</h2>
      <table class="table">
        <thead><tr><th>לקוח</th><th>סכום</th><th>תאריך צ׳ק</th><th>נשלח</th><th>סטטוס</th><th>צ׳ק</th></tr></thead>
        <tbody>
          ${checks
            .map(
              (ch) => `
            <tr data-id="${escapeAttr(ch.id)}">
              <td>${escapeHtml(ch.custname)}</td>
              <td class="amount">${ch.amount != null ? '₪' + ch.amount.toFixed(2) : '-'}</td>
              <td>${ch.checkDate ? escapeHtml(ch.checkDate) : '-'}${ch.isPostdated ? ' <span class="badge warn">דחוי</span>' : ''}</td>
              <td>${escapeHtml((ch.createdAt || '').slice(0, 10))}</td>
              <td><select class="pay-status" data-id="${escapeAttr(ch.id)}">${opts(ch.status)}</select></td>
              <td><a href="/api/admin/payments/${encodeURIComponent(ch.id)}/image" target="_blank">צפייה</a></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div id="pay-msg" style="margin-top:0.5rem"></div>
    </div>
  `;
  const msg = c.querySelector('#pay-msg') as HTMLDivElement;
  c.querySelectorAll<HTMLSelectElement>('select.pay-status').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        await api.patch(`/api/admin/payments/${sel.dataset.id}`, { status: sel.value });
        msg.textContent = '✓ עודכן';
        msg.className = 'ok';
      } catch (ex) {
        msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
        msg.className = 'error';
      }
    });
  });
}

async function renderDashboard(c: HTMLElement): Promise<void> {
  c.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const s = await api.get<Stats>('/api/admin/dashboard');
    c.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem">
        ${tile('לקוחות רשומים', s.users)}
        ${tile('הזמנות', s.orders)}
        ${tile('נשלחו ל-Priority', s.orders_submitted)}
        ${tile('לידים חדשים', s.leads)}
        ${tile('הזמנות פתוחות', s.invites_pending)}
        ${tile('מוצרים בקטלוג', s.products)}
      </div>
    `;
  } catch (ex) {
    c.innerHTML = `<div class="card error">${ex instanceof Error ? ex.message : ex}</div>`;
  }
}

function tile(label: string, value: number): string {
  return `
    <div class="card" style="text-align:center">
      <div class="muted" style="font-size:0.85rem">${label}</div>
      <div style="font-size:2rem;font-weight:700;color:var(--brand)">${value}</div>
    </div>`;
}

async function renderCatalogAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">סנכרון קטלוג מ-Priority</h2>
      <p class="muted">משוך את כל המוצרים (LOGPART) ומשפחות המוצרים מ-Priority ל-cache המקומי.</p>
      <button id="refresh">סנכרן עכשיו</button>
      <div id="msg" style="margin-top:1rem"></div>
    </div>
  `;
  const btn = c.querySelector('#refresh') as HTMLButtonElement;
  const msg = c.querySelector('#msg') as HTMLDivElement;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    msg.textContent = 'מסנכרן… זה עשוי לקחת דקה או שתיים';
    msg.className = 'muted';
    try {
      const r = await api.post<{ products: number; families: number }>('/api/admin/catalog/refresh');
      msg.textContent = `✓ נטענו ${r.products} מוצרים ו-${r.families} משפחות`;
      msg.className = 'ok';
    } catch (ex) {
      msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
      msg.className = 'error';
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderInvitesAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `
    <div class="card" style="margin-bottom:0.75rem">
      <h2 style="margin-top:0">צור הזמנת-לקוח חדשה</h2>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        <input id="custname" placeholder="CUSTNAME (מספר לקוח ב-Priority)" style="flex:1;min-width:200px"/>
        <input id="cust_desc" placeholder="שם לקוח לתצוגה" style="flex:1;min-width:200px"/>
        <input id="email" placeholder="אימייל (אופציונלי)" style="flex:1;min-width:180px"/>
        <input id="phone" placeholder="טלפון (אופציונלי)" style="flex:1;min-width:140px"/>
        <button id="create">צור</button>
      </div>
      <div id="create-msg" style="margin-top:0.5rem"></div>
    </div>
    <div id="invites-list" class="muted">טוען…</div>
  `;

  const createBtn = c.querySelector('#create') as HTMLButtonElement;
  const createMsg = c.querySelector('#create-msg') as HTMLDivElement;
  createBtn.addEventListener('click', async () => {
    const custname = (c.querySelector('#custname') as HTMLInputElement).value.trim();
    const cust_desc = (c.querySelector('#cust_desc') as HTMLInputElement).value.trim();
    const email = (c.querySelector('#email') as HTMLInputElement).value.trim();
    const phone = (c.querySelector('#phone') as HTMLInputElement).value.trim();
    if (!custname) {
      createMsg.textContent = 'יש להזין CUSTNAME';
      createMsg.className = 'error';
      return;
    }
    try {
      const r = await api.post<{ url: string }>('/api/admin/invites', {
        custname,
        cust_desc,
        email,
        phone,
      });
      createMsg.innerHTML = `<div class="ok">קישור הזמנה: <input value="${escapeAttr(r.url)}" readonly style="width:100%;margin-top:0.25rem"/></div>`;
      createMsg
        .querySelector('input')
        ?.addEventListener('click', (e) => (e.target as HTMLInputElement).select());
      await loadInvitesList(c);
    } catch (ex) {
      createMsg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
      createMsg.className = 'error';
    }
  });

  await loadInvitesList(c);
}

async function loadInvitesList(c: HTMLElement): Promise<void> {
  const list = c.querySelector('#invites-list') as HTMLDivElement;
  try {
    const { invites } = await api.get<{ invites: Invite[] }>('/api/admin/invites');
    if (invites.length === 0) {
      list.innerHTML = `<div class="card muted">עדיין לא נוצרו הזמנות.</div>`;
      return;
    }
    list.className = '';
    list.innerHTML = `
      <div class="card">
        <h3 style="margin-top:0">הזמנות אחרונות</h3>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:right;border-bottom:1px solid var(--border)">
              <th style="padding:0.5rem">CUSTNAME</th>
              <th style="padding:0.5rem">שם</th>
              <th style="padding:0.5rem">נוצרה</th>
              <th style="padding:0.5rem">סטטוס</th>
              <th style="padding:0.5rem">קישור</th>
            </tr>
          </thead>
          <tbody>
            ${invites
              .map((i) => {
                const used = i.used_at ? '<span class="ok">נוצל ✓</span>' : '<span class="muted">ממתין</span>';
                const url = `${location.origin}/#invite/${i.token}`;
                return `
                  <tr style="border-bottom:1px solid var(--border)">
                    <td style="padding:0.5rem">${escapeHtml(i.custname)}</td>
                    <td style="padding:0.5rem">${escapeHtml(i.cust_desc || '-')}</td>
                    <td style="padding:0.5rem">${new Date(i.created_at + 'Z').toLocaleString('he-IL')}</td>
                    <td style="padding:0.5rem">${used}</td>
                    <td style="padding:0.5rem"><input value="${escapeAttr(url)}" readonly style="width:100%"/></td>
                  </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    list
      .querySelectorAll('input[readonly]')
      .forEach((el) => el.addEventListener('click', () => (el as HTMLInputElement).select()));
  } catch (ex) {
    list.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}

async function renderLeadsAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const { leads } = await api.get<{ leads: Lead[] }>('/api/admin/leads');
    if (leads.length === 0) {
      c.innerHTML = `<div class="card muted">אין לידים עדיין.</div>`;
      return;
    }
    c.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">לידים</h2>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:right;border-bottom:1px solid var(--border)">
              <th style="padding:0.5rem">תאריך</th>
              <th style="padding:0.5rem">עסק</th>
              <th style="padding:0.5rem">איש קשר</th>
              <th style="padding:0.5rem">טלפון</th>
              <th style="padding:0.5rem">אימייל</th>
              <th style="padding:0.5rem">עיר</th>
              <th style="padding:0.5rem">הערות</th>
              <th style="padding:0.5rem">סטטוס</th>
            </tr>
          </thead>
          <tbody>
            ${leads
              .map(
                (l) => `
              <tr style="border-bottom:1px solid var(--border)">
                <td style="padding:0.5rem">${new Date(l.created_at + 'Z').toLocaleString('he-IL')}</td>
                <td style="padding:0.5rem">${escapeHtml(l.business_name || '-')}</td>
                <td style="padding:0.5rem">${escapeHtml(l.contact_name || '-')}</td>
                <td style="padding:0.5rem">${escapeHtml(l.phone || '-')}</td>
                <td style="padding:0.5rem">${escapeHtml(l.email || '-')}</td>
                <td style="padding:0.5rem">${escapeHtml(l.city || '-')}</td>
                <td style="padding:0.5rem">${escapeHtml(l.notes || '')}</td>
                <td style="padding:0.5rem">${l.status}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (ex) {
    c.innerHTML = `<div class="card error">${ex instanceof Error ? ex.message : ex}</div>`;
  }
}

