# Implementation Plan: Panel basic layout

**Branch**: `002-panel-basic-layout` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-panel-basic-layout/spec.md`, grounded in the full assessment trail at `.specify/assessments/panel-basic-layout/` (intake → problem → concept Option B → decision: go) and the existing panel implementation from `001-config-webapp`.

## Summary

Apply a basic, functional visual layout to all 8 pages of the config panel: one hand-written `panel.css` (zero dependencies) plus a minimal shared `layout.js` helper that wraps each page in a common shell (header, 6-section nav with active highlight, content area). The 6 authenticated views move from standalone HTML documents to body fragments rendered through the helper; the 2 auth pages (login, set-password, inline in `routes/login.js`) keep the centered simple layout but share the CSS. No functional change of any kind: URLs, forms, fields, validations, session behavior, and the reveal flow are untouched (FR-004, SC-005). Everything ships inside the existing `COPY src/panel/` in `Dockerfile.panel` — no Dockerfile, compose, or package.json change.

## Technical Context

**Language/Version**: JavaScript / Node.js 20 + hand-written CSS (unchanged from the current panel — `Dockerfile.panel` base is `node:20-slim`).

**Primary Dependencies**: None new. Reuses only Node built-ins already in use (`fs` for reading view templates and the new CSS file, `path`). The panel's existing "zero new npm dependencies" precedent (001 plan, `src/telegram/bot.js` P9) is preserved — CSS is a static file served by the existing hand-rolled router, not a framework.

**Storage**: Unchanged. No new kv keys, no new table, no `.env`/`crontab.txt` write paths touched. The feature is purely presentational.

**Testing**: `node --check` for syntax (already the project's smoke-test convention per `DEPLOY.md`) plus the manual validation pass in `quickstart.md` — the project has no test framework and the change is DOM/CSS, where `node --test` can meaningfully assert only the layout helper's output (nav active marking, CSS link presence), which is done as a small self-contained check inside `quickstart.md`, not a new harness.

**Target Platform**: Linux container (Docker), `config-panel` service, same as today — reached at `127.0.0.1:8080` by default (FR-005 of 001 unchanged).

**Project Type**: Single small internal web service (server-rendered HTML, no client-side framework), third container — only the `src/panel/` subtree changes.

**Performance Goals**: Not demanding — one operator, localhost-bound. The CSS must be small (target: a single file of low size, order of a few KB) so page weight barely changes.

**Constraints**:
- Zero new runtime dependency; no CSS framework, no build step, no CDN (spec Assumptions, inherited from 001's precedent).
- No template engine: the layout helper layers on top of the existing `{{var}}` string-substitution pattern (spec Assumptions).
- `Dockerfile.panel` must not need changes: the CSS and helper live under `src/panel/` and travel with the existing `COPY src/panel/ ./src/panel/` (verified: `.dockerignore` excludes only `.env*`, `node_modules/`, `.git/`, `*.md` — confirmed during decision).
- No new UI JavaScript: the existing per-page reveal `<script>` stays (FR-010).
- `notifier-cron` and `notifier-listener` containers, their mounts, and every non-panel behavior are untouched.

**Scale/Scope**: 8 pages (6 views + login + set-password), 1 new CSS file, 1 new helper module, 1 new static route, 9 route modules touched mostly around their existing `render()` functions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unfilled template — no ratified project constitution exists (same finding as 001's plan). The one clearly evidenced, repo-wide engineering convention is again treated as the binding gate: **no new runtime dependency without strong justification** (001's "zero new runtime deps" precedent, 3 total dependencies across the project).

- **Gate: no new npm dependency** — PASS. CSS is a static file; the layout helper is plain Node + `fs`. No `package.json` change.
- **Gate: does not weaken existing security posture** — PASS. The only new HTTP surface is `GET /static/panel.css`, a non-sensitive static asset. Session gating, lockout, and secrets masking are untouched. (Whether the static route is gated by `requireSession` is decided in research.md — conclusion: gated, so the panel stays invisible to unauthenticated probing.)
- **Gate: does not change applied configuration behavior** — PASS. No write path to `.env`/`crontab.txt`/DB is touched.

No violations to justify; Complexity Tracking is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/002-panel-basic-layout/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── routes.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
└── panel/                    # existing — ONLY this subtree changes
    ├── layout.js             # NEW — shared shell: renderLayout({title, active, body})
    │                          #       emits <html> with <link> to /static/panel.css,
    │                          #       header + 6-link nav (active highlight), content area
    ├── static/
    │   └── panel.css         # NEW — single hand-written stylesheet (all 8 pages)
    ├── server.js             # +1 route: GET /static/panel.css → text/css (session-gated)
    ├── views/
    │   ├── dashboard.html    # converted: full document → content fragment + classes
    │   ├── telegram.html     # converted: fragment (reveal <script> kept verbatim)
    │   ├── smtp.html         # converted: fragment
    │   ├── actual.html       # converted: fragment
    │   ├── recipients.html   # converted: fragment
    │   └── schedule.html     # converted: fragment
    └── routes/
        ├── dashboard.js      # render() wraps fragment in layout('/', active='dashboard')
        ├── telegram.js       # render() wraps fragment, active='telegram'
        ├── smtp.js           # render() wraps fragment, active='smtp'
        ├── actual.js         # render() wraps fragment, active='actual'
        ├── recipients.js     # render() wraps fragment, active='recipients'
        ├── schedule.js       # render() wraps fragment, active='schedule'
        └── login.js          # inline layout() helper → shared helper, centered variant
                              # (no nav) for login + set-password
```

**Structure Decision**: Everything stays inside the existing `src/panel/` subtree — no new directories at repo root, no frontend/backend split (the panel is server-rendered HTML in one Node process, per 001). One new module (`layout.js`) is the minimal coupling point the concept's Option B anticipated; it is a pure string-composition helper with no state, so it cannot disturb the per-route `{{var}}` substitution flow. The CSS lives in a `static/` subfolder so `Dockerfile.panel`'s existing `COPY src/panel/ ./src/panel/` picks it up unchanged.

## Complexity Tracking

> Not needed — no Constitution violations (see Constitution Check above).
