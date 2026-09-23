# Idea Intake: Maquetación básica y funcional para el panel web

- **Slug**: panel-basic-layout
- **Created**: 2026-09-23
- **Source**: pasted text
- **Type**: improvement

## Idea (as captured)

> "Tenemos una web app funcionando pero sin ningún estilo visual. Aplica una maquetación básica y funcional para lo que está pensado esta web app."

## Restated

The config panel web app for actual-notifier (the `config-panel` service, views under `src/panel/views/`) is functional but unstyled — plain HTML with no visual design. The idea is to apply a basic, functional layout/stylesheet appropriate to the panel's purpose (an operator-facing configuration dashboard), without redesigning its functionality.

## Origin & Context

- **Raised by**: project owner/maintainer (speaking in first person plural, "Tenemos")
- **Trigger**: the panel exists and works end to end (spec 001-config-webapp) but ships unstyled HTML views — an observability/polish gap noticed while the panel is in active use (the recipients view was open in the browser during the request)

## First-Glance Unknowns

- [NEEDS CLARIFICATION: What counts as "básica y funcional" — a shared plain-CSS stylesheet across the existing views, or also a common layout shell (nav, header) tying the pages together?]
- [NEEDS CLARIFICATION: Any constraint against external CDNs/frameworks — the panel image (`Dockerfile.panel`) bakes in only the files it needs, so a vendored or zero-dependency static asset is likely expected, but confirm]
- [NEEDS CLARIFICATION: Is responsive/mobile support in scope, or is a fixed desktop-width layout acceptable for a localhost-bound admin panel?]
- [NEEDS CLARIFICATION: Should the login page get the same treatment, or only the authenticated views (dashboard, actual, recipients, schedule, smtp, telegram)?]
