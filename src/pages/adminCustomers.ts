import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';

interface AdminCustomer {
  custname: string;
  cust_desc: string | null;
  user_count: number;
  kind: string; // 'auto' | 'cash' | 'net'
  resolvedKind: string; // 'cash' | 'net'
  open_debt_threshold: number | null;
  allow_order_with_open_debt: number; // 0 or 1
  paymentTerms: string | null;
  openTotal: number | null;
}

const qs = {
  q: '',
  page: 0, // server uses 0-based offset: page * pageSize
  pageSize: 50,
};

// Inline-edit pending changes: custname → { field: value }. Saved in one batch.
const edits = new Map<string, Record<string, unknown>>();

function chipStyle(on: boolean): string {
  if (!on) return 'background:#f3f4f6;color:#9aa0a6;border-color:#e5e7eb';
  return 'background:#e7e9f5;color:#3a3f7a;border-color:#c4c8ec';
}

function setEdit(custname: string, field: string, value: unknown): void {
  const patch = edits.get(custname) || {};
  patch[field] = value;
  edits.set(custname, patch);
  refreshSaveBar();
}

function refreshSaveBar(): void {
  const bar = document.getElementById('inline-save-bar');
  if (!bar) return;
  bar.style.display = edits.size > 0 ? 'flex' : 'none';
  const count = document.getElementById('inline-save-count');
  if (count) count.textContent = String(edits.size);
}

async function saveEdits(shell: HTMLElement): Promise<void> {
  if (edits.size === 0) return;
  const items = [...edits.entries()].map(([custname, patch]) => ({ custname, ...patch }));
  const btn = shell.querySelector('#inline-save') as HTMLButtonElement | null;
  const msg = shell.querySelector('#cust-msg') as HTMLDivElement;
  if (btn) btn.disabled = true;
  msg.textContent = 'שומר…';
  msg.className = 'muted';
  try {
    const { changes } = await api.post<{ changes: number }>('/api/admin/customers/batch', { items });
    edits.clear();
    await loadList(shell); // re-render from server (clears dirty highlights + bar)
    msg.textContent = `✓ נשמרו ${changes} שינויים`;
    msg.className = 'ok';
  } catch (ex) {
    msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
    msg.className = 'error';
    if (btn) btn.disabled = false;
  }
}

export async function renderAdminCustomers(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="card" style="margin-bottom:0.75rem">
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        <input id="cust-q" placeholder="חיפוש שם לקוח / CUSTNAME" style="flex:1;min-width:240px"/>
        <button id="cust-search">חפש</button>
      </div>
      <div id="cust-msg" style="margin-top:0.25rem"></div>
    </div>

    <div id="cust-table-wrap" class="card" style="padding:0;overflow:auto"></div>
    <div id="cust-pager" style="text-align:center;margin-top:0.75rem"></div>

    <div id="inline-save-bar">
      <span><b id="inline-save-count">0</b> שינויים בטבלה</span>
      <button id="inline-save" style="background:#fff;color:var(--navy);font-weight:800">שמור שינויים</button>
      <button id="inline-cancel" class="ghost" style="color:#fff;border-color:#fff;background:transparent">בטל</button>
    </div>
  `;

  bindControls(shell);
  await loadList(shell);
}

function bindControls(shell: HTMLElement): void {
  const q = shell.querySelector('#cust-q') as HTMLInputElement;
  const searchBtn = shell.querySelector('#cust-search') as HTMLButtonElement;
  q.value = qs.q;

  const doSearch = () => {
    qs.q = q.value.trim();
    qs.page = 0;
    loadList(shell);
  };
  searchBtn.addEventListener('click', doSearch);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });

  // Inline-edit batch save / cancel
  shell.querySelector('#inline-save')?.addEventListener('click', () => saveEdits(shell));
  shell.querySelector('#inline-cancel')?.addEventListener('click', () => {
    edits.clear();
    loadList(shell); // re-render discards pending edits
  });
}

async function loadList(shell: HTMLElement): Promise<void> {
  const wrap = shell.querySelector('#cust-table-wrap') as HTMLDivElement;
  wrap.innerHTML = `<div class="muted" style="padding:1rem">טוען…</div>`;
  edits.clear(); // a (re)load discards any pending inline edits
  refreshSaveBar();
  try {
    const params = new URLSearchParams();
    if (qs.q) params.set('q', qs.q);
    params.set('page', String(qs.page));
    params.set('pageSize', String(qs.pageSize));
    const { items, total } = await api.get<{ items: AdminCustomer[]; total: number }>(
      `/api/admin/customers?${params}`
    );

    if (items.length === 0) {
      wrap.innerHTML = `<div class="muted" style="padding:1.5rem;text-align:center">לא נמצאו לקוחות</div>`;
      return;
    }

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
        <thead>
          <tr style="text-align:right;border-bottom:1px solid var(--border);background:#fafafa">
            <th style="padding:0.5rem">חברה</th>
            <th style="padding:0.5rem">משתמשים</th>
            <th style="padding:0.5rem">תנאים</th>
            <th style="padding:0.5rem">חוב</th>
            <th style="padding:0.5rem">סוג תשלום</th>
            <th style="padding:0.5rem">סף חוב</th>
            <th style="padding:0.5rem">פטור</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(renderRow).join('')}
        </tbody>
      </table>
    `;

    // Row click → navigate to customer detail (excluding editable controls)
    wrap.querySelectorAll<HTMLTableRowElement>('tr[data-cust]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('input,button,select,a')) return;
        location.hash = '#admin/customers/' + encodeURIComponent(tr.dataset.cust!);
      });
    });

    // Inline editing — kind <select>
    wrap.querySelectorAll<HTMLSelectElement>('select[data-field="kind"]').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        e.stopPropagation();
        const tr = sel.closest('tr') as HTMLTableRowElement;
        tr.classList.add('row-dirty');
        setEdit(tr.dataset.cust!, 'kind', sel.value);
        // Update the resolved-kind hint
        const hint = tr.querySelector('.kind-hint') as HTMLSpanElement | null;
        if (hint) {
          hint.textContent = sel.value === 'auto' ? `(${tr.dataset.resolvedKind ?? ''})` : '';
        }
      });
    });

    // Inline editing — open_debt_threshold <input>
    wrap.querySelectorAll<HTMLInputElement>('input[data-field="open_debt_threshold"]').forEach((inp) => {
      inp.addEventListener('input', (e) => {
        e.stopPropagation();
        const tr = inp.closest('tr') as HTMLTableRowElement;
        tr.classList.add('row-dirty');
        const value = inp.value.trim() === '' ? null : Number(inp.value);
        setEdit(tr.dataset.cust!, 'open_debt_threshold', value);
      });
    });

    // Inline editing — allow_order_with_open_debt toggle chip
    wrap.querySelectorAll<HTMLButtonElement>('button.status-toggle').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation(); // don't navigate
        const on = !(chip.dataset.on === '1');
        chip.dataset.on = on ? '1' : '';
        chip.setAttribute('style', chipStyle(on));
        const tr = chip.closest('tr') as HTMLTableRowElement;
        tr.classList.add('row-dirty');
        setEdit(tr.dataset.cust!, 'allow_order_with_open_debt', on ? 1 : 0);
      });
    });

    // Pager (server is 0-based: page=0 is the first page)
    const totalPages = Math.max(1, Math.ceil(total / qs.pageSize));
    const pager = shell.querySelector('#cust-pager') as HTMLDivElement;
    pager.innerHTML = `
      <button ${qs.page <= 0 ? 'disabled' : ''} id="prev">‹ הקודם</button>
      <span style="margin:0 1rem">עמוד ${qs.page + 1} מתוך ${totalPages} · סה״כ ${total}</span>
      <button ${qs.page >= totalPages - 1 ? 'disabled' : ''} id="next">הבא ›</button>
    `;
    (pager.querySelector('#prev') as HTMLButtonElement)?.addEventListener('click', () => {
      qs.page--;
      loadList(shell);
    });
    (pager.querySelector('#next') as HTMLButtonElement)?.addEventListener('click', () => {
      qs.page++;
      loadList(shell);
    });
  } catch (ex) {
    wrap.innerHTML = `<div class="error" style="padding:1rem">${ex instanceof Error ? ex.message : ex}</div>`;
  }
}

function renderRow(r: AdminCustomer): string {
  const cust = escapeAttr(r.custname);
  const kindHint = r.kind === 'auto'
    ? `<span class="kind-hint muted" style="font-size:0.75rem">(${escapeHtml(r.resolvedKind)})</span>`
    : `<span class="kind-hint muted" style="font-size:0.75rem"></span>`;
  const kindSel = `
    <select data-field="kind" style="font-size:0.85rem;padding:2px 4px">
      <option value="auto" ${r.kind === 'auto' ? 'selected' : ''}>auto</option>
      <option value="cash" ${r.kind === 'cash' ? 'selected' : ''}>מזומן</option>
      <option value="net" ${r.kind === 'net' ? 'selected' : ''}>שוטף</option>
    </select> ${kindHint}
  `;
  const thresholdInp = `<input class="cell-edit" data-field="open_debt_threshold" type="number" min="0" value="${r.open_debt_threshold ?? ''}" placeholder="—" style="width:80px" aria-label="סף חוב"/>`;
  const exempt = r.allow_order_with_open_debt === 1;
  const toggleChip = `<button type="button" class="status-toggle" data-on="${exempt ? '1' : ''}" style="${chipStyle(exempt)}">פטור</button>`;

  return `
    <tr data-cust="${cust}" data-resolved-kind="${escapeAttr(r.resolvedKind)}" style="border-bottom:1px solid var(--border);cursor:pointer">
      <td style="padding:0.5rem">
        <div style="font-weight:600">${escapeHtml(r.cust_desc || r.custname)}</div>
        <div class="muted" style="font-size:0.8rem">${escapeHtml(r.custname)}</div>
      </td>
      <td style="padding:0.5rem">${r.user_count}</td>
      <td style="padding:0.5rem">${escapeHtml(r.paymentTerms ?? '—')}</td>
      <td style="padding:0.5rem">${r.openTotal != null ? '₪' + r.openTotal.toLocaleString() : '—'}</td>
      <td style="padding:0.5rem;white-space:nowrap">${kindSel}</td>
      <td style="padding:0.5rem">${thresholdInp}</td>
      <td style="padding:0.5rem">${toggleChip}</td>
    </tr>
  `;
}
