# Design — 01: Telegram Interactive Notifications

> **Change**: 01-telegram-interactive-notifications · **Phase**: design · **Date**: 2026-09-20
> **Inputs**: proposal `01-telegram-interactive-notifications.md` (decisions D1–D10), baseline spec `00-baseline-architecture.md`, `src/reporte-diario.js`, `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`, `crontab.txt`, `.env.example`.
> **Constraints honored**: D1 group-only · D2 email kept · D3 first-answer-wins · D4 categorize-only v1 (generic action layer) · D5 no free-text in v1 (not locked out) · D6 per-report expiry · D7 long polling · D8 SQLite · D9 group bot · D10 same Actual credentials.

---

## 1. Process Topology & Lifecycle

### Decision: two Compose services, one image

| Option | Verdict | Why |
|---|---|---|
| **A. Two Compose services** (`notifier-cron`, `notifier-listener`) sharing image + volumes | ✅ **Selected** | Cleanest crash isolation: `restart: unless-stopped` applies independently. A listener crash never touches cron, and a hanging cron run never blocks replies. Separate log streams (`docker logs notifier-cron` / `notifier-listener`). No new supervisor dependency. |
| B. Entrypoint supervisor (`node src/listener.js & exec cron -f`) | Rejected | One PID-namespace: a listener crash is only caught by the entrypoint if it also supervises (background `&` + `wait`/`trap` reintroduces hand-rolled supervision in shell); one log stream mixed; a wedged listener container-restarts and kills the in-flight cron run. |
| C. Single dual-process main (node starts cron child + poll loop) | Rejected | Replaces system `cron` with in-process scheduling (loses the existing `crontab.txt` contract) and couples two lifecycles into one process. |

**Consequences and rules:**

- Both services mount the **same writable data volume** (§5.4) and the same `:ro` mounts (`/app/src`, `/app/.env`). No `:ro` on `./data` — that is the point of the new volume.
- **Port exposure: NONE.** Verified: the listener only *calls out* (`api.telegram.org`, `ACTUAL_SERVER_URL`, SMTP host for cron). No inbound port, no `ports:` stanza added, network posture unchanged (`actual_net` external).
- **Store ownership**: single SQLite file at `/app/data/notifier.db`, writable by both services. Concurrency is bounded: cron writes are a burst at 20:00 (a few rows); the listener is a single long-lived process = the only high-frequency writer. WAL mode + default busy timeout is sufficient (§5.2).
- **Image**: unchanged build (both services use the same `Dockerfile` target). The listener needs no cron binaries; that is harmless.
- **entrypoint**:
  - `notifier-cron` keeps the current `entrypoint.sh` (printenv → crontab → `exec cron -f`).
  - `notifier-listener` gets a trivial second entry — `command: node src/listener.js` in Compose (no entrypoint script needed; dotenv is loaded in Node, same as the cron script).
- **Crash semantics**: listener crash → Docker restarts it → loop resumes polling at the persisted offset (§3.3) → at-least-once redelivery, harmless because claims are atomic (§5.1). Cron unaffected. A container-level restart of the *cron* service wipes `/tmp/actual-cache` (bank-sync throttle marker) — same behavior as today, documented debt, unchanged.
- **Env for the long-lived process**: `.env` is mounted `:ro` and read once at process boot by `dotenv`. Stability note: **token rotation requires `docker compose restart notifier-listener`** (documented in `.env.example` comment). No mid-run reload needed for v1.

---

## 2. Module Decomposition

The monolith (`src/reporte-diario.js`, ~320 lines) is split at its natural seams. Target sizes keep this pragmatic — no services, no abstractions beyond one registry.

```
src/
├── log.js                    NEW   ~15 lines. log(level, service, msg, fields) → single-line
│                               JSON to stdout: {"ts","level","service","msg",...}.
├── actual.js                 NEW   ~80 lines. Actual API lifecycle wrapper.
│                                 open(dataDir) → {api} (init + downloadBudget)
│                                 close(api); getUncategorizedTxs(api, month)
│                                 getCategories(api); computeMonthlyState(...)
│                                 applyCategoryChange(api, txId, categoryId)   [write-back]
├── store.js                  NEW   ~120 lines. better-sqlite3 wrapper (WAL, busy_timeout).
│                                 One open connection per process. All DDL runs
│                                 idempotently at open (CREATE TABLE IF NOT EXISTS).
├── report.js                 NEW   ~120 lines. Steps 1–3 of today's script, verbatim logic:
│                                 bank-sync throttle, uncategorized detection,
│                                 target-category balances + overspend sweep.
│                                 Returns a plain `ReportData` object.
├── reporte-diario.js         SHRINKS to ~90 lines. Cron orchestrator only:
│                                 open Actual → report.compute → email (existing
│                                 nodemailer code, HTML rendering) → telegram
│                                 delivery (via telegram/send.js) → store report row
│                                 → store.expirePreviousPending(run).
├── telegram/
│   ├── bot.js                NEW   ~100 lines. Bare Bot API over global fetch (§3.1):
│   │                               request(method, params), sendMessage,
│   │                               answerCallbackQuery, editMessageText, getUpdates.
│   │                               Retry/backoff lives in the caller loops, not here.
│   └── send.js               NEW   ~110 lines. Builds + sends the summary message
│                                 (no buttons) and one interactive message per
│                                 uncategorized tx (§4.3). Writes interaction rows,
│                                 returns {reportId, sent: n, failed: n}.
├── listener.js               NEW   ~140 lines. Long-poll loop (§3.2), callback
│                                 dispatcher (§3.4), start/stop.
└── actions/
    ├── index.js              NEW   ~25 lines. ACTION_REGISTRY = { categorize: categorize.js }.
    └── categorize.js         NEW   ~90 lines. v1 action executor (§6).
```

Rules:

- `reporte-diario.js` keeps its filename (crontab contract) and its dotenv-`override:true` load.
- Every module is CommonJS, Node 20, no build step.
- `telegram/send.js` is invoked **synchronously from cron**; it never starts the listener. The boundary is `store` + `actions`, not process membership.

---

## 3. Telegram Layer

### 3.1 Client: bare Bot API via global `fetch` (decision)

| Option | Verdict | Why |
|---|---|---|
| **Bare Bot API over Node 20 global `fetch`** | ✅ **Selected** | v1 uses exactly 4 endpoints (`sendMessage`, `answerCallbackQuery`, `editMessageText`, `getUpdates`). A ~100-line wrapper is the whole client. **Zero new dependencies** — `package.json` gains nothing (supply-chain risk R7 vanishes). Home-lab scale, 1 bot, no group-admin features, no rate-limit management beyond a single 429 handler. |
| `grammy` / `telegraf` | Rejected for v1 | Pulls in a dependency + middleware model we will not use 90% of. Reconsider **only** when v2 free-text commands arrive (D5 evolution), at which point grammY's router/ctx model pays off — the `callback_data` codec in `send.js`/`listener.js` is library-agnostic by design. |

`bot.js` semantics:

- Base URL `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/<method>`; JSON body; on HTTP 429 honor `retry_after` once, then throw.
- Network errors throw with a short reason; callers decide retry vs. give-up.
- `TELEGRAM_DRY_RUN=true` (§8): `bot.js` short-circuits — logs the would-be call, returns a fake successful result (`message_id = -1`, etc.). Lets the entire listener + expiry path be exercised with no bot token at all.

### 3.2 Long-poll loop

```
offset = store.get('poll_offset') || 0            // kv table, §5.3
backoff = 1_000
loop:
  res = bot.getUpdates({ offset, timeout: 30,
                         allowed_updates: ['callback_query'] })
  updates = res.result
  if updates.empty: backoff = 1_000; continue
  for u of updates:
    try: handleUpdate(u)          // §3.4 — idempotent by construction
    catch e: log error, continue  // one bad update never wedges the loop
    if u.update_id >= offset:
      store.set('poll_offset', u.update_id + 1)   // persist AFTER processing
  backoff = 1_000
on error:
  log; sleep(min(backoff, 30_000)); backoff *= 2  // 1s → 2s → … → 30s cap
```

- **Offset persists after processing each update** (not before, not batched): crash mid-batch ⇒ those updates are redelivered ⇒ at-least-once. At-least-once is fine because the hot path is an atomic `status` claim (§5.1) and `answerCallbackQuery`/`editMessage` on already-handled callbacks are no-ops or are guarded by store state.
- **Offset lives in the SQLite `kv` table, not `/tmp`**: it must survive listener restarts (offset in `/tmp` would reset to 0 on container restart and replay history; harmless but noisy — rejected). It is written by exactly one process (the listener) — no contention.
- `getUpdates timeout: 30`: Telegram holds the call up to 35 s; 30 s is the standard sweet spot. No `webhook_deletion` call is needed (we never use webhooks, D7).
- **`answerCallbackQuery` early**: called within the first millisecond of handler dispatch (`show_alert: true`) so the tapper always sees a spinner end + ack, before the (slower) Actual write-back runs (§6).
- **Evolution (D5)**: v1 uses `allowed_updates: ['callback_query']` only. Free-text support later = add `'message'` + a dispatcher branch on `update.message`. Nothing in the loop, the offset handling, or the store needs to change.

### 3.3 Crash-recovery behavior (summary)

| Failure | Outcome |
|---|---|
| Crash after `getUpdates`, before persist | Updates redelivered; claims dedupe (§5.1). |
| Crash after claim, before `editMessage` | Action applied exactly once; the confirmation edit is missing → next tap sees "already answered" path; reply log has the row. Acceptable (R9). |
| Telegram outage days | `getUpdates` keeps failing → backoff caps at 30 s; no updates lost (offset unchanged); on recovery, backlog replays. Expired interactions will answer "expired" honestly. |
| Token invalid (HTTP 401) | Same backoff; logged at `error` with the Telegram description. Out-of-scope: no crash alert (§10). |

### 3.4 Update handler (callback dispatcher)

```
handleUpdate(u):
  cb = u.callback_query; return if !cb
  parse callback_data → { itemRef, actionRef }        // §4.1
  ans = bot.answerCallbackQuery({callback_query_id, text: '…', show_alert: true})
  row = store.findInteractionByItemRef(itemRef)
  if !row → ans text "Desconocido"; log; return
  switch row.status:
    'pending':
      claim = store.claimAnswer(row.id, cb.from.id, cb.from.username, actionRef)
      if !claim.won → answer "ya respondido por X" path (edit msg, log dup); return
      handler = ACTION_REGISTRY[claim.action_kind]
      result = await handler(claim)                    // §6
      store.logAnswer(row.id, cb.from, 'applied', result.detail)
      editMessage(confirmation)                          // §4.4
    'answered' → answer "ya respondido por X"; log 'duplicate'; (no re-edit; msg already confirms)
    'expired'  → answer "reporte expirado"; log 'expired'
```

---

## 4. Message & `callback_data` Contract

### 4.1 `callback_data` format (hard limit: **64 bytes**)

Category names are long Spanish strings (`Supermercado y Alimentación` = 28 chars; Actual category IDs are 36-char UUIDs) — **names and UUIDs cannot go in `callback_data`**. Refs are resolved against the row stored at delivery time:

```
v1:<itemRef>:<actionRef>

v1        literal prefix, format version
itemRef   interaction.id in base36 (≤ 12 chars; 10 chars cover 3.5B rows)
actionRef for categorize: category index at delivery time, "0".."n"
              dismiss:    "-"
```

Worst realistic case: `v1:` + 10 + `:` + 2 = **15 bytes** — 4× under the limit. The index maps to `actual_category_id` via the interaction's `button_rows_json` (§5.1), which is captured at delivery — a renamable category in Actual still resolves correctly, and a deleted category makes the write-back fail cleanly (§6).

**Trust rule (R1)**: `callback_data` is untrusted input (echoed back unsigned). The handler never trusts `actionRef` alone — it resolves it through the *stored* `button_rows_json` row, and unknown refs are rejected with a logged `error`.

### 4.2 Telegram limits vs. our messages (all numbers verified against the constraint set: 4096-char text, 8 buttons/row, 100-char button text)

| Element | Our usage | Limit | Headroom |
|---|---|---|---|
| Interactive message text | ~150–250 chars per tx (date, payee, account, amount, header) | 4096 | ~10× |
| Category buttons | ~30 categories → **4 rows of 8** (+ 1 row for dismiss) = 5 rows, 31 buttons | 8/row | OK. If the budget ever exceeds 32 categories: rows auto-wrap, still fine until ~50. |
| Button label | category name, truncated to **97 chars + `…`** | 100 | OK |
| `callback_data` | ≤ 15 bytes (§4.1) | 64 | OK |

### 4.3 Messages per run — **one message per transaction** (decision)

| Option | Verdict | Why |
|---|---|---|
| **1 tx = 1 message + 1 keyboard** | ✅ **Selected** | First-answer-wins confirmation edit targets exactly one message (no ambiguity who answered). 4096-char math is trivially safe. Per-message failure isolation: a failed send skips only that tx. |
| Batch N tx per message | Rejected | A tap edits the whole message — must encode which tx in UI text; one bad send loses N interactions; 4096 math couples with tx count (would force N ≤ ~15 anyway, i.e. the cap we add instead). |

**Group-noise cap**: `TELEGRAM_MAX_TX_MESSAGES` (default **15**). If a day has more uncategorized txs, the first 15 (oldest first) get interactive messages; the rest appear only in the summary message's list (informational). Kept configurable — family scale may want unlimited.

### 4.4 Message layouts (text shown to the group; Spanish UI copy, neutral register)

**Summary (informational, no keyboard)**, sent first by cron:

```
📊 Reporte diario — 20/09/2026
🔄 Banco: sincronizado a las 20:00
🔍 Pendientes sin categorizar: 4  →  4 mensajes debajo con botones
🛒 Consumo: Supermercado 42,10 € (2,10 €/día) … [5 líneas]
⚠️ Sobregasto: Ocio y Restaurantes −12,50 €
```

**Per-tx interactive message** (sent second, one per tx):

```
🔍 1 de 4 · Sin categorizar
18/09 · Supermercado X (ING **4521)
Importe: −34,20 €

Toca la categoría:
```
Buttons: 4–5 rows of category names, final row: `[🚫 Sin categorizar]`.

**After a tap**, the *same message* is edited in place (all group members see it) to:

```
✅ 1 de 4 · 18/09 · Supermercado X (ING **4521) · −34,20 €
→ Supermercado y Alimentación
Respondido por @jordi · 20:04
```
(keyboard removed). Dismiss ends in `→ Sin categorizar (dejado pendiente)`. Failed write-back ends in `⚠️ No se pudo guardar en Actual: <reason>` and the row returns to `pending` (a later tap retries — §6).

---

## 5. SQLite Store (`src/store.js`)

`better-sqlite3` (already in the image via `@actual-app/api`), file `/app/data/notifier.db`. Opened with:

```js
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
```

### 5.1 DDL (created idempotently at open)

```sql
CREATE TABLE IF NOT EXISTS reports (
  id                     INTEGER PRIMARY KEY,
  run_at                 TEXT NOT NULL UNIQUE,   -- ISO, delivery timestamp
  sync_ok                INTEGER NOT NULL,
  sync_message           TEXT,
  tx_uncategorized_count INTEGER NOT NULL,
  email_sent             INTEGER NOT NULL DEFAULT 0,
  telegram_summary_sent  INTEGER NOT NULL DEFAULT 0,
  telegram_tx_sent       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS interactions (
  id                 INTEGER PRIMARY KEY,
  report_id          INTEGER NOT NULL REFERENCES reports(id),
  item_ref           TEXT NOT NULL UNIQUE,       -- base36 of id, used in callback_data
  action_kind        TEXT NOT NULL DEFAULT 'categorize',  -- generic: evolves (D4/D5)
  actual_tx_id       TEXT NOT NULL,              -- Actual Budget transaction id
  account_id         TEXT,
  account_name       TEXT NOT NULL,
  tx_date            TEXT NOT NULL,
  payee              TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  button_rows_json   TEXT NOT NULL,              -- [[{"ref":"0","cat_id":"…","label":"…"},…],…]
  tg_chat_id         INTEGER NOT NULL,
  tg_message_id      INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',  -- pending | answered | expired
  answered_by_id     INTEGER,                 -- tg user_id
  answered_by_name   TEXT,
  chosen_ref         TEXT,                    -- category index at delivery, or '-'
  actual_category_id TEXT,                    -- resolved id applied to Actual
  answer_detail      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions(status, report_id);

CREATE TABLE IF NOT EXISTS answers (          -- append-only reply log (audit)
  id             INTEGER PRIMARY KEY,
  interaction_id INTEGER NOT NULL REFERENCES interactions(id),
  user_id        INTEGER,
  username       TEXT,
  callback_id    TEXT,
  outcome        TEXT NOT NULL,               -- applied | duplicate | expired | rejected
  detail         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kv (               -- small durable scalars
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                          -- e.g. 'poll_offset' = '88231'
);
```

Retention (bounded growth, no cron job for it): at each daily delivery, `DELETE` `answers` rows older than 90 days and `answers` whose interaction is gone — one statement, one pass. `interactions`/`reports` are kept indefinitely (a run is a few rows; ~370 rows/year).

### 5.2 Concurrency model — single hot writer, burst cross-writer

- **Listener**: the only high-frequency writer (`kv`, `answers`, `interactions.status`). One process = one connection = no inter-thread issues (better-sqlite3 is synchronous/serialized anyway).
- **Cron**: bursts at 20:00 — inserts `reports`/`interactions` and runs the expiry `UPDATE`. The two writers can overlap **only** in this window: cron `UPDATE … SET status='expired' WHERE status='pending'` vs. listener `claimAnswer` on the same row. Both use **guarded `UPDATE` + `changes()` check** (below), so exactly one wins; the loser observes the other state. WAL + `busy_timeout=5000` removes lock errors entirely at this scale. No `BEGIN IMMEDIATE` ceremony needed.

### 5.3 Atomic first-answer-wins (D3)

```js
claimAnswer(id, tgUserId, username, actionRef) {
  const stmt = db.prepare(`
    UPDATE interactions
       SET status = 'answered', answered_by_id = ?, answered_by_name = ?,
           chosen_ref = ?, answered_at = datetime('now')
     WHERE id = ? AND status = 'pending'`);
  const r = stmt.run(tgUserId, username, actionRef, id);
  return { won: r.changes === 1, row: getInteraction(id) };   // loser re-reads winner
}
```

Exactly one `won: true` per interaction, across redeliveries, double-taps, and restarts. A tap that arrives after the row is `answered` never mutates Actual state — the handler just replies "ya respondido por X" (D3's confirmation, from the persisted winner's `answered_by_name`).

### 5.4 Volume design (Compose change)

```yaml
volumes:
  - ./data:/app/data        # NEW — writable; holds notifier.db (+ -wal/-shm)
```

- **Bind mount `./data`** (not named volume): the DB is an operational artifact a homelab user should be able to inspect, back up, or wipe from the host — consistency with everything else in this repo being host-visible. Host-side rule: never `rm` the `.db` while a service is up (note in README).
- The three existing `:ro` mounts stay exactly as they are (F5 respected).
- Listener writes are durable before the process can ack: SQLite fsync default is fine here (no write amplification at home-lab write rates).
- `DATA_DIR` env (default `/app/data`) lets the listener/cron override the path (§8) — same value in both, that is what sharing the volume is for.

---

## 6. Action Executor — `actions/categorize.js`

### 6.1 Per-invocation Actual lifecycle (decision)

| Option | Analysis | Verdict |
|---|---|---|
| **init → downloadBudget → write → shutdown per tap** | init is a few seconds (auth + budget list); `downloadBudget` reuses warm files in its dataDir. Worst-case latency to a tap: ~5–15 s — acceptable for a categorization the user is not blocking on. **Every crash/restart inside a write-back dies with the process; no stale API handle, no idle-state unknowns.** Simplest possible reasoning about state. | ✅ **Selected** |
| Warm resident connection in the listener | Fast taps, but the listener now holds a long-lived Actual session: unknown idle/revocation behavior across days, a wedged handle is now a *listener* outage (not just a failed tap), and two inits (listener + cron) sharing one dataDir is the worst case of §6.2. No v1 benefit justifies it. | Rejected |

Executor flow:

```
handleCategorize(claim):
  row = store.getInteraction(claim)
  btn = row.button_rows_json → resolve row.chosen_ref to {cat_id, label}
  if chosen_ref === '-' → return {detail: 'dismissed'}        // no Actual call
  {api} = openActual(LISTENER_DATA_DIR)                        // §6.2
  try: applyCategoryChange(api, row.actual_tx_id, cat_id)
  finally: close(api)
  on success: store.recordApplied(row.id, cat_id, label) → {detail: 'applied'}
  on failure: store.rollbackToPending(row.id, err.message)         // row → pending again
             → {detail: 'failed', retryable: true}                // late tap retries
```

Note: `applyCategoryChange` uses the Actual API's category-setting method for a transaction (`setCategoryForTransaction`-style; **verify the exported name in the installed `@actual-app/api@26.8.1` during apply — the name was not verifiable offline and is the one external API risk in this design**). `dismiss` (`-`) performs **no** budget mutation — "sin categorizar" is the existing state of the tx, so dismiss = record the decision, no write.

### 6.2 Two processes, Actual `dataDir` — risk and mitigation

`@actual-app/api` persists working copies of downloaded budgets under `dataDir` (SQLite-backed). **Two Node processes sharing one `dataDir` is not safe to assume**: the cron run does *sync* (mutating the working copy) while the listener may *download/write* the same budget file concurrently → SQLite lock contention or, worse, cross-process cache staleness/corruption. The repo gives no published concurrency guarantee, so the design does not bet on it:

- **Cron** keeps `/tmp/actual-cache` (unchanged, includes the bank-sync throttle marker).
- **Listener** uses `/tmp/actual-listener-cache` (separate dir, separate files, same `ACTUAL_SERVER_URL`/`ACTUAL_PASSWORD`/`ACTUAL_SYNC_ID` — D10 same credentials, different working copies).
- `/tmp` is ephemeral per container (existing fact F5): after a listener container restart the first tap re-downloads (~seconds). Acceptable and self-healing; documented, not fixed.

### 6.3 Identity (D10)

The listener process authenticates to Actual with the *same* `ACTUAL_PASSWORD` as cron via the mounted `:ro` `.env`. No new credential. The inherited S1 (credentials considered compromised, rotation pending) applies — rotation remains a **precondition for enabling the bot in production** (`TELEGRAM_BOT_TOKEN` is one more secret in the same file), documented in the verification plan, not fixed here.

---

## 7. Daily Delivery Sequencing (cron run)

Exact order inside `reporte-diario.js`:

```
 1. dotenv(override) → open Actual (cron dataDir) + downloadBudget
 2. bank-sync with 60-min throttle            (existing; failure → syncOk=false, continue)
 3. detect uncategorized txs (current month)  (existing)
 4. compute target-category balances + overspend sweep  (existing)
 5. EMAIL: render HTML → send → store: reports.email_sent = 1        ← primary channel first
 6. insert reports row {run_at, sync_*, tx_*, email_sent, …}
 7. TELEGRAM (all of 7–9 wrapped in ONE try/catch — failure ⇒ log error,
    mark telegram_* = 0, and the run still SUCCEEDS; email already delivered):
    7a. summary message (no buttons)
    7b. per-tx interactive messages (cap TELEGRAM_MAX_TX_MESSAGES),
        each: bot.sendMessage(inline_keyboard) → INSERT interaction
        (tg_message_id, button_rows_json, …) → one per tx, sequential.
    7c. store.telegram_summary_sent / telegram_tx_sent counts
 8. EXPIRY (D6): UPDATE interactions SET status='expired'
    WHERE status='pending' AND report_id < thisRunId;
    then best-effort (try/catch per message, log-and-continue):
    for each just-expired row: bot.editMessageText(same text +
    "\n⏳ Expirado por el reporte del 20/09 — usa los mensajes nuevos.")
    with reply_markup removed. Edit failures are logged only.
 9. answers retention sweep (§5.1) → api.shutdown → exit 0
```

Failure-containment rules:

- Email failure ⇒ the run **exits 1** (today's contract, unchanged; email is the primary channel).
- Telegram failure (any of 7–8) ⇒ **logged at `error`, run still exits 0**. Channels independent (proposal success criterion 6).
- A per-tx send failure marks nothing in the store (the interaction row simply isn't created); the tx still appears in the summary + email, so it is never invisible.
- Ordering rationale: email before Telegram (primary first); expiry *last* (no window where both old and new buttons are dead; old buttons stay answerable until the new day's messages are actually out).

---

## 8. Configuration (exact additions)

`.env.example` additions (with the two existing blocks untouched):

```dotenv
# --- Telegram (canal interactivo) ---
# Token del bot creado en @BotFather (añadir el bot al grupo privado).
# ⚠️ Rotar todas las credenciales de este archivo ANTES de activar (ver as-is.md S1).
TELEGRAM_BOT_TOKEN=123456:AA...
# ID numérico del grupo privado (formato -100xxxxxxxxxx).
TELEGRAM_GROUP_ID=-1001234567890

# Opcional (con sensatos valores por defecto):
TELEGRAM_MAX_TX_MESSAGES=15      # máx. mensajes interactivos/día (resto, solo en resumen)
TELEGRAM_POLL_TIMEOUT=30         # getUpdates timeout, segundos (máx. Telegram 50)
TELEGRAM_DRY_RUN=false           # true: loguea envíos/callbacks sin llamar a Telegram ni a Actual
DATA_DIR=/app/data               # ubicación del SQLite (mismo valor en ambos servicios)
```

Notes:

- No channel toggle is needed: D2 fixes `both` for v1. `NOTIFICATION_EMAIL` and `NOTIFICATION_CHANNEL` stay exactly as-is; the email path is literally untouched.
- Listener boot: `dotenv` once at `listener.js` start. **Stability contract**: `TELEGRAM_BOT_TOKEN`/`TELEGRAM_GROUP_ID` changes require `docker compose restart notifier-listener` (comment in `.env.example`). Cron picks changes up per run (`override: true`, existing behavior).
- If `TELEGRAM_BOT_TOKEN` or `TELEGRAM_GROUP_ID` is empty: cron **skips step 7 silently-with-warn** (email-only mode = graceful degradation, old deployment unchanged); the listener service should not be started at all (compose profiles or manual). This keeps `docker compose up` safe before the bot exists.

---

## 9. Expiry Flow (D6) — precise behavior

Trigger: a new report's delivery (step 8) completes. Mechanism:

1. **Store first**: `status='expired'` for all pending rows of earlier reports. This is the single source of truth — the button state in Telegram is only cosmetics.
2. **Telegram best-effort**: edit each expired message → keep text, append expiry footer, remove keyboard. Failures (message deleted, bot kicked, 400) log at `warn` and stop; store state already correct.
3. **Late tap on an expired interaction** (keyboard removal failed, or the tap raced step 8): handler reads `status='expired'` → `answerCallbackQuery("⏳ Reporte expirado — responde desde el mensaje del <fecha>")`, `show_alert: true`, logs `expired` in `answers`. **No action applied, no Actual call. Ever.**
4. **Race between a live tap and expiry**: atomic `UPDATE` — if the listener won the claim first, the row is `answered` and the expiry `UPDATE` touches 0 rows for it (guarded by `status='pending'`); if expiry won, the tap gets the expired ack in (3). Both orders safe, no Actual write in a stale state.
5. **Recurring daily**: each 20:00 run expires *that* previous day's pendings. Multi-day piling-up is prevented by design (there is never more than one pending-report generation, because each generation expires at the moment the next one delivers).

---

## 10. Error Handling & Observability

- **Structured logs**: `src/log.js` → single-line JSON `{ts, level, service, msg, ...fields}` to stdout. `service` ∈ `cron` | `listener`. Every store mutation, every Telegram call, every Actual write-back emits a line; every error emits with `error` (short message) + `cause`.
- **Log locations**: cron → `/var/log/cron.log` (unchanged crontab redirect); listener → its container stdout → `docker logs notifier-listener`. No file rotation for v1 (known debt, as-is.md §5.5, unchanged).
- **Crash notifications**: **OUT OF SCOPE for v1** — explicit. A dead listener means "buttons don't work" but the report still arrives daily by email; detection = `docker ps` / `restart: unless-stopped` auto-recovery. (Follow-up candidate: Telegram self-message on boot + watchdog, documented as future work, not designed here.)
- **Restart**: both services `restart: unless-stopped` (listener = new service, same policy). Offset + store survive on the volume (§5.3); only `/tmp` caches rebuild (bank-sync throttle + listener's Actual cache) — same ephemerality class as today.
- **Error policy in the listener**: an unhandled exception inside `handleUpdate` never kills the loop (caught per-update, §3.2). A truly unexpected top-level throw → process exits → Docker restarts → clean state from the persisted offset.

---

## 11. Evolution Hooks (generic model — what v1 already contains)

| Extensibility point | v1 shape | Future |
|---|---|---|
| Action kinds | `interactions.action_kind TEXT` (v1: only `'categorize'`); `ACTION_REGISTRY` map in `actions/index.js`; `callback_data` has the `v1:` version prefix | New `actions/<kind>.js` + registry entry + a new row-set on the interaction message. No schema change. |
| Item reference | `item_ref` identifies "the object the button acts on" (v1: one tx, `actual_tx_id` column). Generic in concept even if the columns are tx-specific today | Add columns, or a `target_json`, when second action kind lands — isolated migration, old rows untouched. |
| Free text (D5) | Listener loop already processes `allowed_updates` through one dispatcher; store, offset, and ack path are transport-agnostic | Add `'message'` to `allowed_updates`, add a `handleMessage` branch, likely swap `bot.js` for grammY. No redesign of anything in §3.2/§5. |
| Recipients (D1) | `tg_chat_id` per interaction (v1: always the one group) | Per-user DM targeting = new rows in a new group/chat, no listener change. |
| Multi-report actions | `report_id` on every interaction | Cross-report actions read the store, not the callback. |

---

## 12. Verification Plan (strict_tdd = false — manual/functional)

No test runner exists; the plan is a scripted manual pass, all executable in-place. **Order matters; steps 1–4 need no bot at all.**

1. **Dry-run boot**: `TELEGRAM_DRY_RUN=true` + both services up. Verify: both boot, `notifier.db` created with all tables (`sqlite3 ./data/notifier.db .schema`), listener logs "polling" lines, cron run produces logged (not sent) messages.
2. **Delivery + store**: trigger `node src/reporte-diario.js` manually (host, against a real or test budget). Verify `reports` row, `interactions` rows with `tg_message_id=-1` (dry), button_rows_json matches the 5 target categories + dismiss, `poll_offset` untouched.
3. **Callback path (dry)**: with dry-run, exercise the listener by calling the handler path… (dry run intercepts `getUpdates`, so instead: a tiny dev helper `src/dev/replay-callback.js` — reads `interactions`, builds a synthetic `callback_query` with a valid `item_ref`, feeds it to `handleUpdate`. No network, full dispatch/claim/log/rollback path exercised.) Verify: first "tap" → `applied`; second "tap" → `duplicate`, winner preserved; unknown ref → `rejected`; `-` dismiss → answered, no Actual call.
4. **Idempotency & crash (dry)**: replay a double-tap within the same second (two calls, offset replayed twice) → exactly one `applied` row in `answers`. Kill `-9` the listener between steps 3 and 4, restart → offset unchanged, no crash loops.
5. **Expiry (dry)**: run the delivery twice (different `run_at`), verify first run's interactions → `status='expired'`, `answers` for a late "tap" on them → `expired`, and the (logged) edit-with-footer was attempted.
6. **Live cutover**: set real `TELEGRAM_BOT_TOKEN`/`TELEGRAM_GROUP_ID`, bot in the group. One real day: email + summary + per-tx messages arrive; tap a real category in the group → message edited to ✅, Actual Budget shows the tx categorized (verify in Actual UI / API), second person taps the same message → "ya respondido por X", Actual unchanged (single write — confirm via `answers` table: one `applied`).
7. **Restart survival**: `docker compose restart notifier-listener` after a delivered day, tap a still-pending button → action applies (offset + store survived).
8. **Failure containment**: stop Telegram-side (temporarily disable the bot token) → cron run logs the error, **exits 0**, email delivered; with SMTP disabled, Telegram path still runs; both down → documented, no crash loop.
9. **Budget regression check (proposal SC7)**: compare this run's email numbers against the previous day's format/numbers with a controlled budget (no changes) — computation is extracted verbatim, so any diff is a refactor bug.
10. **Credential precondition**: confirm rotation of `.env` secrets (as-is.md S1) is done before the live cutover in step 6. Gate, not a test.

---

## 13. Explicit OUT-OF-SCOPE (v1)

1. Free-text chat / commands (architecture does not block it — D5, §11).
2. Individual DMs, multiple groups, per-user answer authority (D1: single group).
3. Webhook transport (D7: long polling only; no reverse proxy, tunnel, or exposed port).
4. Replacing or gating the email channel (`NOTIFY_CHANNEL` toggle) — v1 is `both`, always.
5. Any action other than category write-back (re-sync trigger, move-to-month, payee renames, dismiss-as-archived, etc.).
6. Crash/alert notification for the listener (boot self-ping, watchdog, healthcheck) — documented follow-up.
7. Non-root container hardening, healthchecks, log rotation (known debt, as-is.md §5.5/S3).
8. Credential rotation itself (precondition to go live, not implemented here).
9. Message localization beyond Spanish UI copy; i18n of the report.
10. Retention/compaction beyond the 90-day `answers` sweep; DB backup tooling (bind mount is host-visible — manual `cp`).
11. Changing `crontab.txt` scheduling, the 60-min bank-sync throttle, or any report computation.
12. Telegram notification delivery for failed run outcomes (email failure behavior unchanged: exit 1, log only).

---

## Appendix A — Decision register (this phase)

| # | Decision | Choice | Key reason |
|---|---|---|---|
| P1 | Process topology | **Two compose services**, one image | Independent crash/restart isolation; no supervisor code |
| P2 | Telegram client | **Bare Bot API + global fetch** | 4 endpoints; zero new dependencies |
| P3 | Poll offset store | **SQLite `kv` table**, persist after processing | Survives restarts; at-least-once safe |
| P4 | `callback_data` | **`v1:<itemRef>:<actionRef>`**, DB-resolved refs | 64-byte limit + long Spanish category names |
| P5 | Tx→message ratio | **1 tx = 1 message**, cap 15/day (config) | Edit/first-answer-wins clarity; 4096 math trivial |
| P6 | Actual lifecycle for actions | **init→action→shutdown per tap** | No warm-state hazard; crash dies with process |
| P7 | dataDir sharing | **Separate dirs per process** | No safe-concurrency guarantee from `@actual-app/api` |
| P8 | Writable volume | **Bind `./data:/app/data`** | Host-visible ops consistent with repo style |
| P9 | First-answer-wins | **Guarded UPDATE + `changes()`** | Atomic, restart/replay safe, single hot writer |
| P10 | Dry-run mode | **`TELEGRAM_DRY_RUN`** (in scope, small) | Only way to verify steps 1–5 without credentials live |
