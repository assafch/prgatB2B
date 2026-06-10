// Web-push notifications. VAPID keys are generated once and stored in settings
// (so no env wiring / redeploy is needed); subscriptions live in push_subscriptions.

import webpush from 'web-push';
import { db, getSetting, setSetting } from './db.js';

let configured = false;
function ensureConfigured(): void {
  if (configured) return;
  let pub = getSetting('push_vapid_public');
  let priv = getSetting('push_vapid_private');
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    setSetting('push_vapid_public', pub);
    setSetting('push_vapid_private', priv);
  }
  webpush.setVapidDetails('mailto:Assaf@orgat.co.il', pub, priv);
  configured = true;
}

export function vapidPublicKey(): string {
  ensureConfigured();
  return getSetting('push_vapid_public') || '';
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

interface SubRow {
  endpoint: string;
  sub_json: string;
}

export function saveSubscription(userId: number, custname: string | null, sub: { endpoint?: string }): void {
  if (!sub || !sub.endpoint) throw new Error('bad_subscription');
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, custname, endpoint, sub_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, custname = excluded.custname, sub_json = excluded.sub_json`
  ).run(userId, custname, sub.endpoint, JSON.stringify(sub));
}

export function removeSubscription(endpoint: string): void {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

async function sendTo(rows: SubRow[], payload: PushPayload): Promise<number> {
  if (!rows.length) return 0;
  ensureConfigured();
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification(JSON.parse(r.sub_json), body);
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number })?.statusCode;
        if (code === 404 || code === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(r.endpoint);
      }
    })
  );
  return sent;
}

/** Fire-and-forget: never let a push failure break the calling request. */
export function notifyUser(userId: number, payload: PushPayload): void {
  const rows = db.prepare('SELECT endpoint, sub_json FROM push_subscriptions WHERE user_id = ?').all(userId) as SubRow[];
  void sendTo(rows, payload).catch(() => {});
}

export async function broadcast(payload: PushPayload): Promise<number> {
  const rows = db.prepare('SELECT endpoint, sub_json FROM push_subscriptions').all() as SubRow[];
  return sendTo(rows, payload);
}
