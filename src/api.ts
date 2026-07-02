// Tiny fetch wrapper. Always sends cookies. Throws on non-2xx with the server's error message.

// Global "thinking circle": a spinning ring shown whenever a request is in flight.
// A 150ms delay means instant (cached) responses never flash it.
let pending = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;
function spinnerEl(): HTMLElement {
  let el = document.getElementById('req-spin');
  if (!el) {
    el = document.createElement('div');
    el.id = 'req-spin';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  return el;
}
function loadStart(): void {
  pending++;
  if (pending === 1) showTimer = setTimeout(() => spinnerEl().classList.add('active'), 150);
}
function loadEnd(): void {
  pending = Math.max(0, pending - 1);
  if (pending === 0) {
    if (showTimer) {
      clearTimeout(showTimer);
      showTimer = undefined;
    }
    spinnerEl().classList.remove('active');
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  loadStart();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } finally {
    loadEnd();
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    // Session expired mid-flow (idle/absolute timeout): remember where the user
    // was, send them to login; main.ts restores the hash after a successful login.
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      const here = location.hash;
      if (here && here !== '#login') sessionStorage.setItem('prgat_post_login_hash', here);
      // The router must drop its cached identity BEFORE navigating — otherwise
      // route() sees the stale user and bounces '#login' straight back to '#home',
      // which 401s again: an infinite flicker loop with no way to log in.
      window.dispatchEvent(new Event('prgat:auth-expired'));
      location.hash = '#login';
    }
    const msg =
      (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).error)
        : '') || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, body?: unknown) => request<T>('POST', p, body),
  put: <T>(p: string, body?: unknown) => request<T>('PUT', p, body),
  patch: <T>(p: string, body?: unknown) => request<T>('PATCH', p, body),
  del: <T>(p: string) => request<T>('DELETE', p),
};

export interface MeUser {
  id: number;
  username: string;
  role: 'customer' | 'admin';
  customer_role?: 'owner' | 'orderer';
  custname: string | null;
  cust_desc: string | null;
}
