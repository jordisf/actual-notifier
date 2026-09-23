# Feature Specification: Web Configuration Panel for actual-notifier

**Feature Branch**: `[001-config-webapp]`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "Assessment handoff from `.specify/assessments/config-webapp/decision.md` (go — Concept Option C): a dedicated web admin panel, reachable only from the maintainer's LAN/VPN and gated by username+password login, from which all of `actual-notifier`'s configuration (Telegram bot settings, SMTP, Actual Budget connection, notification recipients, and the report schedule) is viewable and editable, with changes applying without a manual container restart."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Secure access and first-time login (Priority: P1)

The operator opens the panel from their LAN/VPN and logs in with a username and password before any configuration is visible or editable. On a fresh install (no password set yet), the operator can log in once without a password but is immediately required to set one before doing anything else.

**Why this priority**: Nothing else in this feature is safe to ship without this — every other story assumes the panel is already access-controlled. It is also independently valuable and demonstrable on its own (a locked panel with a working bootstrap flow).

**Independent Test**: Can be fully tested by deploying the panel with no password configured, confirming the first login succeeds without a password and forces a password-creation step, then confirming a second login requires the newly-set password.

**Acceptance Scenarios**:

1. **Given** no password has ever been set, **When** the operator opens the panel, **Then** they are logged in without entering a password and are immediately presented with a mandatory "set your password" step before reaching any configuration screen.
2. **Given** a password has already been set, **When** the operator enters the correct username and password, **Then** they reach the configuration screens.
3. **Given** a password has already been set, **When** the operator enters an incorrect password, **Then** access is denied and no configuration is shown.
4. **Given** the operator is logged in, **When** they change the username or password from within the panel, **Then** the next login requires the new credentials.

---

### User Story 2 - Configure Telegram settings without a restart (Priority: P2)

The operator views and edits the Telegram bot token, group id, category allow-list, and poll timeout from the panel. Saved changes are validated and take effect for the running Telegram listener without any manual container restart.

**Why this priority**: This is the one concrete, evidence-confirmed gap in today's setup — Telegram-related configuration currently only takes effect after a manually-remembered container restart.

**Independent Test**: Can be fully tested by changing the Telegram bot token or category allow-list through the panel and confirming the listener behaves according to the new value without anyone running a restart command.

**Acceptance Scenarios**:

1. **Given** the operator is logged in, **When** they update the Telegram bot token, group id, category allow-list, or poll timeout and save, **Then** the panel validates the new bot token/group id before applying and the running listener picks up the change without a manual restart.
2. **Given** the operator enters an invalid bot token or group id, **When** they try to save, **Then** the panel reports the validation failure and does not apply the change.

---

### User Story 3 - Configure SMTP, Actual Budget connection, and recipients (Priority: P3)

The operator views and edits SMTP settings, the Actual Budget connection (server URL and sync id), and the notification recipient list from the panel, with secret fields (SMTP password, Actual password) masked by default and revealable on demand.

**Why this priority**: Extends the "no server access needed" goal to the remaining `.env`-driven settings beyond Telegram; valuable but not the originally confirmed gap, so ranked after Story 2.

**Independent Test**: Can be fully tested by changing the SMTP host/credentials through the panel, triggering a test send, and confirming the next report email uses the new settings without a restart.

**Acceptance Scenarios**:

1. **Given** the operator is logged in, **When** they update SMTP settings and request a test send, **Then** the panel reports whether the test succeeded before the change is persisted.
2. **Given** the operator is logged in, **When** they view a secret field (SMTP password, Actual password), **Then** it is shown masked until they explicitly choose to reveal it.
3. **Given** the operator updates the notification recipient list, **When** they save, **Then** the next report is sent to the updated list without a restart.

---

### User Story 4 - Configure the report schedule with a simplified input (Priority: P4)

The operator sets when the daily report runs using one of three simplified modes — every X minutes, every X hours, or once a day at a specific time — without needing to know cron syntax. The change takes effect without a manual restart.

**Why this priority**: A UX simplification on top of an already-solvable problem (the schedule is already editable by hand); lowest priority because it is the least evidence-critical piece of the original ask.

**Independent Test**: Can be fully tested by picking each of the three schedule modes in the panel and confirming the report runs at the expected cadence without a restart.

**Acceptance Scenarios**:

1. **Given** the operator is logged in, **When** they select "once a day at HH:MM" and save, **Then** the report subsequently runs at that time without a restart.
2. **Given** the operator is logged in, **When** they select "every X hours" or "every X minutes" and save, **Then** the report subsequently runs on that cadence without a restart.

### Edge Cases

- What happens when the operator is outside the LAN/VPN? The panel MUST NOT be reachable; there is no fallback web access, and the maintainer retains direct server access as the ultimate fallback.
- What happens when a saved value passes validation but the underlying service still fails later (e.g., the Telegram API is temporarily unreachable at save time but down again shortly after)? The change is still applied; validation only catches failures detectable at save time, not future outages.
- What happens when two sessions edit configuration at the same time? The later save wins; no locking/merge is required for a single-operator tool.
- What happens if `crontab.txt` is edited directly on the server, bypassing the panel? The panel's displayed schedule may become stale until the panel next reads the file; this is acceptable since direct server access remains available as a fallback.
- What happens after repeated failed login attempts? Access MUST be throttled/locked out temporarily to resist brute-force guessing (see Assumptions for the default policy).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The panel MUST require a username and password before granting access to any configuration screen or action.
- **FR-002**: The panel MUST store the password as a salted one-way hash, never as reversible/plain text.
- **FR-003**: When no password hash has been set yet, the panel MUST allow exactly one login without a password and MUST require the operator to set a new password before any other panel function becomes available.
- **FR-004**: The panel MUST let the operator change the username and password from within the panel itself.
- **FR-005**: The panel MUST NOT be reachable from outside the operator's LAN/VPN network.
- **FR-006**: The panel MUST allow viewing and editing Telegram settings: bot token, group id, category allow-list, and poll timeout.
- **FR-007**: Telegram setting changes MUST take effect for the running listener without requiring a manual container restart.
- **FR-008**: The panel MUST validate a new Telegram bot token/group id before applying the change, and MUST reject the save with a reported error if validation fails.
- **FR-009**: The panel MUST allow viewing and editing SMTP settings (host, port, secure flag, user, password) and MUST offer a way to send a test email before persisting a change.
- **FR-010**: The panel MUST allow viewing and editing the Actual Budget connection (server URL, password, sync id).
- **FR-011**: The panel MUST allow viewing and editing the notification recipient list.
- **FR-012**: The panel MUST mask secret values (passwords, bot token) by default and only reveal them after an explicit operator action.
- **FR-013**: The panel MUST offer the report schedule as exactly three simplified modes — every X minutes, every X hours, or once daily at a specific time — without requiring the operator to write cron syntax directly.
- **FR-014**: Schedule changes MUST take effect without requiring a manual container restart.
- **FR-015**: The panel MUST throttle or lock out further login attempts after repeated failures, to resist brute-force password guessing.

### Key Entities

- **Panel Credentials**: username and a hashed password governing access to the panel; supports a one-time no-password bootstrap when unset.
- **Telegram Settings**: bot token, group id, category allow-list, poll timeout.
- **SMTP Settings**: host, port, secure flag, user, password.
- **Actual Budget Connection**: server URL, password, sync id.
- **Notification Recipients**: list of destination email addresses.
- **Report Schedule**: one of three modes — interval in minutes, interval in hours, or a fixed daily time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The operator can view or change any in-scope configuration value (Telegram, SMTP, Actual connection, recipients, schedule) without opening a terminal or SSH session to the server, on every occasion.
- **SC-002**: A saved Telegram or schedule change takes effect within 1 minute, with no manual restart performed.
- **SC-003**: Every configuration value that fails validation (invalid bot token, failing SMTP test) is rejected at save time, with zero instances of a known-invalid value being silently applied.
- **SC-004**: Zero successful panel logins or configuration views occur from outside the operator's LAN/VPN across the deployment's operation.
- **SC-005**: The operator can set up a new report cadence using the simplified schedule input in under 1 minute, without consulting cron syntax documentation.

## Assumptions

- A single shared set of panel credentials (no multi-user roles) is sufficient — no evidence of a second operator exists in this assessment.
- The report schedule only ever needs the three simplified modes (interval-minutes, interval-hours, once-daily-at-time); no atypical schedules are required, per explicit maintainer confirmation during assessment.
- LAN/VPN-only reachability is enforced at the network/deployment level (e.g., no published port beyond the VPN/LAN interface); the exact mechanism is a design-time decision, not a specification concern.
- Default session/lockout policy (to be confirmed at design time, not re-litigated here): a login session remains valid for a reasonable working period (e.g., several hours) and the panel locks out further attempts for a short cool-down period after a handful of consecutive failed logins.
- `.env` (and `crontab.txt` for the schedule) remain the persisted source of truth for configuration; the panel reads and writes them (directly or through a shared mechanism) rather than introducing an entirely separate configuration format.
- The panel runs in its own dedicated container, separate from the existing `notifier-cron`/`notifier-listener` image, per the assessment decision.
