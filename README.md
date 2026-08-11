# KERM Session - Serveur indépendant

Génère une session WhatsApp (QR ou code d’appairage) via Baileys.

## Déploiement Railway (recommandé)

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub  
2. Repo : [kermtech6/Xmd-session-id](https://github.com/kermtech6/Xmd-session-id)  
3. Settings → Networking → **Generate Domain**  
4. Ouvrir l’URL → QR / code d’appairage  

Déjà configuré (`railway.json` + `nixpacks.toml`) :
- Builder **NIXPACKS** (pas le Dockerfile par défaut)
- Start : `npm start`
- Healthcheck : `GET /health` (OK avant connexion WhatsApp)
- Bind `0.0.0.0` + `process.env.PORT`

Aucune variable obligatoire. Optionnel : `NODE_ENV=production`.

## Local

```bash
npm install
npm start
```

→ http://localhost:3999

## Docker Compose (local)

```bash
docker compose up --build
```

Le service écoute le `PORT` du conteneur (défaut 8080 mappé).

## Ne pas utiliser Vercel

Baileys = WebSocket persistant. Vercel = serverless → 500 / `FUNCTION_INVOCATION_FAILED`.

## Utilisation

1. Ouvrir l’URL (Railway ou local)
2. QR ou code d’appairage
3. Coller la session dans le bot : `SESSION_ID` ou `SESSION_GENEREE`

## Dépannage Railway

| Symptôme | Cause | Fix |
|----------|--------|-----|
| Crashed / healthcheck fail | Mauvais PORT / pas d’écoute | Déjà corrigé |
| Build OK, 502 | Pas de domaine public | Generate Domain |
| QR absent | Baileys encore en connexion | Attendre / Réinitialiser |
| Connection Failure | Trop d’appareils / bad session | Reset ; max ~4 devices |
