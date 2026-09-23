# Concept: Live-reload for actual-notifier configuration

- **Slug**: config-webapp
- **Created**: 2026-09-23
- **Recommended option**: Option A — Listener hot-reload (no new UI)

## Options

### Option A — Listener hot-reload (no new UI)
- **Sketch**: `notifier-listener` stops freezing its Telegram-related config (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, category allow-list, poll timeout) at process boot. Instead it re-reads `.env` (or just the handful of vars it cares about) on a cheap cadence already available to it — e.g. at the top of each long-poll loop iteration (~every 30s, per `POLL_TIMEOUT_SEC`) or via a file-watch on `.env`. Editing `.env` and waiting a few seconds becomes the entire "apply config" workflow; `docker compose restart notifier-listener` is no longer a required manual step. No new container, no new dependency, no new exposed port.
- **Appetite**: small (days).
- **Trade-offs**: Wins — directly closes the one confirmed gap from problem.md, zero new attack surface, zero new secrets-handling design needed (secrets stay exactly where they already are, in `.env`), cheapest to build and review. Sacrifices — no browser UI, no visibility/validation beyond what `.env` itself offers, does not touch SMTP/Actual credentials or the cron schedule (still requires the existing restart-based workflow for those, which problem.md already scoped as a non-goal). Key risk: needs care around torn reads if `.env` is being written mid-poll (mitigate with the same `dotenv`-style whole-file parse already used elsewhere, not incremental parsing).
- **Rabbit holes**: mostly none — the main way this blows up scope is if "just reload the listener" quietly grows into "also add a UI to edit `.env`," re-absorbing Option C's scope without anyone deciding that explicitly.

### Option B — kv-store-backed config with a local CLI
- **Sketch**: Introduce a small set of config rows in the existing SQLite `kv` table (already used for `poll_offset`) as the source of truth for listener-tunable settings, with a tiny `docker exec ... node src/dev/set-config.js <key> <value>` style CLI (matching the existing `src/dev/*` tooling pattern) to read/write them. `notifier-listener` watches/polls the same rows and hot-reloads on change — same mechanism as Option A, but backed by the DB instead of `.env`, and reachable without opening a text editor inside the container. Still no HTTP server, no new inbound port.
- **Appetite**: small–medium (a few days to a week: schema, CLI, migration path for existing `.env`-sourced values, docs).
- **Trade-offs**: Wins — an actual "interface" (a CLI) instead of hand-editing `.env`, values persist in the same durable store used elsewhere in the codebase, still no network exposure. Sacrifices — a second CLI to learn/remember (`docker exec ...`) instead of a single obvious file; splits configuration across `.env` (secrets, SMTP/Actual, schedule) and `kv` (listener-tunable values), which can get confusing about "where do I change X." Does not deliver a browser UI, so it only partially matches the idea's literal wording ("backweb").
- **Rabbit holes**: deciding exactly which settings migrate to `kv` vs. stay in `.env` can expand scope quickly (the "which settings are in scope" open question from problem.md resurfaces here); CLI ergonomics/validation (masking secrets in `docker exec` output, avoiding shell-history leakage of secret values) is an easy-to-underestimate detail.

### Option C — Web admin panel (the originally requested "backweb")
- **Sketch**: A small authenticated web UI — served either from the existing notifier container on an internal-only port, or from a new dedicated container — backed by the Option B kv-store, letting the operator view and edit configuration (schedule, Telegram settings, and possibly SMTP/Actual credentials) through a browser. Writes trigger the same hot-reload mechanism as A/B. This is the literal shape of the idea as captured in intake.md.
- **Appetite**: medium (weeks) — a new HTTP service, auth, and secrets-in-the-browser handling is materially more than A or B, even kept minimal.
- **Trade-offs**: Wins — fully matches the original ask, gives the friendliest editing experience, could add validation (test SMTP send, test bot token) that neither A nor B offers. Sacrifices — this is a single-operator, no-inbound-ports-today home-lab deployment (per research.md), so a web server is a deliberate, non-trivial change to that security posture for a convenience gain that mostly restates "I don't want to open a text editor." It also reopens exactly the class of mistake already found and fixed in this assessment: a real secret (the Telegram bot token) has already ended up in plaintext in this repo once (`Telegram.md`); rendering secrets in a browser without careful design risks repeating that pattern in a new form.
- **Rabbit holes**: authentication design and threat model (LAN-only? reverse proxy? who else can reach it?); secrets-in-browser handling (masking, encryption at rest, "reveal" flows); same-container-vs-new-container and its compose/network implications; the temptation to keep adding "just one more" admin feature until this becomes a small product instead of a home-lab config fix.

## Recommendation

**Option A.** Problem.md's goals and success metrics are all about closing one specific, already-diagnosed gap (`notifier-listener`'s config being frozen at boot) and about *not* introducing a new secrets-hygiene incident. Option A satisfies both directly, at the smallest possible appetite, with no new attack surface and no new secrets-handling design to get wrong. It does **not** deliver the browser UI literally requested in intake.md — that trade-off should be made consciously at `/speckit-assess-decide`, not assumed away here. If, after seeing this, the maintainer still wants a friendlier editing surface for its own sake (not because of the restart problem, which A already solves), Option B is the next smallest step before considering Option C.

## Out of Scope (for the recommended option)

- Any browser/web UI.
- Editing SMTP or Actual Budget credentials, or the cron schedule — these remain on the existing `.env`/`crontab.txt` + restart workflow (already a non-goal in problem.md; the cron path already live-reloads `.env` with zero restart, and `crontab.txt` only needs a plain restart, not a rebuild).
- Any new container, new inbound port, or new authentication surface.
- Multi-operator access control.

## Assumptions to Validate

- No second user/operator is expected to need this in the near-to-mid term; if that assumption breaks, Option B or C becomes more attractive.
- The maintainer is fine continuing to hand-edit `.env` for non-listener settings — only the listener's live-reload gap is being closed by this concept.
- Re-reading `.env` (or the relevant vars) on the listener's existing ~30s poll cadence is fast and safe enough not to introduce races with the cron process's own `.env` reload, or with partial/concurrent file writes.
- Secrets can keep living in plaintext `.env` for now without a stronger secrets-management requirement emerging — if that changes, it affects all three options, not just C.
