# Payment Policy — Phase 3a (Cash pay-at-order: hold → card → approve) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** For a cash-policy customer, hold the order locally as `pending_payment` (NOT sent to Priority), let them pay it by **card**, and on confirmed payment auto-approve the order and send it to Priority. Inert unless `payment_policy_enabled` is on. (Cheque-pay-at-order + abandon sweep = Phase 3b.)

**Architecture:** One `evaluate()` call in `submitOrder` already exists (Phase 2). Extend it: `reason==='cash_payment_required'` → insert the order as `pending_payment`, insert its `order_lines`, clear cart, return `{ needsPayment:true, orderId, amount }` WITHOUT calling Priority. A new `approveOrder(orderId, kind, paymentId)` flips it to approved and calls a new `sendHeldOrderToPriority(orderId)` (rebuilds the Priority payload from `order_lines`, so it's independent of the now-cleared cart). `confirmCard` gets a hook: a paid `order_payment` card → `approveOrder`. The live non-cash path is left UNCHANGED (safety). Spec §6b.

**Tech Stack:** TS Express + vanilla-TS client. Verify: typecheck/build + curl + dev-browser. Local: `PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev`. Branch `feat/payment-policy`.

**Key existing code:**
- `server/orders.ts`: `submitOrder` (returns `{orderId, ordname, total, lines}` @269; cash gate computed via `evaluate` @~200), inserts `orders_local` (status hardcoded 'submitting' @~205) + `order_lines` (tx, paid line freebie=0 / bogo+gift freebie=1 price 0), then inline `createOrder(...)` @~230. `listLocalOrders` @272, `getLocalOrder` @284. Columns from Phase 1: `payment_status`('not_required'|'pending_payment'|'approved'), `payment_required_amount`, `linked_payment_kind`, `linked_payment_id`, `approved_at`.
- `server/cardPayments.ts`: `createCardPartialIntent(userId,custname,amount,...)` @203 (builds opts `{userId,custname,amount,kind,paidItemsJson}` → per-PSP insert helper → `{id,url,amount}`); `confirmCard(id)` @259 sets `status='paid'` per PSP branch (@277/301/324) then `bustFinanceCache`. `card_payments.order_id` column exists (Phase 1). `CardRow` selects `*`.
- `server/index.ts`: card routes @999/1017 (`requireOwner, blockIfMaintenance, cardPayLimiter`), `GET /api/orders/:id` @794. `notifyUser` used @771.
- `src/pages/checkout.ts`: submit handler @155, `api.post<{ordname,orderId}>('/api/orders',{details})` @161, success path branches on `home?.features.payments` @169.

---

### Task 1: `submitOrder` cash-hold branch + `sendHeldOrderToPriority` + `approveOrder`

**Files:** Modify `server/orders.ts`

- [ ] **Step 1: Unify the policy decision + add the cash-hold branch.** Read `submitOrder`. The Phase-2 gate calls `evaluate` only to block open_debt. Refactor so `evaluate` is called once and its result drives BOTH the net-debt block AND the cash hold. Replace the existing `if (policyEnabled()) { const decision = await evaluate(...); if (!decision.allowOrder && decision.reason==='open_debt') throw ... }` block with:

```ts
  let cashHold = false;
  let requiredAmount = 0;
  if (policyEnabled()) {
    const decision = await evaluate(custname, promotions.total);
    if (!decision.allowOrder && decision.reason === 'open_debt') {
      throw new OrderError(
        `לא ניתן לבצע הזמנה — קיים חוב פתוח בסך ₪${(decision.amount ?? 0).toFixed(2)}. נא לסגור אותו (צ׳ק או אשראי) במסך "חשבוניות" ולנסות שוב.`
      );
    }
    if (decision.requiresPayment && decision.reason === 'cash_payment_required') {
      cashHold = true;
      requiredAmount = decision.amount ?? promotions.total;
    }
  }
```

- [ ] **Step 2: Insert the order with the right initial status + thread the hold.** The `INSERT INTO orders_local (... status ...)` currently hardcodes `'submitting'`. Make the status conditional and set payment columns for a hold. Change the insert + (for holds) return early BEFORE the inline `createOrder`. After the `order_lines` tx runs, add:

```ts
  if (cashHold) {
    db.prepare(
      `UPDATE orders_local SET status = 'pending_payment', payment_status = 'pending_payment', payment_required_amount = ? WHERE id = ?`
    ).run(requiredAmount, localOrderId);
    clearCart(userId);
    return { orderId: localOrderId, ordname: '', total, lines, needsPayment: true, amount: requiredAmount };
  }
```
Place this right after `tx();` (the order_lines insert) and BEFORE `const config = getPriorityConfig();` so a held order never calls Priority. The initial insert can keep `'submitting'` (the UPDATE above overrides it for holds); leave the non-cash path exactly as-is.

- [ ] **Step 3: Extend `SubmitResult`** (the interface ~@120):
```ts
export interface SubmitResult {
  orderId: number;
  ordname: string;
  total: number;
  lines: CartLine[];
  needsPayment?: boolean;
  amount?: number;
}
```

- [ ] **Step 4: Add `sendHeldOrderToPriority` + `approveOrder`** at the end of `server/orders.ts`:

```ts
/** Rebuild the Priority order payload from the persisted order_lines (the cart is
 *  already cleared for held orders) and submit it. Returns the Priority ORDNAME.
 *  Mirrors submitOrder's live payload: paid lines carry no PRICE (Priority prices
 *  them); freebies/gifts are sent at PRICE 0. */
export async function sendHeldOrderToPriority(orderId: number): Promise<string> {
  const order = db.prepare(`SELECT id, custname, details FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; custname: string; details: string | null } | undefined;
  if (!order) throw new Error(`order ${orderId} not found`);
  const rows = db.prepare(
    `SELECT partname, quantity, is_promotion_freebie FROM order_lines WHERE order_id = ?`
  ).all(orderId) as { partname: string; quantity: number; is_promotion_freebie: number }[];
  const config = getPriorityConfig();
  if (!config) throw new Error('Priority not configured');
  const items = rows.map((r) =>
    r.is_promotion_freebie
      ? { PARTNAME: r.partname, TQUANT: r.quantity, PRICE: 0 }
      : { PARTNAME: r.partname, TQUANT: r.quantity }
  );
  return createOrder(config, order.custname, items, order.details ?? undefined, `B2B-${orderId}`);
}

/** Approve a held (pending_payment) order after its payment confirmed: mark approved,
 *  link the payment, send to Priority, notify. Idempotent (no-op if not pending). */
export async function approveOrder(orderId: number, kind: 'card' | 'check', paymentId: string): Promise<void> {
  const order = db.prepare(`SELECT id, user_id, status FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; user_id: number; status: string } | undefined;
  if (!order || order.status !== 'pending_payment') return; // idempotent
  db.prepare(
    `UPDATE orders_local SET payment_status = 'approved', linked_payment_kind = ?, linked_payment_id = ?, approved_at = datetime('now') WHERE id = ?`
  ).run(kind, paymentId, orderId);
  let ordname: string;
  try {
    ordname = await sendHeldOrderToPriority(orderId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Payment IS taken — do NOT lose it. Mark failed-but-paid for admin resend (Phase 3b).
    db.prepare(`UPDATE orders_local SET status = 'failed', error = ? WHERE id = ?`).run(msg, orderId);
    return;
  }
  db.prepare(
    `UPDATE orders_local SET status = 'submitted', priority_ordname = ?, submitted_at = datetime('now') WHERE id = ?`
  ).run(ordname, orderId);
  notifyUser(order.user_id, { title: 'ההזמנה אושרה ✓', body: `התשלום התקבל — הזמנה ${ordname} נשלחה`, url: '#orders' });
}
```
(Add `import { notifyUser } from './push.js';` to `server/orders.ts` if not present.)

- [ ] **Step 5: typecheck + build.** `npm run typecheck && npm run build` (pass).

- [ ] **Step 6: Integration verify — cash order is HELD (no Priority call).** Force 10184 cash, flag on, put an item in qa's cart, submit → expect a 200 with `needsPayment:true` and the order in `pending_payment` (NOT submitted). This never calls Priority (held), so it's safe.
```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" DATA_DIR=./data-qa npm run dev > /tmp/t1.log 2>&1 & sleep 8
AU=$(grep '^ADMIN_BOOTSTRAP_USERNAME=' .env|cut -d= -f2-); AP=$(grep '^ADMIN_BOOTSTRAP_PASSWORD=' .env|cut -d= -f2-)
curl -s -c /tmp/a.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d "{\"username\":\"$AU\",\"password\":\"$AP\"}" -o /dev/null
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/settings -H 'Content-Type: application/json' -d '{"payment_policy_enabled":true}' -o /dev/null
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/customers/10184/policy -H 'Content-Type: application/json' -d '{"kind":"cash"}' -o /dev/null
curl -s -c /tmp/c.j -X POST localhost:3030/api/auth/login -H 'Content-Type: application/json' -d '{"username":"qa","password":"qa123456"}' -o /dev/null
curl -s -b /tmp/c.j -X PUT localhost:3030/api/cart/lines/COKE-15 -H 'Content-Type: application/json' -d '{"quantity":12,"mode":"add"}' -o /dev/null
echo "--- submit (expect needsPayment) ---"; curl -s -b /tmp/c.j -X POST localhost:3030/api/orders -H 'Content-Type: application/json' -d '{}'
echo; echo "--- orders list (expect a pending_payment row, no priority_ordname) ---"; curl -s -b /tmp/c.j localhost:3030/api/orders | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).orders[0];console.log(JSON.stringify({status:o.status,payment_status:o.payment_status,priority_ordname:o.priority_ordname}))})'
curl -s -b /tmp/a.j -X PATCH localhost:3030/api/admin/settings -H 'Content-Type: application/json' -d '{"payment_policy_enabled":false}' -o /dev/null
pkill -f "tsx watch server/index.ts" 2>/dev/null; pkill -f "node_modules/.bin/vite" 2>/dev/null
```
Expected: submit returns JSON containing `"needsPayment":true` + an `amount`; the order row shows `status:"pending_payment"`, `payment_status:"pending_payment"`, `priority_ordname:null`. (NOTE: `listLocalOrders` must return `payment_status` — if it's absent in the output, Task 4 adds it; for now confirm status is pending_payment.)

- [ ] **Step 7: Commit.** `git add server/orders.ts && git commit -m "feat(orders): hold cash orders as pending_payment + approveOrder/sendHeldOrderToPriority (Phase 3a)"`

---

### Task 2: Order-scoped card intent + confirm→approve hook

**Files:** Modify `server/cardPayments.ts`

- [ ] **Step 1: Add `createCardOrderIntent`.** Read `createCardPartialIntent` (@203) and mirror it, but: amount is the order's `payment_required_amount` (read from `orders_local`, do NOT trust the client), `kind:'order_payment'`, and set `order_id` on the row. After the intent row is created by the existing per-PSP helper (which returns `{id,url,amount}`), set the link:
```ts
import { db } from './db.js'; // if not already imported
export async function createCardOrderIntent(userId: number, custname: string, orderId: number): Promise<{ id: string; url: string; amount: number }> {
  const order = db.prepare(
    `SELECT payment_required_amount, status, user_id FROM orders_local WHERE id = ? AND custname = ?`
  ).get(orderId, custname) as { payment_required_amount: number | null; status: string; user_id: number } | undefined;
  if (!order || order.user_id !== userId) throw new Error('order not found');
  if (order.status !== 'pending_payment') throw new Error('order not awaiting payment');
  const amount = Number(order.payment_required_amount);
  if (!(amount > 0)) throw new Error('order amount unavailable');
  const intent = await createPspIntent({ userId, custname, amount, kind: 'order_payment', paidItemsJson: null });
  db.prepare('UPDATE card_payments SET order_id = ? WHERE id = ?').run(String(orderId), intent.id);
  return intent;
}
```
NOTE: `createPspIntent` is the internal helper the existing intents use (the per-PSP dispatcher around @89-130). If it isn't a single exported function, factor the shared "pick PSP + insert row + return {id,url,amount}" body that `createCardPartialIntent` already uses into a local helper and call it here. Keep `createCardPartialIntent`/`createCardDebtIntent` working unchanged.

- [ ] **Step 2: Add the approve hook in `confirmCard`.** Read `confirmCard` (@259). In EACH PSP branch, right after the `UPDATE ... status='paid' ...` + `bustFinanceCache(row.custname)`, add a single shared post-step (best: after the branch, once status is known to be paid). Use a fresh read of `order_id`/`kind` and call `approveOrder`:
```ts
// after the card is marked paid (status now 'paid'):
const fresh = db.prepare('SELECT order_id, kind FROM card_payments WHERE id = ?').get(id) as { order_id: string | null; kind: string } | undefined;
if (fresh?.kind === 'order_payment' && fresh.order_id) {
  const { approveOrder } = await import('./orders.js'); // dynamic import avoids a circular import at module load
  await approveOrder(Number(fresh.order_id), 'card', id);
}
```
Place this once on the success path (e.g. right before `return ...` of the paid result), so all PSPs share it. (Dynamic `import()` because orders.ts already imports paymentPolicy which is fine, but cardPayments↔orders could cycle — the dynamic import sidesteps it.)

- [ ] **Step 2: typecheck + build** (pass).

- [ ] **Step 3: Commit.** `git add server/cardPayments.ts && git commit -m "feat(payments): order-scoped card intent + confirm→approve hook (Phase 3a)"`

---

### Task 3: Endpoint to pay a held order by card

**Files:** Modify `server/index.ts`

- [ ] **Step 1: Add the route** (near the other card routes ~@999), owner-only:
```ts
app.post('/api/orders/:id/pay/card', requireOwner, blockIfMaintenance, cardPayLimiter, ah(async (req: AuthedRequest, res) => {
  try {
    const intent = await createCardOrderIntent(req.user!.id, req.user!.custname!, Number(req.params.id));
    res.json(intent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg === 'order not found' || msg === 'order not awaiting payment' ? 'ההזמנה אינה ממתינה לתשלום' : 'יצירת תשלום נכשלה' });
  }
}));
```
Add `createCardOrderIntent` to the existing import from `./cardPayments.js`.

- [ ] **Step 2: typecheck + build** + curl: create a held order (as in Task 1 Step 6), then `POST /api/orders/:id/pay/card` → expect `{id,url,amount}` with amount = order total. (Don't open/confirm the PSP page — that would be a live charge.)
```bash
# (reuse the held-order curl from Task 1 to get an order id from /api/orders, then:)
curl -s -b /tmp/c.j -X POST localhost:3030/api/orders/<ID>/pay/card -w '\n%{http_code}\n'
```
Expected: 200 + JSON `{id,url,amount}`, amount equals the order total.

- [ ] **Step 3: Commit.** `git add server/index.ts && git commit -m "feat(api): POST /api/orders/:id/pay/card — pay a held order by card (Phase 3a)"`

---

### Task 4: Surface payment state in order lists/detail (server)

**Files:** Modify `server/orders.ts`

- [ ] **Step 1:** Add `payment_status`, `payment_required_amount`, `approved_at` to the SELECT in `listLocalOrders` (@272) and `getLocalOrder` (@284) so the client can render the pending-payment state and the pay button. Keep the existing columns.

- [ ] **Step 2: typecheck + build** + curl `/api/orders` shows `payment_status` on the held order from Task 1.

- [ ] **Step 3: Commit.** `git add server/orders.ts && git commit -m "feat(orders): expose payment_status/required_amount in local order lists (Phase 3a)"`

---

### Task 5: Client — checkout redirect + order-pay screen + pending chip

**Files:** Modify `src/pages/checkout.ts`, `src/pages/orders.ts`, `src/pages/orderDetail.ts`, the router (`src/app.ts` or wherever hash routes are registered); Create `src/pages/orderPay.ts`

- [ ] **Step 1: Checkout success → redirect to the pay screen.** In `checkout.ts` submit handler (@161), the result type is `{ ordname, orderId }`; extend to `{ ordname; orderId; needsPayment?: boolean; amount?: number }`. After a successful `api.post`, if `result.needsPayment` → `location.hash = '#order-pay/' + result.orderId; return;` (before the existing `features.payments` success branch).

- [ ] **Step 2: Create `src/pages/orderPay.ts`** — `renderOrderPay(shell, orderId)`: fetch `GET /api/orders/:id`; if `payment_status==='approved'`/`status==='submitted'` show "ההזמנה אושרה ✓" + link to `#orders`; else show the order summary + `payment_required_amount` + a card button:
```ts
import { api } from '../api.js';
import { toast } from '../ui.js';
export async function renderOrderPay(shell: HTMLElement, orderId: string): Promise<void> {
  const o = await api.get<{ status: string; payment_status?: string; payment_required_amount?: number; priority_ordname?: string|null; lines?: any[] }>(`/api/orders/${orderId}`);
  if (o.status === 'submitted' || o.payment_status === 'approved') {
    shell.innerHTML = `<div class="card"><div style="font-weight:700">ההזמנה אושרה ונשלחה ✓</div><a class="es-cta" href="#orders" style="display:inline-block;margin-top:0.6rem">להזמנות שלי</a></div>`;
    return;
  }
  const amt = Number(o.payment_required_amount || 0).toFixed(2);
  shell.innerHTML = `
    <div class="card">
      <div style="font-weight:700">תשלום להזמנה</div>
      <div class="muted" style="margin-top:0.25rem">כלקוח מזומן, יש לשלם ₪${amt} כדי שההזמנה תאושר ותישלח.</div>
      <button id="pay-card" class="es-cta" style="margin-top:0.8rem">שלם באשראי ₪${amt}</button>
    </div>`;
  shell.querySelector('#pay-card')!.addEventListener('click', async () => {
    const btn = shell.querySelector('#pay-card') as HTMLButtonElement; btn.disabled = true;
    try {
      const r = await api.post<{ url: string }>(`/api/orders/${orderId}/pay/card`, {});
      location.href = r.url; // PSP hosted page; on return, confirmCard approves the order
    } catch (e) { toast('יצירת התשלום נכשלה', 'error'); btn.disabled = false; }
  });
}
```

- [ ] **Step 3: Register the route.** In the router, add a hash route `#order-pay/:id` → `renderOrderPay(shell, id)`. Match the file's existing route-registration pattern (read it first; the catalog/checkout routes show how params are parsed).

- [ ] **Step 4: Pending-payment chip + pay button in the orders list/detail.** In `src/pages/orders.ts` (local-status map ~line 23) add a label for `pending_payment` → `'ממתין לתשלום'` (warn tone) and, when `o.status==='pending_payment'`, render a small `<a href="#order-pay/${o.id}">שלם</a>` on the card. In `orderDetail.ts`, when `status==='pending_payment'`, show a "שלם להזמנה" button linking to `#order-pay/${id}`.

- [ ] **Step 5: typecheck + build** + dev-browser: with flag on + 10184 cash, log in qa, add an item, go through `#checkout` → submit → expect to land on `#order-pay/<id>` showing "שלם באשראי". (Don't click pay — that opens the PSP.)
```bash
# boot + chrome as in Phase 2 Task 2; script: login qa, add COKE-15, goto #checkout, click #submit, wait, assert location.hash starts with #order-pay and body has "שלם באשראי"
```
Expected: lands on `#order-pay/...` with the card button visible.

- [ ] **Step 6: Commit.** `git add src/pages/orderPay.ts src/pages/checkout.ts src/pages/orders.ts src/pages/orderDetail.ts src/app.ts && git commit -m "feat(checkout): cash pay-at-order flow — redirect to #order-pay, card payment, pending chip (Phase 3a)"`

---

### Task 6: Final verify + deploy

- [ ] **Step 1:** Reset data-qa (flag off, clear policies + qa cart), full gate (typecheck/build + `node scripts/test-payment-policy.mjs` on a fresh temp DB) + regression `qa/run-auth.sh` → 21/21 (flag off = no change).
- [ ] **Step 2:** Deploy: `git push origin feat/payment-policy && git push origin HEAD:main`; poll bundle-hash; health-check `/api/auth/me` 200, `/api/orders` 401.
- [ ] **Step 3:** Report prod healthy + inert (flag OFF). Note Phase 3b remaining (cheque pay-at-order, abandon sweep, admin resend of paid-but-unsent orders).

---

## Self-Review notes
- **Spec §6b coverage:** hold as pending_payment + no Priority call (Task 1) ✓ · card order-payment (Task 2-3) ✓ · confirm→approve→send→notify (Task 1-2) ✓ · order-state UI / pending chip / pay screen (Task 4-5) ✓ · Priority-down keeps payment (approveOrder catch → failed-but-paid) ✓. Cheque pay-at-order + abandon sweep + admin resend = Phase 3b (flagged).
- **Safety:** the live non-cash submit path is UNCHANGED; only the cash branch returns early. No test completes a live PSP charge or a real Priority order via the held path (held orders only reach Priority on real payment, which tests never confirm).
- **Types:** `SubmitResult.needsPayment/amount`, `approveOrder(orderId,kind,paymentId)`, `createCardOrderIntent` consistent across tasks. `notifyUser` on approval is wired in the POST handler today only for the immediate path — approval happens in `confirmCard`; add `notifyUser` inside `approveOrder` if push-on-approval is wanted (optional; Phase 3b can add richer messaging).
