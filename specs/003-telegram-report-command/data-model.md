# Data Model: On-Demand Report Command (Telegram Group)

**Feature**: `003-telegram-report-command` | **Date**: 2026-09-24

This feature **adds no new tables**. It reuses the existing store (`src/store.js`, `$DATA_DIR/notifier.db`) and adds one additive column plus one shared filesystem artifact.

## Schema changes (SQLite `notifier.db`)

### `reports` — +1 column (additive migration)

| Column | Type | Constraint | Purpose |
|--------|------|-----------|---------|
| `trigger` | `TEXT` | `NOT NULL DEFAULT 'cron'` | Discriminates delivery origin: `cron` (scheduled) vs `telegram-command` (on-demand `/report`). Existing rows default to `cron`; no backfill needed. |

Migration: `ALTER TABLE reports ADD COLUMN trigger TEXT NOT NULL DEFAULT 'cron'`, executed idempotently the same way the existing DDL is (the store opens with `CREATE … IF NOT EXISTS`; the ALTER must be guarded — check `PRAGMA table_info(reports)` first, since `ADD COLUMN` has no `IF NOT EXISTS`).

### `interactions` — unchanged

On-demand deliveries insert `interactions` rows exactly as the cron does (same `action_kind='categorize'`, same `report_id` FK to the new `reports` row, same status machine `pending → answered | expired`). The D6 rule ("pending rows of older reports expire when a newer report is delivered") applies **identically** to on-demand reports — this is accepted behavior per the assessment (`expirePreviousPending(db, beforeReportId)` is called with the new report id on every delivery, cron or on-demand alike).

### `kv` — unchanged

`poll_offset` keeps its meaning. No new kv keys are introduced: the in-process re-entrancy guard (research.md R8) is process-local state in the listener, not shared state — it does not need to survive a listener restart (a restart implies no report is in flight).

## Shared filesystem artifact

### `$DATA_DIR/last-bank-sync.txt` — relocated (from ephemeral to shared)

| Property | Before | After |
|----------|--------|-------|
| Path | `${dataDir}/last-bank-sync.txt` with `dataDir=/tmp/actual-cache` (per-container) | `$DATA_DIR/last-bank-sync.txt` (`/app/data`, shared volume `./data`) |
| Content | epoch millis of last completed bank sync | unchanged |
| Writers | `report.js` (via `actual.open('/tmp/actual-cache')` callers) | unchanged writer, new path |
| Readers | `report.js` (60-min throttle check) | unchanged reader, new path + one-time legacy fallback read of the old path |

Effect: cron and listener honor **one** 60-minute bank-sync window (research.md R2). The reader treats a stale/missing marker as "sync needed", identical to today.

The listener's Actual cache directory also moves to `$DATA_DIR/actual-cache` (persistent on the shared volume) so on-demand runs operate on a warm cache instead of re-downloading in a fresh per-container `/tmp`. The cron keeps `/tmp/actual-cache` or moves to a distinct subdir — either way the two caches are **not** shared with each other (each process maintains its own `@actual-app/api` state); only the marker is shared.

## State model — in-process (listener)

| State | Scope | Lifecycle |
|-------|-------|-----------|
| `reportInFlight` (bool) | listener process | set when a `/report` pipeline starts, cleared when it finishes; a depth-1 queue holds at most one extra pending request (research.md R8) |
| `registeredToken` (string) | listener process | last `TELEGRAM_BOT_TOKEN` for which `setMyCommands` succeeded; boot + token-change trigger re-registration (research.md R6) |

## Invariant summary (what this feature preserves)

1. Every delivery — cron or on-demand — inserts one `reports` row before sending Telegram, and D6 expiry runs with that row's id.
2. `claimAnswer`'s guarded UPDATE remains the single source of truth for first-answer-wins; on-demand delivery never touches claim logic.
3. The `reports.run_at` `UNIQUE` constraint still holds because runs (cron: daily; on-demand: human-paced) never collide in timestamp format.
