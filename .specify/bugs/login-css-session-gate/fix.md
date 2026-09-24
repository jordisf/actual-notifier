# Bug Fix: Login and set-password pages render unstyled — panel.css made public

- **Slug**: login-css-session-gate
- **Fixed**: 2026-09-24
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Exempted `GET /static/panel.css` from `requireSession` so the two pre-session pages (`/login`, `/set-password`) receive their stylesheet, and amended the 002 contract + quickstart that had codified the defective gate.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `src/panel/server.js` | modified | CSS route no longer wrapped in `requireSession`; comment documents why |
| `specs/002-panel-basic-layout/contracts/routes.md` | modified | Contract 1 Auth row: `requireSession`-gated → **public**, with fix rationale |
| `specs/002-panel-basic-layout/quickstart.md` | modified | Scenario 1 step 4 expectation: 302 → `200` (public asset) |
| `src/dev/panel-smoke-test.js` | modified | New assertions #13 (cookieless CSS → 200 text/css, no-store) and #14 (`/login` links the CSS) |

## Diff Highlights (optional)

```js
// src/panel/server.js — before
router.get('/static/panel.css', (req, res) => {
  requireSession(req, res, (req2, res2) => { /* serve css */ });
});
// after
router.get('/static/panel.css', (req, res) => { /* serve css directly, no gate */ });
```

## Tests Added or Updated

- `src/dev/panel-smoke-test.js` #13 — `GET /static/panel.css` without cookie → `200`, `Content-Type: text/css; charset=utf-8`, `Cache-Control: no-store` (regression guard for this bug).
- `src/dev/panel-smoke-test.js` #14 — `GET /login` body still contains `<link rel="stylesheet" href="/static/panel.css">`.

## Local Verification

- Rebuilt + recreated panel image locally (`docker compose build config-panel && up -d`) → container `Recreated`, `Up`.
- Host probe: `GET /static/panel.css` cookieless → `200 text/css; charset=utf-8` (previously `302 → /login`). ✓
- Smoke suite run in a throwaway container on the rebuilt image (fresh `DATA_DIR`, port 8099):
  - **Assertions 1–9 PASS** (bootstrap flow, sessions, credential set, login ok/bad).
  - **Assertion #13 equivalent (CSS public) — VERIFIED directly**: `css: 200 text/css; charset=utf-8 no-store`, `login links css: true`. ✓
  - **Assertion #10 (lockout 423) FAILED — pre-existing test bug, deterministic on a fresh DB (see Deviations).** Not caused by this change; the lockout code path was not touched.
- Manual: local browser at `http://127.0.0.1:8080/login` — login page now **maquetada** (styled, centered card) after hard refresh. ✓

## Deviations from Assessment

- The assessment's planned smoke-test assertion #13 passed, and its regression guard passed in isolation, but the **full smoke suite cannot complete end-to-end** due to a pre-existing defect in test #10 itself (details below). Not fixed here to keep this change minimal, per the assessment's guardrail. Documented with evidence for a new bug:
  - **Evidence (fresh `DATA_DIR`, throwaway container)**: after test 9's successful login resets `panel_login_failures` to 0, the 5-iteration loop drives the counter 1→4→5. On the 5th failure the implementation sets `panel_lockout_until` **and still returns 401 for that request** (`src/panel/routes/login.js:105-115`); the 423 is issued on the *next* request. The test asserts `423` as the loop's final response → `401 !== 423`.
  - **Git provenance**: `src/dev/panel-smoke-test.js` was introduced verbatim (lockout assertion included) in `8964c92` (001 MVP); this fix only appended tests #13/#14. The suite has therefore **never passed end-to-end as written** on a clean DB — it was evidently run/passed on a non-clean DB (counter already ≥1, so the 4th loop iteration trips the threshold and… still returns 401 — or the passing environment differed; either way the as-written expectation does not match the as-written implementation).
  - **Spec reading**: FR-015 (001) says "MUST throttle or lock out *after* repeated failures" — the implementation (423 from attempt N+1 after N failures) is compliant; the test encodes a stricter "attempt N itself returns 423" reading.
- No other deviations.

## Follow-ups

1. **New bug (candidate slug `smoke-test-lockout-timing`)**: `panel-smoke-test.js` #10 expects 423 on the 5th consecutive failure; implementation returns 423 from the 6th. Decide the contract (423-on-Nth vs 423-on-N+1th) against FR-015 and fix the test — or the code — in a dedicated change. The suite is currently a false-red for any future fix that needs it.
2. **Prod deploy (operator step)**: on the LXC — `git pull --ff-only && docker compose build config-panel && PANEL_BIND_HOST=192.168.4.14 docker compose up -d config-panel`, then hard-refresh `http://192.168.4.14:8080/login`.
3. **DEPLOY.md gap** (surfaced in sibling bug `panel-no-response`): document that any `src/panel/` change ships via `docker compose build config-panel` (baked image, no src bind mount). Not done in this fix to keep scope tight.
