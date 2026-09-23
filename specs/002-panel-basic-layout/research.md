# Research: Panel basic layout

**Feature**: `002-panel-basic-layout` | **Date**: 2026-09-23

All NEEDS CLARIFICATION items from the plan's Technical Context were resolved by direct code inspection of the existing panel (001 implementation). No external research was required — every unknown is answered by the code already in the repository.

## R1. How should the stylesheet be served?

**Decision**: Serve `src/panel/static/panel.css` from the existing hand-rolled router as a new route: `GET /static/panel.css` → respond with `Content-Type: text/css; charset=utf-8` + `Cache-Control: no-store`, reading the file via `fs.readFileSync` (same pattern the routes already use for views). The handler is wrapped in `requireSession` exactly like the other page routes — the panel does NOT gate globally; each route module wraps its own handlers, so the static route must take the guard explicitly (the CSS path stays invisible to unauthenticated probing, consistent with 001's LAN/localhost threat model).

**Rationale**: Zero new dependency; matches the existing "everything is a router entry" architecture (`server.js` registers route modules explicitly — there is no middleware/static-file layer to reuse or extend). One file, read per request, is fine at one-operator scale; no caching headers are warranted (the container restarts on deploy, and the panel is localhost-bound).

**Alternatives considered**:
- *Inline the CSS in every page's `<head>` via the layout helper* — rejected: ~3KB duplicated across 8 pages in every response; a single `<link>` is simpler and keeps the CSS editable in one place without re-rendering every template.
- *A catch-all `/static/*` handler* — rejected: YAGNI; one known, constant file path is all the spec requires, and a glob handler is more attack-surface reasoning than this feature needs.

## R2. How should the shared layout (nav) be injected without a template engine?

**Decision**: A new small module `src/panel/layout.js` exporting two pure functions:

- `renderPage({ title, active, body })` — the full authenticated shell: `<!doctype html>` document with `<link rel="stylesheet" href="/static/panel.css">` in `<head>`, a `<header>` (panel name), a `<nav>` with the 6 section links (Dashboard `/`, Telegram `/telegram`, SMTP `/smtp`, Actual `/actual`, Recipients `/recipients`, Schedule `/schedule`), the active section marked with an `aria-current="page"` attribute + `.active` class, a `<main>` wrapping `body`, and a footer holding the existing "Change password" link + logout form (moved from `dashboard.html` into the shared shell — every authenticated page already has a "Back to dashboard" link that the shared nav superseded, per FR-005/FR-007).
- `renderAuthPage({ title, body })` — the same document + `<link>`, but with a centered `<main class="auth">` and **no** `<nav>` (FR-008). Replaces the existing inline `layout(title, body)` helper in `routes/login.js`.

Both functions are pure string composition (no state, no `fs` except where the caller already loads the fragment). Each route keeps its existing `render({ ... })` → `{{var}}` substitution on the **fragment**, then wraps the result: `renderPage({ title, active: 'recipients', body: applySubstitutions(fragment, vars) })`. The substitution order is unchanged — `{{var}}` markers are replaced **before** wrapping, so the shell's own markup can never be clobbered by a data value, and a route that forgets the wrap fails visibly (page renders as a bare fragment), not subtly.

**Rationale**: This is the minimal coupling point Option B anticipated. Because the shell is composed *after* per-route substitution, the helper cannot interfere with any route's existing `{{var}}` contract; the only per-route diff is "wrap the returned string".

**Alternatives considered**:
- *Partials files (`header.html`/`footer.html`) concatenated by each route* — rejected: every route would need to `fs.readFileSync` two more files and do string splicing; the function boundary is smaller and type-checks the `active` value in one place.
- *Inject the nav server-wide (post-process every HTML response in `server.js`)* — rejected: it would touch the session middleware and the 404/500 error responses, and it cannot mark the active section without knowing the route intent; per-route wrapping keeps the active-section decision with the route that owns it.

## R3. What exactly goes inside each page's fragment?

**Decision**: Each of the 6 view files loses its `<!doctype html>/<html>/<head>/<body>` wrapper, keeps its `<h1>` (becomes the page heading inside `<main>`), and gains minimal semantic classes for styling purposes only: `class="card"` on the primary form container, `class="error"` on the error paragraph (replacing the inline `style="color:red"` that today is generated in each route's `render()`), and `class="actions"` on the save-button line. Navigation-type markup moves into the shared shell: every fragment drops its `<p><a href="/">Back to dashboard</a></p>` line (superseded by the shared nav, FR-005), and `dashboard.html` additionally drops its "Change password" link and the logout `<form>` — these move into the shared footer emitted by `renderPage` (FR-007), so they render once on every authenticated page instead of only on the dashboard. The telegram reveal `<script>` stays **verbatim at the end of its fragment** (FR-010) — it runs after the DOM above it, same as today.

**Rationale**: Field names, labels, `value` attributes, and `{{var}}` markers are byte-for-byte unchanged except for the listed wrappers — FR-004 is verifiable by diffing every fragment against the old file body.

**Alternatives considered**: none meaningful — this is the spec (FR-002/FR-003/FR-004) expressed at template level.

## R4. Does `Dockerfile.panel` or `docker-compose.yml` need changes?

**Decision**: No. `Dockerfile.panel` already runs `COPY src/panel/ ./src/panel/`, which picks up `layout.js` and `static/panel.css` automatically. `.dockerignore` (verified during decision) excludes only `.env*`, `node_modules/`, `.git/`, and `*.md`. No compose change: same service, same port, same mounts.

**Rationale**: Keeps the blast radius to one source subtree; deployment is a plain image rebuild + `docker compose up -d`, identical to today.

**Alternatives considered**: none — verification closed this out.

## R5. What is the styling baseline?

**Decision**: A single `panel.css` (~2–4KB) of hand-written rules: system font stack, max-width content column (auth pages centered, `max-width: 900px` content column for section pages), consistent `h1` sizing, form controls with visible borders/padding, `.error` in a distinct warning color band (kept in the exact position FR-003 requires), `.nav` horizontal link bar with `.active` visual state, and one `@media (max-width: 720px)` rule that stacks the nav vertically — satisfying FR-009 as graceful degradation only, no mobile optimization (Assumptions).

**Rationale**: "Basic and functional" is the agreed bar (concept Option B, decision). A system-font, no-image stylesheet is the lightest thing that makes all 8 pages read as one product (SC-001) with zero build tooling.

**Alternatives considered**: vendored micro-framework (concept Option C) — already rejected in `concept.md` (contradicts the no-framework precedent and imports design decisions the problem did not ask for).

## R6. How do we prove no functional regression (FR-004 / SC-005)?

**Decision**: A two-layer check documented in `quickstart.md`:
1. **Static**: `node --check` on every touched `.js` file (project's existing convention).
2. **Behavioral**: the quickstart's route-by-route pass — each of the 8 pages GETs, each form POSTs with valid and invalid data, the reveal button works on telegram, session-expiry redirect still lands on `/login`, and logout still clears the cookie. All observable in the running dev container; no new test harness introduced.

**Rationale**: The project has no test framework and the change is presentational; a scripted `node --test` suite for 8 DOM pages would be more machinery than the feature justifies (spec's own testing assumption), while the manual matrix is cheap and covers exactly the SCs.

**Alternatives considered**: a small `node --test` unit test of `layout.js` output (asserts CSS link + nav active marking) — included as an **optional** extra in `quickstart.md` since it is genuinely cheap and guards the one new pure function; not mandatory.
