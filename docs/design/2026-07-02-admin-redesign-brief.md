# Admin Control Center — Redesign Brief (current state + direction)

Prepared 2026-07-02. Source of truth for handing the admin redesign to a design tool (Stitch) or for a direct in-code redesign. Current-state facts below were captured from a live seeded instance (all 11 tabs screenshotted at 1456px, logged in as admin).

**Reproduce the live demo anytime:**
```bash
export PATH=/opt/homebrew/opt/node@24/bin:$PATH && npm run build
DATA_DIR=/tmp/adm-vis PORT=3184 NODE_ENV=production \
  ADMIN_BOOTSTRAP_USERNAME=demoadmin ADMIN_BOOTSTRAP_PASSWORD='Demo!admin12' \
  node dist/server/index.js
# then seed products/users/orders — see git history of this file's commit for the seed SQL
```

## 1. What the admin is (subject grounding)

The operations cockpit of **Orgat Sahar** — a family FMCG/hardware distributor (est. 1968) whose owner (Assaf) runs the business largely alone, often from a phone. It manages: the Priority-ERP-backed product catalog, per-customer pricing/policy/discounts, customer logins, promotions, cheque + card payment reconciliation, order recovery, leads, and system kill-switches. One primary user. Hebrew RTL. The **customer-facing app** already has a strong identity (Stitch redesign: navy `#041646` CTAs, Orgat royal blue `#234d8f`, coral gradient debt card `#ed7568→#e6645d`, cool blue-gray bg `#ecf0f4`, 3D Fluent icons, 10px radius cards) — **the admin never got that treatment** and looks like an unstyled prototype next to it.

## 2. Current structure (as-is inventory)

Flat horizontal tab strip, 11 tabs, no icons, no grouping:
`לוח בקרה · דוחות · ניהול מוצרים · סנכרון Priority · משתמשים · לקוחות · מבצעים · הזמנות-לקוח · תשלומים · לידים · הגדרות`

| Screen | What's there today (verified by screenshot) |
|---|---|
| לוח בקרה | 6 plain white stat tiles (לקוחות רשומים, הזמנות, נשלחו ל-Priority, לידים חדשים, הזמנות פתוחות, מוצרים בקטלוג) floating in whitespace. No actions, no activity feed, no alerts. |
| דוחות | Stacked full-width cards (הכנסות לפי חודש, מוצרים מובילים, חייבים מובילים, לקוחות שלא הזמינו 90+) each showing "טוען…" then a plain table. No charts. |
| ניהול מוצרים | The most mature screen: dense RTL table w/ inline multi-row editing (ארגז/מינ׳/מחיר/הסתר/אזל/⭐), search + family/status filters, CSV import/export, pagination. |
| סנכרון Priority | Manual sync buttons + last-sync status. |
| משתמשים | Creation form ABOVE the list; each user row has a flat button row (איפוס סיסמה, השבת, ערוך מספר לקוח, מחק). |
| לקוחות | Table w/ inline policy editing per company (סוג תשלום select, סף חוב, פטור, אכוף) — the סף חוב input is visibly clipped ("et)…"); finance columns show "—" until cached. Click-through to card. |
| לקוחות/card | Long vertical card stack: מדיניות תשלום form (floating checkboxes, weak label association) → הנחת לקוח row → נתוני Priority → user list → danger zone (מחק הזמנות וסל). Breadcrumb is a bare "‹ חזרה". |
| מבצעים | Creation form above list; empty state is a dead end ("אין מבצעים עדיין."). |
| הזמנות-לקוח | Invite creation + list (same form-above-list pattern). |
| תשלומים | Empty state "אין תשלומי צ'ק עדיין." — no cheque/card sub-tabs visible when empty, no filter chrome; cheque recon actions appear only with data. |
| לידים | Plain list of lead rows. |
| הגדרות | One long undifferentiated form: business-critical kill switches (תשלום בכרטיס, מצב תחזוקה, מדיניות תשלום, קבלות Priority) styled identically to cosmetic ones (באנר), followed by ops-monitoring cards (הזמנות ששולמו וטרם נשלחו, קבלות שנכשלו) that actually belong on a dashboard. |

**Design tokens currently in code** (src/styles.css `:root`): brand `#234d8f`, brand-dark `#18386b`, accent `#19b6c4`, bg `#ecf0f4`, surface `#fff`, text `#1a1a1a`, muted `#6b7280`, border `#e5e7eb`, ok `#16a34a`, warn `#d97706`, err `#dc2626`, coral `#ed7568`, navy `#041646`, radius 10px, shadow subtle. Font: system stack (no brand face).

## 3. Usability findings (what the redesign must fix)

1. **No hierarchy of frequency.** Daily-ops tasks (payments to reconcile, stuck orders, new leads) sit behind the same flat tabs as one-time setup (סנכרון, הגדרות). 11 undifferentiated tabs exceed scanning capacity.
2. **The dashboard answers "how much?" but never "what needs me now?"** The real ops queue (paid-but-unsent orders, failed receipts, cheques awaiting reconciliation, new leads) is scattered — some of it inside הגדרות, which is the last place an operator looks daily.
3. **Form-above-list** (users, promotions, invites) pushes the actual data below the fold; creation is rare, viewing is constant.
4. **Three different editing paradigms** (inline table cells, card forms, settings form) with no shared pattern; the customers board even clips its own inputs.
5. **Kill-switches look like preferences.** תשלום בכרטיס and מצב תחזוקה can stop revenue; they're visually identical to the banner toggle.
6. **Dead-end empty states** with no CTA or explanation of how data gets here.
7. **Weak wayfinding**: no breadcrumbs beyond "‹ חזרה", no icons, no active-section identity; the customer card is a wall of same-weight cards.
8. **Mobile is an afterthought** — the owner manages from his phone; the tab strip and wide tables don't adapt.

## 4. Design direction (proposed)

Keep the customer app's identity (it IS the brand now) but make the admin read as the **back-of-house counterpart**: same palette, denser, quieter, tool-like.

- **Color**: bg `#ecf0f4`, surface white, navy `#041646` for the nav rail + primary actions, royal `#234d8f` for links/active, coral `#ed7568` reserved EXCLUSIVELY for "needs attention" signals (counts, alerts, danger). ok/warn/err as today. Never coral for decoration.
- **Type**: Heebo (or Assistant) — 700 for screen titles & KPI numerals, 400/500 for body; tabular numerals for money columns. One scale: 22/16/14/12.
- **Structure**: replace the tab strip with a **grouped sidebar** (desktop ≥1024px) / **bottom nav + sheet** (mobile):
  - **תפעול יומי**: לוח בקרה, תשלומים, הזמנות (incl. stuck-order recovery), לידים
  - **מסחר**: מוצרים, מבצעים, לקוחות (users + invites folded INTO each customer), הנחות
  - **מערכת**: דוחות, סנכרון Priority, הגדרות
- **Signature element — "דורש טיפול" ops rail**: the one memorable thing. A persistent queue strip at the top of the dashboard (and as badges on the sidebar): coral-accented cards for *paid-but-unsent orders / failed receipts / cheques to reconcile / new leads*, each with its count and ONE direct action. This is the admin twin of the customer app's coral debt card — same visual DNA, same meaning: "money needs you".
- **Patterns**: one list+side-drawer editing pattern everywhere (click row → drawer with the form; creation via a floating "+" that opens the same drawer). Empty states name the trigger ("צ'קים שצולמו ע"י לקוחות יופיעו כאן") + one action. Kill-switches get a dedicated "מתגי מסחר" panel with status pills (פעיל/כבוי) and confirmation on the dangerous direction.
- **Restraint**: no charts-for-charts'-sake in דוחות — keep tables, add small sparklines only on the revenue card. No animation beyond drawer slide + count-up on KPI load.

## 5. How to hand this to a design tool

- **Stitch (recommended — same flow as the home-screen redesign):** create a project, upload §1–§4 of this file as the design-md, generate the 3 key screens first (dashboard w/ ops rail, customers board + drawer, settings w/ kill-switch panel), pick a winner, generate the remaining screens in its style, then pixel-match implement.
- **Direct in-code**: implement §4 straight into `src/pages/admin*.ts` behind the existing routing, iterating against the local demo above.
- **Any other tool**: re-run the demo, screenshot the 11 tabs, attach them + this brief.
