/**
 * Patch Baileys: Platform.WEB -> Platform.MACOS (fix 405 Connection Failure)
 * WhatsApp rejette WEB pour les nouveaux appairages depuis fév. 2026.
 * PR: https://github.com/WhiskeySockets/Baileys/pull/2365
 */
const fs = require("fs");
const path = require("path");

const candidates = [
  path.join(__dirname, "node_modules", "@whiskeysockets", "baileys", "lib", "Utils", "validate-connection.js"),
  path.join(__dirname, "node_modules", "@whiskeysockets", "baileys", "lib", "Utils", "validate-connection.cjs"),
  path.join(__dirname, "node_modules", "@whiskeysockets", "baileys", "WAProto", "index.js")
];

let patched = 0;
for (const target of candidates) {
  if (!fs.existsSync(target)) continue;
  let content = fs.readFileSync(target, "utf8");
  if (!content.includes("platform: proto.ClientPayload.UserAgent.Platform.WEB")) continue;
  content = content.replace(
    /platform:\s*proto\.ClientPayload\.UserAgent\.Platform\.WEB/g,
    "platform: proto.ClientPayload.UserAgent.Platform.MACOS"
  );
  fs.writeFileSync(target, content);
  patched++;
  console.log("[session] Patch Baileys 405 appliqué:", path.basename(path.dirname(target)) + "/" + path.basename(target));
}

if (!patched) {
  // Vérifie si déjà MACOS
  const main = candidates[0];
  if (fs.existsSync(main) && fs.readFileSync(main, "utf8").includes("Platform.MACOS")) {
    console.log("[session] Patch Baileys déjà présent (MACOS).");
  } else {
    console.log("[session] Aucun fichier Baileys à patcher (peut-être déjà corrigé en amont).");
  }
}
