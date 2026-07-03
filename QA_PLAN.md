# prgatB2B — Full QA Plan

Status: living document. Covers everything built through 2026-06-10 (P0 hardening,
P1 dashboard/UX, P2 passkeys, invoices + detail, check-photo payments).

## 0. Test environment & accounts

| What | Value |
|---|---|
| Production | https://web-production-ac422.up.railway.app |
| Local | `npm run dev` (Vite + tsx), `.env` holds secrets (gitignored) |
| Test customer | `elibait` / (password in the team vault — NEVER commit it; the previously committed one must be rotated) — real customer **הכל לבית אלי**, custname **10516**, רמת גן |
| Admin | `assaf` / (rotate this) — full admin |
| Priority | company a051014, env tabp008h.ini — **READ-ONLY for QA** |

### ⚠️ Hard rules during QA
1. **Never submit a real order or receipt to production Priority** without explicit
   sign-off (irreversible external action). Test order submission only against a
   Priority sandbox or with a dry-run flag; otherwise stop at the cart/review step.
2. **Never run real card charges**; card flow is gated (`PAYMENTS_ENABLED=false`).
3. Cheque test uploads create real rows — **cancel them afterwards** (cancel also
   erases the image) so the real customer's data stays clean.
4. Use the test customer, not other live customers, for write flows.

---

## 1. Auth & sessions

| # | Case | Expected |
|---|---|---|
| 1.1 | Password login (valid) | 200, session cookie set (HttpOnly, Secure, SameSite), lands on #home |
| 1.2 | Wrong password ×N | per-IP + global login rate-limit kicks in; generic error (no user enumeration) |
| 1.3 | Logout | session row deleted server-side; protected routes 401 after |
| 1.4 | Session expiry / idle | re-auth required; tab-focus re-checks `/api/auth/me` |
| 1.5 | Passkey register (enrolled device) | WebAuthn ceremony succeeds; credential stored; userVerification required |
| 1.6 | Passkey login (usernameless/discoverable) | logs in without typing username; RP_ID = exact host |
| 1.7 | Change password | succeeds; **invalidates all passkeys** (deletes webauthn_credentials) |
| 1.8 | Invite onboarding | invite link → set password → customer created with correct custname |
| 1.9 | Role separation | customer cannot reach #admin or `/api/admin/*` (403); admin redirected to #admin |
| 1.10 | CSRF / Origin | cross-origin POST without valid Origin blocked |

## 2. Dashboard (#home)

| # | Case | Expected |
|---|---|---|
| 2.1 | Open debt | matches OBLIGO.ACC_DEBIT and the official "חובות שטרם שולמו" statement (10516 = ₪710.12) |
| 2.2 | Balance unavailable | when balance form unreachable, shows "לא זמין" not a misleading ₪0 |
| 2.3 | Credit-utilization bar | shows only when obligo+limit present; warn ≥90%, over ≥100% |
| 2.4 | "Pay by cheque" CTA | visible when `features.checkPayment`; routes to #pay/check |
| 2.5 | Card CTA | hidden while `PAYMENTS_ENABLED=false` |
| 2.6 | Last order + reorder | one-tap reorder adds available lines to cart |
| 2.7 | Usual basket | "add all" adds the habitual items |
| 2.8 | First-time customer | welcome state, no false "no debt — well done" |

## 3. Catalog & product

| # | Case | Expected |
|---|---|---|
| 3.1 | Browse / categories | products render with images, B2B names, prices |
| 3.2 | Search | Hebrew search returns relevant items |
| 3.3 | Per-customer pricing | prices reflect the customer's Priority price list |
| 3.4 | Box size / min order | quantity steppers respect box size; min-order enforced |
| 3.5 | Hidden / out-of-stock | hidden products not shown; OOS handled |
| 3.6 | Product detail | description, image, price, add-to-cart |

## 4. Cart & checkout

| # | Case | Expected |
|---|---|---|
| 4.1 | Add / update / remove | cart badge + totals update; persisted per session |
| 4.2 | Totals & VAT | line totals, subtotal, VAT, grand total correct |
| 4.3 | Min-order gate | checkout blocked below minimum with clear message |
| 4.4 | Submit order | **(sign-off required)** posts to Priority ORDERS; idempotent; rate-limited (min+daily) |
| 4.5 | Priority failure | order marked failed, retry budget not burned, user sees actionable error |
| 4.6 | Empty cart | checkout disabled |

## 5. Orders

| # | Case | Expected |
|---|---|---|
| 5.1 | Orders list | shows submitted/submitting/failed with status chips |
| 5.2 | Order detail | line items, totals, status |
| 5.3 | Reorder | re-adds available items |

## 6. Invoices

| # | Case | Expected |
|---|---|---|
| 6.1 | Invoice list | history rows clickable, sorted, dated |
| 6.2 | **Invoice detail** | tap → header + line items + pre-VAT/VAT/total (regression: the `$expand` inner-`$select` 404 bug — verify ALL invoices, incl. old ones) |
| 6.3 | IDOR | `/api/invoices/:ivnum` for another customer's invoice → 404 (scoped to session custname) |
| 6.4 | Open-list label | no misleading "· 0 חשבוניות פתוחות" |
| 6.5 | openListIncomplete | warning shown when total>0 but list empty |

## 7. Payments — cheque (check-photo)

| # | Case | Expected |
|---|---|---|
| 7.1 | Camera capture | 📸 opens camera on mobile |
| 7.2 | Gallery + multi-select | 🖼️ allows picking several WhatsApp images at once |
| 7.3 | AI read accuracy | on well-shot cheques: amount, post-dated date, bank/branch/cheque# correct (validated on 5 real cheques) |
| 7.4 | Bad/blank image | rejected with retake prompt; never hallucinated numbers |
| 7.5 | Non-image upload | 400 "הקובץ אינו תמונה תקינה" |
| 7.6 | Manual fallback | with no AI key / unreadable, customer types amount+date |
| 7.7 | Multi-cheque submit | N cheques confirmed together; running total; partial-failure surfaced |
| 7.8 | Confirm validation | amount>0 and ISO date enforced server-side; is_postdated derived server-side |
| 7.9 | Encryption at rest | image AES-256-GCM on volume; never under /uploads; never web-served |
| 7.10 | Masked account | DB/admin show `****1234` only; full account only inside the encrypted image |
| 7.11 | Owner image access | owner streams own image (200); another customer → 404 (IDOR) |
| 7.12 | Admin reconciliation | "תשלומים" tab: list, status dropdown, image view |
| 7.13 | Erase on cancel | cancel → image unlinked → image route 404 |
| 7.14 | Draft sweep | abandoned drafts + .enc files removed after 48h |
| 7.15 | Rate / cost cap | parse endpoint: per-minute + per-day + org-wide limits |
| 7.16 | Chex framing | copy says "יופקדו לפירעון, אין צורך למסור צ׳ק פיזי" (no driver) |

## 8. Admin

| # | Case | Expected |
|---|---|---|
| 8.1 | Dashboard stats | customers/orders/leads/catalog counts accurate |
| 8.2 | Product management | edit B2B name/desc/tags/box/min/visibility/featured/category |
| 8.3 | Image upload | product photo upload + validation |
| 8.4 | CSV import/export | round-trips without corruption |
| 8.5 | Catalog sync | pulls LOGPART from Priority into local cache |
| 8.6 | Customer pricing refresh | per-customer price list refresh |
| 8.7 | Invites | create link, list, expiry, single-use |
| 8.8 | Leads | public contact form → lead list |
| 8.9 | Payments reconcile | status transitions; cannot promote a never-confirmed draft |

## 9. Security (cross-cutting)

| # | Case | Expected |
|---|---|---|
| 9.1 | IDOR sweep | every `:id`/`:ivnum`/custname-scoped route rejects cross-tenant access |
| 9.2 | Headers | CSP, X-Content-Type-Options:nosniff, HSTS, no-store on sensitive |
| 9.3 | Cookie flags | HttpOnly, Secure, SameSite on session cookie |
| 9.4 | Secrets | none in client bundle; `.env`/`.railway-deploy.json` gitignored; **git history scanned before repo public** |
| 9.5 | Rate limits | login, orders, cheque-parse all capped |
| 9.6 | Input validation | amounts, dates, IDs, file types validated server-side |
| 9.7 | Error handling | generic errors + request_id; no stack/SQL/secret leakage |
| 9.8 | bcrypt | password hashing cost sane; no plaintext |
| 9.9 | Passkey | userVerification 'required'; response.id type-guarded; userHandle cross-check |
| 9.10 | AI injection | cheque image treated as data-only; embedded "instructions" ignored |
| 9.11 | Privacy/compliance | cheque images → Anthropic sub-processor: DPA + privacy-policy disclosure (Israeli Privacy Law) |

## 10. PWA / UX / platform

| # | Case | Expected |
|---|---|---|
| 10.1 | RTL + Hebrew | layout, dates, numbers correct RTL; no mojibake |
| 10.2 | Mobile responsive | bottom nav, cards, capture page on small screens |
| 10.3 | Service worker | registers in prod only; offline shell; **no SW in dev** (NODE_ENV trap) |
| 10.4 | Install / manifest | installable PWA, icons, name |
| 10.5 | Empty / error / loading states | every page has skeleton + empty + error states |
| 10.6 | Accessibility | tap targets, contrast, labels |

## 11. Priority integration resilience

| # | Case | Expected |
|---|---|---|
| 11.1 | Per-form availability | forms not API-enabled degrade gracefully (balanceOk/priorityOk flags), no crash |
| 11.2 | Debt source | OBLIGO.ACC_DEBIT authoritative; CHEQUE_DEBIT excluded |
| 11.3 | Connection drops | reads that 200-then-terminate handled (see invoice $expand fix) — audit other $expand calls |
| 11.4 | PAT/auth | `Basic base64(PAT:PAT)` on the right env (.ini) |

---

## 12. How to run it

**Smoke (fast, every deploy):** scripted curl/Node against prod with the test
customer — login, /api/home, /api/invoices + each detail, catalog, cart add,
cheque parse→confirm→cancel, admin list. (Most of this already exists ad-hoc in
the session history; consolidate into `scripts/smoke.mjs`.)

**Manual exploratory:** walk sections 1–10 on a real phone (camera, RTL, install).

**Automated regression (recommended):** a multi-agent QA workflow that, per
section, drives the live endpoints + a headless browser, asserts expected
outcomes, and adversarially probes IDOR/validation — then reports a pass/fail
matrix. Opt-in (it spawns many agents); ask to run it.

## 13. Bug log format
`[severity] area — symptom — repro — expected vs actual — fix/owner`.
Track regressions here as they're found.

## Admin control center (Stage 8) — 2026-07-03

Cases below cover the grouped-sidebar/bottom-nav shell, the "דורש טיפול" ops
rail, the drawer editing pattern, and the kill-switch panel added in Stage 8
(`src/pages/adminShell.ts`, `adminDashboard.ts`, `adminPayments.ts`,
`adminSettings.ts`). Rows marked **PASS — controller walk 2026-07-03** were
confirmed live during the controller's visual walk of the new admin that day;
rows left unmarked are genuine gaps — mostly actions that write real data
(Priority orders, cheque status, lead status) that the walk didn't exercise.

| # | Case | Expected |
|---|---|---|
| CC.1 | Sidebar / bottom-nav routing + off-nav deep links | every sidebar item (desktop ≥1024px) and bottom-nav item + "עוד" sheet (mobile <1024px) routes to its screen; `#admin/users` and `#admin/invites` — which left the nav but stayed in the router (design law) — still render when the hash is typed or linked directly (PASS — controller walk 2026-07-03) |
| CC.2 | Ops-rail resend-all idempotence | "שלח ל-Priority" on the stuck-orders rail card, run twice in a row: first run resends the stuck set, second run finds zero stuck orders left and no-ops (no duplicate order sent to Priority) — not exercised: not clickable against live Priority in the walk |
| CC.3 | Typed-confirm cancel path | flipping a switch toward its `dangerousValue` opens the "הקלד/י את שם המתג" sheet; dismissing it (Escape, backdrop, ✕, or leaving the typed value mismatched) resolves `false` and leaves the switch and its setting untouched — no PATCH sent (PASS — controller walk 2026-07-03) |
| CC.4 | Drawer Escape/backdrop/hashchange close | the `openDrawer()` panel (customer/promotion editors) closes on Escape key, backdrop click, and `hashchange` (back/forward or navigating to another route) — same three dismiss paths as the existing bottom sheet (PASS — controller walk 2026-07-03) |
| CC.5 | Cheque approve → history flow + badge decrement | "✓ אשר צ׳ק" on a submitted cheque moves it out of the צ׳קים queue into היסטוריה, and the pay-tabs badge + "תשלומים" nav/rail badge count decrement by one — not exercised: approving writes a real status change to a live submitted cheque; not run in the visual walk |
| CC.6 | Lead triage decrements badge | marking a new lead as handled/contacted removes it from `newLeads.count` and decrements the "לידים" nav badge + dashboard rail card — not exercised: writes a real lead status change; not run in the visual walk |
| CC.7 | RTL drawer slide direction | `.adm-drawer` slides in and sits on the correct edge for the RTL layout (not mirrored) on desktop widths (PASS — controller walk 2026-07-03) |
| CC.8 | 44px+ tap targets | mobile bottom-nav items and the "+" FAB (`.adm-fab`) meet the ~44px minimum touch target at phone widths (PASS — controller walk 2026-07-03) |
| CC.9 | Sparkline direction matches labels (RTL) | revenue sparkline series runs right→left (newest point leftmost), matching the month-label flex row under it — **regression found in this walk**: the SVG `x` mapping ran oldest→newest left→right (SVG coords are LTR) against an RTL label row whose first (oldest) label renders rightmost, so the newest-point dot sat above the oldest month label; fixed same day by mirroring the `x` mapping in `sparkline()` (`src/pages/adminDashboard.ts`) — pending a fresh visual re-check on the next deploy |
