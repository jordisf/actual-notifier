# Idea Intake: Comando de Telegram para reporte y notificaciones on demand

- **Slug**: telegram-on-demand
- **Created**: 2026-09-24
- **Source**: pasted text
- **Type**: improvement

## Idea (as captured)

> "como usuario de telegram con acceso al grupo al que se notifica el reporte de actual budget y las operaciones por categorizar quiero poder escribir un comando en el grupo de telegram para que se genere el reporte on demand y las notificaciones de operaciones pendientes de categorizar. Quiero que el bot me facilite esta interaccion ya que puedo no acordarme del comando que debo pedir"

## Restated

A user who already has access to the Telegram group that receives the Actual Budget report and the uncategorized-operations notifications should be able to type a command in that group to trigger the report and/or the pending-categorization notifications on demand. In addition, the bot should make this interaction easy — for example by reminding or hinting the user which command to use, since the user might not remember it.

## Origin & Context

- **Raised by**: the user (workspace owner) — [NEEDS CLARIFICATION: is this a single user or a group of users?]
- **Trigger**: the user can't always remember which command to send to request the report on demand.

## First-Glance Unknowns

- [NEEDS CLARIFICATION: Which bot / where does it run — Telegram group the notifier posts to, or a different bot?]
- [NEEDS CLARIFICATION: Does "un comando" mean one command that does both (report + uncategorized), two separate commands, or a menu?]
- [NEEDS CLARIFICATION: Who is allowed to trigger it — any group member, specific users, or admins only?]
- [NEEDS CLARIFICATION: What does "me facilite esta interaccion" concretely mean — a `/start`-style hint, a reply with available commands, a Telegram command menu, a reminder when the user types something close?]
- [NEEDS CLARIFICATION: Expected behavior when no transactions are pending / report window is empty — confirm silently, send "nothing to report", or an error message?]
