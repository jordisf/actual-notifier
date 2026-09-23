# Idea Intake: Panel web para configurar el notifier

- **Slug**: config-webapp
- **Created**: 2026-09-23
- **Source**: pasted text
- **Type**: new-capability

## Idea (as captured)

> "Actualmente el comportamiento y configuración del script de notificaciones e integración con telegram se determina a través del archivo .env y por la configuración de crontab.txt.
> Actualmente un cambio en .env requiere parar y rearrancar el docker y un cambio en el crontab requiere reconstruir la imágen.
> Queremos añadir un backweb desde el que se pueda configurar todo el comportamiento. El backweb se puede servir desde el mismo docker o crear un nuevo docker que permita estas configuraciones
> Los cambios de configuración y definiciones se deben aplicar sin necesidad de recargar el docker"

## Restated

Today, `actual-notifier`'s behavior (Actual Budget connection, SMTP, Telegram bot settings, category lists, scheduling) is configured entirely through the `.env` file and `crontab.txt`, both edited by hand; the stated belief is that a `.env` change needs a container stop/restart and a `crontab.txt` change needs an image rebuild to take effect. The idea is to add a web-based admin panel — either served from the existing notifier container or from a new dedicated container — that lets an operator view and change this configuration, with changes applying live, without reloading the Docker container.

## Origin & Context

- **Raised by**: [NEEDS CLARIFICATION: project owner/maintainer speaking in first person plural ("Queremos"), no specific name given]
- **Trigger**: [NEEDS CLARIFICATION: no specific triggering event mentioned — appears to be an ongoing operability/usability pain point with editing `.env`/`crontab.txt` directly and the perceived need to stop/restart or rebuild to apply changes]

## First-Glance Unknowns

- [NEEDS CLARIFICATION: Who is the intended user of this panel — the same person who edits `.env` today, or a less technical operator?]
- [NEEDS CLARIFICATION: Should the panel require authentication? What threat model (is it exposed beyond localhost/LAN)?]
- [NEEDS CLARIFICATION: Which settings are in scope — all of `.env` (including secrets like `ACTUAL_PASSWORD`, `SMTP_PASS`, `TELEGRAM_BOT_TOKEN`) and all of `crontab.txt`'s schedule, or a subset?]
- [NEEDS CLARIFICATION: What does "sin recargar el docker" mean precisely — no process restart at all, or restart of only the affected sub-process (e.g. `notifier-listener`) is acceptable? `.env.example` already notes some vars require `docker compose restart notifier-listener`.]
- [NEEDS CLARIFICATION: repo inspection shows `crontab.txt` is bind-mounted `:ro` and reinstalled via `crontab /app/crontab.txt` in [entrypoint.sh](../../../entrypoint.sh) on every container start — a restart of `notifier-cron`, not an image rebuild, already picks up `crontab.txt` edits. Confirm whether the "reconstruir la imagen" belief reflects a different observed behavior, or whether the actual pain point is the restart itself (any restart being undesirable), not specifically a rebuild.]
- [NEEDS CLARIFICATION: Should configuration be persisted back to `.env`/`crontab.txt` files (keeping them as source of truth) or moved to a different store (DB, JSON) with `.env` becoming a fallback/bootstrap only?]
- [NEEDS CLARIFICATION: Same container vs. new container — any preference driven by resource constraints, security isolation, or deployment simplicity (single `docker-compose.yml` already orchestrates `actual-budget` + notifier)?]
- [NEEDS CLARIFICATION: Does the panel need to validate/test settings before applying (e.g. test SMTP send, test Telegram bot token) or just persist raw values?]

