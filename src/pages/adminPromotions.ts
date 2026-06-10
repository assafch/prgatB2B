import { api } from '../api.js';
import { escapeHtml, escapeAttr } from '../format.js';

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

const TYPE_HE: Record<string, string> = { percent: 'אחוז הנחה', fixed: 'הנחה בש"ח', bogo: '1+1 / קנה-קבל', gift: 'מתנה מעל סכום' };

function describe(p: Promo): string {
  const x = p.params;
  if (p.type === 'percent') return `${x.percent}% הנחה על ${x.scope === 'order' ? 'כל ההזמנה' : x.scope === 'family' ? 'משפחה ' + x.target : 'מק"ט ' + x.target}${x.minSubtotal ? ` (מעל ₪${x.minSubtotal})` : ''}`;
  if (p.type === 'fixed') return `₪${x.amount} הנחה על ${x.scope === 'order' ? 'כל ההזמנה' : x.scope === 'family' ? 'משפחה ' + x.target : 'מק"ט ' + x.target}${x.minSubtotal ? ` (מעל ₪${x.minSubtotal})` : ''}`;
  if (p.type === 'bogo') return `קנה ${x.buy} קבל ${x.free} חינם · מק"ט ${x.partname}`;
  if (p.type === 'gift') return `מעל ₪${x.minSubtotal} → מתנה ${x.giftPartname} ×${x.giftQty}`;
  return JSON.stringify(x);
}

export async function renderPromotionsAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `<div class="muted">טוען…</div>`;
  let promos: Promo[] = [];
  try {
    promos = (await api.get<{ promotions: Promo[] }>('/api/admin/promotions')).promotions;
  } catch (ex) {
    c.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
    return;
  }

  c.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">מבצע חדש</h2>
      <div class="form-grid">
        <input id="pm-name" placeholder="שם המבצע (יוצג ללקוח)"/>
        <select id="pm-type">
          <option value="percent">אחוז הנחה</option>
          <option value="fixed">הנחה בש"ח</option>
          <option value="bogo">1+1 / קנה-קבל</option>
          <option value="gift">מתנה מעל סכום</option>
        </select>
      </div>
      <div id="pm-fields" style="margin-top:0.6rem"></div>
      <div class="form-grid" style="margin-top:0.6rem">
        <input id="pm-start" type="date" title="תאריך התחלה (אופציונלי)"/>
        <input id="pm-end" type="date" title="תאריך סיום (אופציונלי)"/>
      </div>
      <button id="pm-create" style="width:100%;margin-top:0.6rem">יצירת מבצע</button>
      <div id="pm-msg" style="margin-top:0.5rem;text-align:center"></div>
    </div>
    <div class="card" style="margin-top:0.75rem">
      <h2 style="margin-top:0">מבצעים (${promos.length})</h2>
      <div id="pm-list"></div>
      <div id="pm-lmsg" style="margin-top:0.5rem;text-align:center"></div>
    </div>`;

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
        <input id="pf-min" type="number" step="0.01" placeholder="מעל סכום ₪"/>
        <input id="pf-gift" placeholder='מק"ט המתנה'/>
        <input id="pf-gqty" type="number" placeholder="כמות מתנה" value="1"/>
      </div>`;
  };
  const typeSel = c.querySelector('#pm-type') as HTMLSelectElement;
  const fields = c.querySelector('#pm-fields') as HTMLElement;
  const renderFields = () => (fields.innerHTML = fieldsFor(typeSel.value));
  typeSel.addEventListener('change', renderFields);
  renderFields();

  const v = (id: string) => (c.querySelector('#' + id) as HTMLInputElement | HTMLSelectElement | null)?.value || '';
  const n = (id: string) => Number(v(id)) || 0;

  const msg = c.querySelector('#pm-msg') as HTMLDivElement;
  (c.querySelector('#pm-create') as HTMLButtonElement).onclick = async () => {
    const type = typeSel.value;
    let params: Record<string, unknown> = {};
    if (type === 'percent') params = { scope: v('pf-scope'), target: v('pf-target') || undefined, percent: n('pf-value'), minSubtotal: n('pf-min') || undefined };
    else if (type === 'fixed') params = { scope: v('pf-scope'), target: v('pf-target') || undefined, amount: n('pf-value'), minSubtotal: n('pf-min') || undefined };
    else if (type === 'bogo') params = { partname: v('pf-part'), buy: n('pf-buy'), free: n('pf-free') };
    else params = { minSubtotal: n('pf-min'), giftPartname: v('pf-gift'), giftQty: n('pf-gqty') };
    msg.textContent = 'יוצר…';
    msg.className = 'muted';
    try {
      await api.post('/api/admin/promotions', {
        name: v('pm-name'),
        type,
        params,
        startsAt: v('pm-start') || null,
        endsAt: v('pm-end') || null,
      });
      msg.textContent = '✓ נוצר';
      msg.className = 'ok';
      setTimeout(() => renderPromotionsAdmin(c), 600);
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
    }
  };

  const list = c.querySelector('#pm-list') as HTMLElement;
  const lmsg = c.querySelector('#pm-lmsg') as HTMLDivElement;
  list.innerHTML = promos.length
    ? promos
        .map(
          (p) => `
      <div class="dash-row" style="border-bottom:1px solid var(--border);padding:0.55rem 0">
        <div class="grow">
          <div style="font-weight:700">${escapeHtml(p.name)} ${!p.active ? '<span class="chip error">כבוי</span>' : ''}</div>
          <div class="muted" style="font-size:0.82rem">${escapeHtml(TYPE_HE[p.type] || p.type)} · ${escapeHtml(describe(p))}${p.endsAt ? ' · עד ' + escapeHtml(p.endsAt) : ''}</div>
        </div>
        <button class="ghost pm-toggle" data-id="${p.id}" data-active="${p.active ? 1 : 0}">${p.active ? 'כבה' : 'הפעל'}</button>
        <button class="ghost pm-del" data-id="${p.id}">מחק</button>
      </div>`
        )
        .join('')
    : '<div class="muted">אין מבצעים עדיין.</div>';

  list.querySelectorAll<HTMLButtonElement>('.pm-toggle').forEach((b) => {
    b.onclick = async () => {
      try {
        await api.patch(`/api/admin/promotions/${b.dataset.id}`, { active: b.dataset.active !== '1' });
        renderPromotionsAdmin(c);
      } catch (ex) {
        lmsg.textContent = ex instanceof Error ? ex.message : String(ex);
        lmsg.className = 'error';
      }
    };
  });
  list.querySelectorAll<HTMLButtonElement>('.pm-del').forEach((b) => {
    b.onclick = async () => {
      if (!window.confirm('למחוק את המבצע?')) return;
      try {
        await api.del(`/api/admin/promotions/${b.dataset.id}`);
        renderPromotionsAdmin(c);
      } catch (ex) {
        lmsg.textContent = ex instanceof Error ? ex.message : String(ex);
        lmsg.className = 'error';
      }
    };
  });
}
