# prgatB2B — Ops Runbook

Production target: **https://b2b.orgat.co.il** on Railway, SQLite on a persistent volume (`DATA_DIR`).

## Deploy checklist (P0)

1. Railway service from this repo (`railway.json` + `nixpacks.toml` already present). Attach a volume, set `DATA_DIR` to its mount path.
2. Env vars (Railway → Variables):
   - `NODE_ENV=production`
   - `PRIORITY_PAT` — **fresh PAT on a dedicated portal API user** (isolates the 100 calls/min quota from the WooCommerce bridge; ask the Priority admin for per-form scoping).
   - `APP_ORIGIN=https://b2b.orgat.co.il` (CSRF origin allowlist)
   - `APP_BASE_URL=https://b2b.orgat.co.il` (invite links)
   - `ADMIN_BOOTSTRAP_USERNAME` / `ADMIN_BOOTSTRAP_PASSWORD` — **remove after first boot** (only used when the users table is empty).
3. DNS: CNAME `b2b.orgat.co.il` → the Railway domain; verify HTTPS.
4. After first login works: delete the `ADMIN_BOOTSTRAP_*` vars, change the admin password from the UI (`POST /api/auth/change-password`).
5. Verify: `/api/health` returns ok; Lighthouse reports an installable PWA; CSP report-free on every screen.

## Backups (two layers)

| Layer | What | Where | Config |
|---|---|---|---|
| Local snapshots | `VACUUM INTO` daily, 30-day retention | `$DATA_DIR/backups/app-YYYY-MM-DD.db` | automatic (`server/backup.ts`) |
| Off-site replication | Litestream WAL streaming, encrypted client-side | R2/B2 bucket | `litestream.yml` — needs bucket + keys (human, one-time) |

**Off-site setup (one-time):** create a private R2/B2 bucket, a write-only key, an [age](https://age-encryption.org) keypair; set `LITESTREAM_ACCESS_KEY_ID`, `LITESTREAM_SECRET_ACCESS_KEY`, `REPLICA_URL`, `BACKUP_AGE_KEY`, `BACKUP_AGE_RECIPIENT`; switch the Railway start command to `litestream replicate -config litestream.yml -exec "node dist/server/index.js"`.

**Restore drill — rehearse once now and before payments go live (§4.2 gate):**

```bash
# from off-site replica:
litestream restore -config litestream.yml -o /tmp/restored.db "$DATA_DIR/app.db"
# or from a local snapshot:
cp "$DATA_DIR/backups/app-<date>.db" /tmp/restored.db
sqlite3 /tmp/restored.db "PRAGMA integrity_check; SELECT COUNT(*) FROM users;"
```

A restore is rehearsed only when you've actually booted the app against the restored file and logged in.

## Routine ops

- **Session sweep**: automatic (boot + daily). Manual: `DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')`.
- **Locked account**: `UPDATE users SET failed_logins=0, locked_until=NULL WHERE username='...'`.
- **Revoke a user's access**: set `status='disabled'` on the user row (sessions die on next request), or `DELETE FROM sessions WHERE user_id=...` for immediate.
- **Dependency check**: `npm audit` before every deploy; `npm outdated` monthly. A payments app does not ship with known-vulnerable deps (§4.2 gate).

## Incident basics

1. Customer-facing 500s carry a `request_id` — grep the Railway logs for it.
2. Priority outage: catalog/finance degrade gracefully (`priorityOk:false`); orders fail loudly — check `orders_local` rows in `status='failed'` and resubmit from Priority manually if needed.
3. Suspected credential compromise: revoke the user's sessions, reset password via invite, check `orders_local` + Priority ORDERS for that CUSTNAME, then review log lines `[csrf]`/`account_locked` around the time window.
4. Leaked PAT: revoke in Priority immediately (it has company-wide read/write), issue fresh, redeploy. This is the highest-blast-radius secret in the system.
