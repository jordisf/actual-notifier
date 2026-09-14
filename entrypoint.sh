#!/bin/sh
set -e

# Volcar el entorno del contenedor para que los jobs de cron dispongan de TZ, PATH, etc.
printenv > /etc/environment

# Instalar la planificacion desde el crontab montado (editable sin reconstruir la imagen).
if [ -f /app/crontab.txt ]; then
  crontab /app/crontab.txt
fi

exec cron -f
