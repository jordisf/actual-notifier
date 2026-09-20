# Feature: Entorno de desarrollo con Actual Budget + datos de prueba

**Fecha:** 2026-09-20 · **Ruta:** delegated direct (writer único) · **TDD:** off (proyecto sin test runner; checks = Node syntax check + docker compose config)

## Objetivo
Poder levantar en Docker una instancia de Actual Budget con datos de inicio conocidos y determinísticos, para testear `actual-notifier` en desarrollo. Sin sincronización bancaria real: la llegada de operaciones nuevas se emula mediante seed de transacciones.

## Problema / Por qué
El script se testa solo contra la instancia real de producción. No hay forma de reproducir casos (sin categorizar, sobregasto, transferencia, splits) bajo demanda ni de reiniciar el estado.

## Alcance (authorized scope)
- `actual-budget/docker-compose.yml` — fijar versión de imagen Actual.
- `actual-budget/seed-data/seed.js` — script Node que crea `dev-budget` vía `api.runImport` y siembra cuentas, categorías, presupuestos del mes en curso y transacciones (incl. splits para validar `is_parent`/`transfer_id`). Sin SMTP: solo imprime `ACTUAL_SYNC_ID` y `ACTUAL_PASSWORD`.
- `actual-budget/seed-data/package.json` + `seed-data/README.md` — deps mínimas, instrucciones de uso (seed, casos de uso, reset).
- `.env.dev` — configuración dev completa del notifier (Actual, Mailpit, destinatarios).
- `.env.dev-mailpit` — configuración de Mailpit.
- `dev.yml` — compose overlay opcional (Mailpit) para capturar los emails del correo.
- `README.md` — sección breve "Entorno de desarrollo" (actualizar existente, no sustituir).
- `.gitignore` — ignorar `.actual-data/` (datos del seed) y `*.zip` de backup.

**Fuera de alcance:** tocar `src/reporte-diario.js`, el compose de producción, o añadir tests unitarios al proyecto.

## Casos de uso objetivo (datos sembrados)
1. Cuentas: `Cuenta Corriente` (on-budget, 14.500), `Cuenta Nómina` (on-budget, 0), `Tarjeta Crédito` (on-budget, 0), `Caja` (off-budget).
2. Categorías (mes en curso): las 5 de `CATEGORIAS_OBJETIVO` (con acento correcto: `Supermercado y Alimentación`) más `Renta`, `Internet y Teléfono`, `Suscripciones`.
3. Mes actual: nómina +3.200 (sin cat), gastos en las 5 categorías objetivo, `Suscripciones` en sobregasto (-42,50), `Internet y Teléfono` con saldo exactamente 0, 1 gasto sin categorizar (Mercadona), 1 transferencia entre cuentas, 1 split de farmacia (10,51, sin cat).
4. Mes anterior con 200€ en `Gasto Personal` para que `carryover` (true en las 5 objetivo) sea observable.

## Decisiones
- **`runImport` para crear el presupuesto**: es la única vía pública de `@actual-app/api` (no existe `createBudget` público). Elimina las categorías de gasto por defecto del presupuesto recién creado → schema limpio y determinístico.
- **Splits vía `addTransactions` + `updateTransaction`**: `addTransactions` acepta `payee_name` (autocrea payee) y `category` por id, pero no `transfer_id`; se crea la fila padre (is_parent, category) y la hija se liga con `transfer_id`.
- **Cuentas off-budget**: `addTransactions` sobre off-budget no crea splits (según docs de la API); por eso la transferencia se hace entre cuentas on-budget (`Cuenta Corriente` → `Tarjeta Crédito`) y `Caja` solo cubre el caso *excluida del paso 2* del script.
- **Mailpit como SMTP dev** (`dev.yml`, overlay): el notifier envía de verdad; el correo se lee en http://localhost:8025 y se resetea con volumen efímero.
- **Backup exportable**: el seed exporta `dev-budget.zip` a `.actual-data/` como snapshot de estado conocido (ignorado por git).

## Evidencia por tarea
| Tarea | Estado | Evidencia |
|-------|--------|-----------|
| T1: Seeded actual-budget service image + compose fix | ✅ | Actual 26.8.0 con healthcheck y proyecto Compose unificado. |
| T2: seed script + seed env + dev env | ✅ | Presupuesto `dev-budget` determinista; imprime `groupId` compatible con `downloadBudget`. |
| T3: Mailpit overlay | ✅ | SMTP sin TLS autenticado para desarrollo, UI en `http://localhost:8025`. |
| T4: README + .gitignore | ✅ | Flujo bootstrap → seed → notifier documentado. |
| T5: node --syntax-check seed.js; docker compose config (prod + dev) | ✅ | `docker compose config --quiet` pasó para el compose combinado. |
| T6: e2e opcional (si Docker Desktop está iniciado): seed → sync id → notifier run → mail en Mailpit | ✅ | 2026-09-20: email recibido; 2 sin categorizar y Suscripciones -7,50 €. |

## Notas de riesgo
- `ACTUAL_SYNC_ID` debe ser el `groupId`, no el `cloudFileId`: `downloadBudget` resuelve el presupuesto remoto por grupo.
- `addTransactions()` devuelve `"ok"` en la API instalada; el seeder consulta el ID de la transacción recién creada antes de actualizar transferencias o el padre de un split.
