// Customers board — the "רשימה + מגירה" template screen (Stage 8b).
// Row click → drawer (policy, threshold, discount, users, invite, danger zone).
// The full card (#admin/customers/:custname) stays for deep work.
import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';
import { confirmDialog, openDrawer, toast } from '../ui.js';

interface AdminCustomer {
  custname: string; cust_desc: string | null; user_count: number;
  kind: string; resolvedKind: string; open_debt_threshold: number | null;
  allow_order_with_open_debt: number; enforced: number;
  paymentTerms: string | null; openTotal: number | null; discount_percent: number | null;
}
interface CardUser { id: number; username: string; customer_role: string; status: string; last_login_at: string | null }
interface CustomerCard {
  custname: string; cust_desc: string | null;
  policy: { kind: string; open_debt_threshold: number | null; allow_order_with_open_debt: number; enforced: number };
  resolvedKind: 'cash' | 'net'; users: CardUser[];
  finance: { priorityOk: boolean; paymentTerms: string | null; openTotal: number | null; creditLimit: number | null; obligo: number | null };
  discount?: { percent: number | null; source: string | null; updated_at: string | null };
}

const qs = { q: '', page: 0, pageSize: 50 };
const nis = (n: number): string => '₪' + Math.round(n).toLocaleString('he-IL');

const KIND_LABEL: Record<string, string> = { auto: 'אוטו׳', cash: 'מזומן', net: 'שוטף' };

function kindPill(r: AdminCustomer): string {
  const resolved = r.kind === 'auto' ? r.resolvedKind : r.kind;
  const label = r.kind === 'auto' ? `${KIND_LABEL.auto} (${KIND_LABEL[resolved] ?? resolved})` : KIND_LABEL[r.kind] ?? r.kind;
  const cls = resolved === 'cash' ? 'pill-cash' : 'pill-net';
  return `<span class="cust-pill ${cls}">${label}</span>`;
}

export async function renderAdminCustomers(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="adm-head">
      <h1 class="adm-title">לקוחות</h1><span class="adm-meta" id="cust-count"></span>
      <div class="adm-head-actions">
        <input id="cust-q" class="adm-search" placeholder="🔍 חיפוש חברה / מס׳ לקוח" value="${escapeAttr(qs.q)}"/>
      </div>
    </div>
    <div id="cust-table" class="adm-card" style="padding:0;overflow:hidden"></div>
    <div id="cust-pager" style="text-align:center;margin-top:0.75rem"></div>
    <button type="button" id="cust-fab" class="adm-fab" aria-label="הזמנת לקוח חדש">+</button>`;

  const q = shell.querySelector('#cust-q') as HTMLInputElement;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { qs.q = q.value.trim(); qs.page = 0; void loadList(shell); } });
  (shell.querySelector('#cust-fab') as HTMLButtonElement).onclick = () => openInviteDrawer();
  await loadList(shell);
}

async function loadList(shell: HTMLElement): Promise<void> {
  const wrap = shell.querySelector('#cust-table') as HTMLElement;
  wrap.innerHTML = `<div class="adm-empty">טוען…</div>`;
  try {
    const params = new URLSearchParams();
    if (qs.q) params.set('q', qs.q);
    params.set('page', String(qs.page)); params.set('pageSize', String(qs.pageSize));
    const { items, total } = await api.get<{ items: AdminCustomer[]; total: number }>(`/api/admin/customers?${params}`);
    (shell.querySelector('#cust-count') as HTMLElement).textContent = `${total} חברות`;

    if (items.length === 0) {
      wrap.innerHTML = `<div class="adm-empty">לא נמצאו לקוחות${qs.q ? ' לחיפוש הזה' : ''}.<br><small>לקוח נכנס לרשימה ברגע שנוצר לו משתמש — דרך כפתור ה-+ (קישור הזמנה).</small></div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="cust-grid cust-grid-head"><span>חברה</span><span>מס׳ לקוח</span><span>סוג תשלום</span><span>חוב פתוח</span><span>הנחה</span><span></span></div>
      ${items.map(r => `
        <div class="cust-grid cust-row" data-cust="${escapeAttr(r.custname)}">
          <span class="cust-name">${escapeHtml(r.cust_desc || r.custname)}</span>
          <span class="muted tabnum">${escapeHtml(r.custname)}</span>
          <span>${kindPill(r)}</span>
          <span class="money ${r.openTotal ? 'debt' : 'muted'}">${r.openTotal != null ? nis(r.openTotal) : '—'}</span>
          <span class="tabnum">${r.discount_percent != null ? Math.round(r.discount_percent) + '%' : '—'}</span>
          <span class="cust-chev">‹</span>
        </div>`).join('')}`;

    wrap.querySelectorAll<HTMLElement>('.cust-row').forEach(row => {
      row.addEventListener('click', () => { void openCustomerDrawer(row.dataset.cust!, shell); });
    });

    const totalPages = Math.max(1, Math.ceil(total / qs.pageSize));
    const pager = shell.querySelector('#cust-pager') as HTMLElement;
    pager.innerHTML = totalPages <= 1 ? '' : `
      <button ${qs.page <= 0 ? 'disabled' : ''} id="prev">‹ הקודם</button>
      <span style="margin:0 1rem">עמוד ${qs.page + 1} מתוך ${totalPages}</span>
      <button ${qs.page >= totalPages - 1 ? 'disabled' : ''} id="next">הבא ›</button>`;
    pager.querySelector('#prev')?.addEventListener('click', () => { qs.page--; void loadList(shell); });
    pager.querySelector('#next')?.addEventListener('click', () => { qs.page++; void loadList(shell); });
  } catch (ex) {
    wrap.innerHTML = `<div class="adm-empty error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}

// ---- The drawer: policy · threshold · discount · users · invite · danger ----
async function openCustomerDrawer(custname: string, shell: HTMLElement): Promise<void> {
  let d: CustomerCard;
  try { d = await api.get<CustomerCard>(`/api/admin/customers/${encodeURIComponent(custname)}`); }
  catch (ex) { toast(ex instanceof Error ? ex.message : 'טעינה נכשלה', 'error'); return; }

  const body = document.createElement('div');
  body.className = 'adm-drawer-body';
  const pending: { kind: string; open_debt_threshold: number | null; allow_order_with_open_debt: number; enforced: number } = { ...d.policy };
  body.innerHTML = `
    <div>
      <div class="adm-sect-label">מדיניות תשלום</div>
      <div class="adm-seg" id="dr-kind">
        <button type="button" data-k="auto" class="${pending.kind === 'auto' ? 'sel' : ''}">אוטו׳ (${KIND_LABEL[d.resolvedKind]})</button>
        <button type="button" data-k="cash" class="${pending.kind === 'cash' ? 'sel' : ''}">מזומן</button>
        <button type="button" data-k="net" class="${pending.kind === 'net' ? 'sel' : ''}">שוטף</button>
      </div>
    </div>
    <div>
      <div class="adm-sect-label">סף חוב לחסימה</div>
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span class="adm-currency"><i>₪</i><input id="dr-thr" type="number" min="0" inputmode="numeric" value="${pending.open_debt_threshold ?? ''}" placeholder="ללא סף"/></span>
        <label class="adm-toggle-line"><button type="button" id="dr-enforce" class="adm-toggle ${pending.enforced ? 'on' : ''}"></button>אכוף חסימה</label>
        <label class="adm-toggle-line"><button type="button" id="dr-exempt" class="adm-toggle ${pending.allow_order_with_open_debt ? 'on' : ''}"></button>פטור</label>
      </div>
    </div>
    <div>
      <div class="adm-sect-label">הנחת לקוח</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="adm-currency"><input id="dr-disc" type="number" min="0" max="99" step="0.5" style="width:64px" value="${d.discount?.percent ?? ''}" placeholder="—"/><i>%</i></span>
        ${d.discount?.source ? `<span class="cust-pill pill-src">${d.discount.source === 'manual' ? 'ידני' : 'אוטו׳ מהזמנות'}</span>` : ''}
        <button type="button" id="dr-disc-refresh" class="adm-btn-ghost" style="padding:5px 10px">↻ משוך מהזמנות</button>
      </div>
    </div>
    <div>
      <div class="adm-sect-label">משתמשים (${d.users.length}) · הזמנות-לקוח</div>
      <div id="dr-users">${d.users.map(u => `
        <div class="dr-user-row">
          <b>${escapeHtml(u.username)}</b>
          <span class="${u.status === 'active' ? 'ok' : 'warn'}" style="font-size:10.5px;font-weight:700">${u.status === 'active' ? 'פעיל' : 'מושבת'}</span>
        </div>`).join('') || '<div class="muted" style="font-size:12px">אין משתמשים עדיין</div>'}
      </div>
      <button type="button" id="dr-invite" class="adm-btn-ghost" style="margin-top:6px;padding:6px 12px">+ צור קישור הזמנה</button>
      <div id="dr-invite-out" style="margin-top:6px"></div>
    </div>
    <details class="adm-danger"><summary>אזור מסוכן ▾</summary>
      <button type="button" id="dr-reset-portal" class="adm-btn-ghost" style="margin-top:8px;color:var(--err);border-color:#f0c9c5">איפוס פורטל (מחיקת הזמנות וסל)</button>
    </details>`;

  const foot = document.createElement('div');
  foot.className = 'adm-drawer-foot';
  foot.innerHTML = `<button type="button" class="save">שמור שינויים</button><button type="button" class="cancel">ביטול</button>`;
  body.append(foot);

  const drawer = openDrawer(body, {
    title: d.cust_desc || d.custname,
    sub: `לקוח ${d.custname} · ${d.finance.priorityOk ? 'Priority ✓' : 'Priority —'} · חוב ${d.finance.openTotal != null ? nis(d.finance.openTotal) : '—'} · <a href="#admin/customers/${encodeURIComponent(d.custname)}">כרטיס מלא ←</a>`,
  });

  body.querySelectorAll<HTMLButtonElement>('#dr-kind button').forEach(b => {
    b.onclick = () => {
      body.querySelectorAll('#dr-kind button').forEach(x => x.classList.remove('sel'));
      b.classList.add('sel'); pending.kind = b.dataset.k!;
    };
  });
  const bindToggle = (id: string, key: 'enforced' | 'allow_order_with_open_debt'): void => {
    const t = body.querySelector('#' + id) as HTMLButtonElement;
    t.onclick = () => { t.classList.toggle('on'); pending[key] = t.classList.contains('on') ? 1 : 0; };
  };
  bindToggle('dr-enforce', 'enforced');
  bindToggle('dr-exempt', 'allow_order_with_open_debt');

  (foot.querySelector('.cancel') as HTMLButtonElement).onclick = () => drawer.close();
  (foot.querySelector('.save') as HTMLButtonElement).onclick = async () => {
    const thrRaw = (body.querySelector('#dr-thr') as HTMLInputElement).value.trim();
    pending.open_debt_threshold = thrRaw === '' ? null : Number(thrRaw);
    try {
      await api.post('/api/admin/customers/batch', { items: [{ custname: d.custname, ...pending }] });
      const discRaw = (body.querySelector('#dr-disc') as HTMLInputElement).value.trim();
      const newPct = discRaw === '' ? null : Number(discRaw);
      if (newPct !== (d.discount?.percent ?? null)) {
        await api.patch(`/api/admin/customers/${encodeURIComponent(d.custname)}`, { discount_percent: newPct });
      }
      toast('נשמר ✓', 'ok'); drawer.close(); void loadList(shell);
    } catch (ex) { toast(ex instanceof Error ? ex.message : 'השמירה נכשלה', 'error'); }
  };

  (body.querySelector('#dr-disc-refresh') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true;
    try {
      const r = await api.post<{ percent: number | null }>(`/api/admin/customers/${encodeURIComponent(d.custname)}/refresh-discount`, {});
      (body.querySelector('#dr-disc') as HTMLInputElement).value = r.percent != null ? String(r.percent) : '';
      toast(r.percent != null ? `נמשך: ${r.percent}%` : 'לא נמצאה הנחה בהזמנות', 'ok');
    } catch (ex) { toast(ex instanceof Error ? ex.message : 'המשיכה נכשלה', 'error'); }
    btn.disabled = false;
  };

  (body.querySelector('#dr-invite') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement; btn.disabled = true;
    try {
      const r = await api.post<{ url: string }>('/api/admin/invites', { custname: d.custname, cust_desc: d.cust_desc ?? '', email: '', phone: '' });
      const out = body.querySelector('#dr-invite-out') as HTMLElement;
      out.innerHTML = `<input readonly value="${escapeAttr(r.url)}" style="width:100%" onclick="this.select()"/>`;
      toast('קישור הזמנה נוצר ✓', 'ok');
    } catch (ex) { toast(ex instanceof Error ? ex.message : 'יצירת הקישור נכשלה', 'error'); }
    btn.disabled = false;
  };

  (body.querySelector('#dr-reset-portal') as HTMLButtonElement).onclick = async () => {
    if (!(await confirmDialog(`לאפס את הפורטל של ${d.cust_desc || d.custname}? כל ההזמנות והסל יימחקו.`, 'איפוס', 'ביטול'))) return;
    try {
      await api.post(`/api/admin/customers/${encodeURIComponent(d.custname)}/reset-portal`, {});
      toast('הפורטל אופס ✓', 'ok'); drawer.close();
    } catch (ex) { toast(ex instanceof Error ? ex.message : 'האיפוס נכשל', 'error'); }
  };
}

// FAB → invite a NEW customer (custname not in the list yet).
function openInviteDrawer(): void {
  const body = document.createElement('div');
  body.className = 'adm-drawer-body';
  body.innerHTML = `
    <div><div class="adm-sect-label">מס׳ לקוח ב-Priority (CUSTNAME)</div><input id="ni-cust" placeholder="10024" style="width:100%"/></div>
    <div><div class="adm-sect-label">שם לתצוגה</div><input id="ni-desc" placeholder="שם החברה" style="width:100%"/></div>
    <div><div class="adm-sect-label">אימייל / טלפון (אופציונלי)</div>
      <input id="ni-email" placeholder="אימייל" style="width:100%;margin-bottom:6px"/><input id="ni-phone" placeholder="טלפון" style="width:100%"/></div>
    <div id="ni-out"></div>
    <div class="adm-drawer-foot" style="padding-inline:0"><button type="button" class="save" id="ni-create">צור קישור הזמנה</button></div>`;
  openDrawer(body, { title: 'הזמנת לקוח חדש', sub: 'הקישור יאפשר ללקוח לפתוח משתמש ראשון' });
  (body.querySelector('#ni-create') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const custname = (body.querySelector('#ni-cust') as HTMLInputElement).value.trim();
    if (!custname) { toast('יש להזין מס׳ לקוח', 'error'); return; }
    btn.disabled = true;
    try {
      const r = await api.post<{ url: string }>('/api/admin/invites', {
        custname,
        cust_desc: (body.querySelector('#ni-desc') as HTMLInputElement).value.trim(),
        email: (body.querySelector('#ni-email') as HTMLInputElement).value.trim(),
        phone: (body.querySelector('#ni-phone') as HTMLInputElement).value.trim(),
      });
      (body.querySelector('#ni-out') as HTMLElement).innerHTML = `<input readonly value="${escapeAttr(r.url)}" style="width:100%" onclick="this.select()"/>`;
      toast('קישור נוצר ✓', 'ok');
    } catch (ex) { toast(ex instanceof Error ? ex.message : 'יצירה נכשלה', 'error'); }
    btn.disabled = false;
  };
}
