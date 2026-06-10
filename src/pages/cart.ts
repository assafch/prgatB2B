import { api } from '../api.js';
import { escapeAttr, escapeHtml } from '../format.js';

interface CartLine {
  partname: string;
  partdes: string | null;
  quantity: number;
  price: number | null;
  line_total: number;
  available: boolean;
}

interface CartResp {
  lines: CartLine[];
  total: number;
}

export async function renderCart(shell: HTMLElement): Promise<void> {
  await load(shell);
}

async function load(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="muted">טוען…</div>`;
  try {
    const cart = await api.get<CartResp>('/api/cart');
    if (cart.lines.length === 0) {
      shell.innerHTML = `
        <div class="card" style="text-align:center;padding:2rem">
          <h2>הסל ריק</h2>
          <p><a href="#catalog">חזור לקטלוג</a></p>
        </div>`;
      return;
    }
    shell.innerHTML = `
      <div class="card">
        <h1 style="margin-top:0">הסל שלך</h1>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="text-align:right;border-bottom:1px solid var(--border)">
              <th style="padding:0.5rem">מק״ט / שם</th>
              <th style="padding:0.5rem">כמות</th>
              <th style="padding:0.5rem">מחיר ליחידה</th>
              <th style="padding:0.5rem">סה״כ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${cart.lines
              .map(
                (l) => `
              <tr style="border-bottom:1px solid var(--border)${l.available ? '' : ';opacity:0.55'}">
                <td style="padding:0.5rem">
                  <div style="font-weight:500">${escapeHtml(l.partdes || l.partname)}</div>
                  <div class="muted" style="font-size:0.85rem">${escapeHtml(l.partname)}</div>
                  ${l.available ? '' : '<div class="error" style="font-size:0.8rem">לא זמין יותר — יש להסיר מהסל</div>'}
                </td>
                <td style="padding:0.5rem">
                  <input type="number" min="0" step="1" value="${l.quantity}" data-part="${escapeAttr(l.partname)}" class="qty" style="width:70px" ${l.available ? '' : 'disabled'}/>
                </td>
                <td style="padding:0.5rem">${l.price != null ? `₪${l.price.toFixed(2)}` : '-'}</td>
                <td style="padding:0.5rem;font-weight:700">${l.price != null ? `₪${l.line_total.toFixed(2)}` : '-'}</td>
                <td style="padding:0.5rem"><button class="ghost remove" data-part="${escapeAttr(l.partname)}">🗑</button></td>
              </tr>`
              )
              .join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="padding:0.75rem;text-align:left;font-weight:700">סה״כ:</td>
              <td style="padding:0.75rem;font-weight:700;color:var(--brand);font-size:1.2rem">₪${cart.total.toFixed(2)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
        <div style="margin-top:1rem">
          <label>הערה להזמנה</label>
          <textarea id="details" rows="2"></textarea>
        </div>
        <div style="margin-top:1rem;display:flex;gap:0.5rem;justify-content:flex-end">
          <button class="ghost" id="clear">רוקן סל</button>
          <button id="submit">שלח הזמנה</button>
        </div>
        <div id="msg" style="margin-top:0.5rem"></div>
      </div>
    `;

    const lineError = (text: string) => {
      const msgEl = shell.querySelector('#msg') as HTMLDivElement | null;
      if (msgEl) {
        msgEl.textContent = text;
        msgEl.className = 'error';
      }
    };
    shell.querySelectorAll<HTMLInputElement>('input.qty').forEach((inp) => {
      inp.addEventListener('change', async () => {
        const part = inp.dataset.part!;
        const qty = Number(inp.value);
        if (!isFinite(qty) || qty < 0) {
          inp.value = '0';
          return;
        }
        try {
          await api.put(`/api/cart/lines/${encodeURIComponent(part)}`, { quantity: qty });
          await load(shell);
        } catch (ex) {
          // Server refused the change (item hidden/unpriced/qty cap) — resync,
          // then surface the reason (load() re-renders, so the message goes last).
          const reason = ex instanceof Error ? ex.message : String(ex);
          await load(shell);
          lineError(reason);
        }
      });
    });
    shell.querySelectorAll<HTMLButtonElement>('button.remove').forEach((b) => {
      b.addEventListener('click', async () => {
        await api.put(`/api/cart/lines/${encodeURIComponent(b.dataset.part!)}`, { quantity: 0 });
        await load(shell);
      });
    });

    const clearBtn = shell.querySelector('#clear') as HTMLButtonElement;
    clearBtn.addEventListener('click', async () => {
      if (!confirm('לרוקן את הסל?')) return;
      await api.del('/api/cart');
      await load(shell);
    });

    const submitBtn = shell.querySelector('#submit') as HTMLButtonElement;
    const details = shell.querySelector('#details') as HTMLTextAreaElement;
    const msg = shell.querySelector('#msg') as HTMLDivElement;
    submitBtn.addEventListener('click', async () => {
      submitBtn.disabled = true;
      msg.textContent = 'שולח…';
      msg.className = 'muted';
      try {
        const result = await api.post<{ ordname: string; orderId: number }>('/api/orders', {
          details: details.value || undefined,
        });
        shell.innerHTML = `
          <div class="card" style="text-align:center;padding:2rem">
            <h2 class="ok">✓ ההזמנה נשלחה</h2>
            <p>מספר הזמנה ב-Priority: <b>${escapeHtml(result.ordname)}</b></p>
            <p><a href="#orders/${result.orderId}">צפה בהזמנה</a> · <a href="#catalog">חזור לקטלוג</a></p>
          </div>`;
      } catch (ex) {
        msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
        msg.className = 'error';
        submitBtn.disabled = false;
      }
    });
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
  }
}
