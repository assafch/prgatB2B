// Tiny fetch wrapper. Always sends cookies. Throws on non-2xx with the server's error message.

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
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
  custname: string | null;
  cust_desc: string | null;
}
