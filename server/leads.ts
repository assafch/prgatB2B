// Public lead capture.

import { db } from './db.js';

export interface LeadInput {
  business_name?: string;
  contact_name?: string;
  phone?: string;
  email?: string;
  city?: string;
  notes?: string;
}

// Public, unauthenticated input — accept strings only and clamp lengths so the
// endpoint can't be used to stuff megabytes into the DB.
function clamp(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function createLead(input: LeadInput): number {
  const result = db
    .prepare(
      `INSERT INTO leads (business_name, contact_name, phone, email, city, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      clamp(input.business_name, 200),
      clamp(input.contact_name, 200),
      clamp(input.phone, 50),
      clamp(input.email, 200),
      clamp(input.city, 100),
      clamp(input.notes, 2000)
    );
  return result.lastInsertRowid as number;
}

export function listLeads(): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 200')
    .all() as Array<Record<string, unknown>>;
}

export function updateLeadStatus(id: number, status: string): void {
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, id);
}
