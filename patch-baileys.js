/**
 * patch-baileys.js — Aligne la plateforme déclarée sur celle du serveur de session.
 *
 * Le générateur de session enregistre les identifiants avec Platform.MACOS.
 * Si le bot se connecte en Platform.WEB, WhatsApp rejette la session
 * (405 Connection Failure / boucle "Connection closed, reconnecting").
 *
 * Lancé automatiquement par le script "postinstall" du package.json.
 * Ne fait jamais échouer le build : toute erreur est seulement journalisée.
 */
const fs = require("fs");
const path = require("path");

function findBaileysLib() {
  // 1) Résolution normale du module
  try {
    const entry = require.resolve("@whiskeysockets/baileys");
    return path.dirname(entry);
  } catch {}

  // 2) Chemins classiques en secours (Heroku, installs imbriquées)
  const guesses = [
    path.join(__dirname, "node_modules", "@whiskeysockets", "baileys", "lib"),
    path.join("/app", "node_modules", "@whiskeysockets", "baileys", "lib"),
    path.join(process.cwd(), "node_modules", "@whiskeysockets", "baileys", "lib"),
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return null;
}

/** Parcourt un dossier et renvoie tous les .js / .cjs */
function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

const NEEDLE = /platform:\s*proto\.ClientPayload\.UserAgent\.Platform\.WEB/g;
const REPLACEMENT = "platform: proto.ClientPayload.UserAgent.Platform.MACOS";

try {
  const libDir = findBaileysLib();

  if (!libDir) {
    console.log("[patch] Baileys introuvable — patch ignoré.");
    process.exit(0);
  }

  let patched = 0;
  let already = 0;

  for (const file of walk(libDir)) {
    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    if (NEEDLE.test(content)) {
      NEEDLE.lastIndex = 0;
      try {
        fs.writeFileSync(file, content.replace(NEEDLE, REPLACEMENT));
        patched++;
        console.log("[patch] WEB -> MACOS :", path.relative(libDir, file));
      } catch (e) {
        console.log("[patch] Écriture impossible sur", file, "-", e.message);
      }
    } else if (content.includes("Platform.MACOS")) {
      already++;
    }
    NEEDLE.lastIndex = 0;
  }

  if (patched > 0) {
    console.log("[patch] Terminé —", patched, "fichier(s) modifié(s).");
  } else if (already > 0) {
    console.log("[patch] Déjà en MACOS, rien à faire.");
  } else {
    console.log("[patch] Aucune occurrence Platform.WEB trouvée.");
  }
} catch (e) {
  console.log("[patch] Erreur non bloquante :", e.message);
}

process.exit(0);
