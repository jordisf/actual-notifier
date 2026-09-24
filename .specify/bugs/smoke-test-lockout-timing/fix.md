# Bug Fix: Smoke test #10 lockout timing — test now matches FR-015 semantics

- **Slug**: smoke-test-lockout-timing
- **Fixed**: 2026-09-24
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Fixed the test, not the code: `panel-smoke-test.js` #10 now asserts 5 consecutive 401s (lockout armed on the 5th) and a 423 on the 6th request, matching the implementation's FR-015-compliant "lock out *further* attempts" semantics. The suite now passes end-to-end for the first time on a clean DB.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `src/dev/panel-smoke-test.js` | modified | Test #10 rewritten: loop asserts 401 per attempt, new assertion = 6th request → 423 even with correct password; comment pins the FR-015 reading |

No code changes. `src/panel/routes/login.js` left untouched — its behavior (401 on the 5th failure, 423 from the 6th) is the FR-015-compliant behavior the assessment judged correct.

## Diff Highlights (optional)

```js
// before
for (let i = 0; i < 5; i++) { r = await fetch(...wrongpass); }
assert.strictEqual(r.status, 423, `expected 423 on 5th failure, got ${r.status}`);

// after
for (let i = 0; i < 5; i++) {
  r = await fetch(...wrongpass);
  assert.strictEqual(r.status, 401, `failure #${i + 1} should be 401`);
}
// 6th request, correct password:
assert.strictEqual(r.status, 423, 'correct password should still be rejected while locked out');
```

## Tests Added or Updated

- `src/dev/panel-smoke-test.js` #10 (a) — 5 consecutive wrong-password POSTs each return 401 (pins: the threshold trip on the 5th does not itself change the response code — no lockout oracle).
- `src/dev/panel-smoke-test.js` #10 (b) — 6th request with the **correct** password returns 423 (pins: lockout engages from N+1 and is not password-aware).

Assertion shape was not weakened to `[401,423].includes(...)` — the boundary is pinned exactly, per the assessment's explicit guardrail.

## Local Verification

- Throwaway container, fresh `DATA_DIR` (`/tmp/smoke-data`), port 8099, image `actual-notifier-config-panel` (already rebuilt with the `login-css-session-gate` fix):
  - `node /tmp/smoke.js` → **all 15 assertions PASS**, final line `ALL_PANEL_HTTP_TESTS_PASSED`. First end-to-end green run of this suite in repo history (it shipped never-green in `8964c92`).
- No rebuild needed for prod to pick up: this file is under `src/dev/` and is not referenced by any runtime path; it ships in the image only incidentally. The runtime behavior is byte-identical to the prior image.

## Deviations from Assessment

None. The assessment's preferred remediation (fix the test; keep the code) was applied as specified.

## Follow-ups

- Optional: the other post-423 assertion from the original test (correct-password-while-locked 423) is now the 6th-request assertion itself — no redundant check lost.
- Optional (nice-to-have, out of scope): a positive boundary test — wait/expire `panel_lockout_until` (kv set to past date via dev probe) and assert login succeeds again. Would pin the 15-minute cool-down; currently only the entry to the lockout is covered.
