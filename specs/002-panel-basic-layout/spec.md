# Feature Specification: Panel basic layout

**Feature Branch**: `002-panel-basic-layout`

**Created**: 2026-09-23

**Status**: Draft

**Input**: User description: "Tenemos una web app funcionando pero sin ningún estilo visual. Aplica una maquetación básica y funcional para lo que está pensado esta web app." (Assessment completado: `.specify/assessments/panel-basic-layout/` — intake, problem, concept option B, decision: go)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - El panel se lee de un vistazo (Priority: P1)

El operador abre cualquier página del panel de configuración (dashboard, telegram, smtp, actual, recipients, schedule, login, set-password) y puede distinguir sin esfuerzo qué página está, qué campos hay, cuáles están rellenados, qué hay que hacer — porque todas las páginas comparten una apariencia visual coherente y legible, en vez del HTML plano actual.

**Why this priority**: Es el corazón del problema definido: la ausencia total de estilo hace que cada interacción de configuración requiera lectura densa de HTML sin jerarquía, con el riesgo asociado de cometer errores de configuración (destinatarios, credenciales, schedule).

**Independent Test**: Navegar las 8 páginas con la maquetación aplicada y verificar en cada una que: hay un título claro, los formularios y sus campos son visualmente distinguibles, y el conjunto se percibe como el mismo producto. Sin la US2 (navegación común) esto ya aporta valor completo.

**Acceptance Scenarios**:

1. **Given** el panel está servido y el operador abre la página de recipients, **When** la página cargue, **Then** los campos del formulario, las etiquetas, el botón de guardar y los mensajes de error son visualmente distinguibles entre sí, con una apariencia coherente con las demás páginas del panel.
2. **Given** el operador envía un formulario con datos inválidos, **When** el servidor responde con el mensaje de error, **Then** el error se presenta de forma visualmente destacada y diferenciada del contenido normal de la página, sin cambiar la posición ni el comportamiento actual del campo.
3. **Given** el operador tiene la misma acción de configurar destinatarios a día de hoy (HTML plano), **When** repite la acción en la versión maquetada, **Then** la tarea completa el mismo número de pasos y con el mismo resultado — la maquetación no añade, quita ni reordena ninguna funcionalidad.

---

### User Story 2 - Navegación única entre secciones (Priority: P2)

Desde cualquier página autenticada del panel, el operador puede ir a otra sección sin volver al dashboard, y sabe en todo momento en qué sección está — porque las 6 secciones autenticadas comparten una navegación común con la sección activa resaltada.

**Why this priority**: Convierte 7 documentos HTML "unidos por la paleta" en un producto navegable de un click; es la diferencia entre Option A y Option B de concept.md y lo que el owner eligió explícitamente. Depende de la US1 (compartir estilo), pero aporta valor adicional de forma independiente.

**Independent Test**: Desde una página de config (p. ej. /smtp) ir a otra (p. ej. /schedule) con un solo click, y verificar que la sección destino aparece resaltada en la navegación. Sin la US1 esto no tendría sentido visual, pero funciona como prueba aislada de navegación.

**Acceptance Scenarios**:

1. **Given** el operador está autenticado en cualquier una de las 6 páginas autenticadas (dashboard, telegram, smtp, actual, recipients, schedule), **When** la página cargue, **Then** la navegación común con los 6 enlaces de sección es visible y el enlace de la sección actual está visualmente marcado como activo.
2. **Given** el operador está en `/telegram`, **When** hace click en el enlace "Schedule" de la navegación, **Then** llega a `/schedule` en un solo click, sin pasar por el dashboard.
3. **Given** el operador llega al panel sin sesión, **When** accede a cualquier ruta autenticada, **Then** la redirección a la página de login funciona exactamente como hoy (sin cambios de comportamiento).

---

### Edge Cases

- **Login y set-password no llevan la navegación común**: solo se ven con sesión ausente (o bootstrap) y no incluyen las 6 secciones; llevan el mismo estilo visual, con un layout centrado simple.
- **Páginas con un script propio** (como telegram, con el flujo de "mostrar" el token): la maquetación no toca ni reordena ese script ni sus elementos — la funcionalidad "reveal" permanece idéntica.
- **Ventana estrecha**: el layout no se rompe visualmente (los elementos se apilan o la página es desplazable), pero no hay objetivo de diseño mobile.
- **El usuario llega a una sección y su sesión expira a mitad de tarea** (campo rellenado, sin guardar): el comportamiento de redirección a login es el mismo de hoy. No se preserva contenido de formulario en memoria entre redirecciones (fuera del alcance).
- **Error de validación en un campo con mensaje largo**: el mensaje de error se muestra completo, sin cortar, sin importar el tamaño del texto.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Todas las 8 páginas del panel (dashboard, telegram, smtp, actual, recipients, schedule, login, set-password) MUST compartir una única apariencia visual coherente (tipografía, espaciado, colores, estilo de botones e inputs) servida desde el mismo origen sin dependencias externas.
- **FR-002**: Los formularios y sus campos MUST ser visualmente distinguibles del resto del contenido de la página (etiquetas, cajas de entrada, botones de envío, checkboxes) en las 8 páginas.
- **FR-003**: Los mensajes de error de validación MUST presentarse visualmente de forma destacada respecto al contenido normal de la página, preservando el punto exacto donde se muestran hoy (junto al formulario, no en otra parte).
- **FR-004**: El conjunto de páginas alcanzables, su contenido funcional (campos, validaciones, botones) y sus URLs MUST ser exactamente el mismo que antes de la maquetación.
- **FR-005**: Las 6 páginas autenticadas (dashboard, telegram, smtp, actual, recipients, schedule) MUST compartir una barra de navegación común con enlaces a las 6 secciones.
- **FR-006**: La navegación común MUST resaltar visualmente la sección en la que el usuario está.
- **FR-007**: El acceso a "Change password" (set-password) y a "Log out" MUST seguir siendo alcanzable desde el panel autenticado, con la misma apariencia visual coherente que el resto del panel.
- **FR-008**: La página de login y la de set-password (bootstrap) MUST llevar la misma apariencia visual que las demás (tipografía, botón, input), con un layout centrado simple, sin la barra de navegación de secciones (FR-005).
- **FR-009**: El layout MUST degradar sin rotarse visualmente (elementos apilados o con scroll) cuando la ventana del navegador se estrecha por debajo de un ancho de escritorio típico.
- **FR-010**: El flujo "reveal" (unmask one-shot de tokens/contraseñas, p. ej. el botón "Show" de Telegram) MUST funcionar exactamente como hoy: mismo botón, misma interacción, mismo resultado.

### Key Entities

- **Página del panel**: una de las 8 páginas maquetadas, clasificada en dos grupos: (a) páginas autenticadas con navegación común (6) y (b) páginas de autenticación sin navegación (login, set-password).
- **Sección de navegación**: uno de los 6 enlaces de la barra común; cada uno corresponde a una página autenticada y tiene un estado de "sección activa" cuando la página actual es la suya.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Las 8 páginas del panel comparten una apariencia visual reconocible como el mismo producto, sin necesidad de leer el URL para saber que se está en el mismo panel.
- **SC-002**: Un operador puede completar la tarea de "cambiar los destinatarios de notificación" en la versión maquetada exactamente en el mismo número de clicks y con la misma claridad de campo que en la versión sin maquetar, con el campo a modificar visualmente identificable en ≤2 segundos (cualitativo, observable manualmente).
- **SC-003**: Un operador puede ir de cualquier sección autenticada a cualquier otra en exactamente 1 click.
- **SC-004**: El flujo "reveal" (mostrar token de Telegram) funciona igual que hoy tras la maquetación (verificable manualmente: click en Show, valor se muestra).
- **SC-005**: No hay cambio alguno en las URLs, en el comportamiento de redirección a login al expirar sesión, ni en el resultado de ningún POST de formulario — verificable comparando el comportamiento antes/después.

## Assumptions

- El panel es consumido por el owner/operador principal del sistema, desde un navegador de escritorio (coherente con el binding de `PANEL_BIND_HOST` a `127.0.0.1` como default y con una sola persona operándolo hoy).
- Responsive mobile es **tolerancia, no requisito** (FR-009): que el layout no se rompa es aceptable, no hay que optimizar para ancho táctil. Confirmado en el handoff de `decision.md`.
- No se introduce framework CSS, build step ni dependencias frontend: la maquetación se basa en CSS propio servido desde el propio panel (coherente con la decisión ya documentada en el código del panel de minimizar dependencias y con la imagen de despliegue existente que bakes in `src/panel/` tal cual).
- No se introduce un template engine: la maquetación coexiste con la forma actual en que las páginas se construyen (sustitución de marcadores en plantillas HTML por cada ruta), y la navegación se inyecta con un mecanismo mínimo sobre ese mismo patrón, sin un rediseño del sistema de plantillas.
- No hay JavaScript de UI adicional: el panel opera hoy con formularos POST y un script puntual de "reveal" en las páginas con token; la maquetación no añade otro.
- La ruta `reveal` es un flujo HTTP no-página (un uno-shot que devuelve texto plano), no una página HTML, y por tanto no lleva maquetación ni navegación (confirmado en el código durante la decisión).
- El conjunto de páginas a maquetar es de 8: las 6 vistas autenticadas + login + set-password (ambas últimas viven como HTML inline en la misma ruta, no como archivos de vista separados).
- No `.dockerignore` existente excluye assets de `src/panel/` (verificado en la decisión), por lo que un nuevo fichero CSS y/o subcarpeta bajo `src/panel/` viaja en la imagen de despliegue sin cambios en el `Dockerfile`.
- No se cambian las URLs, los nombres de campo de formulario, las validaciones ni el comportamiento de sesión de la spec 001 (config-webapp), que queda íntegra y sin tocar.
