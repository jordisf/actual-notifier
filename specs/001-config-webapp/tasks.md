---
description: "Task list template for feature implementation"
---

# Tasks: Web Configuration Panel for actual-notifier

**Input**: Design documents from `/specs/001-config-webapp/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/routes.md, quickstart.md (all present)

**Tests**: Not explicitly requested in spec.md and no TDD approach was requested — no dedicated test tasks are generated. `research.md`'s choice of Node's built-in `node --test` is available if tests are added later; T027 covers manual validation via `quickstart.md`.

**Organization**: Tasks are grouped by user story (spec.md P1–P4) to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- File paths are exact, per plan.md's Project Structure

## Path Conventions

Single project (per plan.md). New code lives under `src/panel/` (own container, `Dockerfile.panel`); a small number of existing files (`src/listener.js`, `entrypoint.sh`, `docker-compose.yml`) are modified in place.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project/container scaffolding for the panel

- [X] T001 Create panel project skeleton: `src/panel/server.js`, `src/panel/main.js`, `src/panel/config-store.js`, `src/panel/auth.js`, `src/panel/validate.js`, `src/panel/routes/` (empty dir for per-section route modules), `src/panel/views/` (empty dir for HTML templates), and `Dockerfile.panel` (node:20-slim base, `npm install --omit=dev`, copies `src/store.js`, `src/log.js`, `src/actual.js`, `src/telegram/bot.js`, `src/panel/`, `CMD ["node","src/panel/main.js"]`) — zero new npm dependencies (plan.md Constitution Check)
- [X] T002 [P] Add a `config-panel` service to `docker-compose.yml`: build from `Dockerfile.panel`, join `actual_net`, mount `./data:/app/data`, `./.env:/app/.env:rw`, `./crontab.txt:/app/crontab.txt:rw`; publish no host port beyond the operator's LAN/VPN-reachable interface (FR-005); leave `notifier-cron`'s existing `.env`/`crontab.txt` mounts as `:ro`, unchanged

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 [P] Implement `src/panel/config-store.js`: read/write individual `.env` key-value pairs (preserving unrelated lines/comments) and thin read/write wrappers over `src/store.js`'s existing `kv` table (data-model.md)
- [X] T004 [P] Implement `src/panel/auth.js`: `hashPassword()`/`verifyPassword()` via `crypto.scrypt` with a random salt, encoded `salt:hash` (data-model.md Panel Credentials — "never stored or logged in plain form"); `signSession()`/`verifySession()` via `crypto.createHmac` over `sessionId + expiryEpoch`, with a `panel_session_secret` generated once and persisted to `kv` on first boot
- [X] T005 Implement `src/panel/server.js`: `http.createServer` + a small path/method router + cookie parsing + a session-guard wrapper that redirects unauthenticated/expired-session requests to `/login` (contracts/routes.md: "All Session-gated routes redirect to /login when the session cookie is missing, invalid, or expired") — depends on T004
- [X] T006 Wire `src/panel/main.js`: opens the shared SQLite store (`src/store.js`), starts the HTTP server from T005, logs startup via `src/log.js` with `service: 'panel'` — depends on T005

**Checkpoint**: Foundation ready - user story implementation can now begin

---

## Phase 3: User Story 1 - Secure access and first-time login (Priority: P1) 🎯 MVP

**Goal**: Operator can log in (including a one-time no-password bootstrap that immediately forces setting a new password) and change credentials later; every other page is unreachable without a valid session.

**Independent Test**: Deploy with no `panel_password_hash` set, confirm the first login succeeds without a password and forces password creation, then confirm a second login requires the new password (spec.md US1).

- [X] T007 [P] [US1] Implement `GET /login` and `POST /login` in `src/panel/routes/login.js`: render the bootstrap notice (no password field) when `panel_password_hash` (kv, via T003) is empty, otherwise render the normal form; on `POST`, verify credentials or accept the one-time bootstrap login, issue a signed session cookie (T004) on success, and enforce lockout using `panel_login_failures`/`panel_lockout_until` kv rows (FR-003, FR-015; data-model.md)
- [X] T008 [US1] Implement `GET /set-password`, `POST /set-password`, and `POST /logout` in `src/panel/routes/login.js`: `/set-password` is reachable mid-bootstrap-session and persists a new `panel_username`/`panel_password_hash` via `config-store.js` (T003) before any other route becomes usable (FR-003, FR-004); `/logout` clears the session cookie — depends on T007
- [X] T009 [P] [US1] Implement `GET /` dashboard shell in `src/panel/routes/dashboard.js` + `src/panel/views/dashboard.html`: static links to Telegram/SMTP/Actual/Recipients/Schedule sections (placeholders, wired progressively by later stories)
- [X] T010 [US1] Add structured logging for login success, login failure, and lockout events in `src/panel/routes/login.js` (`src/log.js`, `service: 'panel'`) — depends on T007, T008

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently — a locked panel with a working bootstrap flow, login/logout, and a dashboard shell.

---

## Phase 4: User Story 2 - Configure Telegram settings without a restart (Priority: P2)

**Goal**: Operator views/edits Telegram bot settings from the panel, validated before saving, applied to the running listener without a restart.

**Independent Test**: Change the Telegram bot token or category allow-list through the panel and confirm the listener behaves according to the new value without anyone running a restart command (spec.md US2).

- [X] T011 [P] [US2] Implement `GET /telegram` in `src/panel/routes/telegram.js` + `src/panel/views/telegram.html`: render current `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `TELEGRAM_CATEGORIES`, `TELEGRAM_POLL_TIMEOUT` from `config-store.js` (T003), with the bot token masked by default (FR-006, FR-012)
- [X] T012 [US2] Implement `POST /telegram` in `src/panel/routes/telegram.js`: validate the new bot token/group id by calling `src/telegram/bot.js` before persisting; on validation failure, re-render the form with the reported error and do not apply the change (FR-007, FR-008) — depends on T011
- [X] T013 [US2] Implement `POST /reveal/:field` in `src/panel/routes/reveal.js` (first use: the Telegram bot token), returning the unmasked value only for this explicit request (FR-012)
- [X] T014 [US2] Modify `src/listener.js`'s poll loop to re-read `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `TELEGRAM_CATEGORIES`, and `TELEGRAM_POLL_TIMEOUT` from `.env` at the top of each iteration instead of once at boot (currently `dotenv.config()` without `override`, per research.md), so panel-driven changes apply within one poll cycle with no restart (FR-007)
- [X] T015 [US2] Register the Telegram section link in `src/panel/routes/dashboard.js` — depends on T009, T011

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently.

---

## Phase 5: User Story 3 - Configure SMTP, Actual Budget connection, and recipients (Priority: P3)

**Goal**: Operator views/edits SMTP settings, the Actual Budget connection, and the notification recipient list from the panel, each validated before saving; secrets masked by default.

**Independent Test**: Change the SMTP host/credentials through the panel, trigger a test send, and confirm the next report email uses the new settings without a restart (spec.md US3).

- [X] T016 [P] [US3] Implement `GET /smtp`, `POST /smtp/test`, and `POST /smtp` in `src/panel/routes/smtp.js` + `src/panel/views/smtp.html`: test-send via `nodemailer` (reusing the construction pattern from `src/reporte-diario.js`) before persisting; `SMTP_PASS` masked by default (FR-009, FR-012)
- [X] T017 [P] [US3] Implement `GET /actual` and `POST /actual` in `src/panel/routes/actual.js` + `src/panel/views/actual.html`: validate via `src/actual.js`'s existing `open()`/`close()` handshake before persisting; `ACTUAL_PASSWORD` masked by default (FR-010, FR-012)
- [X] T018 [P] [US3] Implement `GET /recipients` and `POST /recipients` in `src/panel/routes/recipients.js` + `src/panel/views/recipients.html`: require at least one syntactically valid email address in `NOTIFICATION_EMAIL` before persisting (FR-011)
- [X] T019 [US3] Extend `POST /reveal/:field` (T013) to also cover the SMTP password and Actual password fields (FR-012) — depends on T013, T016, T017
- [X] T020 [US3] Register the SMTP/Actual/Recipients section links in `src/panel/routes/dashboard.js` — depends on T009, T016, T017, T018

**Checkpoint**: All of User Stories 1, 2, and 3 should now be independently functional.

---

## Phase 6: User Story 4 - Configure the report schedule with a simplified input (Priority: P4)

**Goal**: Operator sets the report schedule using one of three simplified modes (every X minutes / every X hours / once daily at HH:MM) without needing cron syntax; applied without a restart.

**Independent Test**: Pick each of the three schedule modes in the panel and confirm the report runs at the expected cadence without a restart (spec.md US4).

- [ ] T021 [US4] Add the schedule mtime-watch loop to `entrypoint.sh`: poll `crontab.txt`'s mtime on an interval and re-run `crontab /app/crontab.txt` when it changes, so `notifier-cron` never needs a restart for schedule edits (research.md)
- [ ] T022 [P] [US4] Implement `GET /schedule` in `src/panel/routes/schedule.js` + `src/panel/views/schedule.html`: parse the current single cron line in `crontab.txt` back into one of exactly three modes — `every-minutes`, `every-hours`, `daily-at` — for display (data-model.md Report Schedule; FR-013)
- [ ] T023 [US4] Implement `POST /schedule`: translate the selected mode + its single parameter (`minutes`, `hours`, or `time` HH:MM) into exactly one valid cron line and write it to the shared `crontab.txt` (FR-013, FR-014) — depends on T021, T022
- [ ] T024 [US4] Register the Schedule section link in `src/panel/routes/dashboard.js` — depends on T009, T022

**Checkpoint**: All four user stories should now be independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T025 [P] Security hardening pass across `src/panel/`: confirm no secret (password, bot token, session secret) is ever written to a log line (`src/log.js` calls) or included in any HTTP response outside the explicit `POST /reveal/:field` action (FR-002, FR-012)
- [ ] T026 [P] Update `README.md` and `DEPLOY.md`: document the new `config-panel` service, its LAN/VPN-only exposure requirement, and the first-boot bootstrap-password flow
- [ ] T027 Run `quickstart.md` validation end-to-end (all 5 scenarios: bootstrap login, Telegram live-reload, SMTP test-before-save, schedule live-reload, LAN/VPN-only reachability)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational only
- **User Story 2 (Phase 4)**: Depends on Foundational; assumes US1's session/login exists to reach its pages, but its own logic (Telegram validation + listener hot-reload) is independently testable per spec.md
- **User Story 3 (Phase 5)**: Same relationship to US1 as US2; independent of US2
- **User Story 4 (Phase 6)**: Same relationship to US1 as US2/US3; independent of US2/US3
- **Polish (Phase 7)**: Depends on all four user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: No dependency on other stories — the MVP slice
- **User Story 2 (P2)**: Reuses US1's session guard and dashboard shell to be reachable, but its Telegram validation/hot-reload logic is independently testable
- **User Story 3 (P3)**: Same relationship — independent of US2
- **User Story 4 (P4)**: Same relationship — independent of US2/US3

### Within Each User Story

- Route read (`GET`) before route write (`POST`) where the same file is involved
- Reveal/validation wiring after the base route exists
- Dashboard link registration last, once the section's routes exist

### Parallel Opportunities

- T003 and T004 (Foundational, different files) run in parallel
- T007 and T009 (US1, different files) run in parallel
- T011 (US2), T016/T017/T018 (US3), and T022 (US4) each touch distinct route files and can run in parallel with each other once Foundational + US1 are done
- T025 and T026 (Polish, different files) run in parallel

---

## Parallel Example: User Story 3

```bash
# Once Foundational + US1 are done, these three route modules are fully independent files:
Task: "Implement GET /smtp, POST /smtp/test, POST /smtp in src/panel/routes/smtp.js + src/panel/views/smtp.html"
Task: "Implement GET /actual, POST /actual in src/panel/routes/actual.js + src/panel/views/actual.html"
Task: "Implement GET /recipients, POST /recipients in src/panel/routes/recipients.js + src/panel/views/recipients.html"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: run quickstart.md Scenario 1 independently
5. Deploy/demo if ready — a locked, working panel with no configuration screens yet is already a safe increment

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add User Story 1 → validate (Scenario 1) → deploy/demo (MVP!)
3. Add User Story 2 → validate (Scenario 2) → deploy/demo
4. Add User Story 3 → validate (Scenario 3) → deploy/demo
5. Add User Story 4 → validate (Scenario 4) → deploy/demo
6. Polish phase → validate (Scenario 5 + full quickstart) → final deploy/demo

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- No dedicated test tasks were generated (not requested in spec.md); `quickstart.md` (T027) is the manual verification gate for each story
- Commit after each task or logical group, per this repo's existing convention of small scoped commits
- Stop at any checkpoint to validate a story independently before moving on
- Every secret-handling task (T004, T007, T011, T016, T017, T019, T025) must be double-checked against FR-002/FR-012 before being considered done
