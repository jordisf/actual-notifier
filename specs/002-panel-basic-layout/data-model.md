# Data Model: Panel basic layout

**Feature**: `002-panel-basic-layout` | **Date**: 2026-09-23

## Statement

This feature introduces **no new persisted data**: no new kv keys in the SQLite store, no new table, no new `.env` variables, no new `crontab.txt` lines. The entire change is presentational — HTML composition and one static CSS file. Everything below is the (unchanged) data the feature *renders*, documented so the layout contract in `contracts/routes.md` has a stable vocabulary.

## Entities rendered (all existing, unchanged)

### Panel page (view)

The 8 pages maquetadas (spec Key Entities). Two groups:

| Group | Pages | Route | Layout variant |
|-------|-------|-------|----------------|
| Authenticated sections | dashboard, telegram, smtp, actual, recipients, schedule | `/`, `/telegram`, `/smtp`, `/actual`, `/recipients`, `/schedule` | `renderPage` (shell + nav, active section) |
| Auth pages | login, set-password | `/login`, `/set-password` | `renderAuthPage` (centered, no nav) |

**Attributes consumed per page** (byte-for-byte the `{{var}}` markers each route substitutes today — unchanged by this feature):

| Page | Markers |
|------|---------|
| dashboard | `{{username}}` |
| telegram | `{{maskedToken}}`, `{{groupId}}`, `{{categories}}`, `{{pollTimeout}}`, `{{errorHtml}}` |
| smtp | (route's own markers — see `routes/smtp.js`) |
| actual | (route's own markers — see `routes/actual.js`) |
| recipients | `{{recipients}}`, `{{errorHtml}}` |
| schedule | (route's own markers — see `routes/schedule.js`) |
| login | `{{errorHtml}}` inline (rendered in `routes/login.js`) |
| set-password | `{{errorHtml}}`, `{{username}}` inline |

**Validation rules**: none added. All existing field validation lives in the route modules and is untouched (FR-004).

**State transitions**: none. Pages are stateless renders of current `.env`/kv values; the only cross-page state is the existing signed session cookie.

### Nav section (new, in-memory only)

One of the 6 authenticated-section identifiers: `dashboard | telegram | smtp | actual | recipients | schedule`.

- **Identity/uniqueness**: exactly six fixed values, defined once in `layout.js` as the nav model; each maps to a constant URL path.
- **Active state**: derived per-request from which route rendered the page (`active` argument to `renderPage`); rendered as `aria-current="page"` + `.active` class on that nav link only (FR-006). No persistence, no URL parameter.
- **Relationships**: 1 nav section ↔ 1 authenticated page; nav is rendered only in the `renderPage` variant, never in `renderAuthPage` (FR-008).

## What is explicitly NOT data

- The `reveal` flow (`POST /reveal/:field`) is a plain-text one-shot, not a page — no layout, no nav (spec Assumptions, verified in decision).
- No user preference is stored for layout (no theme choice, no "home section" preference) — out of scope per non-goals.
