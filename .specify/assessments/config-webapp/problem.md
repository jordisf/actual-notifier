# Problem Definition: Manual restart-to-apply-config friction in actual-notifier

- **Slug**: config-webapp
- **Created**: 2026-09-23
- **Inputs used**: intake.md, research.md

## Problem Statement

The sole maintainer/operator of `actual-notifier` (a personal, single-host home-lab tool) changes runtime behavior — Actual Budget/SMTP/Telegram credentials, monitored categories, and the report schedule — by hand-editing `.env` and `crontab.txt`. Research narrowed the actual friction versus the belief recorded in intake: the cron-driven report already reloads `.env` with zero restart on its next scheduled run, and `crontab.txt` only needs a plain container restart, not an image rebuild. The one confirmed remaining gap is `notifier-listener`, a long-running process that reads Telegram-related config (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, category allow-list, poll timeout) once at boot — changing any of it requires the operator to remember and run `docker compose restart notifier-listener` by hand, with no UI, no validation, and no visibility into the currently effective values.

## Affected Users & Stakeholders

- **Users**: the repo owner/maintainer — the only person known to edit `.env`/`crontab.txt` and operate the deployment today [source: research.md "Users & Demand", DEPLOY.md single-LXC deployment].
- **Stakeholders**: same individual, acting as owner, operator, and developer — no separate stakeholder or additional operator has been identified. [NEEDS CLARIFICATION: is there any other person — present or future — who would use or be affected by a configuration interface?]

## Goals

- Remove (or automate) the manual `docker compose restart notifier-listener` step currently required after changing listener-consumed config (Telegram token/group id/categories/poll timeout).
- Let the operator see the currently effective configuration without opening `.env` directly (which mixes secrets with non-secrets in one plaintext file).
- Whatever new config storage/interface is introduced must not repeat the secrets-hygiene mistake already found and remediated in this assessment (a live Telegram bot token committed in plaintext to `Telegram.md`).

## Non-Goals

- Solving for multiple concurrent operators or any multi-tenant access model — no evidence such a need exists.
- Re-solving `.env` reload for the cron/report path (`reporte-diario.js`) — research confirmed this already works with zero restart today.
- Changing report business logic (categorization rules, HTML template, bank-sync throttle) — this is configuration only.
- Deciding *how* to solve it (new web server vs. lightweight file/DB watcher vs. something else) — that choice belongs to `/speckit-assess-shape`, not here.

## Success Metrics

- Changing listener-consumed config (Telegram bot token, group id, category allow-list, poll timeout) takes effect without a manually-remembered `docker compose restart notifier-listener` command. (baseline: today this manual restart is required and only documented in a code comment in `.env.example`)
- The operator can inspect the currently effective configuration without opening `.env` in a text editor. (baseline: today the only way to see current values is to open `.env` and/or `crontab.txt` directly)
- No new incident of a live secret committed in plaintext to the repo is introduced by whatever mechanism is built here. (baseline: one such incident — `Telegram.md` — already occurred and was remediated during this assessment; qualitative metric)

## Cost of Inaction

If nothing is built, the maintainer keeps editing `.env`/`crontab.txt` by hand and running a manual `docker compose restart notifier-listener` after Telegram-related changes. For a single-operator, infrequently-changed home-lab tool this is a small, bounded operational cost, not an urgent business problem — the main risk is a forgotten restart leaving the listener silently running on stale Telegram config until a symptom (e.g. bot not responding) is noticed, and a repeat of the plaintext-secret mistake if configuration handling is later improvised without care.

## Open Questions

- [NEEDS CLARIFICATION: Given the narrowed scope, does the real ask become "make `notifier-listener` hot-reload its config" rather than a full web admin panel — or is "no restart, ever, for anything, via a web UI" still a hard requirement regardless of the now-smaller actual gap?]
- [NEEDS CLARIFICATION: Should secrets (SMTP password, Actual password, Telegram bot token) be viewable/editable through any new interface at all, given the `Telegram.md` incident — and if so, what auth/encryption-at-rest is required?]
- [NEEDS CLARIFICATION: Would a lightweight fix (listener watches a config file/DB row and hot-reloads only the Telegram-related values) satisfy the need without introducing a new HTTP-exposed service and its attack surface?]
- [NEEDS CLARIFICATION: If a UI is still wanted, should it require authentication, and what is the threat model (LAN-only vs. exposed beyond the home-lab network)?]
- [NEEDS CLARIFICATION: Which settings are actually in scope — just the listener's Telegram config, or also SMTP/Actual credentials and the cron schedule?]
- [NEEDS CLARIFICATION: Should configuration be persisted back to `.env`/`crontab.txt` (keeping them as source of truth) or moved to the existing SQLite `kv` store / a different store, with `.env` becoming a bootstrap-only fallback?]
