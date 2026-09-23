# Phase 0 Research: Web Configuration Panel for actual-notifier

All Technical Context choices below were resolved from repository precedent and the completed assessment (`.specify/assessments/config-webapp/`), not open unknowns — no `[NEEDS CLARIFICATION]` markers remain.

## Server implementation: hand-rolled Node `http`, no framework

- **Decision**: Build the panel's HTTP server with Node's built-in `http` module and a small hand-rolled router, instead of Express/Fastify/Koa.
- **Rationale**: `src/telegram/bot.js` documents a "Zero new runtime deps (P9)" principle for a comparable problem (talking to an external HTTP API with exactly four endpoints, using only the Node 20 global `fetch`). The whole project has exactly 3 dependencies (`@actual-app/api`, `dotenv`, `nodemailer`) across its entire history, with no linter, no test framework, no web framework anywhere. The panel's scope (a handful of forms for one operator) does not need routing/middleware sophistication a framework provides.
- **Alternatives considered**: Express (most common choice, but a new dependency plus its own transitive dependency tree, for a five-page internal tool); Fastify (same objection, lighter but still new); a static-file + client JS SPA (rejected — adds a build step/bundler, which this project has never had and doesn't need for five server-rendered forms).

## Password hashing & sessions: Node built-in `crypto`

- **Decision**: Hash the panel password with `crypto.scrypt` (salted) and implement sessions as a signed cookie (HMAC over a random session id + expiry, via `crypto.createHmac`) rather than a server-side session store or a hashing library like bcrypt.
- **Rationale**: `scrypt` and `createHmac`/`randomBytes` are in Node's standard `crypto` module — zero new dependency, and avoids `bcrypt`'s native-module build step (the project already pays one such cost for `better-sqlite3`; adding a second native dependency for a single password field is unwarranted). A signed cookie needs no new database table.
- **Alternatives considered**: `bcrypt`/`bcryptjs` (native build step or extra pure-JS dependency, respectively — rejected per the no-new-deps precedent); server-side session table in SQLite (rejected — adds schema and cleanup logic a stateless signed cookie avoids entirely for a single-operator tool).

## Config storage: keep `.env` / `crontab.txt` as source of truth; reuse the existing `kv` table for panel-only state

- **Decision**: The panel reads and writes `.env` and `crontab.txt` directly (the files `notifier-cron`/`notifier-listener` already consume) for actual configuration values. Panel-only state (username, password hash, login-lockout counters) is stored as new keys in the existing SQLite `kv` table (`src/store.js`), not a new table or a new datastore.
- **Rationale**: Per `decision.md`, `.env`/`crontab.txt` remain authoritative — this avoids a migration and keeps `notifier-cron`/`notifier-listener` unchanged in how they read config (already established: cron path reloads `.env` fresh each run; listener needs its existing hot-reload path, see below). The `kv` table already exists and is documented as the place for "small config/state that must survive redeploys" (`src/store.js`'s own `poll_offset` usage is exactly this pattern).
- **Alternatives considered**: A new dedicated `panel_config` SQLite table (rejected — no need beyond what a couple of `kv` rows already cover); moving all configuration into SQLite and making `.env`/`crontab.txt` bootstrap-only (rejected — larger migration than this feature's scope requires, and not requested).

## Live reload for listener-consumed settings: extend the existing poll-loop hot-reload (Concept Option A mechanism)

- **Decision**: `notifier-listener` re-reads its Telegram-related config (bot token, group id, category allow-list, poll timeout) from `.env` on its existing ~30s poll cadence, exactly as shaped in `concept.md` Option A — now triggered by the panel's writes instead of a human edit.
- **Rationale**: This mechanism was already designed and decision-approved; Option C (the web panel) is additive on top of it, not a replacement.
- **Alternatives considered**: None re-litigated — carried forward from the assessment as-is.

## Live reload for the schedule: `crontab.txt` + mtime-watcher in `entrypoint.sh` (no OS-cron replacement)

- **Decision**: The panel writes a single translated cron line into the shared, bind-mounted `crontab.txt` (mounted `:rw` for the panel, `:ro` for `notifier-cron` as today). `notifier-cron`'s `entrypoint.sh` gains a small polling loop (a few lines of `sh`, no new dependency) that detects `crontab.txt`'s mtime change and re-runs `crontab /app/crontab.txt`.
- **Rationale**: Matches `decision.md`'s explicit choice — keeps OS cron and its container role completely unchanged, avoiding turning `notifier-cron` into a long-running scheduler process (the rejected alternative).
- **Alternatives considered**: Replacing OS cron with an in-process Node scheduler inside `notifier-cron` (rejected in `decision.md` as a bigger architectural change than needed).

## Schedule input: three simplified modes, translated to cron syntax

- **Decision**: The panel UI offers exactly three schedule modes — every X minutes, every X hours, once daily at HH:MM — and translates the selected mode into one cron line. Raw cron syntax is never required from the operator.
- **Rationale**: Explicit maintainer requirement (spec.md FR-013); the maintainer confirmed no atypical schedules are needed.
- **Alternatives considered**: Exposing raw cron syntax directly (rejected — maintainer explicitly asked for a simplified input); a full cron-expression builder UI (rejected — unnecessary complexity for three fixed modes).

## Testing approach: Node's built-in test runner

- **Decision**: Use `node --test` (Node 20's built-in test runner) for the panel's own tests.
- **Rationale**: Zero new dependency; the project has no existing test framework/convention to preserve, and `node --test` is already available in the same Node 20 image the project uses.
- **Alternatives considered**: Jest/Mocha/Vitest (all rejected as new dependencies with no existing project precedent to justify the addition).
