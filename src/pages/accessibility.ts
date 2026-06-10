import { escapeHtml } from '../format.js';

// Accessibility statement (הצהרת נגישות) — required for an Israeli B2B service
// under ת"י 5568 / the service-accessibility regulations. Public page.
export function renderAccessibility(shell: HTMLElement): void {
  const contactEmail = 'Assaf@orgat.co.il';
  shell.innerHTML = `
    <div class="card" style="line-height:1.6">
      <h1 style="margin-top:0">הצהרת נגישות</h1>
      <p>אורגת סחר בע״מ רואה חשיבות רבה במתן שירות שוויוני ונגיש לכלל הלקוחות, לרבות אנשים עם מוגבלות, ופועלת להנגשת אתר ההזמנות שלה (להלן "האתר").</p>

      <h2>רמת הנגישות באתר</h2>
      <p>האתר נבנה במאמץ לעמוד בהוראות תקנות שוויון זכויות לאנשים עם מוגבלות (התאמות נגישות לשירות), התשע״ג‑2013, ובתקן הישראלי ת״י 5568 ברמה AA (התואם להנחיות WCAG 2.0 ברמה AA). בכלל זה: ניווט וקריאות בעברית מימין‑לשמאל, טקסט חלופי לתמונות מוצרים, ניגודיות צבעים, יעדי מגע מוגדלים בנייד, והפעלה מקלדתית.</p>

      <h2>הסתייגויות</h2>
      <p>על אף מאמצינו, ייתכן שחלקים מסוימים באתר טרם הונגשו במלואם או נמצאים בתהליך שיפור מתמשך. אנו ממשיכים לבצע בדיקות והתאמות.</p>

      <h2>יצירת קשר בנושא נגישות</h2>
      <p>אם נתקלתם בקושי בגלישה או בנגישות, נשמח לסייע ולתקן. ניתן לפנות לרכז הנגישות מטעמנו:</p>
      <ul>
        <li>דוא״ל: <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></li>
        <li>אורגת סחר בע״מ</li>
      </ul>
      <p>בפנייתכם פרטו את הבעיה, הדף שבו נתקלתם בה וסוג הדפדפן/המכשיר — נטפל בפנייה בהקדם.</p>

      <p class="muted" style="font-size:0.85rem">הצהרה זו עודכנה לאחרונה ביוני 2026.</p>
      <div style="margin-top:1rem"><a href="#login">חזרה</a></div>
    </div>`;
}
