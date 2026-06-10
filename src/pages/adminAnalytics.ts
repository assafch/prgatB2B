import { api } from '../api.js';
import { escapeHtml } from '../format.js';

// Business analytics dashboard — pulls from Priority (cached server-side 10min).
// Each panel loads independently so one slow/failed query doesn't block the rest.
const money = (n: number) => '₪' + Math.round(n).toLocaleString('en-US');
const errHtml = (ex: unknown) => `<span class="error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</span>`;

export async function renderAnalyticsAdmin(c: HTMLElement): Promise<void> {
  c.innerHTML = `
    <div class="card"><h2 style="margin-top:0">דוחות עסקיים</h2>
      <div class="muted" style="font-size:0.82rem">מתוך Priority · מתעדכן כל 10 דקות</div></div>
    <div class="card" style="margin-top:0.6rem"><h3 style="margin-top:0">הכנסות לפי חודש (12 חודשים)</h3><div id="a-rev" class="muted">טוען…</div></div>
    <div class="card" style="margin-top:0.6rem"><h3 style="margin-top:0">מוצרים מובילים (6 חודשים)</h3><div id="a-prod" class="muted">טוען…</div></div>
    <div class="card" style="margin-top:0.6rem"><h3 style="margin-top:0">חייבים מובילים</h3><div id="a-debt" class="muted">טוען…</div></div>
    <div class="card" style="margin-top:0.6rem"><h3 style="margin-top:0">לקוחות שלא הזמינו 90+ יום</h3><div id="a-inact" class="muted">טוען…</div></div>`;

  void loadRevenue(c.querySelector('#a-rev') as HTMLElement);
  void loadProducts(c.querySelector('#a-prod') as HTMLElement);
  void loadDebtors(c.querySelector('#a-debt') as HTMLElement);
  void loadInactive(c.querySelector('#a-inact') as HTMLElement);
}

async function loadRevenue(el: HTMLElement): Promise<void> {
  try {
    const { revenue } = await api.get<{ revenue: { month: string; total: number; count: number }[] }>('/api/admin/analytics/revenue');
    if (!revenue.length) return void (el.textContent = 'אין נתונים זמינים');
    const max = Math.max(...revenue.map((r) => r.total), 1);
    el.innerHTML = revenue
      .map(
        (r) => `
        <div style="display:flex;align-items:center;gap:0.5rem;margin:0.25rem 0">
          <span class="muted" style="width:62px;font-size:0.78rem">${escapeHtml(r.month)}</span>
          <span style="flex:1;background:var(--surface);border-radius:5px;height:18px;position:relative;overflow:hidden">
            <span style="position:absolute;inset-inline-start:0;top:0;height:100%;width:${Math.round((r.total / max) * 100)}%;background:var(--brand)"></span>
          </span>
          <span style="width:88px;text-align:end;font-size:0.8rem">${money(r.total)}</span>
        </div>`
      )
      .join('');
  } catch (ex) {
    el.innerHTML = errHtml(ex);
  }
}

async function loadProducts(el: HTMLElement): Promise<void> {
  try {
    const { products } = await api.get<{ products: { partname: string; pdes: string; qty: number; revenue: number }[] }>('/api/admin/analytics/top-products');
    if (!products.length) return void (el.textContent = 'אין נתונים זמינים');
    el.innerHTML = `<table class="table"><thead><tr><th>מוצר</th><th>כמות</th><th>הכנסה</th></tr></thead><tbody>${products
      .map((p) => `<tr><td>${escapeHtml(p.pdes || p.partname)}</td><td>${p.qty.toLocaleString('en-US')}</td><td>${money(p.revenue)}</td></tr>`)
      .join('')}</tbody></table>`;
  } catch (ex) {
    el.innerHTML = errHtml(ex);
  }
}

async function loadDebtors(el: HTMLElement): Promise<void> {
  try {
    const { debtors } = await api.get<{ debtors: { custname: string; debit: number }[] }>('/api/admin/analytics/debtors');
    if (!debtors.length) return void (el.textContent = 'אין נתונים זמינים');
    el.innerHTML = `<table class="table"><thead><tr><th>לקוח</th><th>יתרת חוב</th></tr></thead><tbody>${debtors
      .map((d) => `<tr><td>${escapeHtml(d.custname)}</td><td>${money(d.debit)}</td></tr>`)
      .join('')}</tbody></table>`;
  } catch (ex) {
    el.innerHTML = errHtml(ex);
  }
}

async function loadInactive(el: HTMLElement): Promise<void> {
  try {
    const { inactive } = await api.get<{ inactive: { custname: string; lastOrder: string; daysSince: number }[] }>('/api/admin/analytics/inactive');
    if (!inactive.length) return void (el.textContent = 'אין לקוחות לא פעילים');
    el.innerHTML = `<table class="table"><thead><tr><th>לקוח</th><th>הזמנה אחרונה</th><th>ימים</th></tr></thead><tbody>${inactive
      .map((i) => `<tr><td>${escapeHtml(i.custname)}</td><td>${escapeHtml(i.lastOrder)}</td><td>${i.daysSince}</td></tr>`)
      .join('')}</tbody></table>`;
  } catch (ex) {
    el.innerHTML = errHtml(ex);
  }
}
