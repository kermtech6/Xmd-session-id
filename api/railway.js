/**
 * Proxy Vercel → backend Baileys (Railway).
 * Baileys ne peut pas tourner en serverless ; Vercel sert le front + reverse-proxy.
 */
const BACKEND = (process.env.SESSION_BACKEND_URL || "").replace(/\/$/, "");

function collectBody(req) {
  return new Promise((resolve, reject) => {
    if (req.method === "GET" || req.method === "HEAD") {
      resolve(undefined);
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  if (!BACKEND) {
    res.status(503).json({
      error:
        "SESSION_BACKEND_URL manquant. Sur Vercel → Settings → Environment Variables, ajoute l’URL Railway (ex: https://xxx.up.railway.app) sans slash final."
    });
    return;
  }

  const targetPath = typeof req.query.path === "string" ? req.query.path : "/";
  if (!targetPath.startsWith("/")) {
    res.status(400).json({ error: "path invalide" });
    return;
  }

  // Reconstruit la query (hors `path` du rewrite)
  const incoming = new URL(req.url, "http://localhost");
  const forwardQuery = new URLSearchParams(incoming.search);
  forwardQuery.delete("path");
  const qs = forwardQuery.toString();
  const url = BACKEND + targetPath + (qs ? `?${qs}` : "");

  try {
    const body = await collectBody(req);
    const headers = {
      Accept: req.headers.accept || "*/*",
      "User-Agent": req.headers["user-agent"] || "vercel-session-proxy"
    };
    if (req.headers["content-type"]) {
      headers["Content-Type"] = req.headers["content-type"];
    }

    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: body && body.length ? body : undefined,
      redirect: "manual"
    });

    const buf = Buffer.from(await upstream.arrayBuffer());
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "no-store");
    res.status(upstream.status).send(buf);
  } catch (e) {
    console.error("[proxy]", e);
    res.status(502).json({
      error: "Backend Railway injoignable",
      detail: String(e.message || e),
      backend: BACKEND
    });
  }
};
