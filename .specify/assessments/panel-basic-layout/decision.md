# Decision: Maquetación básica + shell de layout para el panel de configuración

- **Slug**: panel-basic-layout
- **Decided**: 2026-09-23
- **Verdict**: go
- **Artifacts reviewed**: intake.md | problem.md | concept.md (research.md ausente — la evidencia se construyó por inspección directa del código durante define y shape)

## Scorecard

| Criterion | Rating | Justification |
|-----------|--------|---------------|
| Problem validity | strong | Verificado en código, no asumido: las 6 vistas de `src/panel/views/` no tienen `<link>` a CSS, `<style>` ni clases; el login es HTML inline sin estilo en `routes/login.js`. Un panel de configuración denso sin jerarquía visual es un problema real de usabilidad para su único operador. |
| Evidence strength | adequate | Sin `research.md`, pero el problema se ancla en inspección directa del repo (vistas, `server.js`, `Dockerfile.panel`, `Dockerfile.panel` bakes in `src/panel/` sin build step). No hay claims externos que validar. Los desconocidos restantes (login en scope, `reveal`, responsive) afectan forma, no validez. |
| Value vs. inaction | adequate | El coste de inacción no es un riesgo funcional (nada se rompe hoy) sino operativo: error de configuración más probable en cada interacción, y crece a medida que más ajustes migran de `.env` al panel. El valor es real pero incremental, no urgente. |
| Feasibility / appetite | strong | Opción B seleccionada y confirmada explícitamente por el owner: 1 archivo CSS propio + helper de layout mínimo sobre la sustitución `{{var}}` existente, compatible con el `COPY src/panel/` de `Dockerfile.panel` sin cambios. Appetite small (días). |
| Strategic fit | adequate | No se encontró constitution del proyecto; el cambio respeta la dirección ya documentada en el código del panel ("no framework", HTTP server vanilla, sin build step) y no toca el contrato funcional de spec 001. |
| Risk posture | strong | Riesgos principales identificados y mitigados en el concept: repetitividad de tocar los 8-9 `register()` (falla visible, no subtle), rabbit hole de estandarizar templates (explícitamente fuera de scope), y la página login por fuera del sistema de vistas (incluida explícitamente en el scope de B). Sin riesgo funcional: es un cambio puramente presentacional. |

## Verdict & Rationale

**Go.** Ningún criterio está en `weak` o `unknown`: el problema es real y verificado en código, la opción recomendada (B: stylesheet compartido + shell de layout) fue confirmada explícitamente por el owner este mismo día, el apetito es small, y el riesgo es presentacional con fallas visibles. El único rubro por debajo de strong es Value vs. inaction, coherente con un cambio de polish/operabilidad y no un bloqueador estratégico — no impide el go porque la validez del problema y la factibilidad compensan sin riesgo funcional. Los open questions restantes (responsive, alcance exacto de métrica) son detalles de especificación, no bloqueadores: `concept.md` ya los acota como tolerancia, no requisito.

## If go — Handoff to `/speckit-specify`

- **Problem**: El panel web de configuración de actual-notifier (7 páginas: 6 vistas en `src/panel/views/` + login/set-password inline en `routes/login.js`) funciona pero es HTML plano sin ningún estilo, sin jerarquía visual ni navegación común, dificultando el uso por parte del único operador.
- **Chosen approach**: Opción B (confirmada por el owner): un único `panel.css` de autor propio + shell de layout común (header, navegación entre las 6 secciones autenticadas, zona de logout) inyectado vía helper mínimo sobre la sustitución `{{var}}` existente; login/set-password usan el mismo CSS con layout centrado simple.
- **In scope / out of scope**: In — CSS propio sin dependencias, shell con nav para las 6 páginas autenticadas, tratamiento visual del login, marcar la sección activa en la nav. Out — cambios funcionales (spec 001 íntegra), responsive/mobile como objetivo, dark mode/theming, frameworks o build steps, template engine, JavaScript de UI, y `reveal` como página (flujo, confirmar durante especificación).
- **Success metrics**: Todas las páginas (incl. login) enlazan el mismo CSS; las 6 páginas autenticadas comparten header y navegación; un operador identifica página actual, formulario activo y errores en un vistazo — verificable por inspección de HTML y pase manual de navegador.
- **Carried-forward open questions**:
  1. Confirmar qué hace la ruta `reveal` (asumido: flujo no-página, fuera del shell).
  2. Confirmar que ningún `.dockerignore` excluya una futura subcarpeta de assets de `src/panel/`.
  3. Responsive: tolerancia (no explote) vs. requirement — resolver en especificación, default tolerancia.
