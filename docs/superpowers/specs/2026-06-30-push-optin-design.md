# Design: Push-notification opt-in for new users

**Project:** prgatB2B · **Branch:** `feat/payment-policy` · **Date:** 2026-06-30 · **Status:** Approved

## Goal

Get new users to approve web-push notifications, so order/payment pushes (which already
fire via `notifyUser`) actually reach them. Two surfaces (owner's choice): a one-time
**home opt-in card** + a **post-order reminder** (the high-intent moment — they want to know
when the order is approved).

## What already exists (no server change needed)

`src/push.ts`: `pushSupported()`, `pushSubscribed()`, `enablePush()` (does
`Notification.requestPermission()` → `pushManager.subscribe()` → `POST /api/push/subscribe`),
`disablePush()`. Service worker `public/sw.js` (registered in `src/pwa.ts`). Server
`/api/push/vapid|subscribe|unsubscribe` + `push_subscriptions` + `notifyUser`. Today
`enablePush()` is only reachable from the Account page.

## New: `src/pages/pushPrompt.ts`

- `shouldOfferPush(): boolean` — true when `pushSupported()` **and**
  `Notification.permission === 'default'` **and** not dismissed within the cooldown
  (localStorage `push_optin_dismissed_until` > now). False once granted/denied or subscribed.
- `iosNeedsInstall(): boolean` — true on iOS Safari **not** running as an installed PWA
  (`/iphone|ipad|ipod/i` UA && not `display-mode: standalone` / `navigator.standalone`).
  On iOS, web push only works after **Add to Home Screen** (iOS 16.4+), and `pushSupported()`
  is false in a plain tab — so we show install guidance instead of an enable button.
- `renderPushCard(host: HTMLElement, opts?: { compact?: boolean }): void` — injects the opt-in
  UI when relevant:
  - iOS-needs-install → a card: "להוספת התראות, הוסיפו את האפליקציה למסך הבית (שיתוף → הוסף למסך הבית)".
  - else if `shouldOfferPush()` → a card: "🔔 קבלו עדכון כשההזמנה מאושרת ובתשלומים" + **[אפשר התראות]**
    (→ `enablePush()`; on success `toast('התראות הופעלו ✓','ok')` + remove card; on reject
    toast the error) + **[אחר כך]** (→ set `push_optin_dismissed_until = now + 14d`, remove card).
  - else → renders nothing.
  All wiring is from the button tap (never auto-request on load).

## Wiring (two call sites, same component)

- **Home** (`src/pages/home.ts`): call `renderPushCard` into a slot near the top, after login.
- **Post-order** (`src/pages/checkout.ts`): after a successful order submit, call `renderPushCard`
  (compact) so they're offered notifications right when they'd want order updates. Same
  dismissal cooldown is respected (no double-nag).

## Constraints (the "how")

1. Permission is requested **only on the button tap** (browsers ignore/penalize auto prompts).
2. **iOS** needs the PWA installed to the home screen — handled by `iosNeedsInstall()` guidance.
3. One dismissal cooldown (14 days, localStorage) shared by both surfaces.

## Testing

typecheck + build; dev-browser: with `Notification.permission='default'` the home card renders
with an "אפשר התראות" button; after dismiss it doesn't re-render (cooldown set); when
`permission!=='default'` nothing renders. (Can't grant real permission in headless — assert
the card + button presence + dismissal behavior.) No server change. Deploy per the standing
always-deploy rule.

## Out of scope

Server/push delivery (already works); SMS/email; richer notification preferences.
