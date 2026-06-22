/**
 * SERVER PLUMBING SCAFFOLD — the harness owns the boot/port/persistence FLOOR for an HTTP-server
 * node, the same way `bootstrapGreenfieldNodeGate` owns the npm floor.
 *
 * A cheap model asked to improvise a whole Express server from scratch reliably slips on the
 * PLUMBING, not the route LOGIC: it hardcodes a port the serve-gate can't reach (exit 3, no boot),
 * forgets `express.json()` (handlers 500), or reinvents a persistence layer. The route logic IS the
 * requirement; the boot/port/store is shared boilerplate every Node HTTP app repeats. So we seed a
 * generic, runnable plumbing skeleton — boot on `process.env.PORT`, JSON bodies, static, a JSON-file
 * store — with the routes STUBBED, and tell the node to fill ONLY the handlers. Composition over
 * improvisation: make the contract (how the server boots + persists) KNOWN so the cheap worker and
 * its gate don't guess. Nothing product-specific is seeded (no routes, no domain deps) — only the
 * floor. Greenfield-only: never clobbers a server file or package.json a node already wrote.
 *
 * Proven by hand on the URL-shortener build (qwen+deepseek filled handlers over this exact plumbing,
 * 13/13 functional checks, no knight); this lifts that hand-move into the funnel.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * The server entrypoint to seed, chosen from the node's blast_radius: the first concrete
 * (non-glob) JS path, preferring a conventional entrypoint name. Defaults to `server.js`.
 */
export function pickServerFile(blastRadius: string[]): string {
  const concrete = blastRadius.filter((g) => /\.(js|mjs|cjs)$/.test(g) && !/[*{}[\]]/.test(g));
  const known = concrete.find((f) => /(^|\/)(server|app|index|main)\.(js|mjs|cjs)$/.test(f));
  return known ?? concrete[0] ?? "server.js";
}

/** The CommonJS Express plumbing skeleton — boot, JSON, static, a JSON-file store, stubbed routes. */
export function serverSkeleton(): string {
  return `const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;        // PLUMBING — the harness sets PORT; never hardcode it

// ---- persistence: a tiny JSON-file store (PLUMBING — use it, or ignore it) ----
const DATA = path.join('data', 'store.json');
const load = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return {}; } };
const save = (d) => { fs.mkdirSync('data', { recursive: true }); fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); };
// Random short id/code — use THIS, not nanoid (nanoid v4+ is ESM-only and breaks require()).
const gen = (n = 7) => crypto.randomBytes(16).toString('base64url').slice(0, n);

app.use(express.json());                       // PLUMBING — JSON request bodies parse into req.body
app.use(express.static('public'));             // PLUMBING — serves ./public at GET / (if present)

// ============================================================================
// ADD YOUR ROUTE HANDLERS HERE. The plumbing above is done — write only the
// endpoints your brief requires (app.get / app.post / ...), using load()/save()
// to persist and gen() for ids/codes. Read request fields EXACTLY as the shared
// contract names them. Return a 4xx for bad input; never let a handler throw
// (that 500s). Keep any catch-all route LAST. Do NOT change the require lines,
// PORT, or app.listen, and do NOT create a second server file.
// Add deps with "npm install <pkg>" — but ONLY CommonJS (require-able) packages.
// ============================================================================

app.listen(PORT, () => console.log('listening on ' + PORT));  // PLUMBING — boots on the harness port
`;
}

/**
 * A CommonJS package.json carrying express + a `start` script that boots the seeded server. Merges
 * onto an existing manifest (keeps its scripts/deps; never downgrades type:module — if a manifest
 * already declares ESM we leave it, the seed only fills a greenfield gap). Deterministic, stable key
 * order so re-deriving is a no-op diff.
 */
export function serverPackageJson(serverFile: string, existing?: string): string {
  let base: Record<string, unknown> = { name: "app", private: true };
  if (existing) {
    try {
      base = { ...base, ...(JSON.parse(existing) as Record<string, unknown>) };
    } catch {
      /* malformed — overwrite with the clean seed */
    }
  }
  const scripts = { ...(base.scripts as Record<string, string> | undefined) };
  if (!scripts.start) scripts.start = `node ${serverFile}`;
  const dependencies = { ...(base.dependencies as Record<string, string> | undefined) };
  if (!dependencies.express) dependencies.express = "^4.19.2";
  return JSON.stringify({ ...base, scripts, dependencies }, null, 2) + "\n";
}

/** Brief addendum telling the node the plumbing is done and to fill only the handlers. */
export function serverSkeletonNote(serverFile: string): string {
  return (
    `\`${serverFile}\` ALREADY EXISTS with the server PLUMBING written for you: it boots on ` +
    `process.env.PORT (the harness sets it — NEVER hardcode a port), parses JSON bodies ` +
    `(express.json), serves ./public, and has a JSON-file store via load()/save() plus gen() for ` +
    `random short ids/codes. ADD ONLY YOUR ROUTE HANDLERS where the file says "ADD YOUR ROUTE ` +
    `HANDLERS HERE", reading request fields EXACTLY as the shared contract names them — do NOT ` +
    `change the require lines, the PORT, or app.listen, and do NOT create a second server file. ` +
    `Use gen() for codes — do NOT add nanoid (ESM-only, breaks require). For any other handler ` +
    `dependency add a CommonJS package and \`npm install\` it; run \`npm start\` to confirm it boots.`
  );
}

export interface ServerScaffoldResult {
  /** True iff this call seeded a greenfield skeleton (false if a server file already existed). */
  seeded: boolean;
  /** The server entrypoint path (relative to workdir). */
  serverFile: string;
}

/**
 * Seed the plumbing skeleton + a runnable package.json into a GREENFIELD workdir for a server node.
 * No-op (seeded:false) if the server file already exists — never clobbers real work. Idempotent.
 */
export function scaffoldServerNode(opts: { workdir: string; blastRadius: string[] }): ServerScaffoldResult {
  const serverFile = pickServerFile(opts.blastRadius);
  const abs = join(opts.workdir, serverFile);
  if (existsSync(abs)) return { seeded: false, serverFile };

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, serverSkeleton());

  const pkgPath = join(opts.workdir, "package.json");
  const existing = existsSync(pkgPath) ? readFileSync(pkgPath, "utf8") : undefined;
  writeFileSync(pkgPath, serverPackageJson(serverFile, existing));

  return { seeded: true, serverFile };
}
