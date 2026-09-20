FROM node:20-slim

WORKDIR /work

# better-sqlite3 (dep nativa de @actual-app/api) necesita toolchain de compilacion.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY seed.js ./
