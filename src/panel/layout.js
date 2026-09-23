'use strict';

/**
 * Panel page layout (FR-001/FR-002, research.md R2 wrap-after-substitution).
 *
 * Routes keep their existing readFileSync + {{var}} replacement chain on a
 * fragment, then wrap the substituted fragment exactly once with
 * renderPage() (authenticated section pages) or renderAuthPage()
 * (login / set-password). A route that forgets to wrap fails visibly: the
 * browser renders a bare fragment without doctype/nav, instead of a subtle
 * partial layout.
 *
 * body is inserted VERBATIM — the caller is responsible for escaping the
 * values it substituted (every route already escapes via its own
 * escapeHtml). Only `title` is escaped here, since it is authored in this
 * module's callers, not in the templates.
 *
 * Nav: exactly 6 links in this fixed order (FR-001, contracts/routes.md).
 * The active link gets class="active" + aria-current="page".
 */

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', href: '/' },
  { id: 'telegram', label: 'Telegram', href: '/telegram' },
  { id: 'smtp', label: 'SMTP', href: '/smtp' },
  { id: 'actual', label: 'Actual', href: '/actual' },
  { id: 'recipients', label: 'Recipients', href: '/recipients' },
  { id: 'schedule', label: 'Schedule', href: '/schedule' },
];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Full authenticated page shell.
 *
 * @param {string} title   page title — becomes `<h1>` and `<title>… — actual-notifier panel</title>`
 * @param {string} active  nav item id that is active ('' or null = none active)
 * @param {string} body    substituted HTML fragment (verbatim)
 * @param {string} [username] when given, the header shows "Logged in as …"
 */
function renderPage({ title, active, body, username }) {
  const nav = NAV_ITEMS.map((item) => {
    const isActive = item.id === active;
    const cls = isActive ? ' class="active"' : '';
    const aria = isActive ? ' aria-current="page"' : '';
    return `    <a href="${item.href}"${cls}${aria}>${item.label}</a>`;
  }).join('\n');

  const userLine = username ? `\n    <p class="user">Logged in as ${escapeHtml(username)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/panel.css"><title>${escapeHtml(title)} — actual-notifier panel</title></head>
<body>
<div class="panel">
  <header class="panel-header">
    <h1>${escapeHtml(title)}</h1>${userLine}
  </header>
  <nav class="nav">
${nav}
  </nav>
  <main>
${body}
  </main>
  <footer class="panel-footer">
    <a href="/set-password">Change password</a>
    <form method="post" action="/logout"><button type="submit">Logout</button></form>
  </footer>
</div>
</body>
</html>`;
}

/**
 * Auth page shell (login / set-password): centered .auth container (FR-001),
 * no nav, no footer, no logout.
 *
 * @param {string} title page title
 * @param {string} body  substituted HTML fragment (verbatim)
 */
function renderAuthPage({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/static/panel.css"><title>${escapeHtml(title)} — actual-notifier panel</title></head>
<body>
<div class="panel">
  <main class="auth">
${body}
  </main>
</div>
</body>
</html>`;
}

module.exports = { renderPage, renderAuthPage };
