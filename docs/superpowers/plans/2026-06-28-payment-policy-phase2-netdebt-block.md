# Payment Policy — Phase 2 (Net-terms debt block) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Block a net-terms customer from placing an order while they have uncovered open debt above the threshold — enforced server-side, surfaced at checkout. Inert unless `payment_policy_enabled` is on.

**Architecture:** Reuse the Phase-1 engine (`server/paymentPolicy.ts` `policyEnabled()` + async `evaluate(custname, cartTotal)` → `{ allowOrder, reason, amount }`). Add one server gate in `submitOrder()` and one client pre-block in checkout. Cash customers are NOT gated here (Phase 3). Spec §6a/§6c.

**Tech Stack:** TS Express + vanilla-TS client. Verify: `npm run typecheck && npm run build` + curl (block case only — never trigger a *successful* submit, which would create a real Priority order) + dev-browser DOM check. Local server: `PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev`.

**Branch:** `feat/payment-policy` (continue on it).

---

### Task 1: Server gate in `submitOrder` (net-debt block)

**Files:**
- Modify: `server/orders.ts` — add import + the gate after the cart line re-validation loop (the loop ends ≈ line 185, before `const config = getPriorityConfig()`)

- [ ] **Step 1: Add the import** at the top of `server/orders.ts` (with the other `./xxx.js` imports):

```ts
import { policyEnabled, evaluate } from './paymentPolicy.js';
```

- [ ] **Step 2: Add the gate** — immediately AFTER the `for (const ln of lines) { ... }` re-validation loop and BEFORE `const config = getPriorityConfig();`:

```ts
  // Payment-policy gate (Phase 2: net-terms open-debt block). Inert unless the
  // admin flag is on. Cash customers are not gated here (Phase 3). The block uses
  // net debt = openTotal − pendingSettlement (post-dated cheques already excluded),
  // so a fresh card payment / submitted cheque lifts it without office reconciliation.
  if (policyEnabled()) {
    const decision = await evaluate(custname, promotions.total);
    if (!decision.allowOrder && decision.reason === 'open_debt') {
      throw new OrderError(
        `לא ניתן לבצע הזמנה — קיים חוב פתוח בסך ₪${(decision.amount ?? 0).toFixed(2)}. נא לסגור אותו (צ׳ק או אשראי) במסך "חשבוניות" ולנסות שוב.`
      );
    }
  }
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both pass.

- [ ] **Step 4: Integration verify — the BLOCK only (never a successful submit)**

The qa customer is `10184` (real open debt from live Priority). Force its policy to `net`, flag on, threshold 0, then attempt an order → expect 400 with the debt message. Then verify flag-off does NOT block (we assert the *error message* is absent — we still expect a non-debt outcome; to avoid creating a real Priority order we DON'T assert success, only that it's not the debt 400).

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev > /tmp/t1.log 2>&1 &
sleep 8
AU=$(grep '^ADMIN_BOOTSTRAP_USERNAME=' .env|cut -d= -f2-); AP=$(grep '^ADMIN_BOOTSTRAP_PASSWORD=' .env|cut -d= -f2-)
curl -s -c /tmp/a.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$AU\",\"password\":\"$AP\"}" -o /dev/null
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/settings -H 'Content-Type: application/json' -d '{"payment_policy_enabled":true,"policy_net_debt_threshold":0}' -o /dev/null
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/customers/10184/policy -H 'Content-Type: application/json' -d '{"kind":"net","allow_order_with_open_debt":false}' -o /dev/null
# customer qa: put one item in the cart, then try to order
curl -s -c /tmp/c.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d '{"username":"qa","password":"qa123456"}' -o /dev/null
curl -s -b /tmp/c.j -X PUT localhost:3030/api/cart/lines/COKE-15 -H 'Content-Type: application/json' -d '{"quantity":12,"mode":"add"}' -o /dev/null
echo "--- flag ON, net, debt → expect 400 + debt msg ---"
curl -s -b /tmp/c.j -X POST localhost:3030/api/orders -H 'Content-Type: application/json' -d '{}' -w '\nHTTP %{http_code}\n'
echo "--- now EXEMPT the customer → gate should pass (do NOT submit; just confirm evaluate allows) ---"
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/customers/10184/policy -H 'Content-Type: application/json' -d '{"kind":"net","allow_order_with_open_debt":true}' -o /dev/null
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npx tsx -e "import('./server/paymentPolicy.js').then(async m=>{const d=await m.evaluate('10184',500);console.log('exempt evaluate.allowOrder:',d.allowOrder,'reason:',d.reason)})"
# cleanup: clear qa cart + reset 10184 + flag off
curl -s -b /tmp/c.j -X DELETE localhost:3030/api/cart 2>/dev/null -o /dev/null || true
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/settings -H 'Content-Type: application/json' -d '{"payment_policy_enabled":false}' -o /dev/null
pkill -f "tsx watch server/index.ts" 2>/dev/null; pkill -f "node_modules/.bin/vite" 2>/dev/null
```
Expected: the order POST returns `HTTP 400` and the body contains "חוב פתוח"; the exempt `evaluate` prints `allowOrder: true reason: null`. (If qa login/cart fails, report it — but the typecheck/build + exempt-evaluate are the hard gates. Do NOT change the test to actually submit an allowed order.)

- [ ] **Step 5: Commit**

```bash
git add server/orders.ts
git commit -m "feat(orders): net-terms open-debt block at submit (flag-gated, Phase 2)"
```

---

### Task 2: Checkout pre-block (client UX)

**Files:**
- Modify: `src/pages/checkout.ts` — `renderCheckout()`

**Read first:** `src/pages/checkout.ts` — how it fetches HomeData (it already pulls `balance`, `paymentTerms`, and now `paymentPolicy` from `/api/home`), the existing **soft credit-warning card** (≈ lines 73-82 — your styling/placement model), the submit button (`submitBtn` ≈ line 139-165), and how it shows errors. The client `HomeData` interface already has `paymentPolicy?: { kind, netDebt, blocksOnDebt } | null` (added in Phase 1).

- [ ] **Step 1: Add the block card + disable submit when blocked**

In `renderCheckout()`, where the home data (`home`) is available and the page HTML is built, add — near the credit-warning card — a conditional block when `home.paymentPolicy?.blocksOnDebt`:

```ts
const debtBlock = home.paymentPolicy?.blocksOnDebt
  ? `<div class="card" style="border:1px solid var(--err);background:#fdecec;margin-bottom:0.75rem">
       <div style="font-weight:700;color:var(--err)">לא ניתן לבצע הזמנה — קיים חוב פתוח</div>
       <div class="muted" style="font-size:0.9rem;margin-top:0.25rem">יש לסגור חוב פתוח של ₪${(home.paymentPolicy.netDebt).toFixed(2)} לפני ביצוע הזמנה.</div>
       <a class="es-cta" href="#invoices" style="display:inline-block;margin-top:0.6rem">סגור חוב ←</a>
     </div>`
  : '';
```

Insert `${debtBlock}` into the rendered HTML near the top of the order summary (before the submit button). Then, after the DOM is built, if blocked, disable the submit button:

```ts
if (home.paymentPolicy?.blocksOnDebt) {
  const sb = shell.querySelector('#submit-order') as HTMLButtonElement | null; // use the REAL submit button id/selector from the file
  if (sb) { sb.disabled = true; sb.textContent = 'סגור חוב כדי להזמין'; }
}
```

Match the real submit-button selector/variable in the file (it may be a local `submitBtn` reference rather than an id — adapt accordingly; if it's a local const, just set `.disabled`/`.textContent` on it directly inside the same scope). Keep everything else unchanged. The server gate (Task 1) remains the real enforcement; this is UX.

- [ ] **Step 2: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: pass.

- [ ] **Step 3: dev-browser DOM check** (block card renders + submit disabled when blocked)

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev > /tmp/t2.log 2>&1 &
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/qa-chrome --no-first-run --disable-gpu about:blank >/tmp/c.log 2>&1 &
sleep 8
AU=$(grep '^ADMIN_BOOTSTRAP_USERNAME=' .env|cut -d= -f2-); AP=$(grep '^ADMIN_BOOTSTRAP_PASSWORD=' .env|cut -d= -f2-)
curl -s -c /tmp/a.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$AU\",\"password\":\"$AP\"}" -o /dev/null
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/settings -H 'Content-Type: application/json' -d '{"payment_policy_enabled":true,"policy_net_debt_threshold":0}' -o /dev/null
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/customers/10184/policy -H 'Content-Type: application/json' -d '{"kind":"net","allow_order_with_open_debt":false}' -o /dev/null
cat > /tmp/co.js <<'JS'
const p=await browser.getPage("main"); await p.setViewportSize({width:390,height:844});
await p.goto("http://localhost:5175/#login",{waitUntil:"networkidle"});
if(await p.$('input[name=username]')){await p.fill('input[name=username]','qa');await p.fill('input[name=password]','qa123456');await p.$eval('#login-form',f=>f.requestSubmit());await p.waitForTimeout(2000);}
await p.evaluate(()=>fetch('/api/cart/lines/COKE-15',{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({quantity:12,mode:'add'})}));
await p.goto("http://localhost:5175/#checkout",{waitUntil:"networkidle"}); await p.waitForTimeout(1500);
const r=await p.evaluate(()=>({blockCard:/חוב פתוח/.test(document.body.innerText), bodyHasSettle:/סגור חוב/.test(document.body.innerText)}));
console.log("CHECKOUT:",JSON.stringify(r));
JS
dev-browser --connect < /tmp/co.js 2>/dev/null | grep CHECKOUT
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/settings -H 'Content-Type: application/json' -d '{"payment_policy_enabled":false}' -o /dev/null
pkill -f "tsx watch server/index.ts" 2>/dev/null; pkill -f "node_modules/.bin/vite" 2>/dev/null; pkill -f "remote-debugging-port=9222" 2>/dev/null
```
Expected: `CHECKOUT: {"blockCard":true,"bodyHasSettle":true}`.

- [ ] **Step 4: Commit**

```bash
git add src/pages/checkout.ts
git commit -m "feat(checkout): block + 'settle debt' prompt for net-terms customers with open debt"
```

---

### Task 3: Final verify + deploy

- [ ] **Step 1: Reset data-qa to prod-like (flag OFF, no override), full gate + regression**

```bash
/opt/homebrew/opt/node@24/bin/node -e 'const D=require("better-sqlite3");const db=new D("./data-qa/app.db");db.prepare("DELETE FROM settings WHERE key LIKE ?").run("policy_%");db.prepare("DELETE FROM settings WHERE key=?").run("payment_policy_enabled");db.prepare("DELETE FROM customer_policies").run();console.log("reset");db.close();'
npm run typecheck && npm run build && node scripts/test-payment-policy.mjs   # (build a fresh /tmp temp DB for the resolve check as in Phase 1 Task 3 if needed)
# boot + qa/run-auth.sh → expect 21/21 (flag off = no gating)
```

- [ ] **Step 2: Deploy** (always-deploy; inert with flag OFF)

```bash
git push origin feat/payment-policy
git push origin HEAD:main
```
Poll prod bundle-hash change; health-check `/api/auth/me` 200, `/api/orders` 401.

- [ ] **Step 3: Report** prod healthy + that the net-debt block is live but inert (flag OFF). Remind the owner: turning `payment_policy_enabled` ON now activates the **net-debt block** (cash pay-at-order is still Phase 3).

---

## Self-Review notes
- **Spec coverage (Phase 2):** server net-debt block (Task 1, §6a) ✓ · checkout prompt + settle link (Task 2, §6c) ✓ · flag-gated/inert (Task 1,2) ✓ · post-dated cheques excluded + pending lifts block (reused Phase-1 `evaluate`) ✓. Cash pay-at-order intentionally deferred to Phase 3.
- **Types:** reuses `policyEnabled`/`evaluate` + `paymentPolicy` field from Phase 1 (names unchanged).
- **No placeholders:** every step has concrete code + commands. Submit-button selector in Task 2 is flagged to match the real one in checkout.ts.
- **Safety:** the integration test only asserts the BLOCK (400) + exempt `evaluate` — it never completes an allowed submit (which would create a real Priority order).
