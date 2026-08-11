/**
 * Serveur de session WhatsApp - 100% indépendant du bot
 * Génère une session via QR ou code d'appairage
 * Envoie la session en PM + affiche sur le site
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import qrcode from "qrcode";
import pino from "pino";
import baileys from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

const {
  useMultiFileAuthState,
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion
} = baileys;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_DIR = path.join(__dirname, "Sessions");
const PORT = process.env.SESSION_PORT || 3999;

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

let sock = null;
let pairingPhone = null;
let globalQr = null;
let globalSession = null;
let starting = false;
let restartTimer = null;

async function resolveWaVersion() {
  try {
    if (typeof fetchLatestWaWebVersion === "function") {
      const live = await fetchLatestWaWebVersion({});
      if (live?.version) {
        console.log("WA Web version:", live.version.join("."), live.isLatest === false ? "(parsed)" : "");
        return live.version;
      }
    }
  } catch (e) {
    console.warn("fetchLatestWaWebVersion échoué:", e.message);
  }
  try {
    const latest = await fetchLatestBaileysVersion();
    console.log("WA Baileys version:", latest.version.join("."), latest.isLatest ? "(latest)" : "(fallback)");
    return latest.version;
  } catch (e) {
    console.warn("fetchLatestBaileysVersion échoué, défaut Baileys:", e.message);
    return undefined;
  }
}

function clearSessionFiles() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    for (const f of fs.readdirSync(SESSION_DIR)) {
      fs.unlinkSync(path.join(SESSION_DIR, f));
    }
  } catch (_) {}
}

function scheduleRestart(ms = 2500) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startSession().catch(console.error);
  }, ms);
}

function stopSocket() {
  try {
    sock?.ev?.removeAllListeners?.();
  } catch (_) {}
  try {
    sock?.end?.(undefined);
  } catch (_) {}
  try {
    sock?.ws?.close?.();
  } catch (_) {}
  sock = null;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/qr", async (req, res) => {
  try {
    if (!globalQr) {
      return res.status(404).json({ error: "QR non disponible" });
    }
    const buf = await qrcode.toBuffer(globalQr, { type: "png", margin: 1, width: 256 });
    res.type("png").end(buf);
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get("/api/status", (req, res) => {
  res.json({
    connected: !!sock?.user,
    qr: !!globalQr,
    pairingPhone,
    session: globalSession
  });
});

app.post("/api/pairing-code", async (req, res) => {
  try {
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    if (!phone || phone.length < 10) {
      return res.json({ error: "Numéro invalide (ex: 237651234567)" });
    }
    if (!sock) {
      return res.json({ error: "Connexion non prête, réessayez dans quelques secondes" });
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (typeof sock.requestPairingCode !== "function") {
      return res.json({ error: "Connexion non prête" });
    }
    pairingPhone = phone + "@s.whatsapp.net";
    const code = await sock.requestPairingCode(phone);
    const formatted = String(code).match(/.{1,4}/g)?.join("-") || code;
    return res.json({ success: true, code: formatted });
  } catch (e) {
    return res.json({ error: String(e.message || e) });
  }
});

app.post("/api/reset", async (req, res) => {
  try {
    stopSocket();
    clearSessionFiles();
    globalQr = null;
    globalSession = null;
    pairingPhone = null;
    scheduleRestart(1000);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

async function startSession() {
  if (starting) return;
  starting = true;

  try {
    stopSocket();
    globalQr = null;

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const version = await resolveWaVersion();
    const logger = pino({ level: "silent" });

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS("Chrome"),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 20_000,
      qrTimeout: 180_000,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, qr: qrData, lastDisconnect } = update;

      if (qrData) {
        globalQr = qrData;
        console.log("QR prêt — ouvrez http://localhost:" + PORT);
      }

      if (connection === "connecting") {
        console.log("Connexion WhatsApp...");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : lastDisconnect?.error?.output?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log("Connexion fermée, code:", statusCode);

        stopSocket();
        globalQr = null;

        if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          console.log("Restart requis. Reconnexion...");
          scheduleRestart(1500);
          return;
        }

        if (
          statusCode === DisconnectReason.badSession ||
          statusCode === DisconnectReason.connectionReplaced ||
          statusCode === DisconnectReason.forbidden ||
          statusCode === 401 ||
          statusCode === 403 ||
          statusCode === 405 ||
          statusCode === 500
        ) {
          console.log("Credentials invalides (code", statusCode, "). Suppression et nouveau QR...");
          clearSessionFiles();
          globalSession = null;
          scheduleRestart(2000);
          return;
        }

        if (loggedOut) {
          console.log("Déconnecté (logged out). Nouveau QR...");
          clearSessionFiles();
          globalSession = null;
          scheduleRestart(2000);
          return;
        }

        console.log("Reconnexion automatique...");
        scheduleRestart(3000);
        return;
      }

      if (connection === "open") {
        globalQr = null;
        console.log("Connecté :", sock.user?.id);

        const userJid = sock.user?.id;
        const targetJid = pairingPhone || userJid;
        if (!targetJid) return;

        try {
          await new Promise((r) => setTimeout(r, 2500));

          let sessionB64;
          const credsPath = path.join(SESSION_DIR, "creds.json");
          if (fs.existsSync(credsPath)) {
            sessionB64 = Buffer.from(fs.readFileSync(credsPath, "utf8"), "utf8").toString("base64");
          } else if (sock.authState?.creds) {
            sessionB64 = Buffer.from(JSON.stringify(sock.authState.creds), "utf8").toString("base64");
          } else {
            console.error("creds.json introuvable après connexion");
            return;
          }

          globalSession = sessionB64;
          const jid = targetJid.includes("@") ? targetJid : targetJid + "@s.whatsapp.net";

          await sock.sendMessage(jid, {
            text:
              "*Session KERM Bot*\n\n" +
              "Mettez la session (message suivant) dans `SESSION_GENEREE` (config.js) ou `SESSION_ID` (.env)."
          });
          await sock.sendMessage(jid, { text: sessionB64 });
          console.log("Session envoyée en PM à", jid);
          pairingPhone = null;
        } catch (e) {
          console.error("Erreur envoi session:", e);
        }
      }
    });
  } catch (e) {
    console.error("Erreur startSession:", e);
    scheduleRestart(5000);
  } finally {
    starting = false;
  }
}

startSession().catch(console.error);

app.listen(PORT, () => {
  console.log(`\nSession Serveur: http://localhost:${PORT}`);
  console.log("Connectez via QR ou code d'appairage, puis recevez la session en PM.\n");
});
