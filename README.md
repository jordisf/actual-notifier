# actual-notifier

Script en **Node.js**, empaquetado en **Docker**, que se ejecuta de forma programada (cron) para generar un **reporte diario por email** del estado de gasto operativo de un presupuesto de [Actual Budget](https://actualbudget.org/) self-hosted.

En cada ejecución:

1. Se conecta a Actual Budget vía su API oficial (`@actual-app/api`).
2. Lanza la sincronización bancaria (PSD2 / ING), con *throttle* de 60 minutos.
3. Detecta movimientos del mes sin categorizar.
4. Calcula la disponibilidad de las categorías objetivo y detecta sobregastos.
5. Envía un reporte HTML por **SMTP** a los destinatarios configurados.

Además, el bot de Telegram responde al comando de grupo **`/report`** (visible en el menú de comandos del cliente): regenera y entrega ese mismo reporte bajo demanda, en cualquier momento. Sin nueva superficie de configuración.

---

## Requisitos

- **Docker** y **Docker Compose** (despliegue recomendado).
- Para desarrollo local: **Node.js 20** y **npm**.
- Herramientas de compilación nativas (`python3`, `make`, `g++`) para `better-sqlite3`, dependencia nativa de la API de Actual. La imagen Docker ya las incluye.
- Una instancia accesible de **Actual Budget** y una cuenta **SMTP**.

---

## Configuración

La configuración se realiza mediante variables de entorno. Copia la plantilla y rellena tus valores:

```bash
cp .env.example .env
```

| Variable | Descripción |
|---|---|
| `ACTUAL_SERVER_URL` | URL del servidor Actual Budget (p. ej. `http://actual-budget:5006`). |
| `ACTUAL_PASSWORD` | Contraseña del servidor Actual. |
| `ACTUAL_SYNC_ID` | ID del presupuesto (Sync ID) a descargar. |
| `SMTP_HOST` | Host del servidor SMTP. |
| `SMTP_PORT` | Puerto SMTP (por defecto `465`). |
| `SMTP_SECURE` | `true`/`false` para TLS implícito. Si se omite, se deduce del puerto (`465` → `true`). |
| `SMTP_USER` | Usuario SMTP. También se usa como remitente (`from`). |
| `SMTP_PASS` | Contraseña SMTP. |
| `NOTIFICATION_EMAIL` | Destinatarios del reporte, separados por comas. |

> ⚠️ **Seguridad:** el fichero `.env` contiene secretos y está incluido en `.gitignore`. Nunca lo subas al repositorio. Si alguna credencial se ha expuesto, rótala.

### Categorías monitorizadas

Las categorías objetivo están definidas en la constante `CATEGORIAS_OBJETIVO` dentro de [src/reporte-diario.js](src/reporte-diario.js). Por defecto:

`Gasto Personal`, `Farmacia y Botiquin`, `Supermercado y Alimentación`, `Ocio y Restaurantes`, `Transporte`.

Ajústalas editando esa lista (los nombres deben coincidir con los de Actual Budget).

---

## Despliegue con Docker (recomendado)

El contenedor arranca `cron` e instala la planificación definida en [crontab.txt](crontab.txt). Por defecto, el reporte se ejecuta **todos los días a las 20:00** (`Europe/Madrid`).

1. Asegúrate de que existe la red externa compartida con Actual Budget:

   ```bash
   docker network create actual_net
   ```

2. Configura tu `.env` (ver sección anterior).

3. Construye y arranca el servicio:

   ```bash
   docker compose up -d --build
   ```

Los volúmenes montan `src/`, `crontab.txt` y `.env` en modo solo lectura, por lo que puedes cambiar el código, la planificación o las credenciales **sin reconstruir la imagen** (basta con reiniciar el contenedor). Las actualizaciones posteriores (git pull → up) y el checklist de producción están en [DEPLOY.md](DEPLOY.md).

### Cambiar la planificación

Edita [crontab.txt](crontab.txt) (sintaxis cron estándar) y reinicia el contenedor:

```bash
docker compose restart
```

### Ver logs

```bash
docker compose logs -f            # salida del contenedor / cron
docker compose exec actual_notifier cat /var/log/cron.log   # log del job
```

### Ejecución manual (una sola vez)

```bash
docker compose exec actual_notifier node src/reporte-diario.js
```

---

## Panel de configuración web (`config-panel`)

Un panel web autogestionado (sin dependencias nuevas) permite gestionar **toda la configuración desde el navegador**, sin SSH ni reinicio de contenedores:

| Sección | Qué configura |
|---|---|
| **Telegram** | Token del bot, grupo, categorías, timeout de long-poll. Si guardas un token en blanco, se conserva el actual. |
| **SMTP** | Host, puerto, TLS, credenciales + botón de *test mail* antes de guardar. |
| **Actual Budget** | URL, sync ID y contraseña + prueba de handshake real antes de guardar. |
| **Destinatarios** | Lista de emails del reporte (se normaliza y dedupla). |
| **Planificación** | Los tres modos de cron (`cada N minutos` / `cada N horas` / `diario a HH:MM`) con vista solo-lectura de la línea resultante. |

### Acceso

- **Dirección:** `http://<host>:8080` (por defecto `http://127.0.0.1:8080`).
- **Exposición LAN/VPN:** el puerto se publica en `${PANEL_BIND_HOST:-127.0.0.1}`. La **restricción a LAN/VPN es responsabilidad del operador**: mantén el valor por defecto (solo localhost, acceso vía túnel/SSH) o, si lo abres a tu red, asegúrate de que `config-panel` **solo sea alcanzable desde LAN o VPN** — nunca desde internet. En la red pública no debe existir.

```bash
# Ejemplo: habilitar acceso desde la LAN (solo si tu red es de confianza)
PANEL_BIND_HOST=0.0.0.0 docker compose up -d config-panel
```

### Primer arranque (bootstrap de contraseña)

La primera vez no existe contraseña: el login entra sin credenciales y **fuerza** la creación de una en `/set-password` (usuario por defecto `admin`, cambiante). Solo se puede hacer **una** vez; si más tarde necesitas reiniciarla, elimina la clave en `data/notifier.db` (tabla `kv`, `panel_password_hash`).

### Aplicación sin reinicios

- **Cron / planificación:** `entrypoint.sh` vigila el mtime de `crontab.txt` y re-vuelca la crontab (~10 s) — sin reiniciar `notifier-cron`.
- **Listener de Telegram:** `src/listener.js` recarga a cada poll los 4 valores Telegram de `.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `TELEGRAM_CATEGORIES`, `TELEGRAM_POLL_TIMEOUT`) — sin reiniciar `notifier-listener`.
- **Cron y reporte:** leen `.env` en cada ejecución, por lo que los cambios de SMTP/Actual/destinatarios valen desde el próximo run.

> ⚠️ Cambiar **el token por un bot distinto** (rotación) sigue requiriendo el reseteo de `poll_offset` documentado en [DEPLOY.md](DEPLOY.md).

### Logs del panel

```bash
docker logs actual_notifier_panel --tail 50
```

---

## Desarrollo local

1. Instala las dependencias:

   ```bash
   npm install
   ```

2. Crea tu `.env` a partir de `.env.example`.

3. Ejecuta el script directamente:

   ```bash
   npm start
   ```

El script crea una caché local en `/tmp/actual-cache`. `dotenv` se carga con `override: true`, de modo que los cambios en `.env` se aplican en cada ejecución.

---

## Entorno de desarrollo (Actual Budget con datos conocidos)

Para testear el script sin tocar la instancia real ni depender de la sincronización bancaria, existe un entorno de desarrollo completamente local: una instancia de **Actual Budget en Docker** sembrada con datos de inicio **determinísticos y documentados**, más un **Mailpit** que captura los correos en su lugar de un SMTP real. La llegada de operaciones nuevas se **emula** simplemente re-sembrando o añadiendo transacciones a la instancia de desarrollo.

### Componentes

| Fichero | Rol |
|---|---|
| `actual-budget/docker-compose.yml` | Servicio `actual-server` (imagen fijada a `26.8.0`) y herramientas one-shot `bootstrap`/`seed` sobre la red compartida `actual_net`. |
| `actual-budget/seed-data/` | Seeder Node.js (`seed.js` + `Dockerfile`): crea el presupuesto `dev-budget` con cuentas, categorías, presupuestos mensuales y transacciones conocidas. |
| `dev.yml` | Overlay Compose: añade **Mailpit** (UI en `:8025`, SMTP en `:1025`) y el contenedor `actual_notifier_dev` apuntando a la instancia de desarrollo. |
| `.env.dev` | Configuración de desarrollo del notifier (copia a `.env` después de sembrar). |

### Arranque

```bash
# 1. Red compartida (una sola vez)
docker network create actual_net

# 2. Actual Budget en desarrollo (espera hasta que esté saludable)
docker compose -f actual-budget/docker-compose.yml up -d --wait actual-server

# 3. Inicializar la contraseña y sembrar los datos (one-shot; imprime ACTUAL_SYNC_ID)
docker compose -f actual-budget/docker-compose.yml --profile tools run --rm bootstrap
docker compose -f actual-budget/docker-compose.yml --profile tools run --rm seed

# 4. Configurar el notifier
cp .env.dev .env   # y pegar el ACTUAL_SYNC_ID (groupId) impreso por el seed

# 5. Arrancar Mailpit + notifier de desarrollo
docker compose -f actual-budget/docker-compose.yml -f dev.yml up -d

# 6. Ejecutar el reporte a demanda (no esperar al cron)
docker compose -f actual-budget/docker-compose.yml -f dev.yml exec actual_notifier_dev node src/reporte-diario.js
```

### Datos sembrados (estado esperado documentado)

El seeder documenta en su cabecera (`actual-budget/seed-data/seed.js`) el estado exacto que produce el reporte:

- **Categorías objetivo** (mes en curso, con *carryover*):
   `Gasto Personal` +5,00 €, `Farmacia y Botiquin` +17,30 €, `Supermercado y Alimentación` +48,90 €, `Ocio y Restaurantes` -9,00 €, `Transporte` 0,00 €.
- **Sobregasto no monitorizado:** `Suscripciones` en **-7,50 €** (dispara la alerta de saldo negativo).
- **Saldo a cero no monitorizado:** `Internet y Teléfono` en 0,00 € (sin alerta, sin ritmo).
- **Sin categorizar ( exactamente 2):** nómina entrante en `Cuenta Nómina` (+195,00 €) y un gasto sin categoría en `Cuenta Corriente` (-15,00 €).
- **Casos de exclusión** (no deben aparecer): transferencia interna alquiler (par con `transfer_id`), split de farmacia (padre sin categoría con `is_parent` + dos hijos con categoría), y gasto en `Caja` (cuenta *off-budget*).

Para **reiniciar** el estado de desarrollo: baja el stack y elimina `actual-budget/.actual-data/`; luego repite los pasos 2 a 5. Un snapshot exportable (`dev-budget-snapshot.zip`) se genera en `actual-budget/.actual-data/`.

> La instancia de desarrollo no tiene cuentas bancarias conectadas. El script sigue ejecutando su intento de sincronización, que puede informar éxito sin descargar operaciones. Los movimientos de prueba se emulan reiniciando y re-sembrando el entorno.

---

## Estructura del proyecto

```
actual-notifier/
├── .env.example         # Plantilla de configuración
├── crontab.txt          # Planificación cron (20:00 diario)
├── docker-compose.yml   # Servicio, volúmenes y red
├── Dockerfile           # Imagen basada en node:20-slim
├── Dockerfile.panel     # Imagen del panel de configuración (multi-stage)
├── entrypoint.sh        # Vuelca entorno, instala crontab, vigila crontab, arranca cron
├── package.json
└── src/
    ├── listener.js      # Listener long-poll de Telegram (recarga .env en cada poll)
    └── panel/           # Panel web de configuración (auth, rutas, vistas)
```

---

## Solución de problemas

- **No llega el correo:** revisa `SMTP_*` y `NOTIFICATION_EMAIL`, y consulta `/var/log/cron.log` dentro del contenedor.
- **Falla la sincronización bancaria:** el reporte se envía igualmente con un aviso; el error se registra. La sincronización se omite si la última fue hace menos de 60 minutos.
- **Error de conexión con Actual:** verifica `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD` y `ACTUAL_SYNC_ID`, y que el contenedor comparte la red `actual_net`.
- **Fallo al compilar `better-sqlite3` en local:** instala las herramientas de compilación nativas (`python3`, `make`, `g++`).
