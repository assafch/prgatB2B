import { api } from '../api.js';
import { escapeHtml, escapeAttr } from '../format.js';
import { toast } from '../ui.js';

interface CustomerCardUser {
  id: number;
  username: string;
  customer_role: string;
  status: string;
  last_login_at: string | null;
}

interface CustomerCardFinance {
  priorityOk: boolean;
  paymentTerms: string | null;
  openTotal: number | null;
  creditLimit: number | null;
  obligo: number | null;
}

interface CustomerCardPolicy {
  kind: string; // 'auto' | 'cash' | 'net'
  open_debt_threshold: number | null;
  allow_order_with_open_debt: boolean | number;
}

interface CustomerCard {
  custname: string;
  cust_desc: string | null;
  policy: CustomerCardPolicy;
  resolvedKind: 'cash' | 'net';
  users: CustomerCardUser[];
  finance: CustomerCardFinance;
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'אחראי';
  if (role === 'orderer') return 'מזמין';
  return escapeHtml(role);
}

function statusLabel(status: string): string {
  if (status === 'active') return '<span class="ok">פעיל</span>';
  if (status === 'inactive' || status === 'disabled') return '<span class="chip error">מושבת</span>';
  return escapeHtml(status);
}

export async function renderCustomerCard(shell: HTMLElement, custname: string): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const d = await api.get<CustomerCard>(`/api/admin/customers/${encodeURIComponent(custname)}`);
    renderCard(shell, d);
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}

function renderCard(shell: HTMLElement, d: CustomerCard): void {
  const resolvedHint =
    d.policy.kind === 'auto'
      ? `<div class="muted" style="font-size:0.85rem;margin-top:0.5rem">נגזר מ-Priority: ${escapeHtml(d.finance.paymentTerms ?? '—')} → ${d.resolvedKind === 'cash' ? 'מזומן' : 'שוטף'}</div>`
      : '';

  const financeSection = d.finance.priorityOk
    ? `
      <div style="display:flex;flex-direction:column;gap:0.4rem">
        <div><span class="muted">תנאי תשלום:</span> ${escapeHtml(d.finance.paymentTerms ?? '—')}</div>
        <div><span class="muted">חוב פתוח:</span> ${d.finance.openTotal != null ? '₪' + d.finance.openTotal.toLocaleString() : '—'}</div>
        <div><span class="muted">מסגרת אשראי:</span> ${d.finance.creditLimit != null ? '₪' + d.finance.creditLimit.toLocaleString() : '—'}</div>
      </div>`
    : `<div class="muted">נתוני Priority לא זמינים</div>`;

  const usersTableHtml =
    d.users.length === 0
      ? `<div class="muted">אין משתמשים רשומים</div>`
      : `<table style="width:100%;border-collapse:collapse;font-size:0.9rem">
          <thead>
            <tr style="text-align:right;border-bottom:1px solid var(--border);background:#fafafa">
              <th style="padding:0.4rem 0.5rem">שם משתמש</th>
              <th style="padding:0.4rem 0.5rem">תפקיד</th>
              <th style="padding:0.4rem 0.5rem">סטטוס</th>
              <th style="padding:0.4rem 0.5rem">כניסה אחרונה</th>
              <th style="padding:0.4rem 0.5rem">פעולות</th>
            </tr>
          </thead>
          <tbody>
            ${d.users
              .map(
                (u) => `
              <tr style="border-bottom:1px solid var(--border)">
                <td style="padding:0.4rem 0.5rem">${escapeHtml(u.username)}</td>
                <td style="padding:0.4rem 0.5rem">${roleLabel(u.customer_role)}</td>
                <td style="padding:0.4rem 0.5rem">${statusLabel(u.status)}</td>
                <td style="padding:0.4rem 0.5rem">${u.last_login_at ? new Date(u.last_login_at + 'Z').toLocaleString('he-IL') : '—'}</td>
                <td style="padding:0.4rem 0.5rem;white-space:nowrap">
                  ${
                    u.customer_role !== 'admin'
                      ? `<button class="ghost cc-u-reset" data-id="${u.id}" data-name="${escapeAttr(u.username)}" style="font-size:0.8rem">איפוס סיסמה</button>
                         <button class="ghost cc-u-toggle" data-id="${u.id}" data-status="${escapeAttr(u.status)}" style="font-size:0.8rem">${u.status === 'active' ? 'השבת' : 'הפעל'}</button>`
                      : '<span class="badge warn">מנהל</span>'
                  }
                </td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>`;

  const usersHtml = `
    ${usersTableHtml}
    <div id="cc-umsg" style="margin-top:0.5rem;text-align:center"></div>
    <details style="margin-top:1rem">
      <summary style="cursor:pointer;font-weight:600;color:var(--primary,#1a5eb8)">+ משתמש חדש</summary>
      <div style="margin-top:0.6rem;display:flex;flex-direction:column;gap:0.5rem">
        <div class="form-grid">
          <input id="cc-nu-username" placeholder="שם משתמש"/>
          <input id="cc-nu-password" type="password" placeholder="סיסמה (10+ תווים)"/>
          <input id="cc-nu-email" type="email" placeholder="אימייל (אופציונלי)"/>
          <input id="cc-nu-phone" placeholder="טלפון (אופציונלי)"/>
        </div>
        <button id="cc-nu-create">צור משתמש</button>
        <div id="cc-nu-msg" style="text-align:center"></div>
      </div>
    </details>`;

  shell.innerHTML = `
    <div style="margin-bottom:1rem">
      <a href="#admin/customers">‹ חזרה</a>
    </div>

    <div style="margin-bottom:1rem">
      <span style="font-weight:700;font-size:1.15rem">${escapeHtml(d.cust_desc || d.custname)}</span>
      <span class="muted" style="margin-inline-start:0.5rem">${escapeHtml(d.custname)}</span>
      <span class="muted" style="margin-inline-start:0.5rem">(${d.users.length} משתמשים)</span>
    </div>

    <div class="card" style="margin-bottom:0.75rem">
      <h2 style="margin-top:0">מדיניות תשלום</h2>
      <div style="display:flex;flex-direction:column;gap:0.75rem">
        <div>
          <label for="cc-kind" style="display:block;font-size:0.85rem;color:var(--muted,#666);margin-bottom:0.25rem">סוג תשלום</label>
          <select id="cc-kind">
            <option value="auto" ${d.policy.kind === 'auto' ? 'selected' : ''}>auto (לפי Priority)</option>
            <option value="cash" ${d.policy.kind === 'cash' ? 'selected' : ''}>מזומן</option>
            <option value="net" ${d.policy.kind === 'net' ? 'selected' : ''}>שוטף</option>
          </select>
          ${resolvedHint}
        </div>
        <div>
          <label for="cc-thr" style="display:block;font-size:0.85rem;color:var(--muted,#666);margin-bottom:0.25rem">סף חוב (₪) — חסימת הזמנות מעל סכום זה</label>
          <input id="cc-thr" type="number" min="0" placeholder="—" value="${d.policy.open_debt_threshold != null ? d.policy.open_debt_threshold : ''}" style="width:160px"/>
        </div>
        <div>
          <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
            <input type="checkbox" id="cc-exempt" ${d.policy.allow_order_with_open_debt ? 'checked' : ''}/>
            מורשה להזמין עם חוב פתוח
          </label>
        </div>
        <div>
          <button id="cc-save">שמור מדיניות</button>
          <span id="cc-msg" style="margin-inline-start:0.75rem"></span>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:0.75rem">
      <h2 style="margin-top:0">נתוני Priority</h2>
      ${financeSection}
    </div>

    <div class="card" style="margin-bottom:0.75rem">
      <h2 style="margin-top:0">משתמשי החברה</h2>
      ${usersHtml}
    </div>

    <div class="card">
      <h2 style="margin-top:0">דגלים נוספים</h2>
      <div class="muted">אין דגלים נוספים כרגע</div>
      <!-- extension point: future per-company flags go here -->
    </div>
  `;

  // Wire up save
  const kindSel = shell.querySelector('#cc-kind') as HTMLSelectElement;
  const thrInp = shell.querySelector('#cc-thr') as HTMLInputElement;
  const exemptChk = shell.querySelector('#cc-exempt') as HTMLInputElement;
  const saveBtn = shell.querySelector('#cc-save') as HTMLButtonElement;
  const msgEl = shell.querySelector('#cc-msg') as HTMLSpanElement;

  // Update auto-hint live when kind changes
  const hintEl = shell.querySelector<HTMLDivElement>('.auto-hint');
  kindSel.addEventListener('change', () => {
    if (hintEl) {
      hintEl.style.display = kindSel.value === 'auto' ? '' : 'none';
    }
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    msgEl.textContent = 'שומר…';
    msgEl.className = 'muted';
    try {
      const thrVal = thrInp.value.trim();
      await api.patch(`/api/admin/customers/${encodeURIComponent(d.custname)}`, {
        kind: kindSel.value,
        open_debt_threshold: thrVal === '' ? null : Number(thrVal),
        allow_order_with_open_debt: exemptChk.checked,
      });
      toast('המדיניות נשמרה ✓', 'ok');
      msgEl.textContent = '';
      // Re-fetch and re-render
      const fresh = await api.get<CustomerCard>(`/api/admin/customers/${encodeURIComponent(d.custname)}`);
      renderCard(shell, fresh);
    } catch (ex) {
      msgEl.textContent = `שגיאה: ${ex instanceof Error ? ex.message : String(ex)}`;
      msgEl.className = 'error';
      saveBtn.disabled = false;
    }
  });

  // --- User management ---
  const umsg = shell.querySelector('#cc-umsg') as HTMLDivElement;

  shell.querySelectorAll<HTMLButtonElement>('.cc-u-reset').forEach((b) => {
    b.onclick = async () => {
      const np = window.prompt(`סיסמה חדשה ל-${b.dataset.name} (10+ תווים):`);
      if (!np) return;
      umsg.textContent = 'מאפס…';
      umsg.className = 'muted';
      try {
        await api.post(`/api/admin/users/${b.dataset.id}/reset-password`, { new_password: np });
        toast('הסיסמה אופסה ✓ (החיבורים הקיימים נותקו)', 'ok');
        umsg.textContent = '';
      } catch (ex) {
        umsg.textContent = ex instanceof Error ? ex.message : String(ex);
        umsg.className = 'error';
      }
    };
  });

  shell.querySelectorAll<HTMLButtonElement>('.cc-u-toggle').forEach((b) => {
    b.onclick = async () => {
      const next = b.dataset.status === 'active' ? 'disabled' : 'active';
      umsg.textContent = 'מעדכן…';
      umsg.className = 'muted';
      try {
        await api.post(`/api/admin/users/${b.dataset.id}/status`, { status: next });
        const fresh = await api.get<CustomerCard>(`/api/admin/customers/${encodeURIComponent(d.custname)}`);
        renderCard(shell, fresh);
      } catch (ex) {
        umsg.textContent = ex instanceof Error ? ex.message : String(ex);
        umsg.className = 'error';
      }
    };
  });

  const nuCreate = shell.querySelector('#cc-nu-create') as HTMLButtonElement | null;
  const nuMsg = shell.querySelector('#cc-nu-msg') as HTMLDivElement | null;
  if (nuCreate && nuMsg) {
    nuCreate.onclick = async () => {
      nuCreate.disabled = true;
      nuMsg.textContent = 'יוצר…';
      nuMsg.className = 'muted';
      try {
        await api.post('/api/admin/users', {
          username: (shell.querySelector('#cc-nu-username') as HTMLInputElement).value.trim(),
          password: (shell.querySelector('#cc-nu-password') as HTMLInputElement).value,
          custname: d.custname,
          cust_desc: d.cust_desc ?? '',
        });
        toast('המשתמש נוצר ✓', 'ok');
        const fresh = await api.get<CustomerCard>(`/api/admin/customers/${encodeURIComponent(d.custname)}`);
        renderCard(shell, fresh);
      } catch (ex) {
        nuMsg.textContent = ex instanceof Error ? ex.message : String(ex);
        nuMsg.className = 'error';
        nuCreate.disabled = false;
      }
    };
  }
}
