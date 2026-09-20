# 00 — Baseline Architecture (sdd-init)

> Captured: **2026-09-20** · Project: `actual-notifier` · Companion memory: `architecture/baseline` in Engram
> Source of truth for the as-is state: `as-is.md` (2026-09-19) + direct code inspection.

## 1. Purpose

A cron-scheduled Node.js service that connects to a self-hosted **Actual Budget** instance, keeps the household budget in sync with the bank, and sends a **daily HTML email report** (20:00, `Europe/Madrid`) covering: sync status, uncategorized transactions of the current month, availability of target spending categories, and overspending alerts.

## 2. System overview

```mermaid
flowchart LR
    subgraph container [Docker container: node:20-slim]
        CRON[cron - daily 20:00<br/>crontab.txt installed by entrypoint.sh]
        JS[src/reporte-diario.js<br/>monolithic script ~290 lines]
        CACHE[/tmp/actual-cache<br/>API cache + sync marker]
        CRON --> JS
        JS <--> CACHE
    end
    ACTUAL[Actual Budget self-hosted<br/>API @actual-app/api]
    BANK[ING PSD2 via Actual sync]
    SMTP[SMTP relay]
    JS -- init/downloadBudget/getTransactions/getBudgetMonth --> ACTUAL
    JS -- runBankSync --> ACTUAL -- PSD2 --> BANK
    JS -- sendMail --> SMTP
    SMTP -- daily report --> USERS[(recipients)]
```

### Component map

| Component | File(s) | Responsibility |
|---|---|---|
| Scheduler | `crontab.txt`, `entrypoint.sh` | Single cron entry (20:00 daily); dumps env to `/etc/environment`, installs crontab, runs `cron -f` |
| Business logic | `src/reporte-diario.js` | **All** of it: Actual client, bank sync, analysis, HTML rendering, mailer |
| Packaging | `Dockerfile` | `node:20-slim` + `cron`, `tzdata`, native build tools (`python3`/`make`/`g++` for `better-sqlite3`) |
| Deployment | `docker-compose.yml` | One service on external network `actual_net`; RO volumes for `src/`, `crontab.txt`, `.env` → code/schedule/credentials change without rebuild |
| Config | `.env` (ignored), `.env.example` | All external config via environment variables |

## 3. Stack & dependencies

- **Runtime**: Node.js 20, **CommonJS**.
- **Dependencies (all)**: `@actual-app/api ^26.8.1`, `dotenv ^16.4.5`, `nodemailer ^6.9.13` — nothing else.
- **No** devDependencies, no test framework, no linter/formatter, no build step.
- **Testing capability: none** (`strict_tdd: false`). Lowest-friction path if needed: Node's built-in `node --test`.

## 4. Execution flow (5 sequential steps)

1. **Init** — `dotenv` (`override: true`), ensure `/tmp/actual-cache`, `api.init()` + `api.downloadBudget(ACTUAL_SYNC_ID)`.
2. **Bank sync** — `api.runBankSync()` with a **60-minute throttle** (marker file `/tmp/actual-cache/last-bank-sync.txt`). stdout is temporarily silenced to suppress the API's transaction dump. Sync failures are **caught and downgraded to a warning** — the report still runs.
3. **Uncategorized detection** — current month, on-budget non-closed accounts; excludes parent transactions and internal transfers.
4. **Availability & overspending** — per-category balances from `getBudgetMonth`; target categories get balance + daily pace; full sweep flags negative non-monitored categories.
5. **Render + send** — inline HTML (conditional blocks), dynamic subject with alert tags, SMTP send to a comma-separated recipient list.

## 5. Data contracts

| Contract | Rule |
|---|---|
| Amounts | Integer **cents** from the Actual API; divided by 100 before use/display |
| Month key | `YYYY-MM` string for budget month and transaction date bounds |
| Category identity | Matched by **trimmed, case-insensitive name** (no ID-based config) |
| Account scope | `!account.offbudget && !account.closed` for transaction scans |
| Transaction filters | Excludes `is_parent`, `transfer_id` set/empty-string, and `category == null or ''` |
| Config | 100% environment variables (`.env` template in `.env.example`): `ACTUAL_*`, `SMTP_*`, `NOTIFICATION_EMAIL` |

## 6. Business invariants (MUST hold in every future change)

| # | Invariant | Current implementation |
|---|---|---|
| I1 | **The daily email is sent even if the bank sync fails** — sync errors surface as a warning block, never an abort | `try/catch` around `runBankSync` in step 2 |
| I2 | Bank sync is throttled to **at most once per 60 minutes** across cron runs | Timestamp marker file, checked before sync |
| I3 | Uncategorized list **excludes** parent transactions, internal transfers, off-budget/closed accounts, and other months | Filters in step 3 |
| I4 | The 5 monitored target categories are: `Gasto Personal`, `Farmacia y Botiquin`, `Supermercado y Alimentación`, `Ocio y Restaurantes`, `Transporte` | `CATEGORIAS_OBJETIVO` constant (hardcoded) |
| I5 | **Daily pace** = balance ÷ days remaining in month; shown as 0 when balance ≤ 0 | Step 4 calculation |
| I6 | Overspending alert = any **non-monitored, non-income** category with negative balance | Full sweep step 4 |
| I7 | Subject line carries alert tags for: sync failure, uncategorized count, overspending presence | `subjectTags` composition |
| I8 | Report covers **operational (on-budget) spending only** — "La capacidad real de gasto reside exclusivamente en los sobres" | Account filter + message footer |

## 7. State model

- **Ephemeral only.** All state lives in `/tmp/actual-cache` (API SQLite cache + bank-sync marker). No database, no queue, no persistent storage owned by this service.
- Consequence: the sync marker resets if the container `/tmp` is wiped; at worst the sync runs more often, which the throttle makes idempotently safe.

## 8. Security & operational posture (as-is)

- Container runs as **root**; `entrypoint.sh` dumps all env vars to `/etc/environment`.
- Real credentials live in `.env` (volumes RO) — treated as potentially compromised; **rotation is the outstanding top action** (as-is.md S1).
- No healthcheck; logs go to `/var/log/cron.log` inside the container, no rotation.
- **Failure blind spot**: any unhandled error (init, download, send) → `exit(1)` with **no failure notification** to the users.

## 9. Known weaknesses (evolution candidates, ordered by as-is.md priorities)

1. **Monolith** — one file mixes client, business logic, HTML presentation, and mailer; natural seam: split into `actual client / analyzer / renderer / mailer` modules.
2. **Hardcoded categories & HTML template** (SMTP already externalized).
3. **Fragile hacks** — `process.stdout.write` override to silence the API; no structured logging.
4. **No observability** — healthcheck, log rotation, process-failure alert.
5. **No tests/linter**; `npm start` is the only script.
6. **Docker hardening** — non-root user, multi-stage build, pinned versions.

## 10. Configuration reference

| Variable | Meaning | Default |
|---|---|---|
| `ACTUAL_SERVER_URL` | Actual Budget server URL | — |
| `ACTUAL_PASSWORD` | Server password | — |
| `ACTUAL_SYNC_ID` | Budget sync ID to download | — |
| `SMTP_HOST` | SMTP relay host | — |
| `SMTP_PORT` | SMTP port | `465` |
| `SMTP_SECURE` | Implicit TLS (`true`/`false`) | inferred: `true` when port is 465 |
| `SMTP_USER` | SMTP user + mail `from` | — |
| `SMTP_PASS` | SMTP password | — |
| `NOTIFICATION_EMAIL` | Comma-separated recipients | — |
