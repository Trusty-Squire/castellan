import { describe, it, expect } from "vitest";
import { createServer, type Server } from "node:http";
import { renderGate } from "../../src/contract/gate-patterns.js";
import { findChrome, runDomGate, type DomStep } from "../../src/harness/dom-gate.js";

// ---- pure pattern render (hermetic, no browser) ----
describe("dom-behavior gate pattern", () => {
  it("renders to a `ser dom-gate <url> <steps>` command, steps JSON intact", () => {
    const steps = '[{"read":"#pot","as":"p0"},{"click":"[data-action=raise]"},{"assert":"#pot","gt":"p0"}]';
    const g = renderGate("dom-behavior", { url: "http://localhost:3000", steps });
    expect(g.type).toBe("command");
    expect(g.run).toContain("ser dom-gate");
    expect(g.run).toContain("http://localhost:3000");
    expect(g.run).toContain('"gt":"p0"'); // the steps survive shell-quoting
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

  itBrowser("returns a clear failure when a selector is missing", async () => {
    const s = await serve(PAGE);
    try {
      const r = await runDomGate(s.url, [{ assert: "#nope", exists: true }], { chrome: chrome!, timeoutMs: 15000 });
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toMatch(/exists=true failed|not found/);
    } finally { s.close(); }
  }, 30000);
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
