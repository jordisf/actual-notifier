# Production Deploy Runbook

Target: home-lab Proxmox LXC with Docker + Compose. Actual Budget and
`actual_notifier` run in the **same LXC** (single host network `actual_net`),
so `ACTUAL_SERVER_URL=http://actual-budget:5006` resolves via Docker DNS.

## How the deploy works

- `src/` and `.env` are **mounted read-only** into the container — code changes
  do **not** require an image rebuild.
- The image only bakes in Node 20 + production npm dependencies.
- `data/` (SQLite state) lives on the host next to the repo and survives
  `git pull` — it is gitignored.

Rebuild the image **only** when `Dockerfile` or `package.json` changes.

## Steps (run in the LXC, from the repo directory)

```bash
# 1. Update code
git checkout master
git pull --ff-only

# 2. Recreate containers (picks up new src/ + .env; no state loss)
docker compose up -d

# 3. Post-check
docker compose ps                      # both services Up, no restart loop
docker exec actual_notifier node --check /app/src/reporte-diario.js
docker logs actual_notifier --tail 10
docker logs notifier_listener --tail 10
```

If `Dockerfile` / `package.json` changed:

```bash
docker compose build
docker compose up -d
```

## Optional: dry-run the report without waiting for 20:00

```bash
docker exec -e "TELEGRAM_DRY_RUN=true" actual_notifier node /app/src/reporte-diario.js
```

(DRY_RUN only skips the actual Telegram sends; the rest is real. For a
category allow-list test pass an extra `-e "TELEGRAM_CATEGORIES=Renta,..."`.)

## First-time / config change checklist

1. `.env` on the LXC: copy from `.env.example` and fill **prod** values:
   - `ACTUAL_*` — prod budget sync id and password
   - `SMTP_*` + `NOTIFICATION_EMAIL`
   - `TELEGRAM_BOT_TOKEN` / `TELEGRAM_GROUP_ID` — **prod** bot and group
   - `TELEGRAM_CATEGORIES=` — closed list of category names (empty = all).
     List this budget's names with:
     `docker exec actual_notifier node /app/src/dev/list-categories.js`
2. First cron run: confirm the compose network exists
   (`docker network ls | grep actual_net`) and that the Actual container is
   reachable: `docker exec actual_notifier node -e "fetch('http://actual-budget:5006/api/version').then(r=>console.log(r.status))"`.

## Gotchas (learned the hard way)

- **Rotating `TELEGRAM_BOT_TOKEN` requires resetting the poll offset.**
  `poll_offset` is a per-bot server-side counter stored in `data/notifier.db`
  (`kv` table). After swapping bots (or on a token rotation) the listener
  parks at EOF until you reset it:
  ```bash
  docker exec actual_notifier node -e "const s=require('/app/src/store');const db=s.open();console.log('before:',s.kvGet(db,'poll_offset'));s.kvSet(db,'poll_offset','0');console.log('after:',s.kvGet(db,'poll_offset'));db.close()"
  docker compose restart notifier-listener
  ```
  Not needed for a plain `git pull` deploy — only when the bot identity changes.
- **Never run two listeners with the same bot token** (e.g. dev stack against
  the prod token): `getUpdates` offsets collide (409) and callbacks get
  cross-consumed. The dev overlay uses a dedicated dev bot for this reason.
- **Prod credentials (WARNING #1 from SDD verify):** bot token and SMTP
  password must be rotated if they were ever shared with the dev environment
  before the dev-bot separation.

## Rollback

```bash
git log --oneline          # find last known-good commit
git checkout <commit>      # or git reset --hard <commit>
docker compose up -d
```

Since `data/` is host-level and schema-migrations are additive, reverting
code that did not add migrations is safe.
