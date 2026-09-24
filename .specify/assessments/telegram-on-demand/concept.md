# Concept: Comando on demand /report en el grupo de Telegram con auto-descubribilidad

- **Slug**: telegram-on-demand
- **Created**: 2026-09-24
- **Recommended option**: B

## Options

### Option A — El mínimo funcional: comando `/report` + menú de comandos
- **Sketch**: El usuario escribe `/report` en el grupo (o lo ve aparecer en el menú de "/" de Telegram al tipear `/`) y el bot responde enviando exactamente lo que ya envía la corrida diaria: resumen + mensajes interactivos por transacción pendiente. No cambia el flujo de categorización existente.
- **Appetite**: small (días). La generación del reporte es re-entrante (`compute()`/`sendReport()` son funciones asíncronas ya exportadas) y el listener ya tiene el loop de polling; solo se extiende `allowed_updates` y se agrega un handler de texto + registro del menú.
- **Trade-offs**: Gana G1 y G2 de golpe y con muy poco esfuerzo. Sacrifica G3 a medias: no hay límite de repetición (un `/report` 10 veces en 10 minutos reenvía 10 reportes y re-expira botones pendientes 10 veces vía D6), y el stale-sync de la ventana de 60 min puede leerse como snapshot fresco (M4). Riesgo: spam y confusión de frescura, ambos directamente atribuibles a no ponerle piso al G3.
- **Rabbit holes**: mínimo por sí solo, pero *el* rabbit hole es dejar G3 sin cerrar: si se vive un rato así, surge la presión de "agregarle algo" (ack de "ya se generó hace X min", botones "ver pendientes"...) que convierte el small en un creep permanente.

### Option B — Comando con piso de comportamiento (A + guardas de estado)
- **Sketch**: Lo mismo para el usuario que A, con comportamientos adicionales: (1) cooldown corto por grupo — un segundo `/report` dentro de X minutos responde "el reporte ya se generó hace N min" sin reenviarlo; (2) dentro de la ventana de throttle de sync-de-banco, la línea de resumen dice explícitamente que el sync es del dia/hora anterior; (3) si no hay pendientes y el resumen es trivial, se responde con un "todo al día" breve en vez de silencio ruidoso; (4) menú de comandos registrado para descubribilidad.
- **Appetite**: small–medium. Sobre la base de A agrega decisiones de policy + estados de respuesta + casos de borde; el riesgo técnico no crece mucho porque las guardas viven en el mismo handler del comando y en una línea extra de `buildSummaryText`. Marcar incertidumbre: para un solo desarrollador, "días, no semanas".
- **Trade-offs**: Gana G1, G2 **y** G3 (que es la única meta que A no cubre completa). Sacrifica unas pocas decisiones que hay que tomar antes de escribir código (duración de cooldown, qué decir en vacío, si `/pendientes` merece existir como segundo comando o no) y un poco más de superficie de tests (M3 ya lo exige de todos modos).
- **Rabbit holes**: (1) el cooldown que se convierte en configuración "lo hago configurable desde el panel" — no, fijo por ahora; (2) segregar `/report` de `/pendientes` y sus variantes; (3) el "estado del throttle" empuja a refactorear `buildSummaryText` y ahí se abre el mundo.

### Option C — No hacer nada (status quo: `docker compose exec … node src/reporte-diario.js`)
- **Sketch**: Mantener la corrida de 20:00 + email como único canal; cuando se necesita más, ejecutar el script a mano desde el servidor (ya documentado en el README).
- **Appetite**: n/a.
- **Trade-offs**: Cero riesgo técnico y cero debt. Sacrifica G1 y G2 por completo. Es honesto decir: el costo de inacción es bajo y acotado (problem.md lo dice explícitamente) — pero el dolor (dificultad de acceso fuera de la ventana + no acordarse de cómo pedirlo) persiste indefinidamente, y el fix parcial de "el trigger sin descubribilidad" —la peor opción según problem.md— queda siempre tentador.
- **Rabbit holes**: ninguno.

## Recommendation

**Option B.** La razón se apoya en las metas del propio problem.md: G3 existe explícitamente y solo B la cubre completa; A la deja a medias y su rabbit hole documentado es exactamente el creep que G3 estaba diseñando para evitar. G1+G2 se resuelven con el mismo esfuerzo base en A y en B — las guardas no duplican alcance, terminan el que ya está decidido. Contra C: B cuesta días, el dolor es real aunque acotado, y la alternativa C mantiene una dependencia del shell que el usuario (homelab, sin exposición a internet — D7) tiene hoy por costumbre, no por necesidad. **Condición de la recomendación**: si el cooldown y el "todo al día" se vuelven pesados para el gusto del único usuario, B degrada a A de forma limpia (se retiran los guardas, se mantiene el comando y el menú).

## Out of Scope (for the recommended option)

- Chat libre / lenguaje natural con el bot (D5, no-goal del problem).
- Cambiar la autorización de write-back de categorización (D3; problem no-goal).
- Múltiples usuarios con configuración individual, roles, o allow-lists (el trust actual "cualquier miembro del grupo" se mantiene).
- Configurar nada de esto desde el panel (el panel es config-only; no se le añade UI por este concepto).
- Modificar la cadencia del cron o el reporte diario de 20:00, ni tocar el email (D2).
- Comandos adicionales (`/pendientes`, `/cancelar`, menus conversacionales): solo `/report` (y su menú) entra en este concepto; los demás son follow-up explícito.
- DMs con el bot fuera del grupo (D1: grupo privado único).

## Assumptions to Validate

1. **`setMyCommands` + `message` updates funcionan con el cliente `fetch` crudo del proyecto sin framework** — knowledge general de Bot API marcado ASSUMPTION en research; validar con un smoke test antes de escribir el handler.
2. **Un solo comando cubre "reporte + notificaciones de pendientes"**: hoy `sendReport()` entrega ambos en una misma corrida, así que el `/report` único *es* la idea original del user; si al vivirlo se necesita `/pendientes` aparte, es follow-up, no alcance.
3. **"Cualquier miembro del grupo" puede dispararlo, consistente con D3** (cualquier miembro puede responder categorización). Si el usuario quiere restringir, es decisión nueva, no defecto.
4. **Uso ocasional, no varias veces por día**: el cooldown corto (orden 10–30 min) alcanza; si el patrón real es uso intensivo, la duración y el "todo al día" se reconsideran.
5. **La línea de sync-de-stale ya existe en `buildSummaryText`** ("omitido — hace X min, umbral 60") y basta para M4; no requiere UI distinto.
