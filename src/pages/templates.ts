import { api } from '../api.js';
import { escapeHtml, formatDate } from '../format.js';
import { toast, emptyState, skeleton } from '../ui.js';
import { refreshCartCount } from '../main.js';

interface Template {
  id: number;
  name: string;
  itemCount: number;
  createdAt: string;
}

export async function renderTemplates(shell: HTMLElement): Promise<void> {
  shell.innerHTML = `<div class="card">${skeleton(3)}</div>`;
  let templates: Template[] = [];
  try {
    templates = (await api.get<{ templates: Template[] }>('/api/templates')).templates;
  } catch (ex) {
    shell.innerHTML = `<div class="card error">${escapeHtml(ex instanceof Error ? ex.message : ex)}</div>`;
    return;
  }
  if (!templates.length) {
    shell.innerHTML = `<div class="card">${emptyState('📋', 'אין תבניות שמורות', 'בנו סל ושמרו אותו כתבנית לשימוש חוזר', '#catalog', 'לקטלוג')}</div>`;
    return;
  }
  shell.innerHTML = `
    <div class="sec-head"><h1 style="margin:0;font-size:1.3rem">התבניות שלי</h1></div>
    ${templates
      .map(
        (t) => `
      <div class="card dash-row" style="margin-bottom:0.5rem" data-id="${t.id}">
        <div class="grow">
          <div style="font-weight:700">${escapeHtml(t.name)}</div>
          <div class="muted" style="font-size:0.83rem">${t.itemCount} פריטים · נשמר ${formatDate(t.createdAt)}</div>
        </div>
        <button class="tpl-add" data-id="${t.id}">הוסף לסל</button>
        <button class="ghost tpl-del" data-id="${t.id}" aria-label="מחק">🗑️</button>
      </div>`
      )
      .join('')}
  `;

  shell.querySelectorAll<HTMLButtonElement>('.tpl-add').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await api.post<{ added: number }>(`/api/templates/${b.dataset.id}/apply`, {});
        await refreshCartCount();
        if (!r.added) {
          toast('אף פריט מהתבנית אינו זמין כעת', 'error');
          b.disabled = false;
          return;
        }
        toast(`${r.added} פריטים נוספו לסל`, 'ok');
        location.hash = '#cart';
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
        b.disabled = false;
      }
    };
  });
  shell.querySelectorAll<HTMLButtonElement>('.tpl-del').forEach((b) => {
    b.onclick = async () => {
      if (!window.confirm('למחוק את התבנית?')) return;
      try {
        await api.del(`/api/templates/${b.dataset.id}`);
        renderTemplates(shell);
      } catch (ex) {
        toast(ex instanceof Error ? ex.message : String(ex), 'error');
      }
    };
  });
}
