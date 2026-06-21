/**
 * dom-gate — the jq-for-the-DOM. Drives the BUILT UI in a headless browser and
 * asserts BEHAVIORS a `curl`/`grep` gate cannot see: after clicking [data-action=raise]
 * the #pot number increases; a card's face flips on reveal; a control disables off-turn;
 * an element animates. Deterministic, exit-code-judged — the membrane extended to the DOM.
 *
 * Zero runtime deps: drives the system Chrome `findChrome` returns, over the Chrome
 * DevTools Protocol, using Node's global WebSocket + fetch (Node >= 22). NOT an e2e
 * framework — one bounded assertion script, the frontend analogue of the API's jq gates.
 *
 * The selector contract: gates are authored before the code exists, so a dom-behavior
 * gate asserts STABLE hooks (#pot, [data-action=raise], [data-face]) that the node brief
 * must also tell the builder to emit — same shared-contract discipline as the data shapes.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CHROME_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

/** First Chrome/Chromium on PATH, or null (the gate then reports "no browser"). */
export async function findChrome(): Promise<string | null> {
  for (const bin of CHROME_BINS) {
    if (spawnSync("which", [bin]).status === 0) return bin;
  }
  return null;
}

/** One driven step. Exactly one verb key per object. */
export type DomStep =
  | { goto: string }
  | { wait: number }
  | { read: string; as: string; prop?: string } // prop: "text" (default) | "value" | <attribute>
  | { click: string }
  | { press: string } // a KeyboardEvent.key, e.g. "ArrowRight", " ", "Enter"
  | ({ assert: string; prop?: string } & AssertOp); // prop: "text" (default) | "value" | <attribute>, for the value ops

type AssertOp =
  | { exists: boolean }
  | { count: number }
  | { gt: string | number } // element's first number > ref (a stored var name or a literal)
  | { lt: string | number }
  | { changed: string } // element's value differs from the stored var
  | { eq: string }
  | { includes: string }
  | { enabled: boolean }
  | { disabled: boolean }
  | { animated: boolean }; // a tracked property changes across ~700ms

export interface DomGateResult {
  ok: boolean;
  ran: number;
  failures: string[];
}

/** Minimal CDP client over the Node global WebSocket. One in-flight map keyed by id. */
class Cdp {
  private readonly ws: WebSocket;
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (typeof msg.id !== "number") return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  static connect(wsUrl: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener("open", () => resolve(new Cdp(ws)));
      ws.addEventListener("error", () => reject(new Error("CDP websocket error")));
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close(): void {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

/** Evaluate an expression in the page; returns the JSON-serialized value (or throws). */
async function evalExpr(cdp: Cdp, expression: string): Promise<unknown> {
  const r = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
    result?: { value?: unknown };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "eval error");
  return r.result?.value;
}

const jstr = (s: string): string => JSON.stringify(s);
/** First number in a string ("$1,200.50" -> 1200.5), or NaN. */
function firstNumber(v: unknown): number {
  const m = String(v ?? "").match(/-?\d[\d,]*\.?\d*/);
  return m ? Number(m[0].replace(/,/g, "")) : NaN;
}

/** Poll until the selector matches (>0) or the deadline; resolves true/false. */
async function waitFor(cdp: Cdp, sel: string, deadline: number): Promise<boolean> {
  for (;;) {
    const n = (await evalExpr(cdp, `document.querySelectorAll(${jstr(sel)}).length`)) as number;
    if (n > 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const readExpr = (sel: string, prop: string): string => {
  const get = prop === "text" ? "(el.textContent||'').trim()" : prop === "value" ? "el.value" : `el.getAttribute(${jstr(prop)})`;
  return `(()=>{const el=document.querySelector(${jstr(sel)});return el?${get}:null;})()`;
};

/** Run a dom-behavior gate against a URL. Pure-ish: returns a verdict, never throws on assertion failure. */
export async function runDomGate(url: string, steps: DomStep[], opts: { timeoutMs?: number; chrome?: string } = {}): Promise<DomGateResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const chrome = opts.chrome ?? (await findChrome());
  if (!chrome) return { ok: false, ran: 0, failures: ["no Chrome/Chromium found — dom-behavior gate cannot run"] };

  const userDir = mkdtempSync(join(tmpdir(), "ser-domgate-"));
  let proc: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const vars = new Map<string, unknown>();
  const failures: string[] = [];
  let ran = 0;
  try {
    proc = spawn(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      "--remote-debugging-port=0", `--user-data-dir=${userDir}`, url,
    ], { stdio: "ignore" });
    // Chrome writes the chosen port to DevToolsActivePort once the endpoint is up.
    const portFile = join(userDir, "DevToolsActivePort");
    while (!existsSync(portFile)) {
      if (Date.now() > deadline) return { ok: false, ran, failures: ["browser did not start in time"] };
      await new Promise((r) => setTimeout(r, 100));
    }
    const port = readFileSync(portFile, "utf8").split("\n")[0]!.trim();
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === "page");
    if (!page) return { ok: false, ran, failures: ["no page target in the browser"] };
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    // Settle the initial load.
    await new Promise((r) => setTimeout(r, 400));

    for (const step of steps) {
      ran += 1;
      if ("goto" in step) {
        await cdp.send("Page.navigate", { url: step.goto });
        await new Promise((r) => setTimeout(r, 500));
      } else if ("wait" in step) {
        await new Promise((r) => setTimeout(r, Math.min(step.wait, Math.max(0, deadline - Date.now()))));
      } else if ("read" in step) {
        if (!(await waitFor(cdp, step.read, deadline))) { failures.push(`read: selector not found: ${step.read}`); continue; }
        vars.set(step.as, await evalExpr(cdp, readExpr(step.read, step.prop ?? "text")));
      } else if ("click" in step) {
        if (!(await waitFor(cdp, step.click, deadline))) { failures.push(`click: selector not found: ${step.click}`); continue; }
        await evalExpr(cdp, `(()=>{const el=document.querySelector(${jstr(step.click)});if(el){el.scrollIntoView();el.click();return true;}return false;})()`);
        await new Promise((r) => setTimeout(r, 200));
      } else if ("press" in step) {
        await evalExpr(cdp, `(()=>{const t=document.activeElement||document.body;['keydown','keyup'].forEach(ty=>t.dispatchEvent(new KeyboardEvent(ty,{key:${jstr(step.press)},bubbles:true})));return true;})()`);
        await new Promise((r) => setTimeout(r, 150));
      } else if ("assert" in step) {
        const f = await runAssert(cdp, step, vars, deadline);
        if (f) failures.push(f);
      }
    }
    return { ok: failures.length === 0, ran, failures };
  } catch (e) {
    return { ok: false, ran, failures: [...failures, `dom-gate error: ${(e as Error).message}`] };
  } finally {
    cdp?.close();
    proc?.kill("SIGKILL");
    try { rmSync(userDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Returns a failure string, or null if the assertion holds. */
async function runAssert(cdp: Cdp, step: { assert: string; prop?: string } & AssertOp, vars: Map<string, unknown>, deadline: number): Promise<string | null> {
  const sel = step.assert;
  const refVal = (r: string | number): number => (typeof r === "number" ? r : vars.has(r) ? firstNumber(vars.get(r)) : firstNumber(r));
  if ("exists" in step) {
    const found = await waitFor(cdp, sel, step.exists ? deadline : Date.now() + 300);
    return found === step.exists ? null : `assert exists=${step.exists} failed for ${sel}`;
  }
  if ("count" in step) {
    const n = (await evalExpr(cdp, `document.querySelectorAll(${jstr(sel)}).length`)) as number;
    return n === step.count ? null : `assert count=${step.count} failed for ${sel} (got ${n})`;
  }
  if ("enabled" in step || "disabled" in step) {
    const want = "enabled" in step ? step.enabled : !step.disabled;
    const dis = (await evalExpr(cdp, `(()=>{const el=document.querySelector(${jstr(sel)});return el?(el.disabled===true||el.getAttribute('aria-disabled')==='true'):null;})()`)) as boolean | null;
    if (dis === null) return `assert enabled/disabled: selector not found: ${sel}`;
    return dis === !want ? null : `assert ${"enabled" in step ? "enabled" : "disabled"} failed for ${sel}`;
  }
  if ("animated" in step) {
    const probe = `(()=>{const el=document.querySelector(${jstr(sel)});if(!el)return null;const r=el.getBoundingClientRect();const s=getComputedStyle(el);return JSON.stringify([r.x,r.y,r.width,r.height,s.transform,s.backgroundColor,(el.textContent||'').slice(0,40)]);})()`;
    const a = await evalExpr(cdp, probe);
    await new Promise((r) => setTimeout(r, 700));
    const b = await evalExpr(cdp, probe);
    if (a === null) return `assert animated: selector not found: ${sel}`;
    const changed = a !== b;
    return changed === step.animated ? null : `assert animated=${step.animated} failed for ${sel} (no change over 700ms)`;
  }
  // value-based ops: read current (text by default, or a prop/attribute)
  if (!(await waitFor(cdp, sel, deadline))) return `assert: selector not found: ${sel}`;
  const cur = await evalExpr(cdp, readExpr(sel, step.prop ?? "text"));
  if ("gt" in step) { const ok = firstNumber(cur) > refVal(step.gt); return ok ? null : `assert ${sel} > ${step.gt} failed (got ${firstNumber(cur)})`; }
  if ("lt" in step) { const ok = firstNumber(cur) < refVal(step.lt); return ok ? null : `assert ${sel} < ${step.lt} failed (got ${firstNumber(cur)})`; }
  if ("changed" in step) { const ok = String(cur) !== String(vars.get(step.changed)); return ok ? null : `assert ${sel} changed from "${step.changed}" failed (still "${cur}")`; }
  if ("eq" in step) { const ok = String(cur ?? "").trim() === step.eq; return ok ? null : `assert ${sel} == "${step.eq}" failed (got "${cur}")`; }
  if ("includes" in step) { const ok = String(cur ?? "").includes(step.includes); return ok ? null : `assert ${sel} includes "${step.includes}" failed (got "${cur}")`; }
  return `unknown assertion for ${sel}`;
}

/**
 * Copy this runner into <workdir>/.squire/dom-gate.mjs so a dom-behavior gate runs
 * with bare `node` — no `ser` on PATH, no deps. `.squire/` is git-clean-excluded, so
 * it survives the per-rung reset. Returns the workdir-relative path the gate invokes.
 */
export function scaffoldDomGate(workdir: string): string {
  const rel = join(".squire", "dom-gate.mjs");
  const dest = join(workdir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(fileURLToPath(import.meta.url), dest);
  return rel;
}

/** CLI entry: `node dom-gate.mjs <url> '<steps-json>'` — exit 0 = pass, 1 = a real failure, 2 = usage. */
async function domGateMain(argv: string[]): Promise<number> {
  const [url, stepsJson] = argv;
  if (!url || !stepsJson) {
    process.stderr.write("usage: dom-gate <url> '<steps-json>'\n");
    return 2;
  }
  let steps: DomStep[];
  try {
    steps = JSON.parse(stepsJson);
    if (!Array.isArray(steps)) throw new Error("steps must be a JSON array");
  } catch (e) {
    process.stderr.write(`invalid steps JSON: ${(e as Error).message}\n`);
    return 2;
  }
  const r = await runDomGate(url, steps);
  if (!r.ok) {
    for (const f of r.failures) process.stderr.write(`dom-gate FAIL: ${f}\n`);
    return 1;
  }
  process.stdout.write(`dom-gate OK (${r.ran} step(s) passed)\n`);
  return 0;
}

// Run directly (the scaffolded .squire/dom-gate.mjs) — but NOT when imported by the CLI/tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  domGateMain(process.argv.slice(2)).then((c) => process.exit(c));
}
