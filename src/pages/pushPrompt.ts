import { pushSupported, enablePush } from '../push.js';
import { toast } from '../ui.js';

const DISMISS_KEY = 'push_optin_dismissed_until';
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

function dismissedActive(): boolean {
  const v = Number(localStorage.getItem(DISMISS_KEY) || 0);
  return isFinite(v) && v > Date.now();
}

/** iOS Safari NOT installed as a PWA — web push needs Add-to-Home-Screen (iOS 16.4+). */
export function iosNeedsInstall(): boolean {
  const ua = navigator.userAgent || '';
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  return isIos && !standalone;
}

/** Offer the enable-notifications prompt? Only when supported, not yet decided, not dismissed. */
export function shouldOfferPush(): boolean {
  try {
    if (!pushSupported()) return false;
    if (Notification.permission !== 'default') return false;
    if (dismissedActive()) return false;
    return true;
  } catch {
    return false;
  }
}

/** Inject the opt-in card into `host` when relevant; otherwise do nothing. */
export function renderPushCard(host: HTMLElement, opts: { compact?: boolean } = {}): void {
  void opts; // reserved for future compact variant styling
  if (host.querySelector('#push-optin')) return; // don't duplicate

  if (iosNeedsInstall() && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    const el = document.createElement('div');
    el.id = 'push-optin';
    el.className = 'card';
    el.style.cssText = 'border:1px solid var(--border);margin:0.6rem 0';
    el.innerHTML = `<div style="font-weight:700">🔔 קבלת התראות</div><div class="muted" style="font-size:0.88rem;margin-top:0.25rem">להפעלת התראות באייפון: כפתור השיתוף ← "הוסף למסך הבית", ואז פתחו את האפליקציה מהמסך.</div>`;
    host.prepend(el);
    return;
  }

  if (!shouldOfferPush()) return;

  const el = document.createElement('div');
  el.id = 'push-optin';
  el.className = 'card';
  el.style.cssText = 'border:1px solid var(--border);margin:0.6rem 0';
  el.innerHTML = `
    <div style="font-weight:700">🔔 קבלו עדכון כשההזמנה מאושרת ובתשלומים</div>
    <div style="display:flex;gap:0.5rem;margin-top:0.6rem">
      <button id="push-enable" class="es-cta" style="flex:1">אפשר התראות</button>
      <button id="push-later" class="ghost">אחר כך</button>
    </div>`;
  host.prepend(el);

  el.querySelector('#push-enable')!.addEventListener('click', async () => {
    const btn = el.querySelector('#push-enable') as HTMLButtonElement;
    btn.disabled = true;
    try {
      await enablePush();
      toast('התראות הופעלו ✓', 'ok');
      localStorage.removeItem(DISMISS_KEY);
      el.remove();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'הפעלת ההתראות נכשלה', 'error');
      btn.disabled = false;
    }
  });

  el.querySelector('#push-later')!.addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + COOLDOWN_MS));
    el.remove();
  });
}
