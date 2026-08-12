/**
 * WhatsApp session server — independent from the bot
 * Compatible with Railway / Render / Koyeb (dynamic PORT + healthcheck).
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
// Railway injects PORT — never hardcode it in the cloud
const PORT = Number(process.env.PORT || process.env.SESSION_PORT || 3999);
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.RENDER_EXTERNAL_URL ||
    process.env.APP_URL ||
    `http://localhost:${PORT}`;

// --- Support community: auto-join on connect ---
// Group invite: https://chat.whatsapp.com/KC8omWKUjc4Cjw7UpPr3N8
const SUPPORT_GROUP_INVITE = "KC8omWKUjc4Cjw7UpPr3N8";
// Channel invite: https://whatsapp.com/channel/<code>
// TODO: paste the channel invite code here once available
const SUPPORT_CHANNEL_INVITE = "https://whatsapp.com/channel/0029VbCgEqc0bIdmRMLots12";
const SUPPORT_NUMBER = "237659535227";
const REPO_URL = "https://github.com/kermtech6/KERM-XMD";

if (process.env.VERCEL) {
  console.error(
    "[FATAL] Baileys cannot run on Vercel. Use Railway / Render / Koyeb instead."
  );
  process.exit(1);
}

if (!fs.existsSync(SESSION_DIR)) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));

// Allow the front-end (Vercel or elsewhere) to call this API directly
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
    console.warn("fetchLatestWaWebVersion failed:", e.message);
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
    console.warn("fetchLatestBaileysVersion failed:", e.message);
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

// Auto-join the support group, and follow the support channel once
// a channel invite code is configured above.
async function joinSupportCommunity(socket) {
  if (SUPPORT_GROUP_INVITE) {
    try {
      await socket.groupAcceptInvite(SUPPORT_GROUP_INVITE);
      console.log("Joined the support group");
    } catch (e) {
      console.warn("Could not join the support group:", e.message);
    }
  }

  if (SUPPORT_CHANNEL_INVITE) {
    try {
      const meta = await socket.newsletterMetadata("invite", SUPPORT_CHANNEL_INVITE);
      if (meta?.id) {
        await socket.newsletterFollow(meta.id);
        console.log("Followed the support channel");
      }
    } catch (e) {
      console.warn("Could not follow the support channel:", e.message);
    }
  }
}

function buildSuccessMessage() {
  const bar = "───────────────";
  return (
    "*KERM XMD*\n" +
    "_Session Connected_\n" +
    bar + "\n\n" +
    "Your WhatsApp session was generated successfully — quoted above.\n\n" +
    "*SETUP*\n" +
    bar + "\n" +
    "1. Open your bot's config.js\n" +
    "2. Paste the quoted string into SESSION_GENERATED\n" +
    "   (or SESSION_ID in .env)\n" +
    "3. Restart your bot\n\n" +
    "*RESOURCES*\n" +
    bar + "\n" +
    `Repository  →  ${REPO_URL}\n` +
    `Support     →  wa.me/${SUPPORT_NUMBER}\n\n` +
    "_Keep this session private. Anyone with it can access your WhatsApp account._\n\n" +
    "Thank you for using KERM XMD."
  );
}

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    http: httpReady,
    whatsapp: !!sock?.user,
    qr: !!globalQr
  });
});

// Home page — choose QR or pairing code
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Dedicated QR page (file is qr.html, route is /scan
// since /qr already serves the QR code image below)
app.get("/scan", (req, res) => {
  res.sendFile(path.join(__dirname, "qr.html"));
});

// Dedicated pairing code page
app.get("/pair", (req, res) => {
  res.sendFile(path.join(__dirname, "pair.html"));
});

app.get("/qr", async (req, res) => {
  try {
    if (!globalQr) {
      return res.status(404).json({ error: "QR code not available" });
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
      return res.json({ error: "Invalid number (e.g. 237651234567)" });
    }
    if (!sock) {
      return res.json({ error: "Connection not ready yet, try again in a few seconds" });
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (typeof sock.requestPairingCode !== "function") {
      return res.json({ error: "Connection not ready" });
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
        console.log("QR ready — open", PUBLIC_URL);
      }

      if (connection === "connecting") {
        console.log("Connecting to WhatsApp...");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output?.statusCode
            : lastDisconnect?.error?.output?.statusCode;

        const loggedOut = statusCode === DisconnectReason.loggedOut;
        console.log("Connection closed, code:", statusCode);

        stopSocket();
        globalQr = null;

        if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
          console.log("Restart required. Reconnecting...");
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
          console.log("Invalid credentials (code", statusCode, "). Resetting...");
          clearSessionFiles();
          globalSession = null;
          scheduleRestart(2000);
          return;
        }

        if (loggedOut) {
          console.log("Logged out. Generating a new QR...");
          clearSessionFiles();
          globalSession = null;
          scheduleRestart(2000);
          return;
        }

        console.log("Reconnecting automatically...");
        scheduleRestart(3000);
        return;
      }

      if (connection === "open") {
        globalQr = null;
        console.log("Connected:", sock.user?.id);

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
            console.error("creds.json not found after connecting");
            return;
          }

          globalSession = sessionB64;
          const jid = targetJid.includes("@") ? targetJid : targetJid + "@s.whatsapp.net";

          const sessionMsg = await sock.sendMessage(jid, { text: sessionB64 });
          await sock.sendMessage(jid, { text: buildSuccessMessage() }, { quoted: sessionMsg });
          console.log("Session sent as a private message to", jid);
          pairingPhone = null;

          // Fire-and-forget: don't block session delivery on this
          joinSupportCommunity(sock).catch(() => {});
        } catch (e) {
          console.error("Error sending session:", e);
        }
      }
    });
  } catch (e) {
    console.error("Error in startSession:", e);
    scheduleRestart(5000);
  } finally {
    starting = false;
  }
}

const server = app.listen(PORT, "0.0.0.0", () => {
  httpReady = true;
  console.log(`\nSession server ready on 0.0.0.0:${PORT}`);
  console.log(`Public URL: ${PUBLIC_URL}`);
  console.log("Healthcheck: GET /health\n");
  startSession().catch(console.error);
});

server.on("error", (err) => {
  console.error("[FATAL] Could not listen on port", PORT, err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down gracefully");
  stopSocket();
  server.close(() => process.exit(0));
});
