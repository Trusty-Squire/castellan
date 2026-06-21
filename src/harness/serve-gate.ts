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
import { dirname, join } from "node:path";
import { connect } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface ServeGateResult {
  ok: boolean;
  /** The check command's exit code when the server booted; 3 = no server could be started. */
  code: number;
  note: string;
}

/** Poll a TCP port until it accepts a connection (server booted) or the deadline. */
function waitForPort(port: number, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const attempt = (): void => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

/**
 * Ordered candidate commands to boot a server in `workdir`. The harness OWNS this so a
 * server node need not declare it: try npm start/dev, then any python/node file that
 * either has a conventional server name or whose source carries a server signature.
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
  let files: string[] = [];
  try {
    files = readdirSync(workdir).filter((f) => /\.(py|js|mjs|cjs)$/.test(f));
  } catch {
    /* unreadable workdir */
  }
  const KNOWN_PY = ["app.py", "main.py", "server.py", "api_server.py", "api.py", "run.py", "wsgi.py", "asgi.py", "manage.py"];
  const KNOWN_JS = ["server.js", "index.js", "app.js", "main.js"];
  const PY_SIG = /uvicorn|fastapi|flask|app\.run\(|http\.server|hypercorn|gunicorn|run\(host/i;
  const JS_SIG = /\.listen\(|createServer|express\(|fastify|new Server/i;
  for (const f of KNOWN_PY) if (files.includes(f)) push(`python3 ${f}`);
  for (const f of KNOWN_JS) if (files.includes(f)) push(`node ${f}`);
  for (const f of files) {
    if (f.endsWith(".py") && PY_SIG.test(read(f))) push(`python3 ${f}`);
    else if (/\.(js|mjs|cjs)$/.test(f) && JS_SIG.test(read(f))) push(`node ${f}`);
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
    const up = await waitForPort(opts.port, deadline);
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
