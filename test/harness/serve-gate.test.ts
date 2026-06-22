import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inferStartCommands, runServeGate } from "../../src/harness/serve-gate.js";
import { serverGatePort, wrapWithServeGate } from "../../src/contract/gate-patterns.js";

const dirs: string[] = [];
function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), "ser-servegate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("serverGatePort — detect a localhost gate that boots no server", () => {
  it("returns the port for a curl-localhost gate with no boot step", () => {
    expect(serverGatePort("curl -s http://localhost:8000/login | jq -e '.token'")).toBe(8000);
    expect(serverGatePort("curl http://127.0.0.1:3001/api/keys | jq -e 'type==\"array\"'")).toBe(3001);
  });
  it("a chain of && curls is logical-AND, NOT backgrounding — still wraps (regression)", () => {
    const chain =
      "curl -s -X POST http://localhost:8000/login -d '{}' | jq -e '.access_token != null' && " +
      "T=$(curl -s http://localhost:8000/login | jq -r '.t') && curl http://localhost:8000/api/keys -H \"Authorization: Bearer $T\" | jq -e '.'";
    expect(serverGatePort(chain)).toBe(8000);
  });
  it("returns null when the gate ALREADY boots something (no double-boot)", () => {
    expect(serverGatePort("node .squire/dom-gate.mjs 'http://localhost:3000' '[]' --serve 'npm start'")).toBeNull();
    expect(serverGatePort("uvicorn app:app & sleep 2; curl http://localhost:8000/")).toBeNull();
    expect(serverGatePort("python3 app.py & sleep 1; curl http://localhost:8000/")).toBeNull(); // lone & = background
    expect(serverGatePort("node .squire/serve-gate.mjs --port 8000 --check 'curl http://localhost:8000/'")).toBeNull();
  });
  it("returns null for gates that hit only EXTERNAL hosts (env base url / real domain)", () => {
    expect(serverGatePort("curl -s ${VOUCHFLOW_BASE_URL}/signup | jq -e '.account_id'")).toBeNull();
    expect(serverGatePort("curl -s https://api.example.com/v1/keys")).toBeNull();
  });
  it("does NOT wrap a localhost port bound to an external-service base URL (the mock provider)", () => {
    // 8001 is an inlined mock provider the gate talks TO, not a build server.
    expect(serverGatePort("VOUCHFLOW_BASE_URL=http://localhost:8001 ./run-bot.sh vouchflow | grep -q vf_")).toBeNull();
    // but a real app port alongside the mock base URL still wraps (the app the build serves)
    expect(serverGatePort("VOUCHFLOW_BASE_URL=http://localhost:8001 ./run-bot.sh && curl http://localhost:3000/api/keys")).toBe(3000);
  });
});

describe("wrapWithServeGate — route the gate through the booting runner", () => {
  it("wraps the original gate verbatim as the --check payload", () => {
    const w = wrapWithServeGate("curl http://localhost:8000/x | jq -e '.ok'", 8000);
    expect(w).toBe("node .squire/serve-gate.mjs --port 8000 --check 'curl http://localhost:8000/x | jq -e '\\''.ok'\\'''");
  });
});

describe("inferStartCommands — boot whatever the build produced", () => {
  it("prefers npm start, then sniffs server files by name and by content", () => {
    const d = workdir();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { start: "node server.js", dev: "vite" } }));
    writeFileSync(join(d, "server.js"), "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)");
    writeFileSync(join(d, "helper.py"), "import uvicorn  # FastAPI app\n");
    const cmds = inferStartCommands(d);
    expect(cmds[0]).toBe("npm start");
    expect(cmds).toContain("npm run dev");
    expect(cmds).toContain("node server.js");
    expect(cmds).toContain("python3 helper.py"); // content-sniffed (uvicorn), not a known name
  });
  it("finds a server written into src/ (the blast-radius case), not just the root", () => {
    const d = workdir();
    mkdirSync(join(d, "src"));
    writeFileSync(join(d, "src", "auth-api.js"), "require('http').createServer((q,s)=>s.end('ok')).listen(8000)");
    expect(inferStartCommands(d)).toContain("node src/auth-api.js");
  });
  it("skips node_modules / venv noise when scanning subdirs", () => {
    const d = workdir();
    mkdirSync(join(d, "node_modules", "x"), { recursive: true });
    writeFileSync(join(d, "node_modules", "x", "server.js"), "require('http').createServer(()=>{}).listen(1)");
    expect(inferStartCommands(d)).toEqual([]);
  });
  it("returns [] for a workdir with no bootable server", () => {
    const d = workdir();
    writeFileSync(join(d, "notes.txt"), "nothing to boot");
    expect(inferStartCommands(d)).toEqual([]);
  });
});

describe("runServeGate — boot, wait for the port, run the check, tear down", () => {
  it("boots an inferred node server and the check passes against it", async () => {
    const d = workdir();
    const port = 8791;
    writeFileSync(
      join(d, "server.js"),
      `require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')}).listen(${port},'127.0.0.1')`,
    );
    const r = await runServeGate({
      port,
      check: `curl -sf http://127.0.0.1:${port}/ -o /dev/null`,
      workdir: d,
      timeoutMs: 8000,
    });
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it("boots a FACTORY export (createApp, no top-level listen) — the contract-coherence case", async () => {
    const d = workdir();
    const port = 8794;
    // The contract pins a testable factory: export createApp(), never call listen().
    // `node api.js` loads it and exits without serving; the harness must boot the factory.
    writeFileSync(
      join(d, "api.js"),
      "module.exports.createApp = () => require('http').createServer((q,s)=>{s.writeHead(200);s.end('ok')});",
    );
    const cmds = inferStartCommands(d);
    expect(cmds.some((c) => c.includes("import('./api.js')"))).toBe(true); // factory-boot candidate emitted
    const r = await runServeGate({
      port,
      check: `curl -sf http://127.0.0.1:${port}/ -o /dev/null`,
      workdir: d,
      timeoutMs: 8000,
    });
    expect(r.ok).toBe(true);
    expect(r.note).toMatch(/import\(/); // booted via the factory fallback, not a self-listen
  });

  it("on a FAILED check, surfaces the requests it made (so the build sees a contract mismatch)", async () => {
    const d = workdir();
    const port = 8795;
    // a server that 400s with a body unless the body has `name` (the build read the wrong field)
    writeFileSync(
      join(d, "server.js"),
      `const http=require('http');http.createServer((q,s)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{` +
        `let ok=false;try{ok=!!JSON.parse(b||'{}').name}catch{}` +
        `if(ok){s.writeHead(200);s.end('{"ok":true}')}else{s.writeHead(400);s.end('{"error":"name is required"}')}` +
        `})}).listen(${port},'127.0.0.1')`,
    );
    const r = await runServeGate({
      port,
      // the gate POSTs `longUrl`, the server wants `name` → 400, curl -f hides the body
      check: `curl -fsS -X POST http://127.0.0.1:${port}/api -H 'content-type: application/json' -d '{"longUrl":"https://x.com"}' | grep -q ok`,
      workdir: d,
      timeoutMs: 8000,
    });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/the check FAILED/);
    // the request the gate actually sent is now visible — enough for the build to spot that it read
    // the wrong field (it POSTed `longUrl`, the handler expected something else)
    expect(r.note).toContain("longUrl");
    expect(r.note).toMatch(/curl/); // the failing request appears in the trace
  });

  it("reports code 3 (not a false pass) when no server can be booted", async () => {
    const d = workdir();
    const r = await runServeGate({ port: 8792, check: "true", workdir: d, timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.note).toMatch(/no way to boot/i);
  });
});
