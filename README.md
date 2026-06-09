# prgatB2B

אפליקציית הזמנות B2B לאורגת סחר בע"מ. PWA בעברית (RTL), מחוברת ל-Priority ERP.

לקוחות עסקיים מתחברים בשם משתמש + סיסמה, רואים קטלוג עם מחיר אישי לפי `CUSTNAME` ב-Priority, מוסיפים לסל, ושולחים הזמנה שנכנסת אוטומטית כ-`ORDERS` ב-Priority.

## Stack

- **Frontend:** Vanilla TS + Vite, Hebrew RTL, PWA
- **Backend:** Express (ESM, TypeScript) — `tsx` בפיתוח, `tsc` ל-build
- **DB:** SQLite (`better-sqlite3`) על volume פרסיסטנטי
- **Auth:** bcrypt + cookie sessions, שני תפקידים (`customer` / `admin`)
- **Priority:** OData REST + PAT

## Local development

```bash
# 1. Install
npm install

# 2. Copy env and fill it in
cp .env.example .env
#   PRIORITY_PAT, SESSION_SECRET, ADMIN_BOOTSTRAP_*

# 3. Run both server (:3030) + Vite (:5175) concurrently
npm run dev

# Open http://localhost:5175
# (Vite proxies /api/* to the Express server on :3030)
```

## Project structure

```
prgatB2B/
├── server/
│   ├── index.ts        # Express + routes
│   ├── auth.ts         # bcrypt + sessions
│   ├── db.ts           # SQLite schema + migrations
│   ├── priority.ts     # Priority OData client (catalog + customer + invoices + AR)
│   ├── finance.ts      # Customer profile/balance/invoices (TTL-cached)
│   ├── catalog.ts      # Product + pricing cache
│   ├── orders.ts       # Order submission + Priority order history
│   ├── promotions.ts   # Buy X Get Y engine
│   ├── invites.ts      # Invite tokens
│   ├── leads.ts        # Public lead form
│   └── admin.ts        # Admin endpoints
├── src/
│   ├── main.ts         # Hash router
│   ├── pages/          # One file per screen
│   ├── api.ts          # fetch wrapper
│   ├── pwa.ts          # Service worker registration
│   └── styles.css
├── public/
│   ├── manifest.json
│   ├── sw.js
│   └── icons/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json / tsconfig.server.json
├── railway.json
└── .env.example
```

## Roadmap

1. ✅ Scaffold
2. ✅ DB schema + auth (bcrypt + cookie sessions)
3. ✅ Priority client (port + extend מ-`order-to-priority`)
4. ✅ Customer API — catalog, cart, orders
5. ✅ Frontend MVP — login + catalog + cart + history
6. ✅ Invites + leads
7. ✅ Admin UI (product control panel, CSV, image upload)
8. ⏳ Promotions engine (Buy X Get Y) — schema in place, engine pending
9. ✅ PWA wiring
10. ✅ **Customer financial view — live Priority profile, open balance, open invoices, invoice history, order history** (`#account` + `#invoices` + `#orders`)
11. ✅ **Product images from Priority** — pulled from inline base64 on `LOGPART.EXTFILENAME`, transcoded to WebP under `/uploads`, shown in catalog + product pages (64/291 parts)
12. ⏳ Deploy ל-Railway, domain `b2b.orgat.co.il`

### Customer financial view (Priority entities)

| תצוגה | Entity | שדות מפתח |
|---|---|---|
| פרופיל לקוח | `CUSTOMERS` | CUSTNAME, CUSTDES, ADDRESS, STATE, PHONE, EMAIL, PAYDES, AGENTNAME |
| יתרה / חוב פתוח | `OPENINVOICES` | TOTPRICE (כולל מע״מ) — יתרה לתשלום = Σ TOTPRICE |
| היסטוריית חשבוניות | `AINVOICES` | IVNUM, IVDATE, TOTPRICE, STATDES (`סופית` בלבד), זיכוי = `IK*`/שלילי |
| חשיפת אשראי | `OBLIGO` | OBLIGO, MAX_CREDIT |
| היסטוריית הזמנות | `ORDERS` | ORDNAME, CURDATE, ORDSTATUSDES |

מטמון TTL קצר (5 דק') ב-`server/finance.ts` שומר אותנו מתחת ל-100 קריאות/דקה.

## Priority reference

ראו `/Users/assaf/Documents/order-to-priority/CLAUDE.md` — תיעוד מקיף של OData entities, subforms, error handling.
