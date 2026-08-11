# KERM Session - Serveur indépendant

Projet **séparé** du bot. Son propre port, son propre serveur, ses propres `node_modules`.

Génère une session WhatsApp (QR ou code d’appairage) via [Baileys](https://github.com/WhiskeySockets/Baileys).

## Important : ne pas déployer sur Vercel

Ce serveur **ne fonctionne pas sur Vercel**.

- Vercel = fonctions serverless (timeout court, pas de WebSocket persistant, pas de process long).
- Baileys = connexion WhatsApp ouverte pendant le scan QR / l’appairage.

Résultat typique sur Vercel : **500** / `FUNCTION_INVOCATION_FAILED`.

Utilisez **Render**, **Railway**, **Koyeb**, ou lancez en **local**.

## Installation locale

```bash
npm install
npm start
```

Ouvrir http://localhost:3999

## Déploiement Render (recommandé)

1. Aller sur [render.com](https://render.com) → New → Web Service
2. Connecter le repo [kermtech6/Xmd-session-id](https://github.com/kermtech6/Xmd-session-id)
3. Runtime : Node — Build : `npm install` — Start : `npm start`
4. Ou utiliser le fichier `render.yaml` (Blueprint)

L’URL publique (ex. `https://xmd-session-id.onrender.com`) remplace localhost.

## Utilisation

1. Ouvrir l’URL du serveur (local ou Render)
2. Se connecter via QR ou code d’appairage
3. La session est envoyée en PM + affichée sur le site
4. Copier la session dans le bot : `SESSION_ID` (`.env`) ou `SESSION_GENEREE` (`config.js`)

## Dépannage

- **Connection Failure** : supprimer le dossier `Sessions/` et réessayer. WhatsApp limite à ~4 appareils connectés.
- **Vercel 500** : déployer ailleurs (voir ci-dessus). Un redéploiement Vercel affichera une page d’explication au lieu du crash opaque.
- **PORT** : sur Render/Railway, `PORT` est fourni automatiquement (pris en charge par `server.js`).
