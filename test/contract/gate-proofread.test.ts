import { describe, it, expect } from "vitest";
import { gateProofread, portCoherence, buildsServer, gateLocalPorts, extractGateFiles, toolingCoherence, type PortCheckNode } from "../../src/contract/gate-proofread.js";

describe("gateProofread — catch a gate that reads state it never seeds", () => {
  it("FLAGS a SELECT-WHERE with no seed (the crypto_storage halt)", () => {
    const g = `echo 'SELECT api_keys FROM users WHERE email="test3@example.com"' | sqlite3 data/app.db | grep -v -E '^(vouchflow_key_|trustysquire_key_)'`;
    expect(gateProofread(g)).toHaveLength(1);
    expect(gateProofread(g)[0]).toMatch(/never seeds/i);
  });

  it("FLAGS a login as a user nobody registers (the auth_module halt)", () => {
    const g = `curl -s -X POST http://localhost:8000/login -d '{"username":"testuser","password":"testpass"}' | jq -e '.access_token != null'`;
    expect(gateProofread(g)).toHaveLength(1);
    expect(gateProofread(g)[0]).toMatch(/never registers/i);
  });

  it("PASSES a gate that registers THEN logs in (the knight's self-seeding gate)", () => {
    const g = `curl -s http://localhost:3000/api/auth/register -d '{"email":"ui@test.com","password":"uipass"}' && curl -s http://localhost:3000/dashboard -u ui@test.com:uipass | grep -q 'API Keys'`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES a gate that INSERTs before it SELECTs", () => {
    const g = `sqlite3 app.db "INSERT INTO users(email,api_keys) VALUES('a@b.c','enc')" && sqlite3 app.db 'SELECT api_keys FROM users WHERE email="a@b.c"' | grep -qv plaintext`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES a gate that seeds via a build script before reading", () => {
    const g = `VOUCHFLOW_BASE_URL=http://localhost:8001 ./run-bot.sh vouchflow a@b.c pw && curl -s http://localhost:3000/api/keys -u a@b.c:pw | grep -q vouchflow`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES a negative auth test (expects 401, seeds nothing — satisfiable)", () => {
    const g = `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/dashboard | grep -q 401`;
    expect(gateProofread(g)).toEqual([]);
  });

  it("PASSES an unrelated gate (build/grep) and an empty gate", () => {
    expect(gateProofread("npm run build --if-present")).toEqual([]);
    expect(gateProofread("python3 test_crypto.py && grep -q PASS out.txt")).toEqual([]);
    expect(gateProofread("")).toEqual([]);
  });
});

describe("portCoherence — a node whose gate boots a server it doesn't build", () => {
  it("buildsServer / gateLocalPorts recognize a server file and the hit ports", () => {
    expect(buildsServer(["app.js", "views/x.html"])).toBe(true);
    expect(buildsServer(["bot.js", "run-bot.sh"])).toBe(false);
    expect(gateLocalPorts("VOUCHFLOW_BASE_URL=http://localhost:8001 ./run-bot.sh && curl http://localhost:3000/api/keys")).toEqual([3000]);
  });

  const webApp: PortCheckNode = { id: "web-app", deps: ["crypto-storage"], blastRadius: ["app.js", "views/dashboard.html"], gateRun: "node .squire/dom-gate.mjs 'http://localhost:3000' '[]'" };
  const cryptoStorage: PortCheckNode = { id: "crypto-storage", deps: [], blastRadius: ["crypto.js", "storage.js"], gateRun: "python3 test.py" };

  it("ADDS a dep on the server-builder when the bot-module node curls its port (acyclic)", () => {
    const botModule: PortCheckNode = { id: "bot-module", deps: [], blastRadius: ["bot.js", "run-bot.sh"], gateRun: "node .squire/serve-gate.mjs --port 3000 --check 'curl http://localhost:3000/api/keys'" };
    const all = [cryptoStorage, botModule, webApp];
    expect(portCoherence(botModule, all)).toEqual({ kind: "add-dep", dep: "web-app" });
  });

  it("returns null when the node ALREADY depends (transitively) on the server-builder", () => {
    const botModule: PortCheckNode = { id: "bot-module", deps: ["web-app"], blastRadius: ["bot.js"], gateRun: "node .squire/serve-gate.mjs --port 3000 --check 'curl http://localhost:3000/x'" };
    expect(portCoherence(botModule, [cryptoStorage, botModule, webApp])).toBeNull();
  });

  it("returns null for a node that builds its OWN server", () => {
    const api: PortCheckNode = { id: "api", deps: [], blastRadius: ["server.js"], gateRun: "node .squire/serve-gate.mjs --port 8000 --check 'curl http://localhost:8000/x'" };
    expect(portCoherence(api, [api])).toBeNull();
  });

  it("WARNS when depending on the provider would create a cycle", () => {
    const a: PortCheckNode = { id: "a", deps: [], blastRadius: ["client.js"], gateRun: "node .squire/serve-gate.mjs --port 3000 --check 'curl http://localhost:3000/x'" };
    const b: PortCheckNode = { id: "b", deps: ["a"], blastRadius: ["app.js"], gateRun: "node .squire/dom-gate.mjs 'http://localhost:3000' '[]'" };
    const v = portCoherence(a, [a, b]);
    expect(v?.kind).toBe("warn");
    expect((v as { issue: string }).issue).toMatch(/cycle/i);
  });
});

describe("toolingCoherence — equip a node with the files/manifest its gate needs", () => {
  it("extractGateFiles pulls scripts + required modules, skips harness scaffolds", () => {
    expect(extractGateFiles("VOUCHFLOW_BASE_URL=x ./run-bot.sh vouchflow && curl http://localhost:3000/x")).toContain("run-bot.sh");
    expect(extractGateFiles("node -e \"require('./storage'); require('./crypto')\"")).toEqual(expect.arrayContaining(["storage.js", "crypto.js"]));
    expect(extractGateFiles("node .squire/serve-gate.mjs --port 3000 --check 'x'")).toEqual([]); // scaffold excluded
  });

  it("ADDS a missing script the gate runs but no node in scope builds (bot-module ./run-bot.sh)", () => {
    const botModule: PortCheckNode = { id: "bot-module", deps: ["web-app"], blastRadius: ["bot.js", "test/bot.test.js"], gateRun: "node .squire/serve-gate.mjs --port 3000 --check 'VOUCHFLOW_BASE_URL=x ./run-bot.sh vouchflow a b && curl http://localhost:3000/api/keys'" };
    const webApp: PortCheckNode = { id: "web-app", deps: [], blastRadius: ["app.js", "package.json"], gateRun: "node .squire/dom-gate.mjs 'http://localhost:3000' '[]'" };
    expect(toolingCoherence(botModule, [botModule, webApp])).toContain("run-bot.sh");
  });

  it("ADDS package.json when a node runs its own JS but can't install a dep (crypto-storage SQLite trap)", () => {
    const cs: PortCheckNode = { id: "crypto-storage", deps: [], blastRadius: ["crypto.js", "storage.js", "data/.gitkeep"], gateRun: "node -e \"require('./storage').create_user('a','b')\" && sqlite3 data/app.db 'SELECT 1'" };
    expect(toolingCoherence(cs, [cs])).toContain("package.json");
  });

  it("ADDS nothing when the node already builds its files and has a manifest", () => {
    const webApp: PortCheckNode = { id: "web-app", deps: [], blastRadius: ["app.js", "package.json"], gateRun: "node .squire/dom-gate.mjs 'http://localhost:3000' '[]'" };
    expect(toolingCoherence(webApp, [webApp])).toEqual([]);
  });

  it("does NOT re-add a script a DEPENDENCY already builds", () => {
    const integration: PortCheckNode = { id: "integration", deps: ["bot"], blastRadius: ["run-bot.sh", "test/i.test.js"], gateRun: "./run-bot.sh x && node -e \"1\"" };
    const bot: PortCheckNode = { id: "bot", deps: [], blastRadius: ["bot.js"], gateRun: "node -e \"require('./bot')\"" };
    expect(toolingCoherence(integration, [integration, bot])).not.toContain("run-bot.sh");
  });
});
