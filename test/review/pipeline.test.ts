import { describe, it, expect } from "vitest";
import { parseSpec } from "../../src/contract/spec.js";
import { MockLlm } from "../../src/llm/mock.js";
import { ceoReview, designReview } from "../../src/review/reviewers.js";
import { reviewPlan } from "../../src/review/orchestrate.js";
import { reviewSpec } from "../../src/contract/review.js";

const SPEC_YAML = `
thesis: "a dashboard that ranks arbitrage opportunities by size"
stories:
  - "user sees opportunities ranked by size, largest first"
requirements:
  - id: R1
    statement: "render the opportunities list"
    acceptance: { tier: 1, gate: "test -f index.html" }
`;
const spec = parseSpec(SPEC_YAML);

const reviewerJson = (o: Record<string, unknown>): string => JSON.stringify(o);

// One scripted reply per reviewer, in pipeline order ceo→design→eng→dx.
const CEO = reviewerJson({
  overall: 7,
  dimensions: [{ name: "ambition", score: 7, whatMakesIt10: "go bigger" }],
  patches: [],
  decisions: [
    { text: "store data where?", options: ["sqlite", "json file"], classification: "mechanical", recommendation: "sqlite", why: "durable", ifWrongCost: "low", blocking: false },
  ],
});
const DESIGN = reviewerJson({
  overall: 4,
  dimensions: [{ name: "headline value shown", score: 2, whatMakesIt10: "show the size" }],
  patches: [
    { statement: "each opportunity shows its size", gate: "grep -q data-size index.html", kind: "objective" },
    { statement: "spacing rhythm is consistent", gate: "true", kind: "visual" },
  ],
  decisions: [
    { text: "dense table or cards?", options: ["cards", "table"], classification: "taste", recommendation: "cards", why: "scannable", ifWrongCost: "low", blocking: false },
  ],
});
const ENG = reviewerJson({
  overall: 6,
  dimensions: [{ name: "edge cases", score: 6, whatMakesIt10: "handle empty" }],
  patches: [],
  decisions: [
    { text: "you asked to skip tests — that's wrong", options: ["add tests", "skip"], classification: "user_challenge", recommendation: "add tests", why: "untested ships bugs", ifWrongCost: "high", blocking: false },
  ],
});
const DX_EMPTY = reviewerJson({ overall: 0, dimensions: [], patches: [], decisions: [] });

describe("reviewers (one premium call each, safeParse fallback)", () => {
  it("returns an empty result tagged with the reviewer on malformed JSON", async () => {
    const llm = new MockLlm([{ text: "not json at all" }]);
    const r = await ceoReview(spec, llm, "m");
    expect(r).toEqual({ reviewer: "ceo", overall: 0, dimensions: [], patches: [], decisions: [] });
  });

  it("parses a well-formed reply and stamps the reviewer name", async () => {
    const llm = new MockLlm([{ text: DESIGN }]);
    const r = await designReview(spec, llm, "m");
    expect(r.reviewer).toBe("design");
    expect(r.patches).toHaveLength(2);
    expect(r.patches[0]!.kind).toBe("objective");
  });
});

describe("reviewPlan fold + auto-decide", () => {
  it("adds frontend floor stories before the design reviewer sees a dashboard spec", async () => {
    let designSawFloorStory = false;
    const designCheck = (call: { user: string }) => {
      designSawFloorStory = call.user.includes("phone-sized viewport") && call.user.includes("headline value in the first viewport");
      return { text: DESIGN };
    };
    const llm = new MockLlm([{ text: CEO }, designCheck, { text: ENG }, { text: DX_EMPTY }]);
    await reviewPlan(spec, llm, "m");
    expect(designSawFloorStory).toBe(true);
  });

  it("folds design's objective patch into the spec the eng reviewer sees", async () => {
    // eng responder asserts the design patch statement reached its user prompt.
    let engSawDesignPatch = false;
    const engCheck = (call: { user: string }) => {
      engSawDesignPatch = call.user.includes("each opportunity shows its size");
      return { text: ENG };
    };
    const llm = new MockLlm([{ text: CEO }, { text: DESIGN }, engCheck, { text: DX_EMPTY }]);
    const result = await reviewPlan(spec, llm, "m");

    expect(engSawDesignPatch).toBe(true);
    expect(result.scores).toEqual({ ceo: 7, design: 4, eng: 6, dx: 0 });
    // all patches collected (objective + visual)
    expect(result.patches.map((p) => p.kind)).toEqual(["objective", "visual"]);
    // mechanical dropped; taste + user_challenge surfaced
    expect(result.finalGate.map((d) => d.classification)).toEqual(["taste", "user_challenge"]);
  });

  it("reports each reviewer's name via onReviewer in order", async () => {
    const seen: string[] = [];
    const llm = new MockLlm([{ text: CEO }, { text: DESIGN }, { text: ENG }, { text: DX_EMPTY }]);
    await reviewPlan(spec, llm, "m", { onReviewer: (n) => seen.push(n) });
    expect(seen).toEqual(["ceo", "design", "eng", "dx"]);
  });
});

describe("reviewSpec adapter (back-compat shape)", () => {
  it("maps objective patches → patches and the final gate → open_questions", async () => {
    const llm = new MockLlm([{ text: CEO }, { text: DESIGN }, { text: ENG }, { text: DX_EMPTY }]);
    const review = await reviewSpec(spec, llm, "m");

    // visual patch dropped; only the objective one survives as a gated requirement
    expect(review.patches).toEqual([{ statement: "each opportunity shows its size", gate: "grep -q data-size index.html" }]);

    // taste + user_challenge become open_questions; recommendation is first option
    expect(review.open_questions).toHaveLength(2);
    const taste = review.open_questions[0]!;
    expect(taste.options[0]).toBe("cards");
    expect(taste.blocking).toBe(false);
    const challenge = review.open_questions[1]!;
    expect(challenge.options[0]).toBe("add tests");
    expect(challenge.blocking).toBe(true); // user_challenge is always blocking
  });
});
