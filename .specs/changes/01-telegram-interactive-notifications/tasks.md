# Tasks — 01: Telegram Interactive Notifications

> **Change**: 01-telegram-interactive-notifications · **Phase**: tasks · **Date**: 2026-09-20
> **Inputs**: proposal (§7 decisions D1–D11), design (all sections incl. §12/§12A).
> **Stack**: Node 20, CommonJS, no build step, **zero new runtime deps** (P9: bare Bot API over global fetch; do NOT add grammy/telegraf).
> **strict_tdd**: FALSE — no test runner. Checks = `node --check` syntax, `docker compose config`, dev-stack functional verification per design §12/§12A.
> **Delivery**: `auto-chain`, PR budget 400 authored lines/slice. `chain_strategy`: `feature-branch-chain` (user-chosen 2026-09-20). Tracker branch: **`master-add-telegram`** (existing branch holding proposal + dev environment; current HEAD). Slice branches fork from the tracker: `slice/01-s1-...` → PR#1 targets `master-add-telegram`; each later slice branch forks from the previous slice branch and its PR targets the previous slice branch; only `master-add-telegram` eventually merges to `master` when the whole feature is validated.
> **Commits**: Conventional Commits only; no AI/Co-Authored-By attribution.

## Carry-in bindings (from design gatekeeper — non-negotiable)

| # | Binding | Bound to |
|---|---------|----------|
| CI-1 | Verify the exact `@actual-app/api@26.8.1` write-back method for a transaction's category BEFORE any write-back code. Evidence on hand: `actual-budget/seed-data/seed.js` uses `api.updateTransaction(txId, {...})` (transfer/split fields), so the expected call is `api.updateTransaction(tx.id, { category: categoryId })`. Confirm against the installed library (host `npm install` if `node_modules` absent, or read `node_modules/@actual-app/api` exports). Record the confirmed method name in apply-progress. | **T0** (hard gate for T5) |
| CI-2 | The listener's Actual `dataDir` is explicitly `LISTENER_DATA_DIR=/tmp/actual-listener-cache` — a separate env var and path, never conflated with the cron `/tmp/actual-cache`, never conflated with the SQLite `DATA_DIR`/`/app/data`. | **T1** (env in `actual.js`), **T5** (usage in `listener.js`/`categorize.js`) |
| CI-3 | The dismiss button (ref `"-"` / `🚫 Sin categorizar`) is **forced onto its own final keyboard row**, never mixed with category buttons, regardless of row-fill state. | **T4** (keyboard assembly in `send.js`) |

## Tasks

### T0 — Apply entry gate: confirm Actual API write-back method

- **Files touched**: none (verification only; result recorded in apply-progress).
- **What**: Resolve CI-1 first. Inspect installed `@actual-app/api@26.8.1` (exports of `updateTransaction`, any dedicated set-category helper); cross-check `seed.js` usage (`api.updateTransaction(legMinus, { transfer_id: legPlus })` proves the `{txId, fields}` signature). Confirm the exact call for category write-back (expected `api.updateTransaction(txId, { category: catId })`) and its field name (`category` = category **id**). If `node_modules` is absent on host, `npm install --omit=dev` in a throwaway copy — repo `package.json` is NOT modified.
- **Checks**: `node -e` smoke against dev Actual (optional if dev stack is up): load the lib, log that the method exists and its type; record method name + signature in apply-progress.
- **Est. authored lines**: ~0.
- **Depends on**: nothing. **Blocks**: T1 (signature of `applyCategoryChange`) and **hard gate** for T5.

### T1 — `log.js` + `actual.js` (Actual lifecycle wrapper)

- **Files touched**: `src/log.js` (NEW), `src/actual.js` (NEW).
- **What**: Per design §10 and §2/§6.
  - `log.js`: `log(level, service, msg, fields?)` → single-line JSON `{ts, level, service, msg, ...}` to stdout. `service` ∈ `cron`|`listener`.
  - `actual.js`: `open(dataDir)` → `{api}` (`api.init` + `api.downloadBudget(process.env.ACTUAL_SYNC_ID)`); `close(api)` (`api.shutdown`); `getUncategorizedTxs(api, month)` (step-2 logic: on-budget, non-transfer, parent-filtered — verbatim semantics from `reporte-diario.js`); `getCategories(api)` (non-income only, with ids); `applyCategoryChange(api, txId, categoryId)` using the T0-confirmed method. CI-2: dataDir for the listener must come from the `LISTENER_DATA_DIR` env (default `/tmp/actual-listener-cache`) — do NOT default to `/app/data`.
- **Checks**: `node --check src/log.js src/actual.js`; dry smoke: against dev stack, one open → fetch uncategorized (expect exactly **2** txs per §12A invariant: `Nomina empresa +195.00`, `Compra suelta -15.00`) → close.
- **Est. authored lines**: ~100 (15 + 85).
- **Depends on**: T0 (for `applyCategoryChange`'s exact call; the rest of the module can be written with the expected name and finalized after T0).

### T2 — `store.js` (SQLite persistence)

- **Files touched**: `src/store.js` (NEW).
- **What**: Per design §5. `better-sqlite3` (already in image), file from `DATA_DIR` env (default `/app/data`), `fs.mkdirSync(DATA_DIR, {recursive:true})` on open. Pragma WAL + `busy_timeout=5000` + `foreign_keys=ON`. Idempotent DDL exactly per §5.1 (`reports`, `interactions`, `answers`, `kv` + index). API: report insert; `insertInteraction` (+ returns id → `item_ref` = base36 of id); `findInteractionByItemRef`; `claimAnswer` (guarded `UPDATE … WHERE status='pending'`, `changes()===1` = won, loser re-reads winner — §5.3, byte-for-byte semantics); `recordApplied`; `rollbackToPending`; `logAnswer`; `get`/`set` kv (`poll_offset`); `expirePreviousPending(beforeReportId)` (guarded UPDATE, counts rows, returns just-expired rows for the §9 edit pass); `answersRetentionSweep()` (90-day, one pass, §5.1).
- **Checks**: `node --check src/store.js`; smoke: temp `DATA_DIR` → open → assert 4 tables via `sqlite_master`; insert a fake report + interaction → `claimAnswer` twice → first `won:true`, second `won:false` with winner visible; `expirePreviousPending` flips a second generation.
- **Est. authored lines**: ~130.
- **Depends on**: nothing (pure module; used by T3/T4/T5).

### T3 — `report.js` extraction + `reporte-diario.js` shrink (behavior-preserving)

- **Files touched**: `src/report.js` (NEW), `src/reporte-diario.js` (SHRUNK 320 → ~90).
- **What**: Per design §2/§7. Move steps 1–3 of the current monolith VERBATIM-semantics into `report.compute(api)`: bank-sync 60-min throttle (stdout-suppression trick included), uncategorized detection, target-category balances + overspend sweep → plain `ReportData` `{syncOk, syncMensaje, mesActual, diasRestantes, transaccionesSinCategorizar, datosConsumo, categoriasNegativas}`. `reporte-diario.js` becomes orchestrator for now: dotenv `override:true` → `actual.open('/tmp/actual-cache')` → `report.compute` → existing HTML render + SMTP (kept verbatim, `reports.email_sent` semantics) → `actual.close` → exit 0/1 contract unchanged (email failure → exit 1). Log lines switch to `log.js` with `service:'cron'`. Telegram + store rows NOT yet (that is T4) — but keep `reporte-diario.js` shaped so T4 appends steps 6–8 cleanly.
- **Checks**: `node --check` both files; dev-stack run `node src/reporte-diario.js` → Mailpit `http://localhost:8025` shows the email **pixel-identical in structure and numbers** to the pre-refactor baseline (early SC7 / §12 step 9 check — this is the refactor-regression gate); uncategorized count still exactly 2.
- **Est. authored lines**: ~340 (report.js ~120 add + reporte-diario.js ~120 del / ~100 add, net churn from the move).
- **Depends on**: T1 (uses `actual.js`/`log.js`).

### T4 — `telegram/bot.js` + `telegram/send.js` + cron delivery wiring

- **Files touched**: `src/telegram/bot.js` (NEW), `src/telegram/send.js` (NEW), `src/reporte-diario.js` (wiring), `.env.example` (+Telegram block).
- **What**: Per design §3.1, §4, §7, §8, §9.
  - `bot.js`: bare Bot API over global fetch — `request(method, params)`, `sendMessage`, `answerCallbackQuery`, `editMessageText`, `getUpdates`; 429 → honor `retry_after` once then throw; `TELEGRAM_DRY_RUN=true` short-circuits all calls (log + fake results, `message_id:-1`).
  - `send.js`: summary message (no keyboard, §4.4) + one interactive message per uncategorized tx (cap `TELEGRAM_MAX_TX_MESSAGES`, default 15, oldest first); keyboard = category buttons (8/row wrap, labels truncated 97+`…`) with **CI-3: dismiss forced onto its own final row**; `callback_data` = `v1:<itemRef>:[idx|-]` per §4.1 (≤64 bytes); `button_rows_json` captured at delivery; per-tx: `sendMessage` → `store.insertInteraction` (failure ⇒ skip tx, never invisible — it stays in summary/email); returns `{reportId, sent, failed}`. Exports `buildKeyboard`/message builders so T7 (replay helper) and tests can reuse them.
  - `reporte-diario.js` step 6–9 wiring (§7 order): reports row → TELEGRAM block in ONE try/catch (failure ⇒ `log` error, `telegram_*=0`, run still exits 0) → EXPIRY (guarded `expirePreviousPending` then best-effort edit-with-footer per just-expired row, individual try/catch) → `answersRetentionSweep` → shutdown. Empty/missing `TELEGRAM_BOT_TOKEN` or `TELEGRAM_GROUP_ID` ⇒ log warn + skip Telegram entirely (email-only mode, old deployment safe).
  - `.env.example`: add the exact §8 block (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `TELEGRAM_MAX_TX_MESSAGES`, `TELEGRAM_POLL_TIMEOUT`, `TELEGRAM_DRY_RUN`, `DATA_DIR=app` + comment that token/group changes require `docker compose restart notifier-listener`).
- **Checks**: `node --check` new/changed files; `.env.example` consistent (no real secrets); dev-stack **dry run** (§12 steps 1–2): `TELEGRAM_DRY_RUN=true`, run delivery → logged (not sent) summary + **exactly 2** interactive messages; `sqlite3 ./data/notifier.db .schema` shows all tables; `interactions` rows have `tg_message_id=-1`, `button_rows_json` = 8 dev categories + dismiss on its own row (§12A target 2); `reports` row counts correct; `poll_offset` untouched.
- **Est. authored lines**: ~285 (100 + 110 + ~60 + 15).
- **Depends on**: T1, T2, T3.

### T5 — `listener.js` + `actions/` + `dev/replay-callback.js`

- **Files touched**: `src/listener.js` (NEW), `src/actions/index.js` (NEW), `src/actions/categorize.js` (NEW), `src/dev/replay-callback.js` (NEW).
- **What**: Per design §3.2, §3.4, §6.
  - `listener.js`: dotenv once at boot; long-poll loop with **offset persisted in `kv` after each processed update** (§3.2 exact pseudocode, incl. backoff 1s→30s cap); `handleUpdate` dispatcher per §3.4 (parse `v1:` refs → `store.findInteractionByItemRef` → early `answerCallbackQuery` `show_alert:true` → status switch `pending/answered/expired`); `allowed_updates:['callback_query']` only; per-update try/catch (one bad update never wedges the loop). CI-2: Any Actual access goes through `actual.open(process.env.LISTENER_DATA_DIR)` with the default `/tmp/actual-listener-cache`.
  - `actions/index.js`: `ACTION_REGISTRY = { categorize }`.
  - `actions/categorize.js`: per-invocation Actual lifecycle (§6.1): resolve `chosen_ref` via stored `button_rows_json` (**trust rule §4.1 — never trust callback alone**); `-` ⇒ dismiss, no Actual call; else `actual.open(LISTENER_DATA_DIR)` → `applyCategoryChange` (T0-confirmed method) → `finally close` → `recordApplied` / on failure `rollbackToPending` (row back to `pending`, `{detail:'failed', retryable:true}`).
  - `dev/replay-callback.js`: reads `interactions`, builds a synthetic `callback_query` (valid `item_ref`, chosen ref, fake `from`), feeds it to the exported `handleUpdate`. No network. Used by §12 steps 3–5 and §12A target 5.
- **Checks** (all dry, §12 steps 3–4):
  1. First synthetic tap → `answers` row `applied`, interaction `answered` (dismiss path: no Actual call logged).
  2. Second tap same ref → `duplicate`, winner preserved, no second `applied`.
  3. Unknown `item_ref` → `rejected` logged.
  4. Double-tap same second (two replays) → exactly one `applied` (idempotency).
  5. `kill -9` listener between runs, restart → `poll_offset` unchanged, clean boot, no crash loop.
  Plus `node --check` on all new files. **Gate**: CI-1 must be resolved (T0 recorded) before `applyCategoryChange` is finalized — do not ship this task with an unverified method name.
- **Est. authored lines**: ~315 (140 + 25 + 90 + 60).
- **Depends on**: T0 (hard gate), T2, T4 (reuses `bot.js`, `send.js` builders); T1 for `actual.js`.

### T6 — Infra: two compose services + data volume + dev overlay

- **Files touched**: `docker-compose.yml`, `dev.yml`, `README.md`.
- **What**: Per design §1, §5.4, §8, §12A.
  - `docker-compose.yml`: split `actual-notifier` into **`notifier-cron`** (current entrypoint, unchanged command) + **`notifier-listener`** (`command: node src/listener.js`, same `:ro` mounts, no ports). Both `restart: unless-stopped`, same image build, both get **NEW writable volume `./data:/app/data`** (+ `DATA_DIR=/app/data` env). Existing three `:ro` mounts untouched (F5). No `ports:` added.
  - `dev.yml`: add `notifier-listener_dev` (command `node src/listener.js`, same mounts + writable `../data` bind, `restart: no`, no ports, `depends_on` actual-server healthy + `actual-notifier` optional) mirroring production so identical code paths run in dev (§12A compose note).
  - `README.md`: updated dev bring-up (both dev services), production usage note: run `notifier-cron` only until `TELEGRAM_BOT_TOKEN`/`TELEGRAM_GROUP_ID` are set (listener is the opt-in second service); host rule "never `rm` `./data/notifier.db` while a service is up"; token rotation ⇒ `docker compose restart notifier-listener`.
  - `Dockerfile` / `entrypoint.sh` / `crontab.txt`: **no changes** (explicitly verified as a task step — the listener needs nothing new in the image; better-sqlite3 already compiled via `@actual-app/api`).
- **Checks**: `docker compose config -q` (prod file); `docker compose -f actual-budget/docker-compose.yml -f dev.yml config -q` (dev overlay); dev stack bring-up `… up -d` → both notifier services boot (listener logs "polling" lines in dry mode); `sqlite3 ./data/notifier.db .schema` succeeds (early §12 step 1).
- **Est. authored lines**: ~100 (35 + 25 + 40).
- **Depends on**: T4 (listener command references `src/listener.js` — T5 may not have landed, service still ships because `up` is explicit per-service; alternatively this task may be delayed one slice if `node src/listener.js` missing-file boot noise is unacceptable in dev bring-up — decision point for apply: if T5 is not landed, note it and skip `notifier-listener_dev` boot in this task's checks).

> **Note for apply**: T6 nominally depends on T5's file existing for a clean listener boot; with the S3/S4 split below, T6 lands in S3 and T5 in S4. In S3's checks, boot the listener service only if `src/listener.js` exists, else verify `docker compose config` + `notifier-cron` boot only, and complete the two-service boot check in S4 (T7). This keeps each slice independently sensible (work-unit invariant).

### T7 — Dev-stack end-to-end verification + final docs

- **Files touched**: `README.md` (small operational notes only); no new source.
- **What**: Execute the full verification plan on the dev stack (D11 — validation runs against the DEV Actual instance, §12A). Dev readiness: `docker compose -f actual-budget/docker-compose.yml -f dev.yml up -d`, seed done (per `odd/tasks/dev-actual-budget.md` T6 e2e — re-seed by deleting `.actual-data/` if state drifted; expected invariant: exactly 2 uncategorized + `Suscripciones −7,50` overspend).
- **Checks** (§12/§12A steps, mapped):
  1. §12.1 — dry-run boot: both services, schema OK, polling lines. (Repeat after T6's slice for the two-service boot.)
  2. §12.3/§12A.5 — replay-callback paths: applied / duplicate / rejected / dismiss (no Actual call).
  3. §12.4 — idempotency double-tap + `kill -9` offset survival (re-confirm in full stack).
  4. §12.5 + §12A.4 — expiry: second delivery run → previous run's interactions `expired`; late tap → `expired` ack, no Actual write.
  5. **§12A.3 — LIVE write-back (the strongest check)**: with a real dev Telegram group + token (or, if no bot: replay helper driving the real dispatch with the store's dev rows and a real `actual.open` write against `http://actual-budget:5006`): tap category on the `Compra suelta` message → verify in the dev Actual UI the tx moved from "Sin categoría" to the chosen category; next delivery's uncategorized count drops 2 → 1.
  6. §12.7 — `docker compose restart notifier-listener` → pending tap still applies (offset + store survived).
  7. §12.8 — failure containment: bot disabled (bad token) → delivery logs error, **exits 0**, email in Mailpit; SMTP down → Telegram block still runs.
  8. §12.9 — budget regression: dev run numbers vs. documented seed expectations (2 uncategorized, `Suscripciones −7,50 €`) — any diff is a refactor bug.
  9. §12.10 — credential gate: record as **precondition for production cutover only** (as-is.md S1 rotation); dev uses `dev-seed-password`, gate is N/A in dev but must be flagged in the verify report.
- **Est. authored lines**: ~20 (README operational notes).
- **Depends on**: T5, T6.

## Dependency order

```
T0 ──→ T1 ──→ T3 ──→ T4 ──→ T5 ──→ T7
        │        ↑      │
T2 ─────┼────────┘      │
        └───────────────┴──→ T6  (T5 file-existence note; T7 completes two-service boot if deferred)

T2: independent (can run parallel to T1/T3)
T0: gates T1's applyCategoryChange and HARD-gates T5
```

Linear safe order: **T0 → T1 → T2 → T3 → T4 → T5 → T6 → T7**.

## Apply Progress

- **S1 — DONE** (2026-09-20, branch `slice/01-s1-telegram-foundation`): `c08907b` (T1 log.js + actual.js), `e4e7ecf` (T2 store.js), `4a76e2c` (chain strategy doc). T0 gate confirmed on `@actual-app/api@26.9.0`: `api.updateTransaction(id, { category: categoryId })`. Smokes PASS (2 uncategorized, 8 non-income categories, double-claim first-wins). Gatekeeper PASS.
- **S2 — DONE** (2026-09-20, branch `slice/01-s2-report-extraction`): `584cab4` `refactor: extract report computation from daily notifier monolith` (+229/-165 vs S1 branch). T3 checks: `node --check` both files PASS; **§12 step 9 early regression gate PASS** — Mailpit email from old monolith vs refactored code byte-identical (5503 chars, UTF-8 compare), subject tag `2 sin categorizar` preserved, logs show exactly 2 uncategorized (Nómina empresa +195.00, Compra suelta −15.00).
- **S3 — DONE** (2026-09-20, branch `slice/01-s3-telegram-delivery`): `f2fa99d` `feat: deliver interactive Telegram notifications from cron` (T4: telegram/bot.js + telegram/send.js + cron wiring + store.js T4 methods + .env.example) · `666b031` `feat: split notifier into cron and listener services` (T6: x-notifier-base anchor, dormant self-detecting listener command, dev overlay mirror). T4 checks PASS: `node --check` 7 files; dry-run (TELEGRAM_DRY_RUN=true, dummy token via `-e`, .env NOT touched) → email sent + 1 summary + exactly 2 interactive messages, exit 0; store: `reports` row counters correct, 2 `interactions` rows `tg_message_id=-1`, CI-3 verified in `button_rows_json` (8 categories row + dismiss alone on final row); expiry of prior report's interactions + 2 dry editMessageText observed. **Budget note**: slice authored 650 lines vs 400 budget — actual churn exceeded the estimate (send.js builders + header docs); needs split or `size:exception` decision at PR time (user decision). **DECISION (user, 2026-09-20): PR #3 ships as-is with `size:exception`, NO split — explicit user choice.**
- **S4 — DONE (dry-run e2e)** (2026-09-20, branch `slice/01-s4-listener-e2e`): `7b0e34a` `feat: run long-poll listener with categorize action executor` (+516: listener.js, actions/categorize.js + registry, dev/replay-callback.js). T0 gate reused from S1 (`updateTransaction(id, { category: categoryId })`). Dev-station e2e (D11, dev budget, dev-only): **unknown ref** (`--item-ref=3 --ref=99`) → `logAnswer rejected (unknown ref 99)` + status rolled back to `pending` ✅; **dismiss** (item 4) → `applied (dismissed)`, no Actual call, winner = first replayer ✅; **second tap on answered** → `duplicate (already answered)`, winner preserved ✅; **expired** (item 1 from report 1) → `expired (report expired)`, no state change ✅; **race attempt**: two concurrent replays on item 3 → one job applied (`applied` + real write-back), the other job hit a host path-resolution failure (Start-Job doesn't inherit cwd), so TRUE concurrent double-tap was not reproduced this time; idempotency is instead evidenced by the answered-guard (answer row 5: `duplicate (already answered)` on item 3's second touch) + the S1-verified guarded `UPDATE … WHERE status='pending'` first-wins semantics ✅; **Real write-back verified**: dev Actual tx "Nómina empresa" (+195, Cuenta Nómina) confirmed with category `Suscripciones (497d9e1f-…)` via API read; **then cleaned** (category null'd back, seed-invariant restored) ✅. Listener loop smoke: offset persists across restart (poll_offset kv), 404 backoff 1s→2s→4s, SIGTERM clean shutdown exit 0 ✅. `notifier-listener-dev` boots, detects no token, exits 1 cleanly (expected per §6.1) ✅. Deviation: el subagente escritor dejó `getDb()`/`setDb` usados sin definir en listener.js (ReferenceError en runtime, no en require); al verificar se añadieron los dos handlers a nivel de módulo en `listener.js` antes del commit (sin cambiar store.js). Live-tap steps (§12 step 6: @BotFather token, real group) NOT executed — no token available this session; blocked on user action, all other steps complete.

## Review Workload Forecast

| Slice | Tasks | Est. authored lines (add+del) | Under 400? |
|-------|-------|-------------------------------|------------|
| S1 | T0, T1, T2 | ~230 | ✅ |
| S2 | T3 | ~340 | ✅ |
| S3 | T4, T6 | ~385 | ✅ |
| S4 | T5, T7 | ~335 | ✅ |
| **Total** | T0–T7 | **~1290** | — |

- **Total estimated authored changed lines**: **~1290** (advisory estimates; the large T3 churn comes from verbatim code *movement* — deletions in the monolith matched by additions in `report.js`, not new logic).
- **Chained PRs recommended**: **Yes** (4 slices). Each slice maps to one PR:
  - **PR #1 (S1)**: `feat: add structured logging and Actual API lifecycle wrapper` + `feat: add SQLite store for notifications state` (+ gate note commit for T0 if it produces a code-visible record; otherwise 2 commits).
  - **PR #2 (S2)**: `refactor: extract report computation from daily notifier monolith` (behavior-preserving, Mailpit regression-checked).
  - **PR #3 (S3)**: `feat: deliver interactive Telegram notifications from cron` (bot + send + wiring + compose/infra; listener service ships dormant per T6 note).
  - **PR #4 (S4)**: `feat: run long-poll listener with categorize action executor` (+ verification/docs closeout).
- **400-line budget risk**: **High (multi-PR change)** — total is 3× the single-PR budget, but after one honest slicing pass every slice fits under 400 with no artificial compression. No `size:exception` needed.
- **chain_strategy**: `feature-branch-chain` (user-chosen 2026-09-20). Tracker branch: **`master-add-telegram`** (existing branch holding proposal + dev environment; current HEAD). Slice branches fork from the tracker: `slice/01-s1-...` → PR#1 targets `master-add-telegram`; each later slice branch forks from the previous slice branch and its PR targets the previous slice branch; only `master-add-telegram` eventually merges to `master` when the whole feature is validated.

## Apply entry gate (restated)

**Before ANY write-back code is finalized (T1's `applyCategoryChange` signature is provisional until T0 records its finding; T5 is hard-blocked on it):** confirm the exact `@actual-app/api@26.8.1` method for setting a transaction's category, record `{method name, signature, field name}` in apply-progress. Candidate from `seed.js` evidence: `api.updateTransaction(txId, { category: categoryId })`.

## Verification coverage map (design §12 → task)

| §12 step | Task where executed |
|----------|--------------------|
| 1 (dry boot + schema) | T4 (initial), T6/T7 (two-service) |
| 2 (delivery + store rows, dry) | T4 |
| 3 (callback path, replay) | T5 |
| 4 (idempotency + crash) | T5, re-confirm T7 |
| 5 (expiry, dry) | T7 (live path also §12A.4) |
| 6 (live cutover, single tap, winner preserved) | T7 step 5 (dev group) — production cutover stays out of scope |
| 7 (restart survival) | T7 |
| 8 (failure containment) | T7 |
| 9 (budget regression) | T3 (early gate) + T7 (final) |
| 10 (credential rotation gate) | T7 — recorded as production precondition only |
| 11 (dev-instance e2e) | T7 (this IS the dev e2e pass) |
| §12A.1–6 | T4 (targets 1–2), T5 (target 5 synthetic), T7 (targets 3, 4, 5 live, 6) |

## Explicit non-goals in this task list (design §13)

No free-text, no DMs/second groups, no webhook, no channel toggle, no other actions, no listener healthcheck/alerting, no rotation implementation, no crontab/throttle/computation changes.
