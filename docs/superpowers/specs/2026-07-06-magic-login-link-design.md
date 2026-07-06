# Magic Login Link (קישור כניסה) — Design Spec

**Date:** 2026-07-06
**Status:** Approved (Assaf) — reduce first-login friction for new customers (first: moran / customer 11323)
**Gate:** none needed — the feature is admin-initiated per user; no global flag. Generating no link = today's behavior.

## 1. Problem

Onboarding a customer today means texting a username+password over WhatsApp —
high first-use friction and a plaintext credential in chat. Goal: one WhatsApp
link that logs the customer straight in, no typing.

## 2. Rule

- Admin generates a login link per app user (customer-card → user row →
  "🔗 קישור כניסה"). URL: `{base}/#login-link/{token}`, token = 32 random hex.
- **Reusable until expiry: 14 days.** Rationale: customer sessions idle out
  after 3 days; during onboarding the same WhatsApp link re-admits her.
- **One active link per user** — generating a new one replaces (revokes) the old.
- Clicking → normal customer session (`createSession`, 14-day absolute / 3-day
  idle, same cookie as password login). All business rules apply unchanged.
- Only `status='active'` non-admin users can redeem. Admin accounts NEVER get
  login links.

## 3. Implementation surface

### 3.1 Data + server (`server/loginLinks.ts`, new)

```sql
CREATE TABLE IF NOT EXISTS login_links (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, -- one per user
  token_hash TEXT NOT NULL UNIQUE,        -- sha256, plaintext never stored (session pattern)
  created_by INTEGER,                      -- admin user id
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
```

- `createLoginLink(userId, createdBy): { token, expiresAt }` — UPSERT by
  user_id (replace = revoke previous), TTL 14 days.
- `redeemLoginLink(token): { userId } | null` — hash lookup, must be unexpired,
  user must exist + active + role 'customer'; bumps use_count/last_used_at.
  Does NOT consume (reusable).

### 3.2 Endpoints

- `POST /api/admin/users/:id/login-link` (requireAdmin, sensitiveLimiter) →
  `{ url, expiresAt }` where url uses the existing `appBaseUrl(req)` helper.
  404 for missing/admin users.
- `POST /api/auth/link` (public, `globalLoginLimiter` + `loginLimiter`) body
  `{ token }` → redeem → `createSession(userId,'customer',ip,ua)` +
  `setSessionCookie` → `{ ok: true }`. Invalid/expired → 401
  `{ error: 'הקישור אינו תקף — בקשו קישור חדש' }`. Timing: token lookup is
  hash-based (no user enumeration surface; no bcrypt needed).

### 3.3 Client

- Route `#login-link/<token>` in `src/main.ts` (accessible logged-out; if
  already logged in, POST anyway — redeem replaces the session, so the link
  "just works" on a second device or after a role switch).
- New tiny page `src/pages/loginLink.ts`: spinner "מתחברים…" → POST → on ok:
  full reload to `#home` (picks up session + push/passkey prompts naturally) +
  one-time toast **"מחוברים! מומלץ להפעיל כניסה עם טביעת אצבע בחשבון"**;
  on error: friendly card "הקישור אינו תקף או שפג תוקפו" + link to `#login`.
- Admin customer card: per-user "🔗 קישור כניסה" button (next to the existing
  reset-password action) → calls the endpoint → opens the existing sheet
  pattern with the URL, a **"העתק הודעה"** button copying a WhatsApp-ready
  Hebrew message (link + one-line intro), and the expiry date.

### 3.4 Security posture

- Token 128-bit random, stored hashed, transmitted only in the URL fragment
  (`#…` — fragments are not sent to servers/proxies; our client POSTs it over
  TLS to our API only).
- Holder-of-link = access (accepted, WhatsApp-forward risk): bounded by 14-day
  expiry, one-active-per-user, replace-to-revoke, and rate-limited redemption.
  Strictly better than today's plaintext password in WhatsApp.
- Sessions created are ordinary customer sessions — idle/absolute limits,
  logout, and admin user-disable all work unchanged. Disabling a user
  (status != active) immediately invalidates the link.

## 4. Testing

- Unit (`scripts/test-login-link.mjs`): create → redeem ok (+use_count),
  reuse ok, expiry rejects, replace revokes old token, inactive user rejects,
  admin user rejects, plaintext token absent from DB.
- Live QA: generate for a local test user, open in browser logged-out → lands
  home logged-in; bad token → error card; regenerate → old link 401.

## 5. Out of scope

- Auto-revoke on password reset (regenerate covers it).
- SMS-sending integration (Assaf copies into WhatsApp himself).
- Admin-account links (never).
