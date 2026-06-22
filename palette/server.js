// SERVER SKELETON (palette) — a complete, working Express app for an auth-gated credential
// dashboard. It wires the storage module + the palette templates; you normally use it AS-IS.
//
// To use: copy this to app.js, ensure package.json has "express" (keep sqlite3 + bcrypt) and
// "scripts": { "start": "node app.js" }, then `npm install`. It listens on process.env.PORT
// (default 3000). It require()s ./storage — that module already exists.
//
// Routes (the contract): GET /theme.css, GET / (login), POST /login, GET /dashboard
// (session-gated), POST /logout, GET /api/keys (HTTP Basic Auth, JSON for agents).
const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const storage = require("./storage");

const app = express();
const PORT = process.env.PORT || 3000;

// Server-side sessions: cookie holds only an opaque token; email+password stay in memory.
// (get_user_keys(email, password) needs the password to decrypt, so the session retains it.)
const sessions = new Map();
function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
function tplPath(file) {
  // templates live in palette/components/ (vendored); fall back to the repo root if copied out.
  const a = path.join("palette", "components", file);
  return fs.existsSync(a) ? a : file;
}
function sendFileSafe(res, p, type) {
  try {
    res.type(type).send(fs.readFileSync(p, "utf8"));
  } catch {
    res.status(500).send("template missing");
  }
}

app.use(express.urlencoded({ extended: false }));

app.get("/theme.css", (_req, res) => {
  const p = fs.existsSync(path.join("palette", "theme.css")) ? path.join("palette", "theme.css") : "theme.css";
  sendFileSafe(res, p, "text/css");
});

app.get("/", (_req, res) => sendFileSafe(res, tplPath("login.html"), "html"));

app.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const keys = await storage.get_user_keys(email, password); // throws/empty on bad creds
    if (!keys) throw new Error("invalid");
    const token = crypto.randomBytes(18).toString("hex");
    sessions.set(token, { email, password });
    res.cookie ? res.cookie("sid", token, { httpOnly: true }) : res.setHeader("Set-Cookie", `sid=${token}; HttpOnly`);
    res.redirect("/dashboard");
  } catch {
    res.status(401).redirect("/");
  }
});

app.get("/dashboard", async (req, res) => {
  const sess = sessions.get(readCookie(req, "sid"));
  if (!sess) return res.redirect("/");
  let keys = {};
  try {
    keys = (await storage.get_user_keys(sess.email, sess.password)) || {};
  } catch {
    return res.redirect("/");
  }
  const rows = Object.entries(keys)
    .map(([provider, key]) => {
      const masked = String(key).slice(-4);
      return `<div class="row"><span class="provider">${provider}</span><span class="key">••••${masked}</span></div>`;
    })
    .join("");
  let html = fs.readFileSync(tplPath("dashboard.html"), "utf8");
  // Inject rows into the api-keys-list container (replace its inner content).
  html = html.replace(
    /(<div class="list" data-testid="api-keys-list">)[\s\S]*?(<\/div>\s*<\/main>)/,
    `$1${rows}$2`,
  );
  res.type("html").send(html);
});

app.post("/logout", (req, res) => {
  sessions.delete(readCookie(req, "sid"));
  res.setHeader("Set-Cookie", "sid=; Max-Age=0");
  res.redirect("/");
});

// Agent API: HTTP Basic Auth -> the decrypted keys as JSON.
app.get("/api/keys", async (req, res) => {
  const hdr = req.headers.authorization || "";
  if (!hdr.startsWith("Basic ")) return res.status(401).json({ error: "auth required" });
  const [email, password] = Buffer.from(hdr.slice(6), "base64").toString().split(":");
  try {
    const keys = await storage.get_user_keys(email, password);
    if (!keys) throw new Error("invalid");
    res.json(keys);
  } catch {
    res.status(401).json({ error: "invalid credentials" });
  }
});

if (require.main === module) app.listen(PORT, () => console.log(`listening on ${PORT}`));
module.exports = app;
