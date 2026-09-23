# Quickstart: Panel basic layout

Validation guide for proving the maquetación works end-to-end and that nothing functional changed. See [data-model.md](./data-model.md) for entities and [contracts/routes.md](./contracts/routes.md) for the full page/contract list.

## Prerequisites

- Docker + Docker Compose, `actual_net` external network already created.
- The existing three-service stack (notifier-cron, notifier-listener, config-panel) buildable from this repo.
- A panel login/username+password already set (or go through the bootstrap flow once).

## Setup

```bash
# Rebuild only the panel image — the other two services are untouched by this feature
docker compose build config-panel
docker compose up -d config-panel
```

## Syntax gate (run first)

```powershell
# From repo root, into the dev panel container (same convention as DEPLOY.md)
docker compose run --rm --entrypoint="" config-panel node --check /app/src/panel/layout.js
docker compose run --rm --entrypoint="" config-panel node --check /app/src/panel/server.js
docker compose run --rm --entrypoint="" config-panel node --check /app/src/panel/routes/dashboard.js
# ... and so on for every touched route module
```

**Expected**: no output, exit 0 for each.

## Scenario 1 — CSS is served and gated (Contract 1)

1. Log in to the panel and open any page.
2. **Expected** (DevTools → Network): `GET /static/panel.css` returns `200`, `Content-Type: text/css; charset=utf-8`, `Cache-Control: no-store`; the page is visibly styled.
3. Open `http://127.0.0.1:8080/static/panel.css` in a **fresh browser profile without a session cookie**.
4. **Expected**: a `302` to `/login` — the asset is not readable unauthenticated (no CSS leak).
5. **Expected (visual)**: the page renders styled content, not the old flat HTML (compare against a screenshot of the pre-change panel if you have one).

## Scenario 2 — All 6 authenticated pages share the shell + nav (FR-001, FR-005, FR-006, SC-001, SC-003)

1. While logged in, visit each of: `/`, `/telegram`, `/smtp`, `/actual`, `/recipients`, `/schedule`.
2. For EACH page, **expected**:
   - same `<header>` (panel name) at top;
   - the same `<nav>` with 6 links in the fixed order (Dashboard, Telegram, SMTP, Actual, Recipients, Schedule);
   - exactly one nav link visually active (and carrying `aria-current="page"`), and it is the link matching the current page;
   - the same `<footer>` with "Change password" link and "Log out" button;
   - `<link rel="stylesheet" href="/static/panel.css">` present in `<head>`.
3. From any page (e.g. `/smtp`), click a different nav link (e.g. "Schedule").
4. **Expected**: one click reaches `/schedule`, no bounce through dashboard (SC-003).

## Scenario 3 — Login and set-password are styled but have no nav (FR-008)

1. Log out.
2. **Expected** on `/login`: centered layout, same font/branding as the rest, input + password + "Log in" readable; **no `<nav>`**, no "Log out" button.
3. (If you need to) wipe `panel_password_hash` from `data/notifier.db`'s kv table in a **dev** environment to re-enter bootstrap, set a password.
4. **Expected** on `/set-password`: same centered, no-nav treatment.

## Scenario 4 — Form behavior is unchanged (FR-002, FR-003, FR-004, SC-002, SC-005)

1. Go to `/recipients`. Change the list to an invalid value (e.g. a string without `@`).
2. Save.
3. **Expected**: 400 response, error message shown highlighted in the same position as before (top of the form area), the input value preserved, and **no** value written to `.env`.
4. Fix the value and save.
5. **Expected**: success, `.env` updated (verify with `docker compose exec config-panel cat .env` filtering `NOTIFICATION_EMAIL`), page re-renders with the same structure as step 1.
6. Repeat a similar valid/invalid POST pair on at least two other sections (`/telegram` for the categories allow-list, `/schedule` for the cron schedule).
7. **Expected**: identical behavior to pre-change panel — only styling differs.

## Scenario 5 — Reveal flow unchanged (FR-010, SC-004)

1. On `/telegram`, click the "Show" button next to the masked bot token.
2. **Expected**: the masked value is replaced by the actual token via the existing `POST /reveal/telegram-bot-token` plain-text one-shot; the button, label, and DOM element ids are exactly the same as before the change (verify element `id="reveal-btn"` and `id="masked-token"` in DevTools).
3. Repeat on whichever other page (smtp, actual) exposes a reveal button.

## Scenario 6 — Session-expiry redirect unchanged (I-2)

1. Log in, open a page, then manually clear the `panel_session` cookie in DevTools.
2. Reload.
3. **Expected**: 302 to `/login`, exactly as before (no layout-related side effect on the redirect).
4. (Optional: for a bootstrap session) create one, then visit any path other than `/set-password` or `/logout`.
5. **Expected**: 302 to `/set-password`, unchanged.

## Scenario 7 — Narrow-viewport degradation (FR-009 — tolerance, not goal)

1. Open any authenticated page (e.g. `/recipients`) in a desktop-width window.
2. Drag the browser window to well below a typical desktop width (e.g. 640px).
3. **Expected (tolerance)**: layout does not "break" — nav links wrap or stack, content column stays readable, no overlap, no content off-screen without scroll.
4. **Not expected**: an optimized mobile experience (no touch targets engineering, no hamburger menu).

## Scenario 8 — No functional regression sweep (SC-005, I-1)

Run this last, as a fast click-through:

1. In a **single** logged-in session, hit each of the 8 pages in turn and take a 5-second look.
2. **Expected**: no page is blank, no form is missing a previously-present field, no route 404s that used to 200 before the change, and every `POST /reveal/*` still returns the plain-text value.
3. `docker compose exec config-panel node --check /app/src/panel/routes/telegram.js # etc.` — all touched modules still parse.

## Optional — unit check of the layout helper

The one new pure function is the easiest thing to guard with a scripted assertion. This is optional but cheap:

```js
// drop as src/dev/check-layout.js (same convention as other src/dev/* scripts)
const { renderPage, renderAuthPage } = require('../panel/layout');

const page = renderPage({ title: 'x', active: 'recipients', body: '<h1>hi</h1>' });
if (!page.includes('href="/static/panel.css"')) throw new Error('missing css link');
if (!page.includes('aria-current="page"')) throw new Error('missing active marker');
if (page.split('aria-current="page"').length - 1 !== 1) throw new Error('active not exactly once');
if (!page.includes('/recipients')) throw new Error('nav missing recipients');

const auth = renderAuthPage({ title: 'login', body: '<h1>Log in</h1>' });
if (auth.includes('<nav')) throw new Error('auth page must not carry nav');
if (!auth.includes('href="/static/panel.css"')) throw new Error('auth page missing css link');

console.log('layout OK');
```

```powershell
docker compose run --rm --entrypoint="" config-panel node /app/src/dev/check-layout.js
```

**Expected**: prints `layout OK`.

(If the dev-only script is not shipped into the image, run it on the host with `node src/dev/check-layout.js` — the module has no external dependency.)
