// Local SQLite snapshots: nightly `VACUUM INTO` under $DATA_DIR/backups, 30-day
// retention, one snapshot per calendar day (re-runs are no-ops). This is the
// last-resort layer; continuous off-site replication is Litestream's job
// (see litestream.yml + docs/OPS_RUNBOOK.md).

import path from 'node:path';
import fs from 'node:fs';
import { db } from './db.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const RETENTION_DAYS = 30;

export function snapshotDatabase(): string | null {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(BACKUP_DIR, `app-${day}.db`);
  if (fs.existsSync(target)) return null; // already snapshotted today

  // VACUUM INTO writes a compacted, consistent copy without blocking writers.
  db.prepare('VACUUM INTO ?').run(target);
  pruneOldSnapshots();
  console.log(`[backup] snapshot written: ${target}`);
  return target;
}

function pruneOldSnapshots(): void {
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!/^app-\d{4}-\d{2}-\d{2}\.db$/.test(name)) continue;
    const full = path.join(BACKUP_DIR, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        console.log(`[backup] pruned ${name}`);
      }
    } catch {
      /* ignore */
    }
  }
}

/** Boot + every 24h. Failures are logged, never fatal. */
export function scheduleSnapshots(): void {
  const run = () => {
    try {
      snapshotDatabase();
    } catch (err) {
      console.error('[backup] snapshot failed:', err);
    }
  };
  run();
  setInterval(run, 86400_000).unref();
}
