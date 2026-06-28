import { api } from '../api.js';
import { formatMoney, escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface CartLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number | null;
  line_total: number;
  available: boolean;
}
interface CartResp { lines: CartLine[]; total: number }
interface HomeData {
  features: { payments: boolean };
  balance: { obligo: number | null; creditLimit: number | null };
  priorityOk: boolean;
  paymentPolicy?: { kind: 'cash' | 'net'; netDebt: number; blocksOnDebt: boolean } | null;
}

const HE_DOW = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

// Next delivery days, skipping Friday/Saturday (Israeli work week). Cosmetic for
// now — the date rides along as an order note until ERP scheduling lands.
function deliveryOptions(count = 5): { iso: string; dow: string; dnum: string; label: string }[] {
  const out: { iso: string; dow: string; dnum: string; label: string }[] = [];
  const d = new Date();
  d.setDate(d.getDate() + 1); // earliest = tomorrow
  while (out.length < count) {
    const day = d.getDay(); // 0=Sun … 6=Sat
    if (day !== 5 && day !== 6) {
      const pad = (n: number) => String(n).padStart(2, '0');
      out.push({
        // Local date parts — toISOString() is UTC and would roll back a day when
        // the owner opens checkout just after local midnight.
        iso: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        dow: HE_DOW[day],
        dnum: `${d.getDate()}/${d.getMonth() + 1}`,
        label: `יום ${HE_DOW[day]} ${d.getDate()}/${d.getMonth() + 1}`,
      });
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

export async function renderCheckout(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card muted">טוען…</div>`;
  let cart: CartResp;
  let home: HomeData | null = null;
  try {
    [cart, home] = await Promise.all([
      api.get<CartResp>('/api/cart'),
      api.get<HomeData>('/api/home').catch(() => null),
    ]);
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }

  if (cart.lines.length === 0) {
    location.hash = '#cart';
    return;
  }
  if (cart.lines.some((l) => !l.available)) {
    toast('יש פריטים שאינם זמינים — חזרה לסל', 'error');
    location.hash = '#cart';
    return;
  }

  const dates = deliveryOptions();

  // Hard debt block — disables order submission when customer has open debt and policy blocks it.
  const debtBlock = home?.paymentPolicy?.blocksOnDebt
    ? `<div class="card" style="border:1px solid var(--err);background:#fdecec;margin-bottom:0.75rem">
         <div style="font-weight:700;color:var(--err)">לא ניתן לבצע הזמנה — קיים חוב פתוח</div>
         <div class="muted" style="font-size:0.9rem;margin-top:0.25rem">יש לסגור חוב פתוח של ₪${home.paymentPolicy!.netDebt.toFixed(2)} לפני ביצוע הזמנה.</div>
         <a class="es-cta" href="#invoices" style="display:inline-block;margin-top:0.6rem">סגור חוב ←</a>
       </div>`
    : '';

  // Soft credit-limit warning (never blocks — the ERP is the real gate).
  let creditWarn = '';
  if (home?.priorityOk && home.balance.obligo != null && home.balance.creditLimit) {
    const projected = home.balance.obligo + cart.total;
    if (projected > home.balance.creditLimit) {
      creditWarn = `<div class="card" style="border-color:var(--warn);background:rgba(217,119,6,0.06)">
        <b class="badge warn">שים לב</b> ההזמנה עשויה לחרוג ממסגרת האשראי — ייתכן שתידרש אישור.
      </div>`;
    }
  }

  shell.innerHTML = `
    <div class="card">
      <h1 style="margin-top:0">סיום הזמנה</h1>
      <div class="sec-head"><h2>סיכום</h2><a href="#cart">עריכה</a></div>
      ${cart.lines
        .map(
          (l) => `
        <div class="dash-row" style="padding:0.4rem 0;border-bottom:1px solid var(--border)">
          <div class="grow"><div style="font-weight:600">${escapeHtml(l.partdes || l.partname)}</div>
            <div class="muted" style="font-size:0.82rem">${l.quantity} יח׳ × ${l.price != null ? formatMoney(l.price) : '—'}</div></div>
          <div style="font-weight:700">${l.price != null ? formatMoney(l.line_total) : '—'}</div>
        </div>`
        )
        .join('')}
      <div style="display:flex;justify-content:space-between;margin-top:0.75rem;font-weight:900;font-size:1.2rem">
        <span>סה״כ</span><span style="color:var(--brand)">${formatMoney(cart.total)}</span>
      </div>
    </div>

    ${debtBlock}
    ${creditWarn}

    <div class="card">
      <div style="font-weight:700;margin-bottom:0.5rem">מועד אספקה מבוקש</div>
      <div class="date-chips" id="date-chips">
        ${dates
          .map(
            (o, i) => `<div class="date-chip${i === 0 ? ' sel' : ''}" data-iso="${o.iso}" data-label="${escapeHtml(o.label)}">
              <div class="dow">יום ${o.dow}</div><div class="dnum">${o.dnum}</div></div>`
          )
          .join('')}
      </div>
    </div>

    <div class="card">
      <label for="order-note" style="font-weight:700">הערה להזמנה (אופציונלי)</label>
      <textarea id="order-note" rows="2" placeholder="לדוגמה: לתאם טלפונית לפני הגעה"></textarea>
    </div>

    <button id="submit" style="width:100%;padding:0.9rem;font-size:1.05rem;font-weight:700;margin-top:0.25rem">שלח הזמנה</button>
    <div id="msg" style="margin-top:0.5rem;text-align:center"></div>
  `;

  let selectedLabel = dates[0].label;
  shell.querySelectorAll<HTMLDivElement>('.date-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      shell.querySelectorAll('.date-chip').forEach((c) => c.classList.remove('sel'));
      chip.classList.add('sel');
      selectedLabel = chip.dataset.label!;
    });
  });

  const submitBtn = shell.querySelector('#submit') as HTMLButtonElement;
  const note = shell.querySelector('#order-note') as HTMLTextAreaElement;
  const msg = shell.querySelector('#msg') as HTMLDivElement;

  if (home?.paymentPolicy?.blocksOnDebt) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'סגור חוב כדי להזמין';
  }

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    msg.textContent = 'שולח…';
    msg.className = 'muted';
    const details = [`אספקה: ${selectedLabel}`, note.value.trim()].filter(Boolean).join(' · ');
    try {
      const result = await api.post<{ ordname: string; orderId: number; needsPayment?: boolean; amount?: number }>('/api/orders', { details });
      await refreshCartCount();
      if (result.needsPayment) { location.hash = '#order-pay/' + result.orderId; return; }
      shell.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">✅</div>
          <div class="es-title">ההזמנה התקבלה!</div>
          <div class="es-sub">מספר הזמנה: <b>${escapeHtml(result.ordname)}</b><br/>מועד אספקה מבוקש: ${escapeHtml(selectedLabel)}</div>
          ${
            home?.features.payments
              ? `<a class="es-cta" href="#invoices">לתשלום ההזמנה ←</a>
                 <div style="margin-top:0.75rem"><a href="#home">תשלום מאוחר יותר</a></div>`
              : `<a class="es-cta" href="#orders/${result.orderId}">צפייה בהזמנה</a>
                 <div style="margin-top:0.75rem"><a href="#home">חזרה לדף הבית</a></div>`
          }
        </div>`;
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
      submitBtn.disabled = false;
    }
  });
}
