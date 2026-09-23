# Problem Definition: El panel de configuración es funcionalmente completo pero visualmente inoperable

- **Slug**: panel-basic-layout
- **Created**: 2026-09-23
- **Inputs used**: intake.md (research.md ausente — la idea se verificó directamente contra el código)

## Problem Statement

Quien opera el panel web de actual-notifier (config-panel, puerto 8080) encuentra 7 páginas de HTML plano sin ningún estilo — sin CSS, sin tipografías deliberadas, sin separación visual de secciones, botones o formularios — lo que convierte una herramienta de configuración en algo difícil de escanear y de usar rápidamente, justo en las páginas donde el operador necesita distinguir valores, formularios y estados de error con un vistazo.

## Affected Users & Stakeholders

- **Users**: la persona mantenedora/operadora del propio sistema (mismo individuo que hoy edita `.env` y `crontab.txt` a mano) — navega entre las vistas del panel (dashboard, actual, recipients, schedule, smtp, telegram, login) sin apoyo visual para identificar campos, valores actuales, mensajes de error y enlaces.
- **Stakeholders**: [NEEDS CLARIFICATION: no hay evidencia de otros stakehaders; asumo que el owner es único — confirmar si algún otro operador usará el panel]

## Goals

- Que cada página del panel sea legible a la primera vista: títulos, formularios, valores de configuración y errores visualmente distinguibles.
- Que el conjunto de páginas se perciba como un solo producto (apariencia coherente entre vistas), no como 7 documentos HTML independientes.
- Que el resultado sea proporcional al carácter de la herramienta: un panel de administración funcional y austero, no una experiencia visual elaborada.

## Non-Goals

- Rediseño funcional: no se cambian rutas, formularios, campos, validaciones ni comportamiento del panel (spec 001-config-webapp queda intacta).
- Red de diseño o sistema de diseño completo (design tokens exhaustivos, dark mode, theming configurable).
- Soporte móvil / responsive como objetivo primario [NEEDS CLARIFICATION: confirmar si se acepta layout de escritorio fijo o si la maquetación debe degradar decentemente en ventanas estrechas].
- Dependencias frontend (frameworks CSS, CDNs, build steps) — [NEEDS CLARIFICATION: confirmar la restricción; `Dockerfile.panel` bakes in solo lo que necesita, lo que sugiere un static asset vendored o CSS inline, pero falta confirmación explícita].

## Success Metrics

- Las 7 páginas (6 vistas + login) comparten una apariencia coherente: un operador puede identificar el nombre de la página, el formulario activo y el estado de error (si lo hay) en menos de un vistazo (cualitativo, observable manualmente en el navegador).
- [NEEDS CLARIFICATION: métrica medible precisa — p. ej. "todas las páginas enlazan a la misma hoja de estilos" es verificable; definir si basta o si se exige algo más].

## Cost of Inaction

El panel sigue funcionando pero sigue siendo difícil de usar: cada interacción de configuración (cambiar destinatarios, ajustar el schedule, rotar credenciales SMTP/Telegram) requiere leer HTML denso y sin jerarquía visual, aumentando la probabilidad de errores de configuración — y ese riesgo crece a medida que más ajustes migran de `.env` al panel. No hay riesgo funcional: nada se rompe hoy por la ausencia de estilo.

## Open Questions

- [NEEDS CLARIFICATION: ¿Qué incluye "básica y funcional" — solo stylesheet CSS compartido, o también un shell de layout común (header + navegación) que una las páginas?]
- [NEEDS CLARIFICATION: ¿Se acepta CSS sin dependencias externas / vendored (coherente con `Dockerfile.panel`), o hay preferencia por alguna herramienta?]
- [NEEDS CLARIFICATION: ¿La página de login (HTML inline en `src/panel/routes/login.js`, fuera del sistema de vistas) entra en el tratamiento o solo las 6 vistas de `src/panel/views/`?]
- [NEEDS CLARIFICATION: ¿Responsive/mobile está en scope o layout de escritorio fijo es aceptable para un panel bound a localhost?]
- [NEEDS CLARIFICATION: ¿Existe algún otro operador del panel además del owner, que justifique coherencia de UX como métrica dura?]
