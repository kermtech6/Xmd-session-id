# Optionnel — Railway utilise NIXPACKS (railway.json).
# Pour docker compose / build manuel.
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y --no-install-recommends git python3 make g++ ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY patch-baileys.js ./
RUN npm install --omit=dev

COPY . .

# Railway / Compose injectent PORT au runtime
EXPOSE 8080
CMD ["npm", "start"]
