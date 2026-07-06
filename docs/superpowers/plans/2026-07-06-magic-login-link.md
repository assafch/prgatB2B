# Magic Login Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-generated, 14-day reusable login links that sign a customer in with one tap — no username/password.

**Architecture:** New `server/loginLinks.ts` module (token hashed at rest, one active link per user via `user_id PRIMARY KEY` upsert) + two endpoints (admin create, public redeem) + a tiny client landing page + a copy-WhatsApp-message button on the admin customer card. No feature flag: unused = inert.

**Tech Stack:** Express + better-sqlite3 TS ESM; vanilla TS SPA; node assert scripts against dist/.

**Spec:** `docs/superpowers/specs/2026-07-06-magic-login-link-design.md`

## Global Constraints

- Token: 32 hex chars (`crypto.randomBytes(16)`), stored ONLY as sha256 hex (`crypto.createHash('sha256')`, same as sessions); plaintext never persisted or logged.
- One active link per user (`user_id INTEGER PRIMARY KEY` + UPSERT); redeem is reusable (does not consume) until `expires_at` (14 days).
- Redeem requires: unexpired link AND user exists AND `status='active'` AND `role='customer'`. Admin users can neither receive nor redeem links.
- Redeem endpoint rate-limited with the SAME limiters as password login (`globalLoginLimiter`, `loginLimiter`).
- Session created is a standard customer session: `createSession(userId,'customer',ip,ua)` + `setSessionCookie(res, token, 'customer')` — no special session semantics.
- Hebrew copy verbatim as specified. `npm run typecheck` after every task. All migrations additive.

---

### Task 1: Server — loginLinks module, table, endpoints

**Files:**
- Create: `server/loginLinks.ts`
- Modify: `server/db.ts` (schema block — add table near sessions/invites)
- Modify: `server/index.ts` (two routes + import)
- Test: `scripts/test-login-link.mjs` (new)

**Interfaces:**
- Consumes: `db` (db.js), `createSession`/`setSessionCookie` (auth.js — already imported in index.ts), `appBaseUrl(req)` (index.ts:1039), `requireAdmin`, `sensitiveLimiter`, `globalLoginLimiter`, `loginLimiter`, `ah` (all existing in index.ts).
- Produces:
  - `createLoginLink(userId: number, createdBy: number | null): { token: string; expiresAt: string }`
  - `redeemLoginLink(token: string): { userId: number } | null`
  - `POST /api/admin/users/:id/login-link` → `{ url: string; expiresAt: string }`
  - `POST /api/auth/link` `{ token }` → `{ ok: true }` | 401 `{ error }`

- [ ] **Step 1: Write the failing test** — `scripts/test-login-link.mjs`:

```js
// Login-link module. Run: npm run build && DATA_DIR=/tmp/mll-test node scripts/test-login-link.mjs
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import path from 'node:path';
import crypto from 'node:crypto';
const { createLoginLink, redeemLoginLink } = await import('../dist/server/loginLinks.js');
const db = new Database(path.join(process.env.DATA_DIR || './data', 'app.db'));

// Seed: one active customer user, one disabled, one admin
db.prepare("INSERT INTO users (username, password_hash, role, custname, status) VALUES ('mll-active','x','customer','C1','active')").run();
db.prepare("INSERT INTO users (username, password_hash, role, custname, status) VALUES ('mll-off','x','customer','C1','disabled')").run();
db.prepare("INSERT INTO users (username, password_hash, role, status) VALUES ('mll-admin','x','admin','active')").run();
const uid = (u) => db.prepare('SELECT id FROM users WHERE username=?').get(u).id;

// create + redeem (reusable)
const { token, expiresAt } = createLoginLink(uid('mll-active'), null);
assert.match(token, /^[0-9a-f]{32}$/);
assert.ok(new Date(expiresAt).getTime() > Date.now() + 13 * 86400_000);
assert.deepEqual(redeemLoginLink(token), { userId: uid('mll-active') });
assert.deepEqual(redeemLoginLink(token), { userId: uid('mll-active') }, 'reusable');
const row = db.prepare('SELECT * FROM login_links WHERE user_id=?').get(uid('mll-active'));
assert.equal(row.use_count, 2);
assert.ok(row.last_used_at, 'last_used_at set');
// plaintext never at rest
assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
assert.ok(!JSON.stringify(row).includes(token));

// replace revokes old
const second = createLoginLink(uid('mll-active'), null);
assert.equal(redeemLoginLink(token), null, 'old token dead after regenerate');
assert.ok(redeemLoginLink(second.token));
assert.equal(db.prepare('SELECT COUNT(*) c FROM login_links WHERE user_id=?').get(uid('mll-active')).c, 1);

// expiry rejects
db.prepare("UPDATE login_links SET expires_at = datetime('now','-1 hour') WHERE user_id=?").run(uid('mll-active'));
assert.equal(redeemLoginLink(second.token), null, 'expired');

// disabled user rejects; admin rejects at create-redeem level
const offLink = createLoginLink(uid('mll-off'), null);
assert.equal(redeemLoginLink(offLink.token), null, 'inactive user');
const admLink = createLoginLink(uid('mll-admin'), null);
assert.equal(redeemLoginLink(admLink.token), null, 'admin role never redeemable');

// junk token
assert.equal(redeemLoginLink('deadbeef'.repeat(4)), null);
assert.equal(redeemLoginLink(''), null);
console.log('login-link module: ALL PASS');
```

- [ ] **Step 2: Run to fail** — `npm run build && mkdir -p /tmp/mll-test && DATA_DIR=/tmp/mll-test node scripts/test-login-link.mjs` → module missing.

- [ ] **Step 3: Schema** — in `server/db.ts`, near the invites table:

```sql
CREATE TABLE IF NOT EXISTS login_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 4: Implement `server/loginLinks.ts`**:

```ts
// Magic login links — admin-generated, reusable-until-expiry, one per user.
// Token is 128-bit random, stored ONLY as sha256 (same posture as sessions):
// a DB leak must not yield working links. Spec: 2026-07-06-magic-login-link.
import crypto from 'node:crypto';
import { db } from './db.js';

const LINK_TTL_DAYS = 14;

const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Create (or replace — regenerating revokes the previous link) a login link. */
export function createLoginLink(userId: number, createdBy: number | null): { token: string; expiresAt: string } {
  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 86400_000).toISOString();
  db.prepare(
    `INSERT INTO login_links (user_id, token_hash, created_by, expires_at, last_used_at, use_count)
     VALUES (?, ?, ?, ?, NULL, 0)
     ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash, created_by = excluded.created_by,
       created_at = datetime('now'), expires_at = excluded.expires_at, last_used_at = NULL, use_count = 0`
  ).run(userId, hash(token), createdBy, expiresAt);
  return { token, expiresAt };
}

/** Redeem (NOT consumed — reusable until expiry). Null unless the link is live
 *  and its user is an active customer. Admin accounts never redeem. */
export function redeemLoginLink(token: string): { userId: number } | null {
  if (!/^[0-9a-f]{32}$/.test(token || '')) return null;
  const row = db
    .prepare(
      `SELECT l.user_id FROM login_links l
       JOIN users u ON u.id = l.user_id
       WHERE l.token_hash = ? AND datetime(l.expires_at) > datetime('now')
         AND u.status = 'active' AND u.role = 'customer'`
    )
    .get(hash(token)) as { user_id: number } | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE login_links SET use_count = use_count + 1, last_used_at = datetime('now') WHERE user_id = ?`
  ).run(row.user_id);
  return { userId: row.user_id };
}
```

- [ ] **Step 5: Routes** — in `server/index.ts` (import `createLoginLink, redeemLoginLink` from `./loginLinks.js`):

Next to the other `/api/admin/users/:id/*` routes:

```ts
// Magic login link — one active per user, 14 days, reusable. Admin only.
app.post('/api/admin/users/:id/login-link', requireAdmin, sensitiveLimiter, (req: AuthedRequest, res) => {
  const target = db.prepare(`SELECT id, role, status FROM users WHERE id = ?`).get(Number(req.params.id)) as
    | { id: number; role: string; status: string } | undefined;
  if (!target || target.role !== 'customer') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const { token, expiresAt } = createLoginLink(target.id, req.user!.id);
  res.json({ url: `${appBaseUrl(req)}/#login-link/${token}`, expiresAt });
});
```

Next to `/api/auth/login`:

```ts
// Redeem a magic login link → ordinary customer session. Same limiters as
// password login (the token is unguessable, but stay conservative).
app.post('/api/auth/link', globalLoginLimiter, loginLimiter, (req, res) => {
  const { token } = (req.body || {}) as { token?: string };
  const hit = token ? redeemLoginLink(token) : null;
  if (!hit) {
    res.status(401).json({ error: 'הקישור אינו תקף — בקשו קישור חדש' });
    return;
  }
  const session = createSession(hit.userId, 'customer', req.ip, req.headers['user-agent'] as string | undefined);
  setSessionCookie(res, session, 'customer');
  res.json({ ok: true });
});
```

(If `loginLimiter` keys on username, confirm it tolerates a missing username — read its definition; if it requires a field, key the call on `req.body.token` slice or fall back to `globalLoginLimiter` only. Adjust minimally and note in the report.)

- [ ] **Step 6: Test passes** — build + run per Step 2 → `login-link module: ALL PASS`. **Step 7: typecheck + commit** `feat(auth): magic login links — admin create + public redeem (hashed, 14d, one per user)`.

---

### Task 2: Client — landing route + admin copy button

**Files:**
- Create: `src/pages/loginLink.ts`
- Modify: `src/main.ts` (route)
- Modify: `src/pages/adminCustomerCard.ts` (per-user button + sheet)

**Interfaces:**
- Consumes: `POST /api/auth/link`, `POST /api/admin/users/:id/login-link` (Task 1); `api` client; existing sheet/toast utilities in the admin card file (see how reset-password renders its prompt — reuse the same mechanism).

- [ ] **Step 1: `src/pages/loginLink.ts`**:

```ts
import { api } from '../api.js';

/** Magic-link landing: redeem → hard reload into the logged-in app. Hard
 *  navigation (not hash swap) so main.ts re-runs /api/me with the new cookie. */
export function renderLoginLink(shell: HTMLElement, token: string): void {
  shell.innerHTML = `<div class="card" style="text-align:center;padding:2rem"><div class="es-icon">🔑</div><div class="es-title">מתחברים…</div></div>`;
  void (async () => {
    try {
      await api.post('/api/auth/link', { token });
      sessionStorage.setItem('mll-welcome', '1');
      window.location.href = window.location.origin + '/#home';
      window.location.reload();
    } catch {
      shell.innerHTML = `
        <div class="card" style="text-align:center;padding:2rem">
          <div class="es-icon">⏱️</div>
          <div class="es-title">הקישור אינו תקף או שפג תוקפו</div>
          <div class="es-sub">בקשו קישור חדש, או היכנסו עם שם משתמש וסיסמה.</div>
          <a class="es-cta" href="#login" style="display:inline-block;margin-top:0.8rem">לכניסה רגילה</a>
        </div>`;
    }
  })();
}
```

- [ ] **Step 2: Route** — in `src/main.ts`, next to the `#invite/` route (~line 145), BEFORE the logged-in redirect guard applies to it (mirror how `#invite/` is allowed while logged out; the link must work logged-OUT and logged-IN — check line ~136's redirect list and ensure `#login-link/` is NOT bounced to #home before redeeming):

```ts
  if (hash.startsWith('#login-link/')) {
    const token = hash.slice('#login-link/'.length);
    return renderLoginLink(mount(''), token);
  }
```

Also in `renderHome`'s entry (src/pages/home.ts is NOT touched — instead in main.ts after successful boot) show the one-time nudge: where the app finishes rendering home after load, if `sessionStorage.getItem('mll-welcome')`, `sessionStorage.removeItem(...)` and `toast('מחוברים! מומלץ להפעיל כניסה עם טביעת אצבע בחשבון', 'ok')` — put this in main.ts's post-route hook for `#home` (find where toasts are available; if main.ts doesn't import toast, add the import from ui.js).

- [ ] **Step 3: Admin button** — in `src/pages/adminCustomerCard.ts`, in the per-user actions row (next to the reset-password button, ~line 281): add `<button class="cc-loginlink" data-id="${u.id}">🔗 קישור כניסה</button>` (match sibling button classes/style). Handler:

```ts
      shell.querySelectorAll<HTMLButtonElement>('.cc-loginlink').forEach((b) => {
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const r = await api.post<{ url: string; expiresAt: string }>(`/api/admin/users/${b.dataset.id}/login-link`, {});
            const exp = new Date(r.expiresAt).toLocaleDateString('he-IL');
            const msg = `שלום! מעכשיו מזמינים מאורגת סחר ישירות מהאפליקציה 📱\nלחצו על הקישור והאפליקציה תיפתח מחוברת — בלי סיסמה:\n${r.url}\n(הקישור בתוקף עד ${exp})`;
            await navigator.clipboard.writeText(msg);
            toast('הודעת וואטסאפ עם הקישור הועתקה — הדביקו ושלחו ✓', 'ok');
          } catch (ex) {
            toast(ex instanceof Error ? ex.message : String(ex), 'error');
          } finally {
            b.disabled = false;
          }
        });
      });
```

(Import `toast` if the file doesn't already; if the file uses a sheet pattern for prompts, clipboard+toast is sufficient here — one tap, message ready.)

- [ ] **Step 4: typecheck + commit** `feat(client,admin): magic-link landing page + one-tap WhatsApp copy on customer card`.

---

### Task 3: QA + deploy

- [ ] QA_PLAN.md append:

```markdown
## Magic login links

- [ ] Admin: 🔗 on a user row copies a WhatsApp message with a working link (expiry shown).
- [ ] Logged-out browser: link → "מתחברים…" → lands on home logged in; welcome toast once.
- [ ] Link reusable: second open still works; use_count increments.
- [ ] Regenerate: old link → error card with כניסה רגילה fallback.
- [ ] Expired/garbage token → error card; no session.
- [ ] Disabled user / admin user → link rejected.
- [ ] Rate limit: redemption shares login limiters.
```

- [ ] Full verification: typecheck + build + `DATA_DIR=/tmp/mll-test node scripts/test-login-link.mjs` + existing suites (`test-overdue-block.mjs`, `test-payment-policy.mjs`, `test-checkout-preview.mjs`, `test-saved-card.mjs` with scratch env) all pass.
- [ ] Controller live QA (local dev): full flow per QA cases with a throwaway user; cleanup after.
- [ ] Merge to main → push → verify Railway deploy (new bundle, site 200, `/api/auth/link` returns 401 JSON on garbage token — proves route live).

## Rollback

No flag needed: revoking a customer's link = regenerate or disable the user; feature unused = zero behavior change. Full revert = `git revert` of the merge.
