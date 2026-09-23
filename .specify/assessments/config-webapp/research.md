# Idea Research: Panel web para configurar el notifier

- **Slug**: config-webapp
- **Created**: 2026-09-23
- **Evidence confidence (overall)**: medium

## Users & Demand

- This is a single-operator, home-lab tool: `actual-notifier` and `actual-budget` run together in one Proxmox LXC, deployed by one maintainer via `git pull` + `docker compose` — [source: DEPLOY.md] (confidence: high, cited).
- No evidence of demand from anyone other than the repo owner (no issue tracker, no other contributors, no multi-tenant concept anywhere in the codebase) — [ASSUMPTION] that the panel's only user is the current maintainer (confidence: medium).

## Prior Art

- A durable key/value store already exists for exactly this kind of "small config/state that must survive redeploys" need: `src/store.js` opens `data/notifier.db` (SQLite, WAL mode) with a generic `kv` table, currently used for `poll_offset` — [source: src/store.js]. This is a ready-made persistence mechanism a config-webapp could reuse instead of introducing a new datastore (confidence: high, cited).
- The cron path (`src/reporte-diario.js`) already reloads `.env` on every run: `dotenv.config({ override: true })` runs inside a **fresh process spawned by cron** on each scheduled tick (daily 20:00, per [crontab.txt](../../../crontab.txt)) — so edits to most `.env` values already apply on the *next scheduled run*, with **no container restart or rebuild at all** — [source: as-is.md §3.1, crontab.txt] (confidence: high, cited).
- The listener path (`src/listener.js`) is the actual gap: it is a long-running process that loads env **once at boot** and explicitly does **not** use `override: true` ("NO override: the compose environment is authoritative for this service") — so any Telegram-related config it reads is frozen until the process restarts — [source: src/listener.js] (confidence: high, cited).
- `.env.example` already documents this exact gap and its current workaround: "changing `TELEGRAM_BOT_TOKEN`/`TELEGRAM_GROUP_ID` requires `docker compose restart notifier-listener`" — a scoped, single-service restart, not a full-stack reload or rebuild — [source: .env.example] (confidence: high, cited).
- `crontab.txt` is bind-mounted read-only into `notifier-cron` and reinstalled via `crontab /app/crontab.txt` in [entrypoint.sh](../../../entrypoint.sh) on every container start. README.md and DEPLOY.md both document the existing procedure as edit-the-file + `docker compose restart` — **no image rebuild** is required today — [source: README.md "Cambiar la planificación", DEPLOY.md "How the deploy works"] (confidence: high, cited). This directly contradicts the "reconstruir la imagen" belief recorded in intake.md.

## Market & Context

- Not applicable in the usual market sense: this is a personal/home-lab tool with a single deployment target, not a product with competitors or external users — [ASSUMPTION] based on DEPLOY.md's description of a single Proxmox LXC deployment (confidence: high).
- The "alternative users cope with today" is simply direct file editing (`.env`, `crontab.txt`) plus a manual `docker compose restart`/`up -d` — already a fairly low-friction workflow for a sole technical operator, per README.md's documented steps.

## Data & Constraints

- No web-server dependency exists yet: `package.json`'s only dependencies are `@actual-app/api`, `dotenv`, `nodemailer` — a web panel requires adding a new HTTP framework/runtime dependency and attack surface — [source: package.json] (confidence: high, cited).
- The current architecture explicitly has **no inbound ports** on either service (`docker-compose.yml` comment: "Both share the same writable data volume (SQLite) and the same :ro src/.env mounts. No inbound ports on either service.") — a web panel is a deliberate, non-trivial change to that posture, whichever container hosts it — [source: docker-compose.yml] (confidence: high, cited).
- **Security finding (high confidence, cited)**: [Telegram.md](../../../Telegram.md) contains a real Telegram bot token and group id in plaintext at the repo root. It is **not** covered by `.gitignore` (which only ignores `.env*` and a few data/cache directories) and **is committed** to git history (`983c449`, 2026-09-23 09:14:23 +0200), with an `origin` remote at `https://github.com/jordisf/actual-notifier.git` — [source: Telegram.md, `git log`, .gitignore, `git remote -v`]. This is an active credential-hygiene problem independent of this feature, and it directly informs the config-webapp's design: whatever replaces/augments `.env` for secrets must not repeat this pattern (plaintext committed file). Recommend rotating the token regardless of this feature's outcome.
- `data/` (including `notifier.db`) is host-mounted, gitignored, and already documented to survive `git pull`/redeploys — a config-webapp's writes would inherit this durability for free if it stores config there — [source: DEPLOY.md, .gitignore].

## Evidence Against the Idea

- The specific pain point recorded in intake — "`crontab.txt` change requires rebuilding the image" — does not hold up under repo inspection; a restart already suffices today. Building a whole web panel to solve a rebuild problem that does not exist would be solving the wrong problem for that half of the ask.
- The remaining real gap (listener env frozen until `docker compose restart notifier-listener`) is narrow and already has a documented, one-line workaround. A full web admin panel is a large surface (new HTTP server, auth, secrets handling) to close a gap that might be solvable more cheaply — e.g. having the listener poll/watch its config source (file or DB) and hot-reload the handful of values it actually needs, without any new UI.
- This is a single-operator tool with no inbound ports today. Adding a web server increases attack surface (authentication, exposed HTTP endpoint, secrets rendered in a browser) for a convenience gain that only benefits one person who already edits two text files by hand — the cost/benefit is not obviously favorable without a clearer articulation of *why* file editing is currently painful beyond the (partially incorrect) restart/rebuild belief.
- The live, exposed Telegram credential in `Telegram.md` suggests the project's more urgent problem right now is secrets hygiene, not lack of a configuration UI — effort spent here has an opportunity cost against fixing that.

## Gaps & Open Questions

- [NEEDS CLARIFICATION: Is there a real user other than the repo owner who needs this panel, or is the goal purely to reduce the maintainer's own friction?]
- [NEEDS CLARIFICATION: Now that repo inspection shows `.env` changes for the cron path already apply on the next scheduled run with zero restart, and `crontab.txt` changes only need a restart (not a rebuild) — does the ask narrow to just: (a) live-reloading the listener's Telegram config, and (b) a friendlier UI than raw file editing? Or is "no restart, ever, for anything" still a hard requirement?]
- [NEEDS CLARIFICATION: Should secrets (SMTP password, Actual password, Telegram bot token) be renderable/editable through a browser at all, given the existing `Telegram.md` incident? What auth/encryption-at-rest would be required to avoid repeating that mistake?]
- [NEEDS CLARIFICATION: Would a lighter-weight fix (e.g., listener watches a config file/DB row and hot-reloads only the Telegram-related values) satisfy the underlying need without a full web panel and new HTTP attack surface?]

## Sources

- `as-is.md` (local repo file — architecture/behavior description, dated 2026-09-19)
- `README.md` (local repo file — deployment/config instructions)
- `DEPLOY.md` (local repo file — production runbook)
- `crontab.txt`, `entrypoint.sh`, `docker-compose.yml`, `.env.example`, `package.json` (local repo files)
- `src/store.js`, `src/listener.js` (local repo source)
- `Telegram.md` (local repo file — contains a live secret; cited for its existence/exposure, not its value)
- `git log --oneline --all -- Telegram.md` / `git remote -v` (local git metadata, run in workspace terminal)

No external URLs were fetched for this research — the relevant evidence was fully available in the local repository.
