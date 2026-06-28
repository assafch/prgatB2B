# Payment Policy — Phase 3b (Cheque pay-at-order + sweep + admin resend) Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Complete the cash pay-at-order feature: let a cash customer pay a held order by **cheque** (approved at submit), auto-sweep abandoned holds, and give the admin a **resend** for paid-but-unsent orders (the Priority-failed-after-payment recovery path). Inert unless `payment_policy_enabled` is on.

**Architecture:** Reuse the existing cheque scanner (`renderPayCheck`) threaded with an order id; a new `POST /api/orders/:id/pay/check` links a just-submitted cheque to the order and calls the existing `approveOrder(orderId,'check',checkId)` (Phase 3a) → send to Priority + notify. Add `sweepPendingOrders()` on the boot/hourly sweep schedule, and an admin `GET /api/admin/orders/stuck` + `POST /api/admin/orders/:id/resend`. Spec §6b (cheque branch + abandon/expire + Priority-down recovery).

**Tech Stack:** TS Express + vanilla-TS client. Verify: typecheck/build + curl (guards only — never complete a real approve, which sends a live Priority order) + dev-browser. Branch `feat/payment-policy`.

**Key existing code:**
- `server/payments.ts`: `confirmCheck(userId,id,input)` → `UPDATE payment_checks SET ... status='submitted' WHERE id=? AND user_id=? AND status='draft'`; `payment_checks.order_id` column exists (Phase 1). `getCheckForUser(userId,id)`, `sweepDraftChecks()`.
- `server/index.ts`: cheque routes `POST /api/payments/check/parse` (@881), `POST /api/payments/check/:id/confirm` (@932). Sweep scheduling block @~1544-1549 (`setInterval(..., 3600_000).unref()`), imports from `./payments.js` and `./orders.js`. `requireAdmin`/`requireOwner` middleware.
- `server/orders.ts`: `approveOrder(orderId,'card'|'check',paymentId)`, `sendHeldOrderToPriority(orderId)` (Phase 3a). `getLocalOrder`.
- `src/pages/payCheck.ts`: `renderPayCheck(shell)` (@34); confirms via `api.post('/api/payments/check/${draftId}/confirm', {...})` (@349).
- `src/pages/orderPay.ts`: the card-only pay screen (Phase 3a) — add a cheque button.
- `src/main.ts`: hash router (string-slice params; `#order-pay/:id` registered).

---

### Task 1: Server — order-scoped cheque link + approve

**Files:** Modify `server/orders.ts` (add `linkChequeToOrder`), `server/index.ts` (route)

- [ ] **Step 1:** Add to `server/orders.ts`:
```ts
import { getCheckForUser } from './payments.js'; // if not already imported
/** Link an already-submitted cheque to a held order and approve it (cheque = approve
 *  at submit, decision #2). Returns true if the order was claimed for approval. */
export async function payHeldOrderByCheck(userId: number, custname: string, orderId: number, checkId: string): Promise<boolean> {
  const order = db.prepare(`SELECT id, status, custname, user_id FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; status: string; custname: string; user_id: number } | undefined;
  if (!order || order.user_id !== userId || order.custname !== custname) throw new OrderError('ההזמנה לא נמצאה');
  if (order.status !== 'pending_payment') throw new OrderError('ההזמנה אינה ממתינה לתשלום');
  const chk = getCheckForUser(userId, checkId);
  if (!chk || (chk as { status?: string }).status !== 'submitted') throw new OrderError('הצ׳ק לא נמצא או טרם אושר');
  db.prepare('UPDATE payment_checks SET order_id = ? WHERE id = ? AND user_id = ?').run(String(orderId), checkId, userId);
  await approveOrder(orderId, 'check', checkId);
  return true;
}
```

- [ ] **Step 2:** Add the route in `server/index.ts` (near the cheque/order routes), owner-only:
```ts
app.post('/api/orders/:id/pay/check', requireOwner, blockIfMaintenance, cartLimiter, ah(async (req: AuthedRequest, res) => {
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
```
Add `payHeldOrderByCheck` to the `./orders.js` import. (`OrderError` is already imported.)

- [ ] **Step 3:** typecheck + build. Curl — verify the GUARDS only (do NOT complete a real approve → it sends a live Priority order): a non-pending order id → 400 "אינה ממתינה לתשלום"; a bogus checkId on a held order → 400 "הצ׳ק לא נמצא". (Create a held order as in Phase 3a, then `POST /api/orders/<held>/pay/check {checkId:"nope"}` → expect 400 "הצ׳ק לא נמצא"; `POST /api/orders/999999/pay/check {checkId:"x"}` → 400 "ההזמנה לא נמצאה".)

- [ ] **Step 4:** Commit: `git add server/orders.ts server/index.ts && git commit -m "feat(orders): pay a held order by cheque — link + approve at submit (Phase 3b)"`

---

### Task 2: Server — abandon sweep + admin resend

**Files:** Modify `server/orders.ts`, `server/index.ts`

- [ ] **Step 1:** Add to `server/orders.ts`:
```ts
const PENDING_TTL = '-48 hours';
/** Delete abandoned held orders (pending_payment, no payment ever linked, older than
 *  the TTL). Local-only — nothing was sent to Priority. Returns the count removed. */
export function sweepPendingOrders(): number {
  const stale = db.prepare(
    `SELECT id FROM orders_local WHERE status = 'pending_payment' AND linked_payment_id IS NULL AND created_at < datetime('now', ?)`
  ).all(PENDING_TTL) as { id: number }[];
  const delLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const delOrder = db.prepare('DELETE FROM orders_local WHERE id = ?');
  const tx = db.transaction(() => { for (const o of stale) { delLines.run(o.id); delOrder.run(o.id); } });
  tx();
  return stale.length;
}

/** Re-send a paid-but-unsent order to Priority (recovery for a Priority outage after
 *  payment: status='failed'/'submitting' while payment_status='approved'). */
export async function resendApprovedOrder(orderId: number): Promise<{ ok: boolean; ordname?: string; error?: string }> {
  const order = db.prepare(`SELECT id, status, payment_status, priority_ordname FROM orders_local WHERE id = ?`).get(orderId) as
    | { id: number; status: string; payment_status: string; priority_ordname: string | null } | undefined;
  if (!order) return { ok: false, error: 'not found' };
  if (order.priority_ordname) return { ok: true, ordname: order.priority_ordname }; // already sent
  if (order.payment_status !== 'approved') return { ok: false, error: 'not paid' };
  try {
    const ordname = await sendHeldOrderToPriority(orderId);
    db.prepare(`UPDATE orders_local SET status = 'submitted', priority_ordname = ?, submitted_at = datetime('now'), error = NULL WHERE id = ?`).run(ordname, orderId);
    return { ok: true, ordname };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Paid orders that never reached Priority (admin recovery queue). */
export function listStuckOrders(): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT id, custname, status, total, payment_status, created_at, error FROM orders_local
     WHERE payment_status = 'approved' AND (priority_ordname IS NULL) ORDER BY created_at DESC LIMIT 100`
  ).all();
}
```

- [ ] **Step 2:** Schedule the sweep in `server/index.ts` next to the cheque-draft sweep (~@1549): import `sweepPendingOrders` from `./orders.js`, then add `sweepPendingOrders(); setInterval(() => sweepPendingOrders(), 3600_000).unref();`.

- [ ] **Step 3:** Add admin routes in `server/index.ts` (requireAdmin), importing `resendApprovedOrder, listStuckOrders`:
```ts
app.get('/api/admin/orders/stuck', requireAdmin, (req, res) => { res.json({ orders: listStuckOrders() }); });
app.post('/api/admin/orders/:id/resend', requireAdmin, ah(async (req, res) => {
  const r = await resendApprovedOrder(Number(req.params.id));
  res.status(r.ok ? 200 : 400).json(r);
}));
```

- [ ] **Step 4:** typecheck + build. Curl: admin `GET /api/admin/orders/stuck` → 200 `{orders:[...]}` (likely empty); `POST /api/admin/orders/999999/resend` → 400 `{ok:false,error:"not found"}`.

- [ ] **Step 5:** Commit: `git add server/orders.ts server/index.ts && git commit -m "feat(orders): abandon sweep for held orders + admin resend of paid-but-unsent (Phase 3b)"`

---

### Task 3: Client — cheque button on pay screen + payCheck order context

**Files:** Modify `src/pages/orderPay.ts`, `src/pages/payCheck.ts`, `src/main.ts`

- [ ] **Step 1:** `src/pages/orderPay.ts` — add a cheque button under the card button:
```ts
<button id="pay-check" class="es-cta" style="margin-top:0.6rem;background:var(--ok)">שלם בצ׳ק</button>
```
and wire it: `shell.querySelector('#pay-check')!.addEventListener('click', () => { location.hash = '#pay-check/' + orderId; });`

- [ ] **Step 2:** `src/main.ts` — register `#pay-check/:id` → `renderPayCheck(mount(''), id)` (string-slice param like `#order-pay/:id`); keep any existing `#pay-check` (no id) → `renderPayCheck(mount(''))`. Make `navKeyFor` treat `#pay-check` like the existing cheque/payments nav key.

- [ ] **Step 3:** `src/pages/payCheck.ts` — change `renderPayCheck(shell: HTMLElement, orderId?: string)`. When `orderId` is set: (a) show a small header note "תשלום צ׳ק להזמנה" ; (b) after a cheque is successfully confirmed (the existing `api.post('/api/payments/check/${draftId}/confirm', ...)` success path ~@349, which yields the confirmed `draftId`), call:
```ts
if (orderId) {
  try {
    await api.post(`/api/orders/${orderId}/pay/check`, { checkId: j.item.draftId });
    location.hash = '#order-pay/' + orderId; // shows "אושרה ונשלחה"
    return;
  } catch (e) { toast('אישור התשלום להזמנה נכשל', 'error'); }
}
```
Insert this right after the per-cheque confirm succeeds (use the real variable holding the confirmed draft id in that scope). Leave the no-orderId behavior exactly as today. `toast` is already imported in payCheck.ts.

- [ ] **Step 4:** typecheck + build. dev-browser: flag on + 10184 cash, login qa, add item, `#checkout` → submit → on `#order-pay/<id>`, assert both "שלם באשראי" and "שלם בצ׳ק" buttons exist; click "שלם בצ׳ק" → assert `location.hash` starts with `#pay-check/`. (Stop there — don't scan/confirm a real cheque, which would send a live Priority order.)

- [ ] **Step 5:** Commit: `git add -A src/ && git commit -m "feat(checkout): pay a held order by cheque from #order-pay (Phase 3b)"`

---

### Task 4: Admin UI — stuck-orders resend

**Files:** Modify `src/pages/adminSettings.ts` (or the admin orders view if one exists — read first)

- [ ] **Step 1:** In `src/pages/adminSettings.ts`, add a section "הזמנות ששולמו וטרם נשלחו" that on render fetches `GET /api/admin/orders/stuck` and lists each (`id`, `custname`, `total`, `error`) with a "שלח מחדש" button → `POST /api/admin/orders/:id/resend` → on `{ok:true}` toast success + refresh; else toast the error. If the list is empty, show "אין". Match the file's existing fetch/render/toast pattern.

- [ ] **Step 2:** typecheck + build. dev-browser (admin): the section renders (empty "אין" is fine). 

- [ ] **Step 3:** Commit: `git add src/pages/adminSettings.ts && git commit -m "feat(admin): resend paid-but-unsent orders from settings (Phase 3b)"`

---

### Task 5: Final verify + deploy

- [ ] **Step 1:** Reset data-qa (flag off, clear policies/cart/held orders — use SINGLE-quoted SQL string literals), full gate (typecheck/build + `node scripts/test-payment-policy.mjs` on a fresh temp DB) + regression `qa/run-auth.sh` (logout browser first) → 21/21.
- [ ] **Step 2:** Deploy: `git push origin feat/payment-policy && git push origin HEAD:main`; poll bundle-hash; health-check `/api/auth/me` 200, `/api/orders/:id/pay/check` 401, `/api/admin/orders/stuck` 401.
- [ ] **Step 3:** Report prod healthy + ALL phases (1,2,3a,3b) in production, inert (flag OFF). The remaining step is activation (set net-debt threshold + flip `payment_policy_enabled`), which is the owner's business decision.

---

## Self-Review notes
- **Spec §6b coverage:** cheque pay-at-order, approve-at-submit (Task 1) ✓ · abandon/expire sweep (Task 2) ✓ · Priority-down recovery / admin resend (Task 2,4) ✓. Combined with Phase 3a (card), the cash branch is complete.
- **Safety:** tests exercise GUARDS only; no test completes a real cheque approve or card charge (both send a live Priority order). The live non-cash + existing cheque/card debt flows are untouched (new routes/functions only).
- **Types:** `payHeldOrderByCheck`, `sweepPendingOrders`, `resendApprovedOrder`, `listStuckOrders` consistent across server tasks; client routes use the existing `renderPayCheck(shell, orderId?)`.
