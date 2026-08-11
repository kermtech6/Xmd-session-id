FROM node:18-slim

WORKDIR /app

# Installation de Git et des outils nécessaires
RUN apt-get update && \
    apt-get install -y \
    git \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copier package.json et le script patch
COPY package*.json ./
COPY patch-baileys.js ./

# Installer les dépendances
RUN npm install --omit=dev

# Copier le reste du code
COPY . .

EXPOSE 3000

CMD ["npm", "start"]
