# UI/HUD Contract: Panel basic layout

**Feature**: `002-panel-basic-layout` | **Date**: 2026-09-23

Defines the observable contract of the maquetación: what every page emits, what the two layout variants contain, and what MUST NOT change from the 001 behavior this feature builds on.

## Invariant contract (unchanged by this feature — regression guard)

Every item below holds today and MUST hold after the feature (SC-005, FR-004). The quickstart verifies each one.

| # | Contract | Route |
|---|----------|-------|
| I-1 | URLs, methods, status codes identical: 200 on GET, 302 redirects as today, 400 on invalid form POST, 404 unknown, 404/200 on reveal | all |
| I-2 | Session behavior: no/invalid/expired cookie → 302 to `/login`; bootstrap session → 302 to `/set-password` (except `/set-password`, `/logout`) | all |
| I-3 | All form field `name` attributes, action paths, and method (`post`) unchanged on every page | all pages with forms |
| I-4 | Error messages appear in the same place (top of form area) via the route's existing error path; content text unchanged | all |
| I-5 | `POST /reveal/:field` returns the same plain-text one-shot; page buttons for it keep same ids/labels (e.g. `reveal-btn`, "Show") | telegram, smtp, actual |
| I-6 | Static error pages for router 404/500 keep working (they are plain HTML, not layouted — acceptable, they are not among the 8 pages) | server |

## New contract 1: `GET /static/panel.css`

| Aspect | Value |
|--------|-------|
| Method/path | `GET /static/panel.css` |
| Auth | **public** (no session gate). Fix `login-css-session-gate` (2026-09-24): the auth pages (`/login`, `/set-password`) exist only pre-session and link this asset, so a `requireSession` gate 302'd the `<link>` and left them unstyled. The CSS is cosmetic-only (no data) and the port is already bound via `PANEL_BIND_HOST`. |
| Success | `200`, `Content-Type: text/css; charset=utf-8`, `Cache-Control: no-store`, body = exact bytes of `src/panel/static/panel.css` |
| Failure | file missing/corrupt → `500` plain text (same as any panel 500) |

## New contract 2: page HTML shapes

### `renderPage` variant (6 authenticated sections)

Every such page's document MUST contain, in order:

1. `<!doctype html>` / `<html>` … with `<link rel="stylesheet" href="/static/panel.css">` in `<head>` and a page-specific `<title>` ending in `— actual-notifier panel`.
2. A `<header>` containing the panel name (text "actual-notifier config panel" or equivalent single string).
3. A `<nav>` with **exactly** 6 links, in this fixed order, each `<a href>` → path, and exactly one of them carrying `aria-current="page"` (plus CSS class `active`):
   | Label | href |
   |-------|------|
   | Dashboard | `/` |
   | Telegram | `/telegram` |
   | SMTP | `/smtp` |
   | Actual | `/actual` |
   | Recipients | `/recipients` |
   | Schedule | `/schedule` |
4. A `<main>` containing the page fragment (its existing `<h1>`, error area, form(s), page-specific script if any — fragment content byte-for-byte the route's current body minus the wrappers listed in research R3).
5. A `<footer>` containing (in order): "Change password" link → `/set-password`, and the logout `<form method="post" action="/logout">` with submit button "Log out".

### `renderAuthPage` variant (login, set-password)

MUST contain: `<head>` with the same `<link>` and a page `<title>`; a centered `<main class="auth">` with the existing h1, error area, and form(s) unchanged; **no `<nav>`**; NO logout form (user is not authenticated).

### Class vocabulary (styling hooks)

The fragment-level classes introduced (research R3) and their required placement:

- `.card` — wraps the page's primary form container.
- `.error` — the validation error paragraph (replaces inline `style="color:red"`).
- `.actions` — the row holding the submit button.

The layout adds: `.nav`, `.nav a.active`, `.auth` (centered container), plus generic element styling. No other class names are required by the contract; the CSS may use more internally.

## Acceptance mapping (contract row → spec FR)

- 6-link nav, fixed order, 1 active → FR-005, FR-006, SC-001, SC-003.
- `<link>` on all 8 pages → FR-001, SC-001.
- Fragments keep fields/error position → FR-002, FR-003, FR-004, SC-002, SC-005.
- Change-password + logout in footer of all authenticated pages → FR-007.
- Auth pages centered, no nav → FR-008.
- Narrow-viewport non-breaking layout → FR-009 (CSS-only).
- Reveal flow unchanged → FR-010, SC-004, I-5.
