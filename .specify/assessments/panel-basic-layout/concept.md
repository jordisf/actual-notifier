# Concept: Maquetación básica y funcional para el panel de configuración

- **Slug**: panel-basic-layout
- **Created**: 2026-09-23
- **Recommended option**: B — stylesheet compartido + shell de layout común

## Options

### Option A — Sheet de estilos única, sin shell
- **Sketch**: un único `panel.css` de autor propio (sin dependencias) se enlaza desde las 7+ páginas existentes (6 vistas de `src/panel/views/` + las páginas inline de login/set-password en `routes/login.js`). Las páginas se ven como hoy pero con tipografía, espaciado, botones y campos legibles y coherentes. No se añade navegación común: se mantiene el enlace "Back to dashboard" existente como único hilo conductor.
- **Appetite**: small (días)
- **Trade-offs**: gana el mínimo impacto — cada vista solo necesita una línea `<link>` y, si hace falta, unas clases semánticas locales; casi ninguna regresión funcional posible. Sacrifica el objetivo 2 del problema ("percibirse como un solo producto"): sigue habiendo 7 documentos que solo comparten colores, y la navegación depende del enlace de pie de página. Riesgo: inconsistencia residual si cada template envejece por su cuenta.
- **Rabbit holes**: decidir si la página de login (HTML inline en `routes/login.js`, fuera del sistema de vistas) recibe el mismo `<link>` — si no, el arranque del panel se ve cojo.

### Option B — Sheet compartida + shell de layout (header, título, nav)
- **Sketch**: sobre Option A se añade un shell común: header con el nombre del panel, navegación (Dashboard / Actual / Recipients / Schedule / SMTP / Telegram) y zona vacía para logout, inyectadas en todas las páginas autenticadas. Dado que no hay template engine (cada ruta hace `fs.readFileSync` + sustitución `{{var}}`), el shell exige un pequeño helper compartido de layout — por ejemplo, una función `renderLayout(page, content)` o un par de parciales (`header.html`, `footer.html`) que las rutas ya embeban en su render. El login sigue siendo una página centrada y simple, con el mismo CSS.
- **Appetite**: small — borde de medium (días; el helper de layout toca los 8-9 `register()` de rutas una a una, lo cual es repetitivo pero mecánico)
- **Trade-offs**: gana el objetivo 2 completamente (un solo producto, navegación de un click) y hace el panel operable a velocidad. Sacrifica algo de superficie de cambio: tocar cada módulo de rutas es la parte más propensa a error (una ruta que se olvide el shell o rompa su sustitución `{{var}}`). Riesgo: el helper introduce el primer punto de acople entre vistas, que hoy no existe.
- **Rabbit holes**: (1) la tentación de estandarizar los 8 templates en un solo motor mientras estamos ahí — scope creep garantizado; (2) que el shell necesite saber la ruta activa para marcar el item de nav, lo que obliga a pasar contexto a cada render; (3) decidir dónde vive el helper y cómo lo consumen las 2 páginas inline de `login.js`.

### Option C — Framework CSS vendored (p. ej. Pico o Pure vendeados en el repo)
- **Sketch**: se descarga y se commitea un framework CSS utilitarian en `src/panel/` (o una subcarpeta `static/`) y se consume desde las 7+ páginas + opcionalmente un shell mínimo; el panel hereda un look "profesional de stock" sin escribir CSS propio.
- **Appetite**: small (días) — pero con cola de mantenimiento
- **Trade-offs**: gana velocidad visual inicial y un look más pulido con menos CSS propio. Sacrifica coherencia con la decisión de proyecto "no framework" investigada para el panel (`server.js` literalmente documenta "no framework"), añade bytes innecesarios a la imagen para una UI de 8 páginas, y toma decisiones de diseño que no pidió el problema. Riesgo: versión vendored desactualizada, y una superficie de estilos que no se controla completamente cuando haya que ajustar algo.
- **Rabbit holes**: elegir framework y versión, policy de actualización del vendor, y el impulso de adoptar también sus clases de layout (grid, cards) y renegar de la maquetación existente.

## Recommendation

**Option B.** El problema, como se definió, tiene tres objetivos: legibilidad por página (A y B lo cubren), **percibirse como un solo producto** (solo B lo cubre de forma real; A lo deja en "misma paleta"), y proporcionalidad con una herramienta austera (B la mantiene: CSS propio de ~1 archivo y un helper de ~30 líneas, sin framework ni build step — compatible con el `COPY src/panel/` tal cual de `Dockerfile.panel`). El coste extra sobre A (tocar cada `register()` de las 8-9 rutas) es repetitivo pero mecánico y verificable: cualquier ruta rota falla visible, no subtle. Se descarta C por contradecir la dirección "no framework" ya tomada y por traer diseño ajeno a cambio de nada medible.

## Out of Scope (for the recommended option)

- Cambios funcionales: rutas, campos, validaciones, comportamiento del panel (spec 001 intacta).
- Responsive/mobile como objetivo — layout de escritorio; que no explote en ventana estrecha es tolerancia, no requisito (pendiente de confirmación, ver Assumptions).
- Dark mode, theming configurable, design tokens, i18n.
- Cualquier framework CSS o build step (Sass, bundlers, CDNs).
- Rediseño del sistema de plantillas: no se introduce engine de templates; el shell es un helper mínimo sobre la sustitución `{{var}}` existente.
- JavaScript para la UI: el panel opera hoy solo con formularios POST; el shell no debería introducir dependencia de JS.

## Assumptions to Validate

- Ninguna página del panel depende de ausencia de estilos para su funcionalidad (p. ej. un elemento oculto solo por no tener CSS) — validar en el navegador las 8 páginas durante la especificación.
- `routes/login.js` contiene exactamente 2 páginas inline (login y set-password) a tratar; si aparece una tercera, entra en el mismo conteo.
- La ruta `reveal` es un flujo no-página (no requiere shell) — confirmar qué hace antes de escribir las FRs.
- `Dockerfile.panel` no necesita cambios: el helper y el CSS viven bajo `src/panel/` y viajan con el `COPY` existente (validar que no haya `.dockerignore` que excluya `views/` o un futuro `layout/`).
- Un solo operador (el owner) usa el panel — si hay más usuarios, la nav común gana aún más peso y no cambia la recomendación, pero sí la prioridad de la métrica de coherencia.
- La "métrica de éxito" se define como: todas las páginas (incl. login) enlazan el mismo CSS autenticado + las 6 páginas autenticadas comparten el mismo header/nav — verificable manualmente y por inspección de HTML.
