import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { renderAdminProducts } from './adminProducts.js';
import { renderSettingsAdmin } from './adminSettings.js';
import { renderUsersAdmin } from './adminUsers.js';
import { renderAnalyticsAdmin } from './adminAnalytics.js';
import { renderPromotionsAdmin } from './adminPromotions.js';
import { renderAdminCustomers } from './adminCustomers.js';
import { renderCustomerCard } from './adminCustomerCard.js';
import { renderAdminChrome, refreshOpsBadges } from './adminShell.js';
import { renderAdminOrders } from './adminOrders.js';
import { renderAdminDashboard } from './adminDashboard.js';
import { renderAdminPayments } from './adminPayments.js';
import { openDrawer, toast } from '../ui.js';

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
  const c = renderAdminChrome(shell, tab);

  if (tab === '#admin/dashboard') await renderAdminDashboard(c);
  else if (tab === '#admin/analytics') await renderAnalyticsAdmin(c);
  else if (tab === '#admin/products') await renderAdminProducts(c);
  else if (tab === '#admin/catalog') await renderCatalogAdmin(c);
  else if (tab === '#admin/orders') await renderAdminOrders(c);
  else if (tab === '#admin/users') await renderUsersAdmin(c);           // off-nav, still routable
  else if (tab.startsWith('#admin/customers/')) { await renderCustomerCard(c, decodeURIComponent(tab.slice('#admin/customers/'.length))); }
  else if (tab === '#admin/customers') await renderAdminCustomers(c);
  else if (tab === '#admin/promotions') await renderPromotionsAdmin(c);
  else if (tab === '#admin/invites') await renderInvitesAdmin(c);       // off-nav, still routable
  else if (tab === '#admin/payments') await renderAdminPayments(c);
  else if (tab === '#admin/leads') await renderLeadsAdmin(c);
  else if (tab === '#admin/settings') await renderSettingsAdmin(c);
  else await renderAdminDashboard(c);                                   // unknown #admin/* → dashboard
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

const LEAD_STATUS_HE: Record<string, string> = { new: 'חדש', contacted: 'נוצר קשר', done: 'טופל' };

function leadStatusPillClass(status: string): string {
  return status === 'new' ? 'pill-new' : status === 'done' ? 'pill-on' : 'pill-net';
}
function leadStatusPill(status: string): string {
  return `<span class="cust-pill ${leadStatusPillClass(status)}">${escapeHtml(LEAD_STATUS_HE[status] || status)}</span>`;
}

// Local SQLite timestamps are naive UTC ("2026-05-27 12:00:00"); append Z (same
// convention as formatDateTime in format.ts).
function leadTimeAgo(s: string): string {
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return 'עכשיו';
  if (min < 60) return `לפני ${min} דק׳`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `לפני ${hr} שע׳`;
  const day = Math.floor(hr / 24);
  if (day < 7) return day === 1 ? 'אתמול' : `לפני ${day} ימים`;
  return d.toLocaleDateString('he-IL');
}

async function renderLeadsAdmin(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="adm-head">
      <h1 class="adm-title">לידים</h1><span class="adm-meta" id="lead-count"></span>
    </div>
    <div id="lead-list" class="adm-card" style="padding:0;overflow:hidden"></div>`;
  await loadLeadsList(shell);
}

async function loadLeadsList(shell: HTMLElement): Promise<void> {
  const wrap = shell.querySelector('#lead-list') as HTMLElement;
  wrap.innerHTML = `<div class="adm-empty">טוען…</div>`;
  try {
    const { leads } = await api.get<{ leads: Lead[] }>('/api/admin/leads');
    (shell.querySelector('#lead-count') as HTMLElement).textContent = leads.length ? `${leads.length} פניות` : '';

    if (leads.length === 0) {
      wrap.innerHTML = `<div class="adm-empty">פניות מדף הנחיתה יופיעו כאן</div>`;
      return;
    }

    wrap.innerHTML = leads
      .map(
        (l) => `
      <div class="lead-row" data-id="${l.id}">
        <div class="lead-row-main">
          <div class="lead-row-name">${escapeHtml(l.business_name || 'ללא שם עסק')} ${leadStatusPill(l.status)}</div>
          <div class="lead-row-sub">${escapeHtml([l.contact_name, l.city].filter(Boolean).join(' · ') || '—')}</div>
        </div>
        <span class="lead-row-date">${escapeHtml(leadTimeAgo(l.created_at))}</span>
        <span class="cust-chev">‹</span>
      </div>`
      )
      .join('');

    wrap.querySelectorAll<HTMLElement>('.lead-row').forEach((row) => {
      row.addEventListener('click', () => {
        const l = leads.find((x) => String(x.id) === row.dataset.id);
        if (l) openLeadDrawer(l, shell);
      });
    });
  } catch (ex) {
    wrap.innerHTML = `<div class="adm-empty error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}

// ---- The drawer: full details, tel:/mailto: links, status triage ----
function openLeadDrawer(l: Lead, shell: HTMLElement): void {
  const body = document.createElement('div');
  body.className = 'adm-drawer-body';
  body.innerHTML = `
    <div><div class="adm-sect-label">איש קשר</div><div style="font-size:13px">${escapeHtml(l.contact_name || '—')}</div></div>
    <div><div class="adm-sect-label">טלפון</div><div style="font-size:13px">${l.phone ? `<a href="tel:${escapeAttr(l.phone)}">${escapeHtml(l.phone)}</a>` : '—'}</div></div>
    <div><div class="adm-sect-label">אימייל</div><div style="font-size:13px">${l.email ? `<a href="mailto:${escapeAttr(l.email)}">${escapeHtml(l.email)}</a>` : '—'}</div></div>
    <div><div class="adm-sect-label">עיר</div><div style="font-size:13px">${escapeHtml(l.city || '—')}</div></div>
    ${l.notes ? `<div><div class="adm-sect-label">הערות</div><div style="font-size:13px;white-space:pre-wrap">${escapeHtml(l.notes)}</div></div>` : ''}
    <div>
      <div class="adm-sect-label">סטטוס</div>
      <div class="adm-seg" id="lead-status">
        <button type="button" data-s="new" class="${l.status === 'new' ? 'sel' : ''}">חדש</button>
        <button type="button" data-s="contacted" class="${l.status === 'contacted' ? 'sel' : ''}">נוצר קשר</button>
        <button type="button" data-s="done" class="${l.status === 'done' ? 'sel' : ''}">טופל</button>
      </div>
    </div>`;

  const drawer = openDrawer(body, {
    title: l.business_name || 'ליד ללא שם',
    sub: `התקבל ${escapeHtml(leadTimeAgo(l.created_at))}`,
  });

  body.querySelectorAll<HTMLButtonElement>('#lead-status button').forEach((b) => {
    b.onclick = async () => {
      const status = b.dataset.s!;
      if (status === l.status) return;
      const prevStatus = l.status;
      body.querySelectorAll('#lead-status button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      try {
        await api.patch(`/api/admin/leads/${l.id}`, { status });
        toast('הסטטוס עודכן ✓', 'ok');
        drawer.close();
        void loadLeadsList(shell);
        void refreshOpsBadges();
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : 'העדכון נכשל', 'error');
        b.classList.remove('sel');
        body.querySelector(`#lead-status button[data-s="${prevStatus}"]`)?.classList.add('sel');
      }
    };
  });
}

