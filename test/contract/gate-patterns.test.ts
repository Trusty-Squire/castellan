import { describe, it, expect } from "vitest";
import { GATE_PATTERNS, renderGate, getPattern } from "../../src/contract/gate-patterns.js";
import { GateSchema } from "../../src/contract/schema.js";
import { SquireError } from "../../src/errors.js";

describe("gate-pattern library", () => {
  it("every pattern documents the failure it was born from", () => {
    for (const p of GATE_PATTERNS) {
      expect(p.bornFrom.length, p.id).toBeGreaterThan(10);
      expect(p.description.length, p.id).toBeGreaterThan(10);
    }
  });

  it("tests-pass composes diff-guards", () => {
    const g = renderGate("tests-pass", {
      testCmd: "pnpm vitest run test/x.test.ts",
      guardPaths: ["test/x.test.ts", "src/frozen.ts"],
    });
    expect(g.run).toBe(
      "pnpm vitest run test/x.test.ts && git diff --quiet HEAD -- test/x.test.ts && git diff --quiet HEAD -- src/frozen.ts",
    );
  });

  it("fail-for-the-right-reason demands the missing-impl signature and rejects fixture crashes", () => {
    const g = renderGate("fail-for-the-right-reason", {
      testFile: "test/cart.test.ts",
      testCmd: "pnpm vitest run test/cart.test.ts",
      mustMatch: "Failed to load url",
    });
    expect(g.run).toContain("! pnpm vitest run test/cart.test.ts");
    expect(g.run).toContain("grep -q 'Failed to load url'");
    expect(g.run).toContain("! grep -q ENOENT");
  });

  it("varied-input refuses a single assertion (hardcodeable)", () => {
    expect(() => renderGate("varied-input", { exprs: ["f(1)===2"] })).toThrow(/>=2/);
    const g = renderGate("varied-input", { exprs: ["f(1)===2", "f(3)===6"] });
    expect(g.run).toContain("f(1)===2");
    expect(g.run).toContain("f(3)===6");
  });

  it("completeness-grep renders a negative grep over the scope", () => {
    const g = renderGate("completeness-grep", {
      grepPattern: "emit\\(['\"]",
      scope: "src/wire",
      behaviorCmd: "node --test test/api.test.js",
    });
    expect(g.run).toContain("node --test test/api.test.js && ! grep -rEn ");
    expect(g.run).toContain(" src/wire");
    expect(g.run!.startsWith("node --test")).toBe(true);
  });

  it("output-content-smoke asserts on content, not exit codes", () => {
    const g = renderGate("output-content-smoke", {
      runCmd: "node dist/cli.js validate m.yaml",
      mustMatch: "0 error(s), 0 warning(s)",
      mustNotMatch: "Failed to evaluate",
    });
    expect(g.run).toContain("grep -q '0 error(s), 0 warning(s)'");
    expect(g.run).toContain("! (node dist/cli.js validate m.yaml | grep -q 'Failed to evaluate')");
  });

  it("human-adjudication renders a tier-4 gate object, not a command", () => {
    const g = renderGate("human-adjudication", { artifact: "renders/grid.png" });
    expect(g).toEqual({ type: "human", artifact: "renders/grid.png", soft: false });
  });

  it("every rendered gate validates against GateSchema", () => {
    const samples: [string, Record<string, string | string[]>][] = [
      ["tests-pass", { testCmd: "true" }],
      ["fail-for-the-right-reason", { testFile: "t", testCmd: "true", mustMatch: "x" }],
      ["varied-input", { exprs: ["1===1", "2===2"] }],
      ["mutation-guard", { module: "m.js", mutant: "checks/m.mutant.js", testCmd: "true", grepToken: "f", testFile: "t" }],
      ["completeness-grep", { grepPattern: "old", scope: "src" }],
      ["compile-gate", { scope: "src" }],
      ["output-content-smoke", { runCmd: "true", mustMatch: "ok" }],
      ["perf-threshold", { benchCmd: "node bench.js" }],
      ["metric-threshold", { metricCmd: "python eval.py --threshold 35" }],
      ["human-adjudication", { artifact: "a.png" }],
      ["dom-behavior", { url: "http://localhost:3000", steps: '[{"assert":"#pot","exists":true}]' }],
      ["slop-audit", { scope: "dist" }],
    ];
    for (const [id, params] of samples) {
      expect(() => GateSchema.parse(renderGate(id, params)), id).not.toThrow();
    }
    expect(samples.map(([id]) => id).sort()).toEqual(GATE_PATTERNS.map((p) => p.id).sort());
  });

  it("unknown patterns and missing params throw typed errors", () => {
    expect(() => getPattern("nope")).toThrow(SquireError);
    expect(() => renderGate("tests-pass", {})).toThrow(/missing required param/);
  });
});

import { stripSelfBootForServeGate, serverGatePort, gateBehaviorCount } from "../../src/contract/gate-patterns.js";

describe("stripSelfBootForServeGate — let the harness own the boot", () => {
  it("drops npm install/start, sleep, PID bookkeeping and kill; keeps the curl checks", () => {
    const run =
      "npm install --save-exact express qrcode && npm start & SERVER_PID=$! && sleep 3 && " +
      "curl -fsS http://localhost:3000/api/shorten | grep -q shortCode && " +
      "SHORT=$(curl -fsS http://localhost:3000/api/shorten | grep -o code) && " +
      "curl -fsS http://localhost:3000/$SHORT && kill $SERVER_PID";
    const stripped = stripSelfBootForServeGate(run);
    expect(stripped).not.toMatch(/npm (install|start)/);
    expect(stripped).not.toMatch(/sleep|SERVER_PID|kill/);
    expect(stripped).toContain("curl -fsS http://localhost:3000/api/shorten");
    expect(stripped).toContain("SHORT=$(curl"); // the capture survives
    // now the port is visible to serverGatePort (the lone `&` no longer masks it)
    expect(serverGatePort(stripped)).toBe(3000);
  });
  it("is a no-op on a pure curl chain", () => {
    const run = "curl -fsS http://localhost:3000/ | grep -q ok && curl -fsS http://localhost:3000/api | grep -q ok";
    expect(stripSelfBootForServeGate(run)).toBe(run);
  });
});

import { importsServerModule } from "../../src/contract/gate-proofread.js";

describe("importsServerModule — detect an incoherent import-based server gate", () => {
  it("flags supertest / require / node -e imports of the server", () => {
    expect(importsServerModule("node -e \"const app = require('./server.js'); const r = require('supertest')(app)\"")).toBe(true);
    expect(importsServerModule("npx vitest run test_server.js && require('./server')")).toBe(true);
  });
  it("passes a live curl gate (and a self-boot curl gate)", () => {
    expect(importsServerModule("curl -fsS http://localhost:3000/api | grep -q ok")).toBe(false);
    expect(importsServerModule("npm start & sleep 3 && curl -fsS http://localhost:3000/ | grep -q ok")).toBe(false);
  });
});

describe("stripSelfBootForServeGate — semicolon-separated boot (the variant that slipped)", () => {
  it("strips `npm start & PID; sleep N;` glued to the first curl by semicolons", () => {
    const run =
      "npm start & SERVER_PID=$!; sleep 2; curl -fsS -X POST http://localhost:3000/api/shorten -d '{}' | grep -q code && " +
      "curl -fsS http://localhost:3000/api/links | grep -q '[' ; kill $SERVER_PID";
    const stripped = stripSelfBootForServeGate(run);
    expect(stripped).not.toMatch(/npm start|sleep|SERVER_PID|kill/);
    expect(stripped.startsWith("curl")).toBe(true);
    expect(serverGatePort(stripped)).toBe(3000);
  });
});

describe("gateBehaviorCount — a deterministic over-size proxy", () => {
  it("counts curls for a serve gate, asserts for a DOM gate, segments otherwise", () => {
    expect(gateBehaviorCount("curl a && curl b && curl c")).toBe(3);
    expect(gateBehaviorCount('[{"assert":"x"},{"assert":"y"}]')).toBe(2);
    expect(gateBehaviorCount("test1 && test2")).toBe(2);
  });
  it("flags a 13-check monolith server gate as over-sized (>10)", () => {
    const checks = Array.from({ length: 13 }, (_, i) => `curl -fsS http://localhost:3000/api/${i} | grep -q ok`).join(" && ");
    expect(gateBehaviorCount(checks)).toBeGreaterThan(10);
  });
});
