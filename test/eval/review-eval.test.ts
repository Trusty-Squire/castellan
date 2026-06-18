import { describe, it, expect } from "vitest";
import type { ReviewerResult } from "../../src/review/types.js";
import {
  scoreReviewerResult,
  gateReviewEval,
  type LabeledSpecFixture,
} from "../../src/eval/review-eval.js";

const STUB_SPEC = { thesis: "t", stories: [], requirements: [] };

const DESIGN_DEFECTS = [
  { tag: "size-not-displayed", keywords: ["size", "edge", "percentage"] },
  { tag: "ai-slop-bare-ui", keywords: ["bare", "unstyled", "no hierarchy"] },
  { tag: "no-empty-state", keywords: ["empty state"] },
  { tag: "trivial-fake-data", keywords: ["placeholder", "real data", "data source"] },
];

const DEFECTIVE: LabeledSpecFixture = {
  id: "clairvoyance/design", spec: STUB_SPEC, reviewer: "design", isControl: false, defects: DESIGN_DEFECTS, probes: [],
};
const CONTROL: LabeledSpecFixture = {
  id: "clean/design", spec: STUB_SPEC, reviewer: "design", isControl: true, defects: [], probes: DESIGN_DEFECTS,
};

// A strong design review that catches all four clairvoyance defects.
const CAUGHT_ALL: ReviewerResult = {
  reviewer: "design",
  overall: 3,
  dimensions: [{ name: "headline value shown", score: 2, whatMakesIt10: "show the edge percentage per opportunity" }],
  patches: [
    { statement: "each opportunity must display its edge size as a percentage", gate: "grep -q data-edge index.html", kind: "objective" },
    { statement: "the UI is a bare unstyled list — add visual hierarchy in cards", gate: "true", kind: "visual" },
    { statement: "add a designed empty state when there are no opportunities", gate: "grep -qi 'no opportunities' index.html", kind: "objective" },
    { statement: "lines use placeholder data — require a named real data source", gate: "grep -q the-odds-api src/feed.js", kind: "objective" },
  ],
  decisions: [],
};

// A clean control review: high scores, one harmless polish patch.
const CLEAN_REVIEW: ReviewerResult = {
  reviewer: "design",
  overall: 9,
  dimensions: [{ name: "headline value shown", score: 9, whatMakesIt10: "already prominent" }],
  patches: [{ statement: "tighten the type scale slightly", gate: "true", kind: "visual" }],
  decisions: [],
};

describe("scoreReviewerResult", () => {
  it("catches all four labeled defects on the defective spec", () => {
    const s = scoreReviewerResult(DEFECTIVE, CAUGHT_ALL);
    expect(s.missed).toEqual([]);
    expect(s.recall).toBe(1);
    expect(s.falsePositives).toEqual([]);
  });

  it("a clean control review raises no false positives", () => {
    const s = scoreReviewerResult(CONTROL, CLEAN_REVIEW);
    expect(s.falsePositives).toEqual([]);
    expect(s.recall).toBe(1); // vacuous: no defects to catch
    expect(s.isControl).toBe(true);
  });

  it("a low-scored dimension counts toward catching a defect", () => {
    const onlyDims: ReviewerResult = {
      reviewer: "design", overall: 4, patches: [], decisions: [],
      dimensions: [{ name: "empty state", score: 3, whatMakesIt10: "design an empty state" }],
    };
    const s = scoreReviewerResult(DEFECTIVE, onlyDims);
    expect(s.caught).toContain("no-empty-state");
  });
});

describe("gateReviewEval", () => {
  it("passes design when 4/4 caught and control is clean", () => {
    const scores = [scoreReviewerResult(DEFECTIVE, CAUGHT_ALL), scoreReviewerResult(CONTROL, CLEAN_REVIEW)];
    const g = gateReviewEval("design", scores, { minRecall: 1, maxControlFalsePositives: 1 });
    expect(g.passed).toBe(true);
    expect(g.recall).toBe(1);
    expect(g.controlFalsePositives).toBe(0);
  });

  it("fails design when a defect is missed", () => {
    const weak: ReviewerResult = { ...CAUGHT_ALL, patches: CAUGHT_ALL.patches.slice(0, 1) };
    const scores = [scoreReviewerResult(DEFECTIVE, weak), scoreReviewerResult(CONTROL, CLEAN_REVIEW)];
    const g = gateReviewEval("design", scores, { minRecall: 1, maxControlFalsePositives: 1 });
    expect(g.passed).toBe(false);
    expect(g.recall).toBeLessThan(1);
  });

  it("fails when a control over-flags beyond the cap (precision floor)", () => {
    const overFlag = scoreReviewerResult(CONTROL, CAUGHT_ALL); // the 'caught-all' patches match probes on a control
    const scores = [scoreReviewerResult(DEFECTIVE, CAUGHT_ALL), overFlag];
    const g = gateReviewEval("design", scores, { minRecall: 1, maxControlFalsePositives: 1 });
    expect(g.controlFalsePositives).toBeGreaterThan(1);
    expect(g.passed).toBe(false);
  });

  it("dx self-skip (no defects, no probes) passes vacuously", () => {
    const dxSkip: LabeledSpecFixture = { id: "clairvoyance/dx", spec: STUB_SPEC, reviewer: "dx", isControl: false, defects: [], probes: [] };
    const empty: ReviewerResult = { reviewer: "dx", overall: 0, dimensions: [], patches: [], decisions: [] };
    const g = gateReviewEval("dx", [scoreReviewerResult(dxSkip, empty)], { minRecall: 0.75, minPrecision: 0.8 });
    expect(g.passed).toBe(true);
  });
});
