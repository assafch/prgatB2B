// Service-worker registration + update toast.
// Production-only: in dev Vite serves modules directly and SW caching would
// only get in the way.

export function registerPwa(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');

      // A new version is already waiting (page was reopened after a deploy).
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateToast(reg);

      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(reg);
          }
        });
      });

      // After SKIP_WAITING the new worker takes control — reload once. On the very
      // FIRST install there was no controller before, and clients.claim() also
      // fires controllerchange — reloading then would yank the page out from under
      // every user mid-session, so only reload when replacing an old controller.
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloaded) return;
        reloaded = true;
        location.reload();
      });
    } catch {
      // SW is progressive enhancement — never break the app over it.
    }
  });
}

function showUpdateToast(reg: ServiceWorkerRegistration): void {
  if (document.getElementById('pwa-update-toast')) return;
  const toast = document.createElement('div');
  toast.id = 'pwa-update-toast';
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'position:fixed',
    'bottom:1rem',
    'inset-inline-start:50%',
    'transform:translateX(50%)',
    'background:#1f2937',
    'color:#fff',
    'padding:0.75rem 1rem',
    'border-radius:10px',
    'display:flex',
    'gap:0.75rem',
    'align-items:center',
    'box-shadow:0 4px 12px rgba(0,0,0,0.25)',
    'z-index:1000',
    'font-size:0.95rem',
  ].join(';');

  const text = document.createElement('span');
  text.textContent = 'גרסה חדשה זמינה';

  const btn = document.createElement('button');
  btn.textContent = 'רענון';
  btn.style.cssText =
    'background:#fff;color:#1f2937;border:none;border-radius:8px;padding:0.4rem 0.9rem;font-weight:700;cursor:pointer';
  btn.addEventListener('click', () => {
    reg.waiting?.postMessage('SKIP_WAITING');
    btn.disabled = true;
  });

  toast.append(text, btn);
  document.body.appendChild(toast);
}
