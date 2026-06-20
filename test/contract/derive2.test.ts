import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveV2,
  specPreGate,
  affirmsBuildability,
  groundGateRun,
  tractableGateRun,
  stripCaseFilters,
  canonicalizeTestGate,
  bootstrapGreenfieldNodeGate,
  isImplementationShapedDecomposition,
  productPlanningContract,
  trimSurveyForDecompose,
  buildDirectMission,
} from "../../src/contract/derive2.js";
import { parseSpec } from "../../src/contract/spec.js";
import { MockLlm } from "../../src/llm/mock.js";
import { SquireError } from "../../src/errors.js";

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

  it("adds one general interactive-app planning contract (no per-demo categories)", () => {
    // any user-facing app gets the same general 'capabilities not files' rule
    for (const p of ["a dashboard that ranks arbitrage opportunities", "a casino webapp with poker", "a mystical app that reads tarot"]) {
      const c = productPlanningContract(p);
      expect(c).toContain("user-visible capabilities");
      expect(c).toContain("headline value visible in the first viewport");
    }
    // non-interactive intent gets nothing
    expect(productPlanningContract("a CLI that parses CSV files into JSON")).toBe("");
  });

  it("detects file-shaped decomposition for interactive apps", () => {
    expect(
      isImplementationShapedDecomposition(
        [
          { brief: "create index.html", blast_radius: ["index.html"] },
          { brief: "write render.js", blast_radius: ["render.js"] },
          { brief: "fill data.js", blast_radius: ["data.js"] },
        ],
        "a dashboard app for ranked arbitrage opportunities",
      ),
    ).toBe(true);
    expect(
      isImplementationShapedDecomposition(
        [
          { brief: "build the ranked opportunities panel and first-viewport hierarchy", blast_radius: ["index.html", "render.js"] },
          { brief: "make the comparison table readable on mobile", blast_radius: ["index.html", "render.js"] },
        ],
        "a dashboard app for ranked arbitrage opportunities",
      ),
    ).toBe(false);
  });

  it("trims greenfield interactive-app surveys for the decompose stage", () => {
    const survey = [
      "FILES (0):",
      "",
      "DETECTED CHECK COMMANDS:",
      "  npm run test",
      "",
      "AVAILABLE TOOLS (gates MUST use only these interpreters/runners — present=yes):",
      "  python3: yes",
      "  node: yes",
      "  npm: yes",
      "  bash: yes",
      "  rg: yes",
      "  cargo: MISSING — do not use",
      "Prefer the present ones. Use `python3` (not `python`) unless `python` shows present.",
    ].join("\n");
    const trimmed = trimSurveyForDecompose(survey, "a fortune reading app with tarot and tea leaves");
    expect(trimmed).toContain("FILES (0):");
    expect(trimmed).toContain("npm run test");
    expect(trimmed).toContain("python3: yes");
    expect(trimmed).not.toContain("Prefer the present ones.");
  });

  it("retries decomposition when an interactive app plan comes back file-shaped", async () => {
    const first = JSON.stringify({
      nodes: [
        { id: "html", brief: "create index.html", deps: [], context_globs: [], blast_radius: ["index.html"], budget_usd: 0.3 },
        { id: "render", brief: "write render.js", deps: ["html"], context_globs: [], blast_radius: ["render.js"], budget_usd: 0.3 },
        { id: "data", brief: "fill data.js", deps: ["render"], context_globs: [], blast_radius: ["data.js"], budget_usd: 0.4 },
      ],
    });
    const second = JSON.stringify({
      nodes: [
        { id: "hero", brief: "build the top opportunity viewport and ranked opportunity panel", deps: [], context_globs: [], blast_radius: ["index.html", "render.js"], budget_usd: 0.5 },
        { id: "comparison", brief: "render the cross-book comparison surface with readable mobile layout", deps: ["hero"], context_globs: [], blast_radius: ["index.html", "render.js"], budget_usd: 0.5 },
      ],
    });
    const llm = new MockLlm([
      { text: first },
      { text: second },
      { text: JSON.stringify({ gates: [{ node: "hero", freeform: "true" }, { node: "comparison", freeform: "true" }] }) },
      { text: JSON.stringify({ claims: [] }) },
    ]);
    const r = await deriveV2({
      ...base(llm),
      goal: "build a dashboard app that ranks arbitrage opportunities and compares sportsbook lines",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mission.nodes.map((n) => n.id)).toEqual(["hero", "comparison"]);
    expect(llm.calls[1]!.user).toContain("previous decomposition was too implementation-shaped");
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
    expect(mission.nodes[0]!.gate!.run).toContain("npm test -- --run");
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

  it("a refuted load-bearing claim (with evidence) blocks the plan — the poker path", async () => {
    const llm = new MockLlm([
      { text: decomposeOut },
      { text: gatesOut },
      { text: JSON.stringify({ claims: [{ id: "C1", statement: "full-game CFR for NLHE is tractable on a laptop", loadBearing: true, about: "solver" }] }) },
      { text: JSON.stringify({ refuted: true, evidence: "10^160 game states x 1ns/state >> age of the universe; real solvers (PioSOLVER, Pluribus) use abstraction + subgame solving" }) },
      { text: lensOk },
    ]);
    const r = await deriveV2(base(llm));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reasons[0]).toContain("CFR");
    expect(r.reasons[0]).toContain("PioSOLVER");
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

  it("tractableGateRun downgrades node-level e2e gates to a build floor (visual audit keeps the teeth)", () => {
    for (const e2e of [
      "npm run test:e2e -- tests/e2e/lines-dashboard.spec.ts",
      "npm run e2e",
      "npx playwright test",
      "cypress run",
    ]) {
      const out = tractableGateRun(e2e);
      expect(out).toContain("npm run build --if-present"); // tractable floor
      expect(out).not.toMatch(/playwright|cypress|test:e2e/i); // the intractable harness is gone
    }
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
    expect(canonicalizeTestGate("npm test -- --run tests/arbitrage-engine.test.ts")).toBe("npm test");
    expect(canonicalizeTestGate("npx vitest run tests/foo.test.ts")).toBe("npm test");
    // applied end-to-end through tractableGateRun
    expect(tractableGateRun("npm test -- --runTestsByPath tests/x.test.js")).toBe("npm test");
    // compound gates keep their non-test payload (UI build+grep checks, plain grep)
    expect(canonicalizeTestGate("npm run build --if-present && grep -q data-edge index.html")).toContain("grep -q data-edge");
    expect(canonicalizeTestGate("grep -q data-edge index.html")).toBe("grep -q data-edge index.html");
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
