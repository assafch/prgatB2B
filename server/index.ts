// prgatB2B server entry — Express, all routes mounted here.

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

import { db } from './db.js';
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
  getProduct,
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
  OrderError,
  reorderToCart,
  setCartLine,
  submitOrder,
} from './orders.js';
import { acceptInvite, createInvite, getInvite, listInvites } from './invites.js';
import { createLead, listLeads, updateLeadStatus } from './leads.js';
import { getPriorityConfig, listCustomers } from './priority.js';
import { getAccountSummary, getInvoices } from './finance.js';
import {
  bulkUpdate,
  deleteImage,
  exportCsv,
  getProductAdmin,
  importCsv,
  listProductsAdmin,
  patchProduct,
  saveImage,
  upload,
  UPLOADS_DIR,
} from './products.js';
import { scheduleSnapshots } from './backup.js';
import { getHomeData } from './home.js';
import { getReorderSuggestions } from './reorder.js';

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
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
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
app.use(express.json({ limit: '2mb' }));
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
  res.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      custname: user.custname,
      cust_desc: user.cust_desc,
    },
  });
}));

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

// ---------- Customer: home dashboard ----------
app.get('/api/home', requireCustomer, homeLimiter, ah(async (req, res) => {
  const data = await getHomeData(req.user!.id, req.user!.custname!, req.user!.cust_desc);
  res.json(data);
}));

// Add the heuristic "usual basket" to the cart in one tap. Validation lives in
// setCartLine, so hidden/unpriced items are silently skipped here.
app.post('/api/reorder/add-all', requireCustomer, cartLimiter, (req: AuthedRequest, res) => {
  const suggestions = getReorderSuggestions(req.user!.id, req.user!.custname!);
  let added = 0;
  for (const s of suggestions) {
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
  const { q, family, page, pageSize } = req.query;
  const result = queryCatalog(req.user!.custname, {
    q: typeof q === 'string' ? q : undefined,
    family: typeof family === 'string' ? family : undefined,
    page: page ? Number(page) : undefined,
    pageSize: pageSize ? Number(pageSize) : undefined,
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
  res.json(getCart(req.user!.id, req.user!.custname!));
});

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

app.post('/api/orders', requireCustomer, ordersMinuteLimiter, ordersDailyLimiter, ah(async (req, res) => {
  const { details } = (req.body || {}) as { details?: string };
  try {
    const result = await submitOrder(req.user!.id, req.user!.custname!, details);
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
  res.json({
    // Local fallbacks (kept for backward-compat / when Priority is unreachable)
    custname: req.user!.custname,
    cust_desc: req.user!.cust_desc,
    email: req.user!.email,
    phone: req.user!.phone,
    // Live Priority data
    profile: summary.profile,
    balance: summary.balance,
    priorityOk: summary.priorityOk,
  });
}));

app.get('/api/invoices', requireCustomer, financeLimiter, ah(async (req, res) => {
  const result = await getInvoices(req.user!.custname!);
  res.json(result);
}));

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
  // Daily local DB snapshot (VACUUM INTO, 30d retention) — see server/backup.ts.
  scheduleSnapshots();
  app.listen(PORT, () => {
    console.log(`[prgatB2B] listening on :${PORT}`);
    const config = getPriorityConfig();
    if (config) {
      console.log(`[prgatB2B] Priority configured: ${config.baseUrl}/${config.company}`);
    } else {
      console.warn('[prgatB2B] Priority NOT configured — set PRIORITY_* env vars');
    }
  });
}

startup().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
