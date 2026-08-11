# KERM Session - Serveur indépendant

Projet **séparé** du bot. Son propre port, son propre serveur, ses propres `node_modules`.

## Installation

```bash
cd session
npm install
```

## Lancement

```bash
npm start
```

Ou depuis la racine du projet : `npm run session`

## Utilisation

1. Ouvrir http://localhost:3999
2. Se connecter via QR ou code d'appairage
3. La session est envoyée en PM + affichée sur le site
4. Copier la session et la mettre dans `config.js` du **bot** (variable `SESSION_GENEREE`) ou dans `.env` : `SESSION_ID=...`

Le seul lien avec le bot : la session générée doit être utilisée dans le bot.

## Dépannage

- **Connection Failure** : Supprimez le dossier `Sessions/` et réessayez. Vérifiez que vous n'avez pas trop d'appareils connectés (WhatsApp limite à 4).
- **Alternative si le serveur session échoue** : Mettez `SESSION_GENEREE = "LOCAL"` dans config.js, lancez le bot (`npm start`), ouvrez http://localhost:PORT/connect et scannez le QR. Une fois connecté, la session est dans `lib/Sessions/creds.json`. Encodez son contenu en base64 et mettez-le dans `SESSION_GENEREE`.
