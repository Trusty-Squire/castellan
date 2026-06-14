import { describe, it, expect } from "vitest";
import {
  tokenize,
  jaccard,
  factRecorded,
  isShowPlanAsk,
  scoreTranscript,
  formatScoreTable,
  specQuality,
  blindAssign,
  processScore,
  type Scenario,
  type Transcript,
  type EvalTurn,
  type Score,
  type ProcessJudgment,
} from "../../src/eval/talk-eval.js";
import type { Spec } from "../../src/contract/spec.js";

const scenario: Scenario = {
  id: "demo",
  persona: "a parent",
  idea: "an ai companion for my kid",
  facts: [
    { key: "age", value: "4", keywords: ["age 4", "4 year"] },
    { key: "hardware", value: "laptop", keywords: ["laptop"] },
  ],
  showPlanTurn: 3,
  maxTurns: 5,
};

function turn(p: Partial<EvalTurn>): EvalTurn {
  return { user: "", reply: "", asked: "", action: "none", presentedPlan: false, blockingAfter: 1, ready: false, ...p };
}

describe("talk-eval pure helpers", () => {
  it("jaccard catches a re-asked question, ignores an unrelated one", () => {
    expect(jaccard(tokenize("what is her age?"), tokenize("what's her age, again?"))).toBeGreaterThanOrEqual(0.5);
    expect(jaccard(tokenize("what is her age?"), tokenize("which laptop OS?"))).toBeLessThan(0.5);
  });

  it("factRecorded matches on proof keywords in the decisions", () => {
    expect(factRecorded(scenario.facts[0]!, ["Child's age 4 years old"])).toBe(true);
    expect(factRecorded(scenario.facts[1]!, ["Target hardware is a laptop"])).toBe(true);
    expect(factRecorded(scenario.facts[1]!, ["uses local storage"])).toBe(false);
  });

  it("isShowPlanAsk recognizes a request to see the plan", () => {
    expect(isShowPlanAsk("show me the architecture and components")).toBe(true);
    expect(isShowPlanAsk("she is 4")).toBe(false);
  });
});

describe("scoreTranscript", () => {
  it("rewards a clean run: facts recorded, no re-asks, buildable, plan shown", () => {
    const t: Transcript = {
      scenarioId: "demo",
      turns: [
        turn({ user: scenario.idea, asked: "what's her age?", blockingAfter: 1 }),
        turn({ user: "4", asked: "which laptop OS?", blockingAfter: 1 }),
        turn({ user: "show me the architecture", action: "status", presentedPlan: true, blockingAfter: 0, ready: true }),
      ],
      finalDecisions: ["Child's age 4 years old", "Target hardware is a laptop"],
    };
    const s = scoreTranscript(scenario, t);
    expect(s.factsRecorded).toBe(1);
    expect(s.reasks).toBe(0);
    expect(s.askedWhenSettled).toBe(0);
    expect(s.buildable).toBe(true);
    expect(s.turnsToBuildable).toBe(3);
    expect(s.presentedOnRequest).toBe(true);
    expect(s.overall).toBe(100);
  });

  it("penalizes the screenshot failures: re-ask, missing fact, incoherent ask, plan not shown", () => {
    const t: Transcript = {
      scenarioId: "demo",
      turns: [
        turn({ user: scenario.idea, asked: "what's her age?", blockingAfter: 1 }),
        turn({ user: "4", asked: "what is her age?", blockingAfter: 1 }), // re-ask
        // buildable but STILL asks (incoherent), and the user asked to see the plan but it didn't
        turn({ user: "show me the components", reply: "What hardware runs it?", action: "none", presentedPlan: false, blockingAfter: 0, ready: true }),
      ],
      finalDecisions: ["Child's age 4 years old"], // hardware fact never recorded
    };
    const s = scoreTranscript(scenario, t);
    expect(s.reasks).toBe(1);
    expect(s.factsRecorded).toBe(0.5);
    expect(s.askedWhenSettled).toBe(1);
    expect(s.presentedOnRequest).toBe(false);
    expect(s.overall).toBeLessThan(60);
  });

  it("present-on-request is null (not penalized) when the user never asked", () => {
    const t: Transcript = {
      scenarioId: "demo",
      turns: [turn({ user: "4", blockingAfter: 0, ready: true })],
      finalDecisions: ["Child's age 4 years old", "Target hardware is a laptop"],
    };
    expect(scoreTranscript(scenario, t).presentedOnRequest).toBeNull();
  });

});

describe("tier 2 — output quality", () => {
  const spec = {
    thesis: "ai companion",
    stories: [],
    scope_fence: [],
    requirements: [
      { id: "R1", statement: "voice", acceptance: { tier: 1, gate: "x" } },
      { id: "R2", statement: "presence", acceptance: { tier: 0 } },
    ],
    decisions: [
      { id: "D1", statement: "designed for age 4", rationale: "r", claims: [] },
      { id: "D2", statement: "runs on a laptop", rationale: "r", claims: [] },
    ],
    claims: [],
    open_questions: [],
  } as unknown as Spec;

  it("specQuality scores objective gates, ungated, fact coverage, decomposition", () => {
    const q = specQuality(spec, scenario);
    expect(q.gateCoverage).toBe(0.5); // 1 of 2 has any gate
    expect(q.objectiveRate).toBe(0.5); // 1 of 2 is automatable (tier 1-3)
    expect(q.ungated).toBe(1);
    expect(q.human).toBe(0);
    expect(q.factCoverage).toBe(1); // "age 4" + "laptop" both present
    expect(q.components).toBe(2);
    expect(q.composite).toBe(75); // 50*0.5 + 35*1 + 15*1
  });

  it("specQuality penalizes tier-4 human gates — they can't loop unattended", () => {
    const human = {
      ...spec,
      requirements: [
        { id: "R1", statement: "feels safe", acceptance: { tier: 4, artifact: "review.md" } },
        { id: "R2", statement: "feels nice", acceptance: { tier: 4, artifact: "review2.md" } },
      ],
    } as unknown as Spec;
    const q = specQuality(human, scenario);
    expect(q.gateCoverage).toBe(1); // both "gated"…
    expect(q.objectiveRate).toBe(0); // …but neither is automatable
    expect(q.human).toBe(2);
    expect(q.composite).toBeLessThan(60); // dragged down despite full gate coverage
  });

  it("blindAssign hides which spec is ser, and remembers the mapping", () => {
    expect(blindAssign("S", "V", false)).toEqual({ a: "S", b: "V", serIs: "A" });
    expect(blindAssign("S", "V", true)).toEqual({ a: "V", b: "S", serIs: "B" });
  });

  it("processScore blends mechanical 60% + judge 40%, or mechanical alone if no judge", () => {
    const mech = { overall: 80 } as Score;
    expect(processScore(mech, null)).toBe(80);
    const judge: ProcessJudgment = { forks: 5, captured: 5, defaulted: 5, coherence: 5, reason: "" };
    expect(processScore(mech, judge)).toBe(88); // 0.6*80 + 0.4*100
  });

  it("formatScoreTable still renders (legacy tier-1 table)", () => {
    const out = formatScoreTable([
      { scenario: "demo", score: scoreTranscript(scenario, { scenarioId: "demo", turns: [turn({ ready: true, blockingAfter: 0 })], finalDecisions: ["age 4", "laptop"] }) },
    ]);
    expect(out).toContain("scenario");
    expect(out).toContain("demo");
    expect(out).toContain("mean score:");
  });
});
