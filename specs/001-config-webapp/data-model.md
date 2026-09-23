# Phase 1 Data Model: Web Configuration Panel for actual-notifier

No new SQLite tables. Two existing persisted stores hold everything this feature needs: the `kv` table (`src/store.js`, `data/notifier.db`) for panel-only state, and the existing `.env` / `crontab.txt` files for the configuration values themselves.

## Panel Credentials (`kv` table rows)

Represents the single shared login for the panel. Stored as individual keys in the existing generic `kv` table (`key TEXT PRIMARY KEY, value TEXT NOT NULL`) — no schema change required.

| `kv` key | Meaning | Validation rules |
|---|---|---|
| `panel_username` | The panel login username | Non-empty string; set during bootstrap (FR-003) or via credential-change (FR-004) |
| `panel_password_hash` | `scrypt` salted hash of the password, encoded as `salt:hash` (or equivalent self-describing format) | Empty/absent value triggers the one-time no-password bootstrap login (FR-003); once set, never stored or logged in plain form |
| `panel_login_failures` | Consecutive failed login attempt count | Non-negative integer; reset to 0 on a successful login |
| `panel_lockout_until` | ISO 8601 timestamp until which login attempts are rejected | Absent/past = not locked out; set after repeated failures (FR-015) |

## Session (not persisted — stateless signed cookie)

Represents an authenticated browser session. Not a database row: a cookie value of `<sessionId>.<expiryEpoch>.<hmacSignature>`, verified against a server-side secret (itself a `kv` row, e.g. `panel_session_secret`, generated once on first boot).

- **Fields**: `sessionId` (random, for auditability/uniqueness only), `expiryEpoch` (defines session length, per the default policy in spec.md's Assumptions), `hmacSignature` (over `sessionId + expiryEpoch`, using `panel_session_secret`).
- **Validation rules**: request is authenticated only if the signature verifies against the current secret and `expiryEpoch` is in the future; any tampering invalidates the whole cookie (no partial trust).
- **State transitions**: issued on successful login (including the bootstrap no-password login) → valid until `expiryEpoch` or explicit logout (client discards the cookie; optionally the server rotates `panel_session_secret` to invalidate all sessions at once, e.g., on a credential change).

## Telegram Settings (existing `.env` keys — read/written by the panel, consumed live by `notifier-listener`)

- **Fields**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `TELEGRAM_CATEGORIES` (comma-separated allow-list), `TELEGRAM_POLL_TIMEOUT`.
- **Validation rules** (FR-008): before persisting, the panel calls the Telegram Bot API (reusing `src/telegram/bot.js`) to confirm the token is valid and the group id is reachable; a failing call blocks the save with a reported error.

## SMTP Settings (existing `.env` keys)

- **Fields**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`.
- **Validation rules** (FR-009): before persisting, the panel attempts a test send (via `nodemailer`, reusing the same construction as `src/reporte-diario.js`) and blocks the save on failure. `SMTP_PASS` is masked-by-default in the UI (FR-012).

## Actual Budget Connection (existing `.env` keys)

- **Fields**: `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD`, `ACTUAL_SYNC_ID`.
- **Validation rules**: before persisting, the panel attempts `actual.js`'s existing `open()`/`close()` handshake against the new values and blocks the save on failure. `ACTUAL_PASSWORD` is masked-by-default (FR-012).

## Notification Recipients (existing `.env` key)

- **Fields**: `NOTIFICATION_EMAIL` (comma-separated list).
- **Validation rules**: at least one syntactically valid email address; no live "test" call required (a test send under SMTP Settings already covers deliverability).

## Report Schedule (existing `crontab.txt`, one line)

- **Fields**: `mode` (`every-minutes` | `every-hours` | `daily-at`), plus the mode's single parameter (`minutes`, `hours`, or `time` HH:MM).
- **Validation rules** (FR-013): only these three modes are representable in the UI; the panel translates the chosen mode+parameter into exactly one valid cron line before writing `crontab.txt`.
- **State transitions**: on save, the panel writes the new line to the shared `crontab.txt`; `notifier-cron`'s mtime-watcher (see research.md) detects the change and reinstalls the crontab — no panel-side signal to the other container is needed.
