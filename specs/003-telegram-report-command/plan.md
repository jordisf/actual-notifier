# Implementation Plan: On-Demand Report Command (Telegram Group)

**Branch**: `003-telegram-report-command` | **Date**: 2026-09-24 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-telegram-report-command/spec.md`, grounded in the full assessment trail at `.specify/assessments/telegram-on-demand/` (intake → research → problem → concept Option A → decision: go, revised) — the clarify round confirmed the dominant use case is the **categorize → re-report loop**, and the user explicitly **accepted** repeated deliveries, repeated D6 button expiry, and no cooldown/rate limit.

## Summary

Add an on-demand `/report` command, discoverable from the group's Telegram command menu, that re-runs the exact same report pipeline as the 20:00 cron and delivers it into the configured group — recomputing balances so a post-categorization request shows updated figures. The listener (existing long-poll service) gains `message` updates alongside `callback_query`, a command handler, and a `setMyCommands` registration at boot. The report pipeline is extracted from `src/reporte-diario.js` into a shared module parameterized by channel (email on/off), so the cron path keeps its exact behavior and exit contract while the listener path reuses every behavior: `compute()` (current-state balances), `attachTxIds`, `sendReport`, D6 expiry with footer edits, retention sweep, `reports`/`interactions` bookkeeping. No cooldown, no throttle of request frequency (only the existing 60-min bank-sync marker, now **shared** across containers).

## Technical Context

**Language/Version**: JavaScript / Node.js 20 (unchanged; `Dockerfile` base — same image for cron and listener).

**Primary Dependencies**: None new. Raw Telegram Bot API via Node built-in `fetch` (existing convention, `src/telegram/bot.js`); `better-sqlite3` already compiled in the image (transitive of `@actual-app/api`); `@actual-app/api` already a direct dependency.

**Storage**: Shared SQLite `notifier.db` (WAL, `busy_timeout=5000`) on the `./data` volume, already shared by both notifier containers. **Shared bank-sync marker** (new): moves from the ephemeral per-container `/tmp/actual-cache` into `DATA_DIR`, so cron and on-demand runs honor one 60-minute throttle (research.md R2).

**Testing**: `node --check` for syntax (project convention — no test framework) + the existing dev-tool pattern: an offline replay check for the new command handler in `src/dev/` (following `src/dev/replay-callback.js`), plus the manual end-to-end validation in `quickstart.md`.

**Target Platform**: Linux containers (Docker compose, external `actual_net`); the listener service container `notifier_listener`; no new inbound ports (none either service publishes today).

**Project Type**: Single Node repo, multi-service compose — only `src/` changes (+ spec docs); no new services, no new images, no compose changes.

**Performance Goals**: On-demand report lands in the group in well under one minute when the 60-min bank-sync window is warm (the dominant post-categorization case: the user is acting right after the daily run or a previous on-demand sync, so no new sync). A cold on-demand request (first after >60 min) may trigger a bank sync and take several minutes; the listener acks receipt immediately so Telegram never shows a failed/timeout send (research.md R5).

**Constraints**:
- Zero new runtime dependency (repo-wide convention, 001/002 precedent).
- The cron path (`node src/reporte-diario.js` from `crontab.txt`) keeps its exact behavior and exit contract: email is its source of truth, email failure ⇒ exit 1, Telegram failures never affect email (verified in `src/reporte-diario.js` steps 5 & 6-9).
- No cooldown / rate limit on the command (user decision 2026-09-24; a cooldown would block the primary post-categorization use).
- No free-text handling: exactly one command is recognized, everything else in the group is ignored (FR-008).
- Group-only: the handler must ignore messages from chats other than `TELEGRAM_GROUP_ID` (FR-010), consistent with the group being a private homelab group (D1/D7).
- Only ONE bank sync must be "in flight" conceptually — see research.md R2 for the shared-marker resolution; the listener must never fight the cron for a sync.

**Scale/Scope**: 1 new shared report module, 1 small refactor in `reporte-diario.js` (delegation; cron contract preserved), command dispatch + boot-time `setMyCommands` in `listener.js`, 1 `setMyCommands` wrapper in `telegram/bot.js`, 1 marker-path refactor in `report.js`, 1 dev replay script. Single user, single group, localhost homelab, nothing exposed to the internet (D7).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unfilled template — no ratified project constitution exists (same finding as 001 and 002). The clearly evidenced, repo-wide engineering convention is again treated as the binding gate: **no new runtime dependency without strong justification**.

- **Gate: no new npm dependency** — PASS. Only Node built-ins + already-installed `@actual-app/api` / `better-sqlite3`; `setMyCommands` and `message` updates use the existing raw-fetch Bot API client.
- **Gate: does not weaken security posture** — PASS. No new inbound port, no new credential, no internet exposure; the new Bot API surface uses the same token the listener already uses on an outbound long-poll from the homelab. Command recognition additionally requires a chat-id match against the configured group (a new guard, not a removal).
- **Gate: does not change existing behavior** — PASS. The cron path keeps its email exit contract; D6 expiry / claim semantics are reused unchanged; the shared sync marker *strictly reduces* sync frequency (today cron and listener use separate ephemeral caches, so two independent markers exist; after the change one marker in `DATA_DIR` is honored by both).

No violations to justify; Complexity Tracking is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/003-telegram-report-command/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── commands.md      # contract for the /report group command + accepted updates
└── tasks.md             # Phase 2 output (/speckit-tasks command — NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
src/
├── reporte.js              # NEW — extracted report pipeline: async runReport({ sendEmail,
│                           #   telegramChatId, ... }) implementing the steps of
│                           #   reporte-diario.js with the email channel
│                           #   switchable; D6 expiry + retention included
├── reporte-diario.js       # refactored — cron entry: keeps HTML-email construction as
│                           #   today (source of truth, exit contract preserved), then
│                           #   delegates the Telegram steps to reporte.js (research.md R4)
├── listener.js             # + 'message' in allowed_updates; + command dispatch in
│                           #   handleUpdate (chat-id guard for FR-010); + boot-time
│                           #   ensureCommandMenu() and re-registration on token change
├── telegram/
│   └── bot.js              # + setMyCommands(commands) wrapper (raw fetch, same pattern
│                           #   as the 4 existing endpoint wrappers)
├── report.js               # marker path refactor: last-bank-sync marker read/written
│                           #   under DATA_DIR instead of the ephemeral dataDir arg
└── dev/
    └── replay-report-cmd.js   # NEW — offline replay driver for the command handler
                                # (fake message update → assert routing/ack, no network)
```

**Structure Decision**: Everything stays in `src/` inside the existing two notifier containers — no new service, no compose change, no image change (the `./src:/app/src:ro` bind mount picks up new files automatically; the listener's self-detecting `command` is unchanged because `src/listener.js` already exists). The single new coupling point is `src/reporte.js`: the pipeline shared by cron and on-demand, so the two channels cannot drift apart in what a report *contains* (spec FR-002).

## Complexity Tracking

> Not needed — no Constitution violations (see Constitution Check above).
