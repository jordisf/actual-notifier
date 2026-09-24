# Feature Specification: On-Demand Report Command (Telegram Group)

**Feature Branch**: `003-telegram-report-command`

**Created**: 2026-09-24

**Status**: Draft

**Input**: User description (from the completed `telegram-on-demand` assessment, handoff in `.specify/assessments/telegram-on-demand/decision.md`): As a member of the private Telegram group that receives the Actual Budget report and the uncategorized-operations notifications, I want to type a command in the group to generate the report on demand — especially right after I categorize transactions, because categorizing changes the balances shown in the report — and I want the bot to make this interaction easy since I may not remember the exact command.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Refresh the report from the group, especially after categorizing (Priority: P1)

A group member wants to see the current report without waiting for the scheduled daily run. This is most valuable in a routine loop: the member receives the daily report, categorizes one or more pending transactions, and then wants the report re-generated to see the updated balances that result from their categorizing action. They should be able to do this entirely inside the group, by sending the report command, with no access to the server or any terminal.

**Why this priority**: This is the core, confirmed, high-frequency use case. It delivers value on its own (an MVP that works even if the member types the command by hand), and it directly serves the motivation that made the on-demand path worthwhile rather than just a discoverability fix.

**Independent Test**: From within the group, send the report command and confirm the bot delivers a fresh report. Then categorize a pending transaction and send the command again, confirming the delivered balances reflect the categorization — all without any server access.

**Acceptance Scenarios**:

1. **Given** nothing has run recently and the budget has current data, **When** a group member sends the report command in the group, **Then** the bot delivers the report (summary plus the pending-uncategorized-transaction items with their category-selection controls) as it does in the scheduled run.
2. **Given** a member has just categorized one or more pending transactions, **When** they send the report command, **Then** the delivered report reflects the updated balances resulting from that categorization, not the figures from the last scheduled run.
3. **Given** the report was last generated shortly before the request and no new bank synchronization has occurred in the interval, **When** the member sends the report command, **Then** the balance figures are current while the report makes clear the bank-synchronization timestamp is from the previous sync (it does not imply a fresh bank pull).
4. **Given** a member wants the report twice in quick succession, **When** they send the command both times, **Then** the report is regenerated and re-delivered on each request (repeated requests are permitted, not throttled).

---

### User Story 2 - Discover the command without remembering its syntax (Priority: P2)

A group member does not reliably remember the exact command to request the report. They should be able to discover it from within the Telegram client for the group (the client's command menu) so that asking for the report never depends on memorizing syntax or consulting documentation.

**Why this priority**: The intake explicitly motivates the idea with "I may not remember the command." Discoverability is what makes User Story 1 usable day-to-day, but a member who already knows the command gets full value from User Story 1 alone, so this ranks second.

**Independent Test**: In the group, open the client's command menu (type the command trigger `/`) and confirm the report command is listed; select it and confirm the report is delivered without having typed anything the member had to recall.

**Acceptance Scenarios**:

1. **Given** a member is in the group and does not know the command syntax, **When** they open the client's command menu for the group, **Then** the report command appears in the list with enough description to know it generates the report.
2. **Given** the report command is available in the menu, **When** the member selects it, **Then** the report is delivered exactly as if they had typed it.

---

### User Story 3 - Get a clear answer when there is nothing to report (Priority: P3)

A group member requests the report at a moment when there are no pending transactions and nothing of interest to show. They should receive a brief, unambiguous acknowledgment instead of silence, so a "blank" response is not mistaken for the command not working.

**Why this priority**: This is an edge of User Story 1 that improves perceived reliability. It adds no new capability and is not needed for the core loop to work, so it is lowest priority.

**Independent Test**: Arrange a state with no pending transactions, send the command, and confirm the bot responds with a short "all caught up"-style acknowledgment rather than nothing.

**Acceptance Scenarios**:

1. **Given** there are no pending transactions and nothing to report, **When** a member sends the report command, **Then** the bot replies with a brief acknowledgment that the report ran and found nothing pending (not silence).

---

### Edge Cases

- **A member sends the command immediately after the scheduled daily run:** the report is still produced from current budget data; the bank-sync timestamp reflects the previous sync and is not misrepresented as fresh.
- **Repeated rapid requests:** each request is honored and re-delivers the report; previously delivered pending items become superseded/expired by the new report (existing behavior), and the system does not crash or leave pending items mis-marked.
- **A member sends text that is not the report command:** the bot does not treat it as the report command and does not initiate any conversational reply.
- **A request made from a private message to the bot (outside the group):** the on-demand interaction is not offered; it is available only within the configured group.
- **There are pending transactions but the member only wants to look, not categorize:** the interactive report is delivered (the report still carries the category-selection controls), since the on-demand report matches the scheduled report.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow any member of the configured Telegram group to trigger report generation by sending the report command within that group.
- **FR-002**: When the report command is received, the system MUST deliver the same report as the scheduled daily run: a summary of the budget plus the pending-uncategorized-transaction items with their category-selection controls.
- **FR-003**: The generated report MUST reflect the current state of the budget at the moment of the request (balances and pending list recomputed), not a cached copy from the last scheduled run.
- **FR-004**: The report command MUST be discoverable within the Telegram client's command menu for the group, so a member need not know its exact syntax to trigger it.
- **FR-005**: The system MUST allow the report to be requested repeatedly; each request MUST regenerate and re-deliver the report. (Repeated requests are intentionally not throttled or rate-limited.)
- **FR-006**: When a request is made within a short window after the last bank synchronization, the delivered summary MUST make clear that the balance figures are current while the bank-synchronization reference is from the previous sync; it MUST NOT imply a new bank pull occurred.
- **FR-007**: When there are no pending transactions and nothing to report, the system MUST respond with a brief acknowledgment rather than remaining silent.
- **FR-008**: The system MUST respond to the report command only; it MUST NOT engage in free-form or conversational replies for other messages.
- **FR-009**: Triggering the report MUST NOT change who is allowed to categorize transactions or otherwise alter the existing categorization authorization rules.
- **FR-010**: The on-demand interaction MUST be available only within the configured group; it MUST NOT be offered via private messages to the bot.

### Key Entities

- **Report (on-demand snapshot)**: A point-in-time view of the same content the scheduled run produces — budget summary, per-category balances, pending-uncategorized transactions, and the bank-synchronization reference. Regenerated on each request.
- **Pending (uncategorized) transaction**: A transaction in the current period lacking a category, surfaced in the report with the controls used to assign it a category.
- **Group member**: A participant in the configured Telegram group; any member may trigger the report (consistent with existing behavior that any member may act on the report's controls).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A group member can obtain an up-to-date report from within the group in under one minute, with no server, terminal, or configuration access.
- **SC-002**: After categorizing one or more pending transactions, a member can re-request the report and see the updated balances with no manual server action.
- **SC-003**: A member who does not know the command can discover it from the client's command menu and successfully trigger the report within one request, without consulting documentation.
- **SC-004**: The scheduled daily report, its email delivery, and the existing categorization flow continue to work unchanged (no regression) after this feature is added.
- **SC-005**: After at least ten on-demand requests (including repeated ones), the pending-transaction state contains no orphaned or mis-marked items (no pending item left active after it should be superseded, and none unresolvable).

## Assumptions

- Single private Telegram group, operated within a personal (homelab) environment with no internet exposure; the primary user is effectively a single member.
- Any group member may trigger the report, consistent with the existing rule that any group member may act on the report's category controls.
- The on-demand report delivers the same full content as the scheduled report, including the interactive category-selection controls — not a read-only summary.
- Repeated deliveries, and the superseding/expiring of previously delivered pending items when a new report arrives, are accepted and intended behavior for the categorize→re-report loop; no cooldown or rate limit is added (a cooldown was explicitly considered and rejected because it would block the primary post-categorization request).
- Where a request lands shortly after the last bank synchronization, "current balances" is sufficient; no additional user-facing stale-state handling beyond the existing synchronization reference is required.
- This feature reuses the existing report-generation and report-delivery behavior; it does not change the cron schedule, the email, private-message behavior, or any configuration-panel surface.
