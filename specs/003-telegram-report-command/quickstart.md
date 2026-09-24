# Quickstart: On-Demand Report Command (Telegram Group)

**Feature**: `003-telegram-report-command`
**Goal**: a member of the configured Telegram group types `/report` and receives the same report + interactive categorization the 20:00 cron sends, recalculated from current data.
**Testing strategy**: no test framework (project convention) → `node --check` + a **manual validation script against the homelab** (real bot, real group, real Actual stack) + the existing `src/dev/` replay-driver pattern for offline iteration.

## Prerequisites

1. Actual Budget stack running in Docker (`docker compose -f actual-budget/docker-compose.yml ps` — `actual-server` up).
2. `.env` filled: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID` (the group the cron already posts to), `ACTUAL_URL`, `ACTUAL_PASSWORD`, and SMTP keys (cron path only).
3. You are a member of that group and it is where the daily report already lands.
4. At least one uncategorized transaction in the current month (to exercise the interactive part) — create it in the Actual UI or rely on daily bank data.

## Validation steps (run these in order)

### 1. Syntax gate (every touched file)

```bash
node --check src/listener.js
node --check src/reporte.js          # new shared module
node --check src/reporte-diario.js   # refactored cron entry
node --check src/telegram/bot.js
node --check src/report.js
node --check src/store.js
```

Expected: no output (all pass).

### 2. Reboot the listener

```bash
docker compose up -d --force-recreate notifier-listener
docker logs notifier_listener --tail 30
```

Expected log lines: listener starts, and a **command menu registration** line (setMyCommands OK). In the group: type `/` — the client's command menu shows **`report`** with its description.

### 3. Baseline: what the last cron report looked like

Note the current daily report's summary message in the group (balances + sync line). This is your "before" snapshot.

### 4. Trigger the on-demand report

In the group, type:

```
/report
```

Expected, in order:
- `⏳ Generando reporte…` within ~2 seconds
- the report: summary message (same format as cron) + one interactive message per uncategorized tx (existing buttons)

### 5. Change data, then trigger again (the dominant use case)

1. Categorize 1-2 pending transactions using the report's buttons (existing flow).
2. In the Actual UI, change a balance or add a budget entry if you want to stress the balance line (optional — balanceMap is rebuilt every run).
3. Send `/report` again.

Expected: a **new** full report; its `sin categorizar` count reflects your categorization (lower than step 4); the previously pending buttons are now marked `⌛ Reporte expirado` (D6, accepted behavior); the new report is interactive.

### 6. Full report with nothing pending (spec change 2026-09-25)

With all pending txs categorized, send `/report` again.

Expected: the **full report is still delivered** — summary message with category balances (as in the cron output) and no interactive item messages, because there are none pending. There is no "ack-only" mode anymore (old FR-007 superseded; US3 as amended).

### 7. No-regression check for the cron path

- Verify `src/reporte-diario.js` still: builds HTML, sends email, **exits 1 on email failure** (this contract is byte-for-byte), and delivers its Telegram report.
- Trigger the cron path manually (one-off): `docker exec actual_notifier node src/reporte-diario.js` and watch both the email and the group receive the daily report as before, with the same D6 expiry behavior (spec SC-004).
- Check the new column: `docker exec actual_notifier node -e "const s=require('/app/src/store.js'); (await (async()=>{const db=s.open?.(); }))()"` — or simpler: inspect SQLite that on-demand rows carry `trigger='telegram-command'` and cron rows carry `trigger='cron'`.

### 8. Non-group / non-command safety (spec FR-008, FR-010)

- Send free text in the group (`hola`, `reporte`, `/report extra`): expected **no reply**.
- Send `/report` by DM to the bot (if you have DMs enabled with it, or via a second test account): expected **no reply**.
- Send `/report` from another group the bot is in (if any): expected **no reply** (chat-id guard).

### 9. Repeated-request stress (spec SC-005)

Send `/report` 10 times across a session, interspersed with categorizations (steps 5/6 cycle). Verify:
- each request got a `⏳` then a full report delivery (nothing silently dropped, nothing interleaved mid-delivery by the depth-1 queue),
- `node --check` still passes, no `better-sqlite3` busy errors in `docker logs notifier_listener`,
- pending rows in the store are either `answered` or point at the newest report (no orphans from a dropped delivery).

### 10. Offline iteration (no group)

Use the `src/dev/` replay-driver pattern (like `replay-callback.js`): a small dev script that feeds a synthetic `/report` **message update object** into the listener's handler function directly (no `getUpdates` involved), so you can exercise recognition rules, the nothing-pending full-report path, and error edits without the live bot. This is part of the repo's established convention and is listed in the plan's file structure.

## Rollback notes

- Revert the listener restart to the old image/files via git; no data migration is destructive (the additive `reports.trigger` column with a default is backward-compatible — old code ignores it).
- The moved marker (`$DATA_DIR/last-bank-sync.txt`): a missing file just re-triggers a sync (safe).
- Command menu: `deleteMyCommands` (not shipped; a one-off Bot API call) removes the entry if needed.
