# Idea Research: Comando de Telegram para reporte y notificaciones on demand

- **Slug**: telegram-on-demand
- **Created**: 2026-09-24
- **Evidence confidence (overall)**: medium (high internal code evidence; external platform evidence from general Bot API knowledge, not freshly verified)

## Users & Demand

- The demand signal is the user's own stated frustration: they forget which command to send to request the report. This is a single-user (homelab, private Telegram group) tool, not a product for a large audience. — [source: intake.md origin & context; engram obs #5 (D1: single private group)] (confidence: medium)
- **UPDATE 2026-09-24 (user-confirmed during decision discussion): there is an OBSERVED, high-frequency use case** — after categorizing pending transactions, the user's balances change, so they need the report re-generated to see the updated `datosConsumo`/`categoriasNegativas`. This is "bastante habitual" per the user, and it works because `compute()` re-reads the current Actual `budgetMonth` on every call with no balance cache (verified: src/report.js:149-157, `balanceMap` rebuilt from `budgetMonth.categoryGroups` each invocation). Demand is therefore not only stated, it is behaviorally grounded. — [source: user statement 2026-09-24; src/report.js verified by this session] (confidence: high)
- Demand strength scales with how often reports are needed beyond the 20:00 daily cron. No usage metrics exist for missed-report frustration (no ticket log); the stated trigger is memory, not absence of automation. — [ASSUMPTION] (confidence: low)
- Group membership = potential trigger audience. Decision D1 established the Telegram bot lives in one private group with all users, and D3 established *any member* may answer categorization buttons. On-demand commands would land in the same group with the same (currently uncontrolled) membership. — [source: engram obs #5, section "SDD 01-telegram: all open questions resolved"] (confidence: high)

## Prior Art

- **No command handling exists today.** The long-poll listener only requests `callback_query` updates; there is no `message` update handling, no `/start`, `/report`, or any text-command parsing anywhere in `src/`. — [source: src/listener.js:290-296 (`allowed_updates: ['callback_query']`), src/actions/index.js:3 (`ACTION_REGISTRY = { categorize }`), workspace-wide grep for command handlers (zero matches)] (confidence: high)
- **The original Telegram v1 design explicitly scoped out free-text / commands.** Decision D5 (2026-09-20): "no free-text chat in v1 (evolve later)"; the action layer was "explicitly designed to EVOLVE (keep action layer generic)" (D4). On-demand commands are the natural next "evolve" step, but they were consciously deferred, not forgotten. — [source: engram obs #5 (decisions D4, D5)] (confidence: high)
- **Manual triggering already exists out-of-band**: `docker compose exec actual_notifier node src/reporte-diario.js` (documented in README). So "run report now" is technically possible today — manually and from the server, not from the group. There is no report-level dedup flag; only a 60-minute bank-sync throttle guard. — [source: README.md (manual run section), src/report.js:79-83 (sync throttle marker), explorer report §3/§6] (confidence: high)
- **The 60-min sync throttle is the main semantic collision**: an on-demand report within 60 min of the last sync skips the bank sync; the summary would show a stale/"omitted" sync line rather than a fresh report. — [source: src/report.js:79-83] (confidence: high)

## Market & Context

- This is a personal / homelab tool in a private group. External market context (commercial budget apps, Telegram finance bots) is not material for the decision; "prior art" here is the project's own deferred v1 decision, which is the relevant benchmark. — [source: engram obs #5 (D7: long polling, homelab, nothing exposed to internet; D9: private group)] (confidence: high)
- Cost of doing nothing is low: the 20:00 daily cron + email remain the baseline. The pain being addressed is *remembering how to ask*, not *data freshness*. — [source: crontab.txt:1, intake.md] (confidence: medium)
- Telegram platform primitives relevant to "facile la interacción": bots can declare a command menu via `setMyCommands` (shows in the client's "/" menu) and can reply to arbitrary group texts. Both are standard Bot API features available with the project's raw-fetch client; the client would need two new endpoint wrappers (`setMyCommands`, and fetching `message` updates). — [ASSUMPTION from general Bot API knowledge, not re-verified this session] (confidence: medium)

## Data & Constraints

- Transport: raw `fetch` Bot API, long polling, 4 endpoint wrappers in `src/telegram/bot.js:100-122`; no framework. Adding a text-command path = (a) extend `allowed_updates` to include `message`, (b) add `setMyCommands` wrapper, (c) a new handler in the listener loop. Small delta, well-understood surface. — [source: src/telegram/bot.js:100-122, src/listener.js:268-352] (confidence: high)
- Report generation is re-entrant: `compute()` (src/report.js:38) and `sendReport()` (src/telegram/send.js:261) are plain async functions with no cron-only state; on-demand invocation is safe to repeat. — [source: src/report.js:38, src/reporte-diario.js:60, explorer report §3] (confidence: high)
- **D6 interaction expiry is a real behavioral effect, not a blocking one**: every report delivery (including on-demand) calls `expirePreviousPending(db, beforeReportId)` (src/store.js:212-220, called from src/reporte-diario.js:241), which turns all pending categorization buttons from older reports into "expired". A user spamming an on-demand report would repeatedly expire and re-raise pending interactions. — [source: src/store.js:212-220] (confidence: high)
- **Authorization is an open security constraint, not a technical one**: D3 allows any group member to answer categorization buttons (with write-back to Actual via the same credentials as the cron, D10). An any-member `/report` command is consistent with that existing trust level, but no per-user allow-list exists anywhere today. — [source: engram obs #5 (D3, D10), negative finding: no allow-list in src/ or panel] (confidence: high)
- No rate limiting on report generation exists: nothing stops 20 on-demand reports in a minute except the 60-min band being throttled only for the sync step, not for fetching uncategorized transactions or re-sending messages. — [source: negative finding, explorer report §6] (confidence: medium)

## Evidence Against the Idea

- **The stated problem (forgetting the command) has a cheaper fix**: registering a bot command menu via `setMyCommands` solves *discovery* without building any on-demand execution path at all. If the user only needs the 20:00 report and "pending" reminders they already receive daily, the on-demand trigger itself may be unnecessary — only the hint may be. Both live in the same intake; their value is independent and should be judged separately in define. — [source: combination of prior-art findings above; [ASSUMPTION] on relative value] (confidence: medium)
- **On-demand report amplifies an existing trust hole**: it is the first *write-side-adjacent* trigger (it delivers data and flips interaction state) reachable by any group member, expanding the attack/silly-misuse surface of a bot that already writes to Actual on any member's button tap. If the user later wants member restrictions, the button flow (already live) also needs it. — [source: engram obs #5 (D3, D10)] (confidence: medium)
- **Stale-data risk inside the 60-min throttle window — PARTIALLY RETIRED 2026-09-24**: an on-demand report right after the 20:00 run skips the new bank sync, but the balance figures in the summary are **not** stale: `compute()` rebuilds them from the current Actual state on every call (src/report.js:149-157). Only the bank-sync line is stale. The user was told this explicitly and accepted it: for their categorize→re-report loop the missing sync is irrelevant because the balance changes come from their own action. The remaining (minor) risk: a reader skimming the message could misread the report as a fresh bank snapshot. — [source: src/report.js:79-83, src/report.js:149-157; user confirmation 2026-09-24] (confidence: high)
- **UPDATE 2026-09-24 — the cooldown idea (from the shape-stage option B) now has a strong counter-argument**: a 10–30 min group cooldown would block exactly the categorize→re-report moment, which the user just identified as the dominant use case. Throttling designed "against spam" would throttle the feature's main function. — [source: user statement 2026-09-24] (confidence: high)
- Not found, for honesty: no evidence of *actual observed* on-demand usage need (no log of "I needed the report at 15:00 and couldn't get it"; D6 expiry cadence already handles the main freshness story). **Partially retired 2026-09-24**: the categorize→re-report loop IS observed usage, per the user's "bastante habitual".

## Gaps & Open Questions

- [NEEDS CLARIFICATION: One command doing both (report + pending list), two commands, or reuse the existing daily flow where the "pending" messages already follow the report? Today's `sendReport()` already delivers both in one run — so "the pending notification" may already be bundled.]
- [NEEDS CLARIFICATION: "Facilitar la interacción": command menu (`setMyCommands`), a bot hint message on `/start`/unknown command, or an actual nudge when the user types something close? Only the first is a zero-data-integration option.]
- [NEEDS CLARIFICATION: Any group member (consistent with D3) or a restricted user set for triggering?]
- [NEEDS CLARIFICATION: Rate limit expectation — ignore repeated triggers within N minutes, answer "ya se generó hace X min", or expire+re-raise every time (current D6 behavior)?]
- [NEEDS CLARIFICATION: Behavior when there are zero uncategorized transactions and nothing to report — silent, or a "todo al día" confirmation.]

## Sources

- `src/telegram/bot.js` (internal code; endpoints L100-122) — policy: n/a (local)
- `src/listener.js` (internal code; `allowed_updates` L290-296, loop L268-352) — policy: n/a (local)
- `src/actions/index.js` (internal code; L3) — policy: n/a (local)
- `src/report.js` (internal code; `compute()` L38, sync throttle L79-83) — policy: n/a (local)
- `src/reporte-diario.js` (internal code; L60, L241) — policy: n/a (local)
- `src/telegram/send.js` (internal code; `sendReport()` L261, builders L189-224) — policy: n/a (local)
- `src/store.js` (internal code; `expirePreviousPending` L212-220, `claimAnswer` L148-157) — policy: n/a (local)
- `src/panel/routes/telegram.js` + `src/panel/views/telegram.html` (internal code; config-only, no trigger UI) — policy: n/a (local)
- `crontab.txt` (L1, 20:00 daily), `README.md` (manual run) — policy: n/a (local)
- Engram obs #5 "SDD 01-telegram: all open questions resolved by user" (D1-D10, 2026-09-20) — policy: n/a (local memory)
- Telegram Bot API `setMyCommands` / `message` updates — general platform knowledge, not re-fetched this session — [ASSUMPTION] (policy: n/a)
