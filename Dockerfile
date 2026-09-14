FROM node:20-slim

# 1. Instalar cron, tzdata y herramientas nativas de compilación (Python, gcc, g++, make)
RUN apt-get update && apt-get install -y --no-install-recommends \
    cron \
    tzdata \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Europe/Madrid

WORKDIR /app

# 2. Copiar descriptores e instalar dependencias compilando better-sqlite3 con éxito
COPY package*.json ./
RUN npm install --omit=dev

# 3. Copiar el codigo fuente, el crontab por defecto y el entrypoint.
#    crontab.txt y .env se pueden sobreescribir con volumenes para cambiarlos sin reconstruir la imagen.
COPY src/ ./src/
COPY crontab.txt ./crontab.txt
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

CMD ["/usr/local/bin/entrypoint.sh"]
