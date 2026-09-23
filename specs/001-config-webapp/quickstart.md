# Quickstart: Web Configuration Panel for actual-notifier

Validation guide for proving the feature works end-to-end. See [data-model.md](./data-model.md) for field details and [contracts/routes.md](./contracts/routes.md) for the full route list.

## Prerequisites

- Docker + Docker Compose, `actual_net` external network already created (existing project prerequisite, per `README.md`).
- The existing `notifier-cron` / `notifier-listener` stack running (or at least buildable) from this repo.

## Setup

```bash
# Build/refresh all three services, including the new panel
docker compose up -d --build
```

## Scenario 1 — First-time login forces a password (User Story 1)

```bash
# Fresh install: no panel_password_hash set yet in data/notifier.db's kv table
```

1. Open the panel URL from a machine on the LAN/VPN.
2. **Expected**: logged in immediately without a password, and redirected to a mandatory "set your password" screen — no configuration screen is reachable yet.
3. Set a username and password.
4. Log out, log back in with the new credentials.
5. **Expected**: the old no-password bootstrap path no longer works; only the new credentials succeed.

## Scenario 2 — Telegram config applies live, no restart (User Story 2)

1. Log in to the panel, go to Telegram settings.
2. Change `TELEGRAM_CATEGORIES` (the allow-list) to a different value and save.
3. **Expected**: the panel validates the bot token/group id before saving; on success, `.env`'s `TELEGRAM_CATEGORIES` is updated.
4. Without restarting any container, trigger a Telegram interaction (or wait one poll cycle, ≤ ~30s).
5. **Expected**: `notifier-listener` behaves according to the new allow-list — confirmable via `docker logs notifier_listener` showing the updated value picked up, per its existing structured logging (`src/log.js`).

## Scenario 3 — SMTP test-before-save (User Story 3)

1. Log in, go to SMTP settings, enter a deliberately wrong `SMTP_PASS`.
2. Click test-send.
3. **Expected**: the panel reports the failure and does not persist the change.
4. Correct the value, test again, save.
5. **Expected**: `.env`'s SMTP values update; the field remains masked until "show" is explicitly clicked.

## Scenario 4 — Schedule via simplified input, no restart (User Story 4)

1. Log in, go to Schedule settings, pick "every 6 hours".
2. Save.
3. **Expected**: `crontab.txt` now contains a single translated cron line; without restarting `notifier-cron`, its `entrypoint.sh` mtime-watcher detects the change and re-runs `crontab /app/crontab.txt` (confirmable via `docker exec actual_notifier crontab -l`).

## Scenario 5 — LAN/VPN-only reachability (FR-005, SC-004)

1. From a device outside the operator's LAN/VPN, attempt to reach the panel's address/port.
2. **Expected**: connection fails/refused — the panel is not reachable from outside the LAN/VPN.
