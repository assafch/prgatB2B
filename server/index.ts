// prgatB2B server entry — Express, all routes mounted here.

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

import { db, getSetting, getSettingBool, setSetting, setSettingBool, getAllSettings } from './db.js';
import { listAllUsers, createCustomerLogin, resetUserPassword, setUserStatus, updateCustomerDetails, deleteCustomerUser } from './adminUsers.js';
import { getRevenueByMonth, getTopProducts, getTopDebtors, getInactiveCustomers } from './analytics.js';
import { runAssistant, assistantEnabled } from './assistant.js';
import { createCardDebtIntent, createCardPartialIntent, createCardOrderIntent, chargeSavedCard, unreconciledCardTotal, getCardForUser, confirmCard, listAllCardPayments, recordTranzilaIndex, activeCardProvider, expireStaleCardIntents } from './cardPayments.js';
import { getSavedCard, deleteSavedCard } from './savedCards.js';
import * as payplus from './payplus.js';
import { listPromotions, createPromotion, updatePromotion, deletePromotion, type PromoInput } from './promotions.js';
import { saveTemplate, listTemplates, applyTemplate, deleteTemplate, toggleFavorite, listFavorites } from './templates.js';
import { listStaff, createStaff, setStaffStatus, resetStaffPassword } from './staff.js';
import { vapidPublicKey, saveSubscription, removeSubscription, notifyUser, broadcast } from './push.js';
import { createLoginLink, redeemLoginLink } from './loginLinks.js';
import {
  accountLockSeconds,
  bootstrapAdmin,
  clearFailedLogins,
  clearSessionCookie,
  createSession,
  destroySession,
  destroySessionById,
  equalizeLoginTiming,
  hashPassword,
  listSessions,
  loadUser,
  recordFailedLogin,
  requireAdmin,
  requireAuth,
  requireCustomer,
  requireOwner,
  revokeOtherSessions,
  setSessionCookie,
  sweepSessions,
  tokenFromRequest,
  validatePassword,
  validateUsername,
  verifyPassword,
  type AuthedRequest,
} from './auth.js';
import {
  findByBarcode,
  getProduct,
  getSimilarProducts,
  listFamiliesLocal,
  queryCatalog,
  refreshCatalogFromPriority,
  refreshCustomerPricing,
} from './catalog.js';
import {
  clearCart,
  getCart,
  getLocalOrder,
  listLocalOrders,
  listPriorityOrders,
  listStuckOrders,
  OrderError,
  payHeldOrderByCheck,
  recoverStuckSubmittingOrders,
  reorderToCart,
  resendApprovedOrder,
  setCartLine,
  submitOrder,
  sweepPendingOrders,
} from './orders.js';
import { sweepPendingReceipts, listFailedReceipts, failedReceiptCount } from './priorityReceipts.js';
import { getOpsQueues, getRecentActivity } from './opsQueue.js';
import { acceptInvite, createInvite, getInvite, listInvites } from './invites.js';
import { createLead, listLeads, updateLeadStatus } from './leads.js';
import { getPriorityConfig, listCustomers } from './priority.js';
import { listCustomersAdmin, getCustomerAdmin, patchCustomer, batchUpdateCustomers, resetCustomerPortal } from './customers.js';
import { getAccountSummary, getInvoices, getInvoiceDetail, getUnpaidInvoices, warmFinance } from './finance.js';
import { refreshCustomerDiscounts, sweepCustomerDiscounts } from './discounts.js';
import {
  bulkUpdate,
  batchUpdate,
  deleteImage,
  exportCsv,
  getProductAdmin,
  importCsv,
  listProductsAdmin,
  patchProduct,
  saveImage,
  savePromoImage,
  upload,
  UPLOADS_DIR,
} from './products.js';
import { scheduleSnapshots } from './backup.js';
import { getHomeData } from './home.js';
import { buildCheckoutPreview } from './checkoutPreview.js';
import { VAT_RATE } from './money.js';
import { getReorderSuggestions } from './reorder.js';
import multer from 'multer';
import { extractCheck, checkOcrEnabled, prepareCheckImage } from './checkOcr.js';
import {
  createCheckDraft,
  confirmCheck,
  listChecksForUser,
  getCheckForUser,
  decryptCheckImage,
  listAllChecks,
  getCheckAny,
  setCheckStatus,
  imageStorageEnabled,
  sweepDraftChecks,
  type CheckRow,
} from './payments.js';
import {
  webauthnEnabled,
  registrationOptions,
  verifyRegistration,
  authenticationOptions,
  verifyAuthentication,
  listUserCredentials,
  deleteCredential,
  renameCredential,
  sweepChallenges,
} from './webauthn.js';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// Exactly one trusted hop (Railway's proxy) in production. Trusting a hop in
// direct-connection dev would let clients spoof req.ip via X-Forwarded-For and
// dodge the per-IP limiters.
app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.disable('x-powered-by'); // don't advertise Express

// Request ID — correlates client-facing errors with server logs without leaking detail.
declare module 'express-serve-static-core' {
  interface Request {
    reqId?: string;
  }
}
app.use((req, _res, next) => {
  req.reqId = crypto.randomBytes(6).toString('hex');
  next();
});

/** Wrap async handlers so rejections reach the global error handler (Express 4
 * does not do this on its own — an uncaught rejection would crash the process). */
const ah =
  (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req as AuthedRequest, res).catch(next);
  };

// Security headers on every response. The strict CSP/HSTS are production-only so
// they don't break the Vite dev server (HMR uses inline scripts, eval, websockets).
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  // camera=(self): the cheque scanner + barcode scanner use getUserMedia on our own
  // origin — an empty allowlist would reject it even same-origin (prod-only outage).
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self), payment=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join('; ')
    );
  }
  next();
});

// CSRF defense-in-depth (on top of SameSite=Lax cookies): every mutating /api
// request that carries a browser Origin/Referer must match our own origin.
// Requests with neither header are non-browser clients — a browser that can attach
// a victim's cookie always sends Origin on cross-site POSTs, so they pass.
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function allowedOrigins(req: Request): Set<string> {
  const set = new Set<string>();
  for (const o of (process.env.APP_ORIGIN || '').split(',')) {
    const v = o.trim().replace(/\/+$/, '');
    if (v) set.add(v);
  }
  // Same-origin for this request (correct behind Railway's proxy via trust proxy).
  set.add(`${req.protocol}://${req.get('host')}`);
  if (process.env.NODE_ENV !== 'production') {
    set.add('http://localhost:5175');
    set.add('http://127.0.0.1:5175');
    set.add('http://localhost:5173');
  }
  return set;
}
app.use('/api', (req, res, next) => {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }
  let origin: string | null = (req.headers.origin as string | undefined) ?? null;
  if (!origin && req.headers.referer) {
    try {
      origin = new URL(req.headers.referer).origin;
    } catch {
      origin = null;
    }
  }
  if (origin && !allowedOrigins(req).has(origin)) {
    console.warn(`[csrf] [${req.reqId}] blocked ${req.method} ${req.path} from origin ${origin}`);
    res.status(403).json({ error: 'bad_origin' });
    return;
  }
  next();
});

// Body parsing AFTER the origin check — rejected cross-site requests shouldn't
// cost JSON parsing.
app.use(
  express.json({
    limit: '2mb',
    // Stash the raw bytes ONLY for the PayPlus IPN — its HMAC 'hash' must be verified
    // against the exact body PayPlus signed (re-serializing would change the digest).
    verify: (req, _res, buf) => {
      if (req.url?.startsWith('/api/payments/payplus/ipn')) {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      }
    },
  })
);
app.use(loadUser);

// Public uploads (product images). Cached aggressively since filenames are content-hashed.
app.use(
  '/uploads',
  express.static(UPLOADS_DIR, {
    maxAge: '7d',
    etag: true,
  })
);

// ---------- Health ----------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---------- Rate limits ----------
// Per-IP login throttle + a global cap (one IP per attempt can't be the only guard
// against distributed credential-stuffing; per-ACCOUNT lockout lives in auth.ts).
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10 });
// Catastrophic backstop only. Deliberately high: a low global cap would itself be
// a cheap site-wide login DoS (review finding) — sustaining 600/min already needs
// 60+ IPs past the per-IP limiter, and per-account lockout blunts what gets through.
const globalLoginLimiter = rateLimit({ windowMs: 60_000, max: 600, keyGenerator: () => 'global' });
// Throttle unauthenticated, state-changing / probe-able public endpoints
// (invite lookup + accept, lead capture) to deter token brute-force and spam.
const publicLimiter = rateLimit({ windowMs: 60_000, max: 20 });

// Per-USER limiters for authenticated routes (mounted after the auth guard, so
// req.user always exists). They protect the shared 100-calls/min Priority quota
// and stop order/upload spam from a compromised account.
const userKey = (req: Request) => `u:${(req as AuthedRequest).user!.id}`;
const perUser = (windowMs: number, max: number) =>
  rateLimit({ windowMs, max, keyGenerator: userKey });
// Order caps count only SUCCESSFUL submissions — a Priority outage must not burn
// the customer's retry budget (skipFailedRequests skips status >= 400).
const ordersMinuteLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: userKey,
  skipFailedRequests: true,
});
const ordersDailyLimiter = rateLimit({
  windowMs: 86_400_000,
  max: 30,
  keyGenerator: userKey,
  skipFailedRequests: true,
});
const cartLimiter = perUser(60_000, 60);
const financeLimiter = perUser(60_000, 20);
// Home is the post-login landing and is re-pulled by checkout — give it its own,
// roomier bucket so bouncing between screens can't 429 the dashboard. Underlying
// Priority load is already shielded by the 5-min finance memo.
const homeLimiter = perUser(60_000, 60);
const sensitiveLimiter = perUser(60_000, 5); // password change etc.
// Separate buckets: a CSV import dry-run + real-run pair must not eat the budget
// of a bulk image-upload session (review finding).
const csvImportLimiter = perUser(60_000, 10);
const imageUploadLimiter = perUser(60_000, 20);
const adminHeavyLimiter = perUser(60_000, 4); // full catalog/pricing refresh hits Priority hard
const adminAnalyticsLimiter = perUser(60_000, 30); // analytics is cached server-side; this just bounds abuse

// Maintenance mode: block transactional customer actions (ordering, paying) while
// reads stay up so the customer still sees the maintenance notice on the home screen.
function blockIfMaintenance(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (getSettingBool('maintenance_enabled', false)) {
    res.status(503).json({ error: getSetting('maintenance_message') || 'המערכת בתחזוקה זמנית. נחזור בקרוב.' });
    return;
  }
  next();
}

/**
 * Error text that is safe to return to an ADMIN client: ERP failures can embed
 * entire OData payloads/URLs — log those server-side, return a short prefix only.
 * Customer-facing routes must NOT use this; they return fixed Hebrew messages.
 */
function redactedError(reqId: string | undefined, context: string, err: unknown): string {
  console.error(`[${context}] [${reqId ?? '-'}]`, err);
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
}

// ---------- Auth ----------

app.post('/api/auth/login', globalLoginLimiter, loginLimiter, ah(async (req, res) => {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'missing_credentials' });
    return;
  }
  const user = db
    .prepare(`SELECT * FROM users WHERE username = ? AND status = 'active'`)
    .get(username) as any;
  if (!user) {
    // Burn the same time as a real bcrypt check so response timing can't reveal
    // whether the username exists (anti-enumeration).
    await equalizeLoginTiming(password);
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  // Per-account exponential lockout (5 failures → 1 min, doubling, capped 60 min).
  const lockSeconds = accountLockSeconds(user);
  if (lockSeconds > 0) {
    res.status(429).json({ error: 'account_locked', retry_after_seconds: lockSeconds });
    return;
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    recordFailedLogin(user.id);
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  clearFailedLogins(user.id);
  // Session rotation: a login always issues a fresh token; any session already on
  // this browser is revoked so the old cookie value dies with it.
  const oldToken = tokenFromRequest(req);
  if (oldToken) destroySession(oldToken);
  const token = createSession(user.id, user.role, req.ip, req.headers['user-agent']);
  setSessionCookie(res, token, user.role);
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  // Warm the finance snapshot in the background so the first dashboard load is instant.
  if (user.role === 'customer' && user.custname) {
    warmFinance(user.custname);
    // Fire-and-forget: first catalog paint uses whatever is cached; this refreshes for next time.
    refreshCustomerDiscounts(user.custname).catch(() => {});
  }
  res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      customer_role: user.customer_role,
      custname: user.custname,
      cust_desc: user.cust_desc,
    },
  });
}));

// Redeem a magic login link → ordinary customer session. Same limiters as
// password login (the token is unguessable, but stay conservative). Both
// limiters here key off req.ip (loginLimiter has no custom keyGenerator, so it
// falls back to express-rate-limit's IP-based default) — neither depends on
// req.body.username, which this route never has, so no adjustment was needed.
app.post('/api/auth/link', globalLoginLimiter, loginLimiter, (req, res) => {
  const token = typeof (req.body || {}).token === 'string' ? (req.body as { token: string }).token : '';
  const hit = token ? redeemLoginLink(token) : null;
  if (!hit) {
    res.status(401).json({ error: 'הקישור אינו תקף — בקשו קישור חדש' });
    return;
  }
  // Session rotation: a login always issues a fresh token; any session already on
  // this browser is revoked so the old cookie value dies with it.
  const oldToken = tokenFromRequest(req);
  if (oldToken) destroySession(oldToken);
  const sessionToken = createSession(hit.userId, 'customer', req.ip, req.headers['user-agent'] as string | undefined);
  setSessionCookie(res, sessionToken, 'customer');
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(hit.userId);
  // Warm the finance snapshot in the background so the first dashboard load is instant.
  const linkUser = db.prepare(`SELECT custname FROM users WHERE id = ?`).get(hit.userId) as
    | { custname: string | null }
    | undefined;
  if (linkUser?.custname) {
    warmFinance(linkUser.custname);
    // Fire-and-forget: first catalog paint uses whatever is cached; this refreshes for next time.
    refreshCustomerDiscounts(linkUser.custname).catch(() => {});
  }
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  const token = tokenFromRequest(req);
  if (token) destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', requireAuth, sensitiveLimiter, ah(async (req, res) => {
  const { current_password, new_password } = (req.body || {}) as {
    current_password?: string;
    new_password?: string;
  };
  if (!current_password || !new_password) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  const policyError = validatePassword(new_password, req.user!.username);
  if (policyError) {
    res.status(400).json({ error: policyError });
    return;
  }
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user!.id) as
    | { password_hash: string }
    | undefined;
  if (!row || !(await verifyPassword(current_password, row.password_hash))) {
    res.status(401).json({ error: 'סיסמה נוכחית שגויה' });
    return;
  }
  const hash = await hashPassword(new_password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user!.id);
  // Anyone else holding this account's session (e.g. a stolen device) is kicked out.
  revokeOtherSessions(req.user!.id, req.sessionId);
  // ...and any passkey enrolled by an attacker during a hijacked session is killed,
  // so a passkey can't outlive the password reset the user did to recover the account.
  db.prepare('DELETE FROM webauthn_credentials WHERE user_id = ?').run(req.user!.id);
  res.json({ ok: true });
}));

app.get('/api/auth/sessions', requireAuth, (req: AuthedRequest, res) => {
  res.json({ sessions: listSessions(req.user!.id, req.sessionId) });
});

app.delete('/api/auth/sessions/:id', requireAuth, (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'bad_id' });
    return;
  }
  const removed = destroySessionById(req.user!.id, id);
  if (!removed) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (id === req.sessionId) clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/sessions/revoke-others', requireAuth, (req: AuthedRequest, res) => {
  const revoked = revokeOtherSessions(req.user!.id, req.sessionId);
  res.json({ ok: true, revoked });
});

// ---------- WebAuthn / passkeys (Face ID / fingerprint) ----------
const passkeyLimiter = rateLimit({ windowMs: 60_000, max: 30 });
function requireWebauthn(_req: Request, res: Response, next: NextFunction): void {
  if (!webauthnEnabled()) {
    res.status(503).json({ error: 'webauthn_not_configured' });
    return;
  }
  next();
}

app.get('/api/auth/capabilities', (_req, res) => {
  res.json({ webauthn: webauthnEnabled() });
});

// Enrollment (requires a fresh authenticated session).
app.post('/api/webauthn/register/options', requireAuth, requireWebauthn, passkeyLimiter, ah(async (req, res) => {
  const { options, challengeId } = await registrationOptions(req.user!.id, req.user!.username);
  res.json({ options, challengeId });
}));

app.post('/api/webauthn/register/verify', requireAuth, requireWebauthn, passkeyLimiter, ah(async (req, res) => {
  const { challengeId, response, deviceName } = (req.body || {}) as {
    challengeId?: string; response?: unknown; deviceName?: string;
  };
  if (!challengeId || !response) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  const ok = await verifyRegistration(req.user!.id, challengeId, response, String(deviceName || 'מכשיר'));
  if (!ok) {
    res.status(400).json({ error: 'רישום המפתח נכשל. נסו שוב.' });
    return;
  }
  res.json({ ok: true });
}));

// Usernameless login.
app.post('/api/webauthn/login/options', requireWebauthn, passkeyLimiter, ah(async (_req, res) => {
  const { options, challengeId } = await authenticationOptions();
  res.json({ options, challengeId });
}));

app.post('/api/webauthn/login/verify', requireWebauthn, passkeyLimiter, ah(async (req, res) => {
  const { challengeId, response } = (req.body || {}) as { challengeId?: string; response?: unknown };
  if (!challengeId || !response) {
    res.status(400).json({ error: 'missing_fields' });
    return;
  }
  const userId = await verifyAuthentication(challengeId, response);
  if (!userId) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  const user = db
    .prepare(`SELECT id, username, role, custname, cust_desc FROM users WHERE id = ? AND status = 'active'`)
    .get(userId) as
    | { id: number; username: string; role: 'customer' | 'admin'; custname: string | null; cust_desc: string | null }
    | undefined;
  if (!user) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  // Same session path as password login (rotation + role-based TTL cookie).
  const oldToken = tokenFromRequest(req);
  if (oldToken) destroySession(oldToken);
  const token = createSession(user.id, user.role, req.ip, req.headers['user-agent']);
  setSessionCookie(res, token, user.role);
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  res.json({ user });
}));

app.get('/api/auth/passkeys', requireAuth, passkeyLimiter, (req: AuthedRequest, res) => {
  const list = listUserCredentials(req.user!.id).map((c) => ({
    id: c.id,
    device_name: c.device_name,
    created_at: c.created_at,
    last_used_at: c.last_used_at,
  }));
  res.json({ passkeys: list, webauthn: webauthnEnabled() });
});

app.patch('/api/auth/passkeys/:id', requireAuth, passkeyLimiter, (req: AuthedRequest, res) => {
  const { name } = (req.body || {}) as { name?: string };
  if (!name) {
    res.status(400).json({ error: 'name_required' });
    return;
  }
  const ok = renameCredential(req.user!.id, Number(req.params.id), name);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});

app.delete('/api/auth/passkeys/:id', requireAuth, passkeyLimiter, (req: AuthedRequest, res) => {
  const ok = deleteCredential(req.user!.id, Number(req.params.id));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});

app.get('/api/auth/me', (req: AuthedRequest, res: Response) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  res.json({
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role,
      customer_role: req.user.customer_role,
      custname: req.user.custname,
      cust_desc: req.user.cust_desc,
    },
  });
});

// ---------- Invites (public) ----------
app.get('/api/invites/:token', publicLimiter, (req, res) => {
  const inv = getInvite(req.params.token);
  if (!inv) {
    res.status(404).json({ error: 'invite_invalid' });
    return;
  }
  res.json({ custname: inv.custname, cust_desc: inv.cust_desc, email: inv.email, phone: inv.phone });
});

app.post('/api/invites/:token/accept', publicLimiter, ah(async (req, res) => {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  if (!username || !password) {
    res.status(400).json({ error: 'נא למלא שם משתמש וסיסמה' });
    return;
  }
  const usernameError = validateUsername(username);
  if (usernameError) {
    res.status(400).json({ error: usernameError });
    return;
  }
  const passwordError = validatePassword(password, username);
  if (passwordError) {
    res.status(400).json({ error: passwordError });
    return;
  }
  try {
    const { userId } = await acceptInvite(req.params.token, username, password);
    const token = createSession(userId, 'customer', req.ip, req.headers['user-agent']);
    setSessionCookie(res, token, 'customer');
    res.json({ ok: true });
  } catch (err) {
    // acceptInvite throws controlled Hebrew messages (invalid/expired token,
    // username taken) — safe to surface.
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}));

// ---------- Leads (public) ----------
app.post('/api/leads', publicLimiter, (req, res) => {
  const id = createLead(req.body || {});
  res.json({ id });
});

// Staff 'orderer' logins never see company finance — the client hides it, but the
// JSON must not carry it either (requireOwner gates the finance routes; these two
// customer-shared routes redact instead).
const EMPTY_BALANCE = { openTotal: 0, openCount: 0, obligo: null, creditLimit: null };

// ---------- Customer: home dashboard ----------
app.get('/api/home', requireCustomer, homeLimiter, ah(async (req, res) => {
  const data = await getHomeData(req.user!.id, req.user!.custname!, req.user!.cust_desc);
  if (req.user!.customer_role === 'orderer') {
    data.balance = { ...EMPTY_BALANCE };
    data.balanceOk = false;
    // Keep blocksOnDebt (checkout must still explain the block) but not the amount.
    if (data.paymentPolicy) data.paymentPolicy = { ...data.paymentPolicy, netDebt: 0 };
  }
  res.json(data);
}));

// Add the heuristic "usual basket" to the cart in one tap. Validation lives in
// setCartLine, so hidden/unpriced items are silently skipped here.
app.post('/api/reorder/add-all', requireCustomer, cartLimiter, (req: AuthedRequest, res) => {
  // Optional client-side "skip this week" selection — partnames to leave out.
  // Quantities still come from the server's own suggestion computation.
  const exclude = new Set(
    Array.isArray(req.body?.exclude)
      ? (req.body.exclude as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
  );
  const suggestions = getReorderSuggestions(req.user!.id, req.user!.custname!);
  let added = 0;
  for (const s of suggestions) {
    if (exclude.has(s.partname)) continue;
    try {
      setCartLine(req.user!.id, req.user!.custname!, s.partname, s.quantity);
      added++;
    } catch {
      /* skip anything that fails validation */
    }
  }
  res.json({ ...getCart(req.user!.id, req.user!.custname!), added });
});

// ---------- Customer ----------
app.get('/api/catalog', requireCustomer, (req: AuthedRequest, res) => {
  const { q, family, page, pageSize, sort } = req.query;
  const result = queryCatalog(req.user!.custname, {
    q: typeof q === 'string' ? q : undefined,
    family: typeof family === 'string' ? family : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
    sort: sort === 'family' ? 'family' : undefined,
  });
  res.json(result);
});

app.get('/api/catalog/families', requireCustomer, (_req, res) => {
  res.json({ families: listFamiliesLocal() });
});

app.get('/api/catalog/:partname', requireCustomer, (req: AuthedRequest, res) => {
  const prod = getProduct(req.params.partname, req.user!.custname);
  if (!prod) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(prod);
});

app.get('/api/cart', requireCustomer, (req: AuthedRequest, res) => {
  res.json({
    ...getCart(req.user!.id, req.user!.custname!),
    vatRate: VAT_RATE,
    unifiedCheckout: getSettingBool('unified_checkout_enabled', false),
  });
});

// Read-only checkout preview (unified checkout). Safe to call regardless of the
// flag; `enabled` tells the client which UI to render.
app.get('/api/checkout/preview', requireCustomer, ah(async (req: AuthedRequest, res) => {
  res.json(await buildCheckoutPreview(req.user!.id, req.user!.custname!));
}));

app.put('/api/cart/lines/:partname', requireCustomer, cartLimiter, (req: AuthedRequest, res) => {
  const { quantity, mode } = (req.body || {}) as { quantity?: number; mode?: 'set' | 'add' };
  if (typeof quantity !== 'number' || !isFinite(quantity)) {
    res.status(400).json({ error: 'bad_quantity' });
    return;
  }
  try {
    setCartLine(
      req.user!.id,
      req.user!.custname!,
      req.params.partname,
      quantity,
      mode === 'add' ? 'add' : 'set'
    );
  } catch (err) {
    if (err instanceof OrderError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  res.json(getCart(req.user!.id, req.user!.custname!));
});

app.delete('/api/cart', requireCustomer, (req: AuthedRequest, res) => {
  clearCart(req.user!.id);
  res.json({ ok: true });
});

// ---------- Saved-basket templates + favorites ----------
app.get('/api/templates', requireCustomer, (req: AuthedRequest, res) => {
  res.json({ templates: listTemplates(req.user!.id) });
});
app.post('/api/templates', requireCustomer, cartLimiter, (req: AuthedRequest, res) => {
  const name = typeof (req.body as { name?: unknown })?.name === 'string' ? (req.body as { name: string }).name : '';
  try {
    res.json({ id: saveTemplate(req.user!.id, req.user!.custname!, name) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'שגיאה' });
  }
});
app.post('/api/templates/:id/apply', requireCustomer, cartLimiter, (req: AuthedRequest, res) => {
  try {
    res.json({ added: applyTemplate(req.user!.id, req.user!.custname!, Number(req.params.id)) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'שגיאה' });
  }
});
app.delete('/api/templates/:id', requireCustomer, (req: AuthedRequest, res) => {
  const ok = deleteTemplate(req.user!.id, Number(req.params.id));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});

app.get('/api/favorites', requireCustomer, (req: AuthedRequest, res) => {
  res.json({ partnames: listFavorites(req.user!.id) });
});

// ---------- Push notifications ----------
app.get('/api/push/vapid', requireCustomer, (_req, res) => {
  res.json({ publicKey: vapidPublicKey() });
});
app.post('/api/push/subscribe', requireCustomer, (req: AuthedRequest, res) => {
  try {
    saveSubscription(req.user!.id, req.user!.custname, (req.body || {}).subscription);
    res.json({ ok: true });
  } catch {
    res.status(400).json({ error: 'bad_subscription' });
  }
});
app.post('/api/push/unsubscribe', requireCustomer, (req: AuthedRequest, res) => {
  const ep = (req.body || {}).endpoint;
  if (ep) removeSubscription(String(ep));
  res.json({ ok: true });
});
app.post('/api/admin/push/broadcast', requireAdmin, ah(async (req, res) => {
  const { title, body } = (req.body || {}) as { title?: string; body?: string };
  if (!title || !body) {
    res.status(400).json({ error: 'title_body_required' });
    return;
  }
  const sent = await broadcast({ title: String(title).slice(0, 80), body: String(body).slice(0, 200), url: '#home' });
  res.json({ sent });
}));
// ---------- Per-store staff (owner-managed) ----------
app.get('/api/account/staff', requireOwner, (req: AuthedRequest, res) => {
  res.json({ staff: listStaff(req.user!.custname!) });
});
app.post('/api/account/staff', requireOwner, sensitiveLimiter, ah(async (req: AuthedRequest, res) => {
  const b = (req.body || {}) as { username?: string; password?: string };
  const r = await createStaff(req.user!.custname!, req.user!.cust_desc, b.username || '', b.password || '');
  res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true, id: r.id } : { error: r.error });
}));
app.post('/api/account/staff/:id/status', requireOwner, (req: AuthedRequest, res) => {
  const { status } = (req.body || {}) as { status?: string };
  if (status !== 'active' && status !== 'disabled') {
    res.status(400).json({ error: 'bad_status' });
    return;
  }
  const ok = setStaffStatus(req.user!.custname!, Number(req.params.id), status);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});
app.post('/api/account/staff/:id/reset-password', requireOwner, sensitiveLimiter, ah(async (req: AuthedRequest, res) => {
  const r = await resetStaffPassword(req.user!.custname!, Number(req.params.id), ((req.body || {}) as { new_password?: string }).new_password || '');
  res.status(r.ok ? 200 : 400).json(r.ok ? { ok: true } : { error: r.error });
}));

app.get('/api/favorites/products', requireCustomer, (req: AuthedRequest, res) => {
  const items = listFavorites(req.user!.id)
    .map((p) => getProduct(p, req.user!.custname))
    .filter((x) => x !== null);
  res.json({ items });
});
app.get('/api/catalog/:partname/similar', requireCustomer, (req: AuthedRequest, res) => {
  res.json({ items: getSimilarProducts(req.params.partname, req.user!.custname, 8) });
});
app.get('/api/catalog/barcode/:code', requireCustomer, (req: AuthedRequest, res) => {
  const item = findByBarcode(req.params.code, req.user!.custname);
  res.status(item ? 200 : 404).json(item ? { item } : { error: 'not_found' });
});
app.post('/api/favorites', requireCustomer, cartLimiter, (req: AuthedRequest, res) => {
  const partname = typeof (req.body as { partname?: unknown })?.partname === 'string' ? (req.body as { partname: string }).partname : '';
  if (!partname) {
    res.status(400).json({ error: 'partname_required' });
    return;
  }
  res.json({ favorited: toggleFavorite(req.user!.id, partname) });
});

app.post('/api/orders', requireCustomer, blockIfMaintenance, ordersMinuteLimiter, ordersDailyLimiter, ah(async (req, res) => {
  const { details, track } = (req.body || {}) as { details?: string; track?: string };
  try {
    const result = await submitOrder(req.user!.id, req.user!.custname!, details, track === 'fast' ? 'fast' : 'regular');
    if (result.needsPayment) {
      notifyUser(req.user!.id, { title: 'ההזמנה ממתינה לתשלום', body: 'השלימו תשלום כדי שההזמנה תאושר ותישלח', url: '#order-pay/' + result.orderId });
    } else {
      notifyUser(req.user!.id, { title: 'ההזמנה נקלטה ✓', body: `הזמנה ${result.ordname} התקבלה בהצלחה`, url: '#orders' });
    }
    res.json(result);
  } catch (err) {
    // User-facing validation errors (e.g. empty cart) are safe to surface.
    if (err instanceof OrderError) {
      res.status(400).json({ error: err.message });
      return;
    }
    // Anything else may carry Priority/ERP internals — log server-side, return generic.
    console.error('[orders] submit failed:', err);
    res.status(500).json({ error: 'שליחת ההזמנה נכשלה. נסה שוב או פנה לתמיכה.' });
  }
}));

app.get('/api/orders', requireCustomer, (req: AuthedRequest, res) => {
  res.json({ orders: listLocalOrders(req.user!.id) });
});

app.get('/api/orders/priority', requireCustomer, financeLimiter, ah(async (req, res) => {
  const orders = await listPriorityOrders(req.user!.custname!);
  res.json({ orders });
}));

app.get('/api/orders/:id', requireCustomer, (req: AuthedRequest, res) => {
  const order = getLocalOrder(req.user!.id, Number(req.params.id));
  if (!order) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(order);
});

app.post('/api/orders/:id/reorder', requireCustomer, (req: AuthedRequest, res) => {
  try {
    const count = reorderToCart(req.user!.id, req.user!.custname!, Number(req.params.id));
    res.json({ ok: true, lines: count });
  } catch (err) {
    if (err instanceof OrderError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[orders] reorder failed:', err);
    res.status(500).json({ error: 'הפעולה נכשלה. נסו שוב.' });
  }
});

app.get('/api/account', requireCustomer, financeLimiter, ah(async (req, res) => {
  const summary = await getAccountSummary(req.user!.custname!);
  const isOrderer = req.user!.customer_role === 'orderer';
  res.json({
    // Local fallbacks (kept for backward-compat / when Priority is unreachable)
    custname: req.user!.custname,
    cust_desc: req.user!.cust_desc,
    email: req.user!.email,
    phone: req.user!.phone,
    // Live Priority data — finance redacted for staff 'orderer' logins
    profile: isOrderer && summary.profile ? { ...summary.profile, paymentTerms: null } : summary.profile,
    balance: isOrderer ? { ...EMPTY_BALANCE } : summary.balance,
    priorityOk: summary.priorityOk,
    balanceOk: isOrderer ? false : summary.balanceOk,
  });
}));

app.patch('/api/account/phone', requireCustomer, sensitiveLimiter, (req: AuthedRequest, res) => {
  const raw = String(((req.body || {}) as { phone?: string }).phone || '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  // allow clearing, else require a valid Israeli mobile (05XXXXXXXX = 10 digits)
  if (digits && !/^05\d{8}$/.test(digits)) { res.status(400).json({ error: 'מספר נייד לא תקין (למשל 05XXXXXXXX)' }); return; }
  const phone = digits || null;
  db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, req.user!.id);
  res.json({ ok: true, phone });
});

app.get('/api/invoices', requireOwner, financeLimiter, ah(async (req: AuthedRequest, res) => {
  const custname = req.user!.custname!;
  const result = await getInvoices(custname);
  // paymentInProcess = recent card payments not yet reconciled into Priority's debt;
  // the UI shows an "in process" note and the partial-pay cap derives from it.
  res.json({ ...result, paymentInProcess: unreconciledCardTotal(custname) });
}));

// Single invoice detail (line items) — scoped to the session custname (IDOR-safe).
app.get('/api/invoices/:ivnum', requireOwner, financeLimiter, ah(async (req, res) => {
  const detail = await getInvoiceDetail(req.user!.custname!, req.params.ivnum);
  if (!detail) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(detail);
}));

// ---------- Check-photo payments (promise-to-pay; image encrypted, never web-served) ----------
const checkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
// The parse endpoint is the only LLM-billing path: cap per-minute, per-day, and
// org-wide so a runaway/compromised account can't run up the Anthropic bill.
// skipFailedRequests so an Anthropic outage doesn't burn the customer's budget.
const checkParseLimiter = perUser(60_000, 10);
const checkParseDailyLimiter = rateLimit({ windowMs: 86_400_000, max: 60, keyGenerator: userKey, skipFailedRequests: true });
const checkParseGlobalLimiter = rateLimit({ windowMs: 86_400_000, max: 2000, keyGenerator: () => 'global', skipFailedRequests: true });

function shapeCheck(c: CheckRow) {
  return {
    id: c.id,
    amount: c.amount,
    checkDate: c.check_date,
    isPostdated: !!c.is_postdated,
    bank: c.bank,
    branch: c.branch,
    account: c.account,
    checkNumber: c.check_number,
    note: c.note,
    status: c.status,
    createdAt: c.created_at,
    submittedAt: c.submitted_at,
    custname: c.custname,
  };
}

// Upload a cheque photo → normalise + validate it's a real image → store encrypted
// → AI extraction (if a key is set) → return a draft id + extracted fields.
app.post(
  '/api/payments/check/parse',
  requireOwner,
  blockIfMaintenance,
  checkParseGlobalLimiter,
  checkParseLimiter,
  checkParseDailyLimiter,
  checkUpload.single('image'),
  ah(async (req, res) => {
  const file = (req as any).file as { buffer: Buffer } | undefined;
  if (!file) {
    res.status(400).json({ error: 'no_image' });
    return;
  }
  // The stored deposit image must be retrievable later — refuse if encryption
  // (hence storage) isn't configured, rather than silently discarding it.
  if (!imageStorageEnabled()) {
    console.error('[payments] CHECK_IMAGE_KEY missing/invalid — refusing cheque upload');
    res.status(503).json({ error: 'אחסון התשלומים אינו זמין כעת' });
    return;
  }
  // Normalise (EXIF/GPS strip + downscale). A non-decodable upload is rejected
  // before anything is stored or sent to the model.
  const jpeg = await prepareCheckImage(file.buffer);
  if (!jpeg) {
    res.status(400).json({ error: 'הקובץ אינו תמונה תקינה' });
    return;
  }
  const ai = await extractCheck(jpeg);
  const { id } = createCheckDraft(req.user!.id, req.user!.custname!, jpeg, ai);
  res.json({
    id,
    aiAvailable: checkOcrEnabled(),
    ai: ai
      ? {
          isCheck: ai.is_check,
          amount: ai.amount,
          date: ai.date,
          isPostdated: ai.is_postdated,
          bank: ai.bank,
          branch: ai.branch,
          account: ai.account,
          checkNumber: ai.check_number,
          confidence: ai.confidence,
          legible: ai.legible,
          notes: ai.notes_he,
        }
      : null,
  });
}));

// Customer confirms the human-verified amount/date → promise-to-pay recorded.
app.post('/api/payments/check/:id/confirm', requireOwner, blockIfMaintenance, cartLimiter, (req: AuthedRequest, res) => {
  const b = (req.body || {}) as Record<string, unknown>;
  const amount = Number(b.amount);
  const checkDate = typeof b.checkDate === 'string' ? b.checkDate : '';
  if (!isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'יש להזין סכום תקין' });
    return;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkDate)) {
    res.status(400).json({ error: 'יש להזין תאריך תקין' });
    return;
  }
  const ok = confirmCheck(req.user!.id, req.params.id, {
    amount: Math.round(amount * 100) / 100,
    checkDate, // is_postdated is derived server-side from checkDate in confirmCheck
    bank: typeof b.bank === 'string' ? b.bank : undefined,
    branch: typeof b.branch === 'string' ? b.branch : undefined,
    account: typeof b.account === 'string' ? b.account : undefined,
    checkNumber: typeof b.checkNumber === 'string' ? b.checkNumber : undefined,
    note: typeof b.note === 'string' ? b.note : undefined,
  });
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});

app.get('/api/payments', requireOwner, (req: AuthedRequest, res) => {
  res.json({ checks: listChecksForUser(req.user!.id).map(shapeCheck) });
});

// ---------- AI assistant ("שאל את אורגת") ----------
const assistantLimiter = perUser(60_000, 20);
const assistantDailyLimiter = perUser(86_400_000, 300); // daily cost ceiling per user
app.post('/api/assistant', requireCustomer, assistantLimiter, assistantDailyLimiter, ah(async (req: AuthedRequest, res) => {
  if (!assistantEnabled()) {
    res.status(503).json({ error: 'האסיסטנט אינו זמין כרגע' });
    return;
  }
  const body = (req.body || {}) as { messages?: Array<{ role?: string; content?: string }> };
  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
  if (!history.length || history[history.length - 1].role !== 'user') {
    res.status(400).json({ error: 'no_message' });
    return;
  }
  const turn = await runAssistant(req.user!.id, req.user!.custname!, req.user!.customer_role, history);
  res.json(turn);
}));

// ---------- Card payments via hosted page (UPay / Tranzila; amount fixed server-side) ----------
const cardPayLimiter = perUser(60_000, 10);
function paymentsLive(): boolean {
  return getSettingBool('payments_enabled', process.env.PAYMENTS_ENABLED === 'true') && activeCardProvider() !== null;
}
function appBaseUrl(req: Request): string {
  return process.env.APP_BASE_URL || process.env.WEB_ORIGIN || `${req.protocol}://${req.get('host')}`;
}

// Open (unpaid) invoices the customer can choose to settle by card.
app.get('/api/payments/card/open-invoices', requireOwner, financeLimiter, ah(async (req: AuthedRequest, res) => {
  const custname = req.user!.custname!;
  const [items, summary] = await Promise.all([
    getUnpaidInvoices(custname).catch(() => []),
    getAccountSummary(custname).catch(() => null),
  ]);
  res.json({ items, debt: summary && summary.balanceOk ? summary.balance.openTotal : 0 });
}));

app.post('/api/payments/card/create', requireOwner, blockIfMaintenance, cardPayLimiter, ah(async (req: AuthedRequest, res) => {
  if (!paymentsLive()) {
    res.status(503).json({ error: 'תשלום בכרטיס אשראי אינו זמין כרגע' });
    return;
  }
  const rawInvoices = (req.body as { invoices?: unknown })?.invoices;
  const invoices = Array.isArray(rawInvoices) ? rawInvoices.filter((x): x is string => typeof x === 'string') : [];
  // Only an account owner can create a savable token — 'orderer' staff have no
  // saved-card surface (view/delete/use are all requireOwner), so their consent
  // would mint an unrevocable token. requireOwner above already blocks orderers
  // from this route entirely; this is a belt-and-suspenders gate on the flag itself.
  const saveCard = (req.body as { saveCard?: unknown })?.saveCard === true && req.user!.customer_role === 'owner';
  try {
    const out = await createCardDebtIntent(req.user!.id, req.user!.custname!, { invoices }, undefined, appBaseUrl(req), saveCard);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'שגיאה ביצירת התשלום' });
  }
}));

// Partial / custom-amount card payment ("תשלום על חשבון"). Unlike /create, the client
// supplies the amount — validated server-side (0 < amount <= openTotal − pending). Ticked
// invoices are an office hint only; the office allocates the receipt in Priority.
app.post('/api/payments/card/intent', requireOwner, blockIfMaintenance, cardPayLimiter, ah(async (req: AuthedRequest, res) => {
  if (!paymentsLive()) {
    res.status(503).json({ error: 'תשלום בכרטיס אשראי אינו זמין כרגע' });
    return;
  }
  const body = (req.body || {}) as { amount?: unknown; invoiceRefs?: unknown; saveCard?: unknown };
  const amount = typeof body.amount === 'number' ? body.amount : Number(body.amount);
  const invoiceRefs = Array.isArray(body.invoiceRefs)
    ? body.invoiceRefs.filter((x): x is string => typeof x === 'string')
    : undefined;
  // Owner-only consent gate — see the /card/create comment above.
  const saveCard = body.saveCard === true && req.user!.customer_role === 'owner';
  try {
    const out = await createCardPartialIntent(req.user!.id, req.user!.custname!, amount, invoiceRefs, undefined, appBaseUrl(req), saveCard);
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'שגיאה ביצירת התשלום' });
  }
}));

// Pay a held (pending_payment) order by card — returns the PSP hosted-page URL.
app.post('/api/orders/:id/pay/card', requireCustomer, blockIfMaintenance, cardPayLimiter, ah(async (req: AuthedRequest, res) => {
  if (!paymentsLive()) {
    res.status(503).json({ error: 'תשלום בכרטיס אשראי אינו זמין כרגע' });
    return;
  }
  // This route runs under requireCustomer (not requireOwner) since any staff member
  // may pay a held order — but 'orderer' staff have no saved-card surface at all
  // (view/delete/use are requireOwner-gated), so their consent here would mint an
  // unrevocable token nobody can ever see or revoke. Restrict saveCard to owners.
  const saveCard = (req.body as { saveCard?: unknown })?.saveCard === true && req.user!.customer_role === 'owner';
  try {
    const intent = await createCardOrderIntent(req.user!.id, req.user!.custname!, Number(req.params.id), undefined, appBaseUrl(req), saveCard);
    res.json(intent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const safe = (msg === 'order not found' || msg === 'order not awaiting payment') ? 'ההזמנה אינה ממתינה לתשלום' : 'יצירת תשלום נכשלה';
    res.status(400).json({ error: safe });
  }
}));

app.post('/api/orders/:id/pay/check', requireCustomer, blockIfMaintenance, cartLimiter, ah(async (req: AuthedRequest, res) => {
  const checkId = typeof (req.body || {}).checkId === 'string' ? (req.body as { checkId: string }).checkId : '';
  if (!checkId) { res.status(400).json({ error: 'חסר מזהה צ׳ק' }); return; }
  try {
    await payHeldOrderByCheck(req.user!.id, req.user!.custname!, Number(req.params.id), checkId);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof OrderError) { res.status(400).json({ error: err.message }); return; }
    console.error('[orders] pay-by-check failed:', err);
    res.status(500).json({ error: 'אישור התשלום נכשל' });
  }
}));

// Owner-scoped status poll — re-queries UPay to confirm.
app.get('/api/payments/card/:id', requireOwner, ah(async (req: AuthedRequest, res) => {
  let row = getCardForUser(req.user!.id, req.params.id);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  // Re-confirm 'failed'/'expired' too: a decline followed by a successful retry on
  // the same hosted page (or a charge whose IPN was lost while the intent aged out)
  // must resolve to paid, not stick on the stale failure.
  if (row.status === 'pending' || row.status === 'failed' || row.status === 'expired') row = (await confirmCard(row.id)) || row;
  // Unified checkout: order-payment polls need to know WHICH order was settled so
  // the success page can say "ההזמנה אושרה" instead of a generic payment message.
  let orderId: number | null = null;
  let ordname: string | null = null;
  if (row.kind === 'order_payment' && row.order_id) {
    orderId = Number(row.order_id);
    const o = db.prepare('SELECT priority_ordname FROM orders_local WHERE id = ?').get(orderId) as
      | { priority_ordname: string | null }
      | undefined;
    ordname = o?.priority_ordname ?? null; // null until Priority send completes — success copy must not depend on it
  }
  res.json({ id: row.id, status: row.status, amount: row.amount, confirmationCode: row.confirmation_code, fourDigits: row.four_digits, provider: row.provider, orderId, ordname });
}));

// Phase 1 saved card (PayPlus token, one per user) — display fields only, never the token.
app.get('/api/payments/saved-card', requireOwner, (req: AuthedRequest, res) => {
  const row = getSavedCard(req.user!.id);
  res.json({
    card: row
      ? { id: row.id, brand: row.brand, fourDigits: row.four_digits, expiryMonth: row.expiry_month, expiryYear: row.expiry_year }
      : null,
  });
});

app.delete('/api/payments/saved-card', requireOwner, (req: AuthedRequest, res) => {
  deleteSavedCard(req.user!.id);
  res.json({ ok: true });
});

// Phase 2: one-tap charge against the saved PayPlus token — no hosted page. Body must
// carry EXACTLY ONE of orderId / invoices / amount (the same three modes as the hosted
// /create, /intent, /pay/card routes). Kept 404 (not 503/400) while dark — flag off,
// payments not live, or no saved card on file all look like "feature doesn't exist" to
// the client, which silently falls back to the hosted flow.
app.post('/api/payments/card/charge-saved', requireOwner, blockIfMaintenance, cardPayLimiter, ah(async (req: AuthedRequest, res) => {
  if (!getSettingBool('saved_card_charge_enabled', false) || !paymentsLive()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (!getSavedCard(req.user!.id)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const body = (req.body || {}) as { orderId?: unknown; invoices?: unknown; amount?: unknown };
  const hasOrderId = body.orderId !== undefined && body.orderId !== null;
  const hasInvoices = body.invoices !== undefined && body.invoices !== null;
  const hasAmount = body.amount !== undefined && body.amount !== null;
  if ([hasOrderId, hasInvoices, hasAmount].filter(Boolean).length !== 1) {
    res.status(400).json({ error: 'יש לבחור מצב תשלום אחד בלבד' });
    return;
  }
  // Strict validation: invoices, when present, must be an array of strings. Silently
  // coercing a malformed value to [] would fall through to deriveDebtCharge's
  // whole-balance fallback — charging the entire open debt when the caller meant to
  // select specific invoices.
  if (hasInvoices && !(Array.isArray(body.invoices) && body.invoices.every((x): x is string => typeof x === 'string'))) {
    res.status(400).json({ error: 'בקשה לא תקינה' });
    return;
  }
  const mode = hasOrderId
    ? { orderId: Number(body.orderId) }
    : hasInvoices
      ? { invoices: body.invoices as string[] }
      : { amount: typeof body.amount === 'number' ? body.amount : Number(body.amount) };
  try {
    const out = await chargeSavedCard(req.user!.id, req.user!.custname!, mode);
    res.json(out);
  } catch (err) {
    if (err instanceof OrderError) {
      // deriveOrderCharge (shared with the hosted path) throws plain-English internal
      // messages via this OrderError wrapper — sanitize them the same way the hosted
      // /pay/card route does before they reach the customer.
      const raw = err.message;
      const safe =
        raw === 'order not found' || raw === 'order not awaiting payment' || raw === 'order already paid'
          ? 'ההזמנה אינה ממתינה לתשלום'
          : raw;
      res.status(402).json({ error: safe });
      return;
    }
    console.error('[card] charge-saved failed:', err);
    res.status(500).json({ error: 'שגיאה בחיוב' });
  }
}));

// UPay server-to-server IPN — confirms by re-query (caller is never trusted).
app.get('/api/payments/upay/ipn', ah(async (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (id) await confirmCard(id).catch(() => null);
  res.status(200).send('ok');
}));

// Tranzila callbacks (GET or POST, form-encoded). The payload is only a HINT —
// we record the transaction index and confirm by re-querying /v1/transactions.
const tranzilaBody = express.urlencoded({ extended: false });
function tranzilaCallbackParams(req: Request): { id: string; index: string } {
  const p = { ...(req.query as Record<string, unknown>), ...((req.body || {}) as Record<string, unknown>) };
  const id = typeof p.id === 'string' ? p.id : '';
  const rawIndex = p.transaction_id ?? p.index ?? '';
  return { id, index: typeof rawIndex === 'string' || typeof rawIndex === 'number' ? String(rawIndex) : '' };
}
app.all('/api/payments/tranzila/ipn', tranzilaBody, ah(async (req, res) => {
  const { id, index } = tranzilaCallbackParams(req);
  if (id && index) recordTranzilaIndex(id, index);
  if (id) await confirmCard(id).catch(() => null);
  res.status(200).send('ok');
}));
// success/fail land here (browser redirect target) — capture the hint, then
// bounce to the SPA result page, which polls the authenticated status endpoint.
app.all('/api/payments/tranzila/return', tranzilaBody, ah(async (req, res) => {
  const { id, index } = tranzilaCallbackParams(req);
  if (id && index) recordTranzilaIndex(id, index);
  if (id) confirmCard(id).catch(() => null); // fire-and-forget; the SPA polls anyway
  res.redirect(`/#pay/card/return?id=${encodeURIComponent(id)}`);
}));

// PayPlus server-to-server IPN (JSON). Authenticated by User-Agent: PayPlus + an
// HMAC-SHA256 'hash' over the raw body; even then the body is only a HINT — the
// charge is confirmed by re-querying /Transactions/View (caller never trusted).
app.all('/api/payments/payplus/ipn', ah(async (req, res) => {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!payplus.verifyWebhook(raw, req.get('hash'), req.get('user-agent'))) {
    res.status(401).send('unauthorized');
    return;
  }
  const body = (req.body || {}) as { more_info?: unknown };
  const id =
    (typeof req.query.id === 'string' && req.query.id) ||
    (typeof body.more_info === 'string' ? body.more_info : '');
  if (id) await confirmCard(id).catch(() => null);
  res.status(200).send('ok');
}));
// browser redirect target (success/fail/cancel) — confirm, then bounce to the SPA
// result page, which polls the authenticated status endpoint.
app.all('/api/payments/payplus/return', ah(async (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : '';
  if (id) confirmCard(id).catch(() => null); // fire-and-forget; the SPA polls anyway
  res.redirect(`/#pay/card/return?id=${encodeURIComponent(id)}`);
}));

// ---------- Admin: promotions ----------
app.get('/api/admin/promotions', requireAdmin, (_req, res) => {
  res.json({ promotions: listPromotions() });
});
app.post('/api/admin/promotions', requireAdmin, (req, res) => {
  const b = (req.body || {}) as Partial<PromoInput>;
  if (!b.name || !b.type || !b.params) {
    res.status(400).json({ error: 'name_type_params_required' });
    return;
  }
  res.json({ id: createPromotion(b as PromoInput) });
});
app.patch('/api/admin/promotions/:id', requireAdmin, (req, res) => {
  const ok = updatePromotion(Number(req.params.id), (req.body || {}) as Partial<PromoInput>);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});
app.delete('/api/admin/promotions/:id', requireAdmin, (req, res) => {
  const ok = deletePromotion(Number(req.params.id));
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'not_found' });
});
// Promo card image (id-less: the returned URL is saved into params.imageUrl on submit).
app.post(
  '/api/admin/promotions/image',
  requireAdmin,
  imageUploadLimiter,
  upload.single('image'),
  ah(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    try {
      res.json(await savePromoImage(req.file.buffer));
    } catch (err) {
      res.status(400).json({ error: redactedError(req.reqId, 'admin/promo-image', err) });
    }
  })
);

function parsePaidItems(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as string[]) : null;
  } catch {
    return null;
  }
}
app.get('/api/admin/card-payments', requireAdmin, (_req, res) => {
  res.json({
    payments: listAllCardPayments().map((c) => ({
      id: c.id, custname: c.custname, amount: c.amount, status: c.status, kind: c.kind,
      confirmationCode: c.confirmation_code, fourDigits: c.four_digits, provider: c.provider,
      paidItems: parsePaidItems(c.paid_items), paymentsCount: c.payments_count,
      createdAt: c.created_at, paidAt: c.paid_at,
    })),
  });
});

// Stream the cheque image to its owner only (decrypted; never cached).
app.get('/api/payments/:id/image', requireOwner, (req: AuthedRequest, res) => {
  const c = getCheckForUser(req.user!.id, req.params.id);
  if (!c || !c.image_path) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const buf = decryptCheckImage(c.image_path);
  if (!buf) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
});

// Admin reconciliation.
app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  res.json({ checks: listAllChecks(status).map(shapeCheck) });
});

app.patch('/api/admin/payments/:id', requireAdmin, (req, res) => {
  const { status } = (req.body || {}) as { status?: string };
  const ok = status ? setCheckStatus(req.params.id, status) : false;
  res.status(ok ? 200 : 400).json(ok ? { ok: true } : { error: 'bad_status' });
});

app.get('/api/admin/payments/:id/image', requireAdmin, (req, res) => {
  const c = getCheckAny(req.params.id);
  if (!c || !c.image_path) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const buf = decryptCheckImage(c.image_path);
  if (!buf) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.send(buf);
});

// ---------- Admin ----------
app.post('/api/admin/catalog/refresh', requireAdmin, adminHeavyLimiter, ah(async (req, res) => {
  try {
    const result = await refreshCatalogFromPriority();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: redactedError(req.reqId, 'admin/catalog-refresh', err) });
  }
}));

app.post('/api/admin/pricing/refresh', requireAdmin, adminHeavyLimiter, ah(async (req, res) => {
  const custname = String(req.query.custname || '');
  if (!custname) {
    res.status(400).json({ error: 'custname_required' });
    return;
  }
  try {
    const count = await refreshCustomerPricing(custname);
    res.json({ updated: count });
  } catch (err) {
    res.status(500).json({ error: redactedError(req.reqId, 'admin/pricing-refresh', err) });
  }
}));

app.get('/api/admin/customers/priority', requireAdmin, ah(async (req, res) => {
  const config = getPriorityConfig();
  if (!config) {
    res.status(400).json({ error: 'priority_not_configured' });
    return;
  }
  try {
    const customers = await listCustomers(config);
    res.json({ customers });
  } catch (err) {
    res.status(500).json({ error: redactedError(req.reqId, 'admin/customers', err) });
  }
}));

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  const users = db
    .prepare(
      `SELECT id, username, role, custname, cust_desc, email, phone, status, created_at, last_login_at
       FROM users ORDER BY created_at DESC`
    )
    .all();
  res.json({ users });
});

app.post('/api/admin/invites', requireAdmin, (req: AuthedRequest, res) => {
  const { custname, cust_desc, email, phone } = (req.body || {}) as Record<string, string | undefined>;
  if (!custname) {
    res.status(400).json({ error: 'custname_required' });
    return;
  }
  const inv = createInvite({
    custname,
    cust_desc,
    email,
    phone,
    created_by: req.user!.id,
  });
  const base = process.env.APP_BASE_URL || `http://localhost:5173`;
  res.json({ invite: inv, url: `${base}/#invite/${inv.token}` });
});

app.get('/api/admin/invites', requireAdmin, (_req, res) => {
  res.json({ invites: listInvites() });
});

app.get('/api/admin/leads', requireAdmin, (_req, res) => {
  res.json({ leads: listLeads() });
});

app.patch('/api/admin/leads/:id', requireAdmin, (req, res) => {
  const { status } = (req.body || {}) as { status?: string };
  if (!status) {
    res.status(400).json({ error: 'status_required' });
    return;
  }
  updateLeadStatus(Number(req.params.id), status);
  res.json({ ok: true });
});

// ---------- Admin: app settings ----------
// Only these keys are settable from the panel (allowlist — no arbitrary writes).
const SETTABLE = new Set([
  'payments_enabled',
  'check_payment_enabled',
  'card_provider', // 'upay' | 'tranzila' — which PSP handles new card intents
  'maintenance_enabled',
  'maintenance_message',
  'announcement_enabled',
  'announcement_text',
  'payment_policy_enabled',
  'policy_cash_paydes_match',
  'policy_net_debt_threshold',
  'priority_receipts_enabled',
  'priority_receipt_cashname',
  'priority_receipt_ownerlogin',
  'priority_receipt_cc_paymentcode',
  'priority_receipt_terminal',
  'priority_receipts_test_custname',
  'discount_pricing_enabled',
  'oos_sort_bottom_enabled',
  'unified_checkout_enabled',
  'installments_enabled',
  'installments_min_amount',
  'installments_max',
  'saved_cards_enabled',
  'saved_card_charge_enabled',
  'fast_track_enabled',
  'fast_track_discount_pct',
]);
const BOOL_SETTINGS = new Set(['payments_enabled', 'check_payment_enabled', 'maintenance_enabled', 'announcement_enabled', 'payment_policy_enabled', 'priority_receipts_enabled', 'discount_pricing_enabled', 'oos_sort_bottom_enabled', 'unified_checkout_enabled', 'installments_enabled', 'saved_cards_enabled', 'saved_card_charge_enabled', 'fast_track_enabled']);

app.get('/api/admin/settings', requireAdmin, (_req, res) => {
  res.json({ settings: getAllSettings() });
});

app.patch('/api/admin/settings', requireAdmin, (req, res) => {
  const updates = (req.body || {}) as Record<string, unknown>;
  const applied: string[] = [];
  for (const [key, value] of Object.entries(updates)) {
    if (!SETTABLE.has(key)) continue;
    if (BOOL_SETTINGS.has(key)) setSettingBool(key, value === true || value === 'true');
    else setSetting(key, String(value ?? '').slice(0, 1000));
    applied.push(key);
  }
  if (!applied.length) {
    res.status(400).json({ error: 'no_valid_settings' });
    return;
  }
  res.json({ ok: true, applied });
});

// ---------- Admin: customer / login management ----------
app.get('/api/admin/users/detailed', requireAdmin, (_req, res) => {
  res.json({ users: listAllUsers() });
});

app.post('/api/admin/users', requireAdmin, sensitiveLimiter, ah(async (req: AuthedRequest, res) => {
  const b = (req.body || {}) as Record<string, string>;
  const result = await createCustomerLogin({
    username: b.username || '',
    password: b.password || '',
    custname: b.custname || '',
    cust_desc: b.cust_desc,
    email: b.email,
    phone: b.phone,
    customerRole: b.customer_role,
  });
  res.status(result.ok ? 200 : 400).json(result.ok ? { ok: true, id: result.id } : { error: result.error });
}));

app.post('/api/admin/users/:id/reset-password', requireAdmin, sensitiveLimiter, ah(async (req: AuthedRequest, res) => {
  const { new_password } = (req.body || {}) as { new_password?: string };
  const result = await resetUserPassword(Number(req.params.id), new_password || '');
  res.status(result.ok ? 200 : 400).json(result.ok ? { ok: true } : { error: result.error });
}));

app.post('/api/admin/users/:id/status', requireAdmin, (req: AuthedRequest, res) => {
  const { status } = (req.body || {}) as { status?: string };
  if (status !== 'active' && status !== 'disabled') {
    res.status(400).json({ error: 'bad_status' });
    return;
  }
  const result = setUserStatus(Number(req.params.id), status);
  res.status(result.ok ? 200 : 400).json(result.ok ? { ok: true } : { error: result.error });
});

app.patch('/api/admin/users/:id', requireAdmin, sensitiveLimiter, (req: AuthedRequest, res) => {
  const b = (req.body || {}) as { custname?: string; cust_desc?: string };
  const r = updateCustomerDetails(Number(req.params.id), b.custname || '', typeof b.cust_desc === 'string' ? b.cust_desc : null);
  res.status(r.ok ? 200 : 400).json(r);
});

app.delete('/api/admin/users/:id', requireAdmin, sensitiveLimiter, (req: AuthedRequest, res) => {
  const r = deleteCustomerUser(Number(req.params.id));
  res.status(r.ok ? 200 : 400).json(r);
});

// Magic login link — one active per user, 14 days, reusable. Admin only.
app.post('/api/admin/users/:id/login-link', requireAdmin, sensitiveLimiter, (req: AuthedRequest, res) => {
  const target = db.prepare(`SELECT id, role, status FROM users WHERE id = ?`).get(Number(req.params.id)) as
    | { id: number; role: string; status: string } | undefined;
  if (!target || target.role !== 'customer' || target.status !== 'active') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const { token, expiresAt } = createLoginLink(target.id, req.user!.id);
  res.json({ url: `${appBaseUrl(req)}/#login-link/${token}`, expiresAt });
});

// ---------- Admin: company list (group-by custname, cached finance, resolved policy) ----------
app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const page = Math.max(0, Number(req.query.page) || 0);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
  res.json(listCustomersAdmin(q, page, pageSize));
});

// ---------- Admin: per-customer detail / policy upsert / batch ----------
// NOTE: POST /batch must be declared before GET /:custname (different method, no conflict,
// but keeping literal paths first is the safest pattern).
app.post('/api/admin/customers/batch', requireAdmin, (req: AuthedRequest, res) => {
  const items = Array.isArray((req.body || {}).items) ? (req.body as { items: Array<Record<string, unknown>> }).items : [];
  res.json({ changes: batchUpdateCustomers(items) });
});
app.get('/api/admin/customers/:custname', requireAdmin, ah(async (req: AuthedRequest, res) => { res.json(await getCustomerAdmin(req.params.custname)); }));
app.patch('/api/admin/customers/:custname', requireAdmin, (req: AuthedRequest, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  if ('discount_percent' in body) {
    const raw = body.discount_percent;
    if (raw === null || raw === '') {
      db.prepare("DELETE FROM customer_discounts WHERE custname = ? AND source = 'manual'").run(req.params.custname);
    } else {
      const pct = Number(raw);
      if (!isFinite(pct) || pct < 0 || pct > 60) { res.status(400).json({ error: 'אחוז הנחה חייב להיות בין 0 ל-60' }); return; }
      db.prepare(
        `INSERT INTO customer_discounts (custname, percent, source, updated_at) VALUES (?, ?, 'manual', datetime('now'))
         ON CONFLICT(custname) DO UPDATE SET percent = excluded.percent, source = 'manual', updated_at = datetime('now')`
      ).run(req.params.custname, pct);
    }
  }
  patchCustomer(req.params.custname, body);
  res.json({ ok: true });
});
app.post('/api/admin/customers/:custname/reset-portal', requireAdmin, (req, res) => {
  const r = resetCustomerPortal(req.params.custname);
  res.status(r.ok ? 200 : 409).json(r);
});
app.post('/api/admin/customers/:custname/refresh-discount', requireAdmin, ah(async (req, res) => {
  try {
    const percent = await refreshCustomerDiscounts(req.params.custname);
    res.json({ ok: true, percent });
  } catch (err) {
    res.status(502).json({ error: 'רענון מ-Priority נכשל — נסו שוב' });
  }
}));


// ---------- Admin: business analytics (from Priority; cached) ----------
app.get('/api/admin/analytics/revenue', requireAdmin, adminAnalyticsLimiter, ah(async (_req, res) => {
  const config = getPriorityConfig();
  res.json({ revenue: config ? await getRevenueByMonth(config, 12) : [] });
}));
app.get('/api/admin/analytics/top-products', requireAdmin, adminAnalyticsLimiter, ah(async (_req, res) => {
  const config = getPriorityConfig();
  res.json({ products: config ? await getTopProducts(config, 6, 15) : [] });
}));
app.get('/api/admin/analytics/debtors', requireAdmin, adminAnalyticsLimiter, ah(async (_req, res) => {
  const config = getPriorityConfig();
  res.json({ debtors: config ? await getTopDebtors(config, 20) : [] });
}));
app.get('/api/admin/analytics/inactive', requireAdmin, adminAnalyticsLimiter, ah(async (_req, res) => {
  const config = getPriorityConfig();
  res.json({ inactive: config ? await getInactiveCustomers(config, 90) : [] });
}));

// ---------- Admin: Product control panel ----------
app.get('/api/admin/products', requireAdmin, (req, res) => {
  const { q, family, status, page, pageSize } = req.query;
  const result = listProductsAdmin({
    q: typeof q === 'string' ? q : undefined,
    family: typeof family === 'string' ? family : undefined,
    status: (typeof status === 'string' ? status : 'all') as 'all' | 'visible' | 'hidden' | 'no_image' | 'inactive',
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
  });
  res.json(result);
});

app.get('/api/admin/products/export.csv', requireAdmin, (_req, res) => {
  const csv = exportCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="orgat-products.csv"');
  res.send('﻿' + csv); // BOM for Excel Hebrew
});

app.post('/api/admin/products/import.csv', requireAdmin, csvImportLimiter, upload.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'no_file' });
    return;
  }
  const dryRun = req.query.dryRun !== 'false';
  const text = req.file.buffer.toString('utf8').replace(/^﻿/, '');
  try {
    const result = importCsv(text, dryRun);
    res.json({ dryRun, ...result });
  } catch (err) {
    res.status(500).json({ error: redactedError(req.reqId, 'admin/import-csv', err) });
  }
});

app.post('/api/admin/products/bulk', requireAdmin, (req, res) => {
  try {
    const changes = bulkUpdate(req.body || {});
    res.json({ changes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Inline-edit batch save: per-row different values, one transaction.
app.post('/api/admin/products/batch', requireAdmin, (req, res) => {
  try {
    const items = Array.isArray((req.body as { items?: unknown })?.items)
      ? ((req.body as { items: Array<Record<string, unknown>> }).items)
      : [];
    const changes = batchUpdate(items);
    res.json({ changes });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/admin/products/:partname', requireAdmin, (req, res) => {
  const prod = getProductAdmin(req.params.partname);
  if (!prod) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(prod);
});

app.patch('/api/admin/products/:partname', requireAdmin, (req, res) => {
  const updated = patchProduct(req.params.partname, req.body || {});
  if (!updated) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json(updated);
});

app.post(
  '/api/admin/products/:partname/image',
  requireAdmin,
  imageUploadLimiter,
  upload.single('image'),
  ah(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'no_file' });
      return;
    }
    try {
      const result = await saveImage(req.params.partname, req.file.buffer);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: redactedError(req.reqId, 'admin/image-upload', err) });
    }
  })
);

app.delete('/api/admin/products/:partname/image', requireAdmin, (req, res) => {
  deleteImage(req.params.partname);
  res.json({ ok: true });
});

app.get('/api/admin/orders/stuck', requireAdmin, (req, res) => { res.json({ orders: listStuckOrders() }); });
app.get('/api/admin/receipts/failed', requireAdmin, (req, res) => { res.json({ count: failedReceiptCount(), receipts: listFailedReceipts() }); });

app.get('/api/admin/ops-queue', requireAdmin, (_req, res) => {
  res.json({ queues: getOpsQueues(), activity: getRecentActivity(8) });
});

// Give up-for-good receipts (attempts >= 20) one more round: reset attempts, sweep now.
app.post('/api/admin/receipts/retry', requireAdmin, ah(async (_req, res) => {
  db.prepare(`UPDATE priority_receipts SET attempts = 0 WHERE status = 'failed'`).run();
  await sweepPendingReceipts();
  res.json({ ok: true, remaining: failedReceiptCount() });
}));

// Admin order list for the orders screen. scope=open → not yet in Priority.
app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const scope = req.query.scope === 'open' ? 'open' : 'all';
  const where = scope === 'open' ? 'WHERE priority_ordname IS NULL' : '';
  const orders = db.prepare(
    `SELECT o.id, o.custname, o.status, o.payment_status, o.total, o.payment_required_amount, o.priority_ordname, o.error, o.created_at,
            (SELECT MAX(u.cust_desc) FROM users u WHERE u.custname = o.custname) AS cust_desc
       FROM orders_local o ${where} ORDER BY o.created_at DESC LIMIT 200`
  ).all();
  res.json({ orders });
});

// Open (unreconciled) Priority invoices for one customer — cheque-approval match hints.
// Read-only; served from the finance cache when warm.
app.get('/api/admin/customers/:custname/unpaid-invoices', requireAdmin, ah(async (req, res) => {
  res.json({ invoices: await getUnpaidInvoices(String(req.params.custname)) });
}));
app.post('/api/admin/orders/:id/resend', requireAdmin, ah(async (req, res) => {
  const r = await resendApprovedOrder(Number(req.params.id));
  res.status(r.ok ? 200 : 400).json(r);
}));

app.get('/api/admin/dashboard', requireAdmin, (_req, res) => {
  const stats = {
    users: (db.prepare(`SELECT COUNT(*) as c FROM users WHERE role='customer'`).get() as any).c,
    orders: (db.prepare(`SELECT COUNT(*) as c FROM orders_local`).get() as any).c,
    orders_submitted: (db.prepare(`SELECT COUNT(*) as c FROM orders_local WHERE status='submitted'`).get() as any).c,
    leads: (db.prepare(`SELECT COUNT(*) as c FROM leads WHERE status='new'`).get() as any).c,
    invites_pending: (db.prepare(`SELECT COUNT(*) as c FROM invites WHERE used_at IS NULL`).get() as any).c,
    products: (db.prepare(`SELECT COUNT(*) as c FROM catalog_cache WHERE active=1`).get() as any).c,
  };
  res.json(stats);
});

// ---------- API 404 (must precede the SPA fallback so unknown /api paths
// return JSON, not index.html) ----------
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ---------- Static client in production ----------
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const clientDir = path.resolve(__dirname, '../client');
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

// ---------- Global error handler (last) ----------
// Catches sync throws, next(err), and (via the ah() wrapper) async rejections.
// Clients get a request id, never the error detail.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const e = err as { type?: string; status?: number } | null;
  if (e && typeof e === 'object' && e.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'bad_json' });
    return;
  }
  if (e && typeof e === 'object' && e.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  // multer (file upload) errors — map the over-size case to 413, others to 400,
  // instead of a generic 500 for a user-correctable condition.
  const me = err as { name?: string; code?: string } | null;
  if (me && typeof me === 'object' && me.name === 'MulterError') {
    res.status(me.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      error: me.code === 'LIMIT_FILE_SIZE' ? 'payload_too_large' : 'upload_error',
    });
    return;
  }
  console.error(`[error] [${req.reqId ?? '-'}] ${req.method} ${req.path}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error', request_id: req.reqId ?? null });
});

// ---------- Startup ----------
async function startup() {
  await bootstrapAdmin();
  // Expired/idle-dead session cleanup: at boot and once a day after.
  const swept = sweepSessions();
  if (swept > 0) console.log(`[auth] swept ${swept} dead sessions`);
  setInterval(() => sweepSessions(), 86400_000).unref();
  sweepChallenges();
  setInterval(() => sweepChallenges(), 3600_000).unref();
  // Abandoned cheque drafts (+ their encrypted images): sweep at boot and hourly.
  sweepDraftChecks();
  setInterval(() => sweepDraftChecks(), 3600_000).unref();
  // Abandoned held orders (pending_payment, never linked): sweep at boot and hourly.
  sweepPendingOrders();
  setInterval(() => sweepPendingOrders(), 3600_000).unref();
  // Hosted-page card intents that were never completed: PSP-confirm then expire,
  // at boot + every 10 min.
  expireStaleCardIntents().catch((err) => console.warn('[card] expiry sweep failed:', err));
  setInterval(() => { expireStaleCardIntents().catch((err) => console.warn('[card] expiry sweep failed:', err)); }, 10 * 60_000).unref();
  // Orders stranded in 'submitting' by a crash/drain: resolve by BOOKNUM. The stuck
  // set is captured synchronously here (before traffic) — resolution runs async.
  recoverStuckSubmittingOrders().catch((err) => console.warn('[orders] boot recovery failed:', err));
  // Priority receipts: create/retry pending rows at boot and every 5 min.
  sweepPendingReceipts().catch(() => {});
  setInterval(() => { sweepPendingReceipts().catch(() => {}); }, 5 * 60_000).unref();
  // Per-customer discount percents (derived from recent Priority orders): daily.
  sweepCustomerDiscounts().catch((err) => console.warn('[discounts] sweep failed:', err));
  setInterval(() => { sweepCustomerDiscounts().catch((err) => console.warn('[discounts] sweep failed:', err)); }, 86400_000).unref();
  // Daily local DB snapshot (VACUUM INTO, 30d retention) — see server/backup.ts.
  scheduleSnapshots();
  const server = app.listen(PORT, () => {
    console.log(`[prgatB2B] listening on :${PORT}`);
    const config = getPriorityConfig();
    if (config) {
      console.log(`[prgatB2B] Priority configured: ${config.baseUrl}/${config.company}`);
    } else {
      console.warn('[prgatB2B] Priority NOT configured — set PRIORITY_* env vars');
    }
    if (!imageStorageEnabled()) {
      console.warn('[prgatB2B] CHECK_IMAGE_KEY missing/invalid (need 64 hex chars) — cheque uploads will be refused');
    }
  });

  // Graceful shutdown: Railway sends SIGTERM on every deploy. Without this the
  // process dies mid-flight — killing in-progress Priority order submits and
  // payment confirmations. Drain active requests, with a hard cap so a hung
  // connection can't stall the deploy.
  let shuttingDown = false;
  const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[prgatB2B] ${sig} received — draining in-flight requests`);
    server.close(() => {
      console.log('[prgatB2B] drained — exiting');
      process.exit(0);
    });
    server.closeIdleConnections();
    // Above the default 30s Priority timeout so normal in-flight ERP calls finish;
    // anything longer (the rare 120s order POST) is resolved by the boot-time
    // 'submitting' recovery instead of blocking the deploy.
    setTimeout(() => {
      console.warn('[prgatB2B] drain timeout — forcing exit');
      process.exit(0);
    }, 35_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startup().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
