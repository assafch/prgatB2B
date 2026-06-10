// Passkey (WebAuthn) client helpers. Thin wrappers over @simplewebauthn/browser
// + the server ceremony endpoints.
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api } from './api.js';

export function supportsPasskeys(): boolean {
  return browserSupportsWebAuthn();
}

let cachedServerEnabled: boolean | null = null;
export async function serverPasskeysEnabled(): Promise<boolean> {
  if (cachedServerEnabled !== null) return cachedServerEnabled;
  try {
    const { webauthn } = await api.get<{ webauthn: boolean }>('/api/auth/capabilities');
    cachedServerEnabled = webauthn; // cache only a real answer
    return webauthn;
  } catch {
    return false; // transient failure — don't cache, retry next time
  }
}

// True when the user cancelled/declined the ceremony (don't show a scary error).
export function isPasskeyCancel(ex: unknown): boolean {
  const name = ex instanceof Error ? ex.name : '';
  const msg = ex instanceof Error ? ex.message : String(ex);
  return /NotAllowedError|AbortError/.test(name) || /NotAllowed|AbortError|cancel|timed out/i.test(msg);
}

/** Usernameless login. Throws on failure/cancel. */
export async function passkeyLogin(): Promise<void> {
  const { options, challengeId } = await api.post<{ options: unknown; challengeId: string }>(
    '/api/webauthn/login/options'
  );
  const response = await startAuthentication({ optionsJSON: options as any });
  await api.post('/api/webauthn/login/verify', { challengeId, response });
}

/** Enroll the current device (requires an authenticated session). */
export async function passkeyRegister(deviceName: string): Promise<void> {
  const { options, challengeId } = await api.post<{ options: unknown; challengeId: string }>(
    '/api/webauthn/register/options'
  );
  const response = await startRegistration({ optionsJSON: options as any });
  await api.post('/api/webauthn/register/verify', { challengeId, response, deviceName });
}
