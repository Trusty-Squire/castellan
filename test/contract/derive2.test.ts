import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveV2,
  specPreGate,
  affirmsBuildability,
  groundGateRun,
  tractableGateRun,
  stripCaseFilters,
  wrapTestsWithTimeout,
  canonicalizeTestGate,
  bootstrapGreenfieldNodeGate,
  trimSurveyForDecompose,
  gateClusterHints,
  buildDirectMission,
  nodeRequirementIds,
  allocateNodeBudgets,
  overflowingNodes,
  decompositionIssues,
  deriveUiGate,
  functionalUiGate,
  extractDomHooks,
  looksLikeUi,
} from "../../src/contract/derive2.js";
import { parseSpec } from "../../src/contract/spec.js";
import { MockLlm } from "../../src/llm/mock.js";
import { SquireError } from "../../src/errors.js";
import { gateBehaviorCount } from "../../src/contract/gate-patterns.js";

let workdir: string;
beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "derive2-"));
  mkdirSync(join(workdir, "src"), { recursive: true });
  writeFileSync(join(workdir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
});

const decomposeOut = JSON.stringify({
  nodes: [
    { id: "impl", brief: "implement the parser", deps: [], context_globs: ["src/**"], blast_radius: ["src/**"], budget_usd: 0.5 },
    { id: "tests", brief: "write parser tests", deps: ["impl"], context_globs: ["src/**", "test/**"], blast_radius: ["test/**"], budget_usd: 0.5 },
  ],
});
const gatesOut = JSON.stringify({
  gates: [
    { node: "impl", pattern: "varied-input", params: { exprs: ["p('1h')===3600", "p('2m')===120"] } },
    { node: "tests", pattern: "tests-pass", params: { testCmd: "npm run test", guardPaths: ["src/parser.ts"] } },
  ],
});
const claimsOut = JSON.stringify({
  claims: [
    { id: "C1", statement: "durations parse in linear time", loadBearing: true, about: "impl" },
    { id: "C2", statement: "naming is nice", loadBearing: false, about: "tests" },
  ],
});
const lensOk = JSON.stringify({ refuted: false, evidence: "" });

function base(llm: MockLlm) {
  return { goal: "build a duration parser", workdir, llm, model: "qwen/qwen3-coder", chainName: "cheap", budgetUsd: 1.0 };
}

class HangingLlm extends MockLlm {
  constructor() {
    super([]);
  }

  override async complete(): Promise<{ text: string; inTokens: number; outTokens: number }> {
    return new Promise(() => undefined);
  }
}

describe("deriveV2 — herald pipeline (SPEC-v0.2 §6)", () => {
  it("happy path: decompose → pattern gates → claims survive → compiled mission + readback", async () => {
    const llm = new MockLlm([
      { text: decomposeOut },
      { text: gatesOut },
      { text: claimsOut },
      { text: lensOk }, // C1 feasibility
      { text: lensOk }, // C1 prior-art
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes).toHaveLength(2);
    expect(r.mission.nodes[0]!.gate!.run).toContain("p('1h')===3600");
    expect(r.mission.nodes[1]!.gate!.run).toContain("git diff --quiet HEAD -- src/parser.ts");
    expect(r.freeformGates).toHaveLength(0);
    expect(r.readback).toContain("survived 2/2 lenses");
    // only the load-bearing claim got lenses: 5 calls total
    expect(llm.calls).toHaveLength(5);
    // no provider-reported cost in this script → estimation territory
    expect(r.costUsd).toBeUndefined();
  });

  it("spec-mode falls back to a direct mission when model decomposition fails", async () => {
    const spec = parseSpec(`
thesis: Build a local notes tool
stories:
  - I can create and search notes
scope_fence: []
requirements:
  - id: R1
    statement: Notes can be created and searched locally
    acceptance:
      tier: 1
      gate: npm test
decisions: []
claims: []
open_questions: []
`);
    const llm = new MockLlm([
      { text: "not json" },
      { text: "still not json" },
    ]);

    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes).toHaveLength(1);
    expect(r.mission.nodes[0]!.id).toBe("fallback1");
    expect(r.mission.nodes[0]!.gate!.run).toContain("npm test");
    expect(r.mission.nodes[0]!.brief).toContain("Recovery may simplify the node shape");
    expect(r.mission.nodes[0]!.brief).toContain("Thesis: Build a local notes tool");
    expect(r.readback).toContain("fallback planner");
  });

  it("refuses fallback when recovery would preserve only a vacuous oracle", async () => {
    const spec = parseSpec(`
thesis: Build a Telegram bot that replies to incoming messages with contextual flirt coaching
stories:
  - I can send the bot a message and receive a context-aware reply through Telegram
scope_fence: []
requirements:
  - id: R1
    statement: The Telegram bot handles incoming messages and returns contextual replies
    acceptance:
      tier: 1
      gate: "true"
decisions: []
claims: []
open_questions: []
`);
    const llm = new MockLlm([
      { text: "not json" },
      { text: "still not json" },
    ]);

    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons[0]).toContain("fallback would weaken requirement R1");
    expect(r.reasons[0]).toContain("vacuous");
  });

  it("spec-mode falls back to a direct mission when model decomposition times out", async () => {
    const spec = parseSpec(`
thesis: Local notes
scope_fence: []
requirements:
  - id: R1
    statement: Notes can be created and searched locally
    acceptance:
      tier: 1
      gate: npm test
decisions: []
claims: []
open_questions: []
`);
    const prev = process.env.SER_PLANNER_TIMEOUT_MS;
    process.env.SER_PLANNER_TIMEOUT_MS = "5";
    try {
      const llm = new HangingLlm();
      const r = await deriveV2({ ...base(llm), goal: undefined, spec });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.mission.nodes[0]!.id).toBe("fallback1");
      expect(r.readback).toContain('stage "decompose" timed out');
    } finally {
      if (prev === undefined) delete process.env.SER_PLANNER_TIMEOUT_MS;
      else process.env.SER_PLANNER_TIMEOUT_MS = prev;
    }
  });

  it("accepts decompose list fields emitted as comma-separated strings", async () => {
    const spec = parseSpec(`
thesis: Local notes
scope_fence: []
requirements:
  - id: R1
    statement: Notes can be created and searched locally
    acceptance:
      tier: 1
      gate: npm test
decisions: []
claims: []
open_questions: []
`);
    const decompose = JSON.stringify({
      contract: "type Note = { id: string, title: string }",
      nodes: [
        {
          id: "server",
          brief: "build the notes server",
          deps: "",
          context_globs: "",
          blast_radius: "server.js, package.json, data/notes.json",
          budget_usd: 0.8,
          requirement: "R1",
        },
      ],
    });
    const llm = new MockLlm([
      { text: decompose },
      { text: JSON.stringify({ claims: [] }) },
    ]);

    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readback).not.toContain("fallback planner");
    expect(r.mission.nodes[0]!.id).toBe("server");
    expect(r.mission.nodes[0]!.blast_radius).toEqual(["server.js", "package.json", "data/notes.json"]);
    expect(r.mission.nodes[0]!.context_globs).toEqual([]);
    expect(r.mission.nodes[0]!.deps).toEqual([]);
  });

  it("adds contract-named runtime stores to blast radius before execution", async () => {
    const spec = parseSpec(`
thesis: Build a tiny local notes CLI
scope_fence: []
requirements:
  - id: R1
    statement: Notes can be added and listed from local storage
    acceptance:
      tier: 1
      gate: node notes.js add "hello" && node notes.js list | grep -q hello
decisions: []
claims: []
open_questions: []
`);
    const decompose = JSON.stringify({
      contract: "Storage file: 'notes.json' in CWD. CLI: node notes.js add/list.",
      nodes: [
        {
          id: "cli",
          brief: "Create notes.js implementing add/list.",
          deps: [],
          context_globs: [],
          blast_radius: ["notes.js", "package.json"],
          budget_usd: 1,
          requirement: "R1",
        },
      ],
    });
    const llm = new MockLlm([
      { text: decompose },
      { text: JSON.stringify({ claims: [] }) },
    ]);

    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes[0]!.blast_radius).toEqual(expect.arrayContaining(["notes.js", "notes.json"]));
  });

  it("compiles the captured Kimi notes decomposition instead of falling back", async () => {
    const spec = parseSpec(`
thesis: build a small local notes tool with tags, browser persistence, and a visible test result
scope_fence: []
requirements:
  - id: R1
    statement: "Implement the smallest useful version of: build a small local notes tool with tags, browser persistence, and a visible test result"
    acceptance:
      tier: 1
      gate: npm test -- --runInBand
  - id: R2
    statement: "The app renders a usable product UI in index.html, seeded with realistic sample content on first load."
    acceptance:
      tier: 1
      gate: npm run build --if-present
decisions: []
claims: []
open_questions: []
`);
    const decompose = JSON.stringify({
      contract: "type Note = { id: string, title: string }",
      nodes: [
        {
          id: "server",
          brief: "Create Express server and CRUD API for notes.",
          deps: [],
          context_globs: [],
          blast_radius: "server.js, package.json, data/notes.json",
          budget_usd: 0.8,
          requirement: "R1",
        },
        {
          id: "frontend",
          brief: "Build phone-friendly UI in public/ with tag filtering and search.",
          deps: ["server"],
          context_globs: ["server.js"],
          blast_radius: "public/index.html, public/style.css, public/app.js",
          budget_usd: 1.2,
          requirement: "R1, R2",
        },
        {
          id: "tests",
          brief: "Add API and UI tests for create, delete, filter, and search.",
          deps: ["server", "frontend"],
          context_globs: ["server.js", "public/*"],
          blast_radius: "test/api.test.js, test/ui.spec.ts, package.json",
          budget_usd: 0.5,
          requirement: "R1",
        },
      ],
    });
    const llm = new MockLlm([
      { text: "web-app" },
      { text: decompose },
      { text: JSON.stringify({ claims: [] }) },
    ]);

    const r = await deriveV2({ ...base(llm), goal: undefined, spec, scaffoldServers: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.readback).not.toContain("fallback planner");
    expect(r.mission.nodes.map((n) => n.id)).toEqual(["server", "frontend", "tests"]);
    expect(r.mission.nodes[0]!.blast_radius).toEqual(["server.js", "package.json", "data/notes.json"]);
    expect(r.mission.nodes[1]!.blast_radius).toEqual(["public/index.html", "public/style.css", "public/app.js"]);
  });

  it("seeds server plumbing for a greenfield serve-gate node (scaffoldServers) and wires the node", async () => {
    const decompose = JSON.stringify({
      contract: "GET/POST /api/items over an HTTP server on :8090",
      nodes: [
        { id: "api", brief: "build the items HTTP API", deps: [], context_globs: [], blast_radius: ["server.js", "data/**"], budget_usd: 1.0 },
      ],
    });
    // a freeform localhost-curl gate → serverGatePort detects :8090 → wrapWithServeGate → a server node
    const gates = JSON.stringify({ gates: [{ node: "api", freeform: "curl -fsS http://localhost:8090/api/items | grep -q ok" }] });
    // scaffoldServers → the archetype classifier runs FIRST (web-app), then decompose/gates/claims
    const llm = new MockLlm([{ text: "web-app" }, { text: decompose }, { text: gates }, { text: JSON.stringify({ claims: [] }) }]);
    const r = await deriveV2({ ...base(llm), goal: "an items HTTP API", scaffoldServers: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = r.mission.nodes[0]!;
    // a web app steers the decompose to the scaffold-supported stack
    expect(llm.calls[1]!.system).toContain("Node.js + Express");
    // the gate author (call 2, after classify+decompose) SEES the shared contract — so its gates
    // use the contract's exact field names instead of inventing incoherent ones (the 400-on-url bug)
    expect(llm.calls[2]!.user).toContain("SHARED CONTRACT");
    expect(llm.calls[2]!.user).toContain("/api/items");
    // the gate boots the server; the harness seeded a runnable skeleton the model only fills
    expect(node.gate!.run).toContain("serve-gate.mjs --port 8090");
    expect(readFileSync(join(workdir, "server.js"), "utf8")).toContain("app.listen(PORT");
    expect(existsSync(join(workdir, "server.js"))).toBe(true);
    // node is wired to fill (not improvise) the server: brief note + radius covers the seeded files
    expect(node.brief).toContain("ADD ONLY YOUR ROUTE HANDLERS");
    expect(node.blast_radius).toContain("package.json");
    expect(node.context_globs).toContain("server.js");
    // the UI palette is vendored for web apps
    expect(existsSync(join(workdir, "public", "theme.css"))).toBe(true);
    expect(r.readback).toContain("seeded server plumbing");
  });

  it("does NOT seed when scaffoldServers is off (judge/dry-run callers only inspect)", async () => {
    const decompose = JSON.stringify({
      contract: "HTTP server on :8090",
      nodes: [{ id: "api", brief: "build the API", deps: [], context_globs: [], blast_radius: ["server.js"], budget_usd: 1.0 }],
    });
    const gates = JSON.stringify({ gates: [{ node: "api", freeform: "curl -fsS http://localhost:8090/ | grep -q ok" }] });
    const llm = new MockLlm([{ text: decompose }, { text: gates }, { text: JSON.stringify({ claims: [] }) }]);
    const r = await deriveV2({ ...base(llm), goal: "an API" }); // scaffoldServers omitted
    expect(r.ok).toBe(true);
    expect(existsSync(join(workdir, "server.js"))).toBe(false);
  });

  it("trimSurveyForDecompose caps an oversized survey, passes a small one through (domain-agnostic)", () => {
    const small = "FILES (0):\nDETECTED CHECK COMMANDS:\n  npm run test\n";
    expect(trimSurveyForDecompose(small)).toBe(small); // under the cap → untouched, no app-type heuristic
    const big = "x".repeat(5000);
    expect(trimSurveyForDecompose(big).length).toBe(4000); // size cap only
  });

  it("repairs infer-gates when a selected pattern has invalid params", async () => {
    const decompose = JSON.stringify({
      nodes: [
        { id: "reading", brief: "build the tarot reading flow", deps: [], context_globs: [], blast_radius: ["index.html", "app.js"], budget_usd: 1.0 },
      ],
    });
    const badGates = JSON.stringify({
      gates: [
        { node: "reading", pattern: "output-content-smoke", params: { runCmd: "node app.js", mustMatch: "" } },
      ],
    });
    const fixedGates = JSON.stringify({
      gates: [
        { node: "reading", pattern: "output-content-smoke", params: { runCmd: "node app.js", mustMatch: "fortune" } },
      ],
    });
    const llm = new MockLlm([
      { text: decompose },
      { text: badGates },
      { text: fixedGates },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const r = await deriveV2({
      ...base(llm),
      goal: "a mystical fortune app that reads tarot cards and tea leaves",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes[0]!.gate!.run).toContain("fortune");
    expect(llm.calls[2]!.user).toContain("could not be rendered");
    expect(llm.calls[2]!.user).toContain("pattern param");
  });

  it("retries decomposition when spec-mode leaves requirement ids uncovered", async () => {
    const spec = parseSpec(`
thesis: parser library
stories:
  - developer parses tarot and tea tokens
requirements:
  - id: R1
    statement: tarot flow
    acceptance: { tier: 1, gate: "true" }
  - id: R2
    statement: tea flow
    acceptance: { tier: 1, gate: "true" }
`);
    const first = JSON.stringify({
      nodes: [
        { id: "fortune", brief: "build the shared fortune experience", deps: [], context_globs: [], blast_radius: ["src/**"], budget_usd: 1, requirement: "R1" },
      ],
    });
    const second = JSON.stringify({
      nodes: [
        { id: "tarot", brief: "build the tarot flow", deps: [], context_globs: [], blast_radius: ["src/**"], budget_usd: 0.5, requirement: "R1" },
        { id: "tea", brief: "build the tea flow", deps: ["tarot"], context_globs: [], blast_radius: ["src/**"], budget_usd: 0.5, requirement: "R2" },
      ],
    });
    const llm = new MockLlm([
      { text: first },
      { text: second },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const r = await deriveV2({
      ...base(llm),
      goal: undefined,
      spec,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes.map((n) => n.id)).toEqual(["tarot", "tea"]);
    expect(llm.calls[1]!.user).toContain("left these requirement ids uncovered");
    expect(llm.calls[1]!.user).toContain("R2");
  });

  it("builds a focused direct mission from raised delta items without LLM planning", () => {
    const mission = buildDirectMission({
      thesis: "mystical fortune app",
      items: [
        { statement: "The first viewport must show Gypsy, Tarot, Tea Leaves, and a concise fortune preview." },
        { statement: "Completed readings must render a compact result summary before the prose interpretation.", acceptance: { tier: 1, gate: "npm test -- --run" } },
      ],
      chainName: "cheap",
      budgetUsd: 2.5,
      idPrefix: "d",
    });
    expect(mission.nodes.map((n) => n.id)).toEqual(["d1", "d2"]);
    expect(mission.nodes[1]!.deps).toEqual(["d1"]);
    // a delta item without an explicit gate falls back to a generic bootstrapped
    // npm test gate — no per-demo grep heuristics
    expect(mission.nodes[0]!.gate!.run).toContain("npm install --no-fund --no-audit");
    expect(mission.nodes[0]!.gate!.run).toMatch(/&& npm test'$/);
    expect(mission.nodes[0]!.gate!.run).not.toContain("--run");
    expect(mission.nodes[0]!.gate!.run).not.toContain("headline-value");
    expect(mission.nodes[1]!.gate).toMatchObject({ type: "command", run: expect.stringContaining("npm install --no-fund --no-audit") });
  });

  it("sums provider-reported cost across stages into result.costUsd (A36)", async () => {
    const llm = new MockLlm([
      { text: decomposeOut, costUsd: 0.001 },
      { text: gatesOut, costUsd: 0.002 },
      { text: claimsOut, costUsd: 0.003 },
      { text: lensOk, costUsd: 0.004 }, // C1 feasibility
      { text: lensOk, costUsd: 0.005 }, // C1 prior-art
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costUsd).toBeCloseTo(0.015, 10);
  });

  it("reports cost even when only some stages report it (partial)", async () => {
    const llm = new MockLlm([
      { text: decomposeOut, costUsd: 0.001 },
      { text: gatesOut }, // no cost reported
      { text: claimsOut, costUsd: 0.003 },
      { text: lensOk },
      { text: lensOk },
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.costUsd).toBeCloseTo(0.004, 10);
  });

  it("prepends the shared decompose contract to every brief so nodes build compatible pieces", async () => {
    const withContract = JSON.stringify({
      contract: "type NormalizedLine = { event: string; market: string; selection: string; decimalOdds: number; ts: number }; module odds.ts exports normalizeFeed(raw): NormalizedLine[]",
      nodes: [
        { id: "impl", brief: "implement the parser", deps: [], context_globs: ["src/**"], blast_radius: ["src/**"], budget_usd: 0.5 },
        { id: "tests", brief: "write parser tests", deps: ["impl"], context_globs: ["src/**", "test/**"], blast_radius: ["test/**"], budget_usd: 0.5 },
      ],
    });
    const llm = new MockLlm([{ text: withContract }, { text: gatesOut }, { text: claimsOut }, { text: lensOk }, { text: lensOk }]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes.every((n) => n.brief.includes("SHARED CONTRACT"))).toBe(true);
    expect(r.mission.nodes.every((n) => n.brief.includes("type NormalizedLine"))).toBe(true);
    // the node's own brief still follows the contract block
    expect(r.mission.nodes[0]!.brief).toContain("implement the parser");
  });

  it("a refuted claim with NO buildable remedy (impossible in principle) still halts — the poker path", async () => {
    const llm = new MockLlm([
      { text: decomposeOut },
      { text: gatesOut },
      { text: JSON.stringify({ claims: [{ id: "C1", statement: "full-game CFR for NLHE is tractable on a laptop", loadBearing: true, about: "solver" }] }) },
      { text: JSON.stringify({ refuted: true, evidence: "10^160 game states x 1ns/state >> age of the universe; real solvers (PioSOLVER, Pluribus) use abstraction + subgame solving" }) },
      { text: lensOk },
      // remedy stage: impossible in principle, no constraint resolves it → honest halt
      { text: JSON.stringify({ remedies: [{ claim: "full-game CFR for NLHE is tractable on a laptop", remediable: false, constraint: "" }] }) },
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons[0]).toContain("no buildable remedy");
    expect(r.reasons[0]).toContain("CFR");
    expect(r.reasons[0]).toContain("PioSOLVER");
  });

  it("a refuted claim WITH a buildable remedy folds a constraint into every brief and proceeds (don't stop at a failed state)", async () => {
    const llm = new MockLlm([
      { text: decomposeOut },
      { text: gatesOut },
      { text: JSON.stringify({ claims: [{ id: "C1", statement: "cent-rounded stake splits preserve guaranteed profit for all valid arbs", loadBearing: true, about: "stake" }] }) },
      { text: JSON.stringify({ refuted: true, evidence: "sub-cent margins lose to rounding; $0.50/$0.50 on 1.99/2.02 pays $0.995 < $1" }) },
      { text: lensOk },
      // remedy stage: infeasible as stated, but buildable with an obvious constraint
      { text: JSON.stringify({ remedies: [{ claim: "cent-rounded stake splits preserve guaranteed profit for all valid arbs", remediable: true, constraint: "Only surface opportunities whose margin exceeds the cent-rounding error so rounded stakes keep a non-negative profit." }] }) },
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the remedy is folded into every node brief, so the executor implements it
    expect(r.mission.nodes.every((n) => n.brief.includes("BUILD CONSTRAINTS"))).toBe(true);
    expect(r.mission.nodes[0]!.brief).toContain("margin exceeds the cent-rounding error");
    expect(r.readback).toContain("folded a build constraint instead of halting");
  });

  it("evidence-free refutations are DISCARDED (refuters are accountable too)", async () => {
    const llm = new MockLlm([
      { text: decomposeOut },
      { text: gatesOut },
      { text: claimsOut },
      { text: JSON.stringify({ refuted: true, evidence: "" }) }, // lazy refuter
      { text: lensOk },
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c1 = r.claims.find((c) => c.id === "C1")!;
    expect(c1.lenses[0]!.discarded).toBe(true);
    expect(c1.refuted).toBe(false);
  });

  it("a refutation whose evidence AFFIRMS buildability is DISCARDED (polarity reversal — the clairvoyance bug)", async () => {
    // The exact failure mode: refuted:true with evidence that says it's buildable.
    const reversed = JSON.stringify({
      refuted: true,
      evidence:
        "Prior art demonstrates this is buildable. Blackbird and Hummingbot compute cross-exchange arbitrage and only emit profitable opportunities, matching the claim's acceptance gate logic — a practical build path rather than an infeasible requirement.",
    });
    const llm = new MockLlm([
      { text: decomposeOut },
      { text: gatesOut },
      { text: claimsOut },
      { text: reversed }, // C1 feasibility lens: backwards
      { text: lensOk }, // C1 prior-art lens: clean
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true); // the build is NOT blocked by a backwards refutation
    if (!r.ok) return;
    const c1 = r.claims.find((c) => c.id === "C1")!;
    expect(c1.lenses[0]!.discarded).toBe(true);
    expect(c1.refuted).toBe(false);
  });

  it("groundGateRun rewrites bare python/pip to python3/pip3, leaving others intact", () => {
    expect(groundGateRun("python - <<'PY'\nprint(1)\nPY")).toContain("python3 - <<'PY'");
    expect(groundGateRun("pip install x")).toBe("pip3 install x");
    expect(groundGateRun("python3 -m pytest")).toBe("python3 -m pytest"); // already grounded
    expect(groundGateRun("pytest -q && rg foo")).toBe("python3 -m pytest -q && rg foo");
    expect(groundGateRun("test -f x && pytest -q tests/test_x.py")).toBe("test -f x && python3 -m pytest -q tests/test_x.py");
    expect(groundGateRun("./mypython.sh")).toBe("./mypython.sh"); // substring untouched
  });

  it("tractableGateRun downgrades a project-wide e2e SUITE, but lets a single playwright spec through", () => {
    // project-wide suites / cypress stay intractable per node → build floor
    for (const e2e of ["npm run test:e2e -- tests/e2e/x.spec.ts", "npm run e2e", "cypress run"]) {
      const out = tractableGateRun(e2e);
      expect(out).toContain("npm run build --if-present");
      expect(out).not.toMatch(/cypress|test:e2e/i);
    }
    // a SINGLE-FILE playwright behavioral spec is now the deterministic UI gate we WANT — survives
    expect(tractableGateRun("npx playwright test tests/raise.spec.ts")).toBe("npx playwright test tests/raise.spec.ts");
    // non-test gates pass through unchanged (just grounded) — no general bootstrap
    expect(tractableGateRun("grep -q data-edge index.html")).toBe("grep -q data-edge index.html");
    expect(tractableGateRun("npm test -- foo")).toBe("npm test"); // pure test gate → whole vitest suite
    expect(tractableGateRun("python -m pytest tests/x.py")).toContain("python3 -m pytest"); // still grounds tools
  });

  it("stripCaseFilters drops hallucinated/fragile named-case filters so the gate runs the test file", () => {
    // the observed halt: `--case` is no runner's flag → exits non-zero before any test runs
    expect(stripCaseFilters("npm test -- --run tests/odds.test.ts --case='normalizes two books'")).toBe(
      "npm test -- --run tests/odds.test.ts",
    );
    // long-form variants + value forms (=quoted, =bare, space-quoted)
    expect(stripCaseFilters("vitest run x.test.ts --grep='ranks by size'")).toBe("vitest run x.test.ts");
    expect(stripCaseFilters("npm test -- --testNamePattern 'edge cases'")).toBe("npm test --");
    expect(stripCaseFilters("npm test -- --name=foo")).toBe("npm test --");
    // grounding applies it end-to-end (spec-authored gates flow through groundGateRun)
    expect(groundGateRun("npm test -- --run a.test.ts --case='x'")).toBe("npm test -- --run a.test.ts");
    // single-char flags left alone — too collision-prone (this is a typecheck, not a filter)
    expect(stripCaseFilters("tsc -t es2020 --noEmit")).toBe("tsc -t es2020 --noEmit");
    expect(stripCaseFilters("grep -q data-edge index.html")).toBe("grep -q data-edge index.html");
  });

  it("canonicalizeTestGate runs the whole vitest suite for pure test gates (robust to jest flags / pinned filenames), keeping compound gates", () => {
    // jest idiom vitest rejects (CACError) + a pinned filename the cheap model renamed
    expect(canonicalizeTestGate("test -f tests/x.test.js && npm test -- --runTestsByPath tests/x.test.js")).toBe("npm test");
    expect(canonicalizeTestGate("npm test -- --runInBand")).toBe("npm test");
    expect(canonicalizeTestGate("npm test -- --run tests/arbitrage-engine.test.ts")).toBe("npm test");
    expect(canonicalizeTestGate("npx vitest run tests/foo.test.ts")).toBe("npm test");
    // applied end-to-end through tractableGateRun
    expect(tractableGateRun("npm test -- --runTestsByPath tests/x.test.js")).toBe("npm test");
    // compound gates keep their non-test payload (UI build+grep checks, plain grep)
    expect(canonicalizeTestGate("npm run build --if-present && grep -q data-edge index.html")).toContain("grep -q data-edge");
    expect(canonicalizeTestGate("grep -q data-edge index.html")).toBe("grep -q data-edge index.html");
  });

  it("decompositionIssues rejects oversized nodes and tiny sibling sprawl while keeping cohesive plans", () => {
    const oversized = decompositionIssues(
      [{ id: "cli", blast_radius: ["cli.js"], deps: [] }],
      new Map([
        [
          "cli",
          {
            type: "command",
            soft: false,
            run: [
              "node cli.js a",
              "node cli.js b",
              "node cli.js c",
              "node cli.js d",
              "node cli.js e",
              "node cli.js f",
              "node cli.js g",
              "node cli.js h",
              "node cli.js i",
              "node cli.js j",
              "node cli.js k",
            ].join(" && "),
          },
        ],
      ]),
    );
    expect(oversized.map((i) => i.kind)).toContain("too_large");

    const tinyNodes = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, blast_radius: [`src/a${i}.js`], deps: [] }));
    const tinyGates = new Map(tinyNodes.map((n) => [n.id, { type: "command" as const, soft: false, run: `node ${n.blast_radius[0]}` }]));
    expect(decompositionIssues(tinyNodes, tinyGates).map((i) => i.kind)).toContain("too_small");

    expect(
      decompositionIssues(
        [
          { id: "core", blast_radius: ["src/core.js", "test/core.test.js"], deps: [] },
          { id: "cli", blast_radius: ["bin/cli.js", "test/cli.test.js"], deps: ["core"] },
        ],
        new Map([
          ["core", { type: "command", soft: false, run: "npm test && node test/core.test.js && node test/edge.test.js" }],
          ["cli", { type: "command", soft: false, run: "node bin/cli.js sample.csv && node bin/cli.js --help" }],
        ]),
      ),
    ).toEqual([]);
  });

  it("gateClusterHints groups oversized gates into useful repair seams", () => {
    const hints = gateClusterHints(
      [
        "python3 csv.py rows.csv | grep -q '3 rows'",
        "python3 csv.py cols.csv | grep -q 'name'",
        "python3 csv.py nums.csv | grep -q 'min'",
        "python3 csv.py nums.csv | grep -q 'max'",
        "python3 csv.py nums.csv | grep -q 'avg'",
        "python3 csv.py missing.csv 2>&1 | grep -qi 'not found'",
        "python3 csv.py empty.csv 2>&1 | grep -qi 'empty'",
        "python3 csv.py quoted.csv | grep -q 'Smith, John'",
        "cat data.csv | python3 csv.py --stdin | grep -q rows",
        "python3 csv.py types.csv | grep -q numeric",
        "python3 csv.py bad.csv 2>&1 | grep -qi invalid",
      ].join(" && "),
      4,
    );
    expect(hints.some((h) => h.startsWith("shape-summary"))).toBe(true);
    expect(hints.some((h) => h.startsWith("numeric-stats"))).toBe(true);
    expect(hints.some((h) => h.startsWith("errors"))).toBe(true);
    expect(hints.every((h) => !/^case\d+/.test(h))).toBe(true);
  });

  it("repairs oversized decomposition once before emitting a mission", async () => {
    const spec = parseSpec(`
thesis: build a tiny reporting CLI
scope_fence: []
requirements:
  - id: R1
    statement: "The CLI reports basic file facts"
    acceptance:
      tier: 1
      gate: node cli.js a && node cli.js b && node cli.js c && node cli.js d && node cli.js e && node cli.js f
  - id: R2
    statement: "The CLI reports numeric summaries"
    acceptance:
      tier: 1
      gate: node cli.js g && node cli.js h && node cli.js i && node cli.js j && node cli.js k && node cli.js l
decisions: []
claims: []
open_questions: []
`);
    const bundled = {
      contract: "CLI contract",
      nodes: [{ id: "cli", brief: "build all CLI facts and numeric summaries", deps: [], context_globs: [], blast_radius: ["cli.js", "cli.test.js"], budget_usd: 1, requirement: "R1, R2" }],
    };
    const repaired = {
      contract: "CLI contract",
      nodes: [
        { id: "facts", brief: "build basic file facts", deps: [], context_globs: [], blast_radius: ["cli.js", "facts.test.js"], budget_usd: 0.5, requirement: "R1" },
        { id: "numeric", brief: "extend CLI with numeric summaries", deps: ["facts"], context_globs: ["cli.js"], blast_radius: ["cli.js", "numeric.test.js"], budget_usd: 0.5, requirement: "R2" },
      ],
    };
    const llm = new MockLlm([
      { text: JSON.stringify(bundled) },
      { text: JSON.stringify(repaired) },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const result = await deriveV2({
      spec,
      workdir,
      llm,
      model: "mock",
      chainName: "cheap",
      budgetUsd: 2,
      executorModel: "qwen/qwen3-coder",
      nodeContextBudget: 24000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mission.nodes.map((n) => n.id)).toEqual(["facts", "numeric"]);
    expect(result.readback).not.toContain("over-sized node");
  });

  it("falls back to requirement-band repair when model shape repair stays oversized", async () => {
    const spec = parseSpec(`
thesis: build a command-line reporting tool
scope_fence: []
requirements:
  - id: R1
    statement: "Report file metadata and headers"
    acceptance:
      tier: 1
      gate: node cli.js a | grep -q a && node cli.js b | grep -q b && node cli.js c | grep -q c && node cli.js d | grep -q d
  - id: R2
    statement: "Report row and column summaries"
    acceptance:
      tier: 1
      gate: node cli.js e | grep -q e && node cli.js f | grep -q f && node cli.js g | grep -q g && node cli.js h | grep -q h
  - id: R3
    statement: "Report numeric statistics"
    acceptance:
      tier: 1
      gate: node cli.js i | grep -q i && node cli.js j | grep -q j && node cli.js k | grep -q k && node cli.js l | grep -q l
  - id: R4
    statement: "Report input errors"
    acceptance:
      tier: 1
      gate: node cli.js m 2>&1 | grep -q m && node cli.js n 2>&1 | grep -q n && node cli.js o 2>&1 | grep -q o
decisions: []
claims: []
open_questions: []
`);
    const workdir2 = mkdtempSync(join(tmpdir(), "ser-derive-band-repair-"));
    writeFileSync(join(workdir2, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const monolith = {
      contract: "CLI contract",
      nodes: [{ id: "cli", brief: "build every report behavior", deps: [], context_globs: [], blast_radius: ["cli.js", "cli.test.js"], budget_usd: 1, requirement: "R1, R2, R3, R4" }],
    };
    const llm = new MockLlm([
      { text: JSON.stringify(monolith) },
      { text: JSON.stringify(monolith) },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const result = await deriveV2({
      spec,
      workdir: workdir2,
      llm,
      model: "mock",
      chainName: "cheap",
      budgetUsd: 2,
      executorModel: "qwen/qwen3-coder",
      nodeContextBudget: 24000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mission.nodes.length).toBe(2);
    expect(result.mission.nodes.every((n) => n.gate?.type === "command" && typeof n.gate.run === "string" && gateBehaviorCount(n.gate.run) <= 10)).toBe(true);
    expect(result.readback).not.toContain("over-sized node");
  });

  it("bootstrapGreenfieldNodeGate scaffolds a runnable npm skeleton + e2e-excluding vitest config (idempotent)", () => {
    const out = bootstrapGreenfieldNodeGate("npm test");
    expect(out).toMatch(/if \[ ! -f package\.json \]/); // never clobbers a real manifest
    expect(out).toContain('"test":"vitest run"'); // skeleton maps npm test -> vitest
    expect(out).toContain('"build":"vite build"');
    expect(out).toMatch(/if \[ ! -f vitest\.config\.js \]/); // writes a config so the suite excludes e2e
    expect(out).toContain('"**/e2e/**"'); // playwright specs don't choke the unit run
    expect(out).toContain('"**/*.spec.*"');
    expect(out).toMatch(/if \[ ! -d node_modules \]/); // install deps when absent
    expect(out.endsWith("npm test'")).toBe(true); // the real gate still runs last, inside the sh -c wrap
    expect(out).not.toContain("index.html"); // a pure test node doesn't get a vite entry
    // a BUILD gate also gets a minimal vite entry so `vite build` resolves on an early node
    const buildOut = bootstrapGreenfieldNodeGate("npm run build --if-present");
    expect(buildOut).toMatch(/if \[ ! -f index\.html \]/);
    expect(buildOut).toContain("<!doctype html>");
    // browser-driver gates get verifier deps even when the gate itself is not an npm script
    const playwrightOut = bootstrapGreenfieldNodeGate("npx playwright test tests/ui.spec.ts");
    expect(playwrightOut).toContain("npm install --no-fund --no-audit -D @playwright/test");
    expect(playwrightOut).toContain("npx playwright install chromium");
    const puppeteerOut = bootstrapGreenfieldNodeGate("node -e \"require('puppeteer')\"");
    expect(puppeteerOut).toContain("npm install --no-fund --no-audit -D puppeteer");
    // non-npm gates are left completely alone (no scaffold noise)
    expect(bootstrapGreenfieldNodeGate("grep -q data-edge index.html")).toBe("grep -q data-edge index.html");
    expect(bootstrapGreenfieldNodeGate("python3 -m pytest tests/x.py")).toBe("python3 -m pytest tests/x.py");
  });

  it("affirmsBuildability flags backwards evidence but not a genuine refutation", () => {
    expect(affirmsBuildability("Prior art demonstrates this is buildable")).toBe(true);
    expect(affirmsBuildability("a practical build path exists, existing systems already do this")).toBe(true);
    expect(affirmsBuildability("matching the claim's acceptance gate logic")).toBe(true);
    expect(affirmsBuildability("Financial systems use decimal arithmetic libraries such as decimal.js and big.js")).toBe(true);
    // the real poker refutation must NOT be mistaken for an affirmation
    expect(
      affirmsBuildability("10^160 game states x 1ns/state >> age of the universe; real solvers (PioSOLVER, Pluribus) use abstraction + subgame solving"),
    ).toBe(false);
  });

  it("free-form gates compile but are flagged in the readback", async () => {
    const ff = JSON.stringify({ gates: [{ node: "impl", freeform: "bash check.sh" }, { node: "tests", pattern: "tests-pass", params: { testCmd: "npm run test" } }] });
    const llm = new MockLlm([{ text: decomposeOut }, { text: ff }, { text: claimsOut }, { text: lensOk }, { text: lensOk }]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.freeformGates).toEqual([{ node: "impl", run: "bash check.sh" }]);
    expect(r.readback).toContain("free-form gate on impl");
  });

  it("spec-mode: tier-0 requirement refuses with the three remediations BEFORE spending tokens", async () => {
    const spec = parseSpec(`
thesis: "a realistic chicken"
requirements:
  - id: R1
    statement: "the chicken looks realistic"
    acceptance: { tier: 0 }
`);
    const llm = new MockLlm([]);
    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons[0]).toContain("UNANCHORED");
    expect(r.remediations[0]!.options).toHaveLength(3);
    expect(r.remediations[0]!.options.join(" ")).toMatch(/anchor.*proxy.*own|anchor/);
    expect(llm.calls).toHaveLength(0); // pre-gate: zero tokens spent
  });

  it("spec-mode: explicit acceptance gates win over inference; tier-4 becomes a human gate", async () => {
    const spec = parseSpec(`
thesis: "render a chicken"
requirements:
  - id: R1
    statement: "render pipeline works"
    acceptance: { tier: 1, gate: "npm run test" }
  - id: R2
    statement: "the chicken looks alive"
    acceptance: { tier: 4, artifact: "renders/grid.png" }
`);
    const decompose = JSON.stringify({
      nodes: [
        { id: "pipeline", brief: "build it", deps: [], context_globs: [], blast_radius: ["src/**"], budget_usd: 0.5, requirement: "R1" },
        { id: "render", brief: "render it", deps: ["pipeline"], context_globs: [], blast_radius: ["renders/**"], budget_usd: 0.5, requirement: "R2" },
      ],
    });
    const llm = new MockLlm([
      { text: decompose },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the explicit acceptance gate wins over inference, then the harness scaffolds a
    // runnable greenfield skeleton around it (so `npm run test` doesn't ENOENT on an
    // empty repo). The real command still runs last; the spec author's gate is intact.
    expect(r.mission.nodes[0]!.gate!.type).toBe("command");
    const g0run = String(r.mission.nodes[0]!.gate!.run ?? "");
    expect(g0run).toContain("npm run test");
    expect(g0run).toMatch(/if \[ ! -f package\.json \]/);
    expect(r.mission.nodes[1]!.gate).toMatchObject({ type: "human", artifact: "renders/grid.png" });
    // no infer-gates call was needed: decompose + claims only
    expect(llm.calls).toHaveLength(2);
  });

  it("spec-mode canonicalizes Jest-only pure test flags before bootstrapping Vitest", async () => {
    const spec = parseSpec(`
thesis: "build notes"
requirements:
  - id: R1
    statement: "unit tests prove notes work"
    acceptance: { tier: 1, gate: "npm test -- --runInBand" }
`);
    const decompose = JSON.stringify({
      nodes: [
        { id: "notes", brief: "build notes", deps: [], context_globs: [], blast_radius: ["src/**"], budget_usd: 0.5, requirement: "R1" },
      ],
    });
    const llm = new MockLlm([
      { text: decompose },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const run = String(r.mission.nodes[0]!.gate!.run ?? "");
    expect(run).toContain('"test":"vitest run"');
    expect(run).toMatch(/&& npm test'$/);
    expect(run).not.toContain("runInBand");
  });

  it("judge mode pre-gate diagnoses refuted decisions and blocking questions", () => {
    const spec = parseSpec(`
thesis: "x"
requirements:
  - id: R1
    statement: "y"
    acceptance: { tier: 1, gate: "true" }
decisions:
  - id: D1
    statement: "use CFR"
    rationale: "standard"
    claims: [C1]
claims:
  - id: C1
    statement: "tractable"
    status: refuted
    evidence: "arithmetic shown"
open_questions:
  - { id: Q1, text: "pricing?", blocking: true }
`);
    const refusal = specPreGate(spec)!;
    expect(refusal.reasons.join(" ")).toContain("D1");
    expect(refusal.reasons.join(" ")).toContain("Q1");
  });

  it("rejects neither-or-both goal/spec input", async () => {
    const llm = new MockLlm([]);
    await expect(deriveV2({ ...base(llm), goal: undefined })).rejects.toThrow(SquireError);
  });
});

describe("node sizing — kill the count anchor, size to the executor envelope", () => {
  it("the decompose prompt no longer carries the '1-12 nodes' anchor; it states the envelope", async () => {
    const llm = new MockLlm([{ text: decomposeOut }, { text: gatesOut }, { text: JSON.stringify({ claims: [] }) }]);
    await deriveV2({ ...base(llm), executorModel: "qwen/qwen3-coder", nodeContextBudget: 18000 });
    const decomposeSystem = llm.calls[0]!.system ?? "";
    expect(decomposeSystem).not.toContain("1-12");
    expect(decomposeSystem).toContain("SIZE EACH NODE TO THE EXECUTOR'S ENVELOPE");
    // the envelope it sizes against is the EXECUTOR slug + its calibrated budget
    expect(decomposeSystem).toContain("qwen/qwen3-coder");
    expect(decomposeSystem).toContain("18000");
  });

  it("copies the executor envelope into every node's max_context_tokens", async () => {
    const llm = new MockLlm([{ text: decomposeOut }, { text: gatesOut }, { text: JSON.stringify({ claims: [] }) }]);
    const r = await deriveV2({ ...base(llm), nodeContextBudget: 22000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const n of r.mission.nodes) expect(n.max_context_tokens).toBe(22000);
  });

  it("nodeRequirementIds splits comma/space lists and tolerates an absent field", () => {
    expect(nodeRequirementIds({ requirement: "R1, R2  R3" })).toEqual(["R1", "R2", "R3"]);
    expect(nodeRequirementIds({})).toEqual([]);
  });

  it("coverage gate accepts ONE node satisfying SEVERAL requirements (no count inflation)", async () => {
    const spec = parseSpec(`
thesis: "a small tool"
requirements:
  - id: R1
    statement: "parse input"
    acceptance: { tier: 1, gate: "npm run test" }
  - id: R2
    statement: "validate input"
    acceptance: { tier: 1, gate: "npm run lint" }
`);
    // a SINGLE node claims both requirements — must pass coverage with no retry
    const decompose = JSON.stringify({
      nodes: [
        { id: "core", brief: "parse + validate", deps: [], context_globs: [], blast_radius: ["src/**"], budget_usd: 1, requirement: "R1, R2" },
      ],
    });
    const llm = new MockLlm([{ text: decompose }, { text: JSON.stringify({ claims: [] }) }]);
    const r = await deriveV2({ ...base(llm), goal: undefined, spec });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes).toHaveLength(1);
    // the node's gate AGGREGATES both concrete acceptance commands (verifies the WHOLE unit)
    const run = String(r.mission.nodes[0]!.gate!.run ?? "");
    expect(run).toContain("npm run test");
    expect(run).toContain("npm run lint");
    // coverage passed on the FIRST decompose — no coverage-retry call was spent
    expect(llm.calls.some((c) => c.user.includes("uncovered"))).toBe(false);
  });

  it("refuses a node whose EXISTING context_globs already blow the envelope (derive-time filter)", async () => {
    // a real, oversized file in the workdir that the node's context_globs match
    writeFileSync(join(workdir, "src", "huge.ts"), "x".repeat(80_000));
    const decompose = JSON.stringify({
      nodes: [
        { id: "big", brief: "touch the huge module", deps: [], context_globs: ["src/**"], blast_radius: ["src/**"], budget_usd: 1 },
      ],
    });
    const llm = new MockLlm([{ text: decompose }, { text: gatesOut }, { text: JSON.stringify({ claims: [] }) }]);
    const r = await deriveV2({ ...base(llm), nodeContextBudget: 5_000 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons.join(" ")).toMatch(/over-scoped/);
    expect(r.reasons.join(" ")).toContain("big");
  });
});

describe("allocateNodeBudgets — floor + escalation reserve", () => {
  it("holds back a reserve and gives every node at least the floor", () => {
    const out = allocateNodeBudgets([10, 0, 0], 1.0);
    // 20% reserve held back → distributed pool is ~0.80
    expect(out.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(0.8 + 0.02);
    // the two zero-weight nodes still clear the floor
    expect(out[1]!).toBeGreaterThanOrEqual(0.05);
    expect(out[2]!).toBeGreaterThanOrEqual(0.05);
    // the heavy node still gets the lion's share
    expect(out[0]!).toBeGreaterThan(out[1]!);
  });

  it("never returns below one cent, even on a degenerate tiny budget", () => {
    const out = allocateNodeBudgets([1, 1, 1, 1], 0.001);
    for (const b of out) expect(b).toBeGreaterThanOrEqual(0.01);
  });

  it("overflowingNodes ignores nodes with no context_globs (greenfield)", () => {
    expect(overflowingNodes(workdir, [{ id: "x", context_globs: [] }], 1000)).toEqual([]);
  });
});

describe("harness-derived UI gate — deterministic DOM teeth without the planner selecting it", () => {
  it("extracts pinned DOM hooks from a brief", () => {
    expect(extractDomHooks("renders [data-testid=pot] and [data-action=raise], plus [data-card]")).toEqual([
      "[data-testid=pot]",
      "[data-action=raise]",
      "[data-card]",
    ]);
    expect(extractDomHooks("a poker hand evaluator module, no DOM")).toEqual([]);
  });

  it("derives a dom-behavior presence gate when a brief pins hooks (planner-independent)", () => {
    const g = deriveUiGate({ brief: "build the table: [data-testid=pot] and [data-action=raise]" });
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.type).toBe("command");
    expect(g.run).toContain("node .squire/dom-gate.mjs");
    expect(g.run).toContain('"assert":"[data-testid=pot]"'); // asserts each pinned hook exists
    expect(g.run).toContain('"assert":"[data-action=raise]"');
    expect(g.run).toContain("--serve"); // boots the app to drive it
  });

  it("returns null for a non-UI node (no hooks → leave the planner's gate alone)", () => {
    expect(deriveUiGate({ brief: "implement the poker hand evaluator and side-pot logic" })).toBeNull();
  });

  it("functionalUiGate seeds two sentinels and gates the HTTP function (not the pixels)", () => {
    const g = functionalUiGate("storage.create_user(email,password); storage.store_api_key(email,provider,api_key)");
    expect(g.type).toBe("command");
    expect(g.soft).toBe(false);
    const run = g.run ?? "";
    expect(run).toContain("serve-gate.mjs --port 3000");
    // two distinct sentinel keys (defeats hardcoding) + isolation
    expect(run).toContain("SENTL_a1b2c3d4e5");
    expect(run).toContain("SENTL_z9y8x7w6v5");
    expect(run).toMatch(/alice@sentinel\.test/);
    expect(run).toMatch(/bob@sentinel\.test/);
    // seeds via the storage interface (satisfiable, not a vacuous pass)
    expect(run).toContain("create_user");
    expect(run).toContain("store_api_key");
    // auth-rejection + session-gating checks present
    expect(run).toContain("WRONGpw");
    expect(run).toMatch(/30\[12\]\|401\|403/);
  });

  it("DRIVES the login flow for an auth-gated app instead of asserting post-auth hooks on the bare page", () => {
    const contract =
      "DOM HOOKS: [data-testid=login-form], [data-testid=email-input], [data-testid=password-input], [data-testid=login-button], [data-testid=dashboard], [data-testid=api-keys-list], [data-testid=logout-button]. " +
      "MODULE EXPORTS: storage.create_user(email, password); storage.store_api_key(email, provider, api_key)";
    const g = deriveUiGate({ brief: "login-protected dashboard" }, contract);
    expect(g).not.toBeNull();
    if (!g) return;
    // seeds a user through the storage module so login has valid credentials
    expect(g.run).toContain("create_user");
    expect(g.run).toContain("test@example.com");
    // fills the form and submits, THEN asserts the dashboard surface (not on the bare load)
    expect(g.run).toContain('"fill":"[data-testid=password-input]"');
    expect(g.run).toContain('"click":"[data-testid=login-button]"');
    // dashboard hooks are asserted AFTER the click, not before it
    const runStr = g.run ?? "";
    expect(runStr.indexOf('"click":"[data-testid=login-button]"')).toBeLessThan(runStr.indexOf('"assert":"[data-testid=dashboard]"'));
  });

  it("reads hooks from the shared CONTRACT, not just the node brief", () => {
    const g = deriveUiGate({ brief: "build the table UI" }, "DOM CONTRACT: [data-testid=pot], [data-action=raise]");
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.run).toContain('"assert":"[data-testid=pot]"');
    expect(g.run).toContain('"assert":"[data-action=raise]"');
  });

  it("looksLikeUi detects a frontend node by its files, not a logic node", () => {
    expect(looksLikeUi({ blast_radius: ["src/app/Table.tsx", "public/index.html"] })).toBe(true);
    expect(looksLikeUi({ blast_radius: ["styles.css"] })).toBe(true);
    expect(looksLikeUi({ blast_radius: ["src/poker-engine.js", "src/bot-ai.js"] })).toBe(false);
  });
});

import { unifyContractFieldNames } from "../../src/contract/derive2.js";

describe("unifyContractFieldNames — one value, one name (the url/longUrl drift)", () => {
  it("rewrites an endpoint field to the type's canonical name", () => {
    const c = "type Link = { id: string, longUrl: string, shortCode: string };\nPOST /api/shorten body: { url: string, customAlias?: string } -> { shortCode: string }";
    const r = unifyContractFieldNames(c);
    expect(r.renamed).toContainEqual(["url", "longUrl"]);
    expect(r.contract).toContain("{ longUrl: string, customAlias?: string }"); // url -> longUrl
    expect(r.contract).not.toMatch(/\burl\b/); // the bare endpoint `url` is gone
  });
  it("does NOT touch a legit endpoint-only field or a substring collision", () => {
    const c = "type Link = { longUrl: string, shortCode: string };\nresponse: { shortUrl: string, customAlias: string }";
    const r = unifyContractFieldNames(c);
    // shortUrl is NOT a substring-rename of shortCode; customAlias has no type match -> both kept
    expect(r.renamed).toEqual([]);
    expect(r.contract).toContain("shortUrl");
    expect(r.contract).toContain("customAlias");
  });
  it("no-op when there are no data types", () => {
    expect(unifyContractFieldNames("just prose, no types").renamed).toEqual([]);
  });
});

describe("wrapTestsWithTimeout", () => {
  it("wraps each bare test-file runner, skips already-timed, fails fast on a hung test", () => {
    const out = wrapTestsWithTimeout("node test/a.cjs && node test/b.cjs && timeout 15s node test/c.cjs");
    expect(out).toBe("timeout 30s node test/a.cjs && timeout 30s node test/b.cjs && timeout 15s node test/c.cjs");
  });
  it("also applies through groundGateRun (so spec + generated gates both get it)", () => {
    expect(groundGateRun("node test/r4_recalc.cjs")).toBe("timeout 30s node test/r4_recalc.cjs");
  });
  it("bails out on inline scripts / heredocs / pipes where && splitting is unsafe", () => {
    expect(wrapTestsWithTimeout(`node -e "x && y"`)).toBe(`node -e "x && y"`);
    expect(wrapTestsWithTimeout("node a.cjs | grep ok")).toBe("node a.cjs | grep ok");
  });
  it("leaves non-test commands alone (curl, npm, npx playwright)", () => {
    const run = "curl -fsS localhost:3000 && npx playwright test e2e.spec.ts";
    expect(wrapTestsWithTimeout(run)).toBe(run);
  });
});
