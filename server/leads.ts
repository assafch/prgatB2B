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

export function createLead(input: LeadInput): number {
  const result = db
    .prepare(
      `INSERT INTO leads (business_name, contact_name, phone, email, city, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.business_name ?? null,
      input.contact_name ?? null,
      input.phone ?? null,
      input.email ?? null,
      input.city ?? null,
      input.notes ?? null
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
