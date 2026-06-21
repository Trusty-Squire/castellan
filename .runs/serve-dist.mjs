// Minimal static server for the gypsy production build — correct ES-module MIME,
// no Host allowlist (so a cloudflared tunnel domain works), SPA fallback to index.html.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";

const ROOT = "/home/lunchbox/gypsy-build/dist";
const PORT = Number(process.env.PORT ?? 5181);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function tryFile(p) {
  try {
    const s = await stat(p);
    if (s.isFile()) return p;
  } catch {}
  return null;
}

createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
    let file = await tryFile(join(ROOT, safe));
    if (!file && safe.endsWith("/")) file = await tryFile(join(ROOT, safe, "index.html"));
    if (!file) file = await tryFile(join(ROOT, "index.html")); // SPA fallback
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    res.writeHead(500).end(String(e?.message ?? e));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
