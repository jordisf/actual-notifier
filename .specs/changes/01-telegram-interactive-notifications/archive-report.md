# Archive Report — 01-telegram-interactive-notifications

Archived: 2026-09-20 · Branch: `slice/01-s4-listener-e2e` · Status: **APPROVED / ARCHIVED**

## What shipped

Interactive Telegram notifications layered onto the existing cron-triggered Actual Budget daily report. From the cron run: one plain summary + one inline-keyboard message per uncategorized tx (8 non-income categories + a dismiss row). A long-poll listener resolves taps, applies the chosen category to the real transaction (or dismisses), and edits the message to a "Respondido por <user>" confirmation. State lives in a shared SQLite store (WAL); first-answer-wins is enforced by a guarded update.

## Delivery (feature-branch-chain, no remote — branches are the PRs)

| PR | Branch | Base | Authoried lines | Note |
|---|---|---|---|---|
| #1 | `slice/01-s1-telegram-foundation` | `master-add-telegram` | ~230 | ✅ |
| #2 | `slice/01-s2-report-extraction` | #1 | ~340 | ✅ |
| #3 | `slice/01-s3-telegram-delivery` | #2 | ~650 | ⚠️ `size:exception` (user decision) |
| #4 | `slice/01-s4-listener-e2e` | #3 | ~560 | ✅ |

Only `master-add-telegram` merges to `master` once the whole chain is validated.

## Verification

Full §12 + §12A pass on the dev stack, including the **live e2e**: real BotFather bot in a real Telegram supergroup, live taps applied categories to the dev Actual instance and were verified by API read (Renta, then Transporte + Suscripciones), message edited with "Respondido por jsbdm" + disabled buttons, and a follow-up run dropped the uncategorized count 2 → 0. See `verify-report.md`.

## Final-state corrections made after the original apply artifacts

These are part of the final (archived) state, newer than the S4 dry-run `tasks.md` snapshot:
- **Split-brain SQLite (dev infra)** fixed: recreated the notifier containers so cron and listener share the host `data` volume (verified by matching inodes). Backups at `data/backup-*.db`.
- **`telegram_tx_sent`** now stores the real delivered count (was boolean). Commit `1398baf`.
- **`data/`** added to `.gitignore`.
- `getDb`/`setDb` added to `listener.js` before first S4 commit.

## Open preconditions (gate PRODUCTION cutover, not this feature's dev validation)

- **Credential rotation** of production `.env` secrets (as-is.md S1) — still pending. Must be done before real-world go-live.
- Production deploy: ensure `./data/` exists before first boot on a fresh host.

## Follow-ups (documented out-of-scope, §13)

- Listener self-ping / healthcheck / boot watchdog.
- Crash/alert notification for the listener process.

## Artifacts (final, in this folder)

- `design.md` — architecture, decision log D1–D11, verification plan §12/§12A
- `tasks.md` — T0–T7, apply progress (all slices DONE), delivery decision
- `verify-report.md` — step-by-step §12 verdicts
- `archive-report.md` — this file
- Proposal: `.specs/proposals/01-telegram-interactive-notifications.md`
- Baseline spec: `.specs/specs/00-baseline-architecture.md`

Change `01-telegram-interactive-notifications` is **closed**.
