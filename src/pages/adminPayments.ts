// Admin payments — mobile-first cheque approval queue (Stage 8c).
// Three segmented tabs: צ׳קים (submitted cheques → approve/reject queue),
// אשראי (paid card payments, read-only), היסטוריה (reconciled cheques, the
// old status <select> workflow verbatim).
import { api } from '../api.js';
import { escapeAttr, escapeHtml, formatDate, formatDateTime, formatMoney } from '../format.js';
import { confirmDialog, toast } from '../ui.js';
import { refreshOpsBadges } from './adminShell.js';

interface AdminCheck {
  id: string;
  custname: string;
  amount: number | null;
  checkDate: string | null;
  isPostdated: boolean;
  bank?: string | null;
  status: string;
  createdAt: string;
}

interface CardPayment {
  id: string;
  custname: string;
  amount: number;
  status: string;
  kind: string;
  confirmationCode: string | null;
  fourDigits: string | null;
  provider: string | null;
  paidItems: string[] | null;
  createdAt: string;
  paidAt: string | null;
}

interface UnpaidInvoice {
  ivnum: string;
  amount: number;
  date: string | null;
}

type MatchState =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'match'; invoices: UnpaidInvoice[]; matched: UnpaidInvoice };

type PayTab = 'checks' | 'credit' | 'history';

// Module-level state: tab + which cheque card is expanded persist across
// re-renders (same pattern as adminCustomers' `qs`).
let activeTab: PayTab = 'checks';
let expandedId: string | null = null;

// Same labels/values as the pre-redesign renderPaymentsAdmin (office reconciliation flow).
const HISTORY_STATUS_OPTS: Array<[string, string]> = [
  ['submitted', 'התקבל — בעיבוד'],
  ['received', 'הצ׳ק נאסף'],
  ['deposited', 'הופקד'],
  ['bounced', 'חזר'],
  ['cancelled', 'בוטל'],
];

export async function renderAdminPayments(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `
    <div class="adm-head"><h1 class="adm-title">תשלומים</h1></div>
    <div class="pay-tabs">
      <button type="button" data-t="checks" class="${activeTab === 'checks' ? 'sel' : ''}">צ׳קים<span class="pay-tab-badge" id="pay-checks-badge" hidden>0</span></button>
      <button type="button" data-t="credit" class="${activeTab === 'credit' ? 'sel' : ''}">אשראי</button>
      <button type="button" data-t="history" class="${activeTab === 'history' ? 'sel' : ''}">היסטוריה</button>
    </div>
    <div id="pay-body"></div>`;

  shell.querySelectorAll<HTMLButtonElement>('.pay-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.t as PayTab;
      if (t === activeTab) return;
      activeTab = t;
      expandedId = null;
      shell.querySelectorAll('.pay-tabs button').forEach((b) => b.classList.remove('sel'));
      btn.classList.add('sel');
      void loadTab(shell);
    });
  });

  await loadTab(shell);
}

async function loadTab(shell: HTMLElement): Promise<void> {
  const body = shell.querySelector('#pay-body') as HTMLElement;
  body.innerHTML = `<div class="adm-empty">טוען…</div>`;

  let checks: AdminCheck[];
  try {
    checks = (await api.get<{ checks: AdminCheck[] }>('/api/admin/payments')).checks.filter((c) => c.status !== 'draft');
  } catch (ex) {
    body.innerHTML = `<div class="adm-card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
    return;
  }
  const submitted = checks.filter((c) => c.status === 'submitted');
  const history = checks.filter((c) => c.status !== 'submitted');

  const badge = shell.querySelector('#pay-checks-badge') as HTMLElement;
  badge.textContent = String(submitted.length);
  badge.hidden = submitted.length === 0;

  if (activeTab === 'checks') renderChecksTab(shell, body, submitted);
  else if (activeTab === 'credit') await loadCreditTab(body);
  else renderHistoryTab(shell, body, history);
}

// ---- צ׳קים tab: the approval queue ----

function chequeRowHtml(ch: AdminCheck): string {
  const isExpanded = ch.id === expandedId;
  const imgUrl = `/api/admin/payments/${encodeURIComponent(ch.id)}/image`;
  const bankLabel = ch.bank ? escapeHtml(ch.bank) : '—';
  const dateLabel = ch.checkDate ? escapeHtml(formatDate(ch.checkDate)) : '—';
  return `
    <div class="chq-row${isExpanded ? ' expanded' : ''}" data-id="${escapeAttr(ch.id)}">
      <img class="chq-thumb" loading="lazy" src="${imgUrl}" alt="" onerror="this.style.visibility='hidden'"/>
      <div class="chq-row-main">
        <div class="chq-row-name">${escapeHtml(ch.custname)} <span class="money">${ch.amount != null ? formatMoney(ch.amount) : '—'}</span></div>
        <div class="chq-row-meta">${bankLabel} · ${dateLabel}${ch.isPostdated ? ' <span class="badge warn">דחוי</span>' : ''}</div>
      </div>
      <span class="chq-chev">‹</span>
    </div>
    ${isExpanded ? chequeExpandHtml(ch) : ''}`;
}

function chequeExpandHtml(ch: AdminCheck): string {
  const imgUrl = `/api/admin/payments/${encodeURIComponent(ch.id)}/image`;
  return `
    <div class="chq-expand" data-expand="${escapeAttr(ch.id)}">
      <a class="chq-photo-link" href="${imgUrl}" target="_blank" rel="noopener">
        <img class="chq-photo-lg" loading="lazy" src="${imgUrl}" alt="" onerror="this.style.visibility='hidden'"/>
      </a>
      <div class="chq-match-wrap">${matchStripHtml({ kind: 'loading' })}</div>
      <div class="chq-actions">
        <button type="button" class="chq-approve">✓ אשר צ׳ק</button>
        <button type="button" class="chq-reject">דחה</button>
      </div>
    </div>`;
}

function matchStripHtml(state: MatchState): string {
  if (state.kind === 'loading') return `<div class="chq-match">בודק התאמה…</div>`;
  if (state.kind === 'none') return `<div class="chq-match">ללא התאמה אוטומטית</div>`;
  const { invoices, matched } = state;
  const options =
    `<option value="">ללא התאמה</option>` +
    invoices
      .map(
        (iv) =>
          `<option value="${escapeAttr(iv.ivnum)}"${iv.ivnum === matched.ivnum ? ' selected' : ''}>חשבונית ${escapeHtml(iv.ivnum)} · ${formatMoney(iv.amount)}</option>`
      )
      .join('');
  return `
    <div class="chq-match-ok">
      <span class="chq-match-text">התאמה: חשבונית ${escapeHtml(matched.ivnum)} · ${formatMoney(matched.amount)} ✓</span>
      <button type="button" class="chq-match-change">שנה ▾</button>
    </div>
    <select class="chq-match-select" hidden>${options}</select>`;
}

function renderChecksTab(shell: HTMLElement, body: HTMLElement, submitted: AdminCheck[]): void {
  if (submitted.length === 0) {
    body.innerHTML = `
      <div class="adm-empty">
        צ׳קים שלקוחות מצלמים באפליקציה יופיעו כאן לאישור שלך<br/>
        <a href="#admin/settings" class="adm-btn-ghost" style="margin-top:10px;display:inline-block">בדוק שהמתג פעיל ←</a>
      </div>`;
    return;
  }
  body.innerHTML = `<div class="adm-card" style="padding:0;overflow:hidden">${submitted.map(chequeRowHtml).join('')}</div>`;
  wireChecksTab(shell, body, submitted);
}

function wireChecksTab(shell: HTMLElement, body: HTMLElement, submitted: AdminCheck[]): void {
  body.querySelectorAll<HTMLElement>('.chq-row').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.id!;
      expandedId = expandedId === id ? null : id;
      renderChecksTab(shell, body, submitted);
    });
  });

  const expanded = submitted.find((c) => c.id === expandedId);
  if (!expanded) return;

  const matchWrap = body.querySelector('.chq-match-wrap') as HTMLElement;
  void loadMatch(expanded, matchWrap);

  const expandEl = body.querySelector('.chq-expand') as HTMLElement;
  (expandEl.querySelector('.chq-approve') as HTMLButtonElement).addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    try {
      await api.patch(`/api/admin/payments/${encodeURIComponent(expanded.id)}`, { status: 'received' });
      toast('✓ הצ׳ק אושר', 'ok');
      expandedId = null;
      await loadTab(shell);
      void refreshOpsBadges();
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'העדכון נכשל', 'error');
      btn.disabled = false;
    }
  });
  (expandEl.querySelector('.chq-reject') as HTMLButtonElement).addEventListener('click', async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (!(await confirmDialog('לדחות את הצ׳ק? הלקוח יראה אותו כבוטל.'))) return;
    btn.disabled = true;
    try {
      await api.patch(`/api/admin/payments/${encodeURIComponent(expanded.id)}`, { status: 'cancelled' });
      toast('הצ׳ק נדחה', 'ok');
      expandedId = null;
      await loadTab(shell);
      void refreshOpsBadges();
    } catch (ex) {
      toast(ex instanceof Error ? ex.message : 'העדכון נכשל', 'error');
      btn.disabled = false;
    }
  });
}

// Auto-match hint only — nothing is written to Priority; the picked invoice
// only changes what this card displays.
async function loadMatch(ch: AdminCheck, wrap: HTMLElement): Promise<void> {
  let invoices: UnpaidInvoice[];
  try {
    invoices = (
      await api.get<{ invoices: UnpaidInvoice[] }>(`/api/admin/customers/${encodeURIComponent(ch.custname)}/unpaid-invoices`)
    ).invoices;
  } catch {
    wrap.innerHTML = matchStripHtml({ kind: 'none' });
    return;
  }
  const matched = ch.amount != null ? invoices.find((iv) => Math.abs(iv.amount - ch.amount!) < 0.01) : undefined;
  if (!matched) {
    wrap.innerHTML = matchStripHtml({ kind: 'none' });
    return;
  }
  wrap.innerHTML = matchStripHtml({ kind: 'match', invoices, matched });
  const changeBtn = wrap.querySelector('.chq-match-change') as HTMLButtonElement;
  const select = wrap.querySelector('.chq-match-select') as HTMLSelectElement;
  const textEl = wrap.querySelector('.chq-match-text') as HTMLElement;
  changeBtn.addEventListener('click', () => {
    select.hidden = !select.hidden;
  });
  select.addEventListener('change', () => {
    const iv = invoices.find((x) => x.ivnum === select.value);
    textEl.textContent = iv ? `התאמה: חשבונית ${iv.ivnum} · ${formatMoney(iv.amount)} ✓` : 'ללא התאמה (נבחר ידנית)';
  });
}

// ---- אשראי tab: read-only, already reconciled automatically ----

async function loadCreditTab(body: HTMLElement): Promise<void> {
  let payments: CardPayment[];
  try {
    payments = (await api.get<{ payments: CardPayment[] }>('/api/admin/card-payments')).payments.filter((p) => p.status === 'paid');
  } catch (ex) {
    body.innerHTML = `<div class="adm-card error">${escapeHtml(ex instanceof Error ? ex.message : String(ex))}</div>`;
    return;
  }
  if (payments.length === 0) {
    body.innerHTML = `<div class="adm-empty">תשלומי אשראי שאושרו יופיעו כאן</div>`;
    return;
  }
  body.innerHTML = `
    <div class="adm-card" style="padding:0;overflow:hidden">
      <div class="cust-grid-head">אשראי · אושרו אוטומטית — לקריאה בלבד</div>
      ${payments
        .map(
          (p) => `
        <div class="cred-row">
          <span class="cred-icon">✓</span>
          <div class="promo-row-main">
            <div class="promo-row-name">${escapeHtml(p.custname)}</div>
            <div class="promo-row-desc">${escapeHtml(p.provider || 'אשראי')} · ${escapeHtml(formatDateTime(p.paidAt || p.createdAt))}</div>
          </div>
          <span class="money">${formatMoney(p.amount)}</span>
        </div>`
        )
        .join('')}
    </div>`;
}

// ---- היסטוריה tab: non-submitted cheques, old status <select> verbatim ----

function renderHistoryTab(_shell: HTMLElement, body: HTMLElement, history: AdminCheck[]): void {
  if (history.length === 0) {
    body.innerHTML = `<div class="adm-empty">אין עדיין היסטוריית תשלומי צ׳ק.</div>`;
    return;
  }
  const opts = (cur: string) =>
    HISTORY_STATUS_OPTS.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('');

  body.innerHTML = `
    <div class="adm-card">
      <table class="table">
        <thead><tr><th>לקוח</th><th>סכום</th><th>תאריך צ׳ק</th><th>נשלח</th><th>סטטוס</th><th>צ׳ק</th></tr></thead>
        <tbody>
          ${history
            .map(
              (ch) => `
            <tr data-id="${escapeAttr(ch.id)}">
              <td>${escapeHtml(ch.custname)}</td>
              <td class="amount">${ch.amount != null ? formatMoney(ch.amount) : '-'}</td>
              <td>${ch.checkDate ? escapeHtml(formatDate(ch.checkDate)) : '-'}${ch.isPostdated ? ' <span class="badge warn">דחוי</span>' : ''}</td>
              <td>${escapeHtml((ch.createdAt || '').slice(0, 10))}</td>
              <td><select class="pay-status" data-id="${escapeAttr(ch.id)}">${opts(ch.status)}</select></td>
              <td><a href="/api/admin/payments/${encodeURIComponent(ch.id)}/image" target="_blank">צפייה</a></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div id="pay-hist-msg" style="margin-top:0.5rem"></div>
    </div>`;

  const msg = body.querySelector('#pay-hist-msg') as HTMLDivElement;
  body.querySelectorAll<HTMLSelectElement>('select.pay-status').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        await api.patch(`/api/admin/payments/${sel.dataset.id}`, { status: sel.value });
        msg.textContent = '✓ עודכן';
        msg.className = 'ok';
        void refreshOpsBadges();
      } catch (ex) {
        msg.textContent = `שגיאה: ${ex instanceof Error ? ex.message : ex}`;
        msg.className = 'error';
      }
    });
  });
}
