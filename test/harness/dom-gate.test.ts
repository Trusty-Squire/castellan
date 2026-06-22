import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { renderGate } from "../../src/contract/gate-patterns.js";
import { findChrome, runDomGate, scaffoldDomGate, type DomStep } from "../../src/harness/dom-gate.js";
import { existsSync, mkdtempSync as mkdtemp } from "node:fs";
import { tmpdir as tmp } from "node:os";
import { join as pjoin } from "node:path";

// ---- pure pattern render + scaffold (hermetic, no browser) ----
describe("dom-behavior gate pattern", () => {
  it("renders to a `node .squire/dom-gate.mjs <url> <steps>` command, steps JSON intact", () => {
    const steps = '[{"read":"#pot","as":"p0"},{"click":"[data-action=raise]"},{"assert":"#pot","gt":"p0"}]';
    const g = renderGate("dom-behavior", { url: "http://localhost:3000", steps });
    expect(g.type).toBe("command");
    expect(g.run).toContain("node .squire/dom-gate.mjs");
    expect(g.run).toContain("http://localhost:3000");
    expect(g.run).toContain('"gt":"p0"'); // the steps survive shell-quoting
  });

  it("scaffolds a self-contained runner into .squire/ (the gate runs with bare node)", () => {
    const dir = mkdtemp(pjoin(tmp(), "scaffold-"));
    const rel = scaffoldDomGate(dir);
    expect(rel).toBe(pjoin(".squire", "dom-gate.mjs"));
    expect(existsSync(pjoin(dir, rel))).toBe(true);
  });

  it("accepts steps as a native JSON array (no escaped string) + an optional serve", () => {
    const g = renderGate("dom-behavior", {
      url: "http://localhost:3000",
      steps: [{ read: "[data-testid=pot]", as: "p0" }, { click: "[data-action=raise]" }, { assert: "[data-testid=pot]", gt: "p0" }],
      serve: "npm start",
    });
    expect(g.run).toContain("node .squire/dom-gate.mjs");
    expect(g.run).toContain('"gt":"p0"'); // the array was stringified into the command
    expect(g.run).toContain("--serve");
    expect(g.run).toContain("npm start");
  });
});

// ---- real browser run (skipped when no Chrome is present) ----
const PAGE = `<!doctype html><html><head><style>
  #spinner{width:20px;height:20px;animation:spin 1s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head><body>
  <div id="pot">0</div>
  <button data-action="raise" onclick="document.getElementById('pot').textContent=(+document.getElementById('pot').textContent+100)">raise</button>
  <button id="locked" disabled>locked</button>
  <div class="card" data-face="down"></div><div class="card" data-face="down"></div>
  <div id="spinner"></div>
  <div id="static">stays</div>
  <script>
    document.querySelector('[data-action=raise]').addEventListener('click',()=>{
      document.querySelectorAll('.card').forEach(c=>c.setAttribute('data-face','up'));
    });
  </script>
</body></html>`;

function serve(html: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      const port = a && typeof a === "object" ? a.port : 0;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

const chrome = await findChrome();
const itBrowser = chrome ? it : it.skip;

describe("runDomGate (real headless Chrome)", () => {
  itBrowser("PASSES a true behavioral assertion: clicking raise increases #pot", async () => {
    const s = await serve(PAGE);
    try {
      const steps: DomStep[] = [
        { read: "#pot", as: "p0" },
        { click: "[data-action=raise]" },
        { assert: "#pot", gt: "p0" }, // 0 -> 100
        { assert: ".card", count: 2 },
        { assert: ".card", prop: "data-face", eq: "up" }, // the cards flipped face-up on the click
      ];
      const r = await runDomGate(s.url, steps, { chrome: chrome!, timeoutMs: 20000 });
      expect(r.failures).toEqual([]);
      expect(r.ok).toBe(true);
    } finally { s.close(); }
  }, 30000);

  itBrowser("FAILS honestly when the behavior does not hold (pot not > 999)", async () => {
    const s = await serve(PAGE);
    try {
      const r = await runDomGate(s.url, [{ read: "#pot", as: "p0" }, { click: "[data-action=raise]" }, { assert: "#pot", gt: 999 }], { chrome: chrome!, timeoutMs: 20000 });
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toMatch(/> 999 failed/);
    } finally { s.close(); }
  }, 30000);

  itBrowser("reads disabled state and animation (control disabled; spinner animates, static does not)", async () => {
    const s = await serve(PAGE);
    try {
      const r = await runDomGate(s.url, [
        { assert: "#locked", disabled: true },
        { assert: "#spinner", animated: true },
        { assert: "#static", animated: false },
      ], { chrome: chrome!, timeoutMs: 20000 });
      expect(r.failures).toEqual([]);
      expect(r.ok).toBe(true);
    } finally { s.close(); }
  }, 30000);

  itBrowser("fills an input then clicks — the dashboard appears only if the typed value was set", async () => {
    const loginPage = `<!doctype html><html><body>
      <form data-testid="login-form">
        <input data-testid="password-input" />
        <button type="button" data-testid="login-button"
          onclick="if(document.querySelector('[data-testid=password-input]').value==='password123'){const d=document.createElement('div');d.setAttribute('data-testid','dashboard');document.body.appendChild(d);}">go</button>
      </form>
    </body></html>`;
    const s = await serve(loginPage);
    try {
      const r = await runDomGate(s.url, [
        { assert: "[data-testid=login-form]", exists: true },
        { fill: "[data-testid=password-input]", value: "password123" },
        { click: "[data-testid=login-button]" },
        { wait: 300 },
        { assert: "[data-testid=dashboard]", exists: true }, // only present if fill set the value
      ], { chrome: chrome!, timeoutMs: 20000 });
      expect(r.failures).toEqual([]);
      expect(r.ok).toBe(true);
    } finally { s.close(); }
  }, 30000);

  itBrowser("returns a clear failure when a selector is missing", async () => {
    const s = await serve(PAGE);
    try {
      const r = await runDomGate(s.url, [{ assert: "#nope", exists: true }], { chrome: chrome!, timeoutMs: 15000 });
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toMatch(/exists=true failed|not found/);
    } finally { s.close(); }
  }, 30000);

  itBrowser("boots the app via `serve`, waits for the URL, drives it, then tears it down", async () => {
    const port = 38317;
    const dir = mkdtemp(pjoin(tmp(), "srv-"));
    const srv = pjoin(dir, "server.mjs");
    writeFileSync(
      srv,
      `import{createServer}from"node:http";const html=${JSON.stringify(PAGE)};` +
        `createServer((q,s)=>{s.writeHead(200,{"content-type":"text/html"});s.end(html)}).listen(${port},"127.0.0.1");`,
    );
    const r = await runDomGate(
      `http://127.0.0.1:${port}/`,
      [{ read: "#pot", as: "p0" }, { click: "[data-action=raise]" }, { assert: "#pot", gt: "p0" }],
      { chrome: chrome!, serve: `node ${srv}`, timeoutMs: 25000 },
    );
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  }, 40000);
});

// ---- slop-audit: deterministic anti-slop gate (no browser) ----
import { execa } from "execa";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("slop-audit gate pattern", () => {
  it("renders an inverted grep over the built CSS/HTML", () => {
    const g = renderGate("slop-audit", { scope: "dist" });
    expect(g.type).toBe("command");
    expect(g.run).toMatch(/^! grep/);
    expect(g.run).toContain("background-clip");
    expect(g.run).toContain("dist");
  });

  it("FAILS on slop CSS and PASSES on clean CSS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-"));
    mkdirSync(join(dir, "css"), { recursive: true });
    writeFileSync(join(dir, "css", "clean.css"), "body{color:#222;background:#fafafa}\n");
    const clean = await execa("sh", ["-c", renderGate("slop-audit", { scope: dir }).run!], { reject: false });
    expect(clean.exitCode).toBe(0); // no tells -> pass

    writeFileSync(join(dir, "css", "slop.css"), ".hero{backdrop-filter: blur(10px);background:linear-gradient(135deg,#667eea,#764ba2)}\n");
    const slop = await execa("sh", ["-c", renderGate("slop-audit", { scope: dir }).run!], { reject: false });
    expect(slop.exitCode).toBe(1); // tell found -> fail
  });
});
