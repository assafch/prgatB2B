// Saved-basket templates ("שמירה כתבנית") + product favorites. All session-scoped.

import { db } from './db.js';
import { setCartLine } from './orders.js';
import { getProduct } from './catalog.js';

export interface TemplateView {
  id: number;
  name: string;
  itemCount: number;
  createdAt: string;
}

export function saveTemplate(userId: number, custname: string, name: string): number {
  const lines = db.prepare('SELECT partname, quantity FROM cart_lines WHERE user_id = ?').all(userId) as Array<{
    partname: string;
    quantity: number;
  }>;
  if (!lines.length) throw new Error('הסל ריק — אין מה לשמור');
  const id = Number(
    db.prepare('INSERT INTO templates (user_id, custname, name) VALUES (?, ?, ?)').run(userId, custname, (name || 'תבנית').slice(0, 80)).lastInsertRowid
  );
  const ins = db.prepare('INSERT INTO template_lines (template_id, partname, quantity) VALUES (?, ?, ?)');
  db.transaction(() => lines.forEach((l) => ins.run(id, l.partname, l.quantity)))();
  return id;
}

export function listTemplates(userId: number): TemplateView[] {
  return (
    db
      .prepare(
        `SELECT t.id, t.name, t.created_at AS createdAt,
                (SELECT COUNT(*) FROM template_lines tl WHERE tl.template_id = t.id) AS itemCount
           FROM templates t WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT 100`
      )
      .all(userId) as Array<{ id: number; name: string; createdAt: string; itemCount: number }>
  ).map((r) => ({ id: r.id, name: r.name, itemCount: r.itemCount, createdAt: r.createdAt }));
}

/** Load a template's lines into the cart (skips items no longer sellable). */
export function applyTemplate(userId: number, custname: string, id: number): number {
  const t = db.prepare('SELECT id FROM templates WHERE id = ? AND user_id = ?').get(id, userId);
  if (!t) throw new Error('תבנית לא נמצאה');
  const lines = db.prepare('SELECT partname, quantity FROM template_lines WHERE template_id = ?').all(id) as Array<{
    partname: string;
    quantity: number;
  }>;
  let added = 0;
  for (const l of lines) {
    const prod = getProduct(l.partname, custname);
    if (!prod || typeof prod.price !== 'number' || prod.price <= 0) continue;
    try {
      setCartLine(userId, custname, l.partname, l.quantity, 'add');
      added++;
    } catch {
      /* skip */
    }
  }
  return added;
}

export function deleteTemplate(userId: number, id: number): boolean {
  return db.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

// --- favorites ---
export function toggleFavorite(userId: number, partname: string): boolean {
  const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND partname = ?').get(userId, partname);
  if (exists) {
    db.prepare('DELETE FROM favorites WHERE user_id = ? AND partname = ?').run(userId, partname);
    return false;
  }
  db.prepare('INSERT INTO favorites (user_id, partname) VALUES (?, ?)').run(userId, partname);
  return true;
}

export function listFavorites(userId: number): string[] {
  return (db.prepare('SELECT partname FROM favorites WHERE user_id = ?').all(userId) as Array<{ partname: string }>).map((r) => r.partname);
}
