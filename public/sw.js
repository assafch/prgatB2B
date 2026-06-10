// prgatB2B service worker.
//
// Policy (P0 security gate): cache-first for STATIC assets only; /api/* and
// /uploads/* are never touched (network-only) so authenticated/financial
// responses can never land in a shared cache. Navigations are network-first
// with the cached shell as the offline fallback.
//
// Bump CACHE_VERSION on breaking shell changes; hashed asset filenames make
// stale subresources unlikely either way.
const CACHE_VERSION = 'v1';
const CACHE = `prgat-static-${CACHE_VERSION}`;
const SHELL = ['/', '/manifest.json'];
const STATIC_RE = /^\/(assets|fonts|icons)\//;

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page shows an update toast and the user opts in.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Network-only: API and customer-specific images. The browser handles them
  // normally when this handler returns without respondWith.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;

  // App navigations: network-first, cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Only a healthy response may become the offline shell — caching a 5xx
          // error page would serve it to every offline user.
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets: cache-first.
  if (STATIC_RE.test(url.pathname) || url.pathname === '/manifest.json') {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
  }
});
