/**
 * The serve-gate runner — the browserless analog of dom-gate. The planner happily
 * writes HTTP gates that `curl http://localhost:8000/...` but emits NO step to BOOT the
 * server, so the gate is un-passable by construction (connection refused forever) no
 * matter how good the built code is. (Measured: the trustysquire build honest-halted on
 * exactly this — auth_module, gate exit 4, server never started.) dom-gate already solves
 * the UI half (`--serve 'npm start'`); this solves the API half: boot the built server,
 * wait for its port, run the curl checks, tear the server down, propagate the check's exit.
 *
 * It INFERS the start command from the workdir (npm start; a python/node server file) so
 * it boots whatever the cheap model produced without the planner having to declare it.
 * Self-scaffolds into <workdir>/.squire/serve-gate.mjs exactly like dom-gate.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { connect } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ServeGateResult {
  ok: boolean;
  /** The check command's exit code when the server booted; 3 = no server could be started. */
  code: number;
  note: string;
}

/**
 * Poll a TCP port until it accepts a connection (server booted), the deadline, OR the
 * server process exits first — a candidate that runs and exits without listening (a
 * factory-export module loaded by `node <file>`) is abandoned immediately, not waited out.
 */
function waitForPort(port: number, deadline: number, server?: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    server?.once("exit", () => finish(false));
    const attempt = (): void => {
      if (done) return;
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        finish(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) finish(false);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

const IGNORE_DIRS = new Set(["node_modules", ".git", ".squire", ".venv", "venv", "__pycache__", "dist", "build", ".pytest_cache", "coverage", ".next"]);

/** Relative paths of .py/.js source files up to `maxDepth` levels deep, skipping noise dirs. */
function listSourceFiles(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name) || (e.name.startsWith(".") && e.isDirectory())) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isFile() && /\.(py|js|mjs|cjs)$/.test(e.name)) out.push(rel);
      else if (e.isDirectory() && depth > 0) walk(join(dir, e.name), rel, depth - 1);
    }
  };
  walk(root, "", maxDepth);
  return out;
}

/**
 * Ordered candidate commands to boot a server in `workdir`. The harness OWNS this so a
 * server node need not declare it: try npm start/dev, then any python/node file (root OR
 * a level down in src/ / app/ / backend/) that has a conventional server name or whose
 * source carries a server signature.
 */
export function inferStartCommands(workdir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (cmd: string): void => {
    if (!seen.has(cmd)) {
      seen.add(cmd);
      out.push(cmd);
    }
  };
  const read = (f: string): string => {
    try {
      return readFileSync(join(workdir, f), "utf8");
    } catch {
      return "";
    }
  };
  if (existsSync(join(workdir, "package.json"))) {
    try {
      const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.start) push("npm start");
      if (pkg.scripts?.dev) push("npm run dev");
    } catch {
      /* malformed package.json — skip the npm candidates */
    }
  }
  // Scan the root AND one or two levels down — the model routinely writes the server
  // into src/ / app/ / backend/ (and its blast radius may FORCE that), so a root-only
  // scan misses it entirely (the auth-api "no server file" halt). Relative paths so the
  // candidate command boots the right file: `node src/auth-api.js`.
  const files = listSourceFiles(workdir, 2);
  const KNOWN_PY = ["app.py", "main.py", "server.py", "api_server.py", "api.py", "run.py", "wsgi.py", "asgi.py", "manage.py"];
  const KNOWN_JS = ["server.js", "index.js", "app.js", "main.js"];
  const PY_SIG = /uvicorn|fastapi|flask|app\.run\(|http\.server|hypercorn|gunicorn|run\(host/i;
  // A factory export (createApp/makeApp) counts as a server file even with no top-level
  // .listen — the contract often pins a testable factory, so we boot it ourselves below.
  const JS_SIG = /\.listen\(|createServer|express\(|fastify|new Server|createApp|makeApp|buildApp/i;
  // Boot a module that exports a factory (createApp) or an app but never calls listen():
  // import it, resolve the app across CJS/ESM + factory/instance shapes, and listen. This
  // is the harness BRIDGING the testable-factory contract to the live HTTP gate.
  const factoryBoot = (f: string): string =>
    `node -e "import('./${f}').then(m=>{const c=m.default??m;const a=(c&&c.createApp&&c.createApp())||(c&&c.makeApp&&c.makeApp())||(c&&c.app)||(typeof c==='function'&&c())||(m.createApp&&m.createApp());a&&a.listen?a.listen(process.env.PORT,'127.0.0.1'):process.exit(7)}).catch(e=>{console.error(String(e));process.exit(7)})"`;
  const pushJs = (f: string): void => {
    push(`node ${f}`); // self-listening entrypoint, preferred
    push(factoryBoot(f)); // fallback: boot a factory/app export that doesn't self-listen
  };
  for (const f of files) if (f.endsWith(".py") && KNOWN_PY.includes(basename(f))) push(`python3 ${f}`);
  for (const f of files) if (/\.(js|mjs|cjs)$/.test(f) && KNOWN_JS.includes(basename(f))) pushJs(f);
  for (const f of files) {
    if (f.endsWith(".py") && PY_SIG.test(read(f))) push(`python3 ${f}`);
    else if (/\.(js|mjs|cjs)$/.test(f) && JS_SIG.test(read(f))) pushJs(f);
  }
  return out;
}

/** Boot a server (given or inferred), wait for `port`, run `check`, tear the server down. */
export async function runServeGate(opts: {
  port: number;
  check: string;
  start?: string;
  workdir?: string;
  timeoutMs?: number;
}): Promise<ServeGateResult> {
  const workdir = opts.workdir ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const candidates = opts.start ? [opts.start] : inferStartCommands(workdir);
  if (candidates.length === 0) {
    return { ok: false, code: 3, note: `no way to boot a server for port ${opts.port} (no npm start / server file in ${workdir})` };
  }
  const tried: string[] = [];
  const kill = (server: ChildProcess): void => {
    if (!server.pid) return;
    try {
      process.kill(-server.pid, "SIGKILL"); // the whole group (npm -> node -> …)
    } catch {
      try {
        server.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  for (const start of candidates) {
    const deadline = Date.now() + timeoutMs;
    const server = spawn("sh", ["-c", start], {
      cwd: workdir,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, PORT: String(opts.port) }, // nudge servers that read $PORT
    });
    const up = await waitForPort(opts.port, deadline, server);
    if (!up) {
      tried.push(start);
      kill(server);
      continue;
    }
    try {
      const code = await new Promise<number>((resolve) => {
        const c = spawn("sh", ["-c", opts.check], { cwd: workdir, stdio: "inherit" });
        c.on("exit", (x) => resolve(x ?? 1));
        c.on("error", () => resolve(1));
      });
      return { ok: code === 0, code, note: `server booted via \`${start}\` on :${opts.port}` };
    } finally {
      kill(server);
    }
  }
  return { ok: false, code: 3, note: `server never came up on port ${opts.port}; tried: ${tried.join(" | ")}` };
}

/**
 * Copy this runner into <workdir>/.squire/serve-gate.mjs so a wrapped HTTP gate runs with
 * bare `node` — no `ser` on PATH, no deps. `.squire/` survives the per-rung reset.
 */
export function scaffoldServeGate(workdir: string): string {
  const rel = join(".squire", "serve-gate.mjs");
  const dest = join(workdir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(fileURLToPath(import.meta.url), dest);
  return rel;
}

/** CLI: `node serve-gate.mjs --port <p> --check '<cmd>' [--start '<cmd>']`. exit 0 = pass. */
async function serveGateMain(argv: string[]): Promise<number> {
  let port = NaN;
  let check: string | undefined;
  let start: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") port = Number(argv[++i]);
    else if (argv[i] === "--check") check = argv[++i];
    else if (argv[i] === "--start") start = argv[++i];
  }
  if (!port || !check) {
    process.stderr.write("usage: serve-gate --port <p> --check '<cmd>' [--start '<cmd>']\n");
    return 2;
  }
  const r = await runServeGate({ port, check, start });
  if (!r.ok) {
    process.stderr.write(`serve-gate FAIL: ${r.note}\n`);
    return r.code === 0 ? 1 : r.code;
  }
  process.stdout.write(`serve-gate OK (${r.note})\n`);
  return 0;
}

// Run directly (the scaffolded .squire/serve-gate.mjs) — but NOT when imported by CLI/tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  serveGateMain(process.argv.slice(2)).then((c) => process.exit(c));
}
