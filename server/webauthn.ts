// WebAuthn passkeys (Face ID / fingerprint) layered on top of password login.
// Uses @simplewebauthn/server. RP_ID and WEB_ORIGIN must be set for the exact
// production host; routes 503 until they are (premature enrollment is impossible
// — a passkey enrolled against the wrong RP ID can't be used after a domain move).

import crypto from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { db } from './db.js';

const RP_NAME = 'אורגת B2B';
const CHALLENGE_TTL_SEC = 120;

export function webauthnConfig(): { rpID: string; origin: string } | null {
  const rpID = process.env.RP_ID?.trim();
  const origin = (process.env.WEB_ORIGIN || process.env.APP_ORIGIN)?.trim().replace(/\/+$/, '');
  if (!rpID || !origin) return null;
  return { rpID, origin };
}

export function webauthnEnabled(): boolean {
  return webauthnConfig() !== null;
}

const b64u = {
  enc: (buf: Uint8Array | Buffer): string => Buffer.from(buf).toString('base64url'),
  // Copy into a freshly-allocated ArrayBuffer-backed Uint8Array (the type the
  // @simplewebauthn API expects — Node Buffers are ArrayBufferLike-backed).
  dec: (s: string): Uint8Array<ArrayBuffer> => {
    const b = Buffer.from(s, 'base64url');
    const u = new Uint8Array(b.byteLength);
    u.set(b);
    return u;
  },
};

interface CredRow {
  id: number;
  user_id: number;
  cred_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

// --- challenge store (single-use, short TTL) ---
function storeChallenge(challenge: string, type: 'register' | 'login', userId: number | null): string {
  const id = crypto.randomBytes(18).toString('base64url');
  db.prepare(
    `INSERT INTO auth_challenges (id, challenge, user_id, type, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+${CHALLENGE_TTL_SEC} seconds'))`
  ).run(id, challenge, userId, type);
  return id;
}
function consumeChallenge(id: string, type: 'register' | 'login'): { challenge: string; user_id: number | null } | null {
  const row = db
    .prepare(
      `SELECT challenge, user_id FROM auth_challenges
       WHERE id = ? AND type = ? AND datetime(expires_at) > datetime('now')`
    )
    .get(id, type) as { challenge: string; user_id: number | null } | undefined;
  if (row) db.prepare('DELETE FROM auth_challenges WHERE id = ?').run(id);
  return row ?? null;
}
export function sweepChallenges(): void {
  db.prepare(`DELETE FROM auth_challenges WHERE datetime(expires_at) <= datetime('now')`).run();
}

export function listUserCredentials(userId: number): CredRow[] {
  return db
    .prepare('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId) as CredRow[];
}

// --- registration (requires an authenticated user) ---
export async function registrationOptions(userId: number, username: string) {
  const cfg = webauthnConfig()!;
  const existing = listUserCredentials(userId);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: cfg.rpID,
    userID: new Uint8Array(Buffer.from(String(userId))),
    userName: username,
    userDisplayName: username,
    attestationType: 'none',
    authenticatorSelection: {
      residentKey: 'required',
      requireResidentKey: true,
      userVerification: 'preferred',
    },
    excludeCredentials: existing.map((c) => ({ id: c.cred_id, transports: parseTransports(c.transports) })),
  });
  const challengeId = storeChallenge(options.challenge, 'register', userId);
  return { options, challengeId };
}

export async function verifyRegistration(
  userId: number,
  challengeId: string,
  response: any,
  deviceName: string
): Promise<boolean> {
  const cfg = webauthnConfig()!;
  const stored = consumeChallenge(challengeId, 'register');
  if (!stored || stored.user_id !== userId) return false;
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpID,
      requireUserVerification: false,
    });
  } catch {
    return false;
  }
  if (!verification.verified || !verification.registrationInfo) return false;
  const { credential } = verification.registrationInfo;
  db.prepare(
    `INSERT INTO webauthn_credentials (user_id, cred_id, public_key, counter, transports, device_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(cred_id) DO NOTHING`
  ).run(
    userId,
    credential.id,
    b64u.enc(credential.publicKey),
    credential.counter ?? 0,
    JSON.stringify(credential.transports ?? []),
    deviceName.slice(0, 60) || 'מכשיר'
  );
  return true;
}

// --- usernameless login (discoverable credentials) ---
export async function authenticationOptions() {
  const cfg = webauthnConfig()!;
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpID,
    userVerification: 'preferred',
    allowCredentials: [], // discoverable — the authenticator offers its resident creds
  });
  const challengeId = storeChallenge(options.challenge, 'login', null);
  return { options, challengeId };
}

/** Returns the user_id on success, or null. Updates the signature counter. */
export async function verifyAuthentication(challengeId: string, response: any): Promise<number | null> {
  const cfg = webauthnConfig()!;
  const stored = consumeChallenge(challengeId, 'login');
  if (!stored) return null;
  const cred = db
    .prepare('SELECT * FROM webauthn_credentials WHERE cred_id = ?')
    .get(response?.id) as CredRow | undefined;
  if (!cred) return null;
  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: cfg.origin,
      expectedRPID: cfg.rpID,
      requireUserVerification: false,
      credential: {
        id: cred.cred_id,
        publicKey: b64u.dec(cred.public_key),
        counter: cred.counter,
        transports: parseTransports(cred.transports),
      },
    });
    if (!verification.verified) return null;
    // Counter anomalies are logged, not fatal: synced passkeys (iCloud/Google) report 0.
    db.prepare(
      `UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?`
    ).run(verification.authenticationInfo.newCounter, cred.id);
    return cred.user_id;
  } catch {
    return null;
  }
}

export function renameCredential(userId: number, id: number, name: string): boolean {
  return (
    db
      .prepare('UPDATE webauthn_credentials SET device_name = ? WHERE id = ? AND user_id = ?')
      .run(name.slice(0, 60), id, userId).changes > 0
  );
}
export function deleteCredential(userId: number, id: number): boolean {
  return db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function parseTransports(s: string | null): any[] | undefined {
  if (!s) return undefined;
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) && a.length ? a : undefined;
  } catch {
    return undefined;
  }
}
