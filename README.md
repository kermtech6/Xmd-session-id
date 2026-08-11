# KERM Session - Serveur indépendant

Génère une session WhatsApp (QR ou code d’appairage) via Baileys.

## Architecture Vercel + Railway (recommandé pour une URL Vercel)

**Baileys ne peut pas tourner dans une fonction Vercel** (pas de WebSocket persistant).  
Solution : le **site** sur Vercel, le **moteur WhatsApp** sur Railway. Vercel reverse-proxy `/api/*` et `/qr` vers Railway.

```
Navigateur → https://ton-projet.vercel.app (UI)
           → /api/* et /qr  proxyés vers  Railway (Baileys)
```

### 1. Railway (déjà fait)

Service `Xmd-session-id` en ligne + **Generate Domain**.

### 2. Variable Vercel

Sur le projet Vercel → **Settings → Environment Variables** :

| Name | Value |
|------|--------|
| `SESSION_BACKEND_URL` | `https://TON-SERVICE.up.railway.app` (sans `/` final) |

### 3. Déployer sur Vercel

- Import du repo GitHub `kermtech6/Xmd-session-id`
- Framework preset : Other
- Deploy

L’URL Vercel affiche le même UI ; les appels API partent vers Railway via `api/railway.js`.

## Local / Railway seul

```bash
npm install
npm start
```

→ http://localhost:3999  
Sur Railway : Generate Domain, pas besoin de `SESSION_BACKEND_URL`.

## Ne pas attendre un Baileys 100 % Vercel

Impossible de façon fiable : connexion WhatsApp = process long + WebSocket.  
Sans Railway (ou équivalent), le front Vercel renverra 503 (`SESSION_BACKEND_URL` manquant) ou 502.

## Utilisation

1. Ouvrir l’URL Vercel (ou Railway)
2. QR ou code d’appairage
3. Coller la session dans le bot : `SESSION_ID` / `SESSION_GENEREE`

## Dépannage

| Symptôme | Fix |
|----------|-----|
| 503 SESSION_BACKEND_URL | Ajouter la variable sur Vercel + redeploy |
| 502 Backend injoignable | Vérifier domaine Railway + service Online |
| QR absent | Attendre / Réinitialiser ; logs Railway |
| Unexposed sur Railway | Settings → Networking → Generate Domain |
