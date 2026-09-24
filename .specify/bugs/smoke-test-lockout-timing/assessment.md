# Bug Assessment: Smoke test #10 asserts 423 on 5th failure; implementation returns 423 from the 6th

- **Slug**: smoke-test-lockout-timing
- **Created**: 2026-09-24
- **Source**: discovered during `login-css-session-gate` fix (fresh-DB smoke run); evidence in `.specify/bugs/login-css-session-gate/fix.md`
- **Verdict**: valid (test defect — the suite cannot pass end-to-end on a clean DB as written)
- **Severity**: low (no user-facing impact; it is a false-red that undermines the panel's only automated regression gate)

## Report (verbatim or summarized)

While fixing `login-css-session-gate`, the smoke suite ran in a throwaway container with a fresh `DATA_DIR` (port 8099):

```
OK: GET /login bootstrap notice
...
OK: POST /login correct password succeeds
TEST_FAILED AssertionError [ERR_ASSERTION]: expected 423 on 5th failure, got 401
  401 !== 423
  at main (/tmp/smoke.js:92)
```

Assertions 1–9 pass; #10 (lockout) fails deterministically.

## Symptom

`src/dev/panel-smoke-test.js` test #10 expects the **5th** consecutive wrong-password POST to `/login` to return `423`; the implementation returns `401` for that request and only starts returning `423` from the **6th** request onward.

## Reproduction

1. Fresh throwaway panel (clean `DATA_DIR`) on port 8099.
2. Run the suite (`node src/dev/panel-smoke-test.js` against it).
3. After test 9's successful login resets `panel_login_failures` to 0, the 5-iteration wrong-password loop drives the counter 1→2→3→4→5.
4. On the 5th failure the implementation sets `panel_lockout_until` **and still responds 401** for that request → assertion fails: `401 !== 423`.

The arithmetic is deterministic given a clean DB — no state-dependence.

## Suspected Code Paths

- `src/dev/panel-smoke-test.js:88-98` — test #10: `for (let i = 0; i < 5; i++)` then `assert.strictEqual(r.status, 423, 'expected 423 on 5th failure')`.
- `src/panel/routes/login.js:87-92` — `isLockedOut(db)` check at the **top** of the handler: 423 is only issued when a *prior* request already set `panel_lockout_until`. Correct request that trips the threshold gets 401.
- `src/panel/routes/login.js:105-115` — failure path: increments `panel_login_failures`; when it reaches `LOCKOUT_THRESHOLD` (5) it sets `panel_lockout_until` and **still returns 401 for the current request**.
- `specs/001-config-webapp/spec.md` FR-015 — "MUST throttle or lock out **further** login attempts after repeated failures".

## Root Cause Hypothesis

**Confidence: high — verified by code read, git provenance, and a live fresh-DB run.**

Test defect, not implementation defect. FR-015 says lock out *further* attempts *after* repeated failures: the implementation (423 from attempt N+1, with attempt N = the 5th failure already rejected 401 and setting the lockout) is a faithful reading. The test encodes a stricter reading (the Nth failing attempt itself must already be 423 — which would require the threshold to be checked *before* the increment at 4). `git log` proves the test shipped in this exact form in `8964c92` (001 MVP) alongside that same implementation, so the suite has **never** passed end-to-end on a clean DB. Consequence: the panel's only automated smoke gate has a permanent false-red, which desensitizes anyone running it — exactly the moment (during the `login-css-session-gate` fix) when it would have caught a real problem.

## Proposed Remediation

**Preferred**: fix the **test**, not the code — keep the FR-015-compliant semantics:

- Test #10 becomes: loop of 5 wrong passwords asserting `401` on each (threshold trips on the 5th, still 401), then one **6th** request (correct password) asserting `423`. Update the comment to state the semantics: "lockout enforced from the request *after* the 5th consecutive failure (FR-015: 'further attempts')".
- Optionally tighten: assert the 5th response body does not contain the lockout error text while the 6th does — cheap, pins the boundary precisely.

**Alternatives**:
- Change the implementation to issue 423 on the 5th attempt (check threshold pre-increment or re-check after set). Trade-off: defensible ("5 strikes = 423"), but it means the 5th user attempt returns a different code than the 4th, which leaks "you are about to be locked out" one attempt earlier — classic lockout-oracle hardening argues for *not* doing that. Also changes production-observed behavior for a test's sake.
- Leave both as-is and document the suite as known-red. Trade-off: keeps the false-red forever; worst of both worlds.

**Files likely to change**:
- `src/dev/panel-smoke-test.js`

**Tests to add or update**:
- The change *is* the test update (assertions 1–9 and 11–14 untouched).

## Risks & Considerations

- Low change surface (dev-only test file); no deploy/rebuild impact beyond the next `docker compose build config-panel` if you want the image in sync.
- Do not "fix" by weakening the 423 assertion into `assert.ok([401,423].includes(...))` — that hides the boundary instead of pinning it.
- When the fix lands, re-run the whole suite to confirm it reaches `ALL_PANEL_HTTP_TESTS_PASSED` end-to-end for the first time.

## Open Questions

- None blocking. If the team later wants the stricter "5th attempt already 423" semantics, that is a product/security decision (FR-015 revision), not a test convenience — out of scope here.
