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
git checkout main
git pull --ff-only

# 2. Recreate containers (picks up new src/ + .env; no state loss)
docker compose up -d

# 3. Post-check
docker compose ps                      # all services Up, no restart loop
docker exec actual_notifier node --check /app/src/reporte-diario.js
docker logs actual_notifier --tail 10
docker logs notifier_listener --tail 10
docker logs actual_notifier_panel --tail 10
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

## Config panel (config-panel)

- Served on `127.0.0.1:${PANEL_PORT:-8080}` by default. Reach it via SSH
  tunnel: `ssh -L 8080:127.0.0.1:8080 <lxc>`, then open
  `http://127.0.0.1:8080` in a browser.
- To expose it on the LAN instead: set `PANEL_BIND_HOST=0.0.0.0` in the
  environment and keep the LXC firewall / network ACLs so only LAN or VPN
  can reach that port. **Never expose it to the internet.**
- First boot: open the panel once — the login form is in bootstrap mode
  (no password). Set the username (default `admin`) and a strong password.
  This can only happen **once**; the bootstrap flag is gone after the first
  password is stored in `data/notifier.db` (kv table).
- The panel writes `./.env` and `./crontab.txt` on the host (mounted
  `:rw` into the panel only; the other services keep `:ro` mounts).
  `notifier-cron` picks up `.env` on its next run, the crontab is
  re-installed by the mtime watcher in `entrypoint.sh` (~10s), and
  `notifier-listener` reloads the four `TELEGRAM_*` values on every poll —
  **no container restarts needed** for any panel edit.

## Gotchas (learned the hard way)

- **First upgrade from the old single-service compose (one-time conflict).**
  The old compose ran one service `actual-notifier` with
  `container_name: actual_notifier`. The new compose creates
  `notifier-cron` with the **same** container name — compose sees the old
  container as an orphan (different project) and fails with
  `Conflict. The container name "/actual_notifier" is already in use`.
  It is safe to remove (state lives in host `data/` and `.env`):
  ```bash
  docker rm -f actual_notifier
  docker compose up -d --remove-orphans
  ```
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
- **Config panel reachability is operator-managed.** Compose only defaults
  the bind to 127.0.0.1 (fail-closed). If you set `PANEL_BIND_HOST=0.0.0.0`,
  the LAN/VPN-only restriction is **your** responsibility (firewall/ACL);
  the panel itself has no network filtering.
- **Panel password reset (no recovery UI).** To force the bootstrap flow
  again, delete the hash while the panel is down:
  ```bash
  docker stop actual_notifier_panel
  docker exec actual_notifier node -e "const s=require('/app/src/store');const db=s.open();s.kvSet(db,'panel_password_hash',null);db.close()"
  docker start actual_notifier_panel
  ```

## Rollback

```bash
git log --oneline          # find last known-good commit
git checkout <commit>      # or git reset --hard <commit>
docker compose up -d
```

Since `data/` is host-level and schema-migrations are additive, reverting
code that did not add migrations is safe.
