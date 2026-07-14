import { api } from '../api.js';
import { toast } from '../ui.js';
import { escapeHtml, formatMoney } from '../format.js';

interface SavedCardInfo {
  id: string;
  brand: string | null;
  fourDigits: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
}

export async function renderOrderPay(shell: HTMLElement, orderId: string): Promise<void> {
  shell.innerHTML = `<div class="card muted">טוען…</div>`;
  try {
    const [o, home] = await Promise.all([
      api.get<{ status: string; payment_status?: string; payment_required_amount?: number; priority_ordname?: string | null }>(`/api/orders/${orderId}`),
      api.get<{ features?: { savedCardCharge?: boolean } }>('/api/home').catch(() => null),
    ]);
    if (o.status === 'submitted' || o.priority_ordname) {
      shell.innerHTML = `<div class="card"><div style="font-weight:700">ההזמנה אושרה ונשלחה ✓</div><a class="es-cta" href="#orders" style="display:inline-block;margin-top:0.6rem">להזמנות שלי</a></div>`;
      return;
    }
    if (o.payment_status === 'approved') {
      shell.innerHTML = `<div class="card"><div style="font-weight:700">התקבל התשלום ✓ — ההזמנה בעיבוד</div><div class="muted" style="margin-top:0.25rem">ההזמנה תישלח בקרוב</div><a class="es-cta" href="#orders" style="display:inline-block;margin-top:0.6rem">להזמנות שלי</a></div>`;
      return;
    }

    // One-tap saved-card charge: fetch the card only when the flag is on.
    let savedCard: SavedCardInfo | null = null;
    if (home?.features?.savedCardCharge) {
      try {
        const r = await api.get<{ card: SavedCardInfo | null }>('/api/payments/saved-card');
        savedCard = r.card;
      } catch {
        /* non-owner or vault unavailable — fall back to the hosted flow */
      }
    }

    const amt = Number(o.payment_required_amount || 0).toFixed(2);
    shell.innerHTML = `
      <div class="card">
        <div style="font-weight:700">תשלום להזמנה</div>
        <div class="muted" style="margin-top:0.25rem">כלקוח מזומן, יש לשלם ₪${amt} כדי שההזמנה תאושר ותישלח.</div>
        ${
          savedCard
            ? `<button id="pay-saved" class="es-cta" style="margin-top:0.8rem">שלם ב${escapeHtml(savedCard.brand)} ••${escapeHtml(savedCard.fourDigits)} ₪${amt}</button>`
            : ''
        }
        <button id="pay-card" class="es-cta" style="margin-top:0.8rem">שלם באשראי ₪${amt}</button>
        <button id="pay-check" class="es-cta" style="margin-top:0.6rem;background:var(--ok)">שלם בצ׳ק ₪${amt}</button>
      </div>`;

    if (savedCard) {
      const savedBtn = shell.querySelector('#pay-saved') as HTMLButtonElement;
      savedBtn.addEventListener('click', async () => {
        savedBtn.disabled = true;
        try {
          const r = await api.post<{ id: string; status: string; amount: number }>('/api/payments/card/charge-saved', { orderId: Number(orderId) });
          shell.innerHTML = `
            <div class="empty-state">
              <div class="es-icon">✅</div>
              <div class="es-title">התשלום בוצע — ההזמנה אושרה ותישלח</div>
              <div class="es-sub">שולם ${formatMoney(r.amount)} בכרטיס אשראי.<br/>מספר הזמנה מקומי: <b>${escapeHtml(orderId)}</b></div>
              <a class="es-cta" href="#orders">להזמנות שלי</a>
            </div>`;
        } catch (ex) {
          const msgText = ex instanceof Error ? ex.message : String(ex);
          if (msgText.includes('בעיבוד')) {
            // Processing, not declined — never reveal a retry path for the same charge.
            shell.innerHTML = `
              <div class="card" style="text-align:center">
                <div class="es-icon">⏳</div>
                <div style="font-weight:700">${escapeHtml(msgText)}</div>
                <a class="es-cta" href="#orders" style="display:inline-block;margin-top:0.75rem">להזמנות שלי</a>
              </div>`;
            return;
          }
          // Decline — keep the existing hosted-card/cheque buttons available.
          toast(msgText || 'החיוב נכשל', 'error');
          savedBtn.disabled = false;
        }
      });
    }

    const btn = shell.querySelector('#pay-card') as HTMLButtonElement;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await api.post<{ url: string }>(`/api/orders/${orderId}/pay/card`, {});
        location.href = r.url;
      } catch (e) {
        toast('יצירת התשלום נכשלה', 'error');
        btn.disabled = false;
      }
    });
    shell.querySelector('#pay-check')?.addEventListener('click', () => { location.hash = '#pay-check/' + orderId; });
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
  }
}
