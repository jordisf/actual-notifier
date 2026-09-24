# Contract: `/report` group command & accepted updates

**Feature**: `003-telegram-report-command` | **Date**: 2026-09-24

This repo's external interfaces are (a) the Telegram bot surface and (b) what lands in the SQLite store. This contract covers (a); the store side is in `../data-model.md`.

## 1. Command menu (Bot API `setMyCommands`)

Registered by the listener at boot and on `TELEGRAM_BOT_TOKEN` change (idempotent):

```json
{ "commands": [ { "command": "report", "description": "Generar el reporte ahora" } ] }
```

- Exactly one command. No scope argument (defaults to all chats; only the configured group consumes it anyway).
- Description language: Spanish, matching the bot's existing user-facing strings.
- Failure (network, 401, 400) is logged and does NOT stop the listener; retried at the next token change or restart.

## 2. Accepted updates

The listener's `getUpdates` call expands from:

```text
allowed_updates: ["callback_query"]        →   ["callback_query", "message"]
```

All other update types remain filtered out by Telegram server-side (no `edited_message`, no `channel_post`, etc.).

## 3. Message handling — recognition rules (exact)

An inbound `message` update is treated as the **report command** iff **all** hold:

1. `message.text` is a string; `trim()`ed it matches `^/report(@[A-Za-z0-9_]+)?\s*$`
   (bare `/report` or `/report@botusername`, optional trailing whitespace).
2. `message.chat.id` (string-compared) equals `TELEGRAM_GROUP_ID`.

Everything else (any other text, stickers, photos, callbacks from unknown senders, messages from other chats, DMs) is **ignored without any reply** (spec FR-008, FR-010).

## 4. Response sequence for a valid command

| Step | Message to the group | Notes |
|------|---------------------|-------|
| 1 (immediate) | `⏳ Generando reporte…` (`sendMessage`) | Sent before any Actual work, so Telegram UX is never a timeout (research.md R5). |
| 2a (pipeline OK, has content) | full report as the cron delivers it: summary message + one interactive message per uncategorized tx (existing `sendReport` output) | Step-1 message is left as-is (history shows the request). |
| 2b (pipeline OK, nothing to report) | step-1 message **edited** to a brief "todo al día" line (no separate report spam) | spec FR-007 / US3. Exact wording is an implementation detail; must make clear no report content was needed. |
| 3 (pipeline failure) | step-1 message **edited** to a one-line error (no stack traces, no internal paths) | e.g. `❌ No se pudo generar el reporte (error interno).` |

## 5. Concurrency surface

- While a report is in flight, an additional valid command yields a step-1-style short reply (`⏳ Ya hay un reporte en curso…`) and one queued re-run after the current one finishes (depth 1); a third concurrent command gets the same short reply and is NOT queued (bounded, no accumulation) (research.md R8).
- The queued re-run follows the normal response sequence (4) when it starts.

## 6. What is explicitly NOT part of this contract

- No second command (`/pendientes`, `/help`, …) — spec Assumptions; the single command delivers the full report including interactive pending items.
- No reply to free text — no conversational behavior at all (FR-008).
- No DM handling — the bot keeps behaving as before in private chats (nothing new is offered there; FR-010).
- No authorization changes — any member of the configured group may trigger (spec Assumptions, consistent with existing D3 any-member buttons). This contract does NOT introduce per-user allow-lists.

## 7. Observability

- Every accepted command logs at `info` with: `chat_id`, `from.id`, `from.username`, and a short outcome tag (`sent` | `empty` | `failed` | `queued-dropped`).
- Every ignored `message` update is NOT logged at info (group noise would be meaningless); malformed/unknown commands are simply not in the recognition set and are ignored by design — logging them would leak every group member's chatter into the log. (Design decision: silence is the correct behavior per FR-008.)
