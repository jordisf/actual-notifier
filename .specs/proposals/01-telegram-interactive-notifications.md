# SDD Proposal — 01: Telegram Interactive Notifications

> **Status**: PROPOSED — Open Questions RESOLVED by user 2026-09-20 (see Section 7). Ready for design phase.
> **Date**: 2026-09-20
> **Author**: ODD/SDD workflow (sdd-orchestrator)
> **Route**: SDD (user-selected) · Pace: interactive · Artifacts: hybrid (OpenSpec + Engram) · PR strategy: auto-chain

---

## 1. Background & Motivation

`actual-notifier` currently delivers a daily budget report **only by email** (SMTP, cron-triggered, fire-and-forget). The report is informational: recipients can read it but **cannot act on it from the notification itself**.

The proposed feature adds **Telegram** as a notification channel with **interactive inline buttons**:

- The daily message is delivered to **multiple Telegram recipients** (1-on-1 private chats or a single group — decision pending, see Q1).
- Each message carries **inline keyboard buttons** (selection options) defined by the business logic (exact options pending — see Q4).
- When a user taps a button, the **tap is received by our system** and the **corresponding action is applied** (the concrete action mapping is an open question — see Q4).

### Goals

1. Deliver the daily report to multiple Telegram destinations in addition to (or replacing) email.
2. Support interactive inline buttons on the message.
3. Receive each user's button press in our system and apply a corresponding action.
4. Persist response state so answers survive across cron runs and container restarts.
5. Keep the existing email channel behavior available during/after migration (replace vs. complement — pending Q2).

### Non-Goals (initial scope)

- Telegram group-administration features, bot marketplace, etc.
- Replacing Actual Budget's own sync/notification features.
- A full chat dialogue experience: v1 is **push + inline-button reply** only (a richer bot conversation can be a follow-up change if Q5 points there).

---

## 2. As-Is (Current State — verified 2026-09-20)

### 2.1 System shape

- **Single monolithic script**: `src/reporte-diario.js` (~320 lines, CommonJS, Node 20).
- **Lifecycle**: **cron-triggered, ephemeral process**. One cron entry (`crontab.txt`) runs `node src/reporte-diario.js` **daily at 20:00 Europe/Madrid** inside the `actual_notifier` Docker container. The process starts, does its job, and exits.
- **No persistent listener**: nothing in the system is reachable or listening between cron runs. There is no HTTP server, no queue, no webhook target.
- **State is ephemeral**: only `/tmp/actual-cache` (API cache + 60-min bank-sync throttle marker). Container restarts wipe it. No database, no persistent volume.

### 2.2 Current flow (email channel)

```mermaid
flowchart TD
    A[cron 20:00 daily] --> B[api.init + downloadBudget]
    B --> C{throttle: bank sync < 60 min?}
    C -- yes --> D[Skip sync]
    C -- no --> E[api.runBankSync ING/PSD2]
    E --> D
    D --> F[Detect uncategorized txs<br/>(current month, on-budget accounts)]
    F --> G[Compute balances + daily pace<br/>for 5 hardcoded target categories<br/>+ overspend sweep]
    G --> H[Render HTML report]
    H --> I[SMTP send via nodemailer<br/>to NOTIFICATION_EMAIL list]
    I --> J[api.shutdown / process exits]
```

### 2.3 Key current-state facts that constrain this change

| # | Fact | Consequence for Telegram feature |
|---|------|----------------------------------|
| F1 | Process is **fire-and-forget** (starts and exits each day) | An inline-button reply can arrive at **any moment**, including minutes after the report process has exited and for days afterwards. The current lifecycle **cannot receive replies at all**. |
| F2 | **No persistent state** — everything in `/tmp` | Replies, "already-processed" flags, and per-user answer state need a **new persistence layer** (volume + SQLite/JSON store). |
| F3 | Container runs **in a Docker network** (`actual_net`, external). No ports exposed in `docker-compose.yml`. | Inbound option (Telegram **webhook**) requires a **publicly reachable HTTPS endpoint** (reverse proxy, tunnel, or exposing a port) that does not exist today. |
| F4 | **3 runtime deps only** (`@actual-app/api`, `dotenv`, `nodemailer`); no devDependencies, no test runner, no linter | Adding a Telegram library is low-friction, but there is **zero test capability** (strict_tdd: false). |
| F5 | Volumes are **read-only** (`./src`, `./crontab.txt`, `./.env` mounted `:ro`) | A persistent reply store **cannot live in those mounts**; a new **writable** volume (or named volume) is required. |
| F6 | Env config loaded with `override: true` per execution | Bot token / recipient IDs can follow the same `.env` pattern with no code ceremony. |
| F7 | Recipients today = `NOTIFICATION_EMAIL` (comma-separated emails) | Telegram recipients need an equivalent config: bot-authorized **chat IDs** (comma-separated) instead of/alongside emails. |
| F8 | Failure handling: unhandled error → `process.exit(1)`, no failure notification | A long-lived listener needs its own crash-restart semantics (`restart: unless-stopped` exists, but the listener currently doesn't). |

### 2.4 Current message content (what the buttons would attach to)

The report already computes, per run, the exact signals needed to make buttons *meaningful*:

- `syncOk` / `syncMensaje` (bank sync status, 60-min throttle-aware)
- `transaccionesSinCategorizar[]` (date, payee, account, amount)
- `datosConsumo[]` (5 target categories: balance + daily pace)
- `categoriasNegativas[]` (overspent sweep)

The interactive options are expected to act on these signals (e.g., acknowledge, re-sync now, mark as reviewed) — **final mapping is Open Question Q4**.

---

## 3. To-Be (Proposed State)

### 3.1 High-level architecture (directional — final choice depends on Q7)

```mermaid
flowchart TB
    subgraph Container["actual_notifier container (evolved)"]
        CRON[cron 20:00<br/>report generator]
        SRVC[Telegram listener<br/>(webhook HTTP server OR long-poll loop)]
        STORE[(persistent store<br/>writable volume<br/>SQLite or JSON: replies, dedupe, state)]
        ACT[Action executor<br/>runs business actions on reply]
        CRON --> SRVC
        SRVC <--> TG[Telegram Bot API]
        SRVC --> STORE
        SRVC --> ACT
        ACT <--> ACTUAL[(Actual Budget API)]
        ACT --> STORE
        EMAIL[SMTP channel<br/>kept or retired — Q2]
        CRON --> EMAIL
    end
```

### 3.2 Component changes (proposed)

1. **Telegram bot creation** (out-of-scope infra, user-side): create a bot via @BotFather → obtain `TELEGRAM_BOT_TOKEN`.
2. **New config (`.env`)**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_RECIPIENT_CHAT_IDS` (comma-separated), channel toggles (`NOTIFY_CHANNEL=telegram|email|both`), webhook settings if that route is chosen (`TELEGRAM_WEBHOOK_URL`, secret token).
3. **New module(s)** (the monolith already exceeds a single-responsibility; this change is a natural moment to split):
   - `src/telegram/notify.js` — build the report as an interactive message (inline keyboard), send to N chat IDs.
   - `src/telegram/listener.js` — receive updates (webhook or long polling) and route button callbacks.
   - `src/actions/*.js` — the actionable behaviors a button triggers.
   - `src/store.js` — persistence (replies log, idempotency keys, per-report state).
   - `src/reporte-diario.js` — reduced to orchestration: compute → notify (all channels) → store run metadata.
4. **New runtime process**: a **persistent listener process** alongside cron (e.g., `CMD`/entrypoint runs both `cron` and the listener, two compose services, or the listener started by the entrypoint). Lifecycle: `restart: unless-stopped` already applies.
5. **New writable volume** for the reply store (e.g., `./data:/app/data` or a named volume) because all current mounts are read-only.
6. **Message format**: Telegram supports limited HTML and `inline_keyboard` buttons (max 8 buttons per row, 100-char button text, ~4096-char message limit — reports may need truncation/summaries vs. the rich HTML email).

### 3.3 Response contract (proposed skeleton — details pending Q3/Q4)

- Each button carries a `callback_data` payload: `{ reportId, action, itemRef? }`.
- On callback: (a) parse payload, (b) load `reportId` state from store, (c) **idempotency check** (same user + same report + same action already applied → re-edit message "✅ already applied" and stop), (d) execute action, (e) persist the reply, (f) edit the button/message to confirm to the tapping user.
- Reply log entry: `{ chatId, userId, username, reportId, action, itemRef, appliedAt, result }` → persisted, queryable, survives restarts.

### 3.4 Email channel disposition

- Default proposal: **complement first** (`NOTIFY_CHANNEL=both` during a migration window), with a config flag to switch to `telegram`-only once stable. Reversal is a config change, not a code change. (Final answer pending Q2.)

---

## 4. Key Architectural Risks

### R1 — Reply persistence & idempotency (HIGH)
Buttons can be tapped days after the report run, by any recipient, repeatedly, or out of order. With today's **zero persistent state** (F2/F5), a naive implementation loses all answers on container restart.
- **Mitigations**: new writable volume + append-only reply log (SQLite recommended over JSON for concurrent access from listener + actions); `callback_data` is a **security-sensitive channel** (it is echoed back unsigned) — do NOT put secrets or large payloads in it; re-validate action against stored report state, not against the callback alone. Idempotency key required (`reportId + chatId + action + itemRef`).
- **Edge**: Telegram may redeliver updates (at-least-once semantics) → duplicates are expected, not exceptional.

### R2 — Webhook vs. long polling inbound transport (RESOLVED → long polling, D7)
The core structural question. Current state: no exposed ports, no public URL, container behind an external network (F3).

| | **Webhook** (Telegram pushes updates to HTTPS URL) | **Long polling** (our process calls `getUpdates` in a loop) |
|---|---|---|
| Infra required | **Public HTTPS endpoint** + cert (reverse proxy / tunnel / port exposure) | **None** — outbound connection only |
| Fit to current architecture | Poor without new infra (F3): requires exposing the container or a sidecar proxy on the host | **Excellent**: works from inside Docker, no public surface |
| Latency | Immediate push | ~0–35s per update cycle (usually <1s in practice) |
| Reliability | Depends on external URL availability; must `answerCallbackQuery` promptly | Depends on process uptime; **must re-issue `getUpdates` with stable `offset` after crashes**, else redeliveries or lost updates |
| Ops/security attack surface | Opens a port + TLS management | None inbound |
| Scale ceiling | Fine for N bots | **Hard 1 bot / 1 process**: exactly our case |

- **Working recommendation (not final)**: **long polling** for v1 — zero new inbound infra, matches the 1-bot-1-home scale, keeps the container's current network posture. Webhook can be revisited if latency or reliability demands it later. **Pending user confirmation (Q7)** because it depends on whether the user wants/has a public HTTPS endpoint available.

### R3 — Cron fire-and-forget vs. continuous service lifecycle (HIGH)
Today the only thing that runs is a process that exits (F1). The listener must be a **long-lived process**, which changes:
- Container contract: entrypoint must launch **two processes** (cron + listener) — the current `exec cron -f` becomes a process-supervision problem (simplest v1: two compose services sharing build + volumes, or a small supervisor / entrypoint `&` pattern — decision goes in design phase).
- Crash semantics: the listener can die while cron keeps working → reports send but nobody can answer buttons until restart. `restart: unless-stopped` helps, but there is **no healthcheck and no liveness signal today** (known debt, as-is.md §5.5).
- The action executor may need the **Actual API initialized**, which today happens per-cron-run; the listener cannot assume a warm API connection across days (Actual API handles have idle/lifecycle behavior) → actions likely run API init per-action (slower, but correct) — design decision.

### R4 — Multi-recipient answer model (MEDIUM, business fork)
Multiple recipients = **who is allowed to answer, and what happens when two people answer differently?** (e.g., A taps "acknowledge sync failure", B taps "ignore"). Options: first-answer-wins, all-must-answer (quorum), per-user answers are independent (each action scoped to its actor), or only a designated admin chat may act. This is a **business rule, not a tech choice** → Q3.

### R5 — Report lifetime and action validity (MEDIUM)
Actions reference a *specific day's* report state (`reportId`). A tap on last week's "re-sync now" button — still valid? Stale buttons must degrade gracefully (edit message: "this report is expired"), and the store must retain reports long enough for the valid window (retention policy → Q6).

### R6 — Channel format divergence (MEDIUM)
Email HTML (rich tables, badges) does not map 1:1 to Telegram's ~4096-char, limited-HTML message with inline keyboards. The content renderer must become **channel-aware**; the "smart subject line" logic maps to a message header. Truncation strategy for busy days (many uncategorized txs) needed.

### R7 — Dependency & supply-chain (LOW-MEDIUM)
New runtime dep (e.g., `grammy` or `telegraf`, or zero-dep direct Bot API calls over `fetch`). Node 20 has global `fetch`, so a **zero-extra-dependency** implementation of send + long-poll is viable and keeps the dependency list at ~4. Decision in design phase; low risk either way.

### R8 — Existing security debt amplification (MEDIUM, inherited)
as-is.md S1: real credentials in `.env` are considered **compromised — rotation pending**. A Telegram bot token is a new high-value credential added to the same file (still gitignored, still root-running container, S3). **The credential rotation must be treated as a precondition before this feature ships**, and the compose `:ro` mounts + non-root hardening (known debt) reduce but don't eliminate exposure.

### R9 — Reply delivery visibility (LOW)
Users tap a button; with at-least-once semantics + long polling, a crash mid-processing could surface as "nothing happened". The confirmation edit (3.3-f) plus the reply log covers this; a "no action" fallback message prevents silent drops.

---

## 5. Impact Summary

| Area | Impact |
|---|---|
| `src/reporte-diario.js` | Refactored: render/send split out; computes + orchestrates |
| `src/telegram/*`, `src/actions/*`, `src/store.js` | **New** modules |
| `package.json` | +0..1 runtime dep (bot lib optional), no build step change |
| `docker-compose.yml` | +writable volume; +listener process (2nd service or supervised) |
| `entrypoint.sh` / `cron` | Entrypoint must start listener too |
| `.env` / `.env.example` | +`TELEGRAM_BOT_TOKEN`, `TELEGRAM_RECIPIENT_CHAT_IDS`, channel toggle, webhook vars (if chosen) |
| Runtime lifecycle | cron-only → cron + continuous listener (**biggest structural change**) |
| Infra | Public HTTPS endpoint **only if** webhook route chosen (R2) |

**Size estimate**: well within one PR (~300–500 authored changed lines; if it crosses 400, auto-chain slices it).

---

## 6. Success Criteria (proposed, to confirm)

1. Daily report received by both Telegram and email (or Telegram-only per config) at 20:00.
2. Telegram message contains ≥2 functional inline buttons.
3. A button tap by any configured recipient is received by the system and its action is applied + persisted.
4. Re-tapping the same button does not re-apply the action (idempotent) and shows a confirmation.
5. Container restart between report and tap does not lose or duplicate the applied action.
6. Telegram outage/degradation does not break the email channel and vice-versa (channels independent).
7. No regression in the existing report computation (same numbers as today's email).

## 7. Design Decisions (RESOLVED by user — 2026-09-20)

Original open questions closed with these answers; they are the design input now:

| # | Decision | Answer |
|---|----------|--------|
| D1 | Recipients & format | **Single private Telegram group** containing all intervening users. All communication is orchestrated through this group. (R4 simplifies: all members see the same messages; first-answer-wins per D3.) |
| D2 | Email channel | **Kept.** Daily email continues as-is; Telegram is complementary. `NOTIFY_CHANNEL=both` is effectively the only mode for v1. |
| D3 | Answer authority | **Any group member may answer. First answer wins** — the first response closes the question as answered (subsequent tappers get a "ya respondido X" style confirmation, no action applied). |
| D4 | v1 scope (business) | ONLY this scenario: system sends a message with info about an **uncategorized transaction**, offering **category options** as inline buttons (the category list is the one already queried from Actual Budget). Any user selects one category → the transaction gets **categorized in Actual Budget**. Explicitly: **designed to evolve** — the action layer must stay generic (report/action/item model), not hardwired to categorization. |
| D5 | Conversation depth | v1 = message + inline buttons + confirmation edits. **No free-text chat.** Designed to evolve (listener/adapter boundaries must not forbid it later). |
| D6 | Action validity | Report is sent **at least once per day**. Any pending interaction from a **previous report** may be **expired** when a new report is delivered → pending buttons of older reports are invalidated/closed on new delivery. (Supersedes the 48–72h clock proposal.) |
| D7 | Transport | **Long polling. Confirmed.** Nothing exposed to the internet — home-lab server. No webhook, no reverse proxy, no tunnel. (R2 closed.) |
| D8 | Persistence tech | **SQLite** (recommended option accepted). |
| D9 | Bot availability | Yes — user will create the bot via @BotFather (v1 uses a **group**, so the `/start`-for-DM constraint does not apply; bot must be added to the private group). |
| D10 | Action identity | **Yes** — actions write to Actual Budget with the same credentials as the cron run. |
| D11 | Validation target | The repo now includes a **local dev environment** (`actual-budget/` compose + deterministic `dev-budget` seed + `dev.yml` overlay with Mailpit, feature `dev-actual-budget`). **All functional validation of this change runs against that dev Actual instance**, not production. Details in design §12A. |

### Consequences for scope (v1)

- The daily report message itself is **informational** (mirrors the email), no buttons on the summary.
- Interactive messages are **per-uncategorized-transaction** (or batched per message if Telegram row limits force it): text with date/payee/account/amount + inline keyboard of category buttons + a way to dismiss ("Ignorar / sin categorizar" — still an open wording detail, not a fork).
- "Categorize" action = **write-back to Actual Budget** (`api` set-category call on the transaction) — the only v1 mutation.
- First-answer-wins + per-new-report expiry require the store to track pending interactions per report and atomically claim a win.
- Evolution hooks (keep out of v1 scope, but architecture must not block): free-text commands, more report-scoped actions, possibly per-user targeting.

## 8. Next SDD Phases

`design` (architecture: listener process lifecycle, poll-loop crash recovery with stable offset, store schema, callback_data contract, action executor with per-action Actual API lifecycle, group-message layout within 4096-char limit) → `tasks` → `apply` → `verify` → `archive`.

---
*Spec artifact language: English (per SDD config). Conversation language: Spanish.*
