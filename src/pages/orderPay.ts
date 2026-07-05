import { api } from '../api.js';
import { toast } from '../ui.js';

export async function renderOrderPay(shell: HTMLElement, orderId: string): Promise<void> {
  shell.innerHTML = `<div class="card muted">טוען…</div>`;
  try {
    const o = await api.get<{ status: string; payment_status?: string; payment_required_amount?: number; priority_ordname?: string | null }>(`/api/orders/${orderId}`);
    if (o.status === 'submitted' || o.priority_ordname) {
      shell.innerHTML = `<div class="card"><div style="font-weight:700">ההזמנה אושרה ונשלחה ✓</div><a class="es-cta" href="#orders" style="display:inline-block;margin-top:0.6rem">להזמנות שלי</a></div>`;
      return;
    }
    if (o.payment_status === 'approved') {
      shell.innerHTML = `<div class="card"><div style="font-weight:700">התקבל התשלום ✓ — ההזמנה בעיבוד</div><div class="muted" style="margin-top:0.25rem">ההזמנה תישלח בקרוב</div><a class="es-cta" href="#orders" style="display:inline-block;margin-top:0.6rem">להזמנות שלי</a></div>`;
      return;
    }
    const amt = Number(o.payment_required_amount || 0).toFixed(2);
    shell.innerHTML = `
      <div class="card">
        <div style="font-weight:700">תשלום להזמנה</div>
        <div class="muted" style="margin-top:0.25rem">כלקוח מזומן, יש לשלם ₪${amt} כדי שההזמנה תאושר ותישלח.</div>
        <button id="pay-card" class="es-cta" style="margin-top:0.8rem">שלם באשראי ₪${amt}</button>
        <button id="pay-check" class="es-cta" style="margin-top:0.6rem;background:var(--ok)">שלם בצ׳ק ₪${amt}</button>
      </div>`;
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
    shell.innerHTML = `<div class="card error">${ex instanceof Error ? ex.message : String(ex)}</div>`;
  }
}
