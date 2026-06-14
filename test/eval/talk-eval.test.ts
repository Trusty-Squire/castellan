import { describe, it, expect } from "vitest";
import {
  tokenize,
  jaccard,
  factRecorded,
  isShowPlanAsk,
  scoreTranscript,
  formatScoreTable,
  type Scenario,
  type Transcript,
  type EvalTurn,
} from "../../src/eval/talk-eval.js";

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

  it("formatScoreTable renders a row per scenario plus a mean", () => {
    const out = formatScoreTable([
      { scenario: "demo", score: scoreTranscript(scenario, { scenarioId: "demo", turns: [turn({ ready: true, blockingAfter: 0 })], finalDecisions: ["age 4", "laptop"] }) },
    ]);
    expect(out).toContain("scenario");
    expect(out).toContain("demo");
    expect(out).toContain("mean score:");
  });
});
