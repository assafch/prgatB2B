import { api } from '../api.js';
import { formatMoney, escapeHtml } from '../format.js';

interface Profile {
  custname: string;
  name: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  phone: string | null;
  fax: string | null;
  email: string | null;
  vatNumber: string | null;
  paymentTerms: string | null;
  agent: string | null;
}

interface Balance {
  openTotal: number;
  openCount: number;
  obligo: number | null;
  creditLimit: number | null;
}

interface Account {
  custname: string | null;
  cust_desc: string | null;
  email: string | null;
  phone: string | null;
  profile: Profile | null;
  balance: Balance;
  priorityOk: boolean;
  balanceOk: boolean;
}

export async function renderAccount(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const a = await api.get<Account>('/api/account');
    const p = a.profile;

    // Prefer live Priority profile; fall back to local user record when unreachable.
    const name = p?.name || a.cust_desc || '-';
    const custname = p?.custname || a.custname || '-';
    const phone = p?.phone || a.phone || '-';
    const email = p?.email || a.email || '-';
    const addressParts = [p?.address, p?.city, p?.zip].filter(Boolean).join(', ');

    const rows: Array<[string, string | null]> = [
      ['שם לקוח', name],
      ['מספר לקוח', custname],
      ['ח.פ / עוסק מורשה', p?.vatNumber || null],
      ['כתובת', addressParts || null],
      ['טלפון', phone],
      ['פקס', p?.fax || null],
      ['אימייל', email],
      ['תנאי תשלום', p?.paymentTerms || null],
      ['סוכן', p?.agent || null],
    ];

    shell.innerHTML = `
      <div class="card" style="max-width:720px;margin:0 auto">
        <h1 style="margin-top:0">החשבון שלי</h1>
        ${balanceSection(a)}
        <dl class="kv" style="margin-top:1.25rem">
          ${rows
            .filter(([, v]) => v && v !== '-')
            .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
            .join('')}
        </dl>
        ${
          !a.priorityOk
            ? `<p class="muted" style="margin-top:1rem">⚠ נתוני Priority אינם זמינים כעת — מוצגים הפרטים השמורים.</p>`
            : ''
        }
        <p class="muted" style="margin-top:1.5rem">לשינוי פרטים — צרו קשר עם משרד אורגת.</p>
      </div>
    `;
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}

function balanceSection(a: Account): string {
  if (!a.balanceOk) return '';
  const b = a.balance;
  const hasDebt = b.openTotal > 0.005;
  const extra: string[] = [];
  if (b.creditLimit != null) {
    extra.push(`<div class="stat"><div class="num">${formatMoney(b.creditLimit)}</div><div class="label">מסגרת אשראי</div></div>`);
  }
  if (b.obligo != null) {
    extra.push(`<div class="stat"><div class="num">${formatMoney(b.obligo)}</div><div class="label">ניצול אשראי (אובליגו)</div></div>`);
  }
  return `
    <div class="summary-grid">
      ${
        hasDebt
          ? `<div class="stat debt">
               <div class="num">${formatMoney(b.openTotal)}</div>
               <div class="label">יתרה לתשלום · ${b.openCount} חשבוניות · <a href="#invoices">פירוט</a></div>
             </div>`
          : `<div class="stat clear">
               <div class="num">אין יתרה ✓</div>
               <div class="label">כל החשבוניות שולמו · <a href="#invoices">היסטוריה</a></div>
             </div>`
      }
      ${extra.join('')}
    </div>`;
}
