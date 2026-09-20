# Verify Report — 01-telegram-interactive-notifications

Date: 2026-09-20 · Branch: `slice/01-s4-listener-e2e` · strict_tdd: false (functional verification)

Scope: design §12 (11 steps) + §12A, against the dev stack per D11, with live BotFather token available from the live-e2e step onward.

## Results

| §12 step | Verdict | Evidence |
|---|---|---|
| 1. Dry-run boot | PASS | S3: both services boot; `notifier.db` schema created; listener polling logs; cron run logs (not sends). |
| 2. Delivery + store | PASS | S3 dry-run: `reports` row, 2 `interactions` with `tg_message_id=-1`, `button_rows_json` = 8-category row + dismiss row (CI-3), `poll_offset` untouched. Live (report 1–3): real `tg_message_id`s, real chat id `-1000000000002`. |
| 3. Callback path (dry) | PASS | S4 replay: unknown ref → `rejected` + rollback to `pending`; dismiss → `applied (dismissed)` with no Actual call; second tap → `duplicate (already answered)` winner preserved. |
| 4. Idempotency & crash | PASS (with note) | Guarded `UPDATE … WHERE status='pending'` first-wins proven in S1 smoke + replay duplicates. True concurrent double-tap NOT reproduced in dev (host job-infra limitation, noted honestly in tasks.md). Backoff 1s→2s→4s + SIGTERM clean exit 0 observed. `poll_offset` persists across restarts (`545467806`→`809`→`810`). |
| 5. Expiry (D6) | PASS | S3 dry-run + LIVE: new delivery expired prior report's interactions (rows 1–2 report 1; rows 5–6 report 3 → `expired`) + real editMessageText observed in group. |
| 6. Live cutover | PASS | Real group <group> (supergroup), bot admin. Delivery → email + summary + 2 interactive messages. Live taps: `⏳ Procesando…` ack → Renta applied (verified in dev Actual), then Transporte + Suscripciones (both verified via API) → "Respondido por <user>" with disabled buttons. Follow-up run: `2 → 0` uncategorized, `sent: 0`. Note: "second person taps same message" not exercised live; covered by dry-run duplicate path + S1 guard. |
| 7. Restart survival | PASS | Listener restarted multiple times during live e2e (stop/recreate for split-brain fix, `up -d` reboots); offset survived (`545467809` at restart); taps after restart applied (batch-2 taps landed after the recreate). |
| 8. Failure containment | PASS | S3: Telegram fail → cron exits 0, email delivered. Listener 409/404 storms self-recover via backoff (observed live). No crash loops on any container. |
| 9. Budget regression | PASS | S2: old monolith vs refactored email byte-identical (5503 chars UTF-8), subject tag preserved, 2 uncategorized + amounts unchanged across all subsequent runs. |
| 10. Credential precondition | OPEN (by design) | Production `.env` secrets rotation still pending — this gates PRODUCTION cutover, not dev validation. Carried as follow-up. |
| 11. Dev-instance e2e | PASS | Full loop executed on dev: seed invariant (2 uncategorized) → delivery → live tap → Actual mutation → re-check → restore. |

## Issues found & resolved during verification

1. **Split-brain SQLite (dev infra, fixed)**: long-lived `actual_notifier_dev` container predated the `data` volume mount and was never recreated → cron and listener used different `notifier.db`. Fixed by recreating containers; verified by matching inodes. Backup copies kept at `data/backup-cron-only.db`, `data/backup-listener-only.db`.
2. **`telegram_tx_sent` boolean counter (fixed)**: stored `1` for any nonzero count; now stores the real delivered count (verified: report 2 → `2`). Commit `1398baf`.
3. **`.gitignore`**: `data/` now ignored (SQLite state must never be committed).
4. **getDb/setDb (fixed in S4)**: listener referenced undefined module fns; added before first commit.

## Warnings

- Live "second person taps same message" path verified only via dry-run replay + unit-level first-wins guard, not with a second human in the group. Low risk: the code path is identical to the replayed one (guarded UPDATE is the single source of truth).
- Step 10 remains open until production credentials are rotated.

## Suggestions (non-blocking)

- Production deploy check: confirm `data/` directory is created before first boot (fresh hosts have no `./data`).
- Follow-up feature (documented out-of-scope §13.6): listener self-ping/healthcheck, so an unmonitored long-poll dying is detectable.

## Verdict

**CRITICAL: 0 · WARNING: 2 (above) · SUGGESTION: 2 (above)** — implementation matches proposal + design across all 11 verification steps; change is ready to archive.

---

## Post-Archive Addendum (2026-09-20, after the dedicated dev-env e2e)

This addendum supersedes the warning list above for the items covered. The original report stands as the snapshot taken at archive time.

- **WARNING #1 (live second-person same-message) — RESOLVED to the extent physically possible.** A *sequential* second tap cannot occur in Telegram (buttons are disabled once `editMessageText` lands), so the true case is the SIMULTANEOUS race. It was exercised on **live batch-3 store data** (interaction 5, winner `<user>`) via `replay-callback.js --item-ref=5 --ref=3` through the real `handleUpdate`: outcome `duplicate (already answered)`, winner row unchanged, synthetic answer row removed. Evidence: tasks.md "Duplicate-tap race" note, commit `dde66fd`. Only the cosmetic Telegram toast for a synthetic callback id is unrenderable (HTTP 400, expected) — the live code path is byte-for-byte the one exercised.
- **New evidence: live e2e batch 3** on a DEDICATED dev bot + dev group (bot `0000000000…`, group `-1000000000001`): full loop green (delivery → 2 taps applied → API read-back → follow-up run 0 uncategorized → seed restored). Commit `ed6798f`.
- **New runbook items** (recorded in tasks.md GOTCHA notes): (a) after rotating a bot token, reset `kv poll_offset` to `0` — the offset is a per-bot server counter and a stale-high value parks the poll at EOF; (b) Actual mutations only flush through the proper `actual.close()` — `process.exit()` discards pending write-backs silently.
- Verdict after addendum: **CRITICAL 0 · WARNING 1 (step 10 credential rotation — production precondition, by design) · SUGGESTION 2.**
