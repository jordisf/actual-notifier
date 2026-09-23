#!/bin/sh
set -e

# Volcar el entorno del contenedor para que los jobs de cron dispongan de TZ, PATH, etc.
printenv > /etc/environment

# Instalar la planificacion desde el crontab montado (editable sin reconstruir la imagen).
if [ -f /app/crontab.txt ]; then
  crontab /app/crontab.txt
fi

# Vigilar crontab.txt (editado por el panel web) y reinstalar la planificacion
# cuando cambie, sin reiniciar el contenedor (specs/001-config-webapp FR-014).
# Corre en segundo plano para que `cron -f` siga siendo el proceso principal (PID 1).
(
  last_mtime=""
  if [ -f /app/crontab.txt ]; then
    last_mtime=$(stat -c %Y /app/crontab.txt 2>/dev/null || echo "")
  fi
  while true; do
    sleep 10
    if [ -f /app/crontab.txt ]; then
      mtime=$(stat -c %Y /app/crontab.txt 2>/dev/null || echo "")
      if [ -n "$mtime" ] && [ "$mtime" != "$last_mtime" ]; then
        crontab /app/crontab.txt
        echo "entrypoint: crontab.txt changed, schedule reinstalled"
        last_mtime="$mtime"
      fi
    fi
  done
) &

exec cron -f
