/**
 * Serveur de session WhatsApp — indépendant du bot
 * Compatible Railway / Render / Koyeb (PORT dynamique + healthcheck).
 */
const fs = require("fs");
const path = require("path");
const express = require("express");
const baileys = require("@whiskeysockets/baileys");
const {
  useMultiFileAuthState,
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion
} = baileys;
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode");
const pino = require("pino");

const SESSION_DIR = path.join(__dirname, "Sessions");
// Railway injecte PORT — ne jamais hardcoder en cloud
const PORT = Number(process.env.PORT || process.env.SESSION_PORT || 3999);
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL ||
    `http://localhost:${PORT}`;

if (process.env.VERCEL) {
  console.error(
    "[FATAL] Baileys ne tourne pas sur Vercel. Utilisez Railway / Render / Koyeb."
  );
  process.exit(1);
}

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

// Autorise le front Vercel (et autres) à appeler Railway en direct si besoin
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allow = process.env.CORS_ORIGIN || "*";
  if (allow === "*" || (origin && allow.split(",").map((s) => s.trim()).includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", allow === "*" ? "*" : origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

let sock = null;
let pairingPhone = null;
let globalQr = null;
let globalSession = null;
let starting = false;
let restartTimer = null;
let httpReady = false;

async function resolveWaVersion() {
  try {
    if (typeof fetchLatestWaWebVersion === "function") {
      const live = await fetchLatestWaWebVersion({});
      if (live?.version) {
        console.log(
          "WA Web version:",
          live.version.join("."),
          live.isLatest === false ? "(parsed)" : ""
        );
        return live.version;
      }
    }
  } catch (e) {
    console.warn("fetchLatestWaWebVersion échoué:", e.message);
  }
  try {
    const latest = await fetchLatestBaileysVersion();
    console.log(
      "WA Baileys version:",
      latest.version.join("."),
      latest.isLatest ? "(latest)" : "(fallback)"
    );
    return latest.version;
  } catch (e) {
    console.warn("fetchLatestBaileysVersion échoué:", e.message);
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

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    http: httpReady,
    whatsapp: !!sock?.user,
    qr: !!globalQr
  });
});

// Page d'accueil — choix QR ou code d'appairage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Page QR dédiée (le fichier s'appelle qr.html, la route reste /scan
// car /qr sert déjà l'image du QR code plus bas)
app.get("/scan", (req, res) => {
  res.sendFile(path.join(__dirname, "qr.html"));
});

// Page code d'appairage dédiée
app.get("/pair", (req, res) => {
  res.sendFile(path.join(__dirname, "pair.html"));
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
        console.log("QR prêt — ouvrez", PUBLIC_URL);
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
          console.log("Credentials invalides (code", statusCode, "). Reset...");
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
            sessionB64 = Buffer.from(fs.readFileSync(credsPath, "utf8"), "utf8").toString(
              "base64"
            );
          } else if (sock.authState?.creds) {
            sessionB64 = Buffer.from(JSON.stringify(sock.authState.creds), "utf8").toString(
              "base64"
            );
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

const server = app.listen(PORT, "0.0.0.0", () => {
  httpReady = true;
  console.log(`\nSession Serveur prêt sur 0.0.0.0:${PORT}`);
  console.log(`URL publique: ${PUBLIC_URL}`);
  console.log("Healthcheck: GET /health\n");
  startSession().catch(console.error);
});

server.on("error", (err) => {
  console.error("[FATAL] Impossible d'écouter sur le port", PORT, err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM reçu — arrêt propre");
  stopSocket();
  server.close(() => process.exit(0));
});
