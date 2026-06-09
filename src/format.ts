// Shared formatting helpers for the customer-facing UI (RTL, Hebrew locale).

const moneyFmt = new Intl.NumberFormat('he-IL', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// ₪1,234.50 — always two decimals. Negative amounts keep their sign (credit notes).
export function formatMoney(n: number | null | undefined): string {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return '₪' + moneyFmt.format(v);
}

// ISO date/datetime → he-IL date (no time). Priority sends e.g. "2026-05-27T00:00:00Z".
export function formatDate(s: string | null | undefined): string {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString('he-IL');
}

// Local SQLite timestamps are stored as naive UTC ("2026-05-27 12:00:00"); append Z.
export function formatDateTime(s: string | null | undefined): string {
  if (!s) return '-';
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('he-IL');
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
