# Contracts: Web Configuration Panel Routes

This is a small server-rendered web application (form posts, not a JSON API for external consumers), so its "contract" is the set of HTTP routes it exposes, their auth requirement, and what each does. There is no OpenAPI/JSON-schema contract because there are no external API consumers — the only client is the operator's browser.

| Method | Path | Auth required | Purpose | Notes |
|---|---|---|---|---|
| `GET` | `/login` | No | Render the login form | If no `panel_password_hash` is set (kv), render the bootstrap notice instead of a password field (FR-003) |
| `POST` | `/login` | No | Submit username/password (or username-only on bootstrap) | On success: sets the signed session cookie. On repeated failure: enforces lockout (FR-015) |
| `POST` | `/logout` | Session | Clear the session cookie | — |
| `GET` | `/set-password` | Session, only reachable mid-bootstrap | Force-set a new password before anything else is usable | Redirects here automatically after a bootstrap (no-password) login until a password is set (FR-003) |
| `POST` | `/set-password` | Session | Persist the new `panel_password_hash` (and optionally new username) | FR-004 |
| `GET` | `/` | Session | Dashboard — links to each configuration section | — |
| `GET` | `/telegram` | Session | Show current Telegram settings (secrets masked) | FR-006, FR-012 |
| `POST` | `/telegram` | Session | Validate + persist Telegram settings | FR-007, FR-008 |
| `GET` | `/smtp` | Session | Show current SMTP settings (secret masked) | FR-009, FR-012 |
| `POST` | `/smtp/test` | Session | Send a test email with the submitted (not-yet-saved) values | FR-009 |
| `POST` | `/smtp` | Session | Persist SMTP settings (only after a passing test, or explicit override) | FR-009 |
| `GET` | `/actual` | Session | Show current Actual Budget connection (secret masked) | FR-010, FR-012 |
| `POST` | `/actual` | Session | Validate (test connect) + persist Actual connection settings | FR-010 |
| `GET` | `/recipients` | Session | Show current notification recipient list | FR-011 |
| `POST` | `/recipients` | Session | Persist the recipient list | FR-011 |
| `GET` | `/schedule` | Session | Show current schedule as one of the three simplified modes | FR-013 |
| `POST` | `/schedule` | Session | Translate the selected mode to a cron line and persist to `crontab.txt` | FR-013, FR-014 |
| `POST` | `/reveal/:field` | Session | Return the unmasked value of a single secret field, for the explicit "show" action | FR-012 — never included in any other response by default |

All `Session`-gated routes redirect to `/login` when the session cookie is missing, invalid, or expired. All `POST` routes re-render the originating form with the reported error on validation failure rather than silently applying an invalid value (spec.md Edge Cases).
