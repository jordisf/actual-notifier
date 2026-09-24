# Bug Assessment: Login and set-password pages render unstyled — panel.css is session-gated

- **Slug**: login-css-session-gate
- **Created**: 2026-09-24
- **Source**: pasted text (operator observations local + prod) — follow-up to sibling bug `panel-no-response`
- **Verdict**: valid (design contract defect inherited by implementation)
- **Severity**: medium (visual/UX breakage on the two pages that only exist pre-session; no data or security impact)

## Report (verbatim or summarized)

Operator pulled the 002 layout work and redeployed:

- All 8 pages maquetated correctly **except** the login screen.
- Prod (`http://192.168.4.14:8080/login`): login renders as plain, unstyled HTML.
- Local: initially looked fine (memory of a previously-styled login), then after the 002 image rebuild local shows the **same** unstyled login. Operator confirms: "En local, he refrescado y tampoco lo veo bien. En algún momento ha estado maquetado en local, pero ya no está."

## Symptom

`/login` (and by the same code path, `/set-password`) render their HTML shell but with **no stylesheet applied**, because their `<link rel="stylesheet" href="/static/panel.css">` receives a 302 to `/login` instead of CSS — the page requesting the CSS is itself the unauthenticated page.

## Reproduction

Verified live against the local stack (image `f36747cbd4d7`, contains commit `2d37b7e`):

1. `curl http://127.0.0.1:8080/login` → **200**, HTML includes `<link rel="stylesheet" href="/static/panel.css">`.
2. `curl http://127.0.0.1:8080/static/panel.css` (no cookie) → **302 → /login** (Location header observed: `http://127.0.0.1:8080/login`, no CSS body).
3. Browser at `/login` → bare unstyled form.

Authenticated pages are unaffected (they have a valid session cookie, so the CSS `link` resolves to 200) — which is why only the two pre-session pages look broken.

## Suspected Code Paths

- `src/panel/server.js` (`/static/panel.css` route inside `createServer`) — wraps the CSS handler in `requireSession`; no cookie → 302 before any bytes are served.
- `src/panel/layout.js:57` and `:88` — **both** shells (`renderPage`, `renderAuthPage`) emit the same `<link>` to `/static/panel.css`.
- `src/panel/layout.js` `renderAuthPage` — used by `/login` and `/set-password` (`src/panel/routes/login.js`), i.e. pages that are *by definition* rendered in the unauthenticated (or bootstrap) state.
- `src/panel/routes/dashboard.js:30-35` etc. — authenticated pages, unaffected (session present at CSS-fetch time).

## Root Cause Hypothesis

**Confidence: high — measured, not inferred.**

Contract defect that the implementation faithfully followed. `specs/002-panel-basic-layout/contracts/routes.md` ("New contract 1") specifies `/static/panel.css` as `requireSession`-gated (302 to `/login` when unauthenticated), and the CSS link is shared by all 8 page shells. Two of those shells (`renderAuthPage` pages) exist **exclusively** in the logged-out state, so the gated stylesheet can never resolve for them: the browser follows the `<link>` request, gets a 302 to `/login` (navigations aside, sub-resource requests do not follow into a different document), and the page is left unstyled. The invariant I-2 (no cookie → 302 everywhere) and the "all 8 pages maquetated" goal are mutually unsatisfiable for the two auth pages while the CSS stays gated. Commit `2d37b7e` ("add page layout helpers, stylesheet, and session-guarded static route") introduced the regression; that is exactly when local stopped showing a styled login (operator's "en algún momento lo vi bien" = pre-002 image).

## Proposed Remediation

**Preferred**: exempt `/static/panel.css` from `requireSession` — serve it unauthenticated (200, same content-type and `Cache-Control: no-store`). Rationale: it contains only styling rules, no data or secrets, and login pages exposing their stylesheet is standard practice. Blast radius: one route in `src/panel/server.js` plus the contract text.

**Alternatives**:
- Serve the CSS under a public path (e.g. `/public/panel.css`) for auth pages and keep the session-gated route for others — more moving parts, no meaningful security gain, rejects the uniform `<link>` in both shells.
- Inline the stylesheet into `renderAuthPage` output only — works, but duplicates the CSS source of truth and changes HTML shape for those two pages; more churn, breaks the "single asset" invariant.

**Files likely to change**:
- `src/panel/server.js` — drop the `requireSession` wrapper on the CSS route (keep `Cache-Control: no-store`).
- `specs/002-panel-basic-layout/contracts/routes.md` — amend "New contract 1" Auth row: public, no session gate (with rationale).
- `src/dev/panel-smoke-test.js` (or equivalent dev probe) — add: `GET /static/panel.css` without cookie → `200 text/css`.
- `DEPLOY.md` — optionally: note for the record that any `src/panel/` change ships via `docker compose build config-panel && up -d config-panel` (baked image, no src bind mount) — gap surfaced during sibling bug `panel-no-response`.

**Tests to add or update**:
- Smoke-test assertion: cookieless `GET /static/panel.css` → 200 with `Content-Type: text/css; charset=utf-8` and `Cache-Control: no-store`.
- Smoke-test assertion (regression guard): cookieless `GET /login` still → 200 with 302-free document, and its HTML still links `/static/panel.css`.
- (Repo has no automated test harness; verification goes through `src/dev/panel-smoke-test.js`-style probes per repo convention.)

## Risks & Considerations

- Public stylesheet exposure: cosmetic content only (no data, no usernames, no field values). The access surface is already constrained by `PANEL_BIND_HOST` + LAN/VPN firewall. Accepted trade-off for the preferred fix.
- Contract drift: `contracts/routes.md` was the source of the defect; it **must** be amended in the same change to keep the spec-of-record honest (SC-005 regression guards rely on that file).
- Deploy pipeline: the fix lives under `src/panel/`, baked into `Dockerfile.panel` — prod requires image rebuild + recreate, not just `git pull`/`up -d`.
- `/set-password` bootstrap flow: same shell, same fix covers it; worth checking both pages visually after the fix (bootstrap page only reachable once, so verify on local before prod).

## Open Questions

- None blocking. If any future page gains secrets-derived styling, revisit the "CSS is public" premise — not applicable today.
