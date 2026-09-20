# actual-notifier

Script en **Node.js**, empaquetado en **Docker**, que se ejecuta de forma programada (cron) para generar un **reporte diario por email** del estado de gasto operativo de un presupuesto de [Actual Budget](https://actualbudget.org/) self-hosted.

En cada ejecución:

1. Se conecta a Actual Budget vía su API oficial (`@actual-app/api`).
2. Lanza la sincronización bancaria (PSD2 / ING), con *throttle* de 60 minutos.
3. Detecta movimientos del mes sin categorizar.
4. Calcula la disponibilidad de las categorías objetivo y detecta sobregastos.
5. Envía un reporte HTML por **SMTP** a los destinatarios configurados.

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

Los volúmenes montan `src/`, `crontab.txt` y `.env` en modo solo lectura, por lo que puedes cambiar el código, la planificación o las credenciales **sin reconstruir la imagen** (basta con reiniciar el contenedor).

### Cambiar la planificación

Edita [crontab.txt](crontab.txt) (sintaxis cron estándar) y reinicia el contenedor:

```bash
docker compose restart
```

### Ver logs

```bash
docker compose logs -f            # salida del contenedor / cron
docker compose exec actual-notifier cat /var/log/cron.log   # log del job
```

### Ejecución manual (una sola vez)

```bash
docker compose exec actual-notifier node src/reporte-diario.js
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

## Estructura del proyecto

```
actual-notifier/
├── .env.example         # Plantilla de configuración
├── crontab.txt          # Planificación cron (20:00 diario)
├── docker-compose.yml   # Servicio, volúmenes y red
├── Dockerfile           # Imagen basada en node:20-slim
├── entrypoint.sh        # Vuelca entorno, instala crontab y arranca cron
├── package.json
└── src/
    └── reporte-diario.js  # Lógica del reporte
```

---

## Solución de problemas

- **No llega el correo:** revisa `SMTP_*` y `NOTIFICATION_EMAIL`, y consulta `/var/log/cron.log` dentro del contenedor.
- **Falla la sincronización bancaria:** el reporte se envía igualmente con un aviso; el error se registra. La sincronización se omite si la última fue hace menos de 60 minutos.
- **Error de conexión con Actual:** verifica `ACTUAL_SERVER_URL`, `ACTUAL_PASSWORD` y `ACTUAL_SYNC_ID`, y que el contenedor comparte la red `actual_net`.
- **Fallo al compilar `better-sqlite3` en local:** instala las herramientas de compilación nativas (`python3`, `make`, `g++`).
