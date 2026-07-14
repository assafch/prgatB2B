import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';

interface AdminProduct {
  partname: string;
  partdes: string | null;
  family: string | null;
  family_desc: string | null;
  barcode: string | null;
  list_price: number | null;
  box_size: number;
  active: number;
  b2b_visible: number;
  b2b_partdes_override: string | null;
  b2b_description: string | null;
  b2b_image_path: string | null;
  b2b_tags: string | null;
  b2b_min_qty: number | null;
  b2b_sort_priority: number;
  b2b_featured: number;
  b2b_category_override: string | null;
  b2b_out_of_stock: number;
  b2b_is_new: number;
  updated_at: string;
  alert_count: number;
}

interface Family {
  family: string;
  family_desc: string | null;
  count: number;
}

const qs = {
  q: '',
  family: '',
  status: 'all',
  page: 1,
  pageSize: 50,
};

const selection = new Set<string>();
// Inline-edit pending changes: partname → { field: value }. Saved in one batch.
const edits = new Map<string, Record<string, unknown>>();

// Pill colors for a status toggle, per field + on/off. Inline so a toggle can
// restyle itself without a stylesheet round-trip.
function chipStyle(field: string, on: boolean): string {
  if (!on) return 'background:#f3f4f6;color:#9aa0a6;border-color:#e5e7eb';
  if (field === 'b2b_out_of_stock') return 'background:#ffe3e3;color:#c0341e;border-color:#f3b0a8';
  if (field === 'b2b_featured') return 'background:#ffeed1;color:#9c5500;border-color:#e8c98f';
  if (field === 'b2b_is_new') return 'background:#dcfce7;color:#15803d;border-color:#86efac';
  return 'background:#e7e9f5;color:#3a3f7a;border-color:#c4c8ec'; // מוסתר (b2b_visible inverted)
}
function statusToggle(part: string, label: string, on: boolean, field: string, invert = false): string {
  return `<button type="button" class="status-toggle" data-part="${escapeAttr(part)}" data-field="${field}"${invert ? ' data-invert="1"' : ''} data-on="${on ? '1' : ''}" style="${chipStyle(field, on)}">${label}</button>`;
}

function setEdit(part: string, field: string, value: unknown): void {
  const patch = edits.get(part) || {};
  patch[field] = value;
  edits.set(part, patch);
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
  const items = [...edits.entries()].map(([partname, patch]) => ({ partname, ...patch }));
  const btn = shell.querySelector('#inline-save') as HTMLButtonElement | null;
  const msg = shell.querySelector('#bulk-msg') as HTMLDivElement;
  if (btn) btn.disabled = true;
  msg.textContent = 'שומר…';
  msg.className = 'muted';
  try {
    const { changes } = await api.post<{ changes: number }>('/api/admin/products/batch', { items });
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

export async function renderAdminProducts(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="card" style="margin-bottom:0.75rem">
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">
        <input id="prod-q" placeholder="חיפוש שם / מק״ט / ברקוד / תגית" style="flex:1;min-width:240px"/>
        <select id="prod-family" style="width:auto"><option value="">כל המשפחות</option></select>
        <select id="prod-status" style="width:auto">
          <option value="all">כל הסטטוסים</option>
          <option value="visible">מוצגים</option>
          <option value="hidden">מוסתרים</option>
          <option value="no_image">ללא תמונה</option>
          <option value="inactive">לא פעיל ב-Priority</option>
        </select>
        <button id="prod-search">חפש</button>
      </div>
      <div style="display:flex;gap:0.5rem;margin-top:0.5rem;align-items:center;flex-wrap:wrap">
        <span id="prod-selection-info" class="muted">לא נבחרו פריטים</span>
        <div id="bulk-actions" style="display:none;gap:0.5rem;flex-wrap:wrap">
          <button class="ghost" data-bulk="hide">הסתר</button>
          <button class="ghost" data-bulk="show">הצג</button>
          <button class="ghost" data-bulk="feature">סמן כמומלצים</button>
          <button class="ghost" data-bulk="unfeature">בטל מומלצים</button>
          <button class="ghost" data-bulk="mark_out_of_stock">סמן כאזל מהמלאי</button>
          <button class="ghost" data-bulk="mark_in_stock">סמן כקיים במלאי</button>
          <button class="ghost" data-bulk="mark_new">סמן כחדשים</button>
          <button class="ghost" data-bulk="unmark_new">בטל חדשים</button>
          <button class="ghost" data-bulk="set_box_size">עדכן גודל ארגז…</button>
          <button class="ghost" data-bulk="set_min_qty">עדכן מינ׳ הזמנה…</button>
        </div>
        <div style="margin-inline-start:auto;display:flex;gap:0.5rem;flex-wrap:wrap">
          <button class="ghost" id="export-csv">⬇ ייצוא CSV</button>
          <label class="ghost" style="display:inline-block;padding:0.55rem 1rem;border:1px solid var(--brand);color:var(--brand);border-radius:10px;cursor:pointer">
            ⬆ ייבוא CSV
            <input type="file" id="import-csv" accept=".csv,text/csv" style="display:none"/>
          </label>
        </div>
      </div>
      <div id="bulk-msg" style="margin-top:0.25rem"></div>
    </div>

    <div id="prod-table-wrap" class="card" style="padding:0;overflow:auto"></div>
    <div id="prod-pager" style="text-align:center;margin-top:0.75rem"></div>

    <div id="prod-drawer" style="position:fixed;top:0;left:0;height:100vh;width:min(520px,95vw);background:var(--surface);border-inline-end:1px solid var(--border);box-shadow:2px 0 8px rgba(0,0,0,0.12);transform:translateX(-100%);transition:transform 0.18s;z-index:50;overflow-y:auto;padding:1rem"></div>
    <div id="prod-drawer-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,0.3);display:none;z-index:40"></div>

    <div id="inline-save-bar">
      <span><b id="inline-save-count">0</b> שינויים בטבלה</span>
      <button id="inline-save" style="background:#fff;color:var(--navy);font-weight:800">שמור שינויים</button>
      <button id="inline-cancel" class="ghost" style="color:#fff;border-color:#fff;background:transparent">בטל</button>
    </div>
  `;

  bindControls(shell);
  await loadFamilies(shell);
  await loadList(shell);
}

function bindControls(shell: HTMLElement): void {
  const search = shell.querySelector('#prod-search') as HTMLButtonElement;
  const q = shell.querySelector('#prod-q') as HTMLInputElement;
  const fam = shell.querySelector('#prod-family') as HTMLSelectElement;
  const status = shell.querySelector('#prod-status') as HTMLSelectElement;
  q.value = qs.q;
  fam.value = qs.family;
  status.value = qs.status;

  const doSearch = () => {
    qs.q = q.value.trim();
    qs.family = fam.value;
    qs.status = status.value;
    qs.page = 1;
    selection.clear();
    loadList(shell);
  };
  search.addEventListener('click', doSearch);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch();
  });
  fam.addEventListener('change', doSearch);
  status.addEventListener('change', doSearch);

  // Bulk actions
  shell.querySelectorAll<HTMLButtonElement>('button[data-bulk]').forEach((btn) => {
    btn.addEventListener('click', () => doBulk(shell, btn.dataset.bulk!));
  });

  // CSV
  (shell.querySelector('#export-csv') as HTMLButtonElement).addEventListener('click', () => {
    window.location.href = '/api/admin/products/export.csv';
  });
  (shell.querySelector('#import-csv') as HTMLInputElement).addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await doImport(shell, file);
    input.value = '';
  });

  // Drawer close on backdrop
  (shell.querySelector('#prod-drawer-backdrop') as HTMLDivElement).addEventListener('click', () =>
    closeDrawer(shell)
  );

  // Inline-edit batch save / cancel
  shell.querySelector('#inline-save')?.addEventListener('click', () => saveEdits(shell));
  shell.querySelector('#inline-cancel')?.addEventListener('click', () => {
    edits.clear();
    loadList(shell); // re-render discards pending edits
  });
}

async function loadFamilies(shell: HTMLElement): Promise<void> {
  try {
    // Reuse the public-facing families endpoint (only visible families).
    // For admin we also want hidden ones; for now show what's visible.
    const { families } = await api.get<{ families: Family[] }>('/api/catalog/families').catch(() => ({ families: [] as Family[] }));
    const sel = shell.querySelector('#prod-family') as HTMLSelectElement;
    for (const f of families) {
      const opt = document.createElement('option');
      opt.value = f.family;
      opt.textContent = `${f.family_desc || f.family} (${f.count})`;
      sel.appendChild(opt);
    }
    sel.value = qs.family;
  } catch {
    /* ignore */
  }
}

async function loadList(shell: HTMLElement): Promise<void> {
  const wrap = shell.querySelector('#prod-table-wrap') as HTMLDivElement;
  wrap.innerHTML = `<div class="muted" style="padding:1rem">טוען…</div>`;
  edits.clear(); // a (re)load discards any pending inline edits
  refreshSaveBar();
  try {
    const params = new URLSearchParams();
    if (qs.q) params.set('q', qs.q);
    if (qs.family) params.set('family', qs.family);
    if (qs.status) params.set('status', qs.status);
    params.set('page', String(qs.page));
    params.set('pageSize', String(qs.pageSize));
    const { items, total } = await api.get<{ items: AdminProduct[]; total: number }>(
      `/api/admin/products?${params}`
    );

    if (items.length === 0) {
      wrap.innerHTML = `<div class="muted" style="padding:1.5rem;text-align:center">לא נמצאו מוצרים</div>`;
      return;
    }

    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.9rem">
        <thead>
          <tr style="text-align:right;border-bottom:1px solid var(--border);background:#fafafa">
            <th style="padding:0.5rem;width:32px"><input type="checkbox" id="select-all"/></th>
            <th style="padding:0.5rem;width:54px">תמונה</th>
            <th style="padding:0.5rem">מק״ט / שם</th>
            <th style="padding:0.5rem">משפחה</th>
            <th style="padding:0.5rem">מחיר</th>
            <th style="padding:0.5rem">ארגז</th>
            <th style="padding:0.5rem">מינ׳</th>
            <th style="padding:0.5rem">סטטוס</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(renderRow).join('')}
        </tbody>
      </table>
    `;

    // Row click → drawer
    wrap.querySelectorAll<HTMLTableRowElement>('tr[data-part]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('input,button,a')) return;
        openDrawer(shell, tr.dataset.part!);
      });
    });

    // Selection checkboxes
    const selectAll = wrap.querySelector('#select-all') as HTMLInputElement;
    selectAll.addEventListener('change', () => {
      const checked = selectAll.checked;
      wrap.querySelectorAll<HTMLInputElement>('input.row-check').forEach((cb) => {
        cb.checked = checked;
        if (checked) selection.add(cb.dataset.part!);
        else selection.delete(cb.dataset.part!);
      });
      updateSelectionInfo(shell);
    });
    wrap.querySelectorAll<HTMLInputElement>('input.row-check').forEach((cb) => {
      cb.checked = selection.has(cb.dataset.part!);
      cb.addEventListener('change', () => {
        if (cb.checked) selection.add(cb.dataset.part!);
        else selection.delete(cb.dataset.part!);
        updateSelectionInfo(shell);
      });
    });
    updateSelectionInfo(shell);

    // Inline editing — number cells (ארגז / מינ׳)
    wrap.querySelectorAll<HTMLInputElement>('input.cell-edit').forEach((inp) => {
      inp.addEventListener('input', () => {
        const field = inp.dataset.field!;
        let value: unknown;
        if (field === 'b2b_min_qty') {
          value = inp.value.trim() === '' ? null : Number(inp.value); // empty → clear override
        } else {
          const n = Number(inp.value); // box_size — ignore invalid
          if (!isFinite(n) || n < 1) return;
          value = n;
        }
        inp.closest('tr')?.classList.add('row-dirty');
        setEdit(inp.dataset.part!, field, value);
      });
    });

    // Inline editing — status toggle chips (מוסתר / אזל / מומלץ)
    wrap.querySelectorAll<HTMLButtonElement>('button.status-toggle').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation(); // don't open the drawer
        const field = chip.dataset.field!;
        const invert = chip.dataset.invert === '1';
        const on = !(chip.dataset.on === '1');
        chip.dataset.on = on ? '1' : '';
        chip.setAttribute('style', chipStyle(field, on));
        chip.closest('tr')?.classList.add('row-dirty');
        setEdit(chip.dataset.part!, field, invert ? !on : on); // מוסתר on → b2b_visible false
      });
    });

    // Pager
    const totalPages = Math.max(1, Math.ceil(total / qs.pageSize));
    const pager = shell.querySelector('#prod-pager') as HTMLDivElement;
    pager.innerHTML = `
      <button ${qs.page <= 1 ? 'disabled' : ''} id="prev">‹ הקודם</button>
      <span style="margin:0 1rem">עמוד ${qs.page} מתוך ${totalPages} · סה״כ ${total}</span>
      <button ${qs.page >= totalPages ? 'disabled' : ''} id="next">הבא ›</button>
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

function renderRow(p: AdminProduct): string {
  const displayName = p.b2b_partdes_override || p.partdes || p.partname;
  const imageThumb = p.b2b_image_path
    ? `<img src="${p.b2b_image_path}" alt="" style="width:42px;height:42px;object-fit:cover;border-radius:4px"/>`
    : `<div style="width:42px;height:42px;background:#f3f4f6;border-radius:4px;display:grid;place-items:center;color:#9ca3af;font-size:0.7rem">—</div>`;
  const part = escapeAttr(p.partname);
  // "לא פעיל" is Priority-sourced → read-only badge. The other three are editable
  // toggle chips. "מוסתר" is the inverse of b2b_visible.
  const inactive = p.active ? '' : '<span style="background:#fee;color:#c33;padding:1px 6px;border-radius:4px;font-size:0.75rem">לא פעיל</span> ';
  const toggles =
    statusToggle(p.partname, 'מוסתר', !p.b2b_visible, 'b2b_visible', true) +
    ' ' +
    statusToggle(p.partname, 'אזל', !!p.b2b_out_of_stock, 'b2b_out_of_stock') +
    ' ' +
    statusToggle(p.partname, '⭐', !!p.b2b_featured, 'b2b_featured') +
    ' ' +
    statusToggle(p.partname, 'חדש', !!p.b2b_is_new, 'b2b_is_new');
  const waitChip = p.alert_count > 0
    ? ` <span style="background:#eef;color:#33c;padding:1px 6px;border-radius:4px;font-size:0.75rem">🔔 ${p.alert_count} ממתינים</span>`
    : '';
  return `
    <tr data-part="${part}" style="border-bottom:1px solid var(--border);cursor:pointer">
      <td style="padding:0.5rem"><input type="checkbox" class="row-check" data-part="${part}"/></td>
      <td style="padding:0.25rem 0.5rem">${imageThumb}</td>
      <td style="padding:0.5rem">
        <div>${escapeHtml(displayName)}</div>
        <div class="muted" style="font-size:0.8rem">${p.partname}${p.barcode ? ` · ${p.barcode}` : ''}</div>
      </td>
      <td style="padding:0.5rem">${escapeHtml(p.family_desc || p.family || '-')}</td>
      <td style="padding:0.5rem">${p.list_price != null ? `₪${p.list_price.toFixed(2)}` : '-'}</td>
      <td style="padding:0.5rem"><input class="cell-edit" type="number" min="1" step="1" value="${p.box_size}" data-part="${part}" data-field="box_size" aria-label="ארגז"/></td>
      <td style="padding:0.5rem"><input class="cell-edit" type="number" min="0" step="1" value="${p.b2b_min_qty ?? ''}" placeholder="${p.box_size}" data-part="${part}" data-field="b2b_min_qty" aria-label="מינ׳ הזמנה"/></td>
      <td style="padding:0.5rem;white-space:nowrap">${inactive}${toggles}${waitChip}</td>
    </tr>
  `;
}

function updateSelectionInfo(shell: HTMLElement): void {
  const info = shell.querySelector('#prod-selection-info') as HTMLSpanElement;
  const bulk = shell.querySelector('#bulk-actions') as HTMLDivElement;
  if (selection.size === 0) {
    info.textContent = 'לא נבחרו פריטים';
    bulk.style.display = 'none';
  } else {
    info.textContent = `${selection.size} נבחרו`;
    bulk.style.display = 'flex';
  }
}

async function doBulk(shell: HTMLElement, action: string): Promise<void> {
  if (selection.size === 0) return;
  let value: number | undefined;
  if (action === 'set_box_size' || action === 'set_min_qty') {
    const v = prompt(action === 'set_box_size' ? 'גודל ארגז חדש:' : 'מינ׳ הזמנה חדש:', '12');
    if (!v) return;
    value = Number(v);
    if (!isFinite(value)) return;
  }
  const msg = shell.querySelector('#bulk-msg') as HTMLDivElement;
  msg.textContent = 'מעדכן…';
  msg.className = 'muted';
  try {
    const { changes } = await api.post<{ changes: number }>('/api/admin/products/bulk', {
      partnames: Array.from(selection),
      action,
      value,
    });
    msg.textContent = `✓ עודכנו ${changes} מוצרים`;
    msg.className = 'ok';
    selection.clear();
    await loadList(shell);
  } catch (ex) {
    msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
    msg.className = 'error';
  }
}

async function doImport(shell: HTMLElement, file: File): Promise<void> {
  const msg = shell.querySelector('#bulk-msg') as HTMLDivElement;
  // Step 1 — dry run
  const fd = new FormData();
  fd.append('file', file);
  msg.textContent = 'מנתח קובץ…';
  msg.className = 'muted';
  let dryRun: { updated: number; skipped: number; errors: string[] };
  try {
    const res = await fetch('/api/admin/products/import.csv?dryRun=true', {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
    dryRun = body;
  } catch (ex) {
    msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
    msg.className = 'error';
    return;
  }
  const confirmMsg =
    `יבוצעו עדכונים על ${dryRun.updated} מוצרים, ${dryRun.skipped} ידולגו.` +
    (dryRun.errors.length ? `\nאזהרות: ${dryRun.errors.length}` : '') +
    `\nלבצע?`;
  if (!confirm(confirmMsg)) {
    msg.textContent = 'בוטל';
    msg.className = 'muted';
    return;
  }
  // Step 2 — real
  const fd2 = new FormData();
  fd2.append('file', file);
  const res = await fetch('/api/admin/products/import.csv?dryRun=false', {
    method: 'POST',
    body: fd2,
    credentials: 'include',
  });
  const real = await res.json();
  if (!res.ok) {
    msg.textContent = `שגיאה: ${real?.error || `HTTP ${res.status}`}`;
    msg.className = 'error';
    return;
  }
  msg.textContent = `✓ ייבוא הושלם: ${real.updated} עודכנו, ${real.skipped} דולגו`;
  msg.className = 'ok';
  await loadList(shell);
}

async function openDrawer(shell: HTMLElement, partname: string): Promise<void> {
  const drawer = shell.querySelector('#prod-drawer') as HTMLDivElement;
  const backdrop = shell.querySelector('#prod-drawer-backdrop') as HTMLDivElement;
  drawer.innerHTML = `<div class="muted">טוען…</div>`;
  drawer.style.transform = 'translateX(0)';
  backdrop.style.display = 'block';
  try {
    const p = await api.get<AdminProduct>(`/api/admin/products/${encodeURIComponent(partname)}`);
    drawer.innerHTML = `
      <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:1rem">
        <h2 style="margin:0;flex:1">עריכת מוצר</h2>
        <button class="ghost" id="drawer-close">✕</button>
      </div>
      <div class="muted" style="margin-bottom:0.75rem">${p.partname}${p.barcode ? ` · ${p.barcode}` : ''}</div>

      <div style="margin-bottom:1rem">
        <label>תמונה</label>
        <div id="image-zone" style="border:1px dashed var(--border);border-radius:8px;padding:1rem;text-align:center;cursor:pointer">
          ${
            p.b2b_image_path
              ? `<img src="${p.b2b_image_path}" style="max-width:100%;max-height:200px;border-radius:4px"/>
                 <div style="margin-top:0.5rem"><button class="ghost" id="image-delete">מחק תמונה</button></div>`
              : '<div class="muted">גרור קובץ או לחץ להעלאה<br/>(JPG / PNG / WEBP, עד 4MB)</div>'
          }
          <input type="file" id="image-input" accept="image/*" style="display:none"/>
        </div>
      </div>

      <form id="prod-form" style="display:flex;flex-direction:column;gap:0.75rem">
        <div>
          <label>שם תצוגה ל-B2B (אופציונלי)</label>
          <input name="b2b_partdes_override" value="${escapeAttr(p.b2b_partdes_override || '')}" placeholder="${escapeAttr(p.partdes || '')}"/>
        </div>
        <div>
          <label>תיאור מורחב</label>
          <textarea name="b2b_description" rows="3">${escapeHtml(p.b2b_description || '')}</textarea>
        </div>
        <div>
          <label>מילות חיפוש נוספות (מופרדות בפסיק)</label>
          <input name="b2b_tags" value="${escapeAttr(p.b2b_tags || '')}"/>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
          <div>
            <label>גודל ארגז</label>
            <input name="box_size" type="number" min="1" value="${p.box_size}"/>
          </div>
          <div>
            <label>מינ׳ הזמנה</label>
            <input name="b2b_min_qty" type="number" min="0" value="${p.b2b_min_qty ?? ''}" placeholder="${p.box_size}"/>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
          <div>
            <label>עדיפות סדר</label>
            <input name="b2b_sort_priority" type="number" value="${p.b2b_sort_priority}"/>
          </div>
          <div>
            <label>קטגוריה מותאמת</label>
            <input name="b2b_category_override" value="${escapeAttr(p.b2b_category_override || '')}" placeholder="${escapeAttr(p.family || '')}"/>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
          <input type="checkbox" name="b2b_visible" ${p.b2b_visible ? 'checked' : ''}/> מוצג בקטלוג ללקוחות
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
          <input type="checkbox" name="b2b_featured" ${p.b2b_featured ? 'checked' : ''}/> ⭐ מומלץ (קופץ קדימה)
        </label>
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
          <input type="checkbox" name="b2b_out_of_stock" ${p.b2b_out_of_stock ? 'checked' : ''}/> 🚫 אזל מהמלאי (לא ניתן להזמנה)
        </label>
        ${p.b2b_out_of_stock && p.alert_count > 0 ? '<div id="alert-waiters" class="muted" style="font-size:0.8rem">טוען ממתינים…</div>' : ''}
        <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">
          <input type="checkbox" name="b2b_is_new" ${p.b2b_is_new ? 'checked' : ''}/> ✨ מוצר חדש (מופיע במסך הבית)
        </label>
        <div style="display:flex;gap:0.5rem;margin-top:0.5rem">
          <button type="submit">שמור</button>
          <button type="button" class="ghost" id="drawer-cancel">סגור</button>
        </div>
        <div id="drawer-msg" style="margin-top:0.25rem"></div>
      </form>
    `;

    (drawer.querySelector('#drawer-close') as HTMLButtonElement).addEventListener('click', () =>
      closeDrawer(shell)
    );
    (drawer.querySelector('#drawer-cancel') as HTMLButtonElement).addEventListener('click', () =>
      closeDrawer(shell)
    );

    // Back-in-stock waiters list (only rendered when OOS + there are waiters)
    const waitersEl = drawer.querySelector<HTMLElement>('#alert-waiters');
    if (waitersEl) {
      api.get<{ waiters: Array<{ username: string; cust_desc: string | null; custname: string | null }> }>(
        `/api/admin/stock-alerts/${encodeURIComponent(p.partname)}`
      ).then((r) => {
        waitersEl.textContent = r.waiters.length
          ? 'ממתינים: ' + r.waiters.map((w) => w.cust_desc || w.custname || w.username).join(', ')
          : '';
      }).catch(() => { waitersEl.textContent = ''; });
    }

    // Image upload
    const imgZone = drawer.querySelector('#image-zone') as HTMLDivElement;
    const imgInput = drawer.querySelector('#image-input') as HTMLInputElement;
    imgZone.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      imgInput.click();
    });
    imgZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      imgZone.style.background = '#f3f4f6';
    });
    imgZone.addEventListener('dragleave', () => (imgZone.style.background = ''));
    imgZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      imgZone.style.background = '';
      const file = e.dataTransfer?.files[0];
      if (file) await uploadImage(shell, p.partname, file);
    });
    imgInput.addEventListener('change', async () => {
      const file = imgInput.files?.[0];
      if (file) await uploadImage(shell, p.partname, file);
    });
    const delBtn = drawer.querySelector('#image-delete') as HTMLButtonElement | null;
    delBtn?.addEventListener('click', async () => {
      if (!confirm('למחוק את התמונה?')) return;
      await api.del(`/api/admin/products/${encodeURIComponent(p.partname)}/image`);
      await openDrawer(shell, p.partname);
      await loadList(shell);
    });

    // Save
    const form = drawer.querySelector('#prod-form') as HTMLFormElement;
    const msg = drawer.querySelector('#drawer-msg') as HTMLDivElement;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const patch: Record<string, unknown> = {
        b2b_partdes_override: String(fd.get('b2b_partdes_override') || ''),
        b2b_description: String(fd.get('b2b_description') || ''),
        b2b_tags: String(fd.get('b2b_tags') || ''),
        box_size: Number(fd.get('box_size')),
        b2b_min_qty: fd.get('b2b_min_qty') ? Number(fd.get('b2b_min_qty')) : null,
        b2b_sort_priority: Number(fd.get('b2b_sort_priority') || 0),
        b2b_category_override: String(fd.get('b2b_category_override') || ''),
        b2b_visible: fd.get('b2b_visible') === 'on',
        b2b_featured: fd.get('b2b_featured') === 'on',
        b2b_out_of_stock: fd.get('b2b_out_of_stock') === 'on',
        b2b_is_new: fd.get('b2b_is_new') === 'on',
      };
      try {
        await api.patch(`/api/admin/products/${encodeURIComponent(p.partname)}`, patch);
        msg.textContent = '✓ נשמר';
        msg.className = 'ok';
        await loadList(shell);
      } catch (ex) {
        msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
        msg.className = 'error';
      }
    });
  } catch (ex) {
    drawer.innerHTML = `<div class="error">${ex instanceof Error ? ex.message : ex}</div>`;
  }
}

async function uploadImage(shell: HTMLElement, partname: string, file: File): Promise<void> {
  const drawer = shell.querySelector('#prod-drawer') as HTMLDivElement;
  const zone = drawer.querySelector('#image-zone') as HTMLDivElement;
  zone.innerHTML = '<div class="muted">מעלה…</div>';
  const fd = new FormData();
  fd.append('image', file);
  try {
    const res = await fetch(`/api/admin/products/${encodeURIComponent(partname)}/image`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    if (!res.ok) throw new Error(await res.text());
    await openDrawer(shell, partname);
    await loadList(shell);
  } catch (ex) {
    zone.innerHTML = `<div class="error">שגיאה: ${ex instanceof Error ? ex.message : ex}</div>`;
  }
}

function closeDrawer(shell: HTMLElement): void {
  const drawer = shell.querySelector('#prod-drawer') as HTMLDivElement;
  const backdrop = shell.querySelector('#prod-drawer-backdrop') as HTMLDivElement;
  drawer.style.transform = 'translateX(-100%)';
  backdrop.style.display = 'none';
}

