// Promotions board — the "רשימה + מגירה" template (Stage 8b), same pattern as
// src/pages/adminCustomers.ts. Row click → drawer (details, active toggle, danger
// zone). FAB → creation drawer (the old full-page form, re-parented unchanged).
import { api } from '../api.js';
import { escapeAttr, escapeHtml, formatDate } from '../format.js';
import { confirmDialog, openDrawer, toast } from '../ui.js';

interface Promo {
  id: number;
  name: string;
  type: string;
  params: Record<string, unknown>;
  active: boolean;
  priority: number;
  startsAt: string | null;
  endsAt: string | null;
}

const TYPE_HE: Record<string, string> = { percent: 'אחוז הנחה', fixed: 'הנחה בש"ח', bogo: '1+1 / קנה-קבל', gift: 'מתנה (סכום/כמות)' };

function describe(p: Promo): string {
  const x = p.params;
  if (p.type === 'percent') return `${x.percent}% הנחה על ${x.scope === 'order' ? 'כל ההזמנה' : x.scope === 'family' ? 'משפחה ' + x.target : 'מק"ט ' + x.target}${x.minSubtotal ? ` (מעל ₪${x.minSubtotal})` : ''}`;
  if (p.type === 'fixed') return `₪${x.amount} הנחה על ${x.scope === 'order' ? 'כל ההזמנה' : x.scope === 'family' ? 'משפחה ' + x.target : 'מק"ט ' + x.target}${x.minSubtotal ? ` (מעל ₪${x.minSubtotal})` : ''}`;
  if (p.type === 'bogo') return `קנה ${x.buy} קבל ${x.free} חינם · מק"ט ${x.partname}`;
  if (p.type === 'gift') return x.condPartname ? `כל ${x.condQty} יח׳ ${x.condPartname} → מתנה ${x.giftPartname} ×${x.giftQty}` : `מעל ₪${x.minSubtotal} → מתנה ${x.giftPartname} ×${x.giftQty}`;
  return JSON.stringify(x);
}

export async function renderPromotionsAdmin(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="adm-head">
      <h1 class="adm-title">מבצעים</h1><span class="adm-meta" id="promo-count"></span>
    </div>
    <div id="promo-list" class="adm-card" style="padding:0;overflow:hidden"></div>
    <button type="button" id="promo-fab" class="adm-fab" aria-label="מבצע חדש">+</button>`;
  (shell.querySelector('#promo-fab') as HTMLButtonElement).onclick = () => openPromoFormDrawer(shell);
  await loadPromoList(shell);
}

async function loadPromoList(shell: HTMLElement): Promise<void> {
  const wrap = shell.querySelector('#promo-list') as HTMLElement;
  wrap.innerHTML = `<div class="adm-empty">טוען…</div>`;
  try {
    const promos = (await api.get<{ promotions: Promo[] }>('/api/admin/promotions')).promotions;
    (shell.querySelector('#promo-count') as HTMLElement).textContent = promos.length ? `${promos.length} מבצעים` : '';

    if (promos.length === 0) {
      wrap.innerHTML = `
        <div class="adm-empty">מבצעים שתגדיר יופיעו כאן ויוצגו ללקוחות בקטלוג ובעגלה<br/>
          <button type="button" id="promo-empty-cta" class="adm-btn-ghost" style="margin-top:10px">+ מבצע חדש</button>
        </div>`;
      (wrap.querySelector('#promo-empty-cta') as HTMLButtonElement).onclick = () => openPromoFormDrawer(shell);
      return;
    }

    wrap.innerHTML = promos
      .map(
        (p) => `
      <div class="promo-row" data-id="${p.id}">
        <div class="promo-row-main">
          <div class="promo-row-name">${escapeHtml(p.name)} <span class="cust-pill ${p.active ? 'pill-on' : 'pill-off'}">${p.active ? 'פעיל' : 'כבוי'}</span></div>
          <div class="promo-row-desc">${escapeHtml(describe(p))}${p.endsAt ? ' · עד ' + escapeHtml(formatDate(p.endsAt)) : ''}</div>
        </div>
        <span class="cust-chev">‹</span>
      </div>`
      )
      .join('');

    wrap.querySelectorAll<HTMLElement>('.promo-row').forEach((row) => {
      row.addEventListener('click', () => {
        const p = promos.find((x) => String(x.id) === row.dataset.id);
        if (p) void openPromoDrawer(p, shell);
      });
    });
  } catch (ex) {
    wrap.innerHTML = `<div class="adm-empty error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}

// ---- The drawer: details · active toggle (PATCHes immediately) · danger zone ----
async function openPromoDrawer(p: Promo, shell: HTMLElement): Promise<void> {
  const body = document.createElement('div');
  body.className = 'adm-drawer-body';
  const validity = [p.startsAt ? 'מ-' + formatDate(p.startsAt) : '', p.endsAt ? 'עד ' + formatDate(p.endsAt) : ''].filter(Boolean).join(' · ') || 'ללא הגבלת תאריכים';
  body.innerHTML = `
    <div>
      <div class="adm-sect-label">פירוט</div>
      <div style="font-size:13px">${escapeHtml(describe(p))}</div>
    </div>
    <div>
      <div class="adm-sect-label">תוקף</div>
      <div class="muted" style="font-size:13px">${escapeHtml(validity)}</div>
    </div>
    <div>
      <div class="adm-sect-label">סטטוס</div>
      <label class="adm-toggle-line"><button type="button" id="pd-active" class="adm-toggle ${p.active ? 'on' : ''}"></button>מבצע פעיל</label>
    </div>
    <button type="button" id="pd-edit" class="adm-btn-ghost" style="width:100%">✏️ עריכת המבצע (תנאים, כותרת, תמונה)</button>
    <details class="adm-danger"><summary>אזור מסוכן ▾</summary>
      <button type="button" id="pd-delete" class="adm-btn-ghost" style="margin-top:8px;color:var(--err);border-color:#f0c9c5">מחיקת המבצע</button>
    </details>`;

  const drawer = openDrawer(body, {
    title: p.name,
    sub: escapeHtml(TYPE_HE[p.type] || p.type),
  });

  (body.querySelector('#pd-edit') as HTMLButtonElement).onclick = () => {
    drawer.close();
    openPromoFormDrawer(shell, p);
  };

  (body.querySelector('#pd-active') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const nextActive = !btn.classList.contains('on');
    btn.disabled = true;
    try {
      await api.patch(`/api/admin/promotions/${p.id}`, { active: nextActive });
      btn.classList.toggle('on', nextActive);
      p.active = nextActive;
      toast(nextActive ? 'המבצע הופעל ✓' : 'המבצע כובה ✓', 'ok');
      void loadPromoList(shell);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'העדכון נכשל', 'error');
    }
    btn.disabled = false;
  };

  (body.querySelector('#pd-delete') as HTMLButtonElement).onclick = async () => {
    if (!(await confirmDialog(`למחוק את המבצע "${p.name}"? הפעולה בלתי הפיכה.`, 'מחיקה', 'ביטול'))) return;
    try {
      await api.del(`/api/admin/promotions/${p.id}`);
      toast('המבצע נמחק ✓', 'ok');
      drawer.close();
      void loadPromoList(shell);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'המחיקה נכשלה', 'error');
    }
  };
}

// FAB / "עריכה" → one shared form drawer. Without `existing` it creates (POST);
// with it, every field is prefilled and saving PATCHes the same id.
function openPromoFormDrawer(shell: HTMLElement, existing?: Promo): void {
  const isEdit = !!existing;
  const x = (existing?.params || {}) as Record<string, unknown>;
  let imgUrl = String(x.imageUrl || '');

  const body = document.createElement('div');
  body.className = 'adm-drawer-body';
  body.innerHTML = `
    <div><div class="adm-sect-label">שם המבצע</div><input id="pm-name" placeholder="שם פנימי (וגם כותרת ברירת המחדל)" style="width:100%"/></div>
    <div><div class="adm-sect-label">סוג מבצע</div>
      <select id="pm-type" style="width:100%">
        <option value="percent">אחוז הנחה</option>
        <option value="fixed">הנחה בש"ח</option>
        <option value="bogo">1+1 / קנה-קבל</option>
        <option value="gift">מתנה (מעל סכום או לפי כמות ממוצר)</option>
      </select>
    </div>
    <div id="pm-fields"></div>
    <div><div class="adm-sect-label">כותרת תצוגה בכרטיס (אופציונלי)</div>
      <input id="pm-cardtitle" placeholder="אם ריק — יוצג שם המבצע" style="width:100%"/>
    </div>
    <div><div class="adm-sect-label">תמונת המבצע (אופציונלי)</div>
      <div id="pm-img-box" style="height:112px;border:1px dashed var(--border);border-radius:12px;display:grid;place-items:center;overflow:hidden;background:#f3f5f7;font-size:2rem"></div>
      <input id="pm-img-file" type="file" accept="image/*" hidden/>
      <div style="display:flex;gap:8px;margin-top:6px">
        <button type="button" id="pm-img-up" class="adm-btn-ghost" style="flex:1">📷 העלאת תמונה</button>
        <button type="button" id="pm-img-rm" class="adm-btn-ghost" style="display:none">הסרה ✕</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px">מומלץ 800×400 פיקסלים (רוחב×גובה), JPG/PNG/WebP עד 4MB. מוצגת בלי חיתוך; בלי תמונה יוצג המוצר שבמבצע.</div>
    </div>
    <div style="display:flex;gap:10px">
      <div style="flex:1"><div class="adm-sect-label">תאריך התחלה</div><input id="pm-start" type="date" style="width:100%"/></div>
      <div style="flex:1"><div class="adm-sect-label">תאריך סיום</div><input id="pm-end" type="date" style="width:100%"/></div>
    </div>`;

  const foot = document.createElement('div');
  foot.className = 'adm-drawer-foot';
  foot.innerHTML = `<button type="button" class="save" id="pm-save">${isEdit ? 'שמירת שינויים' : 'יצירת מבצע'}</button>`;
  body.append(foot);

  const drawer = openDrawer(body, {
    title: isEdit ? `עריכה: ${existing.name}` : 'מבצע חדש',
    sub: 'המבצע יוצג ללקוחות במסך הבית, בקטלוג ובעגלה',
  });

  const fieldsFor = (t: string): string => {
    if (t === 'percent' || t === 'fixed')
      return `<div class="form-grid">
        <select id="pf-scope"><option value="order">כל ההזמנה</option><option value="family">משפחה</option><option value="product">מק"ט בודד</option></select>
        <input id="pf-target" placeholder='קוד משפחה / מק"ט (אם לא "כל ההזמנה")'/>
        <input id="pf-value" type="number" step="0.01" placeholder="${t === 'percent' ? 'אחוז (למשל 10)' : 'סכום הנחה ₪'}"/>
        <input id="pf-min" type="number" step="0.01" placeholder="מינימום הזמנה ₪ (אופציונלי)"/>
      </div>`;
    if (t === 'bogo')
      return `<div class="form-grid">
        <input id="pf-part" placeholder='מק"ט'/>
        <input id="pf-buy" type="number" placeholder="קנה (כמות)" value="1"/>
        <input id="pf-free" type="number" placeholder="קבל חינם (כמות)" value="1"/>
      </div>`;
    return `<div class="form-grid">
        <input id="pf-gift" placeholder='מק"ט המתנה'/>
        <input id="pf-gqty" type="number" placeholder="כמות מתנה" value="1"/>
        <input id="pf-min" type="number" step="0.01" placeholder="תנאי: מעל סכום ₪"/>
        <input id="pf-cond" placeholder='או תנאי כמות: מק"ט שקונים (אופציונלי)'/>
        <input id="pf-cqty" type="number" placeholder="כמות שקונים (למשל 60)"/>
      </div>`;
  };
  const typeSel = body.querySelector('#pm-type') as HTMLSelectElement;
  const fields = body.querySelector('#pm-fields') as HTMLElement;
  const renderFields = () => (fields.innerHTML = fieldsFor(typeSel.value));
  typeSel.addEventListener('change', renderFields);
  renderFields();

  const v = (id: string) => (body.querySelector('#' + id) as HTMLInputElement | HTMLSelectElement | null)?.value || '';
  const n = (id: string) => Number(v(id)) || 0;
  const setVal = (id: string, val: unknown) => {
    const el = body.querySelector('#' + id) as HTMLInputElement | HTMLSelectElement | null;
    if (el && val != null && val !== '') el.value = String(val);
  };

  // ---- prefill (edit mode) ----
  if (isEdit) {
    setVal('pm-name', existing.name);
    typeSel.value = existing.type;
    renderFields();
    if (existing.type === 'percent' || existing.type === 'fixed') {
      setVal('pf-scope', x.scope);
      setVal('pf-target', x.target);
      setVal('pf-value', existing.type === 'percent' ? x.percent : x.amount);
      setVal('pf-min', x.minSubtotal);
    } else if (existing.type === 'bogo') {
      setVal('pf-part', x.partname);
      setVal('pf-buy', x.buy);
      setVal('pf-free', x.free);
    } else {
      setVal('pf-gift', x.giftPartname);
      setVal('pf-gqty', x.giftQty);
      setVal('pf-min', x.minSubtotal);
      setVal('pf-cond', x.condPartname);
      setVal('pf-cqty', x.condQty);
    }
    setVal('pm-cardtitle', x.cardTitle);
    setVal('pm-start', existing.startsAt);
    setVal('pm-end', existing.endsAt);
  }

  // ---- promo image: upload / preview / remove ----
  const imgBox = body.querySelector('#pm-img-box') as HTMLElement;
  const imgFile = body.querySelector('#pm-img-file') as HTMLInputElement;
  const imgRm = body.querySelector('#pm-img-rm') as HTMLButtonElement;
  const renderImg = () => {
    imgBox.innerHTML = imgUrl ? `<img src="${escapeAttr(imgUrl)}" alt="" style="width:100%;height:100%;object-fit:contain"/>` : '🎁';
    imgRm.style.display = imgUrl ? '' : 'none';
  };
  renderImg();
  (body.querySelector('#pm-img-up') as HTMLButtonElement).onclick = () => imgFile.click();
  imgRm.onclick = () => {
    imgUrl = '';
    renderImg();
  };
  imgFile.onchange = async () => {
    const f = imgFile.files?.[0];
    imgFile.value = '';
    if (!f) return;
    imgBox.innerHTML = '<span class="muted" style="font-size:13px">מעלה…</span>';
    try {
      const fd = new FormData();
      fd.append('image', f);
      const res = await fetch('/api/admin/promotions/image', { method: 'POST', body: fd, credentials: 'include' });
      const j = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error || `HTTP ${res.status}`);
      imgUrl = j.url;
      toast('התמונה הועלתה ✓', 'ok');
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'העלאת התמונה נכשלה', 'error');
    }
    renderImg();
  };

  // ---- save (POST new / PATCH existing) ----
  (body.querySelector('#pm-save') as HTMLButtonElement).onclick = async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    const type = typeSel.value;
    let params: Record<string, unknown> = {};
    if (type === 'percent') params = { scope: v('pf-scope'), target: v('pf-target') || undefined, percent: n('pf-value'), minSubtotal: n('pf-min') || undefined };
    else if (type === 'fixed') params = { scope: v('pf-scope'), target: v('pf-target') || undefined, amount: n('pf-value'), minSubtotal: n('pf-min') || undefined };
    else if (type === 'bogo') params = { partname: v('pf-part'), buy: n('pf-buy'), free: n('pf-free') };
    else params = { minSubtotal: n('pf-min'), giftPartname: v('pf-gift'), giftQty: n('pf-gqty'), condPartname: v('pf-cond') || undefined, condQty: n('pf-cqty') || undefined };
    params.cardTitle = v('pm-cardtitle').trim() || undefined;
    params.imageUrl = imgUrl || undefined;
    const payload = { name: v('pm-name'), type, params, startsAt: v('pm-start') || null, endsAt: v('pm-end') || null };
    btn.disabled = true;
    try {
      if (isEdit) await api.patch(`/api/admin/promotions/${existing.id}`, payload);
      else await api.post('/api/admin/promotions', payload);
      toast(isEdit ? 'המבצע עודכן ✓' : 'המבצע נוצר ✓', 'ok');
      drawer.close();
      void loadPromoList(shell);
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'השמירה נכשלה', 'error');
    }
    btn.disabled = false;
  };
}
