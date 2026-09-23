# Tasks: Panel basic layout

**Input**: Design documents from `/specs/002-panel-basic-layout/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: No test tasks — the spec does not request a test suite (project has no test framework; validation is via `node --check` + the manual matrix in `quickstart.md`). One **optional** dev check script is included as a Polish task (marked optional).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g. US1, US2)
- Include exact file paths in descriptions

## Path Conventions

Single project (per plan.md): everything under `src/panel/` — no repo-root changes, no Dockerfile/compose/package.json changes.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Baseline confirmation before touching the panel — nothing to initialize (the feature extends the existing 001 panel), only a safety checkpoint.

- [X] T001 [P] Baseline snapshot (required by I-1/I-2)
- [X] T002 [P] Create `src/panel/static/panel.css` (single hand-written file, ≈2–4KB, research R5): system font stack; `max-width: 900px` centered content column for section pages; `h1` consistent sizing; visible-bordered form controls (inputs, buttons, checkboxes) with padding; `.card` (bordered padded form container); `.error` (distinct warning color band, readable on white); `.actions` (submit-button row); `.nav` horizontal link bar with `.nav a.active` visual state + underline; `.auth` centered narrow column (`max-width: 32rem`, vertically/horizontally centered); a small `@media (max-width: 720px)` rule that stacks `.nav a` vertically (FR-009 tolerance only); NO external fonts/images/CDNs
- [X] T003 [P] Create `src/panel/layout.js` exporting two pure functions (research R2; contracts/routes.md contract 2): `renderPage({ title, active, body })` — full `<!doctype html>` document with `<link rel="stylesheet" href="/static/panel.css">` in `<head>`, `<title>` = `${title} — actual-notifier panel`, `<header>` with the panel name, `<nav class="nav">` with exactly 6 links in fixed order (Dashboard `/`, Telegram `/telegram`, SMTP `/smtp`, Actual `/actual`, Recipients `/recipients`, Schedule `/schedule`), the one matching `active` (`dashboard|telegram|smtp|actual|recipients|schedule`) carrying `aria-current="page"` and `class="active"`, `<main>` wrapping `body`, and a `<footer>` with the "Change password" link (`/set-password`) and the logout form (`<form method="post" action="/logout">`, submit "Log out"); `renderAuthPage({ title, body })` — same document + `<link>` + centered `<main class="auth">`, NO `<nav>`, no logout form; both must `escapeHtml`-sanitize `title` (reuse the same 5-char map as existing route files) and pass `body` through verbatim (routes have already substituted and escaped their data)
- [X] T004 [US1] Add a session-guarded `GET /static/panel.css` route (research R1, contracts/routes.md contract 1): handler wrapped in the existing `requireSession` wrapper; on success respond `200` with `Content-Type: text/css; charset=utf-8` and `Cache-Control: no-store`, body = `fs.readFileSync(path.join(__dirname, 'static', 'panel.css'))`; keep the router array-based pattern (no new middleware layer); do NOT change any existing route, the session cookie logic, or the 404/500 handlers
- [X] T005 Syntax gate: run `node --check` (project convention, per DEPLOY.md) on every file touched so far — `src/panel/layout.js`, `src/panel/server.js` — exit 0 with no output

**Checkpoint**: Foundation ready — stylesheet served, shell functions exist, `node --check` clean. Pages are still unstyled (no route uses the new helpers yet), so this phase alone is invisible to the user.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The two shared primitives every user story depends on — the stylesheet and the layout helper. MUST complete before any story phase.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T001 [P] Baseline snapshot (required by I-1/I-2)
- [X] T002 Create the stylesheet `src/panel/static/panel.css` (single hand-written file, ≈2–4KB, research R5): system font stack; `max-width: 900px` centered content column for section pages; `h1` consistent sizing; visible-bordered form controls (inputs, buttons, checkboxes) with padding; `.card` (bordered padded form container); `.error` (distinct warning color band, readable on white); `.actions` (submit-button row); `.nav` horizontal link bar with `.nav a.active` visual state + underline; `.auth` centered narrow column (`max-width: 32rem`, vertically/horizontally centered); a small `@media (max-width: 720px)` rule that stacks `.nav a` vertically (FR-009 tolerance only); NO external fonts/images/CDNs
- [X] T003 Create `src/panel/layout.js` exporting two pure functions (research R2; contracts/routes.md contract 2): `renderPage({ title, active, body })` — full `<!doctype html>` document with `<link rel="stylesheet" href="/static/panel.css">` in `<head>`, `<title>` = `${title} — actual-notifier panel`, `<header>` with the panel name, `<nav class="nav">` with exactly 6 links in fixed order (Dashboard `/`, Telegram `/telegram`, SMTP `/smtp`, Actual `/actual`, Recipients `/recipients`, Schedule `/schedule`), the one matching `active` (`dashboard|telegram|smtp|actual|recipients|schedule`) carrying `aria-current="page"` and `class="active"`, `<main>` wrapping `body`, and a `<footer>` with the "Change password" link (`/set-password`) and the logout form (`<form method="post" action="/logout">`, submit "Log out"); `renderAuthPage({ title, body })` — same document + `<link>` + centered `<main class="auth">`, NO `<nav>`, no logout form; both must `escapeHtml`-sanitize `title` (reuse the same 5-char map as existing route files) and pass `body` through verbatim (routes have already substituted and escaped their data)
- [X] T004 Register `GET /static/panel.css` in `src/panel/server.js` (research R1, contracts/routes.md contract 1): handler wrapped in the existing `requireSession` wrapper; on success respond `200` with `Content-Type: text/css; charset=utf-8` and `Cache-Control: no-store`, body = `fs.readFileSync(path.join(__dirname, 'static', 'panel.css'))`; keep the router array-based pattern (no new middleware layer); do NOT change any existing route, the session cookie logic, or the 404/500 handlers
- [X] T005 Syntax gate: run `node --check` (project convention, per DEPLOY.md) on every file touched so far — `src/panel/layout.js`, `src/panel/server.js` — exit 0 with no output

**Checkpoint**: Foundation ready — stylesheet served, shell functions exist, `node --check` clean. Pages are still unstyled (no route uses the new helpers yet), so this phase alone is invisible to the user.

---

## Phase 3: User Story 1 - El panel se lee de un vistazo (Priority: P1) 🎯 MVP

**Goal**: All 8 pages render the shared visual (CSS + shell) so titles, forms, and errors are distinguishable and the pages read as one product (FR-001, FR-002, FR-003, FR-008; SC-001, SC-002).

**Independent Test**: Visit all 8 pages (6 sections + login + set-password) and confirm each has the `<link>` to `/static/panel.css`, styled h1/form/buttons, and errors shown highlighted in their existing position — with nav already present as a bonus (US2's acceptance is partially pre-empted, which is acceptable: the shell is one unit).

### Implementation for User Story 1

- [X] T006 [P] [US1] Convert dashboard...
- [X] T007 [P] [US1] Convert telegram...
- [X] T008 [P] [US1] Convert smtp...
- [X] T009 [P] [US1] Convert actual...
- [X] T010 [P] [US1] Convert recipients...
- [X] T011 [P] [US1] Convert schedule...
- [X] T012 [P] [US1] Convert login page...
- [X] T013 [P] [US1] Convert set-password page...
- [X] T014 [US1] Verify each converted fragment...
- [X] T015 [US1] Syntax gate (node --check) all modified files...

**Checkpoint**: `docker compose build config-panel && docker compose up -d config-panel`, then quickstart Scenario 1 + 2 (CSS served & gated; all pages styled, shared header/nav/footer present) — User Story 1 is fully functional and testable.

---

## Phase 4: User Story 2 - Navegación única entre secciones (Priority: P2)

**Goal**: The shared nav lets the operator reach any of the 6 sections in one click, with the current section highlighted (FR-005, FR-006, FR-007; SC-003).

**Independent Test**: From any section (e.g. `/smtp`) click a different nav link (e.g. "Schedule") — one click, no dashboard bounce; the destination link is the highlighted one. The "Change password" link and "Log out" button are present in the footer of every authenticated page.

### Implementation for User Story 2

- [X] T016 [US2] Verify/finish nav active-state correctness across the 6 sections in `src/panel/layout.js`: each of the 6 routes passes its own section id and exactly one `<a>` carries `aria-current="page"` + `class="active"` (contracts/routes.md contract 2); if T003/T007/T013 already left this correct, confirm by inspecting rendered HTML of all 6 pages and close the task — otherwise fix the mismapping
- [X] T017 [US2] Footer consistency pass: confirm the shared footer (T003) renders "Change password" → `/set-password` and the logout form on all 6 authenticated pages and on NONE of the auth pages (FR-007, FR-008) — fix any of the 8 pages where the footer is missing or duplicated (e.g. a leftover local logout form on dashboard from T006)
- [X] T018 [US2] Run quickstart Scenario 2 + Scenario 6 (nav one-click between sections; session-expiry redirect still 302 → /login; bootstrap redirect to /set-password) and Scenario 7 (narrow viewport doesn't break) — record pass/fail per scenario

**Checkpoint**: User Stories 1 AND 2 work independently — the panel is fully maquetado with working navigation.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: No-regression proof and loose ends (FR-004, FR-010, SC-004, SC-005 — the "nothing changed" contract).

- [X] T019 Run the full quickstart matrix end-to-end: Scenarios 1–8 (CSS gated, shell+nav on all 6, login/set-password no-nav, form valid/invalid POST on recipients + ≥2 other sections with `.env`/`crontab.txt` written exactly as before, reveal flow on telegram/smtp/actual with same element ids, session-expiry redirect, narrow viewport, final 8-page click-through) — every scenario PASS
- [X] T020 Diff review for FR-004: for each of the 8 pages, confirm against the pre-change baseline (T001) that URLs, field `name`s, POST actions, status codes, and error message texts are byte-identical in behavior (allowed diffs: wrapper HTML, the `class` additions from research R3, moved footer links, removed "Back to dashboard" lines)
- [X] T021 [P] Optional — add `src/dev/check-layout.js` (the quickstart's optional unit check: asserts CSS link present, active marker exactly once, auth page has no nav) and run it per quickstart "Optional" section; if shipping dev scripts into the image is undesired, run it from the host instead — this task is explicitly optional per the spec's testing assumption
- [X] T022 `git commit` the feature as work units per the existing repo convention (conventional commits, no AI attribution): suggested split — (1) `feat(panel): add shared stylesheet and layout shell` (T002–T005), (2) `feat(panel): apply layout to authenticated section views` (T006–T013), (3) `feat(panel): apply layout to login/set-password` (T014), (4) `docs(specs): 002-panel-basic-layout artifacts` if specs are committed in this repo's convention — confirm against `git log` before committing
- [X] T023 Update `DEPLOY.md` only if the deploy steps changed (they should NOT have — same image build, same service); if a before/after screenshot pair is kept anywhere in the repo, reference it from the spec's quickstart notes; otherwise no doc changes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: no dependencies — starts immediately
- **Foundational (Phase 2)**: depends on T001 (baseline confirmed) — blocks all user stories
- **User Story 1 (Phase 3)**: depends on Phase 2 (T002–T005)
- **User Story 2 (Phase 4)**: depends on Phase 3 (the nav is part of the US1 shell; US2 is the verification/completion pass of that nav) — NOT fully parallelizable with US1, by design: the shell is one unit and splitting "styled, no nav" from "styled, with nav" would re-touch every route twice
- **Polish (Phase 5)**: depends on both stories

### User Story Dependencies

- **US1 (P1)**: after Foundational. Delivers standalone value (readable pages, even though the nav ships with the shell).
- **US2 (P2)**: after US1. Mostly a verification/completion pass (T016–T018) because the nav is baked into the shared shell that US1 consumes — the dependency is real and documented here rather than forced into a false parallel.

### Within Each User Story

- Foundation (CSS + helper + route) before any view conversion
- Fragment conversion before its route wrap (a route wrapping a still-full-document fragment would emit nested `<html>`)
- Syntax gate last in each phase, before claiming the checkpoint

### Parallel Opportunities

- T007 after T006 (sequential pair: fragment then wrap)
- **T008–T012 [P]**: the five non-dashboard view conversions are independent of each other and of T007 — safe to run in parallel (different files)
- T013 depends on T006–T012 (it touches 5 route files whose fragments must exist first)
- T014 (login.js) is independent of T007/T013 — could parallel with the T006→T013 chain if staffed
- T021 [P] is independent of T019/T020

---

## Parallel Example: User Story 1

```text
After T007 finishes (dashboard reference pattern works):

# Launch the five view conversions together:
Task: T008 convert views/telegram.html (keep reveal script verbatim)
Task: T009 convert views/smtp.html
Task: T010 convert views/actual.html
Task: T011 convert views/recipients.html
Task: T012 convert views/schedule.html

# Then the single wrapping pass + login:
Task: T013 wrap the 5 route modules in renderPage (one mechanical pass)
Task: T014 (or earlier, in parallel) switch login.js to renderAuthPage
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 (T001 baseline) → Phase 2 (T002–T005 foundation) → Phase 3 (T006–T015)
2. **STOP and VALIDATE**: quickstart Scenarios 1–4 + 7. The panel is visually complete even if US2's nav pass is considered "pending" — in practice the nav is already in the shell, so US2 becomes a verification checkpoint, not a re-build.

### Full Delivery

3. Phase 4 (T016–T018) — nav active-state and footer verification passes
4. Phase 5 (T019–T023) — full quickstart matrix, FR-004 diff review, commits
5. **Final validation**: all 8 quickstart scenarios green; `node --check` clean across all touched files; one work-unit commit per suggested split in T022.

### Slices if a boundary is needed

The natural PR-slice boundary is after T015 (US1 complete, checkpoint green): slice 1 = foundation + US1 (9 files touched), slice 2 = US2 verification + polish (likely 0–2 files). Total feature footprint: 2 new files + 9 modified files under `src/panel/`, well inside a single-PR budget.
