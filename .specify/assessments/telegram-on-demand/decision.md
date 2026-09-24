# Decision: Comando on demand /report en el grupo de Telegram — GO

- **Slug**: telegram-on-demand
- **Decided**: 2026-09-24
- **Revised**: 2026-09-24 (clarify round: user confirmed the categorize→re-report loop as the dominant use case, accepted re-send/re-expiry, selected Option A over B)
- **Verdict**: go
- **Artifacts reviewed**: intake.md ✓ | research.md ✓ | problem.md ✓ | concept.md ✓

## Scorecard

| Criterion | Rating | Justification |
|-----------|--------|---------------|
| Problem validity | strong (revised from adequate) | No group-chat path to the report/pending list outside the 20:00 cron, plus a discoverability gap — and now **confirmed observed behavior**, not just stated need: after categorizing, the user's balances change and they routinely re-request the recalculated report ("bastante habitual", user 2026-09-24). |
| Evidence strength | adequate (unchanged) | Internal codebase evidence is high-confidence and directly cited (listener polls only `callback_query`; no command handling exists; `compute()` re-entrant **and re-reads current Actual balances on every call** — src/report.js:149-157; D6 `expirePreviousPending` amplification; 60-min sync throttle; D4/D5 "evolve later" prior art). External/platform evidence (Bot API `setMyCommands`, `message` updates over the raw-fetch client) is explicitly marked assumption and is falsifiable cheaply before implementation. |
| Value vs. inaction | adequate (unchanged) | Cost of inaction is low and bounded (documented manual `docker compose exec` fallback) — but the chosen option A cost is days, and it directly serves a confirmed high-frequency loop. Value > cost with a comfortable margin; not transformative, which is fine for a homelab tool. |
| Feasibility / appetite | strong (scope tightened to option A) | Chosen option A is **small** (days). All required building blocks already exist or are thin deltas: one handler in the existing poll loop, one `allowed_updates` extension, one menu registration. No new services, no schema migration, no behavior-guard state. |
| Strategic fit | strong (unchanged) | This is the *designed-for* evolution of the v1 Telegram spec: D4 ("keep action layer generic") and D5 ("no free-text in v1, evolve later") explicitly anticipated this. It consumes existing decisions (D1 group-only, D3 any-member, D6 expiry, D7 homelab/no exposure) without contradicting any of them. |
| Risk posture | adequate (revised from strong) | Major risks are identified in research and **explicitly accepted by the user** (2026-09-24) rather than engineered around: D6 repeated button expiry on repeated `/report` (accepted), re-sent message spam in the group (accepted), stale bank-sync line inside the 60-min window while balances are correctly fresh — user confirmed the missing sync is irrelevant for their loop; the existing "omitido (hace X min, umbral 60)" summary line is the residual mitigation. A cooldown is **excluded** because it would block the dominant categorize→re-report use case. Trust scope unchanged from D3. Assumption #1 (raw-fetch client + setMyCommands) has a named cheap falsifier before code. Note: a `strong` rating here would have required active mitigation; the honest rating for *user-accepted* risk in a single-user homelab group is `adequate`. |

No criterion is rated `unknown`. The clarify round REMOVED open uncertainty rather than adding it: the dominant use case (categorize→re-report) is now confirmed, and the residual decisions (empty-report behavior) are cosmetic defaults carried into specify.

## Verdict & Rationale

**GO.** The idea passes the gate on every mandatory dimension, and the clarify round STRENGTHENED it: problem validity rose from adequate to strong once the user confirmed the dominant use case is OBSERVED behavior — the categorize→re-report loop, driven by `compute()` re-reading current Actual balances on every call rather than the bank sync. Evidence remains adequate (cited internal code; the only external assumptions have a cheap pre-implementation falsifier), and the chosen path — option A: a single `/report` group command registered in the command menu, with no behavior floor — is the smallest credible shape (days) and the one the user selected after seeing the trade-offs. Strategically it is the continuation the v1 Telegram design explicitly reserved (D4/D5).

What the clarify round also settled: the risks the research flagged around on-demand execution (D6 repeated button expiry, re-sent messages, stale bank-sync line) are **explicitly accepted by the user**, and a cooldown was rejected because it would block the feature's main use. Risk posture is therefore honestly rated `adequate` (accepted, documented) rather than `strong` (engineered-mitigated). The residual counter-argument — "discoverability alone could be solved cheaper" — no longer applies, since the user confirmed they want the execution path itself.

## If go — Handoff to `/speckit-specify`

- **Problem**: The user can only see the Actual Budget report / pending-categorization list at the 20:00 daily run (or via manual server exec); after categorizing transactions the balances change and the user routinely needs the recalculated report, in-chat and without the server. The request syntax is also undiscoverable if naively added ("puedo no acordarme del comando").
- **Chosen approach**: Concept Option A — a single `/report` group command registered via `setMyCommands`, delivering the same report + pending-transaction messages as the daily run (`compute()` + `sendReport()`), **without a cooldown or behavior floor**: repeated invocations re-send and re-expire previous pending buttons (D6), which the user has explicitly accepted as the behavior their categorize→re-report loop requires.
- **Accepted risks (do NOT redesign around these)**: group message spam on repeated triggers; D6 button re-expiry on each delivery; the bank-sync line being stale inside the 60-min window (balances are fresh; the existing "omitido (hace X min, umbral 60)" summary omission is sufficient — no new stale-state UI).
- **In scope**: text-`/report` handling in the existing listener (extend `allowed_updates` to include `message`), `setMyCommands` registration, reuse of `compute()` / `sendReport()`. **Out of scope** (per concept.md + clarify round): cooldown/rate limiting (rejected — it blocks the dominant use case), free-text chat, categorization-authorization changes (D3), per-user config/roles, panel UI, cron cadence changes, email changes, DMs (D1), any second command such as `/pendientes`.
- **Success metrics**: M1 < 1 min wall-time from request to visible report, zero server interaction; M2 user requests successfully after ≥ 1 week without docs (discovery via client "/" menu); M3 store consistency after ≥ 10 on-demand requests (no orphan pending rows, no expired-but-active buttons — re-expiry itself is expected); M4 the summary line never implies a fresh bank sync that did not happen.
- **Carried-forward open questions**:
  - Empty-report behavior: acknowledge briefly ("todo al día") vs. silent — default: acknowledge briefly.
  - Confirming "notificaciones de pendientes" means the full interactive list (current `sendReport` behavior) — default: yes.
  - Any-member trigger vs. restricted set — default: any member, consistent with D3.
  - Validation first: smoke-test `setMyCommands` + `message` updates against the raw-fetch client (assumption #1 in concept.md) before handler work.
