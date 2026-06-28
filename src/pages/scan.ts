import { api } from '../api.js';
import { escapeHtml } from '../format.js';
import { toast } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface Item {
  partname: string;
  partdes: string | null;
  price: number | null;
  box_size: number;
  outOfStock?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BD: any = (window as { BarcodeDetector?: unknown }).BarcodeDetector;

export async function renderScan(shell: HTMLElement): Promise<void> {
  const hasDetector = typeof BD === 'function';
  shell.innerHTML = `
    <div class="card" style="max-width:560px;margin:0 auto">
      <h1 style="margin-top:0">📷 סריקת ברקוד</h1>
      ${
        hasDetector
          ? `<div class="scan-cam"><video id="scan-video" playsinline muted></video><div class="scan-line"></div></div>
             <div id="scan-status" class="muted" style="text-align:center;margin-top:0.5rem">מכוונים את המצלמה אל הברקוד…</div>`
          : `<div class="muted" style="text-align:center">המכשיר/דפדפן אינו תומך בסריקה אוטומטית — הקלידו את הברקוד ידנית.</div>`
      }
      <div style="display:flex;gap:0.5rem;margin-top:0.75rem">
        <input id="scan-manual" inputmode="numeric" placeholder="הקלדת ברקוד ידנית" style="flex:1"/>
        <button id="scan-lookup">חפש</button>
      </div>
      <div id="scan-found" style="margin-top:0.75rem"></div>
      <div style="display:flex;gap:0.5rem;margin-top:1rem">
        <a class="ghost" href="#catalog" style="flex:1;text-align:center;padding:0.6rem;border:1px solid var(--border);border-radius:8px">לקטלוג</a>
        <a href="#cart" style="flex:1;text-align:center;padding:0.6rem;background:var(--brand);color:#fff;border-radius:8px">מעבר לסל ←</a>
      </div>
    </div>`;

  const status = shell.querySelector('#scan-status') as HTMLElement | null;
  const found = shell.querySelector('#scan-found') as HTMLElement;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastCode = '';
  let lastAt = 0;
  let busy = false;

  const cleanup = () => {
    if (timer) clearInterval(timer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  window.addEventListener('hashchange', cleanup, { once: true });

  const lookup = async (code: string) => {
    if (busy) return;
    busy = true;
    try {
      const { item } = await api.get<{ item: Item }>(`/api/catalog/barcode/${encodeURIComponent(code)}`);
      if (item.outOfStock) {
        toast(`${item.partdes || item.partname} — אזל מהמלאי, אינו זמין להזמנה`, 'error');
        found.innerHTML = `<div class="card is-oos"><b>${escapeHtml(item.partdes || item.partname)}</b> — אזל מהמלאי</div>`;
        return;
      }
      await api.put(`/api/cart/lines/${encodeURIComponent(item.partname)}`, { quantity: item.box_size, mode: 'add' });
      await refreshCartCount();
      toast(`✓ ${item.partdes || item.partname} ×${item.box_size}`, 'ok');
      found.innerHTML = `<div class="card" style="background:#f0fff4;border:1px solid #1a7a3a"><b>${escapeHtml(item.partdes || item.partname)}</b> — נוסף לסל (${item.box_size} יח׳)</div>`;
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : String(ex);
      if (msg === 'not_found') toast(`ברקוד ${code} לא נמצא בקטלוג`, 'error');
      else toast(msg, 'error');
    } finally {
      busy = false;
    }
  };

  (shell.querySelector('#scan-lookup') as HTMLButtonElement).onclick = () => {
    const code = (shell.querySelector('#scan-manual') as HTMLInputElement).value.trim();
    if (code) void lookup(code);
  };
  (shell.querySelector('#scan-manual') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (shell.querySelector('#scan-lookup') as HTMLButtonElement).click();
  });

  if (!hasDetector) return;
  const video = shell.querySelector('#scan-video') as HTMLVideoElement;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    if (!document.body.contains(video)) {
      cleanup();
      return;
    } // navigated away while awaiting
    video.srcObject = stream;
    await video.play();
    const detector = new BD({ formats: ['ean_13', 'ean_8', 'code_128', 'upc_a', 'upc_e', 'code_39'] });
    timer = setInterval(async () => {
      if (busy || video.readyState < 2) return;
      try {
        const codes = await detector.detect(video);
        if (!codes.length) return;
        const code = String(codes[0].rawValue || '').trim();
        const now = Date.now();
        if (!code || (code === lastCode && now - lastAt < 2500)) return;
        lastCode = code;
        lastAt = now;
        await lookup(code);
      } catch {
        /* transient */
      }
    }, 350);
  } catch {
    if (status) status.textContent = 'לא ניתן לגשת למצלמה — הקלידו את הברקוד ידנית.';
  }
}
