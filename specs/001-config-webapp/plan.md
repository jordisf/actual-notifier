# Implementation Plan: Web Configuration Panel for actual-notifier

**Branch**: `001-config-webapp` | **Date**: 2026-09-23 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-config-webapp/spec.md`, grounded in the full assessment trail at `.specify/assessments/config-webapp/` (intake → research → problem → concept → decision).

## Summary

Add a small, LAN/VPN-only web admin panel — running in its own dedicated container — that lets the operator view and edit `actual-notifier`'s Telegram, SMTP, Actual Budget, recipient, and schedule configuration behind a username/password login, with changes applying without a manual container restart. The panel introduces **zero new npm dependencies**: it reuses Node 20's built-in `http`/`crypto`/`fs` modules and the project's existing dependencies (`better-sqlite3` via `src/store.js`, `dotenv`, `nodemailer`, `@actual-app/api`), matching the project's own established precedent (`src/telegram/bot.js`'s documented "zero new runtime deps" principle).

## Technical Context

**Language/Version**: JavaScript / Node.js 20 (matches `Dockerfile`'s existing `node:20-slim` base and the rest of the codebase).

**Primary Dependencies**: None new. Reuses Node's built-in `http`, `crypto` (password hashing via `scrypt`, signed session cookies via `createHmac`), and `fs`/`querystring` modules for a hand-rolled server (no Express/Fastify — see Rationale in research.md), plus the project's existing `better-sqlite3` (via `src/store.js`), `dotenv`, `nodemailer`, and `@actual-app/api` for reading/testing configuration.

**Storage**: `.env` and `crontab.txt` remain the persisted, applied configuration (unchanged by this feature); the shared SQLite store (`data/notifier.db`, via `src/store.js`'s existing `kv` table) gains a small number of new keys for panel credentials and login-lockout state — no new table, no new datastore.

**Testing**: Node's built-in test runner (`node --test`, available in Node 20, zero new dependency) — the project currently has no test framework installed, so this is the smallest-footprint option consistent with the "no new deps" precedent, exercised via `docker exec` the same way `node --check` is already used for smoke-testing (per `DEPLOY.md`).

**Target Platform**: Linux container (Docker), same `node:20-slim` family as the existing services; reachable only from the operator's LAN/VPN (no public port).

**Project Type**: Single small internal web service (server-rendered HTML forms, no client-side framework/bundler) — a third container alongside `notifier-cron` and `notifier-listener`.

**Performance Goals**: Not demanding — a single operator, LAN-only, occasional configuration changes. Reasonable default: sub-second page responses on LAN; no concurrent-load target beyond a handful of simultaneous requests from one browser.

**Constraints**: Must not be reachable outside LAN/VPN (FR-005); must not introduce a new npm dependency (project precedent); must not disturb `notifier-cron`/`notifier-listener`'s existing access to `.env`, `crontab.txt`, and `data/notifier.db`; secrets masked by default (FR-012); passwords stored as salted one-way hashes, never reversible (FR-002).

**Scale/Scope**: Single operator, ~5 configuration groups (Telegram, SMTP, Actual connection, recipients, schedule), a handful of fields each — trivial scale.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is an unfilled template — no formal, ratified project constitution exists to check against (confirmed during `/speckit-assess-decide`, scored `unknown` for Strategic Fit). In its absence, this plan treats the one clearly evidenced, repo-wide engineering convention as a binding gate: **no new runtime dependency without strong justification** (directly evidenced by `src/telegram/bot.js`'s documented "Zero new runtime deps (P9)" principle, and by the project having only 3 total dependencies across its entire history).

- **Gate: no new npm dependency** — PASS. The panel is built entirely from Node's standard library plus the project's existing dependencies; no `package.json` change is required.
- **Gate: does not weaken existing security posture without mitigation** — PASS. The one new attack surface (an HTTP server) is constrained to LAN/VPN-only reachability, gated by mandatory authentication, with secrets masked by default — all directly required by spec.md's FR-001–FR-005 and FR-012.

No violations to justify; Complexity Tracking is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-config-webapp/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   └── routes.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
# Single project, third container added alongside the existing two.
src/
├── store.js              # existing — gains panel credential/lockout kv keys, unchanged shape
├── log.js                # existing — reused as-is ('panel' becomes a new `service` tag)
├── actual.js              # existing — reused for "test Actual connection" validation
├── telegram/
│   └── bot.js             # existing — reused for "test Telegram bot token" validation
└── panel/                 # NEW — everything specific to the web panel
    ├── server.js           # http.createServer + hand-rolled router (no framework)
    ├── auth.js             # login, bootstrap-password flow, session cookie sign/verify, lockout
    ├── config-store.js     # read/write .env values and crontab.txt schedule line
    ├── validate.js          # test-SMTP-send, test-Telegram-token, test-Actual-connection
    ├── views/                # small server-rendered HTML templates (login, dashboard, per-section forms)
    └── main.js               # entrypoint: starts the HTTP server

data/                     # existing, shared bind-mount (notifier.db) — unchanged location
.env                      # existing — panel gains a `:rw` mount to write here (others stay `:ro`)
crontab.txt                # existing — panel gains a `:rw` mount; notifier-cron adds a small mtime-watch loop

Dockerfile                # existing, unchanged (notifier-cron / notifier-listener image)
Dockerfile.panel          # NEW — lean image: same node:20-slim base, same `npm install --omit=dev`,
                          # copies only src/store.js, src/log.js, src/actual.js, src/telegram/bot.js,
                          # and src/panel/, then runs `node src/panel/main.js`
docker-compose.yml        # gains a third service (e.g. `config-panel`), LAN/VPN-only network exposure
entrypoint.sh             # existing — gains a small mtime-watch loop that re-runs `crontab /app/crontab.txt`
                          # when crontab.txt changes, so the panel's schedule edits apply without restart
```

**Structure Decision**: Single-project layout (no separate `frontend/`/`backend/` split — server-rendered HTML keeps this a single Node process/container). The panel lives in its own `src/panel/` directory and its own `Dockerfile.panel`/compose service, per the assessment decision that it must be a dedicated container rather than embedded in the existing notifier image. It shares `src/store.js`, `src/log.js`, `src/actual.js`, and `src/telegram/bot.js` by file-copying them into its own image (not a shared npm package — the project has no monorepo/package-splitting convention to build on, and introducing one would itself be a complexity this feature doesn't need).

## Complexity Tracking

*No Constitution Check violations — this section is not applicable.*
