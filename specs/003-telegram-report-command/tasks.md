# Tasks: On-Demand Report Command (Telegram Group)

**Input**: Design documents from `/specs/003-telegram-report-command/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/commands.md

**Tests**: No test framework (project convention). Validation = `node --check` per file + offline replay driver in `src/dev/` (pattern of `src/dev/replay-callback.js`) + manual quickstart validation. Task T018 is that replay driver; quickstart steps are the acceptance pass.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g. US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: None needed — no new service, image, or compose change (plan: Project Structure). Skipped on purpose; numbering starts at Foundational.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared report pipeline + schema + Bot API wrapper that every user story builds on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T001 Add additive, idempotent migration in `src/store.js`: `ALTER TABLE reports ADD COLUMN trigger TEXT NOT NULL DEFAULT 'cron'`, guarded by a `PRAGMA table_info(reports)` check (SQLite `ADD COLUMN` has no `IF NOT EXISTS`); extend the `insertReport` query to accept `trigger` (default `'cron'`) per `data-model.md`
- [X] T002 Marker relocation in `src/report.js`: read/write `last-bank-sync.txt` under `DATA_DIR` (shared `/app/data`) instead of the ephemeral per-container `dataDir` arg, with a one-time legacy fallback read of the old path (research.md R2); keep missing/stale marker ⇒ sync needed
- [X] T003 Extract the Telegram delivery tail (current PASOS 6-9 of `src/reporte-diario.js`: `store.insertReport`, `sendReport`, `setReportTelegram`, D6 `expirePreviousPending` + expired-footer `editMessageText`, `answersRetentionSweep`) plus `attachTxIds` prep into a new `src/reporte.js` module exposing `runReport({ trigger, sendEmail: false, ... })` (research.md R4)
- [X] T004 Refactor `src/reporte-diario.js` to delegate to `src/reporte.js`: keep HTML-email construction and the exit contract byte-for-byte (email failure ⇒ `process.exit(1)`), call the shared tail with `trigger: 'cron'`; `node --check` passes and a manual cron run delivers email + Telegram exactly as before (spec SC-004, quickstart step 7)
- [X] T005 [P] Add `setMyCommands(commands)` wrapper in `src/telegram/bot.js` following the existing raw-fetch pattern of the 4 endpoint wrappers (research.md R1, R6)
- [X] T006 [P] Point the listener's Actual cache at `$DATA_DIR/actual-cache` (persistent on the shared volume) so on-demand runs use a warm cache and honor the shared marker (data-model.md)

**Checkpoint**: both channels share one pipeline, one 60-min bank-sync throttle (shared marker), and the `reports.trigger` column exists.

---

## Phase 3: User Story 1 - Refresh the report from the group, especially after categorizing (Priority: P1) 🎯 MVP

**Goal**: a group member sends `/report` and receives the full report (summary + interactive pending items), recomputed from current data; repeated requests are always honored (spec FR-001/FR-002/FR-003/FR-005/FR-006).

**Independent Test**: in the group, send `/report` → report arrives; categorize a pending tx via its buttons; send `/report` again → updated balances, previous buttons expired (quickstart steps 4-5).

- [X] T007 [US1] Add `'message'` to `allowed_updates` in the `getUpdates` call in `src/listener.js` (contract: commands.md §2)
- [X] T008 [US1] Implement command recognition in `src/listener.js` `handleUpdate`: `message.text` trimmed matches `^/report(@[A-Za-z0-9_]+)?\s*$` AND `String(message.chat.id) === TELEGRAM_GROUP_ID`; everything else is ignored with no reply and no info log (spec FR-008/FR-010, contract §3)
- [X] T009 [US1] Implement the report flow in `src/listener.js`: on valid command, immediately `sendMessage('⏳ Generando reporte…')` (research.md R5), then run `compute()` + `attachTxIds` + the shared `runReport` tail with `trigger: 'telegram-command'`, reusing the existing `TELEGRAM_*` env re-reads; on pipeline failure edit the progress message to a one-line Spanish error (no stack traces) (contract §4)
- [X] T010 [US1] Add the in-process re-entrancy guard in `src/listener.js`: `reportInFlight` flag + depth-1 queue; a second valid command while in flight gets a short "ya hay un reporte en curso" reply and one queued re-run; a third is replied but NOT queued (research.md R8, contract §5)
- [X] T011 [US1] Add info-level logging for accepted commands in `src/listener.js`: `chat_id`, `from.id`, `from.username`, outcome tag (`sent` | `empty` | `failed` | `queued-dropped`) (contract §7); `node --check src/listener.js` clean

### Story 1 Checkpoint

`/report` from the group delivers the identical full report the cron delivers, recomputed; the categorize→re-report loop works end-to-end; no cooldown anywhere (spec Assumptions).

---

## Phase 4: User Story 2 - Discover the command without remembering its syntax (Priority: P2)

**Goal**: `/report` appears in the Telegram client's command menu for the group (spec FR-004, success criterion SC-003).

**Independent Test**: in the group, type `/` → menu shows `report` with a description; selecting it delivers the report (quickstart step 2).

- [X] T012 [US2] Implement `ensureCommandMenu()` in `src/listener.js`: register exactly one command `{ command: 'report', description: 'Generar el reporte ahora' }` at boot and re-register whenever `reloadTelegramEnv()` detects a changed `TELEGRAM_BOT_TOKEN` (track `registeredToken`); failure is logged and never blocks the poll loop (research.md R6, contract §1)
- [X] T013 [US2] Verify in the live homelab: `docker compose up -d --force-recreate notifier-listener`, logs show setMyCommands OK, client menu shows `report`, selecting it triggers US1 flow (quickstart step 2 + contract §1)

### Story 2 Checkpoint

the command is discoverable and works from the menu with zero syntax knowledge.

---

## Phase 5: User Story 3 - Full report whenever, including with nothing pending (Priority: P3)

**CHANGED 2026-09-25**: the original "empty acknowledgment instead of a report" was superseded — `/report` now always delivers the full report (spec US3 as amended).

**Goal**: an on-demand report with no pending content still delivers the full summary (category balances) instead of a bare acknowledgment (spec FR-007 as amended, US3).

**Independent Test**: categorize all pending txs, send `/report` → the full summary message is delivered with 0 uncategorized and no interactive items (quickstart step 6 as amended).

- [X] T014 [US3] Implement the always-full-report behavior in `src/listener.js` (via the shared `runReport` result): `skipWhenEmpty: false` for on-demand, so `runReport` delivers the full report even with an empty pending list; the former empty-ack path (editMessageText "todo al día") was removed (spec change 2026-09-25)
- [X] T015 [US3] Verify in the homelab the acknowledgment wording is unambiguous ("the report ran, nothing pending") and that with pending items present the full report is still sent instead (quickstart steps 4 + 6)

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T016 Create `src/dev/replay-report-cmd.js`: offline replay driver feeding synthetic `message` update objects into the exported handler (no `getUpdates`, no network) covering: valid bare command, `@suffix` form, free text (no reply), wrong chat id (no reply), empty path edit, failure edit, depth-1 queue behavior (quickstart step 10, plan: dev replay convention)
- [X] T017 Run `node --check` on `src/listener.js`, `src/reporte.js`, `src/reporte-diario.js`, `src/telegram/bot.js`, `src/report.js`, `src/store.js` (quickstart step 1)
- [X] T018 Execute the full `specs/003-telegram-report-command/quickstart.md` validation pass 1-10 against the homelab, including the cron no-regression check (SC-004) and the 10-request stress with `docker logs notifier_listener` scan for busy errors or orphaned pending rows (SC-005)
- [X] T020 Commit work units per phase with Conventional Commit messages on branch `003-telegram-report-command`; confirm `git status` clean apart from pre-existing unrelated changes

---

## Dependencies & Execution Order

```text
Phase 2 (Foundational)  — T001…T006 (T005, T006 parallelizable with T003/T004)
        │
        ▼
Phase 3 (US1, P1)  — T007…T011 (sequential: T007→T008→T009→T010→T011)
        │
        ├──▶ Phase 4 (US2, P2)  — T012…T013   (parallel-safe with US3: different code paths)
        └──▶ Phase 5 (US3, P3)  — T014…T015
        │
        ▼
Phase 6 (Polish)  — T016…T020 (T016 parallel with T017)
```

Notes:
- US2 and US3 both touch `src/listener.js` but disjoint regions (boot/env-reload hook vs report-flow tail); if implemented by the same session, order US2 → US3 to keep the diff readable.
- T013/T015 are live-homelab verifications of earlier tasks; run them after each story's code task, not after the whole feature.

---

## Implementation Strategy

**MVP = Phase 2 + Phase 3 (US1)**: a member who already knows the command gets the full value (fresh report on demand, categorize→re-report loop) even with no menu discoverability. US2 makes it usable by memory-less humans; US3 (as amended 2026-09-25) guarantees the full report even when nothing is pending.

**Incremental delivery**:
1. Foundation (Phase 2) → quickstart step 7 proves the cron is regression-free *before* any listener work.
2. US1 → quickstart steps 4-5, 8, 9.
3. US2 → quickstart step 2.
4. US3 → quickstart step 6.
5. Polish → full quickstart pass + README + commits.

Each phase ends with an independently verifiable increment against the quickstart; nothing ships on the branch without its quickstart evidence.
