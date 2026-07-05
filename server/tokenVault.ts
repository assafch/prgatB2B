// PSP card-token vault: AES-256-GCM string encryption. Key: CARD_TOKEN_KEY (64-hex),
// falls back to CHECK_IMAGE_KEY so no new prod secret is required. blob format:
// base64([12 iv][16 tag][ciphertext]). No key configured → null (feature dark).
import crypto from 'node:crypto';

function vaultKey(): Buffer | null {
  const hex = (process.env.CARD_TOKEN_KEY || process.env.CHECK_IMAGE_KEY || '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

export function tokenVaultReady(): boolean {
  return vaultKey() !== null;
}

export function encryptToken(plain: string): string | null {
  const key = vaultKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decryptToken(blob: string): string | null {
  const key = vaultKey();
  if (!key) return null;
  try {
    const b = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
