# Bug Assessment: Config panel appears dead — empty `curl http://localhost:8080` output

- **Slug**: panel-no-response
- **Created**: 2026-09-24
- **Source**: pasted text (terminal output from the prod LXC `/opt/actual-notifier`)
- **Verdict**: valid (access-path defect, not a code defect)
- **Severity**: medium (panel unreachable from the operator's normal working location until fixed)

## Report (verbatim or summarized)

Operator deployed to production and reports the config panel gives "no response":

```
root@finanzas:/opt/actual-notifier# docker compose up -d
 ✔ Container actual_notifier       Running
 ✔ Container notifier_listener     Running
 ✔ Container actual_notifier_panel Running
root@finanzas:/opt/actual-notifier# curl http://localhost:8080
root@finanzas:/opt/actual-notifier#
```

`docker compose up -d` shows all three containers Running (panel recreated, others healthy). The bare `curl` produced no visible output and returned directly to the prompt. No error message, no stack trace, no HTTP status shown.

**Follow-up evidence (from operator, same day):**

- On the LXC host: `curl http://localhost:8080/login` → **returns the login page** → panel process healthy locally. ✓
- From the operator's workstation on the same LAN, the rest of the stack is reachable: `http://192.168.4.14:5006/` (Actual Budget, another Docker container in the same LXC) responds (SSL warning aside, connectivity confirmed).
- `http://192.168.4.14:8080/login` → **ERR_CONNECTION_REFUSED** ("La página 192.168.4.14 ha rechazado la conexión").

## Symptom

The config panel answers on the LXC host (`localhost:8080`) but refuses connections from any other machine on the LAN (`192.168.4.14:8080` → ERR_CONNECTION_REFUSED), while the actual-budget container in the same LXC is reachable from the same workstation.

## Reproduction

1. On the LXC host: `curl -s http://localhost:8080/login` → HTML form. **Works.**
2. From the workstation browser: `http://192.168.4.14:5006/` → Actual Budget responds. **Works** (proves LXC networking to LAN is fine).
3. From the workstation browser: `http://192.168.4.14:8080/login` → **ERR_CONNECTION_REFUSED**.

ERR_CONNECTION_REFUSED (not a timeout) means a TCP RST arrived: something actively refused on the LXC host's external interface — i.e. nothing is listening there for that port.

## Suspected Code Paths

- `docker-compose.yml` (config-panel `ports:`) — `"${PANEL_BIND_HOST:-127.0.0.1}:${PANEL_PORT:-8080}:..."` publishes the port on **127.0.0.1 only** unless `PANEL_BIND_HOST` is set. This is the root cause of the LAN refusal.
- `src/panel/server.js:62` — secondary note only: `GET /` for logged-out clients is a 302 with empty body, which is why the original bare-curl probe looked "dead".
- `DEPLOY.md` ("Config panel") — documents exactly this design: fail-closed 127.0.0.1 default (FR-005); LAN exposure requires `PANEL_BIND_HOST=0.0.0.0` plus operator firewall/ACL.

## Root Cause Hypothesis

**Confidence: high — confirmed by the follow-up evidence.**

The panel is healthy and listening inside the LXC (localhost curl works, and Actual Budget reaching the LAN proves the LXC has no blanket firewall against Docker-published ports). The only difference between port 5006 and 8080 is the compose **publish binding**: actual-budget publishes on `0.0.0.0` (LAN-reachable), while `config-panel` publishes on `127.0.0.1` by design (FR-005 fail-closed default). A loopback-only publish answers on `localhost` and sends RSTs to anything arriving on the LXC's external interface — exactly the observed `ERR_CONNECTION_REFUSED`. This is intended fail-closed behavior, not a code defect: the operator never set `PANEL_BIND_HOST` for LAN access.

## Proposed Remediation

**Preferred (config change on the prod LXC, no code change, no rebuild):**

1. In the LXC repo directory, persist the binding so every `docker compose` invocation picks it up — either in the shell profile or a `.env` file next to `docker-compose.yml` (compose auto-reads `.env` for variable substitution):
   ```
   PANEL_BIND_HOST=192.168.4.14     # tighter than 0.0.0.0 — binds the LAN interface only
   ```
   Prefer the LXC's LAN IP over `0.0.0.0` if possible: it excludes non-LAN interfaces outright instead of relying only on the firewall.
2. Recreate the service: `docker compose up -d config-panel`
3. Verify from the workstation: `http://192.168.4.14:8080/login` → login page.
4. Keep the LXC firewall/ACLs so only the LAN or VPN can reach 8080 — per `DEPLOY.md`, the panel must **never** be exposed to the internet. The panel itself does no network filtering.

**Alternative:** SSH tunnel per `DEPLOY.md` (`ssh -L 8080:127.0.0.1:8080 finanzas`, then `http://127.0.0.1:8080/login` in a local browser). Zero exposure surface, zero prod config change — but a tunnel for every access session instead of one firewall-managed port. Trade-off: convenience vs. permanent listening surface.

**Files likely to change**: none in the repo (prod-side env config). Optionally `DEPLOY.md` could gain a worked LAN-exposure snippet if the team wants it documented as the standard path.

**Tests to add or update**: none — no code changes. Manual verification from the workstation is the acceptance check.

## Risks & Considerations

- Opening 8080 to the LAN is a **real, deliberate exposure increase** on a config panel that can rewrite `.env`, `crontab.txt`, and trigger credential flows. Firewall/ACL to LAN/VPN-only is mandatory, not optional.
- If the LXC is multi-homed (e.g. a VPN interface), bind the specific LAN IP (`192.168.4.14`) rather than `0.0.0.0` so the non-LAN interfaces stay closed without firewall rules.
- Compose reads `PANEL_BIND_HOST` from the calling shell / project `.env` at `up` time — setting it once in an interactive shell is not persistent; use a file.
- First-browser-access caveat: if no password was ever set (bootstrap never completed), the first form hit is the bootstrap login and proceeds to `/set-password` exactly once.

## Open Questions

- ~~Was the operator's goal curl or browser?~~ **Resolved**: browser from the workstation; localhost curl works, LAN refused.
- ~~Was the image stale?~~ **Resolved**: no — the panel process is demonstrably serving (localhost `/login` returns the form).
- [NEEDS CLARIFICATION: does the LXC have a VPN or other non-LAN interface? Determines `PANEL_BIND_HOST=192.168.4.14` vs `0.0.0.0`.]
- [NEEDS CLARIFICATION: is LAN exposure preferred over SSH tunnel for ongoing use? Determines preferred vs alternative remediation.]
