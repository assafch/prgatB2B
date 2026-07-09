import { api } from '../api.js';
import { formatMoney, escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount, state } from '../main.js';
import { renderPushCard } from './pushPrompt.js';

interface CartLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number | null;
  line_total: number;
  available: boolean;
}
interface CartPromotions {
  subtotal: number;
  discount: number;
  total: number;
  applied: { id: number; name: string; type: string; savings: number }[];
}
interface CartResp {
  lines: CartLine[];
  total: number;
  promotions?: CartPromotions;
  vatRate?: number;
  unifiedCheckout?: boolean;
}
interface HomeData {
  features: { payments: boolean; discountPricing?: boolean; savedCardCharge?: boolean };
  balance: { obligo: number | null; creditLimit: number | null };
  priorityOk: boolean;
  paymentPolicy?: { kind: 'cash' | 'net'; netDebt: number; blocksOnDebt: boolean } | null;
}
interface CheckoutPreview {
  enabled: boolean;
  subtotal: number;
  discount: number;
  total: number;
  vatRate: number;
  vatAmount: number;
  payable: number;
  requiresPayment: boolean;
  kind: 'cash' | 'net' | null;
  blocked: boolean;
  blockedReason: 'open_debt' | null;
  savedCards: boolean;
  savedCardCharge: boolean;
  installments: { min: number; max: number } | null;
  fastTrack: { discountPct: number; discountedTotal: number; payable: number; saving: number } | null;
}
interface SavedCardInfo {
  id: string;
  brand: string | null;
  fourDigits: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
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
  let preview: CheckoutPreview | null = null;
  try {
    [cart, home, preview] = await Promise.all([
      api.get<CartResp>('/api/cart'),
      api.get<HomeData>('/api/home').catch(() => null),
      api.get<CheckoutPreview>('/api/checkout/preview').catch(() => null),
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

  const unified = !!preview?.enabled;
  const payNow = unified && !!preview!.requiresPayment;

  // Fast-track offer: server already nulls it for cash-forced / blocked / opted-out /
  // non-שוטף customers; re-guard on the client debt block anyway (belt and braces).
  const fastOffer = (!home?.paymentPolicy?.blocksOnDebt && preview?.fastTrack) || null;
  let fastSelected = !!fastOffer; // pre-selected: choosing "regular" means giving up the discount

  // One-tap saved-card charge: fetch the card only when the flag is on, so a customer
  // who never opted in (or the office hasn't enabled the feature) never pays the
  // extra round-trip.
  let savedCard: SavedCardInfo | null = null;
  if ((payNow || fastOffer) && preview!.savedCardCharge) {
    try {
      const r = await api.get<{ card: SavedCardInfo | null }>('/api/payments/saved-card');
      savedCard = r.card;
    } catch {
      /* non-owner or vault unavailable — fall back to the method picker */
    }
  }

  const dates = deliveryOptions();

  // Hard debt block — disables order submission when customer has open debt and policy blocks it.
  // netDebt is 0 for staff 'orderer' logins (server redacts the amount) — show the
  // block without a nonsense "₪0.00" figure, and point them at the owner.
  const isOrderer = state.me?.customer_role === 'orderer';
  const debtBlock = home?.paymentPolicy?.blocksOnDebt
    ? `<div class="card" style="border:1px solid var(--err);background:#fdecec;margin-bottom:0.75rem">
         <div style="font-weight:700;color:var(--err)">לא ניתן לבצע הזמנה — קיים חוב פתוח</div>
         <div class="muted" style="font-size:0.9rem;margin-top:0.25rem">${
           !isOrderer && home.paymentPolicy!.netDebt > 0
             ? `יש לסגור חוב פתוח של ₪${home.paymentPolicy!.netDebt.toFixed(2)} לפני ביצוע הזמנה.`
             : 'יש לסגור את החוב הפתוח לפני ביצוע הזמנה — פנו לבעל העסק.'
         }</div>
         <div class="muted" style="font-size:0.82rem;margin-top:0.35rem">שילמתם בהעברה בנקאית? החסימה תוסר אוטומטית עם קליטת התשלום במשרד.</div>
         ${!isOrderer ? '<a class="es-cta" href="#invoices" style="display:inline-block;margin-top:0.6rem">סגור חוב ←</a>' : ''}
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
      ${home?.features?.discountPricing ? '<p class="muted" style="font-size:0.78rem;margin:0.2rem 0 0.5rem">המחירים כוללים את ההנחה הקבועה שלך.</p>' : ''}
      ${
        unified
          ? `${preview!.discount > 0 ? `<div style="display:flex;justify-content:space-between;margin-top:0.4rem;font-size:0.9rem"><span>סכום ביניים</span><span>${formatMoney(preview!.subtotal)}</span></div>` : ''}
             ${(cart.promotions?.applied || [])
               .filter((a) => a.savings > 0)
               .map((a) => `<div style="display:flex;justify-content:space-between;margin-top:0.3rem;color:var(--ok);font-size:0.9rem"><span>🏷️ ${escapeHtml(a.name)}</span><span dir="ltr">−${formatMoney(a.savings)}</span></div>`)
               .join('')}
             <div style="display:flex;justify-content:space-between;margin-top:0.4rem;font-size:0.9rem"><span>מע״מ ${Math.round(preview!.vatRate * 100)}%</span><span>${formatMoney(preview!.vatAmount)}</span></div>
             <div style="display:flex;justify-content:space-between;margin-top:0.6rem;font-weight:900;font-size:1.2rem"><span>לתשלום</span><span style="color:var(--brand)">${formatMoney(preview!.payable)}</span></div>`
          : `${(cart.promotions?.applied || [])
               .filter((a) => a.savings > 0)
               .map(
                 (a) => `<div style="display:flex;justify-content:space-between;margin-top:0.4rem;color:var(--ok);font-size:0.9rem">
                   <span>🏷️ ${escapeHtml(a.name)}</span><span dir="ltr">−${formatMoney(a.savings)}</span></div>`
               )
               .join('')}
             <div style="display:flex;justify-content:space-between;margin-top:0.75rem;font-weight:900;font-size:1.2rem">
               <span>סה״כ</span><span style="color:var(--brand)">${formatMoney(cart.promotions?.total ?? cart.total)}</span>
             </div>`
      }
    </div>

    ${debtBlock}
    ${creditWarn}

    ${
      fastOffer
        ? `<div class="card" id="track-card">
             <div style="font-weight:700;margin-bottom:0.55rem">בחרו מסלול</div>
             <div class="track-opt" data-track="fast" style="border:2px solid var(--brand);border-radius:12px;padding:0.7rem 0.8rem;cursor:pointer;background:rgba(37,99,235,0.05)">
               <div style="display:flex;justify-content:space-between;align-items:center">
                 <span style="font-weight:800">🚀 מסלול מהיר</span>
                 <span style="font-weight:800;color:var(--brand)">${formatMoney(fastOffer.payable)}</span>
               </div>
               <div class="muted" style="font-size:0.84rem;margin-top:0.2rem">משלמים עכשיו (אשראי או צילום צ׳ק) — ההזמנה מאושרת מיד ויוצאת למשלוח בעדיפות</div>
               <div style="color:var(--ok);font-weight:700;font-size:0.88rem;margin-top:0.2rem">הנחת ${fastOffer.discountPct}% — חיסכון של ${formatMoney(fastOffer.saving)}</div>
             </div>
             <div class="track-opt" data-track="regular" style="border:2px solid var(--border);border-radius:12px;padding:0.7rem 0.8rem;cursor:pointer;margin-top:0.5rem">
               <div style="display:flex;justify-content:space-between;align-items:center">
                 <span style="font-weight:700">מסלול רגיל</span>
                 <span style="font-weight:700">${formatMoney(preview!.payable)}</span>
               </div>
               <div class="muted" style="font-size:0.84rem;margin-top:0.2rem">תשלום לפי תנאי התשלום הקיימים שלכם — אספקה רגילה</div>
             </div>
             <div class="muted" style="font-size:0.75rem;margin-top:0.4rem">המחירים כוללים מע״מ</div>
           </div>`
        : ''
    }

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

    ${
      payNow || fastOffer
        ? `<div class="card" id="pay-methods" style="${payNow || fastSelected ? '' : 'display:none'}">
             <div style="font-weight:700;margin-bottom:0.35rem">אמצעי תשלום</div>
             <p class="muted" style="font-size:0.82rem;margin:0 0 0.6rem">${
               payNow
                 ? 'לקוחות מזומן משלמים בעת ההזמנה — ההזמנה תישלח מיד עם אישור התשלום.'
                 : 'התשלום מאשר את ההזמנה מיד ושולח אותה בעדיפות.'
             }</p>
             ${
               savedCard
                 ? `<button type="button" class="pay-method" data-method="saved" style="width:100%;padding:0.75rem;font-weight:700;border:2px solid var(--brand);border-radius:10px;background:#fff;color:var(--text);margin-bottom:0.6rem">שלם ב${escapeHtml(savedCard.brand)} ••${escapeHtml(savedCard.fourDigits)} · ${formatMoney(fastOffer ? fastOffer.payable : preview!.payable)}</button>`
                 : ''
             }
             <div style="display:flex;gap:0.5rem">
               <button type="button" class="pay-method sel" data-method="card" style="flex:1;padding:0.7rem;font-weight:700;border:2px solid var(--brand);border-radius:10px;background:var(--brand);color:#fff">💳 אשראי</button>
               <button type="button" class="pay-method" data-method="check" style="flex:1;padding:0.7rem;font-weight:700;border:2px solid var(--border);border-radius:10px;background:#fff;color:var(--text)">📸 צ׳ק</button>
             </div>
             ${
               preview!.savedCards
                 ? `<label style="display:flex;align-items:center;gap:0.5rem;margin-top:0.6rem;font-size:0.9rem;cursor:pointer"><input type="checkbox" id="save-card" style="width:1.05rem;height:1.05rem"> 💾 שמור את הכרטיס לתשלומים הבאים</label>`
                 : ''
             }
             ${
               preview!.installments
                 ? `<p class="muted" style="font-size:0.8rem;margin-top:0.5rem">אפשר לחלק עד ${preview!.installments.max} תשלומים בעמוד התשלום</p>`
                 : ''
             }
           </div>`
        : ''
    }

    <button id="submit" style="width:100%;padding:0.9rem;font-size:1.05rem;font-weight:700;margin-top:0.25rem">${
      fastOffer ? `שלח ושלם ${formatMoney(fastOffer.payable)} ←` : payNow ? `שלח ושלם ${formatMoney(preview!.payable)} ←` : 'שלח הזמנה'
    }</button>
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

  let payMethod: 'card' | 'check' | 'saved' = 'card';
  shell.querySelectorAll<HTMLButtonElement>('.pay-method').forEach((btn) => {
    btn.addEventListener('click', () => {
      shell.querySelectorAll<HTMLButtonElement>('.pay-method').forEach((b) => {
        const on = b === btn;
        b.classList.toggle('sel', on);
        b.style.background = on ? 'var(--brand)' : '#fff';
        b.style.color = on ? '#fff' : 'var(--text)';
        b.style.borderColor = on ? 'var(--brand)' : 'var(--border)';
      });
      payMethod = (btn.dataset.method as 'card' | 'check' | 'saved') || 'card';
    });
  });

  const submitBtn = shell.querySelector('#submit') as HTMLButtonElement;
  const note = shell.querySelector('#order-note') as HTMLTextAreaElement;
  const msg = shell.querySelector('#msg') as HTMLDivElement;

  // Track selector: toggling updates the visuals, the payment picker's visibility,
  // and the submit CTA. Fast is pre-selected — switching away shows the plain CTA.
  if (fastOffer) {
    const payCard = shell.querySelector('#pay-methods') as HTMLElement | null;
    shell.querySelectorAll<HTMLElement>('.track-opt').forEach((opt) => {
      opt.addEventListener('click', () => {
        fastSelected = opt.dataset.track === 'fast';
        shell.querySelectorAll<HTMLElement>('.track-opt').forEach((o) => {
          const on = o === opt;
          o.style.borderColor = on ? 'var(--brand)' : 'var(--border)';
          o.style.background = on ? 'rgba(37,99,235,0.05)' : '';
        });
        if (payCard) payCard.style.display = fastSelected ? '' : 'none';
        submitBtn.textContent = fastSelected ? `שלח ושלם ${formatMoney(fastOffer.payable)} ←` : 'שלח הזמנה';
      });
    });
  }

  if (home?.paymentPolicy?.blocksOnDebt || preview?.blocked) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'סגור חוב כדי להזמין';
  }

  submitBtn.addEventListener('click', async () => {
    submitBtn.disabled = true;
    msg.textContent = 'שולח…';
    msg.className = 'muted';
    const details = [`אספקה: ${selectedLabel}`, note.value.trim()].filter(Boolean).join(' · ');
    const payingNow = payNow || (!!fastOffer && fastSelected);
    try {
      const result = await api.post<{ ordname: string; orderId: number; needsPayment?: boolean; amount?: number }>('/api/orders', {
        details,
        track: fastOffer && fastSelected ? 'fast' : 'regular',
      });
      await refreshCartCount();
      if (result.needsPayment) {
        // Unified flow: continue straight to the chosen payment method only when the
        // picker was shown (payNow = true). Any failure in the pay step falls back to
        // the interstitial (#order-pay) — the order is already safely recorded as
        // pending_payment; nothing is lost.
        if (payingNow && payMethod === 'saved') {
          msg.textContent = 'מחייב את הכרטיס השמור…';
          try {
            const chargeResult = await api.post<{ id: string; status: string; amount: number }>('/api/payments/card/charge-saved', { orderId: result.orderId });
            shell.innerHTML = `
              <div class="empty-state">
                <div class="es-icon">✅</div>
                <div class="es-title">התשלום בוצע — ההזמנה אושרה ותישלח</div>
                <div class="es-sub">שולם ${formatMoney(chargeResult.amount)} בכרטיס אשראי.<br/>מספר הזמנה מקומי: <b>${result.orderId}</b></div>
                <a class="es-cta" href="#orders">להזמנות שלי</a>
              </div>`;
          } catch (ex) {
            const chargeMsg = ex instanceof Error ? ex.message : String(ex);
            if (chargeMsg.includes('בעיבוד')) {
              // Processing, not declined — never reveal a retry path for the same charge.
              shell.innerHTML = `
                <div class="card" style="text-align:center">
                  <div class="es-icon">⏳</div>
                  <div style="font-weight:700">התשלום בעיבוד — ההזמנה תאושר אוטומטית עם אישור התשלום</div>
                  <a class="es-cta" href="#orders" style="display:inline-block;margin-top:0.75rem">להזמנות שלי</a>
                </div>`;
            } else {
              // Decline (or generic 400/404/503) — the order is safely pending_payment;
              // send the customer to the interstitial, which offers the hosted card page + cheque.
              location.hash = '#order-pay/' + result.orderId;
            }
          }
          return;
        }
        if (payingNow && payMethod === 'card') {
          msg.textContent = 'מעביר לעמוד תשלום מאובטח…';
          try {
            const saveCard = !!(shell.querySelector('#save-card') as HTMLInputElement | null)?.checked;
            const r = await api.post<{ url: string }>(`/api/orders/${result.orderId}/pay/card`, { saveCard });
            window.location.href = r.url;
          } catch {
            location.hash = '#order-pay/' + result.orderId;
          }
          return;
        }
        if (payingNow && payMethod === 'check') {
          location.hash = '#pay-check/' + result.orderId;
          return;
        }
        location.hash = '#order-pay/' + result.orderId;
        return;
      }
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
      renderPushCard(shell, { compact: true });
    } catch (ex) {
      msg.textContent = ex instanceof Error ? ex.message : String(ex);
      msg.className = 'error';
      submitBtn.disabled = false;
    }
  });
}
