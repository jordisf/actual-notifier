# Problem Definition: Acceso on demand al reporte y a pendientes de categorización desde el grupo de Telegram

- **Slug**: telegram-on-demand
- **Created**: 2026-09-24
- **Updated**: 2026-09-24 (clarify round: user-confirmed categorize→re-report loop; G3 reclassified from goal to accepted risk)
- **Inputs used**: intake.md ✓ | research.md ✓

## Problem Statement

The user who follows Actual Budget notifications in the private Telegram group can only see the report and the pending-categorization list when the 20:00 daily job runs; at any other moment the only way to get that information is manual work on the server. There is a **high-frequency observed case** that makes this acute: after categorizing pending transactions from a report, the user's balances (the report's `datosConsumo` and `categoriasNegativas` are recomputed from the current Actual state on every `compute()` call) change, so the user needs the report **re-generated to see the updated numbers** — even when no fresh bank sync has happened since the last run. On top of that, the interaction to request data in the group is not discoverable: the user has already stated they forget how to ask for it, so even the (non-existent) request path would remain invisible in practice.

## Affected Users & Stakeholders

- **Users**: the workspace owner (user of the homelab, member of the private Telegram group — D1: single group, all users). Affected twice: (a) cannot obtain report/pending data outside the daily window without shell access to the server; (b) cannot remember how to trigger on-demand interaction in the group.
- **Stakeholders**: the same user is also the decision-maker, operator, and funding party (homelab; decision D7: nothing exposed to the internet). No other stakeholders identified.

## Goals

- G1 — Any situation in which the user wants to see the report and/or the pending-categorization list — **including the repeated case of "I just categorized, now show me the recalculated report"** — is solvable **from inside the group chat**, without touching the server.
- G2 — The way to request that data is **self-discoverable inside Telegram**; the user should not need to remember the syntax (the intake explicitly motivates the idea with "puedo no acordarme del comando").

### Accepted risks (not goals)

- Repeated `/report` invocations re-send messages to the group and re-expire the previous pending buttons (D6 `expirePreviousPending`). **The user has explicitly accepted this** (2026-09-24): in their single-user homelab context it is a nuisance at worst, and the re-send is exactly the behavior their categorize→re-report loop requires.
- On-demand reports landing inside the 60-minute bank-sync window show the **recalculated** balances without a fresh bank sync. **The user has explicitly accepted this**: after categorizing, the missing sync does not make the report stale — the balance changes come from their own action.

## Non-Goals

- Replacing the 20:00 daily report or the daily email (D2: email is a complement; the daily cadence remains the baseline).
- Free-form chat, natural language, or any conversational interaction with the bot (D5 deferred this for v1; this problem does not require it).
- Changing **who** is allowed to categorize transactions (D3: any group member, first-answer-wins) — this problem is about *reading/triggering* data, not about write-back authorization.
- A multi-user product: no accounts, roles, or per-user configuration beyond what this single private group already has.
- Modifying the schedule of the cron itself.

## Success Metrics

- M1 — Time from "want the report now" to "report visible in the group" is under ~1 minute, with zero server/shell interaction (baseline: `docker compose exec actual_notifier node src/reporte-diario.js` from a terminal — several minutes, requires SSH/Docker context). **Measurable**: observed once end-to-end in the group.
- M2 — The user can request the report after at least one week without consulting any documentation or reminder — the request syntax is discoverable purely from the Telegram client (baseline: currently impossible, the path does not exist). **Measurable, qualitative check by the user**.
- M3 — Store consistency under repeated on-demand delivery: after N on-demand requests (suggested N ≥ 10), the interaction store holds no orphan pending rows and no expired-but-active buttons (baseline: current correct behavior per store.js `claimAnswer`/`expirePreviousPending`). Note: re-expiring previous reports' buttons on each new report is **expected and accepted** (D6) — M3 checks store invariants, not absence of re-sends. **Measurable** with the existing smoke-test pattern (`src/dev/panel-smoke-test.js`-style).
- M4 — Data-freshness honesty: when the on-demand report lands inside the 60-minute bank-sync window, the summary line must not imply a fresh bank sync (the existing "omitido (hace X min, umbral 60)" omission line in `buildSummaryText` is sufficient; no special new UI). The recalculated balances are by definition fresh. **Qualitative.**

## Cost of Inaction

- The daily 20:00 report + email remain the single source of truth; everything else keeps working. Cost of *not* building is low and bounded: at most, occasional manual `docker compose exec` runs from the server, and the user continues relying on memory for anything on-demand.
- The "forget the command" pain only grows if a command path is built without discoverability — i.e., the partial solution (trigger without discoverability) creates a *worse* state than inaction: a feature nobody remembers how to use.
- No compliance, security, or deadline pressure found in intake or research. Nothing happens if this is never built.

## Open Questions

- **Resolved 2026-09-24 (user):** the two pains are NOT to be separated — the user wants the on-demand execution, with the dominant use case being the categorize→re-report loop. Re-sends and re-expired buttons are explicitly accepted (see Accepted risks above).
- **Resolved 2026-09-24 (user):** the post-categorization re-report is the motivating case; a cooldown throttling it would defeat the feature's main use — any rate limit must be designed around this loop.
- [NEEDS CLARIFICATION: Does "notificaciones de operaciones pendientes de categorizar" mean *the current interactive list* (what sendReport already delivers in the daily run) or a *status summary* of what is pending without reopening the interactive flow? G1 assumes the former; the distinction changes the effect on D6 expiry.]
- [NEEDS CLARIFICATION: Expected behavior when there is nothing pending and the report window is empty — and whether "nothing to say" should be silent or acknowledged.]
