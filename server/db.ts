// SQLite storage layer. Single file at $DATA_DIR/app.db. Migrations run at boot.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(DATA_DIR, { recursive: true });

const dbPath = path.join(DATA_DIR, 'app.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer','admin')),
  custname TEXT,
  cust_desc TEXT,
  email TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_custname ON users(custname);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cred_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('register','login')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token TEXT PRIMARY KEY,
  custname TEXT NOT NULL,
  cust_desc TEXT,
  email TEXT,
  phone TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_checks (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  custname TEXT NOT NULL,
  amount REAL,
  check_date TEXT,            -- the (possibly post-dated) date on the cheque, ISO yyyy-mm-dd
  is_postdated INTEGER NOT NULL DEFAULT 0,
  bank TEXT, branch TEXT, account TEXT, check_number TEXT,
  note TEXT,
  image_path TEXT,            -- AES-GCM encrypted blob on the volume (never web-served)
  ai_raw TEXT,                -- JSON of the model's structured extraction
  ai_confidence REAL,
  -- draft  = uploaded, awaiting customer confirm
  -- submitted = customer confirmed the promise-to-pay
  -- received / deposited / bounced / cancelled = office reconciliation
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_paychecks_user ON payment_checks(user_id);
CREATE INDEX IF NOT EXISTS idx_paychecks_status ON payment_checks(status);

CREATE TABLE IF NOT EXISTS card_payments (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  custname TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'debt',     -- 'debt' (pay open balance) for v1
  amount REAL NOT NULL,                  -- shekels, fixed server-side
  -- created → pending (hosted page opened) → paid | failed | expired
  status TEXT NOT NULL DEFAULT 'created',
  upay_cashier_id TEXT,
  confirmation_code TEXT,                -- SHVA approval
  four_digits TEXT,
  provider TEXT,                         -- shva / bit
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cardpay_user ON card_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_cardpay_status ON card_payments(status);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  business_name TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  city TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cart_lines (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  partname TEXT NOT NULL,
  quantity REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, partname)
);

CREATE TABLE IF NOT EXISTS orders_local (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  custname TEXT NOT NULL,
  priority_ordname TEXT,
  status TEXT NOT NULL,
  total REAL,
  promotions_json TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders_local(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_custname ON orders_local(custname);

CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders_local(id) ON DELETE CASCADE,
  partname TEXT NOT NULL,
  pdes TEXT,
  quantity REAL NOT NULL,
  price REAL NOT NULL,
  is_promotion_freebie INTEGER NOT NULL DEFAULT 0,
  promotion_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_order_lines_order ON order_lines(order_id);

CREATE TABLE IF NOT EXISTS catalog_cache (
  partname TEXT PRIMARY KEY,
  partdes TEXT,
  family TEXT,
  family_desc TEXT,
  barcode TEXT,
  list_price REAL,
  stock REAL,
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_catalog_family ON catalog_cache(family);
CREATE INDEX IF NOT EXISTS idx_catalog_active ON catalog_cache(active);

CREATE TABLE IF NOT EXISTS customer_pricing (
  custname TEXT NOT NULL,
  partname TEXT NOT NULL,
  price REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (custname, partname)
);

CREATE TABLE IF NOT EXISTS promotions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  x_partname TEXT,
  x_qty REAL,
  y_partname TEXT,
  y_qty REAL,
  y_discount_pct REAL,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  customer_filter TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Persistent stale-while-revalidate cache for Priority finance reads, so the
-- request path never blocks on Priority and warm data survives deploys/restarts.
CREATE TABLE IF NOT EXISTS finance_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

db.exec(SCHEMA);

// --- Migration: sessions used to store the raw token as its PRIMARY KEY. Rebuild
// the table around sha256(token) so a leaked DB file / backup can't be replayed as
// live sessions. Existing sessions keep working: the cookie still holds the raw
// token; lookups hash it first.
{
  const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === 'token')) {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE sessions_v2 (
          id INTEGER PRIMARY KEY,
          token_hash TEXT UNIQUE NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          ip TEXT,
          user_agent TEXT
        );
      `);
      const rows = db
        .prepare('SELECT token, user_id, created_at, expires_at, ip, user_agent FROM sessions')
        .all() as Array<{
        token: string;
        user_id: number;
        created_at: string;
        expires_at: string;
        ip: string | null;
        user_agent: string | null;
      }>;
      const ins = db.prepare(
        `INSERT INTO sessions_v2 (token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
         VALUES (?, ?, ?, ?, datetime('now'), ?, ?)`
      );
      for (const r of rows) {
        const hash = crypto.createHash('sha256').update(r.token).digest('hex');
        ins.run(hash, r.user_id, r.created_at, r.expires_at, r.ip, r.user_agent);
      }
      db.exec('DROP TABLE sessions');
      db.exec('ALTER TABLE sessions_v2 RENAME TO sessions');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
    });
    migrate();
    console.log('[db] sessions migrated to hashed tokens');
  }
}

// Clamp legacy session expiries to the new absolute caps (pre-migration rows were
// minted with a 30-day TTL). Idempotent — fresh sessions are never above the cap.
db.prepare(
  `UPDATE sessions SET expires_at = datetime('now', '+14 days')
   WHERE datetime(expires_at) > datetime('now', '+14 days')
     AND user_id IN (SELECT id FROM users WHERE role <> 'admin')`
).run();
db.prepare(
  `UPDATE sessions SET expires_at = datetime('now', '+12 hours')
   WHERE datetime(expires_at) > datetime('now', '+12 hours')
     AND user_id IN (SELECT id FROM users WHERE role = 'admin')`
).run();

function ensureColumn(table: string, column: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.find((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// Per-account login backoff (anti credential-stuffing; see auth.ts).
ensureColumn('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'locked_until', 'TEXT');

// Box / case size per SKU. Default 12 units. Source of truth: app-side override;
// will be populated from Priority LOGPART field once we pick which one (BOXSIZE / UDT).
ensureColumn('catalog_cache', 'box_size', 'INTEGER NOT NULL DEFAULT 12');

// B2B-specific overrides — additive, untouched by Priority sync.
ensureColumn('catalog_cache', 'b2b_visible', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('catalog_cache', 'b2b_partdes_override', 'TEXT');
ensureColumn('catalog_cache', 'b2b_description', 'TEXT');
ensureColumn('catalog_cache', 'b2b_image_path', 'TEXT');
ensureColumn('catalog_cache', 'b2b_tags', 'TEXT');
ensureColumn('catalog_cache', 'b2b_min_qty', 'INTEGER');
ensureColumn('catalog_cache', 'b2b_sort_priority', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('catalog_cache', 'b2b_featured', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('catalog_cache', 'b2b_category_override', 'TEXT');

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function getSettingBool(key: string, fallback: boolean): boolean {
  const v = getSetting(key);
  return v == null ? fallback : v === 'true';
}
export function setSettingBool(key: string, value: boolean): void {
  setSetting(key, value ? 'true' : 'false');
}
export function getSettingInt(key: string, fallback: number): number {
  const v = getSetting(key);
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** All settings as a flat map (admin panel). */
export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export interface UserRow {
  id: number;
  username: string;
  /** Only populated by the login query; deliberately NOT selected for session-loaded users. */
  password_hash?: string;
  role: 'customer' | 'admin';
  custname: string | null;
  cust_desc: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  created_at: string;
  last_login_at: string | null;
  /** Only populated by the login query (SELECT *). */
  failed_logins?: number;
  locked_until?: string | null;
}
