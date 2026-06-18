import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveV2, specPreGate, affirmsBuildability, groundGateRun } from "../../src/contract/derive2.js";
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
    expect(groundGateRun("pytest -q && rg foo")).toBe("pytest -q && rg foo"); // other tools untouched
    expect(groundGateRun("./mypython.sh")).toBe("./mypython.sh"); // substring untouched
  });

  it("affirmsBuildability flags backwards evidence but not a genuine refutation", () => {
    expect(affirmsBuildability("Prior art demonstrates this is buildable")).toBe(true);
    expect(affirmsBuildability("a practical build path exists, existing systems already do this")).toBe(true);
    expect(affirmsBuildability("matching the claim's acceptance gate logic")).toBe(true);
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
    expect(r.mission.nodes[0]!.gate).toMatchObject({ type: "command", run: "npm run test" });
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
